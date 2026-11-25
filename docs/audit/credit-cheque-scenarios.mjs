/**
 * آزمون سناریوهای چک و نسیه — فروش در «صندوق فروش» و «فاکتور فروش عمده» با هر ترکیبی از نقد، کارت،
 * چک (در جریان / پاس‌شده / برگشت‌خورده)، نسیه با مشخصات بدهکار و بارکد اعتبار؛ با یک کالا و با چند کالا.
 * روی هر فروش فقط «یک» برگشت یا «یک» تعویض انجام می‌شود (قاعدهٔ تازهٔ مالک، ۲۰۲۶-۱۱-۲۵: فروش چکی/نسیه فقط یک
 * برگشت یا تعویض دارد؛ پس زنجیره آزموده نمی‌شود). بعد فقط «تلاش» برای برگشت/تعویض دوم ثبت می‌شود تا روشن شود
 * برنامهٔ امروز آن را می‌پذیرد یا نه.
 *
 * فقط ابزار آزمون است: روی پایگاه دادهٔ موقت (پوشهٔ temp) اجرا می‌شود، چاپگر شبیه‌سازی‌شده است و به برنامه،
 * پایگاه واقعی یا آزمون‌های مخزن دست نمی‌زند. در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/credit-cheque-scenarios.mjs
 *   ... --out <file.json[.gz]>   نتیجهٔ فشرده (بی کد، بی شناسه، بی تاریخ) برای مقایسه؛ با .gz فشرده نوشته می‌شود
 *   AUD_SHARDS=<n>    شمار پردازه‌های هم‌زمان، هر کدام با پایگاه موقت خودش (پیش‌فرض ۲)
 *   ... --compare docs/audit/credit-cheque-scenarios-2026-11-25.json.gz
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_ONLY=<regex>  فقط سناریوهای هم‌نام    AUD_VERBOSE=1  ریز هر گام
 *
 * پس از هر عملیات این سنجش‌ها انجام می‌شود: گزارش فروش با ردیف‌های خام، صندوق امانی با ردیف‌های خام، دفتر
 * موجودی، موجودی با سندها، ماندهٔ هر بارکد با دفتر مصرفش، «بدهیِ» صفحهٔ پرداخت‌های فاکتور با محاسبهٔ خام، و
 * معادلهٔ ارزش:
 *   نقد + کارت + چکِ پاس‌شده + بارکدِ آورده + بدهیِ مانده  =  پول پس‌داده + کارت‌به‌کارت + اعتبار زنده + کالای مانده
 *                                                             + اضافه‌دریافتِ ثبت‌شده (طلب مشتری)
 * و بی‌اثر بودنِ هر کارِ ردشده. برای هر برگشت/تعویض، ترتیب واقعیِ برنامه (بدهی ← بارکد ← چک/پول) کنار ترتیبی که
 * مالک خواسته (۱ کم شدن بدهی نسیه ← ۲ سهم بارکد طبق قاعدهٔ بارکد ← ۳ پیشنهاد چک (جایگزینی/ابطال) یا پول) ثبت
 * می‌شود؛ این‌ها «یافتهٔ خطا» نیستند، «فاصله با جریان مالک»اند و جدا شمرده می‌شوند.
 */
