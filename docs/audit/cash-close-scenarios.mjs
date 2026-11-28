/**
 * آزمون سناریوهای «بستن صندوق» (F10)، «تجمیع و انتقال» (F11)، «کارت‌به‌کارت مدیر» و «پشتیبان و بازگردانی»
 * — آزمون ۲۰۲۶-۱۱-۲۶ (دفتر آزمون مالک، بخش ۴-۹۱ بند ۶؛ یافته‌های ۴-۱۰۲ تا ۴-۱۰۸ و خط تازهٔ ۴-۴۱).
 *
 * همه‌چیز از همان راهی می‌رود که صفحه‌های برنامه می‌روند (کانال‌های IPC با همان قفل‌ها، رمزها و «نشست باز»):
 * روز کامل فروش (نقد، کارت، نقد+کارت، نسیه، حساب مدیر، موجودی اول، واریز، برداشت، برگشت نقدی)، پیش‌نمایش «نقد
 * مورد انتظار»، بستن صندوق با شمارش درست، کسری و اضافه زیر و بالای آستانهٔ یادداشت، بستن بی‌شمارش، بستن خالی،
 * بستن دوباره؛ پایان روز با برداشت پول و ماندن پول خرد؛ چک در جریان و پاس‌شده، وصول نسیه در شیفت بعد؛ کارت‌به‌کارت
 * در برگشت و تعویض (پرداخت کمتر، اصلاح مثبت و منفی، لغو با و بی آزادسازی کالا، پرداخت پس از بستن صندوق)؛ تجمیع پیش
 * و پس از بستن صندوق و دوباره در همان روز؛ فراموش کردن بستن صندوق و صبح فردا؛ بستن صندوق شب و صبح فردا؛ حضانت
 * صندوق (بستن نهایی با رمز شخصی و شمارش کور)؛ بکاپ فوری، ادغام همان بکاپ، بکاپ دارای اعتبار خرید، افزودن فایل
 * بکاپ و در پایان «جایگزینی کامل» و وارسی فایل‌ها.
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده و پوشهٔ موقت؛ به برنامه، پایگاه واقعی یا آزمون‌های
 * مخزن دست نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد. «صبح فردا» با برگرداندن تاریخ
 * ردیف‌ها به دیروز ساخته می‌شود (منطق نشست جامانده و قفل روز تجمیع‌شده فقط همین تاریخ‌ها را می‌خوانند)؛ روزِ سناریوهای
 * A و F پس از پایانشان به گذشته می‌رود تا تجمیعِ آن‌ها فروش سناریوهای بعدِ «امروز» را نبندد. میان سناریوها، نشست باز
 * ماندهٔ سناریوی قبل مستقیم در پایگاه بسته می‌شود (کار خود ابزار، نه برنامه). دفتر `_prisma_migrations` مثل پایگاه
 * واقعی پر می‌شود (ادغام بکاپ به آن تکیه دارد). «جایگزینی کامل» آخرین گام است، چون هارنس پس از آن دوباره وصل
 * نمی‌شود؛ وارسی پس از آن با خواندن مستقیم فایل‌هاست.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/cash-close-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی شناسه، بی تاریخ، بی کد) برای مقایسه
 *   ... --compare docs/audit/cash-close-scenarios-2026-11-26.json
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_VERBOSE=1  ریز هر گام   (سناریوها به ترتیب به هم وابسته‌اند؛ AUD_ONLY ندارد)
 *
 * سنجش‌های خودکار: «نقد مورد انتظار» پیش‌نمایش و بستن برابر جمع خام ردیف‌ها (موجودی اول + دریافت نقد + چک پاس‌شدهٔ
 * نقدی + واریز − بازپرداخت نقدی − برداشت)؛ اختلاف = شمارش − انتظار؛ ردیف ذخیره‌شدهٔ بستن همان عدد؛ بستن صندوق و
 * تجمیع به پول و موجودی دست نمی‌زنند؛ کار ردشده هیچ اثری نمی‌گذارد؛ موجودی هر کالا = موجودی اول + دفتر گردش.
 * جز گام‌ها، «دیده‌ها» (اجزای انتظار، وضعیت نشست، پیام‌ها، نتیجهٔ تجمیع، کارت‌به‌کارت، بکاپ) هم در نتیجه می‌نشینند.
 * قاعدهٔ مالک (دفتر آزمون، «شرط مالک برای ۴-۶۸ تا ۴-۷۳»، بند ۱۲): منطق اصلی فقط بهتر شود و فروش هیچ‌جا قفل نشود یا رمز
 * مدیر نخواهد؛ پس از اجرای ۴-۴۱ و ۴-۱۰۲ تا ۴-۱۰۸ این ابزار فقط تفاوت‌های خواسته‌شدهٔ همان بندها را نشان می‌دهد.
 */
import { register } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)

const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
/** پایگاه آزمون همان فایلی است که `databaseFile()` برنامه می‌گوید، تا بکاپ و بازگردانی روی همین فایل کار کنند. */
const dir = mock.state.userData
mkdirSync(join(dir, 'data'), { recursive: true })
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'data', 'shop.db')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
let relaunches = 0
mock.app.relaunch = () => { relaunches++ }
mock.app.exit = () => {}
const openDialog = { result: { canceled: true, filePaths: [] } }
mock.dialog.showOpenDialog = async () => openDialog.result
const sender = { id: 777010, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)

const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')
const { backupService } = await imp('/src/main/services/BackupService.ts')
const { storeCreditService } = await imp('/src/main/services/StoreCreditService.ts')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const { toJalaliDate, jalaliAddDays } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')

const db = harnessClient()
/**
 * هارنس ساختار نهایی جدول‌ها را یک‌جا می‌سازد ولی دفتر `_prisma_migrations` ندارد؛ پایگاه واقعی برنامه این دفتر را
 * دارد (برنامه هنگام باز شدن همهٔ migrationها را در آن ثبت می‌کند) و بکاپش هم همین را دارد. ادغام بکاپ روی همین دفتر
 * تکیه می‌کند، پس دفتر با همان ساختار و همان checksum برنامه پر می‌شود تا پایگاه آزمون شبیه پایگاه واقعی باشد.
 */
{
  const migDir = findMigrationsDir()
  db.$harness.db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`)
  const { createHash, randomUUID } = await import('node:crypto')
  for (const name of readdirSync(migDir).filter((x) => existsSync(join(migDir, x, 'migration.sql'))).sort()) {
    const raw = readFileSync(join(migDir, name, 'migration.sql'))
    db.$harness.db.prepare(`INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count") VALUES (?,?,current_timestamp,?,1)`)
      .run(randomUUID(), createHash('sha256').update(raw).digest('hex'), name)
  }
}
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const dueJalali = toJalaliDate(new Date(Date.now() + 30 * 86400000))
const n = (x) => Number(x ?? 0)
const VERBOSE = process.env.AUD_VERBOSE === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const owner = seed.user('مالک فروشگاه')
const seller = seed.user('فروشنده دوم')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
const cat = seed.category('ممیزی صندوق')
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
// قفل ماژول‌ها عمداً ثبت نمی‌شود: همان پیش‌فرض نصب تازه (همهٔ ماژول‌ها قفل). باز کردن هر صفحه با notePanelUnlocked
// شبیه همان رمزی است که کاربر برای ورود به آن صفحه می‌زند.
const DEBTOR = { firstName: 'رضا', lastName: 'ممیزی', phone: '09121234567', nationalId: null }

registerIpcHandlers()
const ipcErrors = []
const warnLog = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { warnLog.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  return fn({ sender }, payload)
}
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }

// ------------------------------------------------------------------ results and invariants
const scenarios = []
const allFindings = []
let vseq = 0, keySeq = 0

