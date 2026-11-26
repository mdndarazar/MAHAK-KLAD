/**
 * آزمون سناریوهای «اعتبار خرید» و «مدیریت اعتبار» (کارت هدیه / بارکد اعتبار مدیریتی) — آزمون ۲۰۲۶-۱۱-۲۶
 * (یافته‌های ۴-۹۳ تا ۴-۱۰۱ دفتر آزمون مالک).
 *
 * صدور تکی (با و بی انقضا، یک‌بار، چندبار تا N، چندبار تا ته مبلغ، سوختن یا ماندن باقی‌مانده)، تولید گروهی
 * ۳۰۰ کارت برای یک شرکت از همان راهی که فرم «تولید گروهی» می‌فرستد، دامنهٔ مصرف (یک کالا، چند کالا، یک دسته،
 * دستهٔ والد و زیردسته، چند دسته، همهٔ کالاها)، حداقل خرید، سقف هر خرید، فقط برای یک مشتری، منقضی، معلق و
 * باطل، دو کارت روی یک کالا؛ مصرف در صندوق فروش (با همان پیش‌نمایشی که صفحه پیش از ثبت می‌گیرد) و در فاکتور
 * عمده (با همان کاری که صفحهٔ عمده امروز می‌کند)؛ سپس برگشت کامل و بخشی، تعویض با کالای مجاز و غیرمجاز و
 * ارزان‌تر، خرج دوبارهٔ سهم برگشته؛ و در پایان گزارش‌ها، متن و اندازه‌های برگهٔ چاپی و رسید فروش.
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت و چاپگر شبیه‌سازی‌شده؛ به برنامه، پایگاه واقعی یا آزمون‌های مخزن دست
 * نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/store-credit-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی کد، بی شناسه، بی تاریخ) برای مقایسه
 *   ... --compare docs/audit/store-credit-scenarios-2026-11-26.json
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_ONLY=<regex>  فقط سناریوهای هم‌نام    AUD_VERBOSE=1  ریز هر گام
 *
 * پس از هر عملیات همان هفت سنجش ابزار فروش تکی (گزارش فروش و صندوق امانی با ردیف‌های خام، دفتر موجودی، موجودی
 * با سندها، ماندهٔ هر کارت با دفتر مصرفش، معادلهٔ ارزش و بی‌اثر بودنِ کارِ ردشده). جز گام‌ها، «دیده‌ها» هم در نتیجه
 * می‌نشینند: پیش‌نمایش و برنامهٔ صفحهٔ فروش، وضعیت هر کارت، کارت‌های تازهٔ برگشت و تعویض، دادهٔ ذخیره‌شدهٔ تولید
 * گروهی، فهرست دسته‌ها، متن و اندازهٔ قلم برگهٔ چاپی و متن رسید فروش؛ پس هر تغییر ظاهری هم در مقایسه دیده می‌شود.
 * قاعدهٔ مالک (دفتر آزمون، «شرط مالک برای ۴-۶۸ تا ۴-۷۳»، بند ۱۱): پس از اجرای ۴-۹۳ تا ۴-۱۰۱ سه ابزار قبلی باید
 * ۰ تفاوت بدهند و این ابزار فقط تفاوت‌های خواسته‌شدهٔ همان بندها را.
 */
import { register } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
const dir = mkdtempSync(join(tmpdir(), 'store-credit-scenarios-'))
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
const { printService } = await imp('/src/main/services/PrintService.ts')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked, clearPanelSessions } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { toJalaliDate } = await imp('/src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const n = (x) => Number(x ?? 0)
const VERBOSE = process.env.AUD_VERBOSE === '1'
const ONLY = process.env.AUD_ONLY ? new RegExp(process.env.AUD_ONLY) : null

const userId = seed.user('فروشنده ممیزی')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('ممیزی فروش')
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
const openReturnPanel = () => notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', sender.id)
const resetCodeGate = () => sql.prepare('DELETE FROM "AuthLockout" WHERE gate = ?').run('__credit_code__')

// ------------------------------------------------------------------ results and invariants
const scenarios = []
const allFindings = []
let shiftSeq = 0, vseq = 0, keySeq = 0

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
    pay: seed.count('Payment', '1=1'),
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
  const paidIn = raw.cash + raw.card
  const physOut = raw.refundCash + raw.refundCard
  const c2c = c2cTotal(ctx.shiftId)
  const live = liveCreditValue(ctx.creditFloor)
  const kept = keptGoods(ctx.shiftId)
  const writeOff = n(seed.one(`SELECT COALESCE(SUM(c.unrecoveredAmount),0) a FROM "ReturnCorrection" c JOIN "SaleReturn" r ON r.id=c.returnId WHERE r.shiftId=? AND c.status='POSTED'`, ctx.shiftId).a)
  const inV = paidIn + ctx.manualIssued + writeOff
  const outV = physOut + c2c + live + kept
  ctx.lastValue = { paidIn, manual: ctx.manualIssued, writeOff, physOut, c2c, live, kept, delta: inV - outV }
  if (physOut + c2c > paidIn) finding(ctx, 'PHYSICAL_OUT_GT_IN', label, ctx.lastValue)
  if (inV - outV < 0) finding(ctx, 'VALUE_LEAK_TO_CUSTOMER', label, ctx.lastValue)
  if (inV - outV > 0 && !ctx.allowLoss) finding(ctx, 'VALUE_LOSS_FOR_CUSTOMER', label, ctx.lastValue)
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
  const keys = ['id', 'receiptNo', 'grandTotal', 'paidTotal', 'storeCreditApplied', 'total', 'refundMethod', 'refundAmount', 'returnCreditAmount', 'sourceCreditRestoredAmount',
    'diff', 'cashReceived', 'cardReceived', 'barcodeCreditApplied', 'cashRefunded', 'cardRefunded', 'realMoneyRefundAmount', 'newStoreCreditAmount', 'payoutAmount', 'refundMode', 'settlement', 'exchangeInvoiceId', 'returnId', 'idempotentReplay', 'replayed']
  const o = {}
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]
  if (r.storeCreditOutcomes) o.creditOutcomes = r.storeCreditOutcomes.map((x) => `${x.status}:${x.amount}`)
  if (r.storeCredit) o.storeCredit = { id: r.storeCredit.id, amount: r.storeCredit.amount }
  if (r.overpayCredit) o.overpayCredit = { id: r.overpayCredit.id, amount: r.overpayCredit.amount }
  if (r.sourceCreditSuccessors?.length) o.successors = r.sourceCreditSuccessors.map((s) => ({ id: s.id, amount: s.amount }))
  if (r.cardTransfer) o.cardTransfer = { id: r.cardTransfer.id, amount: Number(r.cardTransfer.amount) }
  return o
}

