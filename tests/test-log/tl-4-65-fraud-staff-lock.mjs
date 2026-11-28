/**
 * دفتر آزمون ۴-۶۵ — «بازبینی ضدتقلب» با قفل «عملکرد کارمندان»، در مرز IPC و در صفحه:
 *  - کانال واقعی main (`registerIpcHandlers`): با قفل «عملکرد کارمندان» روشن و بسته، `saleFraudReview` حتی با قفل
 *    «گزارشات فروش» باز رد می‌شود؛ با باز شدن همان قفل برای همان پنجره (مثل تب «عملکرد کارمندان») می‌گذرد؛ پنجرهٔ دیگر
 *    دست نمی‌خورد؛ قفل «گزارشات فروش» همچنان اول سنجیده می‌شود؛ قفل خاموش ⇐ بی رمز (مثل امروز)؛
 *  - صفحهٔ «گزارشات فروش»: دکمهٔ «بازبینی ضدتقلب 🔒»، کادر رمز با راهنمای مالک، تا باز نشده چیزی خوانده نمی‌شود و
 *    چاپ و اکسل این تب هم بسته‌اند؛ تب «عملکرد کارمندان» همان کلید را دارد (یک بار باز کردن ⇐ هر دو تب).
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-65-fraud-staff-lock.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-65-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
harnessClient()
const sessions = await import('../../src/main/services/panelSession.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { PANEL_KEYS } = await import('@shared/panels')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
registerIpcHandlers()

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const PW = '47160582'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const GATE = /^برای دیدن هشدارهای ضدتقلب فروش باید اول قفل همین بخش را باز کنید/
const open = (id, ...keys) => { for (const k of keys) sessions.notePanelUnlocked(k, 'PANEL', id) }
const setLock = async (on) => {
  const r = await ipc(970, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.staffPerformance]: on } })
  assert.equal(r.ok, true, r.error)
}

test('with the «عملکرد کارمندان» lock on and closed the fraud review is refused even with sales reports open; opening that lock for the window lets it through', async () => {
  await setLock(true)
  const W = 971, OTHER = 972
  open(W, PANEL_KEYS.salesReports)
  let r = await ipc(W, IPC.saleFraudReview, {})
  assert.equal(r.ok, false)
  assert.match(r.error, GATE)

  open(W, PANEL_KEYS.staffPerformance) // همان کاری که کادر رمز تب «عملکرد کارمندان» می‌کند
  r = await ipc(W, IPC.saleFraudReview, {})
  assert.equal(r.ok, true, r.error)

  open(OTHER, PANEL_KEYS.salesReports)
  assert.match((await ipc(OTHER, IPC.saleFraudReview, {})).error, GATE, 'another window is still locked')
  // «عملکرد کارمندان» باز ولی «گزارشات فروش» بسته ⇐ همچنان رد (قفل گزارش‌ها نخست)
  const W3 = 973
  open(W3, PANEL_KEYS.staffPerformance)
  assert.match((await ipc(W3, IPC.saleFraudReview, {})).error, GATE)
  for (const id of [W, OTHER, W3]) sessions.clearPanelSessions(id)
})

test('with the «عملکرد کارمندان» lock off the fraud review needs only what it needed before', async () => {
  await setLock(false)
  const W = 974
  open(W, PANEL_KEYS.salesReports)
  const r = await ipc(W, IPC.saleFraudReview, {})
  assert.equal(r.ok, true, r.error)
  await setLock(true)
  sessions.clearPanelSessions(W)
})

test('sales reports page: the tab button, the password box with the owner\'s guidance, no read and no print or Excel before it opens', () => {
  const s = read('src/renderer/src/pages/SalesReports.tsx')
  assert.ok(s.includes("const FRAUD_LOCK_HINT = 'این بخش همان قفل «عملکرد کارمندان» را دارد. رمز مدیر یا رمز دوم بخش «عملکرد کارمندان» را اینجا وارد کنید.'"))
  assert.match(s, /onClick=\{\(\) => setTab\('fraud'\)\}>\s*بازبینی ضدتقلب 🔒\s*<\/button>/)
  assert.match(s, /\{tab === 'fraud' && \([\s\S]{0,160}<ManagerGate panel=\{PANEL_KEYS\.staffPerformance\} title="بازبینی ضدتقلب" reason=\{FRAUD_LOCK_HINT\} inline>\s*<ReportExtraTables/)
  assert.doesNotMatch(s, /\|\| tab === 'fraud'\) && \(/, 'the fraud tab left the shared block')
  assert.match(s, /const staffOpen = usePanelOpen\(PANEL_KEYS\.staffPerformance\)/)
  assert.match(s, /else if \(tab === 'fraud'\) setFraud\(staffOpen \? await call<any>\(CH\.saleFraudReview, f\) : null\)/)
  assert.ok(s.includes("|| (tab === 'fraud' && !staffOpen)"), 'print and Excel stay disabled until the lock opens')
  assert.equal((s.match(/creditOpen, staffOpen/g) ?? []).length >= 2, true, 'the report key and load() follow the lock state')
  assert.match(s, /useEffect\(\(\) => \{\s*if \(tab === 'fraud'\) void load\(\)[\s\S]{0,90}\}, \[staffOpen\]\)/, 'opening the lock loads the tab at once')
  // تب «عملکرد کارمندان» همان کلید را دارد ⇐ یک بار باز کردن هر دو تب را باز می‌کند
  assert.match(read('src/renderer/src/components/StaffPerformancePanel.tsx'), /panel=\{PANEL_KEYS\.staffPerformance\}/)
})