function newCtx(id, title) {
  return { id, title, variants: [], steps: [], findings: [], findingKeys: new Set(), refusals: [], obs: [], notes: [] }
}
function finding(ctx, type, label, detail) {
  const key = `${type}|${label}`
  if (ctx.findingKeys.has(key)) return
  ctx.findingKeys.add(key)
  const f = { scenario: ctx.id, type, label, detail }
  ctx.findings.push(f)
  allFindings.push(f)
  if (VERBOSE) console.log('    ⚠', type, label, typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
}
function obs(ctx, key, value) {
  ctx.obs.push({ k: key, v: value })
  if (VERBOSE) console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 260)}`)
}
const firstLine = (t) => String(t ?? '').split('\n')[0]
const countOf = (t, where = '1=1', ...p) => seed.count(t, where, ...p)
const stockOf = (v) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
const openShifts = () => seed.rows('SELECT id,userId,dayJalali,openedVia,staffConfirmed FROM "Shift" WHERE closedAt IS NULL ORDER BY id')

function sig(ctx) {
  return JSON.stringify({
    t: ['Shift', 'CashSession', 'CashMovement', 'Payment', 'SaleInvoice', 'SaleReturn', 'StockMovement', 'CardTransferRequest', 'Consolidation', 'StoreCredit'].map((t) => countOf(t)),
    open: openShifts().map((r) => [n(r.id), r.userId == null ? null : n(r.userId), r.dayJalali]),
    closed: seed.rows('SELECT id FROM "Shift" WHERE closedAt IS NOT NULL ORDER BY id').map((r) => n(r.id)),
    pend: countOf('StockMovement', "state='PENDING'"),
    cons: countOf('SaleInvoice', 'consolidationId IS NOT NULL'),
    ct: seed.rows('SELECT id,status,paidAmount FROM "CardTransferRequest" ORDER BY id'),
    stock: ctx.variants.map(stockOf),
    custody: seed.rows('SELECT state,activeShiftId,epoch FROM "CustodyState"')
  })
}
function verify(ctx, label) {
  if (ctx.skipLedger) return
  for (const v of ctx.variants) {
    const actual = stockOf(v)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    if (actual !== v.baseline + ledger) finding(ctx, 'STOCK_LEDGER', label, { v: v.label, actual, baseline: v.baseline, ledger })
  }
}
const BRIEF_KEYS = ['state', 'grandTotal', 'paidTotal', 'total', 'refundMethod', 'refundAmount', 'status', 'amount', 'paidAmount', 'releasedQty', 'stillPending',
  'invoiceCount', 'finalizedMovements', 'mode', 'willRestart', 'shiftClosed', 'openedVia', 'staffPending', 'closed', 'retryNoOp', 'countStatus', 'canceled']
function brief(r) {
  if (r == null || typeof r !== 'object') return r ?? null
  if (Array.isArray(r)) return { rows: r.length }
  const o = {}
  for (const k of BRIEF_KEYS) if (r[k] !== undefined && r[k] !== null && typeof r[k] !== 'object') o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]
  if (r.cashClose) o.cash = { state: r.cashClose.state, expected: n(r.cashClose.expectedCash), counted: r.cashClose.countedProvided ? n(r.cashClose.countedCash) : null, diff: n(r.cashClose.cashDifference), requiresNote: !!r.cashClose.requiresNote }
  if (r.summary && typeof r.summary === 'object' && 'count' in r.summary) o.invoices = n(r.summary.count)
  if (Array.isArray(r.done)) { o.daysDone = r.done.length; o.daysSkipped = (r.skipped ?? []).length }
  if (r.report?.inserted) o.inserted = r.report.inserted
  if (r.cardTransfer) o.cardTransfer = n(r.cardTransfer.amount)
  if (r.payment && typeof r.payment === 'object') o.payment = { kind: r.payment.kind, amount: n(r.payment.amount), chequeStatus: r.payment.chequeStatus ?? null }
  return o
}

/** یک گام از راه صفحه (کانال IPC با همان قفل و نشست). */
async function call(ctx, label, expect, channel, payload) {
  const before = sig(ctx)
  let r
  try { r = await invoke(channel, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  if (!r.ok) {
    if (sig(ctx) !== before) finding(ctx, 'REFUSAL_NOT_ATOMIC', label, r.error)
    ctx.refusals.push({ label, msg: r.error, code: r.code ?? null, expected: expect !== 'ok' })
    if (expect === 'ok') finding(ctx, 'UNEXPECTED_REFUSAL', label, r.error)
    ctx.steps.push({ label, ok: false, expect, code: r.code ?? null, msg: String(r.error).slice(0, 400) })
    if (VERBOSE) console.log(`   ✗ ${label}: ${r.code ? `[${r.code}] ` : ''}${firstLine(r.error).slice(0, 170)}`)
    verify(ctx, label + ' [after refusal]')
    return { ok: false, error: String(r.error), code: r.code ?? null }
  }
  if (expect === 'refuse') finding(ctx, 'ACCEPTED_BUT_SHOULD_REFUSE', label, brief(r.data))
  ctx.steps.push({ label, ok: true, expect, brief: brief(r.data) })
  if (VERBOSE) console.log(`   ✓ ${label} ${JSON.stringify(brief(r.data)).slice(0, 200)}`)
  verify(ctx, label)
  return { ok: true, data: r.data }
}
/** گامی که مستقیم سرویس را صدا می‌زند (فقط راه‌اندازی حضانت و صدور اعتبار). */
async function svc(ctx, label, expect, fn) {
  const before = sig(ctx)
  try {
    const res = await fn()
    if (expect === 'refuse') finding(ctx, 'ACCEPTED_BUT_SHOULD_REFUSE', label, brief(res))
    ctx.steps.push({ label, ok: true, expect, brief: brief(res) })
    if (VERBOSE) console.log(`   ✓ ${label}`)
    return { ok: true, data: res }
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (sig(ctx) !== before) finding(ctx, 'REFUSAL_NOT_ATOMIC', label, msg)
    if (expect === 'ok') finding(ctx, 'UNEXPECTED_REFUSAL', label, msg)
    ctx.refusals.push({ label, msg, code: e?.code ?? null, expected: expect !== 'ok' })
    ctx.steps.push({ label, ok: false, expect, code: e?.code ?? null, msg: msg.slice(0, 400) })
    if (VERBOSE) console.log(`   ✗ ${label}: ${firstLine(msg).slice(0, 170)}`)
    return { ok: false, error: msg, code: e?.code ?? null }
  }
}
const refusalObs = (r) => (r.ok ? { ok: true } : { ok: false, code: r.code ?? null, msg: firstLine(r.error) })

function V(ctx, label, price, stock = 20) {
  const pid = seed.product(`${ctx.id}-${label}-${++vseq}`, cat)
  const id = seed.variant(pid, `${label}-${vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(stock, price, id)
  const v = { id, label, price, baseline: stock }
  ctx.variants.push(v)
  return v
}
const lineOf = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const itemFor = (invoiceId, v) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=? ORDER BY id', invoiceId, v.id)
const PAY = {
  CASH: (amount) => ({ methodId: cashM, amount, destination: 'CASH' }),
  CARD: (amount) => ({ methodId: cardM, amount, destination: 'CARD' }),
  MANAGER: (amount) => ({ methodId: cardM, amount, destination: 'MANAGER' })
}

/** ---- راه‌های صفحه ---- */
async function openSession(ctx, staffId, { label, expect = 'ok', reason, password, handover = false } = {}) {
  const payload = { staffId, handover, idempotencyKey: `aud-open-${++keySeq}` }
  if (reason) { payload.reason = reason; payload.overrideReason = reason }
  if (password !== undefined) payload.managerPassword = password
  return call(ctx, label ?? 'open session', expect, IPC.shiftSessionOpen, payload)
}
async function sale(ctx, { items, pays = [], debtor = false, label, expect = 'ok' }) {
  const payments = pays.map(([kind, amount]) => PAY[kind](amount))
  const split = payments.length > 1 && payments.every((p) => p.destination === 'CASH' || p.destination === 'CARD')
  const payload = { lines: items.map(([v, qty]) => lineOf(v, qty ?? 1)), payments, ...(split ? { splitPayment: true } : {}), ...(debtor ? { debtor: DEBTOR } : {}), saleRequestIdempotencyKey: `aud-sale-${++keySeq}` }
  const r = await call(ctx, label ?? 'sale', expect, IPC.saleCreate, payload)
  if (r.ok) r.invoiceId = n(r.data.id)
  return r
}
async function movement(ctx, type, amount, description, { label, expect = 'ok' } = {}) {
  unlock(PANEL_KEYS.cashClose)
  return call(ctx, label ?? `cash movement ${type} ${amount}`, expect, IPC.cashboxMovementAdd, { type, amount, description })
}
function rawExpected(shiftId) {
  const mv = (types) => n(seed.one(`SELECT COALESCE(SUM(amount),0) a FROM "CashMovement" WHERE shiftId=? AND type IN (${types.map(() => '?').join(',')})`, shiftId, ...types).a)
  const cashIn = n(seed.one(`SELECT COALESCE(SUM(p.amount),0) a FROM "Payment" p JOIN "SaleInvoice" s ON s.id=p.invoiceId JOIN "PaymentMethod" m ON m.id=p.methodId
    WHERE p.createdShiftId=? AND COALESCE(p.kind,'CASH')<>'CHEQUE' AND p.voidedAt IS NULL AND s.voidedAt IS NULL
      AND (p.destination='CASH' OR (p.destination IS NULL AND m.kind='CASH'))`, shiftId).a)
  const clearedCash = n(seed.one(`SELECT COALESCE(SUM(p.amount),0) a FROM "Payment" p JOIN "SaleInvoice" s ON s.id=p.invoiceId
    WHERE p.clearedShiftId=? AND p.kind='CHEQUE' AND p.chequeStatus='CLEARED' AND p.destination='CASH' AND p.voidedAt IS NULL AND s.voidedAt IS NULL`, shiftId).a)
  return mv(['OPENING_FLOAT']) + cashIn + clearedCash + mv(['DEPOSIT', 'CASH_IN']) - mv(['RETURN_REFUND', 'EXCHANGE_REFUND']) - mv(['WITHDRAWAL', 'CASH_OUT'])
}
const COMPONENT_KEYS = ['openingFloat', 'cashReceived', 'deposits', 'withdrawals', 'cashReturnRefunds', 'cashExchangeRefunds', 'priorCreditSettlements', 'priorCreditSettlementsCard',
  'clearedCashCheques', 'clearedManagerCheques', 'managerAccountReceived', 'cardExpected']