function newCtx(id, title, opts = {}) {
  const shiftId = seed.insert('Shift', { name: `AUD ${id}`, number: 500 + (++shiftSeq), dayJalali: today, openedAt: Date.now() - 5000, userId })
  const creditFloor = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "StoreCredit"').m)
  resetCodeGate()
  return { id, title, shiftId, creditFloor, variants: [], manualIssued: 0, steps: [], findings: [], findingKeys: new Set(), refusals: [], certs: [], notes: [], obs: [], allowLoss: !!opts.allowLoss, lastValue: null }
}
function V(ctx, label, price, stock = 30) {
  const pid = seed.product(`${ctx.id}-${label}-${++vseq}`, cat)
  const id = seed.variant(pid, `${label}-${vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(stock, price, id)
  const v = { id, label, price, baseline: stock }
  ctx.variants.push(v)
  return v
}
async function issueManual(ctx, amount, { multiUse = false, maxUses, carryRemainder = true, days = 30 } = {}) {
  const r = await storeCreditService.issueManual({ amount, multiUse, maxUses: maxUses ?? (multiUse ? 10 : 1), carryRemainder, days, userId, managerPassword: PW })
  ctx.manualIssued += amount
  const row = rawCredit(r.id)
  return { id: n(r.id), code: row.code, amount }
}
const lineOf = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const itemsOf = (invoiceId) => seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const itemFor = (invoiceId, v) => itemsOf(invoiceId).find((r) => n(r.variantId) === v.id)
const newCredits = (ctx, sinceId) => seed.rows('SELECT * FROM "StoreCredit" WHERE id>? ORDER BY id', Math.max(ctx.creditFloor, sinceId))
const maxCreditId = () => n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "StoreCredit"').m)

function paymentsFor(tender, due, splitCash) {
  if (due <= 0 || tender === 'NONE') return { payments: [] }
  if (tender === 'CASH') return { payments: [{ methodId: cashM, amount: due, destination: 'CASH' }] }
  if (tender === 'CARD') return { payments: [{ methodId: cardM, amount: due, destination: 'CARD' }] }
  if (tender === 'SPLIT') {
    const c = splitCash ?? Math.floor(due / 2)
    return { splitPayment: true, payments: [{ methodId: cashM, amount: c, destination: 'CASH' }, { methodId: cardM, amount: due - c, destination: 'CARD' }] }
  }
  if (tender === 'LEGACY2') {
    const c = splitCash ?? Math.floor(due / 2)
    return { payments: [{ methodId: cashM, amount: c, destination: 'CASH' }, { methodId: cardM, amount: due - c, destination: 'CARD' }] }
  }
  throw new Error('tender ' + tender)
}
async function sale(ctx, { items, tender = 'CASH', credits = [], due, key, splitCash, expect = 'ok', label, extra = {}, receiptCheck = true }) {
  const total = items.reduce((s, it) => s + it.v.price * (it.qty ?? 1), 0)
  const cover = credits.reduce((s, c) => s + n(c.requestedAmount ?? c.amount ?? 0), 0)
  const pay = paymentsFor(tender, due ?? Math.max(0, total - cover), splitCash)
  const input = {
    userId, shiftId: ctx.shiftId, lines: items.map((it) => lineOf(it.v, it.qty ?? 1)), ...pay,
    ...(credits.length ? { storeCredits: credits.map((c) => ({ code: c.code, requestedAmount: c.requestedAmount === undefined ? (c.amount ?? null) : c.requestedAmount })) } : {}),
    saleRequestIdempotencyKey: key ?? `aud-${ctx.id}-sale-${++keySeq}`, ...extra
  }
  const r = await step(ctx, label ?? `sale ${items.length} item(s) ${tender} + ${credits.length} barcode(s)`, expect, () => salesService.create(input))
  if (r.ok) {
    r.invoiceId = n(r.res.id)
    if (receiptCheck) {
      try {
        const html = await printService.invoiceHtml(r.invoiceId)
        for (const c of seed.rows('SELECT code,amount,usedAmount,status FROM "StoreCredit" WHERE id>?', ctx.creditFloor))
          if (html.includes(c.code) && n(c.amount) - n(c.usedAmount) > 0 && ['ACTIVE', 'PARTIALLY_USED'].includes(c.status))
            finding(ctx, 'LIVE_CODE_ON_SALE_RECEIPT', label ?? 'sale', { code: c.code })
      } catch (e) { finding(ctx, 'SALE_RECEIPT_RENDER_FAILED', label ?? 'sale', String(e?.message ?? e)) }
    }
  }
  return r
}

function returnInput(ctx, invoiceId, { lines, full, method, amount, extra = {} }) {
  const input = { userId, shiftId: ctx.shiftId, invoiceId, full: !!full, ...(lines ? { lines } : {}), ...extra }
  if (method === 'UNSELECTED') input.refundDecision = 'UNSELECTED'
  else if (method === 'DECLINED') { input.refundDecision = 'DECLINED'; input.refundMethod = 'NONE'; input.refundNote = 'مشتری بازپرداخت نخواست' }
  else if (method === 'NONE') { input.refundMethod = 'NONE' }
  else { input.refundDecision = 'METHOD'; input.refundMethod = method; if (amount != null) input.refundAmount = amount }
  if (method === 'CARD') input.cardPosOverride = { managerPassword: PW, reason: 'آزمون ممیزی کارت‌خوان', acknowledgedNoReverse: true }
  return input
}
async function ret(ctx, invoiceId, opts) {
  const since = maxCreditId()
  const input = returnInput(ctx, invoiceId, opts)
  const label = opts.label ?? `return ${opts.full ? 'full' : 'partial'} ${opts.method}`
  let r = await step(ctx, label, opts.expect ?? 'ok', () => salesService.createReturn(input))
  if (!r.ok && opts.autoConfirm !== false && /اضافه‌دریافت/.test(r.error) && /بله ثبت کن/.test(r.error)) {
    ctx.notes.push(`${label}: needed «بله ثبت کن» confirmation`)
    r = await step(ctx, label + ' + confirmOverpay', opts.expect ?? 'ok', () => salesService.createReturn({ ...input, confirmOverpay: true }))
  }
  if (r.ok) {
    r.returnId = n(r.res.id)
    await docCodeCheck(ctx, label, 'return', r.returnId)
    r.credits = newCredits(ctx, since)
    if (opts.method === 'CARD_TO_CARD' && opts.payC2C !== false) await payC2C(ctx, r.returnId, label)
  }
  return r
}
async function payC2C(ctx, returnId, label) {
  const req = seed.one(`SELECT id,amount,status FROM "CardTransferRequest" WHERE returnId=? AND status='PENDING' ORDER BY id DESC`, returnId)
  if (!req) { ctx.notes.push(`${label}: no pending C2C request`); return null }
  return step(ctx, `${label} → manager pays C2C ${n(req.amount)}`, 'ok', () => cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: PW, trackingNo: `AUD-${ctx.id}-${returnId}` }))
}

async function exch(ctx, invoiceId, { lines, full, repl, pay = 'CASH', refundMode = 'STORE_CREDIT', payout, code, label, expect = 'ok', splitCash, payC2C: doPay = true }) {
  const since = maxCreditId()
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
    else if (pay === 'SPLIT') { input.splitPayment = true; const c = splitCash ?? Math.floor(diff / 2); input.payments = [{ methodId: cashM, amount: c, destination: 'CASH' }, { methodId: cardM, amount: diff - c, destination: 'CARD' }] }
    else if (pay === 'BARCODE') { input.exchangeCreditCode = code; input.idempotencyKey = `aud-${ctx.id}-exc-${keySeq}` }
  } else if (diff < 0) {
    mode = refundMode
    if (refundMode === 'UNSELECTED') input.exchangeSettlementDecision = 'UNSELECTED'
    else {
      input.exchangeSettlementDecision = 'METHOD'; input.refundMode = refundMode
      if (refundMode === 'CARD') input.cardPosOverride = { managerPassword: PW, reason: 'آزمون ممیزی کارت‌خوان تعویض', acknowledgedNoReverse: true }
      if (payout != null) input.refundAmount = payout
    }
  }
  const r = await step(ctx, `${lbl} (diff ${diff}, ${mode})`, expect, () => salesService.createExchange(input))
  r.preview = { effectiveDiff: diff, nominalDiff: n(preview.nominalDiff), realMoneySurplus: n(preview.realMoneySurplus), sourceCreditRestoration: n(preview.sourceCreditRestoration) }
  if (r.ok) {
    r.returnId = n(r.res.returnId)
    r.exchangeInvoiceId = n(r.res.exchangeInvoiceId)
    await docCodeCheck(ctx, lbl, 'exchange', r.returnId, r.exchangeInvoiceId)
    r.credits = newCredits(ctx, since)
    if (diff < 0 && refundMode === 'CARD_TO_CARD' && doPay) await payC2C(ctx, r.returnId, lbl)
  }
  return r
}

async function docCodeCheck(ctx, label, kind, returnId, exchangeInvoiceId) {
  const codes = seed.rows('SELECT code FROM "StoreCredit" WHERE id>?', ctx.creditFloor).map((r) => r.code)
  try {
    const html = kind === 'exchange' ? await printService.exchangeHtml(returnId) : await printService.returnHtml(returnId)
    const leaked = codes.filter((c) => html.includes(c))
    if (leaked.length) finding(ctx, 'CREDIT_CODE_ON_' + kind.toUpperCase() + '_DOC', label, leaked)
    if (exchangeInvoiceId) {
      const inv = await printService.invoiceHtml(exchangeInvoiceId)
      const l2 = codes.filter((c) => inv.includes(c))
      if (l2.length) finding(ctx, 'CREDIT_CODE_ON_EXCHANGE_INVOICE_RECEIPT', label, l2)
    }
  } catch (e) { finding(ctx, 'DOC_RENDER_FAILED', label, String(e?.message ?? e)) }
}

/** seller certificate lifecycle on one return/exchange credit (IPC handlers + print mock) */
async function certLifecycle(ctx, creditId, label, { reprint = true } = {}) {
  const c0 = rawCredit(creditId)
  const res = { creditId, label, source: c0.source, amount: n(c0.amount), returnId: c0.returnId, exchangeInvoiceId: c0.exchangeInvoiceId, status: c0.status }
  const del = seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', creditId)
  res.delivery = del?.status ?? null
  openReturnPanel(); printers()
  let r = await invoke(IPC.creditDeliveryPrint, { id: creditId })
  res.firstPrint = r.ok ? 'OK' : `REFUSED: ${r.error}`
  if (r.ok) {
    const html = mock.state.windows.at(-1)?._html ?? ''
    res.certHasCode = html.includes(c0.code)
    res.printCalls = mock.state.printCalls.length
    if (!res.certHasCode) finding(ctx, 'CERT_WITHOUT_CODE', label, creditId)
    if (res.printCalls !== 1) finding(ctx, 'CERT_FIRST_PRINT_NOT_ONE_PAPER', label, res.printCalls)
    printers()
    r = await invoke(IPC.creditDeliveryPrint, { id: creditId })
    res.secondFirstPrint = r.ok ? 'OK' : 'REFUSED'
    if (r.ok) finding(ctx, 'CERT_FIRST_PRINT_TWICE', label, creditId)
    if (reprint) {
      printers()
      r = await invoke(IPC.creditSellerReprint, { id: creditId, reasonCode: 'INCOMPLETE' })
      res.sellerReprint1 = r.ok ? 'OK' : `REFUSED: ${r.error}`
      if (r.ok && !(mock.state.windows.at(-1)?._html ?? '').includes('نسخه‌ی مجدد')) finding(ctx, 'REPRINT_NOT_LABELLED', label, creditId)
      printers()
      r = await invoke(IPC.creditSellerReprint, { id: creditId, reasonCode: 'INCOMPLETE' })
      res.sellerReprint2 = r.ok ? 'OK' : 'REFUSED'
      if (r.ok) finding(ctx, 'SELLER_REPRINT_TWICE', label, creditId)
    }
  } else if (['ACTIVE', 'DRAFT'].includes(c0.status) && (c0.returnId != null || c0.exchangeInvoiceId != null)) {
    finding(ctx, 'CERT_FIRST_PRINT_REFUSED', label, { creditId, source: c0.source, delivery: res.delivery, error: r.error })
  }
  res.printCount = n(rawCredit(creditId).printCount)
  ctx.certs.push(res)
  return res
}

/** spend once (must work), spend again (must fail). Each spend pays the rest in cash. */
async function spendTwice(ctx, creditId, label) {
  const c = rawCredit(creditId)
  const bal = n(c.amount) - n(c.usedAmount)
  if (bal <= 0 || !['ACTIVE', 'PARTIALLY_USED'].includes(c.status)) { ctx.notes.push(`${label}: credit #${creditId} not spendable (status ${c.status}, balance ${bal})`); return }
  const price = bal + 10_000
  const v = V(ctx, `spend-${creditId}`, price)
  resetCodeGate()
  const s1 = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: bal }], label: `${label}: spend credit #${creditId} (${bal}) once` })
  if (s1.ok) {
    const applied = n(s1.res.storeCreditApplied)
    if (applied !== bal) finding(ctx, 'SPEND_APPLIED_MISMATCH', label, { creditId, bal, applied })
  }
  const v2 = V(ctx, `spend2-${creditId}`, price)
  const s2 = await sale(ctx, { items: [{ v: v2 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: bal }], label: `${label}: spend credit #${creditId} AGAIN`, expect: 'refuse' })
  resetCodeGate()
  return { s1, s2 }
}

