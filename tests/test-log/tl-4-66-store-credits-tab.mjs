/**
 * دفتر آزمون ۴-۶۶ — تب «اعتبار خرید» در «گزارشات فروش»: کادر رمز و راهنما به جای پیام قرمز سرور:
 *  - کانال واقعی main (سرور دست نخورده): `storeCreditList` با قفل «مدیریت اعتبار خرید» روشن و بسته رد می‌شود، با باز شدن
 *    همان قفل برای همان پنجره فهرست می‌دهد و با قفل خاموش بی رمز است؛ همان کلیدی که صفحه اکنون پیش از خواندن می‌سنجد؛
 *  - صفحهٔ «گزارشات فروش»: دکمهٔ «اعتبار خرید 🔒»، `ManagerGate` همان کلید با راهنمای مالک دور همان محتوای پیشین؛ تا باز نشده
 *    فهرست خوانده نمی‌شود (پس پیام قرمز نمی‌آید) و چاپ و اکسل بسته‌اند؛ صفحهٔ «مدیریت اعتبار خرید» همان کلید را دارد.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-66-store-credits-tab.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-66-'))
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
const PW = '60471825'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const RED = /^برای دیدن فهرست اعتبارهای خرید در گزارش باید اول قفل همین بخش را باز کنید/
const setLock = async (on) => {
  const r = await ipc(980, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.creditManagement]: on } })
  assert.equal(r.ok, true, r.error)
}

test('the server still refuses the list with the «مدیریت اعتبار خرید» lock closed, lists after that lock opens for the window, and needs nothing with the lock off', async () => {
  await setLock(true)
  const W = 981, OTHER = 982
  sessions.notePanelUnlocked(PANEL_KEYS.salesReports, 'PANEL', W)
  let r = await ipc(W, IPC.storeCreditList, {})
  assert.equal(r.ok, false)
  assert.match(r.error, RED, 'this red message is what the tab showed before 4-66')

  sessions.notePanelUnlocked(PANEL_KEYS.creditManagement, 'PANEL', W) // همان کاری که کادر رمز تب یا صفحهٔ «مدیریت اعتبار خرید» می‌کند
  r = await ipc(W, IPC.storeCreditList, {})
  assert.equal(r.ok, true, r.error)
  assert.ok(Array.isArray(r.data?.rows ?? r.data), 'a list comes back')
  assert.match((await ipc(OTHER, IPC.storeCreditList, {})).error, RED, 'another window is still locked')

  await setLock(false)
  const W2 = 983
  assert.equal((await ipc(W2, IPC.storeCreditList, {})).ok, true)
  await setLock(true)
  for (const id of [W, OTHER, W2]) sessions.clearPanelSessions(id)
})

test('sales reports page: the tab button, the password box with the owner\'s guidance around the same content, no read and no print or Excel before it opens', () => {
  const s = read('src/renderer/src/pages/SalesReports.tsx')
  assert.ok(s.includes("const STORE_CREDITS_LOCK_HINT = 'این بخش همان قفل «مدیریت اعتبار خرید» را دارد. رمز مدیر یا رمز دوم بخش «مدیریت اعتبار خرید» را اینجا وارد کنید.'"))
  assert.match(s, /onClick=\{\(\) => setTab\('storeCredits'\)\}>\s*اعتبار خرید 🔒\s*<\/button>/)
  assert.match(s, /\{tab === 'storeCredits' && \([\s\S]{0,160}<ManagerGate panel=\{PANEL_KEYS\.creditManagement\} title="اعتبار خرید" reason=\{STORE_CREDITS_LOCK_HINT\} inline>\s*<ReportExtraTables\s+tab=\{tab\}[\s\S]{0,200}storeCredits=\{storeCredits\}/)
  assert.match(s, /\{tab === 'ledger' && \(\s*<ReportExtraTables/, 'the ledger tab keeps its old ungated block')
  assert.match(s, /const creditMgmtOpen = usePanelOpen\(PANEL_KEYS\.creditManagement\)/)
  assert.match(s, /else if \(tab === 'storeCredits'\) setStoreCredits\(creditMgmtOpen \? await call<any>\(CH\.storeCreditList, f\) : null\)/, 'nothing is asked from the server (so no red message) before the lock opens')
  assert.ok(s.includes("|| (tab === 'storeCredits' && !creditMgmtOpen)"), 'print and Excel stay disabled until the lock opens')
  assert.match(s, /useEffect\(\(\) => \{\s*if \(tab === 'storeCredits'\) void load\(\)[\s\S]{0,90}\}, \[creditMgmtOpen\]\)/, 'opening the lock lists at once')
  assert.equal((s.match(/staffOpen, creditMgmtOpen/g) ?? []).length >= 3, true, 'the report key and load() follow the lock state')
  // صفحهٔ «مدیریت اعتبار خرید» همان کلید را دارد ⇐ یک بار باز کردن هر دو را باز می‌کند
  assert.match(read('src/renderer/src/pages/CreditManagement.tsx'), /function Gate\(\{ children, panel = PANEL_KEYS\.creditManagement,/)
})