const comps = (c) => Object.fromEntries(COMPONENT_KEYS.map((k) => [k, n(c?.[k])]))
async function expected(ctx, shiftId, { label, counted, check = true, expect = 'ok' } = {}) {
  const r = await call(ctx, label ?? 'preview expected cash', expect, IPC.cashboxExpected, { shiftId, ...(counted != null ? { countedCash: counted } : {}) })
  if (r.ok && check) {
    const raw = rawExpected(shiftId)
    if (n(r.data.expectedCash) !== raw) finding(ctx, 'EXPECTED_VS_RAW', label ?? 'preview', { raw, got: n(r.data.expectedCash) })
  }
  return r
}
function effects() {
  return {
    payments: countOf('Payment'), cashMovements: countOf('CashMovement'), stockMovements: countOf('StockMovement'),
    pending: countOf('StockMovement', "state='PENDING'"), stock: n(seed.one('SELECT COALESCE(SUM(stock),0) s FROM "ProductVariant"').s),
    invoices: countOf('SaleInvoice'), returns: countOf('SaleReturn')
  }
}
const deltaOf = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]))
async function close(ctx, shiftId, { counted, note, allowRepeat = false, explicit = false, label, expect = 'ok' } = {}) {
  const before = effects()
  const payload = { shiftId, explicitShift: explicit, fromJalali: today, toJalali: today, closeShift: true, allowRepeatClose: allowRepeat,
    ...(counted != null ? { countedCash: counted, countedTotal: counted } : {}), ...(note ? { note } : {}) }
  const r = await call(ctx, label ?? `F10 close${counted != null ? ' counted ' + counted : ' (not counted)'}`, expect, IPC.cashClose, payload)
  if (r.ok) {
    const lbl = label ?? 'F10 close'
    const got = n(r.data.cashClose.expectedCash)
    const raw = rawExpected(shiftId)
    if (got !== raw) finding(ctx, 'EXPECTED_VS_RAW', lbl, { raw, got })
    if (counted != null) {
      const d = counted - got
      const st = d < 0 ? 'SHORTAGE' : d > 0 ? 'OVERAGE' : 'MATCHED'
      if (n(r.data.cashClose.cashDifference) !== d || r.data.cashClose.state !== st) finding(ctx, 'DIFF_MISMATCH', lbl, { d, got: r.data.cashClose.cashDifference, st, state: r.data.cashClose.state })
    }
    const row = seed.one('SELECT expectedCash,cashDifference,countedTotal FROM "CashSession" WHERE id=?', n(r.data.session.id))
    if (n(row.expectedCash) !== got) finding(ctx, 'SESSION_ROW_MISMATCH', lbl, { row: n(row.expectedCash), got })
    const after = effects()
    const delta = deltaOf(before, after)
    if (Object.values(delta).some((x) => x !== 0)) finding(ctx, 'CLOSE_TOUCHED_MONEY_OR_STOCK', lbl, delta)
    r.closeObs = {
      state: counted != null ? r.data.cashClose.state : 'NOT_COUNTED', expected: got, counted: counted ?? null,
      recordedDiff: n(row.cashDifference), recordedCounted: row.countedTotal == null ? null : n(row.countedTotal),
      requiresNote: !!r.data.cashClose.requiresNote, shiftClosed: !!r.data.shiftClosed, invoices: n(r.data.summary?.count),
      cardTotal: n(r.data.summary?.cardTotal), creditTotal: n(r.data.summary?.creditTotal), managerAccountTotal: n(r.data.summary?.managerAccountTotal),
      components: comps(r.data.cashClose.components), warnings: (r.data.warnings ?? []).map(firstLine)
    }
  }
  return r
}
/** همان کاری که صفحهٔ بستن صندوق و نوار بالا پس از هر تغییر می‌کنند (shift:current). */
async function pageReload(ctx, label, before = openShifts()) {
  const r = await call(ctx, label ?? 'page reload (shift:current)', 'either', IPC.shiftCurrent, {})
  const now = openShifts()
  const created = now.filter((x) => !before.some((b) => n(b.id) === n(x.id)))
  return { r, created: created.map((x) => ({ openedVia: x.openedVia, staffKnown: x.userId != null, sameDay: x.dayJalali === today })) }
}
async function statusObs() {
  const r = await invoke(IPC.shiftStatus, {})
  if (!r.ok) return { ok: false, code: r.code ?? null }
  return { state: r.data.state, staleUser: r.data.stale?.userName ?? null, overtime: r.data.overtimeUntilLabel ?? null }
}
async function ret(ctx, invoiceId, { lines, full = false, method = 'CASH', label, expect = 'ok' }) {
  unlock(PANEL_KEYS.salesReturn)
  const payload = { invoiceId, full, ...(lines ? { lines } : {}), refundDecision: 'METHOD', refundMethod: method }
  const r = await call(ctx, label ?? `return ${method}`, expect, IPC.saleReturn, payload)
  if (r.ok) r.returnId = n(r.data.id)
  return r
}
async function exch(ctx, invoiceId, { lines, repl, refundMode = 'CASH', label, expect = 'ok' }) {
  unlock(PANEL_KEYS.salesReturn)
  const replacements = repl.map(([v, qty]) => lineOf(v, qty ?? 1))
  const pv = await invoke(IPC.saleExchangePreview, { invoiceId, lines, replacements, full: false })
  if (!pv.ok || !pv.data?.ok) {
    const msg = pv.ok ? pv.data?.error : pv.error
    ctx.steps.push({ label: (label ?? 'exchange') + ' [preview]', ok: false, expect, msg: String(msg).slice(0, 400) })
    if (expect === 'ok') finding(ctx, 'UNEXPECTED_REFUSAL', (label ?? 'exchange') + ' [preview]', msg)
    return { ok: false, error: msg }
  }
  const diff = n(pv.data.effectiveDiff)
  const input = { invoiceId, lines, full: false, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `aud-ex-${++keySeq}` }
  if (pv.data.discountTransfer) input.discountTransferOption = 'NO'
  if (diff > 0) input.methodId = cashM
  else if (diff < 0) { input.exchangeSettlementDecision = 'METHOD'; input.refundMode = refundMode }
  const r = await call(ctx, `${label ?? 'exchange'} (diff ${diff}, ${diff < 0 ? refundMode : diff > 0 ? 'CASH' : 'ZERO'})`, expect, IPC.saleExchangeCreate, input)
  if (r.ok) r.returnId = n(r.data.returnId)
  return r
}
async function f11(ctx, label, expect = 'ok', days = [today]) {
  unlock(PANEL_KEYS.consolidation)
  const before = effects()
  const r = await call(ctx, label ?? 'F11 consolidate today', expect, IPC.consolidationFinalizeDays, { days })
  if (r.ok) {
    const d = deltaOf(before, effects())
    if (d.stock !== 0 || d.stockMovements !== 0 || d.payments !== 0 || d.cashMovements !== 0) finding(ctx, 'F11_TOUCHED_MONEY_OR_STOCK', label ?? 'F11', d)
    r.f11Obs = { daysDone: r.data.done.length, daysSkipped: r.data.skipped.length, invoices: n(r.data.invoiceCount), movements: n(r.data.finalizedMovements), pendingDelta: d.pending }
  }
  return r
}
const c2cOf = (returnId) => seed.one(`SELECT id,amount,status,paidAmount FROM "CardTransferRequest" WHERE returnId=? AND kind='REQUEST' ORDER BY id DESC`, returnId)
const c2cRow = (id) => { const r = seed.one('SELECT status,amount,paidAmount,stockReleasedQty FROM "CardTransferRequest" WHERE id=?', id); return { status: r.status, amount: n(r.amount), paid: r.paidAmount == null ? null : n(r.paidAmount), released: r.stockReleasedQty == null ? null : n(r.stockReleasedQty) } }
/** نشست جاری را مثل گذر یک شب به دیروز می‌برد (فقط تاریخ نشست؛ منطق «نشست جامانده» همین را می‌خواند). */
function backdateShift(shiftId, days = 1) {
  const s = seed.one('SELECT dayJalali FROM "Shift" WHERE id=?', shiftId)
  const ms = days * 86400000
  sql.prepare('UPDATE "Shift" SET dayJalali=?, openedAt=openedAt-?, closedAt=CASE WHEN closedAt IS NULL THEN NULL ELSE closedAt-? END WHERE id=?')
    .run(jalaliAddDays(s.dayJalali || today, -days), ms, ms, shiftId)
}
/**
 * «دیروز شد»: همهٔ ردیف‌هایی که از لحظهٔ floors() ساخته شده‌اند (نشست، فاکتور، پرداخت، برگشت، گردش صندوق، بستن صندوق،
 * تجمیع، دفتر انبار، کارت‌به‌کارت، سابقه) به‌اندازهٔ چند روز عقب می‌روند؛ تاریخ‌های شمسی همراهشان هم از نو ساخته می‌شوند.
 * سررسید چک (تاریخ کاری) دست نمی‌خورد.
 */
const BACKDATE_TABLES = ['Shift', 'SaleInvoice', 'Payment', 'PaymentChequeStatusHistory', 'SaleReturn', 'CashMovement', 'CashSession', 'Consolidation', 'StockMovement', 'CardTransferRequest', 'AuditLog']
const KEEP_DATES = new Set(['dueDate', 'dueDateJalali'])
function floors() {
  return Object.fromEntries(BACKDATE_TABLES.map((t) => [t, n(seed.one(`SELECT COALESCE(MAX(id),0) m FROM "${t}"`).m)]))
}
const SQLITE_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const dateMs = (v) => (typeof v === 'number' ? v : SQLITE_TS.test(String(v)) ? new Date(String(v).replace(' ', 'T') + 'Z').getTime() : new Date(v).getTime())
function shiftDateValue(v, ms) {
  if (typeof v === 'number') return v - ms
  const s = String(v)
  const t = dateMs(s)
  if (!Number.isFinite(t)) return v
  return SQLITE_TS.test(s) ? new Date(t - ms).toISOString().slice(0, 19).replace('T', ' ') : new Date(t - ms).toISOString()
}
function backdateSince(fl, days) {
  const ms = days * 86400000
  for (const [t, floor] of Object.entries(fl)) {
    const cols = sql.prepare(`PRAGMA table_info("${t}")`).all()
    const dateCols = cols.filter((c) => /DATE|TIME/i.test(c.type) && !KEEP_DATES.has(c.name)).map((c) => c.name)
    const jalCols = cols.filter((c) => /Jalali$/.test(c.name) && !KEEP_DATES.has(c.name)).map((c) => c.name)
    for (const r of sql.prepare(`SELECT * FROM "${t}" WHERE id > ?`).all(floor)) {
      const set = {}
      for (const c of dateCols) if (r[c] != null) set[c] = shiftDateValue(r[c], ms)
      for (const c of jalCols) {
        if (!r[c]) continue
        const base = c.replace(/Jalali$/, '')
        set[c] = c !== 'dayJalali' && set[base] != null ? toJalaliDate(new Date(dateMs(set[base]))) : jalaliAddDays(String(r[c]), -days)
      }
      const keys = Object.keys(set)
      if (keys.length) sql.prepare(`UPDATE "${t}" SET ${keys.map((k) => `"${k}"=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => set[k]), r.id)
    }
  }
}
/** کار خود ابزار میان سناریوها: نشست باز ماندهٔ سناریوی قبل بسته می‌شود تا سناریوی بعد از صفر شروع کند. */
function teardown() { sql.prepare('UPDATE "Shift" SET closedAt=? WHERE closedAt IS NULL').run(Date.now()) }
const currentShiftId = () => { const r = seed.one('SELECT id FROM "Shift" WHERE closedAt IS NULL ORDER BY id DESC'); return r ? n(r.id) : null }
const sessionsFor = (shiftId) => countOf('CashSession', 'shiftId=?', shiftId)

async function run(id, title, fn) {
  const ctx = newCtx(id, title)
  const t0 = Date.now()
  try { await fn(ctx) } catch (e) {
    finding(ctx, 'SCRIPT_ERROR', 'exception', String(e?.stack ?? e).slice(0, 800))
  }
  scenarios.push({ id, title, ms: Date.now() - t0, steps: ctx.steps, refusals: ctx.refusals, findings: ctx.findings, obs: ctx.obs, notes: ctx.notes })
  const bad = ctx.findings.length
  console.log(`${bad ? '✗' : '✓'} ${id} ${title} — steps ${ctx.steps.length}, refusals ${ctx.refusals.length}, obs ${ctx.obs.length}${bad ? `, FINDINGS ${bad}: ${[...new Set(ctx.findings.map((f) => f.type))].join(',')}` : ''}`)
}

