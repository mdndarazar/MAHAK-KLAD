/**
 * دفتر آزمون ۴-۶۴ — قفل «نسیه» برای پنجرهٔ پرداختی‌ها و تب «چک‌ها»، در مرز IPC و در صفحه:
 *  - کانال‌های واقعی main (`registerIpcHandlers`): فهرست پرداختی‌ها، ثبت پرداختی و فهرست چک‌ها بی قفل «نسیه» رد می‌شوند و با
 *    باز شدن همان قفل برای همان پنجره می‌گذرند؛ پرداختی‌ها از صفحهٔ فاکتور عمده با قفل همان صفحه؛ فهرست چک‌ها همچنان اول
 *    قفل «گزارشات فروش» را می‌خواهد؛ قفل «نسیه» خاموش ⇐ بی رمز؛ پنجرهٔ دیگر دست نمی‌خورد؛
 *  - صفحهٔ «گزارشات فروش»: پنجرهٔ پرداختی‌ها و تب «چک‌ها» پشت `ManagerGate` همان قفل با راهنمای «رمز بخش نسیه»؛ تا باز
 *    نشده فهرست چک‌ها خوانده نمی‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-64-credit-lock.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-64-'))
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
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const GATE = /باید اول قفل همین بخش را باز کنید/
const open = (id, ...keys) => { for (const k of keys) sessions.notePanelUnlocked(k, 'PANEL', id) }
/** از دروازه گذشت: یا انجام شد یا خطای خود سرویس (نه پیام قفل) */
const passed = (r) => r.ok === true || !GATE.test(String(r.error ?? ''))

test('with the «نسیه» lock closed the payments list, adding a payment and the cheque list are refused; opening that lock for the window lets them through', async () => {
  const W = 951, OTHER = 952
  open(W, PANEL_KEYS.salesReports)
  let r = await ipc(W, IPC.salePayments, { invoiceId: 999_999 })
  assert.equal(r.ok, false)
  assert.match(r.error, /^برای دیدن پرداختی‌ها و اقساط یک فاکتور باید اول قفل همین بخش را باز کنید/)
  r = await ipc(W, IPC.salePaymentAdd, { invoiceId: 999_999, kind: 'CASH', amount: 10_000 })
  assert.match(r.error, /^برای ثبت پرداختی یا چک باید اول قفل همین بخش را باز کنید/)
  r = await ipc(W, IPC.saleChequeList, {})
  assert.match(r.error, /^برای دیدن فهرست چک‌های فروش در گزارشات باید اول قفل/)

  open(W, PANEL_KEYS.salesCredit)
  assert.ok(passed(await ipc(W, IPC.salePayments, { invoiceId: 999_999 })))
  assert.ok(passed(await ipc(W, IPC.salePaymentAdd, { invoiceId: 999_999, kind: 'CASH', amount: 10_000 })))
  r = await ipc(W, IPC.saleChequeList, {})
  assert.equal(r.ok, true, r.error)

  // پنجرهٔ دیگر هنوز قفل است
  open(OTHER, PANEL_KEYS.salesReports)
  assert.match((await ipc(OTHER, IPC.salePayments, { invoiceId: 999_999 })).error, GATE)
  sessions.clearPanelSessions(W); sessions.clearPanelSessions(OTHER)
})

test('the wholesale invoice page opens the payments window with its own lock; the cheque list still needs reports and «نسیه»', async () => {
  const W = 953
  open(W, PANEL_KEYS.wholesaleInvoiceModule)
  assert.ok(passed(await ipc(W, IPC.salePayments, { invoiceId: 999_999 })), 'same as today on the wholesale page')
  assert.ok(passed(await ipc(W, IPC.salePaymentAdd, { invoiceId: 999_999, kind: 'CASH', amount: 10_000 })))
  assert.match((await ipc(W, IPC.saleChequeList, {})).error, GATE)
  // «گزارشات فروش» و صفحهٔ عمده باز، «نسیه» بسته ⇐ تب «چک‌ها» فقط با قفل «نسیه»
  open(W, PANEL_KEYS.salesReports)
  assert.match((await ipc(W, IPC.saleChequeList, {})).error, GATE)
  // «نسیه» باز ولی «گزارشات فروش» بسته ⇐ فهرست چک‌ها همچنان رد (همان قفل گزارش‌ها، نخست)
  const W2 = 954
  open(W2, PANEL_KEYS.salesCredit)
  assert.match((await ipc(W2, IPC.saleChequeList, {})).error, GATE)
  sessions.clearPanelSessions(W); sessions.clearPanelSessions(W2)
})

test('with the «نسیه» lock off nothing asks for a password', async () => {
  const set = await ipc(960, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.salesCredit]: false } })
  assert.equal(set.ok, true, set.error)
  const W = 961
  assert.ok(passed(await ipc(W, IPC.salePayments, { invoiceId: 999_999 })))
  assert.ok(passed(await ipc(W, IPC.salePaymentAdd, { invoiceId: 999_999, kind: 'CASH', amount: 10_000 })))
  open(W, PANEL_KEYS.salesReports)
  assert.equal((await ipc(W, IPC.saleChequeList, {})).ok, true)
  await ipc(960, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.salesCredit]: true } })
  sessions.clearPanelSessions(W)
})

test('sales reports page: the payments window and the cheques tab sit behind the «نسیه» lock with the owner\'s guidance; nothing is read before it opens', () => {
  const s = read('src/renderer/src/pages/SalesReports.tsx')
  assert.ok(s.includes("const CREDIT_PAYMENTS_LOCK_HINT = 'این پنجره قفل بخش «نسیه» را دارد. رمز مدیر یا رمز دوم بخش «نسیه» را اینجا وارد کنید تا باز شود.'"))
  assert.ok(s.includes("const CREDIT_CHEQUES_LOCK_HINT = 'این تب قفل بخش «نسیه» را دارد. رمز مدیر یا رمز دوم بخش «نسیه» را اینجا وارد کنید تا باز شود.'"))
  assert.match(s, /\{paymentsFor != null && !creditOpen && \([\s\S]{0,400}<ManagerGate panel=\{PANEL_KEYS\.salesCredit\} title="پرداختی‌ها \/ اقساط" reason=\{CREDIT_PAYMENTS_LOCK_HINT\} inline>/)
  assert.match(s, /<InvoicePaymentsModal\s+open=\{paymentsFor != null && creditOpen\}/)
  assert.match(s, /\{tab === 'cheques' && \([\s\S]{0,120}<ManagerGate panel=\{PANEL_KEYS\.salesCredit\} title="چک‌ها" reason=\{CREDIT_CHEQUES_LOCK_HINT\} inline>\s*<ReportExtraTables/)
  assert.match(s, /if \(tab === 'cheques'\) setCheques\(creditOpen \? await call<any>\(CH\.saleChequeList,/)
  assert.ok(s.includes("((tab === 'credit' || tab === 'cheques') && !creditOpen)"))
})