async function run(id, title, fn, opts = {}) {
  if (ONLY && !ONLY.test(id)) return
  const ctx = newCtx(id, title, opts)
  const t0 = Date.now()
  try { await fn(ctx) } catch (e) {
    finding(ctx, 'SCRIPT_ERROR', 'exception', String(e?.stack ?? e).slice(0, 800))
  }
  const ms = Date.now() - t0
  const unexpected = ctx.findings.length
  scenarios.push({ id, title, ms, steps: ctx.steps, refusals: ctx.refusals, findings: ctx.findings, certs: ctx.certs, notes: ctx.notes, obs: ctx.obs, value: ctx.lastValue })
  if (VERBOSE) for (const note of ctx.notes) console.log('    · ' + note)
  console.log(`${unexpected ? '✗' : '✓'} ${id} ${title} — steps ${ctx.steps.length}, refusals ${ctx.refusals.length}${unexpected ? `, FINDINGS ${unexpected}: ${[...new Set(ctx.findings.map((f) => f.type))].join(',')}` : ''}`)
}


// =================================================================== wholesale helpers (same as docs/audit/wholesale-barcode-scenarios.mjs)
function wLines(items, percent = 0) {
  return items.map((it) => {
    const qty = it.qty ?? 1
    const eff = Math.round(it.v.price * (1 - (percent || 0) / 100))
    const useList = eff <= it.v.price
    return { variantId: it.v.id, qty, unitPrice: useList ? it.v.price : eff, discount: useList ? it.v.price * qty - eff * qty : 0, tax: 0 }
  })
}
const payableOf = (lines) => lines.reduce((s, l) => s + l.unitPrice * l.qty - l.discount, 0)
async function wsale(ctx, { items, tender = 'CASH', code = null, paid, percent = 0, deduct = true, issuedAtJalali, customerId = null, extra = {}, expect = 'ok', label, lookup = true, splitCash }) {
  const lines = wLines(items, percent)
  const payable = payableOf(lines)
  const lbl = label ?? `wholesale ${items.length} item(s) ${tender}${code ? ' + 1 barcode' : ''}`
  let creditAmountUi = 0
  if (code && lookup) {
    const lk = await step(ctx, `${lbl} · page auto-check of the barcode`, 'either', () => storeCreditService.lookup({ code, userId }))
    if (lk.ok) creditAmountUi = n(lk.res.amount)
  }
  const creditApplied = Math.min(creditAmountUi, payable)
  const paidAmount = paid ?? Math.max(0, payable - creditApplied)
  let pay
  if (tender === 'SPLIT') {
    const c = splitCash ?? Math.floor(paidAmount / 2)
    pay = paidAmount > 0 ? { splitPayment: true, payments: [{ methodId: cashM, amount: c, destination: 'CASH' }, { methodId: cardM, amount: paidAmount - c, destination: 'CARD' }] } : { payments: [] }
  } else {
    pay = { payments: paidAmount > 0 ? [{ methodId: tender === 'CARD' ? cardM : cashM, amount: paidAmount }] : [] }
  }
  const input = {
    customerId, orderType: 'WHOLESALE', issuedAtJalali: issuedAtJalali ?? today, deductInventory: deduct,
    wholesaleDiscountPercent: percent || null, invoiceDiscount: 0, invoiceTax: 0, serviceCharge: 0, lines,
    remoteCustomer: false, autoCentralWithdraw: false, storeCreditCode: code || null, ...pay, userId, shiftId: ctx.shiftId, ...extra
  }
  const r = await step(ctx, lbl, expect, () => salesService.create(input))
  if (r.ok) {
    r.invoiceId = n(r.res.id)
    r.uiCreditApplied = creditApplied
    r.paid = paidAmount
    try {
      const html = await printService.invoiceHtml(r.invoiceId)
      for (const c of seed.rows('SELECT code,amount,usedAmount,status FROM "StoreCredit" WHERE id>?', ctx.creditFloor))
        if (html.includes(c.code) && n(c.amount) - n(c.usedAmount) > 0 && ['ACTIVE', 'PARTIALLY_USED'].includes(c.status))
          finding(ctx, 'LIVE_CODE_ON_SALE_RECEIPT', lbl, { code: c.code })
    } catch (e) { finding(ctx, 'SALE_RECEIPT_RENDER_FAILED', lbl, String(e?.message ?? e)) }
  }
  return r
}