// =================================================================== A. یک روز کامل و بستن صندوق
let aShift = null
const aFloors = floors()
await run('A', 'روز کامل: فروش‌های گوناگون، موجودی اول، واریز، برداشت، برگشت نقدی، بستن با شمارش درست، سپس تجمیع', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session (owner, first of the day)' })
  aShift = n(o.data?.id)
  obs(ctx, 'openedSession', { openedVia: o.data?.openedVia ?? null, staffPending: o.data?.staffPending ?? null })
  await movement(ctx, 'OPENING_FLOAT', 2_000_000, 'موجودی اول صبح', { label: 'opening float 2,000,000' })
  const a1 = V(ctx, 'شلوار', 700_000), a2 = V(ctx, 'پیراهن', 500_000), b = V(ctx, 'کفش', 800_000), c = V(ctx, 'کاپشن', 800_000), d = V(ctx, 'کت', 1_000_000), e = V(ctx, 'کیف', 400_000)
  const s1 = await sale(ctx, { items: [[a1], [a2]], pays: [['CASH', 1_200_000]], label: 'sale 1: cash 1,200,000 (2 items)' })
  await sale(ctx, { items: [[b]], pays: [['CARD', 800_000]], label: 'sale 2: card 800,000' })
  await sale(ctx, { items: [[c]], pays: [['CASH', 300_000], ['CARD', 500_000]], label: 'sale 3: cash 300,000 + card 500,000' })
  await sale(ctx, { items: [[d]], pays: [], debtor: true, label: 'sale 4: نسیه 1,000,000' })
  await sale(ctx, { items: [[e]], pays: [['MANAGER', 400_000]], label: 'sale 5: manager account 400,000' })
  await movement(ctx, 'DEPOSIT', 100_000, 'پول خرد از مدیر', { label: 'deposit 100,000' })
  await movement(ctx, 'WITHDRAWAL', 50_000, 'خرید آب و چای', { label: 'withdrawal 50,000 with reason' })
  await movement(ctx, 'WITHDRAWAL', 30_000, '', { label: 'withdrawal 30,000 without reason', expect: 'refuse' })
  if (s1.ok) await ret(ctx, s1.invoiceId, { lines: [{ saleItemId: n(itemFor(s1.invoiceId, a2).id), qty: 1 }], method: 'CASH', label: 'return shirt 500,000 cash refund' })
  const pv = await expected(ctx, aShift, { label: 'F10 page preview' })
  if (pv.ok) obs(ctx, 'preview', { expectedCash: n(pv.data.expectedCash), components: comps(pv.data.components) })
  const cl = await close(ctx, aShift, { counted: 3_050_000, label: 'F10 close counted 3,050,000' })
  if (cl.ok) obs(ctx, 'close', cl.closeObs)
  unlock(PANEL_KEYS.salesReports)
  const rep = await invoke(IPC.saleReportRows, { shiftId: aShift })
  obs(ctx, 'shiftReport', rep.ok ? Object.fromEntries(['count', 'grandTotal', 'cashTotal', 'cardTotal', 'managerAccountTotal', 'creditTotal', 'creditRemainingTotal', 'refundCashTotal', 'returnedTotal'].map((k) => [k, n(rep.data.totals?.[k])])) : refusalObs(rep))
  const pr = await pageReload(ctx, 'page reload right after close (shift:current)')
  obs(ctx, 'afterCloseNewSession', { created: pr.created })
  obs(ctx, 'afterCloseStatus', await statusObs())
  const f1 = await f11(ctx, 'F11 right after F10 (new session has no staff yet)', 'either')
  obs(ctx, 'f11AfterF10', refusalObs(f1))
  const auto = currentShiftId()
  const cs = await call(ctx, 'confirm staff of the new session (owner)', 'ok', IPC.shiftSessionStaff, { shiftId: auto, staffId: owner })
  obs(ctx, 'confirmStaff', { ok: cs.ok, staffPending: cs.data?.staffPending ?? null })
  const f2 = await f11(ctx, 'F11 after confirming staff')
  if (f2.ok) obs(ctx, 'f11', f2.f11Obs)
  obs(ctx, 'stockAfterDay', ctx.variants.map((v) => ({ v: v.label, shelfOut: v.baseline - stockOf(v) })))
})

// =================================================================== H. صبح فردای همان روز
await run('H', 'صبح فردا پس از بستن صندوق دیشب: نشست خالی پس از بستن، جامانده دیده می‌شود', async (ctx) => {
  const leftover = currentShiftId()
  obs(ctx, 'leftoverSession', { exists: leftover != null, invoices: leftover ? countOf('SaleInvoice', 'shiftId=?', leftover) : null, payments: leftover ? countOf('Payment', 'createdShiftId=?', leftover) : null, cashMovements: leftover ? countOf('CashMovement', 'shiftId=?', leftover) : null })
  backdateSince(aFloors, 1) // روز A با بستن صندوق و تجمیعش «دیروز» شد
  obs(ctx, 'morningStatus', await statusObs())
  const v = V(ctx, 'جوراب', 150_000)
  const s = await sale(ctx, { items: [[v]], pays: [['CASH', 150_000]], label: 'first sale of the morning', expect: 'either' })
  obs(ctx, 'morningFirstSale', refusalObs(s))
  const form = await invoke(IPC.shiftSessionForm, {})
  obs(ctx, 'morningForm', form.ok ? { blockReason: form.data.blockReason, stale: !!form.data.staleOpen } : { ok: false })
  const o1 = await openSession(ctx, owner, { label: 'open today session without reason/password', expect: 'refuse' })
  obs(ctx, 'openWithoutPassword', refusalObs(o1))
  const o2 = await openSession(ctx, owner, { label: 'open today session with reason, no password', reason: 'شروع روز', expect: 'refuse' })
  obs(ctx, 'openReasonNoPassword', refusalObs(o2))
  const o3 = await openSession(ctx, owner, { label: 'open today session with reason + manager password', reason: 'شروع روز', password: PW })
  obs(ctx, 'openWithPassword', { ok: o3.ok, leftoverClosed: leftover ? seed.one('SELECT closedAt FROM "Shift" WHERE id=?', leftover).closedAt != null : null, leftoverCashSessions: leftover ? sessionsFor(leftover) : null })
  const s2 = await sale(ctx, { items: [[v]], pays: [['CASH', 150_000]], label: 'first sale again' })
  obs(ctx, 'morningSaleAfter', refusalObs(s2))
  teardown()
})

// =================================================================== B. کسری و اضافه
await run('B', 'شمارش با کسری و اضافه، زیر و بالای آستانهٔ یادداشت (۱۰۰٬۰۰۰ ریال)', async (ctx) => {
  const cases = [
    { counted: 1_450_000, note: null, expect: 'ok', tag: 'shortage 50,000 without note' },
    { counted: 1_400_000, note: null, expect: 'ok', tag: 'shortage exactly 100,000 without note' },
    { counted: 1_350_000, note: null, expect: 'refuse', tag: 'shortage 150,000 without note' },
    { counted: 1_350_000, note: 'یک اسکناس ۱۵۰ هزار تومانی پیدا نشد', expect: 'ok', tag: 'shortage 150,000 with note', reuse: true },
    { counted: 1_700_000, note: null, expect: 'refuse', tag: 'overage 200,000 without note' },
    { counted: 1_700_000, note: 'بقیهٔ پول مشتری را نگرفته بودیم', expect: 'ok', tag: 'overage 200,000 with note', reuse: true }
  ]
  let shiftId = null
  for (const k of cases) {
    if (!k.reuse) {
      const o = await openSession(ctx, owner, { label: `open session for «${k.tag}»` })
      shiftId = n(o.data?.id)
      await movement(ctx, 'OPENING_FLOAT', 1_000_000, 'موجودی اول', { label: 'opening float 1,000,000' })
      const v = V(ctx, 'کالا', 500_000)
      await sale(ctx, { items: [[v]], pays: [['CASH', 500_000]], label: 'sale cash 500,000' })
    }
    const r = await close(ctx, shiftId, { counted: k.counted, note: k.note ?? undefined, label: `F10 close: ${k.tag}`, expect: k.expect })
    obs(ctx, k.tag, r.ok ? { state: r.closeObs.state, diff: r.closeObs.recordedDiff, requiresNote: r.closeObs.requiresNote } : refusalObs(r))
  }
  teardown()
})

// =================================================================== C. بی‌شمارش، دوباره، خالی
await run('C', 'بستن بی‌شمارش، بستن دوباره، بستن نشست بی‌فروش', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session' })
  const s1 = n(o.data?.id)
  const v = V(ctx, 'کالا', 300_000)
  await sale(ctx, { items: [[v]], pays: [['CASH', 300_000]], label: 'sale cash 300,000' })
  const c1 = await close(ctx, s1, { label: 'F10 close without counting' })
  if (c1.ok) obs(ctx, 'notCounted', { state: c1.closeObs.state, recordedDiff: c1.closeObs.recordedDiff, recordedCounted: c1.closeObs.recordedCounted, expected: c1.closeObs.expected })
  await openSession(ctx, owner, { label: 'open next session (same staff, same day)' })
  const r1 = await close(ctx, s1, { counted: 300_000, explicit: true, label: 'F10 close the same session again (no confirmation)', expect: 'refuse' })
  obs(ctx, 'repeatWithoutConfirm', refusalObs(r1))
  const before = effects()
  const r2 = await close(ctx, s1, { counted: 300_000, explicit: true, allowRepeat: true, label: 'F10 close the same session again (confirmed)' })
  obs(ctx, 'repeatConfirmed', r2.ok ? { state: r2.closeObs.state, shiftClosedNow: r2.closeObs.shiftClosed, sessionsForShift: sessionsFor(s1), effects: deltaOf(before, effects()) } : refusalObs(r2))
  const s2 = currentShiftId()
  const e1 = await close(ctx, s2, { label: 'F10 close a session without any sale, no note', expect: 'refuse' })
  obs(ctx, 'emptyWithoutNote', refusalObs(e1))
  const e2 = await close(ctx, s2, { note: 'امروز فروشی نداشتیم', label: 'F10 close a session without any sale, with note' })
  obs(ctx, 'emptyWithNote', e2.ok ? { state: e2.closeObs.state, invoices: e2.closeObs.invoices } : refusalObs(e2))
  teardown()
})