import { register } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
const dir = mkdtempSync(join(tmpdir(), 'credit-cheque-scenarios-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)

const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 777001, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)

const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { salesService } = await imp('/src/main/services/SalesService.ts')
const { storeCreditService } = await imp('/src/main/services/StoreCreditService.ts')
const { cardTransferService } = await imp('/src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await imp('/src/main/services/CustodyAggregateService.ts')
const { invoiceRemaining } = await imp('/src/main/services/invoiceDebt.ts')
const { printService } = await imp('/src/main/services/PrintService.ts')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked, clearPanelSessions } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const { toJalaliDate } = await imp('/src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const dueJalali = toJalaliDate(new Date(Date.now() + 30 * 86400000))
const n = (x) => Number(x ?? 0)
const VERBOSE = process.env.AUD_VERBOSE === '1'
const ONLY = process.env.AUD_ONLY ? new RegExp(process.env.AUD_ONLY) : null

const userId = seed.user('فروشنده ممیزی چک و نسیه')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
/** همان ردیفی که `chequeMethodId` برنامه در نخستین ثبت چک می‌سازد؛ از پیش ساخته شد تا شناسه‌ها ثابت بمانند. */
const chequeM = seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
const cat = seed.category('ممیزی چک و نسیه')
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const DEFAULT_LOCKS = { [PANEL_KEYS.salesReturn]: true, [PANEL_KEYS.creditManagement]: true, [PANEL_KEYS.settings]: true }
seed.setting(SETTING_KEYS.panelLocks, DEFAULT_LOCKS)

registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  return fn({ sender }, payload)
}
const REAL = [{ name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: true }, { name: 'Axiom', displayName: 'Axiom', isDefault: false }]
const printers = () => { mock.reset(); mock.state.printers = REAL.map((p) => ({ ...p })); mock.state.executeJavaScriptOutcome = 500 }
notePanelUnlocked(PANEL_KEYS.settings, 'PANEL', sender.id)
printers()
{
  const r = await invoke(IPC.creditCertificatePrinterSet, { printerName: 'Axiom' })
  if (!r?.ok) throw new Error('certificate printer set failed: ' + JSON.stringify(r))
}
clearPanelSessions(sender.id)
const resetCodeGate = () => sql.prepare('DELETE FROM "AuthLockout" WHERE gate = ?').run('__credit_code__')

// ------------------------------------------------------------------ results and invariants
const scenarios = []
const allFindings = []
let shiftSeq = 0, vseq = 0, keySeq = 0, chequeSeq = 0

function rawCredit(id) { return seed.one('SELECT * FROM "StoreCredit" WHERE id=?', id) }
function rawPhysical(shiftId) {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.amount), refundCard: n(r.amount) }
}
/** چک پاس‌شده (مقصد «حساب مدیر») پول واقعیِ دریافت‌شده است ولی به کشو/کارت‌خوان نمی‌آید. */
function clearedCheques(shiftId) {
  return n(seed.one(`SELECT COALESCE(SUM(p.amount),0) a FROM "Payment" p JOIN "SaleInvoice" s ON s.id=p.invoiceId
    WHERE s.shiftId=? AND p.kind='CHEQUE' AND p.chequeStatus='CLEARED' AND p.voidedAt IS NULL`, shiftId).a)
}
function c2cTotal(shiftId) {
  const rows = seed.rows(`SELECT amount FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) AND status <> 'CANCELED'`, shiftId)
  return rows.reduce((s, r) => s + n(r.amount), 0)
}
function liveCreditValue(floorId) {
  const rows = seed.rows('SELECT * FROM "StoreCredit" WHERE id > ?', floorId)
  const byLineage = new Map()
  const nowMs = Date.now()
  for (const r of rows) {
    const usable = ['ACTIVE', 'PARTIALLY_USED'].includes(r.status) && r.voidedAt == null && r.deletedAt == null && r.suspendedAt == null &&
      (r.expiresAt == null || n(r.expiresAt) > nowMs)
    const local = usable ? Math.max(0, n(r.amount) - n(r.usedAmount)) : 0
    const lid = r.lineageId == null ? n(r.id) : n(r.lineageId)
    byLineage.set(lid, (byLineage.get(lid) ?? 0) + local)
  }
  let total = 0
  for (const [lid, local] of byLineage) {
    const lin = seed.one('SELECT issuedAmount, usedAmount FROM "StoreCreditLineage" WHERE id=?', lid)
    total += lin ? Math.min(local, Math.max(0, n(lin.issuedAmount) - n(lin.usedAmount))) : local
  }
  return total
}
const NOT_CORRECTED = `NOT EXISTS (SELECT 1 FROM "ReturnCorrection" c WHERE c.returnId=r.id AND c.status='POSTED')`
function keptGoods(shiftId) {
  let total = 0
  const invs = seed.rows('SELECT id,status FROM "SaleInvoice" WHERE shiftId=?', shiftId)
  for (const inv of invs) {
    if (inv.status === 'CANCELED') continue
    for (const it of seed.rows('SELECT id,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', inv.id)) {
      const back = n(seed.one(`SELECT COALESCE(SUM(ri.qty),0) q FROM "SaleReturnItem" ri JOIN "SaleReturn" r ON r.id=ri.returnId WHERE ri.saleItemId=? AND r.voidedAt IS NULL AND ${NOT_CORRECTED}`, it.id).q)
      total += (n(it.qty) - back) * (n(it.lineTotal) / Math.max(1, n(it.qty)))
    }
  }
  return Math.round(total)
}
/** بدهی/اضافه‌دریافت هر فاکتور: صفحهٔ «پرداختی‌ها» در برابر محاسبهٔ خام با همان فرمول واحد برنامه. */
async function invoiceDebt(invoiceId) {
  const inv = seed.one('SELECT id,grandTotal,status FROM "SaleInvoice" WHERE id=?', invoiceId)
  const pays = seed.rows('SELECT amount,kind,chequeStatus FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', invoiceId)
  const received = pays.reduce((s, p) => s + ((p.kind ?? 'CASH') !== 'CHEQUE' || p.chequeStatus === 'CLEARED' ? Math.max(0, n(p.amount)) : 0), 0)
  const raw = await invoiceRemaining(db, invoiceId, n(inv.grandTotal), received)
  const cheques = seed.rows(`SELECT amount,chequeStatus FROM "Payment" WHERE invoiceId=? AND kind='CHEQUE' AND voidedAt IS NULL`, invoiceId)
  const pending = cheques.filter((c) => c.chequeStatus === 'PENDING').reduce((s, c) => s + n(c.amount), 0)
  const bounced = cheques.filter((c) => c.chequeStatus === 'BOUNCED').reduce((s, c) => s + n(c.amount), 0)
  const overpayCredit = n(seed.one(`SELECT COALESCE(SUM(amount),0) a FROM "StoreCredit" WHERE sourceInvoiceId=? AND source LIKE 'OVERPAY%' AND voidedAt IS NULL`, invoiceId).a)
  return { status: inv.status, remaining: n(raw.remaining), overpaid: n(raw.overpaid), received, pending, bounced, overpayCredit }
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

function sig(ctx) {
  return JSON.stringify({
    inv: seed.count('SaleInvoice', '1=1'),
    ret: seed.count('SaleReturn', '1=1'),
    pay: seed.rows('SELECT id,voidedAt IS NULL v,chequeStatus,amount FROM "Payment" WHERE id>?', ctx.payFloor),
    cm: seed.count('CashMovement', '1=1'),
    red: seed.count('StoreCreditRedemption', '1=1'),
    ct: seed.count('CardTransferRequest', '1=1'),
    sc: seed.rows('SELECT id,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id>?', ctx.creditFloor),
    lin: seed.rows('SELECT id,usedAmount,usedCount FROM "StoreCreditLineage"'),
    stock: ctx.variants.map((v) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
  })
}

async function verify(ctx, label) {
  const report = await salesService.reportRows({ shiftId: ctx.shiftId })
  const rep = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  const raw = rawPhysical(ctx.shiftId)
  if (JSON.stringify(rep) !== JSON.stringify(raw)) finding(ctx, 'REPORT_VS_RAW', label, { rep, raw })
  const blue = n(await physicalMovementForCustodyShift(ctx.shiftId))
  const blueRaw = raw.cash + raw.card - raw.refundCash - raw.refundCard
  if (blue !== blueRaw) finding(ctx, 'CUSTODY_VS_RAW', label, { blue, blueRaw })
  for (const v of ctx.variants) {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    if (actual !== v.baseline + ledger) finding(ctx, 'STOCK_LEDGER', label, { v: v.label, actual, baseline: v.baseline, ledger })
    const sold = n(seed.one(`SELECT COALESCE(SUM(i.qty),0) q FROM "SaleInvoiceItem" i JOIN "SaleInvoice" s ON s.id=i.invoiceId WHERE i.variantId=? AND s.status<>'CANCELED' AND s.deductInventory=1`, v.id).q)
    const restocked = n(seed.one(`SELECT COALESCE(SUM(ri.restockedQty),0) q FROM "SaleReturnItem" ri JOIN "SaleReturn" r ON r.id=ri.returnId WHERE ri.variantId=? AND r.voidedAt IS NULL AND ${NOT_CORRECTED}`, v.id).q)
    if (v.baseline - actual !== sold - restocked) finding(ctx, 'STOCK_VS_DOCS', label, { v: v.label, shelfOut: v.baseline - actual, sold, restocked })
  }
  const rows = seed.rows('SELECT * FROM "StoreCredit" WHERE id>?', ctx.creditFloor)
  for (const r of rows) {
    if (n(r.usedAmount) < 0 || n(r.usedAmount) > n(r.amount)) finding(ctx, 'CREDIT_OVERDRAWN', label, { id: r.id, amount: r.amount, used: r.usedAmount })
    const reds = seed.rows('SELECT id,amount,reversedAt FROM "StoreCreditRedemption" WHERE creditId=?', r.id)
    const restored = new Map()
    for (const a of seed.rows('SELECT redemptionId,amount FROM "CreditReturnAllocation" WHERE sourceCreditId=? AND creditRestored=1', r.id))
      restored.set(n(a.redemptionId), (restored.get(n(a.redemptionId)) ?? 0) + n(a.amount))
    const net = reds.filter((x) => x.reversedAt == null).reduce((s, x) => s + Math.max(0, n(x.amount) - (restored.get(n(x.id)) ?? 0)), 0)
    if (['ACTIVE', 'PARTIALLY_USED'].includes(r.status) && n(r.usedAmount) !== net) finding(ctx, 'CREDIT_USED_VS_REDEMPTIONS', label, { id: r.id, status: r.status, used: n(r.usedAmount), net })
    if (r.status === 'USED' && n(r.usedAmount) < net) finding(ctx, 'CREDIT_USED_UNDERSTATED', label, { id: r.id, used: n(r.usedAmount), net })
  }
  for (const l of seed.rows('SELECT * FROM "StoreCreditLineage" WHERE id IN (SELECT COALESCE(lineageId,id) FROM "StoreCredit" WHERE id>?)', ctx.creditFloor))
    if (n(l.usedAmount) < 0 || n(l.usedAmount) > n(l.issuedAmount)) finding(ctx, 'LINEAGE_OVERDRAWN', label, l)
  let debt = 0, owed = 0
  for (const inv of seed.rows('SELECT id FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', ctx.shiftId)) {
    const d = await invoiceDebt(inv.id)
    if (d.status === 'CANCELED') continue
    debt += d.remaining
    owed += Math.max(0, d.overpaid - d.overpayCredit)
    const view = await salesService.payments({ invoiceId: inv.id })
    if (n(view.remaining) !== d.remaining || n(view.pendingChequeTotal ?? 0) !== d.pending)
      finding(ctx, 'PAYMENTS_VIEW_VS_RAW', label, { invoiceId: inv.id, view: { remaining: n(view.remaining), pending: n(view.pendingChequeTotal) }, raw: { remaining: d.remaining, pending: d.pending } })
  }
  const paidIn = raw.cash + raw.card
  const chequeIn = clearedCheques(ctx.shiftId)
  const physOut = raw.refundCash + raw.refundCard
  const c2c = c2cTotal(ctx.shiftId)
  const live = liveCreditValue(ctx.creditFloor)
  const kept = keptGoods(ctx.shiftId)
  const writeOff = n(seed.one(`SELECT COALESCE(SUM(c.unrecoveredAmount),0) a FROM "ReturnCorrection" c JOIN "SaleReturn" r ON r.id=c.returnId WHERE r.shiftId=? AND c.status='POSTED'`, ctx.shiftId).a)
  const inV = paidIn + chequeIn + ctx.manualIssued + writeOff + debt
  const outV = physOut + c2c + live + kept + owed
  ctx.lastValue = { paidIn, chequeIn, manual: ctx.manualIssued, writeOff, debt, physOut, c2c, live, kept, owed, delta: inV - outV }
  if (physOut + c2c > paidIn + chequeIn) finding(ctx, 'PHYSICAL_OUT_GT_IN', label, ctx.lastValue)
  if (inV - outV < 0) finding(ctx, 'VALUE_LEAK_TO_CUSTOMER', label, ctx.lastValue)
  if (inV - outV > 0) finding(ctx, 'VALUE_LOSS_FOR_CUSTOMER', label, ctx.lastValue)
}

async function step(ctx, label, expect, fn) {
  const before = sig(ctx)
  let res, err
  try { res = await fn() } catch (e) { err = e }
  if (err) {
    const msg = String(err?.message ?? err)
    if (sig(ctx) !== before) finding(ctx, 'REFUSAL_NOT_ATOMIC', label, msg)
    ctx.refusals.push({ label, msg, expected: expect !== 'ok' })
    if (expect === 'ok') finding(ctx, 'UNEXPECTED_REFUSAL', label, msg)
    ctx.steps.push({ label, ok: false, expect, msg: msg.slice(0, 400) })
    if (VERBOSE) console.log(`   ✗ ${label}: ${msg.split('\n')[0].slice(0, 160)}`)
    await verify(ctx, label + ' [after refusal]')
    return { ok: false, error: msg }
  }
  if (expect === 'refuse') finding(ctx, 'ACCEPTED_BUT_SHOULD_REFUSE', label, brief(res))
  ctx.steps.push({ label, ok: true, expect, brief: brief(res) })
  if (VERBOSE) console.log(`   ✓ ${label} ${JSON.stringify(brief(res)).slice(0, 200)}`)
  await verify(ctx, label)
  return { ok: true, res }
}
function brief(r) {
  if (!r || typeof r !== 'object') return r
  const keys = ['grandTotal', 'paidTotal', 'remaining', 'storeCreditApplied', 'total', 'refundMethod', 'refundAmount', 'returnCreditAmount', 'sourceCreditRestoredAmount',
    'diff', 'cashReceived', 'cardReceived', 'barcodeCreditApplied', 'cashRefunded', 'cardRefunded', 'realMoneyRefundAmount', 'newStoreCreditAmount', 'payoutAmount', 'refundMode', 'settlement', 'debtReduction', 'idempotentReplay', 'replayed']
  const o = {}
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]
  if (r.storeCreditOutcomes) o.creditOutcomes = r.storeCreditOutcomes.map((x) => `${x.status}:${x.amount}`)
  if (r.storeCredit) o.storeCredit = { amount: r.storeCredit.amount }
  if (r.overpayCredit) o.overpayCredit = { amount: r.overpayCredit.amount }
  if (r.sourceCreditSuccessors?.length) o.successors = r.sourceCreditSuccessors.map((s) => s.amount)
  if (r.cardTransfer) o.cardTransfer = Number(r.cardTransfer.amount)
  if (Array.isArray(r.chequesAutoVoided)) o.chequesAutoVoided = r.chequesAutoVoided.length
  if (Array.isArray(r.chequesNeedReview)) o.chequesNeedReview = r.chequesNeedReview.length
  if (r.payment && typeof r.payment === 'object') o.payment = { kind: r.payment.kind, amount: n(r.payment.amount), chequeStatus: r.payment.chequeStatus ?? null }
  if (r.voided === true) o.voided = true
  return o
}

function newCtx(id, title, opts = {}) {
  const shiftId = seed.insert('Shift', { name: `AUD ${id}`, number: 700 + (++shiftSeq), dayJalali: today, openedAt: Date.now() - 5000, userId })
  const creditFloor = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "StoreCredit"').m)
  const payFloor = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "Payment"').m)
  resetCodeGate()
  return { id, title, shiftId, creditFloor, payFloor, variants: [], manualIssued: 0, steps: [], findings: [], findingKeys: new Set(), refusals: [], notes: [], units: [], gaps: [], lastValue: null, ...opts }
}
function V(ctx, label, price, stock = 30) {
  const pid = seed.product(`${ctx.id}-${label}-${++vseq}`, cat)
  const id = seed.variant(pid, `${label}-${vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(stock, price, id)
  const v = { id, label, price, baseline: stock }
  ctx.variants.push(v)
  return v
}
async function issueManual(ctx, amount) {
  const r = await storeCreditService.issueManual({ amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId, managerPassword: PW })
  ctx.manualIssued += amount
  const row = rawCredit(r.id)
  return { id: n(r.id), code: row.code, amount }
}
const lineOf = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const itemsOf = (invoiceId) => seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const itemFor = (invoiceId, v) => itemsOf(invoiceId).find((r) => n(r.variantId) === v.id)
const maxCreditId = () => n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "StoreCredit"').m)
const DEBTOR = { firstName: 'رضا', lastName: 'ممیزی', phone: '09121234567', nationalId: null }

// =================================================================== tender plan
/**
 * اجزای پرداخت: B بارکد اعتبار، C نقد، K کارت، Q چک، N نسیه (بدهی با مشخصات بدهکار).
 * سهم‌ها روی جمع ۱٬۰۰۰٬۰۰۰ ریال: B ۱۵۰ هزار، C ۲۰۰ هزار، K ۲۵۰ هزار، Q ۳۰۰ هزار وقتی N هم هست وگرنه «باقی»،
 * N همیشه «باقی». هر ترکیب دست‌کم Q یا N دارد (ترکیب‌های بی چک و بی نسیه در ابزار صندوق فروش آزموده شده‌اند).
 */
const COMPS = ['B', 'C', 'K', 'Q', 'N']
const COMP_FA = { B: 'بارکد', C: 'نقد', K: 'کارت', Q: 'چک', N: 'نسیه' }
const QSTATE_FA = { P: 'در جریان', CL: 'پاس‌شده', BO: 'برگشت‌خورده' }
function planParts(combo, total) {
  const has = (c) => combo.includes(c)
  const parts = { B: 0, C: 0, K: 0, Q: 0, N: 0 }
  if (has('B')) parts.B = 150_000
  if (has('C')) parts.C = 200_000
  if (has('K')) parts.K = 250_000
  const fixed = parts.B + parts.C + parts.K
  if (has('Q')) parts.Q = has('N') ? 300_000 : total - fixed
  if (has('N')) parts.N = total - fixed - parts.Q
  return parts
}
function combos() {
  const out = []
  for (let mask = 1; mask < 32; mask++) {
    const c = COMPS.filter((_, i) => mask & (1 << i))
    if (c.includes('Q') || c.includes('N')) out.push(c.join(''))
  }
  return out.sort((a, b) => a.length - b.length || COMPS.indexOf(a[0]) - COMPS.indexOf(b[0]) || a.localeCompare(b))
}

/**
 * فروش با یک ترکیب پرداخت، همان‌طور که فروشنده امروز می‌تواند ثبت کند:
 *  - صندوق فروش: بارکد در کادر بارکد؛ یک روش پرداخت برای «پرداخت الان» (نقد، یا کارت اگر نقد نیست) با تیک نسیه و
 *    مشخصات بدهکار؛ اگر نقد و کارت هر دو هست، کارت بعداً در «پرداختی‌ها» ثبت می‌شود (نقد + کارت + نسیه هم‌زمان در
 *    صفحه امروز نیست؛ ۴-۵۶).
 *  - فاکتور عمده: همان محمولهٔ صفحه (یک بارکد، یک ردیف پرداخت بی مقصد) به‌علاوهٔ مشخصات بدهکار که ۴-۵۷ اضافه
 *    می‌کند (صفحهٔ امروز بدهکار نمی‌فرستد، پس فاکتور عمدهٔ نسیه امروز ثبت نمی‌شود).
 *  - چک همیشه پس از فروش از «پرداختی‌ها» (`addPayment`) ثبت می‌شود (چک در پرداخت اولیه پذیرفته نیست)، سپس در
 *    صورت نیاز «پاس شد» (مقصد حساب مدیر) یا «برگشت خورد» با رمز مدیر.
 */
async function creditSale(ctx, { channel, items, combo, qstate, label }) {
  const total = items.reduce((s, it) => s + it.v.price * (it.qty ?? 1), 0)
  const parts = planParts(combo, total)
  const lbl = label ?? `${channel} sale ${items.length} item(s) ${combo}${qstate ? '/' + qstate : ''}`
  let credit = null
  if (parts.B) credit = await issueManual(ctx, parts.B)
  const nowMethod = parts.C ? 'C' : parts.K ? 'K' : null
  const nowAmount = nowMethod === 'C' ? parts.C : nowMethod === 'K' ? parts.K : 0
  const debtAtSale = total - parts.B - nowAmount
  let input
  if (channel === 'POS') {
    input = {
      userId, shiftId: ctx.shiftId, lines: items.map((it) => lineOf(it.v, it.qty ?? 1)),
      payments: nowAmount > 0 ? [{ methodId: nowMethod === 'C' ? cashM : cardM, amount: nowAmount, destination: nowMethod === 'C' ? 'CASH' : 'CARD' }] : [],
      ...(credit ? { storeCredits: [{ code: credit.code, requestedAmount: parts.B }] } : {}),
      ...(debtAtSale > 0 ? { debtor: DEBTOR } : {}),
      saleRequestIdempotencyKey: `aud-${ctx.id}-sale-${++keySeq}`
    }
  } else {
    if (credit) {
      const lk = await step(ctx, `${lbl} · page auto-check of the barcode`, 'either', () => storeCreditService.lookup({ code: credit.code, userId }))
      if (!lk.ok) finding(ctx, 'WHOLESALE_LOOKUP_FAILED', lbl, lk.error)
    }
    input = {
      customerId: null, orderType: 'WHOLESALE', issuedAtJalali: today, deductInventory: true, wholesaleDiscountPercent: null,
      invoiceDiscount: 0, invoiceTax: 0, serviceCharge: 0, lines: items.map((it) => lineOf(it.v, it.qty ?? 1)),
      remoteCustomer: false, autoCentralWithdraw: false, storeCreditCode: credit ? credit.code : null,
      payments: nowAmount > 0 ? [{ methodId: nowMethod === 'C' ? cashM : cardM, amount: nowAmount }] : [],
      ...(debtAtSale > 0 ? { debtor: DEBTOR } : {}),
      userId, shiftId: ctx.shiftId
    }
  }
  const s = await step(ctx, lbl, 'ok', () => salesService.create(input))
  if (!s.ok) return { ok: false, parts, total }
  const invoiceId = n(s.res.id)
  if (n(s.res.storeCreditApplied ?? 0) !== parts.B) finding(ctx, 'BARCODE_APPLIED_MISMATCH', lbl, { want: parts.B, got: n(s.res.storeCreditApplied ?? 0) })
  if (parts.C && parts.K) {
    const k = await step(ctx, `${lbl} · card payment later (payments window)`, 'ok', () =>
      salesService.addPayment({ invoiceId, kind: 'CASH', amount: parts.K, methodId: cardM, destination: 'CARD', userId }))
    if (!k.ok) return { ok: false, parts, total, invoiceId }
  }
  let chequeId = null
  if (parts.Q) {
    const q = await step(ctx, `${lbl} · cheque ${parts.Q} (payments window)`, 'ok', () =>
      salesService.addPayment({ invoiceId, kind: 'CHEQUE', amount: parts.Q, chequeNo: `CHQ-${++chequeSeq}`, bankName: 'ملت', dueDateJalali: dueJalali, userId }))
    if (!q.ok) return { ok: false, parts, total, invoiceId }
    chequeId = n(q.res.payment?.id)
    if (qstate === 'CL' || qstate === 'BO') {
      const st = await step(ctx, `${lbl} · cheque ${qstate === 'CL' ? 'CLEARED → manager account' : 'BOUNCED'}`, 'ok', () =>
        salesService.setChequeStatus({ id: chequeId, status: qstate === 'CL' ? 'CLEARED' : 'BOUNCED', destination: qstate === 'CL' ? 'MANAGER' : null, managerPassword: PW, userId }))
      if (!st.ok) return { ok: false, parts, total, invoiceId, chequeId }
    }
  }
  return { ok: true, invoiceId, parts, total, chequeId, credit }
}

// =================================================================== return / exchange
function returnInput(ctx, invoiceId, { lines, full, method, amount }) {
  const input = { userId, shiftId: ctx.shiftId, invoiceId, full: !!full, ...(lines ? { lines } : {}) }
  if (method === 'UNSELECTED') input.refundDecision = 'UNSELECTED'
  else if (method === 'DECLINED') { input.refundDecision = 'DECLINED'; input.refundMethod = 'NONE'; input.refundNote = 'مشتری بازپرداخت نخواست' }
  else if (method === 'NONE') { input.refundMethod = 'NONE' }
  else { input.refundDecision = 'METHOD'; input.refundMethod = method; if (amount != null) input.refundAmount = amount }
  if (method === 'CARD') input.cardPosOverride = { managerPassword: PW, reason: 'آزمون ممیزی کارت‌خوان', acknowledgedNoReverse: true }
  return input
}
async function ret(ctx, invoiceId, opts) {
  const input = returnInput(ctx, invoiceId, opts)
  const label = opts.label ?? `return ${opts.full ? 'full' : 'partial'} ${opts.method}`
  let r = await step(ctx, label, opts.expect ?? 'either', () => salesService.createReturn(input))
  if (!r.ok && /اضافه‌دریافت/.test(r.error) && /بله ثبت کن/.test(r.error)) {
    ctx.notes.push(`${label}: needed «بله ثبت کن» confirmation`)
    r = await step(ctx, label + ' + confirmOverpay', opts.expect ?? 'either', () => salesService.createReturn({ ...input, confirmOverpay: true }))
  }
  if (r.ok) {
    r.returnId = n(r.res.id)
    await docCodeCheck(ctx, label, 'return', r.returnId)
    if (opts.method === 'CARD_TO_CARD') await payC2C(ctx, r.returnId, label)
  }
  return r
}
async function payC2C(ctx, returnId, label) {
  const req = seed.one(`SELECT id,amount,status FROM "CardTransferRequest" WHERE returnId=? AND status='PENDING' ORDER BY id DESC`, returnId)
  if (!req) { ctx.notes.push(`${label}: no pending C2C request`); return null }
  return step(ctx, `${label} → manager pays C2C ${n(req.amount)}`, 'ok', () => cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: PW, trackingNo: `AUD-${ctx.id}-${returnId}` }))
}
async function exch(ctx, invoiceId, { lines, full, repl, pay = 'CASH', refundMode = 'STORE_CREDIT', label, expect = 'either' }) {
  const replacements = repl.map((r) => lineOf(r.v, r.qty ?? 1))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, full })
  const lbl = label ?? 'exchange'
  if (!preview.ok) {
    ctx.refusals.push({ label: lbl + ' [preview]', msg: preview.error, expected: expect !== 'ok' })
    if (expect === 'ok') finding(ctx, 'UNEXPECTED_REFUSAL', lbl + ' [preview]', preview.error)
    ctx.steps.push({ label: lbl + ' [preview]', ok: false, expect, msg: String(preview.error).slice(0, 400) })
    return { ok: false, error: preview.error }
  }
  const diff = n(preview.effectiveDiff)
  const input = { userId, shiftId: ctx.shiftId, invoiceId, lines, full, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `aud-${ctx.id}-ex-${++keySeq}` }
  if (preview.discountTransfer) input.discountTransferOption = 'NO'
  let mode = 'ZERO'
  if (diff > 0) {
    mode = pay
    if (pay === 'CASH') input.methodId = cashM
    else if (pay === 'CARD') input.methodId = cardM
    else if (pay === 'CHEQUE') { input.methodId = chequeM; input.chequeNo = `XCHQ-${++chequeSeq}`; input.bankName = 'ملت'; input.dueDateJalali = dueJalali }
  } else if (diff < 0) {
    mode = refundMode
    if (refundMode === 'UNSELECTED') input.exchangeSettlementDecision = 'UNSELECTED'
    else {
      input.exchangeSettlementDecision = 'METHOD'; input.refundMode = refundMode
      if (refundMode === 'CARD') input.cardPosOverride = { managerPassword: PW, reason: 'آزمون ممیزی کارت‌خوان تعویض', acknowledgedNoReverse: true }
    }
  }
  const r = await step(ctx, `${lbl} (diff ${diff}, ${mode})`, expect, () => salesService.createExchange(input))
  r.preview = { effectiveDiff: diff, nominalDiff: n(preview.nominalDiff), realMoneySurplus: n(preview.realMoneySurplus), sourceCreditRestoration: n(preview.sourceCreditRestoration) }
  if (r.ok) {
    r.returnId = n(r.res.returnId)
    r.exchangeInvoiceId = n(r.res.exchangeInvoiceId)
    await docCodeCheck(ctx, lbl, 'exchange', r.returnId, r.exchangeInvoiceId)
    if (diff < 0 && refundMode === 'CARD_TO_CARD') await payC2C(ctx, r.returnId, lbl)
  }
  return r
}
async function docCodeCheck(ctx, label, kind, returnId, exchangeInvoiceId) {
  const codes = seed.rows('SELECT code FROM "StoreCredit" WHERE id>?', ctx.creditFloor).map((r) => r.code)
  try {
    const html = kind === 'exchange' ? await printService.exchangeHtml(returnId) : await printService.returnHtml(returnId)
    const leaked = codes.filter((c) => html.includes(c))
    if (leaked.length) finding(ctx, 'CREDIT_CODE_ON_' + kind.toUpperCase() + '_DOC', label, leaked.length)
    if (exchangeInvoiceId) {
      const inv = await printService.invoiceHtml(exchangeInvoiceId)
      const l2 = codes.filter((c) => inv.includes(c))
      if (l2.length) finding(ctx, 'CREDIT_CODE_ON_EXCHANGE_INVOICE_RECEIPT', label, l2.length)
    }
  } catch (e) { finding(ctx, 'DOC_RENDER_FAILED', label, String(e?.message ?? e)) }
}

// =================================================================== order analysis (system vs owner)
function chequeRows(invoiceId) {
  return seed.rows(`SELECT id,amount,chequeStatus,voidedAt,voidReason,replacedChequeId FROM "Payment" WHERE invoiceId=? AND kind='CHEQUE' ORDER BY id`, invoiceId)
}
/**
 * ترتیبی که مالک خواسته، روی همین برگشت:
 *   ۱) بدهی نسیه (بدهیِ مانده منهای چکِ در جریان؛ چکِ برگشت‌خورده هم بدهی است) ← min(R, D)
 *   ۲) سهم بارکد ← min(باقی، بارکدِ مصرف‌شده روی فاکتور)
 *   ۳) باقی: پیشنهاد «چک» (جایگزینی با مبلغ کمتر یا ابطال کامل) یا «پول» (نقد / کارت‌به‌کارت / بارکد، تسویهٔ انتخابی).
 * برنامهٔ امروز: بدهی (شامل مبلغ چکِ در جریان و برگشت‌خورده) ← بارکد ← پول؛ چکِ در جریان اگر بدهی صفر شود خودکار
 * باطل می‌شود و اگر نشود فقط «نیاز به بازبینی» می‌گیرد.
 */
function orderAnalysis(before, after, ret0, sale, res, kind) {
  const R = n(ret0.total)
  const N = kind === 'EX' ? n(ret0.exchangeTotal) : 0
  // ارزشی که به سمت مشتری برمی‌گردد: برگشت = کل ارزش اقلام؛ تعویض = فقط مازاد (کالای برگشتی منهای جایگزین)
  const back = kind === 'EX' ? Math.max(0, R - N) : R
  const ownerDebt = Math.max(0, before.remaining - before.pending)
  const ownerDebtCut = Math.min(back, ownerDebt)
  const ownerBarcode = Math.min(back - ownerDebtCut, sale.parts.B)
  const ownerRest = back - ownerDebtCut - ownerBarcode
  const ownerChequeCut = Math.min(ownerRest, before.pending)
  const sysDebtCut = kind === 'EX' ? n(ret0.debtReduction) : Math.min(R, before.remaining)
  const sysBarcode = kind === 'EX' ? n(res?.sourceCreditRestoredAmount) : n(res?.returnCreditAmount)
  const refundMethod = kind === 'EX' ? (res?.refundMode ?? ret0.refundMethod ?? null) : (ret0.refundMethod ?? null)
  const refundAmount = kind === 'EX' ? n(res?.realMoneyRefundAmount) : n(ret0.refundAmount)
  const newCredit = kind === 'EX' ? n(res?.newStoreCreditAmount) : 0
  const autoVoided = after.cheques.filter((c) => c.voidedAt != null && String(c.voidReason ?? '').includes('ابطال خودکار') && !before.cheques.some((b) => b.id === c.id && b.voidedAt != null))
  const autoVoidedAmount = autoVoided.reduce((s, c) => s + n(c.amount), 0)
  // اثرِ واقعی روی هر بخش (نه برچسب داخلی): بدهیِ بی‌پشتوانه (نسیه)، چکِ در جریان، بارکد، پول/طلبِ مشتری
  const uncovered = (x) => Math.max(0, x.remaining - x.pending)
  const sysUncoveredCut = uncovered(before) - uncovered(after)
  const sysChequeCut = before.pending - after.pending
  // در تعویضِ «صدور اعتبار خرید»، بارکد تازه همان مبلغ بازپرداخت است (دوبار شمرده نمی‌شود)؛ طلبِ ثبت‌شدهٔ مشتری هم ارزش اوست
  const sysValueToCustomer = refundAmount + Math.max(0, after.overpaid - before.overpaid)
  const chequeAboveDebt = Math.max(0, after.pending - after.remaining)
  const gaps = []
  if (sysBarcode < ownerBarcode) gaps.push('BARCODE_AFTER_CHEQUE')
  if (autoVoided.length) gaps.push('CHEQUE_AUTO_VOIDED_NO_CHOICE')
  if (chequeAboveDebt > 0) gaps.push('PENDING_CHEQUE_ABOVE_DEBT')
  if (after.bounced > 0 && after.bounced > after.remaining) gaps.push('BOUNCED_CHEQUE_ABOVE_DEBT')
  // پول کشو/کارت‌خوان بیش از نقد و کارتِ دریافتیِ همین فاکتور بیرون رفت ⇐ بخشی بابت چکِ پاس‌شده (به حساب مدیر)
  if ((refundMethod === 'CASH' || refundMethod === 'CARD') && refundAmount > sale.parts.C + sale.parts.K) gaps.push('DRAWER_PAYS_FOR_CLEARED_CHEQUE')
  const sameAsOwner = sysUncoveredCut === ownerDebtCut && sysBarcode === ownerBarcode && sysChequeCut === ownerChequeCut &&
    sysValueToCustomer === ownerRest - ownerChequeCut && chequeAboveDebt === 0
  return {
    R, N, back,
    before: { remaining: before.remaining, pending: before.pending, bounced: before.bounced, overpaid: before.overpaid },
    system: { debtCutInclCheque: sysDebtCut, uncoveredDebtCut: sysUncoveredCut, barcode: sysBarcode, chequeCut: sysChequeCut, chequeAutoVoided: autoVoidedAmount,
      refund: { method: refundMethod, amount: refundAmount }, newCredit, valueToCustomer: sysValueToCustomer, chequeAboveDebtAfter: chequeAboveDebt },
    owner: { debtCut: ownerDebtCut, barcode: ownerBarcode, rest: ownerRest, chequeCutIfChosen: ownerChequeCut, cashIfChequeChosen: ownerRest - ownerChequeCut },
    after: { remaining: after.remaining, pending: after.pending, bounced: after.bounced, overpaid: after.overpaid },
    sameAsOwner,
    gaps
  }
}
async function snapshotInvoice(invoiceId) {
  const d = await invoiceDebt(invoiceId)
  return { ...d, cheques: chequeRows(invoiceId) }
}

/**
 * یک واحد آزمون: یک فروش با ترکیب داده‌شده، سپس «یک» برگشت یا «یک» تعویض، سپس تلاش برای دومی.
 * action: { kind: 'RET', full, method } | { kind: 'EX', diff: 0 | +1 | -1, pay, refundMode }
 */
async function unit(ctx, { channel, nItems, combo, qstate, action }) {
  const items = nItems === 1
    ? [{ v: V(ctx, 'one', 1_000_000) }]
    : [{ v: V(ctx, 'a', 400_000) }, { v: V(ctx, 'b', 350_000) }, { v: V(ctx, 'c', 250_000) }]
  const tag = `${channel}·${nItems}i·${combo}${qstate ? '/' + qstate : ''}·${actionTag(action)}`
  const sale = await creditSale(ctx, { channel, items, combo, qstate, label: `${tag} · sale` })
  const rec = { tag, channel, nItems, combo, qstate: qstate ?? null, action: actionTag(action), parts: sale.parts, ok: false }
  ctx.units.push(rec)
  if (!sale.ok) { rec.saleFailed = true; return rec }
  const before = await snapshotInvoice(sale.invoiceId)
  const target = items[0].v
  let r
  if (action.kind === 'RET') {
    const full = action.full || nItems === 1
    r = await ret(ctx, sale.invoiceId, { full, lines: full ? null : [{ saleItemId: n(itemFor(sale.invoiceId, target).id), qty: 1 }], method: action.method, label: `${tag} · return` })
  } else {
    const price = target.price + (action.diff > 0 ? 100_000 : action.diff < 0 ? -100_000 : 0)
    const rv = V(ctx, 'repl', price)
    r = await exch(ctx, sale.invoiceId, { lines: [{ saleItemId: n(itemFor(sale.invoiceId, target).id), qty: 1 }], full: false, repl: [{ v: rv }], pay: action.pay, refundMode: action.refundMode, label: `${tag} · exchange` })
  }
  rec.ok = !!r.ok
  if (!r.ok) { rec.refusal = String(r.error ?? '').split('\n')[0].slice(0, 300); return rec }
  const after = await snapshotInvoice(sale.invoiceId)
  const row = seed.one('SELECT * FROM "SaleReturn" WHERE id=?', r.returnId)
  rec.order = orderAnalysis(before, after, row, sale, r.res, action.kind)
  if (action.kind === 'EX') {
    rec.exchange = { diff: n(row.exchangeDiff), settlement: row.exchangeSettlement ?? null, debtReduction: n(row.debtReduction), preview: r.preview }
    if (r.exchangeInvoiceId) {
      const child = await snapshotInvoice(r.exchangeInvoiceId)
      rec.exchange.child = { remaining: child.remaining, pending: child.pending, overpaid: child.overpaid }
    }
  }
  for (const g of rec.order.gaps) ctx.gaps.push(`${g} | ${tag}`)
  // تلاش برای برگشت/تعویض دوم روی همان خرید (قاعدهٔ تازهٔ مالک: فقط یکی). فقط نتیجه ثبت می‌شود.
  const left = itemsOf(sale.invoiceId).map((it) => ({ it, back: n(seed.one('SELECT COALESCE(SUM(ri.qty),0) q FROM "SaleReturnItem" ri JOIN "SaleReturn" r ON r.id=ri.returnId WHERE ri.saleItemId=? AND r.voidedAt IS NULL', it.id).q) }))
    .filter((x) => n(x.it.qty) - x.back > 0)
  let second = null
  if (left.length) {
    second = await ret(ctx, sale.invoiceId, { full: false, lines: [{ saleItemId: n(left[0].it.id), qty: 1 }], method: 'CASH', label: `${tag} · 2nd return attempt (same invoice)` })
  } else if (r.exchangeInvoiceId) {
    second = await ret(ctx, r.exchangeInvoiceId, { full: true, method: 'CASH', label: `${tag} · 2nd return attempt (exchange invoice)` })
  }
  rec.second = second == null ? 'NOTHING_LEFT' : second.ok ? 'ACCEPTED' : 'REFUSED'
  if (second?.ok) ctx.gaps.push(`SECOND_ACTION_ACCEPTED | ${tag}`)
  return rec
}

function actionTag(a) {
  if (a.kind === 'RET') return `RET-${a.full ? 'FULL' : 'PART'}-${a.method}`
  return `EX${a.diff > 0 ? '+' : a.diff < 0 ? '-' : '0'}${a.diff > 0 ? '-' + a.pay : a.diff < 0 ? '-' + a.refundMode : ''}`
}

// =================================================================== sharding (two processes on two CPUs)
const SHARD = argOf('--shard')
const PART_OUT = argOf('--part-out')
const SHARDS = SHARD ? Number(SHARD.split('/')[1]) : Math.max(1, Number(process.env.AUD_SHARDS ?? 2))
const SHARD_K = SHARD ? Number(SHARD.split('/')[0]) : 0
let scenarioIndex = -1
const children = []
if (!SHARD && SHARDS > 1) {
  const { spawn } = await import('node:child_process')
  for (let k = 1; k < SHARDS; k++) {
    const part = join(dir, `part-${k}.json`)
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args.filter((a, i) => !['--out', '--compare'].includes(a) && !['--out', '--compare'].includes(args[i - 1])), '--shard', `${k}/${SHARDS}`, '--part-out', part], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
    children.push(new Promise((resolve) => child.on('exit', (code) => resolve({ k, code, part }))))
  }
}

async function run(id, title, fn) {
  scenarioIndex++
  if (scenarioIndex % SHARDS !== SHARD_K) return
  if (ONLY && !ONLY.test(id)) return
  const ctx = newCtx(id, title)
  const t0 = Date.now()
  try { await fn(ctx) } catch (e) {
    finding(ctx, 'SCRIPT_ERROR', 'exception', String(e?.stack ?? e).slice(0, 800))
  }
  const ms = Date.now() - t0
  const unexpected = ctx.findings.length
  scenarios.push({ idx: scenarioIndex, id, title, ms, steps: ctx.steps, refusals: ctx.refusals, findings: ctx.findings, notes: ctx.notes, units: ctx.units, gaps: ctx.gaps, value: ctx.lastValue })
  if (VERBOSE) for (const note of ctx.notes) console.log('    · ' + note)
  if (scenarios.length % 250 === 0) process.stdout.write(`  … ${SHARD ? 'shard ' + SHARD_K : 'main'}: ${scenarios.length} scenarios\n`)
  if (VERBOSE || unexpected) console.log(`${unexpected ? '✗' : '✓'} ${id} — steps ${ctx.steps.length}, refusals ${ctx.refusals.length}, gaps ${ctx.gaps.length}${unexpected ? `, FINDINGS ${unexpected}: ${[...new Set(ctx.findings.map((f) => f.type))].join(',')}` : ''} (${ms} ms)`)
}

// =================================================================== part A — matrix
/**
 * ۲ مسیر (صندوق فروش، فاکتور عمده) × ۲ حالت کالا (۱ کالا، ۳ کالا) × ۵۶ حالت پرداخت (۱۶ ترکیبِ چک‌دار × ۳ وضعیت چک
 * + ۸ ترکیبِ نسیه‌دارِ بی‌چک) × کارها:
 *   ۱ کالا: برگشت کامل با ۶ روش (نقد، کارت، کارت‌به‌کارت مدیر، بارکد اعتبار، «بدون بازپرداخت» با دلیل، انتخاب‌نشده)
 *   ۳ کالا: برگشت جزئیِ یک کالا با همان ۶ روش + برگشت کامل نقد و بارکد اعتبار
 *   هر دو: تعویض هم‌قیمت؛ تعویض گران‌تر (مابه‌التفاوت نقد / چک تازه)؛ تعویض ارزان‌تر (نقد، کارت، کارت‌به‌کارت، بارکد، انتخاب‌نشده)
 * هر کار روی یک فروش تازه و در یک نوبت کاری جدا انجام می‌شود؛ پس هیچ سناریویی زنجیره نیست.
 */
const RET_METHODS = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']
const EX_ACTIONS = [
  { kind: 'EX', diff: 0 },
  { kind: 'EX', diff: 1, pay: 'CASH' },
  { kind: 'EX', diff: 1, pay: 'CHEQUE' },
  ...['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'UNSELECTED'].map((m) => ({ kind: 'EX', diff: -1, refundMode: m }))
]
function actionsFor(nItems) {
  if (nItems === 1) return [...RET_METHODS.map((m) => ({ kind: 'RET', full: true, method: m })), ...EX_ACTIONS]
  return [...RET_METHODS.map((m) => ({ kind: 'RET', full: false, method: m })), ...['CASH', 'STORE_CREDIT'].map((m) => ({ kind: 'RET', full: true, method: m })), ...EX_ACTIONS]
}
const TENDERS = combos().flatMap((c) => (c.includes('Q') ? ['P', 'CL', 'BO'].map((q) => ({ combo: c, qstate: q })) : [{ combo: c, qstate: null }]))
for (const channel of ['POS', 'WHOLESALE'])
  for (const nItems of [1, 3])
    for (const t of TENDERS)
      for (const action of actionsFor(nItems)) {
        const id = `${channel}·${nItems}i·${t.combo}${t.qstate ? '/' + t.qstate : ''}·${actionTag(action)}`
        const title = `${channel === 'POS' ? 'صندوق فروش' : 'فاکتور عمده'} · ${nItems === 1 ? 'یک کالا' : 'سه کالا'} · ${t.combo.split('').map((c) => COMP_FA[c]).join('+')}${t.qstate ? ' (چک ' + QSTATE_FA[t.qstate] + ')' : ''} · ${actionTag(action)}`
        await run(id, title, (ctx) => unit(ctx, { channel, nItems, combo: t.combo, qstate: t.qstate, action }))
      }

// =================================================================== part B — cheque tools available today
/**
 * ابزارهایی که فروشنده امروز برای «جایگزینی/ابطال چک» دارد (همه روی یک فروش صندوق: ۳ کالا، نقد ۲۰۰ هزار + چک ۸۰۰ هزار):
 * جایگزینی با مبلغ کمتر، جایگزینی هم‌مبلغ، ابطال چک در جریان بی رمز، جایگزینی دستیِ دومرحله‌ای پس از برگشت جزئی،
 * ابطال چک پاس‌شده بی رمز/با رمز، جایگزینی چک برگشت‌خورده، و سرنوشت چکی که پس از برگشت جزئی بالای بدهی مانده
 * (پاس شود / برگشت بخورد).
 */
async function cqSale(ctx, qstate = 'P') {
  const items = [{ v: V(ctx, 'a', 400_000) }, { v: V(ctx, 'b', 350_000) }, { v: V(ctx, 'c', 250_000) }]
  const sale = await creditSale(ctx, { channel: 'POS', items, combo: 'CQ', qstate, label: 'sale cash 200000 + cheque 800000' })
  return { ...sale, items }
}
const partialReturnA = (ctx, sale, label = 'return item a (400000) partial, CASH asked') =>
  ret(ctx, sale.invoiceId, { full: false, lines: [{ saleItemId: n(itemFor(sale.invoiceId, sale.items[0].v).id), qty: 1 }], method: 'CASH', label })
const replaceArgs = (sale, amount, extra = {}) => ({ id: sale.chequeId, amount, chequeNo: `RCHQ-${++chequeSeq}`, bankName: 'ملت', dueDateJalali: dueJalali, overrideReason: 'آزمون جایگزینی چک', managerPassword: PW, userId, ...extra })
const toolNote = async (ctx, label, invoiceId) => { const d = await snapshotInvoice(invoiceId); ctx.notes.push(`${label}: remaining ${d.remaining}, pending ${d.pending}, bounced ${d.bounced}, overpaid ${d.overpaid}, cheques ${d.cheques.map((c) => `${n(c.amount)}:${c.chequeStatus}${c.voidedAt != null ? ':VOID' : ''}`).join(' ')}`) }

await run('T1-replace-smaller', 'جایگزینی چک ۸۰۰ هزار با چک ۴۰۰ هزار پس از برگشت جزئی ۴۰۰ هزار', async (ctx) => {
  const sale = await cqSale(ctx)
  await partialReturnA(ctx, sale)
  await step(ctx, 'replace cheque 800000 → 400000 (smaller)', 'either', () => salesService.replaceCheque(replaceArgs(sale, 400_000)))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T2-replace-same', 'جایگزینی چک با چک هم‌مبلغ (شمارهٔ تازه)', async (ctx) => {
  const sale = await cqSale(ctx)
  await step(ctx, 'replace cheque 800000 → 800000 (same amount)', 'either', () => salesService.replaceCheque(replaceArgs(sale, 800_000)))
  await step(ctx, 'replace cheque without manager password', 'either', () => salesService.replaceCheque(replaceArgs(sale, 800_000, { managerPassword: null })))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T3-void-pending-no-password', 'ابطال چک «در جریان» از پنجرهٔ پرداختی‌ها بی هیچ رمزی', async (ctx) => {
  const sale = await cqSale(ctx)
  await step(ctx, 'void PENDING cheque without password', 'either', () => salesService.deletePayment({ id: sale.chequeId, userId }))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T4-manual-two-step-replace', 'جایگزینی دستی دومرحله‌ای: برگشت جزئی، ابطال چک ۸۰۰ هزار، ثبت چک ۴۰۰ هزار', async (ctx) => {
  const sale = await cqSale(ctx)
  await partialReturnA(ctx, sale)
  await step(ctx, 'void the 800000 cheque (payments window)', 'either', () => salesService.deletePayment({ id: sale.chequeId, userId }))
  await step(ctx, 'add a new cheque 400000 (payments window)', 'either', () => salesService.addPayment({ invoiceId: sale.invoiceId, kind: 'CHEQUE', amount: 400_000, chequeNo: `CHQ-${++chequeSeq}`, bankName: 'ملت', dueDateJalali: dueJalali, userId }))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T5-void-cleared', 'ابطال چک پاس‌شده: بی رمز، سپس با رمز مدیر', async (ctx) => {
  const sale = await cqSale(ctx, 'CL')
  await step(ctx, 'void CLEARED cheque without password', 'either', () => salesService.deletePayment({ id: sale.chequeId, userId }))
  await step(ctx, 'void CLEARED cheque with manager password', 'either', () => salesService.deletePayment({ id: sale.chequeId, userId, managerPassword: PW }))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T6-replace-bounced', 'جایگزینی چک برگشت‌خورده با چک هم‌مبلغ', async (ctx) => {
  const sale = await cqSale(ctx, 'BO')
  await step(ctx, 'replace BOUNCED cheque 800000 → 800000', 'either', () => salesService.replaceCheque(replaceArgs(sale, 800_000)))
  await toolNote(ctx, 'after', sale.invoiceId)
})
await run('T7-cheque-above-debt-clears', 'چکی که پس از برگشت جزئی بالای بدهی مانده، بعداً پاس می‌شود', async (ctx) => {
  const sale = await cqSale(ctx)
  await partialReturnA(ctx, sale)
  await toolNote(ctx, 'after return', sale.invoiceId)
  await step(ctx, 'cheque 800000 CLEARED later (debt was 400000)', 'either', () => salesService.setChequeStatus({ id: sale.chequeId, status: 'CLEARED', destination: 'MANAGER', managerPassword: PW, userId }))
  await toolNote(ctx, 'after clearing', sale.invoiceId)
})
await run('T8-cheque-above-debt-bounces', 'چکی که پس از برگشت جزئی بالای بدهی مانده، بعداً برگشت می‌خورد', async (ctx) => {
  const sale = await cqSale(ctx)
  await partialReturnA(ctx, sale)
  await step(ctx, 'cheque 800000 BOUNCED later (debt was 400000)', 'either', () => salesService.setChequeStatus({ id: sale.chequeId, status: 'BOUNCED', managerPassword: PW, userId }))
  await toolNote(ctx, 'after bouncing', sale.invoiceId)
})

await run('T9-cash-instead-of-pending-cheque', 'مشتری به جای چک در جریان نقد می‌آورد: پیام «جایگزینی با نقد/کارت» و راه واقعی امروز', async (ctx) => {
  const sale = await cqSale(ctx)
  await step(ctx, 'pay 800000 cash while the 800000 cheque is pending', 'either', () => salesService.addPayment({ invoiceId: sale.invoiceId, kind: 'CASH', amount: 800_000, methodId: cashM, destination: 'CASH', userId }))
  await step(ctx, 'void the pending cheque (payments window, no password)', 'either', () => salesService.deletePayment({ id: sale.chequeId, userId }))
  await step(ctx, 'pay 800000 cash after voiding the cheque', 'either', () => salesService.addPayment({ invoiceId: sale.invoiceId, kind: 'CASH', amount: 800_000, methodId: cashM, destination: 'CASH', userId }))
  await toolNote(ctx, 'after', sale.invoiceId)
})

// =================================================================== merge shards
function normalizeScenarios(list) {
  const secretCodes = [
    ...seed.rows('SELECT code FROM "StoreCredit"').map((r) => String(r.code)),
    ...seed.rows('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').map((r) => String(r.returnCode))
  ].filter((c) => c.length >= 4).sort((a, b) => b.length - a.length)
  const normText = (t) => {
    let s = String(t ?? '').split('\n')[0]
    for (const c of secretCodes) if (s.includes(c)) s = s.split(c).join('«کد»')
    s = s.replace(/«[A-Z0-9]{2,}»/g, '«کد»')
    return s.replace(/[0-9۰-۹][0-9۰-۹٬,\/:.]*/g, '#').slice(0, 180)
  }
  const stripTag = (label, id) => {
    const tag = id.split('·').slice(0, 4).join('·')
    return String(label).startsWith(tag + ' · ') ? String(label).slice(tag.length + 3) : String(label)
  }
  return list.map((s) => ({
    idx: s.idx,
    id: s.id,
    steps: s.steps.map((st) => [normText(stripTag(st.label, s.id)), st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? (st.brief ?? null) : normText(st.msg)]),
    findings: [...new Set(s.findings.map((f) => `${f.type} | ${normText(stripTag(f.label, s.id))}`))].sort(),
    units: s.units.map((u) => ({ parts: u.parts, ok: u.ok, saleFailed: u.saleFailed ?? false, refusal: u.refusal ? normText(u.refusal) : null, order: u.order ?? null, exchange: u.exchange ?? null, second: u.second ?? null })),
    notes: s.notes.map((x) => normText(stripTag(x, s.id))),
    value: s.value
  }))
}
const bigintSafe = (k, v) => (typeof v === 'bigint' ? Number(v) : v)
if (SHARD) {
  writeFileSync(PART_OUT, JSON.stringify({ scenarios, normalized: normalizeScenarios(scenarios) }, bigintSafe))
  process.exit(0)
}
let normalized = normalizeScenarios(scenarios)
for (const r of await Promise.all(children)) {
  if (r.code !== 0) { console.error = console.log; console.log(`shard ${r.k} failed with exit code ${r.code}`); process.exit(2) }
  const part = JSON.parse(readFileSync(r.part, 'utf8'))
  scenarios.push(...part.scenarios)
  normalized.push(...part.normalized)
}
scenarios.sort((a, b) => a.idx - b.idx)
normalized.sort((a, b) => a.idx - b.idx)
normalized = normalized.map(({ idx, ...rest }) => rest)

// =================================================================== summary, snapshot, compare
const findingsAll = scenarios.flatMap((s) => s.findings)
const count = (arr) => { const m = {}; for (const x of arr) m[x] = (m[x] ?? 0) + 1; return Object.fromEntries(Object.entries(m).sort()) }
const units = scenarios.flatMap((s) => s.units.map((u) => ({ ...u, id: s.id })))
const done = units.filter((u) => u.ok)
const byAction = {}
for (const u of units) {
  const key = (u.channel === 'POS' ? 'POS ' : 'WHOLESALE ') + u.action.replace(/^(RET-(?:FULL|PART)|EX[+\-0]).*$/, '$1')
  const b = byAction[key] ?? (byAction[key] = { units: 0, accepted: 0, refused: 0, sameAsOwner: 0, differentFromOwner: 0, secondAccepted: 0, secondRefused: 0, nothingLeft: 0 })
  b.units++
  if (u.ok) b.accepted++; else b.refused++
  if (u.order) { if (u.order.sameAsOwner) b.sameAsOwner++; else b.differentFromOwner++ }
  if (u.second === 'ACCEPTED') b.secondAccepted++
  if (u.second === 'REFUSED') b.secondRefused++
  if (u.second === 'NOTHING_LEFT') b.nothingLeft++
}
const summary = {
  scenarios: scenarios.length,
  units: units.length,
  steps: scenarios.reduce((s, x) => s + x.steps.length, 0),
  refusals: scenarios.reduce((s, x) => s + x.refusals.length, 0),
  actionsAccepted: done.length,
  actionsRefused: units.length - done.length,
  saleSetupFailed: units.filter((u) => u.saleFailed).length,
  scenariosWithFindings: scenarios.filter((x) => x.findings.length).length,
  findingTypes: count(findingsAll.map((f) => f.type)),
  gapTypes: count(scenarios.flatMap((s) => s.gaps.map((g) => g.split(' | ')[0]))),
  secondAction: count(units.map((u) => u.second ?? (u.ok ? 'n/a' : 'FIRST_REFUSED'))),
  orderVsOwner: count(done.filter((u) => u.order).map((u) => (u.order.sameAsOwner ? 'SAME' : 'DIFFERENT'))),
  byAction
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, scenarios }, bigintSafe, 1))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/credit-cheque-scenarios.mjs', programCommit: head, summary } }
const snapPath = OUT ?? join(dir, 'snapshot.json')
const snapText = JSON.stringify(snapshotDoc, null, 1).replace(/\n}$/, ',\n "scenarios": [\n') + normalized.map((s) => JSON.stringify(s, bigintSafe)).join(',\n') + '\n ]\n}\n'
// نتیجهٔ فشرده بزرگ است (هزاران سناریو)؛ با پسوند .gz فشرده نوشته و خوانده می‌شود (gzip بی تاریخ و نام، پس هر بار همان بایت‌ها).
writeFileSync(snapPath, snapPath.endsWith('.gz') ? gzipSync(Buffer.from(snapText, 'utf8'), { level: 9 }) : snapText)
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)

if (COMPARE) {
  const raw = readFileSync(COMPARE)
  const base = JSON.parse(COMPARE.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')).scenarios
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of normalized) {
    const b = byId.get(s.id)
    if (!b) { diffs.push(`+ سناریوی تازه: ${s.id}`); continue }
    byId.delete(s.id)
    const len = Math.max(s.steps.length, b.steps.length)
    for (let i = 0; i < len; i++) {
      const x = JSON.stringify(s.steps[i] ?? null), y = JSON.stringify(b.steps[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · گام ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    for (const key of ['findings', 'units', 'notes', 'value']) {
      const x = JSON.stringify(s[key]), y = JSON.stringify(b[key])
      if (x !== y) diffs.push(`${s.id} · ${key}\n    پیش: ${y}\n    پس:  ${x}`)
    }
  }
  for (const id of byId.keys()) diffs.push(`- سناریو نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 500)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