// =================================================================== store-credit helpers
const { posMultiCreditPlan } = await imp('/src/shared/posMultiCreditPlan.ts')
const { posPreviewPayload, buildBulkPayload, EMPTY_BULK_DRAFT } = await imp('/src/shared/creditUi.ts')
const catP = seed.category('پوشاک')
const catM = seed.category('مردانه', catP)
const catW = seed.category('زنانه', catP)
const catH = seed.category('لوازم خانگی')
const CAT_NAMES = new Map([[catP, 'پوشاک'], [catM, 'مردانه'], [catW, 'زنانه'], [catH, 'لوازم خانگی']])
const custA = seed.customer('شرکت آرکاجین', '09121111111')
const custB = seed.customer('مشتری دیگر', '09122222222')
const VARIANT_LABELS = new Map()

function VC(ctx, label, price, catId, stock = 50) {
  const pid = seed.product(`${ctx.id}-${label}-${++vseq}`, catId)
  const id = seed.variant(pid, `${label}-${vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(stock, price, id)
  const v = { id, label, price, baseline: stock, catId }
  ctx.variants.push(v)
  VARIANT_LABELS.set(id, label)
  return v
}
function shop(ctx) {
  return {
    shirt: VC(ctx, 'پیراهن مردانه', 300_000, catM),
    pants: VC(ctx, 'شلوار مردانه', 500_000, catM),
    dress: VC(ctx, 'مانتو زنانه', 400_000, catW),
    mug: VC(ctx, 'ماگ', 100_000, catH)
  }
}
/** «دیده»: دادهٔ بی شناسه و بی کد که در نتیجهٔ فشرده می‌نشیند (متن‌ها در پایان پاک می‌شوند). */
function obs(ctx, kind, data) {
  ctx.obs.push({ kind, ...data })
  if (VERBOSE) console.log('    · ' + kind + ' ' + JSON.stringify(data).slice(0, 400))
}
const names = (json, map) => {
  let ids = []
  try { ids = JSON.parse(json ?? '[]') } catch { ids = [] }
  return (Array.isArray(ids) ? ids : []).map((x) => map.get(Number(x)) ?? '?')
}
const expDays = (r) => (r.expiresAt == null ? null : Math.floor((n(r.expiresAt) - Date.now()) / 86400000))
function creditView(r) {
  return { status: r.status, amount: n(r.amount), used: n(r.usedAmount), uses: n(r.usedCount), maxUses: n(r.maxUses), multi: !!r.multiUse,
    carry: r.carryRemainder == null ? null : !!r.carryRemainder, scope: r.restrictScope, cats: names(r.restrictCategoryIdsJson, CAT_NAMES),
    vars: names(r.restrictVariantIdsJson, VARIANT_LABELS), minPurchase: n(r.minPurchase), maxPerTx: n(r.maxPerTransaction), locked: !!r.customerLocked, expDays: expDays(r) }
}
const credit = (ctx, label, id) => obs(ctx, 'credit', { label, ...creditView(rawCredit(id)) })
function successors(ctx, label, sinceId) {
  const list = newCredits(ctx, sinceId).map((r) => ({ ...creditView(r), source: r.source, fromReturn: r.returnId != null }))
  obs(ctx, 'newCredits', { label, list })
  return list
}
async function issue(ctx, amount, o = {}) {
  const { label, expect, ...rest } = o
  const input = { amount, userId, managerPassword: PW, overrideReason: 'ممیزی اعتبار', ...rest }
  const pre = (expect ?? 'ok') !== 'refuse'
  if (pre) ctx.manualIssued += amount
  const r = await step(ctx, label ?? `issue ${amount} ${rest.restrictScope ?? 'ALL'}`, expect ?? 'ok', () => storeCreditService.issueManual(input))
  if (!r.ok) { if (pre) ctx.manualIssued -= amount; return null }
  const row = rawCredit(r.res.id)
  return { id: n(r.res.id), code: row.code, amount }
}
/** صندوق فروش: همان پیش‌نمایش سرور با ردیف‌هایی که صفحه می‌فرستد (فقط دستهٔ خود کالا)، سپس برنامهٔ چندبارکدی صفحه */
async function posUi(ctx, items, codes, customerId = null) {
  const lines = items.map((it) => ({ variantId: it.v.id, qty: it.qty ?? 1, categoryId: it.v.catId, lineTotal: it.v.price * (it.qty ?? 1) }))
  const payable = lines.reduce((s, l) => s + l.lineTotal, 0)
  const rows = []
  for (const [i, code] of codes.entries()) {
    const payload = posPreviewPayload({ code, payable, requested: null, customerId, lines })
    let preview = null, info = null
    try { info = await storeCreditService.lookup({ code, userId }) } catch (e) { obs(ctx, 'lookupRefused', { row: i + 1, msg: String(e?.message ?? e) }) }
    try { preview = await storeCreditService.preview({ ...payload, userId }) } catch (e) { obs(ctx, 'previewRefused', { row: i + 1, msg: String(e?.message ?? e) }) }
    if (preview) obs(ctx, 'preview', { row: i + 1, ok: preview.ok, applied: n(preview.applied), error: preview.error ?? null, notes: preview.notes ?? [],
      eligible: (preview.eligibleVariantIds ?? []).map((id) => VARIANT_LABELS.get(Number(id)) ?? '?'), excluded: (preview.excludedVariantIds ?? []).map((id) => VARIANT_LABELS.get(Number(id)) ?? '?') })
    rows.push({ id: String(i), code, expiresAt: info?.expiresAtJalali ?? null, restrictScope: info?.restrictScope ?? 'ALL', preview })
  }
  const plan = posMultiCreditPlan({ payable, rows, lines: lines.map((l) => ({ variantId: l.variantId, lineTotal: l.lineTotal })), requestedInput: null })
  obs(ctx, 'plan', { payable, applied: n(plan.applied), cashDue: n(plan.cashDue), byRow: plan.appliedById, error: plan.error ?? null, notes: plan.notes ?? [] })
  resetCodeGate()
  return { payable, plan }
}
async function posSale(ctx, items, codes, { customerId = null, label, expect = 'ok', tender = 'CASH' } = {}) {
  const ui = await posUi(ctx, items, codes, customerId)
  const credits = codes.map((code, i) => ({ code, requestedAmount: ui.plan.appliedById[String(i)] ?? 0 })).filter((c) => c.requestedAmount > 0)
  const r = await sale(ctx, { items, tender, credits, due: ui.payable - credits.reduce((s, c) => s + c.requestedAmount, 0), label: label ?? `POS sale ${items.map((i) => i.v.label).join('+')} · ${credits.length} barcode(s)`, expect, extra: customerId ? { customerId } : {} })
  resetCodeGate()
  return { ...r, ui }
}
const htmlLines = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<\/(div|h1|tr|p|section)>/g, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').split('\n').map((x) => x.trim()).filter(Boolean)
/** اندازه‌های برگهٔ چاپی به عدد (نه متن)، تا در نتیجهٔ فشرده پاک نشوند: px همان px، pt به px (×۴/۳)، em همان em. */
function cssFacts(html) {
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? ''
  const pick = (re) => (css.match(re) ?? [])[1] ?? null
  const size = (v) => {
    if (v == null) return null
    const m = String(v).trim().match(/^([0-9.]+)\s*(px|pt|em|mm)$/)
    if (!m) return { raw: 'other' }
    const x = Number(m[1])
    return m[2] === 'pt' ? { px: Math.round(x * 40 / 3) / 10 } : { [m[2]]: x }
  }
  const page = pick(/@page\s*\{\s*size:\s*([^;]+);/)
  const pm = page ? page.trim().split(/\s+/) : []
  return {
    pageWidthMm: pm[0] ? Number.parseFloat(pm[0]) : null, pageHeightMm: pm[1] ? (pm[1] === 'auto' ? 'auto' : Number.parseFloat(pm[1])) : null,
    body: size(pick(/body\s*\{[^}]*font-size:\s*([^;]+);/)), h1: size(pick(/h1\s*\{\s*font-size:\s*([^;]+);/)),
    amount: size(pick(/\.amount\s*\{[^}]*font-size:\s*([^;]+);/)), code: size(pick(/\.code\s*\{[^}]*font-size:\s*([^;]+);/)),
    rules: size(pick(/\.rules\s*\{\s*font-size:\s*([^;]+);/))
  }
}

// =================================================================== A) issuing
await run('A-issue-variants', 'صدور: انقضا/بی‌انقضا، یک‌بار/چندبار، باقی‌مانده', async (ctx) => {
  const list = [
    ['default type', { overrideReason: undefined }], ['no expiry', { days: null }], ['days 0', { days: 0 }], ['multi until amount', { multiUse: true, maxUses: 1 }],
    ['multi 3 uses', { multiUse: true, maxUses: 3 }], ['single, remainder burns', { carryRemainder: false }], ['90 days', { days: 90 }]
  ]
  for (const [label, o] of list) { const c = await issue(ctx, 500_000, { label, ...o }); if (c) credit(ctx, label, c.id) }
  await issue(ctx, 500_000, { managerPassword: 'غلط', label: 'wrong manager password', expect: 'refuse' })
  sql.prepare('DELETE FROM "AuthLockout"').run()
  await issue(ctx, 0, { label: 'amount 0', expect: 'refuse' })
  await issue(ctx, 100_000.5, { label: 'amount decimal', expect: 'refuse' })
  await issue(ctx, 100_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [], label: 'CATEGORY without ids', expect: 'refuse' })
  await issue(ctx, 100_000, { restrictScope: 'VARIANTS', restrictVariantIds: [], label: 'VARIANTS without ids', expect: 'refuse' })
  await issue(ctx, 100_000, { days: 4000, label: 'days 4000', expect: 'refuse' })
})

// =================================================================== B) 300 cards for a company, from the bulk form's own payload
let bulkBatchId = null, bulkSampleId = null
await run('B-bulk-300-company', 'تولید گروهی ۳۰۰ کارت برای شرکت آرکاجین (همان فرم)', async (ctx) => {
  const settings = await storeCreditService.settings()
  const draft = { ...EMPTY_BULK_DRAFT, amount: 500_000, count: 300, title: 'کارت هدیهٔ کارکنان آرکاجین', expiryMode: 'days', days: 60, usesMode: 'single',
    restrictScope: 'CATEGORY', restrictCategoryIds: [catM], holderCompany: 'آرکاجین', holderPhone: '021-88888888', holderNationalId: '10101234567',
    holderAgent: 'واحد منابع انسانی', holderAddress: 'تهران، خیابان آزادی', holderNote: 'تحویل به خانم رضایی', note: 'هدیهٔ فروشگاه به کارکنان شرکت آرکاجین',
    overrideReason: 'کارت هدیهٔ شرکت آرکاجین' }
  const built = buildBulkPayload(draft, settings)
  obs(ctx, 'bulkForm', { ok: built.ok, error: built.error ?? null, warnings: built.warnings, override: built.override, payloadKeys: Object.keys(built.payload ?? {}).sort() })
  if (!built.ok) return
  ctx.manualIssued += 300 * 500_000
  const r = await step(ctx, 'bulk form: 300 × 500k, 60 days, category مردانه, company آرکاجین', 'ok', () => storeCreditService.bulkIssue({ ...built.payload, managerPassword: PW, userId }))
  if (!r.ok) { ctx.manualIssued -= 300 * 500_000; return }
  bulkBatchId = n(r.res.batchId ?? r.res.batch?.id)
  const rows = seed.rows('SELECT * FROM "StoreCredit" WHERE batchId=? ORDER BY id', bulkBatchId)
  const uniq = (f) => [...new Set(rows.map(f))]
  obs(ctx, 'bulkRows', { created: rows.length, uniqueCodes: new Set(rows.map((x) => x.code)).size, codeLens: uniq((x) => x.code.length), statuses: uniq((x) => x.status),
    company: uniq((x) => x.holderCompany), phone: uniq((x) => x.holderPhone), nationalId: uniq((x) => x.holderNationalId ?? null), agent: uniq((x) => x.holderAgent ?? null),
    address: uniq((x) => x.holderAddress ?? null), holderNote: uniq((x) => x.holderNote ?? null), note: uniq((x) => x.note), overrideReason: uniq((x) => x.overrideReason ?? null),
    settingsOverride: uniq((x) => n(x.settingsOverride)), scope: uniq((x) => x.restrictScope), cats: uniq((x) => names(x.restrictCategoryIdsJson, CAT_NAMES).join('+')),
    maxUses: uniq((x) => n(x.maxUses)), carry: uniq((x) => n(x.carryRemainder)), expDays: uniq((x) => expDays(x)) })
  const b = seed.one('SELECT * FROM "StoreCreditBatch" WHERE id=?', bulkBatchId)
  const { id: _i, createdAt: _c, createdAtJalali: _cj, createdAtTime: _ct, userId: _u, ...batchRow } = b
  obs(ctx, 'batchRow', batchRow)
  const listed = (await storeCreditService.batches({})).map(({ id: _id, createdAtJalali: _a, createdAtTime: _b, ...rest }) => rest)
  obs(ctx, 'batchesList', { rows: listed })
  bulkSampleId = n(rows[0].id)
  await step(ctx, 'bulk 6000 (over the 5000 cap)', 'refuse', () => storeCreditService.bulkIssue({ count: 6000, amountEach: 1000, managerPassword: PW, userId }))
  await step(ctx, 'bulk without manager password', 'refuse', () => storeCreditService.bulkIssue({ count: 3, amountEach: 1000, userId }))
  sql.prepare('DELETE FROM "AuthLockout"').run()
  const s = shop(ctx)
  const sp = await posSale(ctx, [{ v: s.shirt }, { v: s.mug }], [rows[0].code], { label: 'employee spends a card: shirt 300k + mug 100k' })
  credit(ctx, 'card after POS spend', n(rows[0].id))
  if (sp.ok) {
    const lines = htmlLines(await printService.invoiceHtml(sp.invoiceId)).filter((l) => /اعتبار|کارت|بارکد|مانده|هدیه/.test(l))
    obs(ctx, 'saleReceiptCardLines', { lines })
  }
  await wsale(ctx, { items: [{ v: s.dress }], code: rows[1].code, label: 'card in wholesale on a women\'s dress (not eligible)', expect: 'either' })
  resetCodeGate()
})

// =================================================================== C) scopes and limits in POS
await run('C1-variant-one-mixed', 'محدود به ۱ کالا؛ سبد ترکیبی', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 200_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  await posSale(ctx, [{ v: s.shirt }, { v: s.mug }], [c.code])
  credit(ctx, 'after', c.id)
})
await run('C2-variant-one-over', 'محدود به ۱ کالا؛ مبلغ کارت بیشتر از کالای مجاز', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 500_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  const since = maxCreditId()
  await posSale(ctx, [{ v: s.shirt }, { v: s.mug }], [c.code])
  credit(ctx, 'after', c.id); successors(ctx, 'after', since)
})
await run('C3-variants-several', 'محدود به چند کالا', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 600_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id, s.dress.id] })
  await posSale(ctx, [{ v: s.shirt }, { v: s.dress }, { v: s.mug }], [c.code])
  credit(ctx, 'after', c.id)
})
await run('C4-category-one', 'محدود به ۱ دسته', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 400_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catM] })
  await posSale(ctx, [{ v: s.pants }, { v: s.mug }], [c.code])
  credit(ctx, 'after', c.id)
})
await run('C5-category-parent', 'محدود به دستهٔ والد (پوشاک)؛ کالای زیردسته (زنانه)', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 300_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catP] })
  await posSale(ctx, [{ v: s.dress }, { v: s.mug }], [c.code], { label: 'POS as the page does it' })
  credit(ctx, 'after page-like sale', c.id)
  await sale(ctx, { items: [{ v: s.dress }, { v: s.mug }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 300_000 }], due: 200_000, label: 'registration itself: dress + mug with the 300k card', expect: 'either' })
  credit(ctx, 'after direct sale', c.id)
  resetCodeGate()
})
await run('C6-categories-several', 'محدود به چند دسته (مردانه + لوازم خانگی)', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 1_000_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catM, catH] })
  await posSale(ctx, [{ v: s.pants }, { v: s.mug }, { v: s.dress }], [c.code])
  credit(ctx, 'after', c.id)
})
await run('C7-all', 'همهٔ کالاها', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 1_000_000, {})
  const since = maxCreditId()
  await posSale(ctx, [{ v: s.pants }, { v: s.mug }], [c.code])
  credit(ctx, 'after', c.id); successors(ctx, 'after', since)
})
await run('C8-no-eligible', 'هیچ کالای مجاز در سبد نیست', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 200_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  await posUi(ctx, [{ v: s.mug }], [c.code])
  await sale(ctx, { items: [{ v: s.mug }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 100_000 }], due: 0, label: 'registration itself: mug with a shirt-only card', expect: 'refuse' })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})
await run('C9-min-purchase', 'حداقل مبلغ خرید ۱٬۰۰۰٬۰۰۰', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 200_000, { minPurchase: 1_000_000 })
  await posUi(ctx, [{ v: s.pants }, { v: s.shirt }], [c.code])
  await sale(ctx, { items: [{ v: s.pants }, { v: s.shirt }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 200_000 }], due: 600_000, label: 'registration itself: 800k cart', expect: 'refuse' })
  resetCodeGate()
  await posSale(ctx, [{ v: s.pants }, { v: s.shirt }, { v: s.mug }, { v: s.mug }], [c.code], { label: 'POS: exactly 1,000,000 cart' })
  credit(ctx, 'after', c.id)
})
await run('C10-max-per-tx', 'سقف هر خرید ۱۵۰٬۰۰۰ روی کارت چندبارهٔ ۴۰۰٬۰۰۰', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 400_000, { multiUse: true, maxUses: 1, maxPerTransaction: 150_000 })
  for (let i = 1; i <= 4; i++) {
    await posSale(ctx, [{ v: s.shirt }], [c.code], { label: `purchase ${i}: shirt 300k`, expect: i <= 3 ? 'ok' : 'either' })
    credit(ctx, `after ${i}`, c.id)
  }
})
await run('C11-customer-lock', 'فقط برای یک مشتری', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 200_000, { customerLocked: true, customerId: custA, customerName: 'شرکت آرکاجین' })
  await posUi(ctx, [{ v: s.shirt }], [c.code], null)
  await sale(ctx, { items: [{ v: s.shirt }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 200_000 }], due: 100_000, label: 'registration itself: no customer', expect: 'refuse' })
  resetCodeGate()
  await sale(ctx, { items: [{ v: s.shirt }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 200_000 }], due: 100_000, label: 'registration itself: other customer', expect: 'refuse', extra: { customerId: custB } })
  resetCodeGate()
  await posSale(ctx, [{ v: s.shirt }], [c.code], { customerId: custA, label: 'POS: the right customer' })
  const c2 = await issue(ctx, 200_000, { customerLocked: true, label: 'customer lock without a customer' })
  await posSale(ctx, [{ v: s.shirt }], [c2.code], { label: 'POS: lock without customer, anyone' })
})
await run('C12-expired-suspended-void', 'منقضی، معلق، باطل', async (ctx) => {
  const s = shop(ctx)
  const e = await issue(ctx, 200_000, { days: 10 })
  sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() - 3 * 86400_000, e.id)
  await posUi(ctx, [{ v: s.shirt }], [e.code])
  await sale(ctx, { items: [{ v: s.shirt }], tender: 'CASH', credits: [{ code: e.code, requestedAmount: 200_000 }], due: 100_000, label: 'expired', expect: 'refuse' })
  resetCodeGate()
  await wsale(ctx, { items: [{ v: s.shirt }], code: e.code, label: 'expired in wholesale', expect: 'either' })
  resetCodeGate()
  const sp = await issue(ctx, 200_000, {})
  await step(ctx, 'suspend', 'ok', () => storeCreditService.suspend({ id: sp.id, reason: 'ممیزی تعلیق', managerPassword: PW, userId }))
  await sale(ctx, { items: [{ v: s.shirt }], tender: 'CASH', credits: [{ code: sp.code, requestedAmount: 200_000 }], due: 100_000, label: 'suspended', expect: 'refuse' })
  resetCodeGate()
  await step(ctx, 'reactivate', 'ok', () => storeCreditService.reactivate({ id: sp.id, reason: 'ممیزی فعال‌سازی', managerPassword: PW, userId }))
  await posSale(ctx, [{ v: s.shirt }], [sp.code], { label: 'after reactivate' })
  const vd = await issue(ctx, 200_000, {})
  await step(ctx, 'void', 'ok', () => storeCreditService.void({ id: vd.id, reason: 'ممیزی ابطال', managerPassword: PW, userId }))
  ctx.manualIssued -= 200_000
  await sale(ctx, { items: [{ v: s.shirt }], tender: 'CASH', credits: [{ code: vd.code, requestedAmount: 200_000 }], due: 100_000, label: 'voided', expect: 'refuse' })
  resetCodeGate()
}, { allowLoss: true })
await run('C13-single-burn', 'یک‌بارمصرف با سوختن باقی‌مانده', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 500_000, { carryRemainder: false })
  const since = maxCreditId()
  await posSale(ctx, [{ v: s.shirt }], [c.code], { label: 'spend 300k of 500k' })
  credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  await posSale(ctx, [{ v: s.mug }], [c.code], { label: 'try the rest 200k', expect: 'either' })
}, { allowLoss: true })
await run('C14-single-carry', 'یک‌بارمصرف با ماندن باقی‌مانده (پیش‌فرض)', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 500_000, { overrideReason: undefined })
  const since = maxCreditId()
  await posSale(ctx, [{ v: s.shirt }], [c.code], { label: 'spend 300k of 500k' })
  credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  await posSale(ctx, [{ v: s.mug }, { v: s.mug }, { v: s.mug }], [c.code], { label: 'spend the rest on 3 mugs 300k' })
  credit(ctx, 'after 2', c.id)
})
await run('C15-multi-3', 'چندباره تا ۳ بار', async (ctx) => {
  const c = await issue(ctx, 300_000, { multiUse: true, maxUses: 3 })
  for (let i = 1; i <= 4; i++) {
    const m = VC(ctx, 'کالای ۵۰ هزاری', 50_000, catH)
    await posSale(ctx, [{ v: m }], [c.code], { label: `use ${i}: 50k`, expect: i <= 3 ? 'ok' : 'either' })
  }
  credit(ctx, 'after', c.id)
}, { allowLoss: true })
await run('C16-two-scoped-same-item', 'دو کارت محدود روی یک کالا', async (ctx) => {
  const s = shop(ctx)
  const c1 = await issue(ctx, 200_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  const c2 = await issue(ctx, 200_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catM] })
  await posSale(ctx, [{ v: s.shirt }, { v: s.mug }], [c1.code, c2.code], { label: 'POS page: shirt 300k + mug 100k with both' })
  credit(ctx, 'card 1', c1.id); credit(ctx, 'card 2', c2.id)
  const s2 = shop(ctx)
  const d1 = await issue(ctx, 200_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s2.shirt.id] })
  const d2 = await issue(ctx, 200_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catM] })
  await sale(ctx, { items: [{ v: s2.shirt }, { v: s2.mug }], tender: 'CASH', credits: [{ code: d1.code, requestedAmount: 200_000 }, { code: d2.code, requestedAmount: 200_000 }], due: 0, label: 'registration itself: 200k + 200k on shirt 300k + mug', expect: 'either' })
  credit(ctx, 'card 3', d1.id); credit(ctx, 'card 4', d2.id)
  resetCodeGate()
})

// =================================================================== D) wholesale (the page as it is today: lookup, then credit = min(amount, payable))
await run('D1-ws-variant-ok', 'عمده: کارت ۱ کالا، کمتر از کالا', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 200_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  await wsale(ctx, { items: [{ v: s.shirt }, { v: s.mug }], code: c.code })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})
await run('D2-ws-variant-over', 'عمده: کارت ۱ کالا، بیشتر از کالا (سبد ترکیبی)', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 500_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  await wsale(ctx, { items: [{ v: s.shirt }, { v: s.mug }], code: c.code, label: 'page as today: credit = min(amount, payable)', expect: 'either' })
  resetCodeGate()
  const since = maxCreditId()
  await wsale(ctx, { items: [{ v: s.shirt }, { v: s.mug }], code: c.code, paid: 100_000, label: 'paid = payable − eligible (300k)', expect: 'either' })
  credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  resetCodeGate()
})
await run('D3-ws-parent-category', 'عمده: دستهٔ والد، کالای زیردسته', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 300_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catP] })
  await wsale(ctx, { items: [{ v: s.dress }], code: c.code })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})
await run('D4-ws-no-eligible', 'عمده: کالای مجاز در فاکتور نیست', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 100_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] })
  await wsale(ctx, { items: [{ v: s.mug }], code: c.code, expect: 'either' })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})
await run('D5-ws-min-purchase', 'عمده: حداقل خرید', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 100_000, { minPurchase: 1_000_000 })
  await wsale(ctx, { items: [{ v: s.pants }], code: c.code, expect: 'either' })
  resetCodeGate()
  await wsale(ctx, { items: [{ v: s.pants }, { v: s.pants }], code: c.code, expect: 'either' })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})
await run('D6-ws-customer-lock', 'عمده: فقط برای یک مشتری', async (ctx) => {
  const s = shop(ctx)
  const c = await issue(ctx, 100_000, { customerLocked: true, customerId: custA, customerName: 'شرکت آرکاجین' })
  await wsale(ctx, { items: [{ v: s.shirt }], code: c.code, customerId: custB, expect: 'either' })
  resetCodeGate()
  await wsale(ctx, { items: [{ v: s.shirt }], code: c.code, customerId: custA, expect: 'either' })
  credit(ctx, 'after', c.id)
  resetCodeGate()
})

// =================================================================== E) POS: spend, then return / exchange
async function posBase(ctx, scope) {
  const s = shop(ctx)
  const o = scope === 'V' ? { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] } : scope === 'C' ? { restrictScope: 'CATEGORY', restrictCategoryIds: [catM] } : {}
  const c = await issue(ctx, 200_000, o)
  const r = await posSale(ctx, [{ v: s.shirt }, { v: s.mug }], [c.code], { label: `base: shirt 300k + mug 100k, card 200k (${scope})` })
  if (!r.ok) throw new Error('base sale failed ' + r.error)
  return { s, c, inv: r.invoiceId }
}
for (const scope of ['V', 'C', 'ALL']) {
  await run(`E1-${scope}-full-return-cash`, `برگشت کامل، نقد (${scope})`, async (ctx) => {
    const { c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    await ret(ctx, inv, { full: true, method: 'CASH' })
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
  await run(`E2-${scope}-return-mug`, `برگشت فقط کالای غیرمجاز (ماگ)، نقد (${scope})`, async (ctx) => {
    const { s, c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, s.mug).id), qty: 1 }], method: 'CASH' })
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
  await run(`E3-${scope}-return-shirt`, `برگشت فقط کالای مجاز (پیراهن)، نقد، و خرج دوباره (${scope})`, async (ctx) => {
    const { s, c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, s.shirt).id), qty: 1 }], method: 'CASH' })
    credit(ctx, 'after', c.id)
    const list = successors(ctx, 'after', since)
    const live = newCredits(ctx, since).filter((x) => ['ACTIVE', 'PARTIALLY_USED'].includes(x.status))
    if (live.length) {
      const code = live[0].code
      await posSale(ctx, [{ v: s.mug }], [code], { label: 'second spend on a mug only', expect: 'either' })
      await posSale(ctx, [{ v: s.shirt }], [code], { label: 'second spend on the same shirt', expect: 'either' })
    } else if (!list.length) obs(ctx, 'note', { text: 'no live card after the return' })
  })
  await run(`E4-${scope}-exchange-shirt-to-dress`, `تعویض پیراهن با مانتو (برای V و C غیرمجاز) (${scope})`, async (ctx) => {
    const { s, c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    const x = await exch(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, s.shirt).id), qty: 1 }], repl: [{ v: s.dress }], pay: 'CASH' })
    obs(ctx, 'exchangePreview', x.preview ?? {})
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
  await run(`E5-${scope}-exchange-shirt-to-pants`, `تعویض پیراهن با شلوار مردانه (برای C مجاز، برای V غیرمجاز) (${scope})`, async (ctx) => {
    const { s, c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    const x = await exch(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, s.shirt).id), qty: 1 }], repl: [{ v: s.pants }], pay: 'CASH' })
    obs(ctx, 'exchangePreview', x.preview ?? {})
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
    if (x.ok) {
      const since2 = maxCreditId()
      await ret(ctx, x.exchangeInvoiceId, { full: true, method: 'CASH', label: 'full return of the exchange invoice (pants)' })
      credit(ctx, 'after return of the exchange invoice', c.id); successors(ctx, 'after return of the exchange invoice', since2)
    }
  })
  await run(`E6-${scope}-exchange-shirt-to-cheaper`, `تعویض پیراهن ۳۰۰ با ماگ ۱۰۰ (${scope})`, async (ctx) => {
    const { s, c, inv } = await posBase(ctx, scope)
    const since = maxCreditId()
    const x = await exch(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, s.shirt).id), qty: 1 }], repl: [{ v: s.mug }], refundMode: 'CASH' })
    obs(ctx, 'exchangePreview', x.preview ?? {})
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
}

// =================================================================== F) wholesale: spend, then return / exchange
for (const scope of ['V', 'C']) {
  const scopeOf = (s) => (scope === 'V' ? { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id] } : { restrictScope: 'CATEGORY', restrictCategoryIds: [catM] })
  await run(`F1-${scope}-ws-full-return`, `عمده: برگشت کامل (${scope})`, async (ctx) => {
    const s = shop(ctx)
    const c = await issue(ctx, 200_000, scopeOf(s))
    const w = await wsale(ctx, { items: [{ v: s.shirt }, { v: s.mug }], code: c.code, label: 'wholesale base: shirt + mug, card 200k' })
    resetCodeGate()
    if (!w.ok) return
    const since = maxCreditId()
    await ret(ctx, w.invoiceId, { full: true, method: 'CASH' })
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
  await run(`F2-${scope}-ws-exchange-to-dress`, `عمده: تعویض پیراهن با مانتو (${scope})`, async (ctx) => {
    const s = shop(ctx)
    const c = await issue(ctx, 200_000, scopeOf(s))
    const w = await wsale(ctx, { items: [{ v: s.shirt }, { v: s.mug }], code: c.code, label: 'wholesale base: shirt + mug, card 200k' })
    resetCodeGate()
    if (!w.ok) return
    const since = maxCreditId()
    const x = await exch(ctx, w.invoiceId, { lines: [{ saleItemId: n(itemFor(w.invoiceId, s.shirt).id), qty: 1 }], repl: [{ v: s.dress }], pay: 'CASH' })
    obs(ctx, 'exchangePreview', x.preview ?? {})
    credit(ctx, 'after', c.id); successors(ctx, 'after', since)
  })
}

// =================================================================== G) reports and the printed paper
await run('G-reports-print', 'گزارش‌ها، متن و اندازهٔ برگهٔ چاپی', async (ctx) => {
  if (bulkSampleId) {
    const d = await storeCreditService.detail({ id: bulkSampleId })
    obs(ctx, 'detailLedger', { rows: (d?.redemptions ?? []).map((r) => ({ seq: n(r.seq), amount: n(r.amount), remainderAfter: n(r.remainderAfter), reversed: !!r.reversed })) })
    const used = await printService.creditHtml(bulkSampleId)
    obs(ctx, 'paperUsedCard', { css: cssFacts(used), lines: htmlLines(used) })
    const fresh = seed.one('SELECT id FROM "StoreCredit" WHERE batchId=? AND id<>? ORDER BY id LIMIT 1 OFFSET 5', bulkBatchId, bulkSampleId)
    const html2 = await printService.creditHtml(n(fresh.id))
    obs(ctx, 'paperFreshCard', { css: cssFacts(html2), lines: htmlLines(html2) })
  }
  if (bulkBatchId) {
    const br = await printService.creditBatchRender({ batchId: bulkBatchId })
    obs(ctx, 'batchPrint', { docs: br.ids.length, total: br.total, perPage: br.perPage, pages: (br.html.match(/<section/g) ?? []).length, css: cssFacts(br.html) })
    const dash = await storeCreditService.dashboard({})
    const keep = ['issuedCount', 'issuedTotal', 'usedTotal', 'remainingTotal', 'activeCount', 'activeValue', 'unusedCount', 'fullyUsedCount', 'expiredCount', 'canceledCount', 'suspendedCount', 'liability']
    obs(ctx, 'dashboard', Object.fromEntries(keep.map((k) => [k, dash?.[k] ?? null])))
  }
  const s = shop(ctx)
  const c = await issue(ctx, 250_000, { restrictScope: 'VARIANTS', restrictVariantIds: [s.shirt.id, s.pants.id], holderCompany: 'آرکاجین', note: 'فقط برای پیراهن و شلوار مردانه' })
  const html3 = await printService.creditHtml(c.id)
  obs(ctx, 'paperVariantScope', { lines: htmlLines(html3).filter((l) => /محدود|قابل استفاده برای/.test(l)) })
  const c4 = await issue(ctx, 250_000, { restrictScope: 'CATEGORY', restrictCategoryIds: [catM, catH] })
  const html4 = await printService.creditHtml(c4.id)
  obs(ctx, 'paperCategoryScope', { lines: htmlLines(html4).filter((l) => /محدود|قابل استفاده برای/.test(l)) })
  const lk = await storeCreditService.lookup({ code: c.code, userId })
  obs(ctx, 'lookupScopeFields', { restrictScope: lk.restrictScope, restrictScopeLabel: lk.restrictScopeLabel ?? null, usesLabel: lk.usesLabel ?? null })
  resetCodeGate()
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
writeFileSync(fullPath, JSON.stringify({ summary, scenarios }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))

// Normalised result: no credit/return codes, no ids, no dates or times — behaviour, amounts and texts.
// Persian digits become «#» and Latin digits «0», so a change of digit script in a message is still visible.
const secretCodes = [
  ...seed.rows('SELECT code FROM "StoreCredit"').map((r) => String(r.code)),
  ...seed.rows('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').map((r) => String(r.returnCode))
].filter((c) => c.length >= 4).sort((a, b) => b.length - a.length)
const normStr = (t, firstLine = true) => {
  let s = String(t ?? '')
  if (firstLine) s = s.split('\n')[0]
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
const BRIEF_KEYS = ['grandTotal', 'paidTotal', 'storeCreditApplied', 'total', 'refundMethod', 'refundAmount', 'returnCreditAmount', 'sourceCreditRestoredAmount',
  'diff', 'cashReceived', 'cardReceived', 'barcodeCreditApplied', 'cashRefunded', 'cardRefunded', 'realMoneyRefundAmount', 'newStoreCreditAmount', 'payoutAmount', 'refundMode', 'settlement', 'idempotentReplay', 'replayed']
const normBrief = (b) => {
  if (!b || typeof b !== 'object') return b ?? null
  const o = {}
  for (const k of BRIEF_KEYS) if (b[k] !== undefined) o[k] = b[k]
  if (b.creditOutcomes) o.creditOutcomes = b.creditOutcomes
  if (b.storeCredit) o.storeCredit = b.storeCredit.amount
  if (b.overpayCredit) o.overpayCredit = b.overpayCredit.amount
  if (b.successors) o.successors = b.successors.map((s) => s.amount)
  if (b.cardTransfer) o.cardTransfer = b.cardTransfer.amount
  return o
}
const snapshot = scenarios.map((s) => ({
  id: s.id,
  steps: s.steps.map((st) => [normText(st.label), st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? normBrief(st.brief) : normText(st.msg)]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${normText(f.label)}`))].sort(),
  obs: normDeep(s.obs ?? []),
  value: s.value
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/store-credit-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
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
    for (const key of ['findings', 'value']) {
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