// =================================================================== W. برداشت پایان روز
await run('W', 'پایان روز به روش درست: برداشت پول با دلیل، ماندن پول خرد در کشو، شمارش؛ صبح موجودی اول همان پول خرد', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session (day 1)' })
  const s1 = n(o.data?.id)
  await movement(ctx, 'OPENING_FLOAT', 500_000, 'پول خرد', { label: 'opening float 500,000' })
  const v = V(ctx, 'کالا', 1_000_000)
  await sale(ctx, { items: [[v]], pays: [['CASH', 1_000_000]], label: 'sale cash 1,000,000' })
  await movement(ctx, 'WITHDRAWAL', 1_000_000, 'انتقال فروش روز به بانک', { label: 'end of day: withdraw 1,000,000 (to the bank)' })
  const c1 = await close(ctx, s1, { counted: 500_000, label: 'F10 close counted 500,000 (only the change float left)' })
  obs(ctx, 'day1', c1.ok ? { state: c1.closeObs.state, expected: c1.closeObs.expected } : refusalObs(c1))
  const o2 = await openSession(ctx, owner, { label: 'open session (day 2)' })
  const s2 = n(o2.data?.id)
  await movement(ctx, 'OPENING_FLOAT', 500_000, 'پول خرد دیشب', { label: 'opening float 500,000 (same as last count)' })
  await sale(ctx, { items: [[v]], pays: [['CASH', 1_000_000]], label: 'sale cash 1,000,000' })
  const c2 = await close(ctx, s2, { counted: 1_500_000, label: 'F10 close counted 1,500,000' })
  obs(ctx, 'day2', c2.ok ? { state: c2.closeObs.state, expected: c2.closeObs.expected, warnings: c2.closeObs.warnings } : refusalObs(c2))
  const o3 = await openSession(ctx, owner, { label: 'open session (day 3) without entering an opening float' })
  const s3 = n(o3.data?.id)
  await sale(ctx, { items: [[v]], pays: [['CASH', 1_000_000]], label: 'sale cash 1,000,000' })
  const c3 = await close(ctx, s3, { counted: 2_500_000, note: 'پول دیشب در کشو ماند', label: 'F10 close counted 2,500,000 (last night\'s money stayed, no opening float entered)' })
  obs(ctx, 'day3', c3.ok ? { state: c3.closeObs.state, expected: c3.closeObs.expected, diff: c3.closeObs.recordedDiff, warnings: c3.closeObs.warnings } : refusalObs(c3))
  teardown()
})

// =================================================================== D. پولی که در کشو نیست
await run('D', 'نسیه، چک در جریان و پاس‌شده، وصول نسیه در شیفت بعد: فقط نقد واقعی در انتظار کشو', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session 1' })
  const s1 = n(o.data?.id)
  const x = V(ctx, 'مانتو', 2_000_000), y = V(ctx, 'کت و شلوار', 1_000_000)
  const sa = await sale(ctx, { items: [[x]], pays: [['CASH', 500_000]], debtor: true, label: 'sale A 2,000,000: cash 500,000 + نسیه 1,500,000' })
  const sb = await sale(ctx, { items: [[y]], pays: [], debtor: true, label: 'sale B 1,000,000 نسیه' })
  let chequeId = null
  if (sb.ok) {
    unlock(PANEL_KEYS.salesCredit); const q = await call(ctx, 'cheque 1,000,000 for sale B (payments window)', 'ok', IPC.salePaymentAdd, { invoiceId: sb.invoiceId, kind: 'CHEQUE', amount: 1_000_000, chequeNo: 'AUD-Q-1', bankName: 'ملت', dueDateJalali: dueJalali })
    chequeId = n(q.data?.payment?.id)
  }
  const c1 = await close(ctx, s1, { counted: 500_000, label: 'F10 close session 1 counted 500,000' })
  if (c1.ok) obs(ctx, 'session1', { state: c1.closeObs.state, expected: c1.closeObs.expected, creditTotal: c1.closeObs.creditTotal, components: c1.closeObs.components })
  const o2 = await openSession(ctx, owner, { label: 'open session 2' })
  const s2 = n(o2.data?.id)
  if (sa.ok) {
    unlock(PANEL_KEYS.salesCredit); await call(ctx, 'collect 600,000 cash on sale A (prior نسیه)', 'ok', IPC.salePaymentAdd, { invoiceId: sa.invoiceId, kind: 'CASH', amount: 600_000, methodId: cashM, destination: 'CASH' })
    await call(ctx, 'collect 400,000 card on sale A (prior نسیه)', 'ok', IPC.salePaymentAdd, { invoiceId: sa.invoiceId, kind: 'CASH', amount: 400_000, methodId: cardM, destination: 'CARD' })
  }
  if (chequeId) await call(ctx, 'cheque 1,000,000 CLEARED → manager account', 'ok', IPC.saleChequeStatus, { id: chequeId, status: 'CLEARED', destination: 'MANAGER', managerPassword: PW })
  let c2 = await close(ctx, s2, { counted: 600_000, label: 'F10 close session 2 (only collections, no new invoice) counted 600,000' })
  obs(ctx, 'session2WithoutNote', refusalObs(c2))
  if (!c2.ok) c2 = await close(ctx, s2, { counted: 600_000, note: 'فقط وصول نسیه داشتیم', label: 'F10 close session 2 with a note' })
  if (c2.ok) obs(ctx, 'session2', { state: c2.closeObs.state, expected: c2.closeObs.expected, invoices: c2.closeObs.invoices, components: c2.closeObs.components })
  if (sa.ok) obs(ctx, 'saleARemaining', { paid: n(seed.one('SELECT paidTotal FROM "SaleInvoice" WHERE id=?', sa.invoiceId).paidTotal) })
  teardown()
})

// =================================================================== E. کارت‌به‌کارت مدیر
await run('E', 'کارت‌به‌کارت در برگشت و تعویض: پرداخت کمتر، اصلاح، لغو، آزادسازی کالا، پرداخت پس از بستن صندوق', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session' })
  const s1 = n(o.data?.id)
  const X = V(ctx, 'X-۶۰۰', 600_000), Y = V(ctx, 'Y-۴۰۰', 400_000), Z = V(ctx, 'Z-۱۰۰۰', 1_000_000), W = V(ctx, 'W-۷۰۰', 700_000)
  const s = await sale(ctx, { items: [[X], [Y], [Z]], pays: [['CASH', 2_000_000]], label: 'sale cash 2,000,000 (X 600k, Y 400k, Z 1,000k)' })
  if (!s.ok) throw new Error('sale failed')
  const exp0 = await expected(ctx, s1, { label: 'preview before card-to-card' })
  const rY = await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, Y).id), qty: 1 }], method: 'CARD_TO_CARD', label: 'return Y 400,000 → card-to-card' })
  const reqY = rY.ok ? c2cOf(rY.returnId) : null
  obs(ctx, 'afterReturnY', { request: reqY ? c2cRow(n(reqY.id)) : null, yShelfBack: stockOf(Y) - (Y.baseline - 1), restockPending: rY.ok ? n(seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', rY.returnId).restockPending) : null })
  const pend = await invoke(IPC.pendingRestockSummary, {})
  obs(ctx, 'pendingRestockWarning', pend.ok ? { returns: n(pend.data?.returnCount), qty: n(pend.data?.totalQty), amount: n(pend.data?.pendingAmount) } : { ok: false, code: pend.code ?? null })
  const exp1 = await expected(ctx, s1, { label: 'preview after card-to-card request' })
  obs(ctx, 'expectedUnchangedByRequest', { before: n(exp0.data?.expectedCash), after: n(exp1.data?.expectedCash) })
  if (reqY) {
    const id = n(reqY.id)
    const p0 = await call(ctx, 'pay with wrong password', 'refuse', IPC.cardTransferPay, { id, paidAmount: 400_000, managerPassword: 'wrong-pass' })
    obs(ctx, 'payWrongPassword', refusalObs(p0))
    const p1 = await call(ctx, 'pay 500,000 (more than requested)', 'refuse', IPC.cardTransferPay, { id, paidAmount: 500_000, managerPassword: PW })
    obs(ctx, 'payMore', refusalObs(p1))
    const p2 = await call(ctx, 'pay 300,000 (less than requested)', 'ok', IPC.cardTransferPay, { id, paidAmount: 300_000, trackingNo: 'AUD-T-1', managerPassword: PW })
    obs(ctx, 'payLess', { ok: p2.ok, request: c2cRow(id), yShelfBack: stockOf(Y) - (Y.baseline - 1) })
    const p3 = await call(ctx, 'pay the same request again', 'refuse', IPC.cardTransferPay, { id, paidAmount: 100_000, managerPassword: PW })
    obs(ctx, 'payAgain', refusalObs(p3))
    const a1 = await call(ctx, 'adjust +150,000 (net would be 450,000 > 400,000)', 'refuse', IPC.cardTransferAdjust, { id, amount: 150_000, reason: 'باقی مبلغ', managerPassword: PW })
    obs(ctx, 'adjustAboveRequest', refusalObs(a1))
    const a2 = await call(ctx, 'adjust +100,000 (net 400,000)', 'ok', IPC.cardTransferAdjust, { id, amount: 100_000, reason: 'باقی مبلغ', trackingNo: 'AUD-T-2', managerPassword: PW })
    obs(ctx, 'adjustRest', { ok: a2.ok, request: c2cRow(id) })
    const a3 = await call(ctx, 'adjust -500,000 (net would be negative)', 'refuse', IPC.cardTransferAdjust, { id, amount: -500_000, reason: 'برگشت پول', managerPassword: PW })
    obs(ctx, 'adjustNegativeTooMuch', refusalObs(a3))
    const c0 = await call(ctx, 'cancel after payment', 'refuse', IPC.cardTransferCancel, { id, reason: 'اشتباه', managerPassword: PW })
    obs(ctx, 'cancelAfterPay', refusalObs(c0))
  }
  const rX = await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], method: 'CARD_TO_CARD', label: 'return X 600,000 → card-to-card' })
  const reqX = rX.ok ? c2cOf(rX.returnId) : null
  if (reqX) {
    const id = n(reqX.id)
    const k1 = await call(ctx, 'cancel without releasing the goods', 'ok', IPC.cardTransferCancel, { id, reason: 'مشتری پشیمان شد و پول نخواست', managerPassword: PW })
    obs(ctx, 'cancelKeepPending', { ok: k1.ok, stillPending: k1.data?.stillPending ?? null, xShelfBack: stockOf(X) - (X.baseline - 1), request: c2cRow(id) })
    const k2 = await call(ctx, 'cancel again with releasing the goods', 'ok', IPC.cardTransferCancel, { id, reason: 'کالا سالم است و به قفسه برگشت', releaseStock: true, managerPassword: PW })
    obs(ctx, 'cancelRelease', { ok: k2.ok, releasedQty: n(k2.data?.releasedQty), xShelfBack: stockOf(X) - (X.baseline - 1), request: c2cRow(id) })
  }
  const ex = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, Z).id), qty: 1 }], repl: [[W]], refundMode: 'CARD_TO_CARD', label: 'exchange Z 1,000,000 → W 700,000' })
  const reqZ = ex.ok ? c2cOf(ex.returnId) : null
  obs(ctx, 'afterExchange', { request: reqZ ? c2cRow(n(reqZ.id)) : null, zShelfBack: stockOf(Z) - (Z.baseline - 1), wShelfOut: W.baseline - stockOf(W) })
  if (reqZ) {
    const pz = await call(ctx, 'pay the exchange difference 300,000', 'ok', IPC.cardTransferPay, { id: n(reqZ.id), paidAmount: 300_000, managerPassword: PW })
    obs(ctx, 'payExchange', { ok: pz.ok, zShelfBack: stockOf(Z) - (Z.baseline - 1), request: c2cRow(n(reqZ.id)) })
  }
  const oos = await call(ctx, 'out-of-sales report (today)', 'either', IPC.cardTransferOutOfSales, { fromJalali: today, toJalali: today })
  if (oos.ok) obs(ctx, 'outOfSalesTotals', Object.fromEntries(Object.entries(oos.data.totals ?? {}).filter(([, v]) => typeof v === 'number')))
  // درخواستی که تا پایان روز پرداخت نمی‌شود
  const s2 = await sale(ctx, { items: [[W]], pays: [['CASH', 700_000]], label: 'sale W cash 700,000' })
  let reqW = null
  if (s2.ok) {
    const rW = await ret(ctx, s2.invoiceId, { full: true, method: 'CARD_TO_CARD', label: 'return W 700,000 → card-to-card (left pending)' })
    reqW = rW.ok ? c2cOf(rW.returnId) : null
  }
  const cl = await close(ctx, s1, { counted: 2_700_000, label: 'F10 close counted 2,700,000 with a pending card-to-card' })
  if (cl.ok) obs(ctx, 'close', { state: cl.closeObs.state, expected: cl.closeObs.expected, warnings: cl.closeObs.warnings })
  const pr = await pageReload(ctx, 'page reload after close')
  obs(ctx, 'afterCloseNewSession', { created: pr.created })
  if (reqW) {
    const pw1 = await call(ctx, 'manager pays the pending card-to-card after F10', 'either', IPC.cardTransferPay, { id: n(reqW.id), paidAmount: 700_000, managerPassword: PW })
    obs(ctx, 'payAfterClose', refusalObs(pw1))
    const auto = currentShiftId()
    if (!pw1.ok && auto) {
      await call(ctx, 'confirm staff of the new session', 'ok', IPC.shiftSessionStaff, { shiftId: auto, staffId: owner })
      const pw2 = await call(ctx, 'pay again after confirming staff', 'ok', IPC.cardTransferPay, { id: n(reqW.id), paidAmount: 700_000, managerPassword: PW })
      obs(ctx, 'payAfterConfirm', { ok: pw2.ok, wShelf: stockOf(W) - W.baseline, request: c2cRow(n(reqW.id)) })
    }
  }
  teardown()
})

// =================================================================== F. تجمیع
const fFloors = floors()
await run('F', 'تجمیع (F11) پیش از بستن صندوق، فروش پس از تجمیع، تجمیع دوباره در همان روز، سپس بستن صندوق', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session' })
  const s1 = n(o.data?.id)
  const v1 = V(ctx, 'کالا ۱', 500_000), v2 = V(ctx, 'کالا ۲', 300_000), v3 = V(ctx, 'کالا ۳', 200_000)
  const a = await sale(ctx, { items: [[v1]], pays: [['CASH', 500_000]], label: 'sale cash 500,000' })
  const pendingOf = (invoiceId) => (invoiceId ? countOf('StockMovement', "refType='SaleInvoice' AND refId=? AND state='PENDING'", invoiceId) : null)
  obs(ctx, 'beforeF11', { saleStockOut: v1.baseline - stockOf(v1), pendingMovements: pendingOf(a.invoiceId) })
  const f1 = await f11(ctx, 'F11 while the session is open (all of today so far)')
  if (f1.ok) obs(ctx, 'f11First', { daysDone: f1.f11Obs.daysDone, ownSalePending: pendingOf(a.invoiceId), ownSaleStockOut: v1.baseline - stockOf(v1) })
  const b0 = await sale(ctx, { items: [[v2]], pays: [['CASH', 300_000]], label: 'sale cash 300,000 after F11 (POS page)', expect: 'either' })
  obs(ctx, 'saleAfterF11', refusalObs(b0))
  const r0 = a.ok ? await ret(ctx, a.invoiceId, { full: true, method: 'CASH', label: 'return of the morning sale after F11 (no password)', expect: 'either' }) : { ok: false }
  obs(ctx, 'returnAfterF11', refusalObs(r0))
  unlock(PANEL_KEYS.salesReturn)
  const b = await call(ctx, 'sale cash 300,000 after F11 with manager password + reason in the request (the POS page has no such field)', 'either', IPC.saleCreate,
    { lines: [lineOf(v2)], payments: [PAY.CASH(300_000)], managerPassword: PW, overrideReason: 'مشتری پس از تجمیع آمد', saleRequestIdempotencyKey: `aud-sale-${++keySeq}` })
  obs(ctx, 'saleAfterF11WithPassword', refusalObs(b))
  const bId = b.ok ? n(b.data.id) : null
  const days = await invoke(IPC.consolidationDays, { fromJalali: today, toJalali: today })
  obs(ctx, 'dayStateAfterNewSale', days.ok ? { state: days.data.days[0]?.state, pendingInvoices: n(days.data.days[0]?.pendingInvoiceCount), consolidations: days.data.days[0]?.consolidationIds?.length ?? 0 } : { ok: false })
  const f2 = await f11(ctx, 'F11 again the same day')
  if (f2.ok) obs(ctx, 'f11Second', { invoices: f2.f11Obs.invoices, movements: f2.f11Obs.movements, newSalePending: pendingOf(bId), consolidationsToday: countOf('Consolidation', 'dayJalali=?', today) })
  const warnBefore = warnLog.length
  const f3 = await f11(ctx, 'F11 a third time with nothing new')
  if (f3.ok) obs(ctx, 'f11Third', { daysDone: f3.f11Obs.daysDone, daysSkipped: f3.f11Obs.daysSkipped, consoleWarnings: warnLog.length - warnBefore })
  const cl = await close(ctx, s1, { counted: 800_000, label: 'F10 close after F11, counted 800,000' })
  if (cl.ok) obs(ctx, 'closeAfterF11', { state: cl.closeObs.state, expected: cl.closeObs.expected, invoices: cl.closeObs.invoices })
  const pr = await pageReload(ctx, 'page reload after close')
  obs(ctx, 'afterCloseNewSession', { created: pr.created })
  const c3 = await sale(ctx, { items: [[v3]], pays: [['CASH', 200_000]], label: 'one more customer after F10 and F11', expect: 'either' })
  obs(ctx, 'saleAfterF10AndF11', refusalObs(c3))
  const auto = currentShiftId()
  if (auto) await call(ctx, 'confirm staff of the new session', 'ok', IPC.shiftSessionStaff, { shiftId: auto, staffId: owner })
  const c4 = await sale(ctx, { items: [[v3]], pays: [['CASH', 200_000]], label: 'the same customer after confirming staff', expect: 'either' })
  obs(ctx, 'saleAfterConfirm', refusalObs(c4))
  teardown()
  backdateSince(fFloors, 2) // تا امروزِ سناریوهای بعد «تجمیع‌شده» نماند
})

// =================================================================== G. فراموش کردن بستن صندوق
await run('G', 'بستن صندوق فراموش شد: صبح فردا، بستن بی‌شمارش با رمز مدیر، بعد شمارش همان نشست؛ و نشست کارمند دیگر', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session (owner)' })
  const g1 = n(o.data?.id)
  await movement(ctx, 'OPENING_FLOAT', 1_000_000, 'موجودی اول', { label: 'opening float 1,000,000' })
  const v = V(ctx, 'کالا', 800_000)
  await sale(ctx, { items: [[v]], pays: [['CASH', 800_000]], label: 'sale cash 800,000 — then the shop closes without F10' })
  backdateShift(g1)
  obs(ctx, 'morningStatus', await statusObs())
  const cur = await call(ctx, 'page reload in the morning (shift:current)', 'either', IPC.shiftCurrent, {})
  obs(ctx, 'morningShiftCurrent', refusalObs(cur))
  const s = await sale(ctx, { items: [[v]], pays: [['CASH', 800_000]], label: 'first sale of the morning', expect: 'either' })
  obs(ctx, 'morningSale', refusalObs(s))
  const c0 = await close(ctx, g1, { counted: 1_800_000, explicit: true, label: 'F10 in the morning for yesterday\'s open session', expect: 'either' })
  obs(ctx, 'morningF10', refusalObs(c0))
  const f = await f11(ctx, 'F11 in the morning', 'either', [today])
  obs(ctx, 'morningF11', refusalObs(f))
  const pv = await expected(ctx, g1, { label: 'F10 page preview of yesterday\'s session (read only)', expect: 'either' })
  obs(ctx, 'morningPreview', pv.ok ? { expectedCash: n(pv.data.expectedCash) } : refusalObs(pv))
  const o1 = await openSession(ctx, owner, { label: 'open today without password', reason: 'شروع روز', expect: 'refuse' })
  obs(ctx, 'openWithoutPassword', refusalObs(o1))
  const o2 = await openSession(ctx, owner, { label: 'open today with wrong password', reason: 'شروع روز', password: '9999', expect: 'refuse' })
  obs(ctx, 'openWrongPassword', refusalObs(o2))
  const o3 = await openSession(ctx, owner, { label: 'open today with reason + manager password', reason: 'دیشب صندوق بسته نشد', password: PW })
  obs(ctx, 'staleClosedWithoutCount', { ok: o3.ok, yesterdayClosed: seed.one('SELECT closedAt FROM "Shift" WHERE id=?', g1).closedAt != null, yesterdayCashSessions: sessionsFor(g1) })
  const c1 = await close(ctx, g1, { counted: 1_800_000, explicit: true, label: 'F10 for yesterday\'s session after that (same staff), counted 1,800,000' })
  obs(ctx, 'yesterdayCountedLater', c1.ok ? { state: c1.closeObs.state, expected: c1.closeObs.expected, shiftClosedNow: c1.closeObs.shiftClosed, sessions: sessionsFor(g1) } : refusalObs(c1))
  // نشست فروشندهٔ دوم که فراموش شد
  const o4 = await openSession(ctx, seller, { label: 'seller opens a session (owner\'s session still open)', expect: 'refuse' })
  obs(ctx, 'sellerOpenWithoutPassword', refusalObs(o4))
  const o5 = await openSession(ctx, seller, { label: 'seller opens with reason + manager password', reason: 'تعویض کارمند', password: PW })
  const g3 = n(o5.data?.id)
  const v2 = V(ctx, 'کالا ۲', 500_000)
  await sale(ctx, { items: [[v2]], pays: [['CASH', 500_000]], label: 'seller sale cash 500,000 — not closed' })
  backdateShift(g3)
  const o6 = await openSession(ctx, owner, { label: 'owner opens next morning with reason + password', reason: 'دیشب صندوق فروشنده بسته نشد', password: PW })
  obs(ctx, 'ownerOpensNextMorning', refusalObs(o6))
  const c2 = await close(ctx, g3, { counted: 500_000, explicit: true, label: 'owner counts the seller\'s session', expect: 'either' })
  obs(ctx, 'ownerCountsSellerSession', refusalObs(c2))
  const o7 = await openSession(ctx, seller, { label: 'seller opens (owner\'s session open) with reason + password', reason: 'شمارش صندوق دیشب', password: PW })
  const c3 = await close(ctx, g3, { counted: 500_000, explicit: true, label: 'seller counts own session from last night', expect: 'either' })
  obs(ctx, 'sellerCountsOwnSession', c3.ok ? { state: c3.closeObs.state, expected: c3.closeObs.expected } : refusalObs(c3))
  obs(ctx, 'managerPasswordsUsed', { count: [o3, o5, o6, o7].filter((x) => x.ok).length })
  teardown()
})

// =================================================================== P. پشتیبان و ادغام
let backup1 = null
let invoicesAtBackup1 = null
await run('P', 'پشتیبان فوری، ادغام همان بکاپ (دو بار)، بکاپ دارای اعتبار خرید، افزودن فایل بکاپ', async (ctx) => {
  const o = await openSession(ctx, owner, { label: 'open session' })
  const s1 = n(o.data?.id)
  await movement(ctx, 'OPENING_FLOAT', 500_000, 'موجودی اول', { label: 'opening float 500,000' })
  const v = V(ctx, 'کالا', 1_000_000)
  await sale(ctx, { items: [[v]], pays: [['CASH', 1_000_000]], label: 'sale cash 1,000,000' })
  const b0 = await call(ctx, 'backup now with wrong password', 'refuse', IPC.backupNow, { managerPassword: 'wrong-pass' })
  obs(ctx, 'backupWrongPassword', refusalObs(b0))
  const b1 = await call(ctx, 'backup now (manager password)', 'ok', IPC.backupNow, { managerPassword: PW })
  invoicesAtBackup1 = countOf('SaleInvoice')
  const list1 = await invoke(IPC.backupList, {})
  backup1 = list1.ok ? list1.data.find((e) => e.source === 'auto') ?? null : null
  obs(ctx, 'backupCreated', { ok: b1.ok, namePattern: backup1 ? backup1.fileName.replace(/[0-9]/g, '0') : null, listed: list1.ok ? list1.data.length : null, sizePositive: (backup1?.size ?? 0) > 0 })
  const v2 = V(ctx, 'کالا ۲', 200_000)
  await sale(ctx, { items: [[v2]], pays: [['CASH', 200_000]], label: 'sale cash 200,000 after the backup' })
  const repTotal = async () => { unlock(PANEL_KEYS.salesReports); const r = await invoke(IPC.saleReportRows, { fromJalali: today, toJalali: today }); return r.ok ? n(r.data.totals?.grandTotal) : null }
  const e0 = await expected(ctx, s1, { label: 'preview before merge' })
  const before = { invoices: countOf('SaleInvoice'), todayTotal: await repTotal(), expected: n(e0.data?.expectedCash), openingFloats: countOf('CashMovement', "shiftId=? AND type='OPENING_FLOAT'", s1), cashSessions: countOf('CashSession') }
  // ادغام، دفتر گردش انبارِ بکاپ را «سند تاریخی» می‌افزاید و به موجودی دست نمی‌زند (طراحی MergeService)؛ پس از آن سنجش دفتر = موجودی
  // برای این سناریو کنار می‌رود و همان فاصله به‌صورت «دیده» ثبت می‌شود.
  ctx.skipLedger = true
  const m1 = backup1 ? await call(ctx, 'merge the same-day backup into current data', 'either', IPC.backupApply, { id: backup1.id, mode: 'merge', managerPassword: PW }) : { ok: false, error: 'no backup' }
  const e1 = await expected(ctx, s1, { label: 'preview after merge' })
  const after1 = { invoices: countOf('SaleInvoice'), todayTotal: await repTotal(), expected: n(e1.data?.expectedCash), openingFloats: countOf('CashMovement', "shiftId=? AND type='OPENING_FLOAT'", s1), cashSessions: countOf('CashSession') }
  obs(ctx, 'mergeSameDay', { ok: m1.ok, before, after: after1, inserted: m1.ok ? Object.fromEntries(['SaleInvoice', 'Payment', 'CashSession', 'CashMovement', 'Consolidation', 'StockMovement'].map((k) => { const ins = m1.data.report?.inserted ?? {}; return [k, ins[k] ?? ins[k[0].toLowerCase() + k.slice(1)] ?? null] })) : null, matchedShifts: m1.ok ? m1.data.report?.matched?.Shift ?? null : null, warnings: m1.ok ? (m1.data.report?.warnings ?? []).length : null })
  const list2 = await invoke(IPC.backupList, {})
  obs(ctx, 'listAfterMerge', list2.ok ? list2.data.map((e) => ({ source: e.source, appliedMode: e.appliedMode ?? null })) : { ok: false })
  const m2 = backup1 ? await call(ctx, 'merge the same backup a second time', 'either', IPC.backupApply, { id: backup1.id, mode: 'merge', managerPassword: PW }) : { ok: false }
  obs(ctx, 'mergeAgain', { ok: m2.ok, invoices: countOf('SaleInvoice'), todayTotal: await repTotal() })
  obs(ctx, 'stockVsLedgerAfterMerges', { stock: stockOf(v), ledgerSum: v.baseline + n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })
  const cl = await close(ctx, s1, { counted: 1_700_000, note: 'شمارش واقعی کشو', label: 'F10 close after the merges, real count 1,700,000', expect: 'either' })
  obs(ctx, 'closeAfterMerges', cl.ok ? { state: cl.closeObs.state, expected: cl.closeObs.expected, diff: cl.closeObs.recordedDiff } : refusalObs(cl))
  teardown()
  // بکاپی که اعتبار خرید دارد
  await svc(ctx, 'issue a manual store credit 300,000', 'ok', () => storeCreditService.issueManual({ amount: 300_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId: owner, managerPassword: PW }))
  await sleep(1100)
  await call(ctx, 'backup now (contains a store credit)', 'ok', IPC.backupNow, { managerPassword: PW })
  const list3 = await invoke(IPC.backupList, {})
  const backup2 = list3.ok ? list3.data.filter((e) => e.source === 'auto').find((e) => e.id !== backup1?.id) ?? null : null
  const m3 = backup2 ? await call(ctx, 'merge a backup that has a store credit', 'refuse', IPC.backupApply, { id: backup2.id, mode: 'merge', managerPassword: PW }) : { ok: false, error: 'no second backup' }
  obs(ctx, 'mergeWithCredit', refusalObs(m3))
  // افزودن فایل بکاپ از دیسک (مثلاً از فلش)
  openDialog.result = { canceled: false, filePaths: [backup1 ? backup1.path : '/nonexistent'] }
  const im = await call(ctx, 'add a backup file from disk', 'ok', IPC.backupImport, {})
  openDialog.result = { canceled: true, filePaths: [] }
  obs(ctx, 'imported', im.ok ? { source: im.data?.entry?.source ?? null, invoiceCount: n(im.data?.entry?.summary?.invoiceCount), sameAsBackup1: n(im.data?.entry?.summary?.invoiceCount) === invoicesAtBackup1 } : refusalObs(im))
  const m4 = await call(ctx, 'replace with wrong password', 'refuse', IPC.backupApply, { id: backup1?.id ?? 'x', mode: 'replace', managerPassword: 'wrong-pass' })
  obs(ctx, 'replaceWrongPassword', refusalObs(m4))
})

// =================================================================== K. حضانت صندوق
await run('K', 'حضانت صندوق: باز کردن با رمز شخصی، فروش، «بستن نهایی» با شمارش کور، صبح فردا', async (ctx) => {
  const OWNER_PIN = 'Owner-Pin-7391!', SELLER_TMP = 'Seller-Tmp-48!', SELLER_PIN = 'Seller-Pin-5527!'
  await svc(ctx, 'owner sets personal custody PIN', 'ok', () => custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW }))
  await svc(ctx, 'enable custody (single shift)', 'ok', () => custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN }))
  await svc(ctx, 'owner issues a temporary PIN for the seller', 'ok', () => custodyService.setPin({ userId: seller, newPassword: SELLER_TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'راه‌اندازی آزمون صندوق' }))
  await svc(ctx, 'seller sets personal PIN', 'ok', () => custodyService.setPin({ userId: seller, currentPassword: SELLER_TMP, newPassword: SELLER_PIN }))
  const op = await call(ctx, 'seller opens the drawer: PIN + count 2,000,000', 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: 2_000_000 })
  const kShift = n(op.data?.shiftId)
  const v1 = V(ctx, 'کالا ۱', 700_000), v2 = V(ctx, 'کالا ۲', 300_000)
  await sale(ctx, { items: [[v1]], pays: [['CASH', 700_000]], label: 'sale cash 700,000' })
  await sale(ctx, { items: [[v2]], pays: [['CARD', 300_000]], label: 'sale card 300,000' })
  const l1 = await close(ctx, kShift, { counted: 2_700_000, label: 'old F10 close in custody mode', expect: 'refuse' })
  obs(ctx, 'legacyF10', refusalObs(l1))
  const l2 = await expected(ctx, kShift, { label: 'old F10 preview in custody mode', expect: 'refuse', check: false })
  obs(ctx, 'legacyPreview', refusalObs(l2))
  const l3 = await openSession(ctx, owner, { label: 'old session form in custody mode', expect: 'refuse' })
  obs(ctx, 'legacySessionOpen', refusalObs(l3))
  const before = openShifts()
  const cur = await call(ctx, 'page reload (shift:current)', 'ok', IPC.shiftCurrent, {})
  obs(ctx, 'shiftCurrentInCustody', { isCustodyShift: n(cur.data?.id) === kShift, newSessions: openShifts().length - before.length })
  const cashSessionsBefore = countOf('CashSession')
  const fc = await call(ctx, '«بستن نهایی»: PIN + blind count 2,900,000 (100,000 short)', 'ok', IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: 2_900_000 })
  const bnd = seed.one('SELECT boundaryKind,newDifference FROM "CustodyAggregateBoundary" ORDER BY id DESC LIMIT 1')
  obs(ctx, 'finalClose', { ok: fc.ok, state: fc.data?.state ?? null, boundary: bnd?.boundaryKind ?? null, difference: bnd ? n(bnd.newDifference) : null, cases: countOf('CustodyDiscrepancyCase'), newCashSessions: countOf('CashSession') - cashSessionsBefore, shiftClosed: seed.one('SELECT closedAt FROM "Shift" WHERE id=?', kShift)?.closedAt != null })
  const before2 = openShifts()
  await call(ctx, 'page reload after «بستن نهایی»', 'either', IPC.shiftCurrent, {})
  obs(ctx, 'afterFinalCloseNewSessions', { created: openShifts().length - before2.length })
  const s3 = await sale(ctx, { items: [[v1]], pays: [['CASH', 700_000]], label: 'sale after «بستن نهایی»', expect: 'refuse' })
  obs(ctx, 'saleAfterFinalClose', refusalObs(s3))
  const f = await f11(ctx, 'F11 after «بستن نهایی»', 'either')
  obs(ctx, 'f11AfterFinalClose', refusalObs(f))
  const op2 = await call(ctx, 'next morning: seller opens with PIN + count 2,900,000 (no manager password)', 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: 2_900_000 })
  obs(ctx, 'morningOpen', { ok: op2.ok, countStatus: op2.data?.countStatus ?? null, newCases: countOf('CustodyDiscrepancyCase') })
  const k2 = n(op2.data?.shiftId)
  await sale(ctx, { items: [[v1]], pays: [['CASH', 700_000]], label: 'sale cash 700,000 — then nobody presses «بستن نهایی»' })
  // گذشتن از لحظهٔ بستن خودکار (rolloverAt هنگام باز شدن صندوق ثبت می‌شود؛ کد امروز ساعت ۵ صبح، توافق دفتر: تک‌شیفت ساعت ۲۴ (۴-۱۸)،
  // «مغازه شب می‌بندد» شروع شیفت اول (۴-۱۷)، «۲۴ساعته» ساعت ۲۴ (۴-۲۳)؛ این سناریو به ساعت وابسته نیست)
  if (k2) sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(Date.now() - 60_000, k2)
  const st = await invoke(IPC.custodyStatus, {})
  obs(ctx, 'afterAutoClose', st.ok ? { state: st.data.state, unresolved: n(st.data.unresolvedCount), nightExpectedKnown: st.data.unresolved?.[0]?.nightExpectedCash != null, shiftClosed: k2 ? seed.one('SELECT closedAt FROM "Shift" WHERE id=?', k2)?.closedAt != null : null } : { ok: false })
  const s4 = await sale(ctx, { items: [[v1]], pays: [['CASH', 700_000]], label: 'first sale after the automatic close', expect: 'refuse' })
  obs(ctx, 'saleAfterAutoClose', refusalObs(s4))
  const resolutionId = st.ok ? n(st.data.unresolved?.[0]?.id) : 0
  const csBefore = countOf('CashSession')
  // کشو واقعاً ۲٬۹۰۰٬۰۰۰ (افتتاح صبح) + ۷۰۰٬۰۰۰ (فروش نقدی) = ۳٬۶۰۰٬۰۰۰ دارد؛ کارت‌خوان این نشست صفر بود.
  let rec = await call(ctx, 'morning witness: seller PIN + real count 3,600,000 of the old drawer', 'ok', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: 3_600_000 })
  obs(ctx, 'morningWitnessWithoutNote', refusalObs(rec))
  if (!rec.ok) rec = await call(ctx, 'morning witness again with a note', 'ok', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: 3_600_000, note: 'شمارش واقعی کشو صبح' })
  const cs = seed.one('SELECT expectedCash,countedTotal,cashDifference FROM "CashSession" ORDER BY id DESC LIMIT 1')
  obs(ctx, 'morningWitness', { ok: rec.ok, newCashSessions: countOf('CashSession') - csBefore, expected: cs ? n(cs.expectedCash) : null, counted: cs?.countedTotal == null ? null : n(cs.countedTotal), diff: cs ? n(cs.cashDifference) : null })
  const op3 = await call(ctx, 'then a new drawer: seller PIN + count 3,600,000', 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: 3_600_000 })
  obs(ctx, 'openAfterWitness', refusalObs(op3))
  const f2 = await f11(ctx, 'F11 while the drawer is open', 'either')
  obs(ctx, 'f11WhileOpen', f2.ok ? { ok: true, daysDone: f2.f11Obs.daysDone } : refusalObs(f2))
  const s5 = await sale(ctx, { items: [[v2]], pays: [['CARD', 300_000]], label: 'a customer after F11 (custody mode, 4-41 not yet done)', expect: 'either' })
  obs(ctx, 'saleAfterF11InCustody', refusalObs(s5))
})

// =================================================================== R. جایگزینی کامل (آخرین گام)
const secretCodes = [
  ...seed.rows('SELECT code FROM "StoreCredit"').map((r) => String(r.code)),
  ...seed.rows('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').map((r) => String(r.returnCode))
].filter((c) => c.length >= 4).sort((a, b) => b.length - a.length)
await run('R', 'جایگزینی کامل با بکاپ صبح: همه‌چیز پس از بکاپ برمی‌گردد و یک بکاپ ایمنی ساخته می‌شود', async (ctx) => {
  const invoicesBefore = countOf('SaleInvoice')
  const custodyMetaBefore = countOf('CustodyShiftMeta')
  const backupsDir = join(dir, 'backups')
  const r = backup1 ? await call(ctx, 'replace current data with the morning backup', 'ok', IPC.backupApply, { id: backup1.id, mode: 'replace', managerPassword: PW }) : { ok: false, error: 'no backup' }
  await sleep(1400)
  const files = existsSync(backupsDir) ? readdirSync(backupsDir) : []
  const safetyName = files.find((f) => f.startsWith('before-restore-')) ?? null
  const listed = await backupService.list().catch(() => [])
  const live = new DatabaseSync(join(dir, 'data', 'shop.db'), { readOnly: true })
  const liveInvoices = n(live.prepare('SELECT COUNT(*) c FROM "SaleInvoice"').get().c)
  const liveCustody = n(live.prepare('SELECT COUNT(*) c FROM "CustodyShiftMeta"').get().c)
  live.close()
  let safetyInvoices = null, safetyCustody = null
  if (safetyName) {
    const s = new DatabaseSync(join(backupsDir, safetyName), { readOnly: true })
    safetyInvoices = n(s.prepare('SELECT COUNT(*) c FROM "SaleInvoice"').get().c)
    safetyCustody = n(s.prepare('SELECT COUNT(*) c FROM "CustodyShiftMeta"').get().c)
    s.close()
  }
  obs(ctx, 'replace', {
    ok: r.ok, willRestart: r.data?.willRestart ?? null, relaunched: relaunches,
    liveEqualsBackup: liveInvoices === invoicesAtBackup1, liveHasCustody: liveCustody > 0, custodyBefore: custodyMetaBefore > 0,
    safetyBackupMade: !!safetyName, safetyHasEverything: safetyInvoices === invoicesBefore && safetyCustody === custodyMetaBefore,
    lastRestoreNote: files.includes('last-restore.txt'),
    safetyInRestoreList: listed.some((e) => String(e.fileName).startsWith('before-restore-')),
    restoreListSources: [...new Set(listed.map((e) => e.source))].sort()
  })
  ctx.notes.push('هارنس پس از جایگزینی دوباره وصل نمی‌شود ($connect ندارد)؛ پس ردیف سابقهٔ «بازگردانی» در پایگاه تازه اینجا سنجیده نمی‌شود (در برنامهٔ واقعی پس از اتصال دوباره نوشته می‌شود).')
})

// =================================================================== summary, snapshot, compare
const byType = new Map()
for (const f of allFindings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1)
const summary = {
  scenarios: scenarios.length,
  steps: scenarios.reduce((s, x) => s + x.steps.length, 0),
  refusals: scenarios.reduce((s, x) => s + x.refusals.length, 0),
  observations: scenarios.reduce((s, x) => s + (x.obs?.length ?? 0), 0),
  scenariosWithFindings: scenarios.filter((x) => x.findings.length).length,
  findingTypes: Object.fromEntries(byType)
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, scenarios, ipcErrors, warnLog }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))

// Normalised result: no ids, no dates or times, no codes — behaviour, amounts and texts.
// Persian digits become «#» and Latin digits «0», so a change of digit script in a message is still visible.
const normStr = (t, onlyFirstLine = true) => {
  let s = String(t ?? '')
  if (onlyFirstLine) s = s.split('\n')[0]
  for (const c of secretCodes) if (s.includes(c)) s = s.split(c).join('«کد»')
  return s.replace(/[۰-۹٠-٩][۰-۹٠-٩٬,\/:.]*/g, '#').replace(/[0-9][0-9,\/:.]*/g, '0').slice(0, 240)
}
const normText = (t) => normStr(t, true)
const normDeep = (v) => {
  if (typeof v === 'string') return normStr(v, false)
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(normDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normDeep(x)]))
  return v ?? null
}
const snapshot = scenarios.map((s) => ({
  id: s.id,
  steps: s.steps.map((st) => [normText(st.label), st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? normDeep(st.brief ?? null) : `${st.code ? '[' + st.code + '] ' : ''}${normText(st.msg)}`]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${normText(f.label)}`))].sort(),
  obs: normDeep(s.obs ?? [])
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/cash-close-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify(snapshotDoc, null, 1) + '\n')
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)

if (COMPARE) {
  const base = JSON.parse(readFileSync(COMPARE, 'utf8')).scenarios
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const b = byId.get(s.id)
    if (!b) { diffs.push(`+ سناریوی تازه: ${s.id}`); continue }
    byId.delete(s.id)
    const len = Math.max(s.steps.length, b.steps.length)
    for (let i = 0; i < len; i++) {
      const x = JSON.stringify(s.steps[i] ?? null), y = JSON.stringify(b.steps[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · گام ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const olen = Math.max(s.obs.length, (b.obs ?? []).length)
    for (let i = 0; i < olen; i++) {
      const x = JSON.stringify(s.obs[i] ?? null), y = JSON.stringify((b.obs ?? [])[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · دیدهٔ ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const x = JSON.stringify(s.findings), y = JSON.stringify(b.findings)
    if (x !== y) diffs.push(`${s.id} · findings\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- سناریو نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 500)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
