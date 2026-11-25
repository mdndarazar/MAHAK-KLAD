/**
 * آزمون سناریوهای فروش، برگشت، تعویض و بارکد اعتبار — همان ۱۵۸ سناریوی آزمون ۲۰۲۶-۱۱-۲۵
 * (یافته‌های ۴-۶۸ تا ۴-۷۳ دفتر آزمون مالک).
 *
 * فقط ابزار آزمون است: روی پایگاه دادهٔ موقت (پوشهٔ temp) اجرا می‌شود، چاپگر شبیه‌سازی‌شده است و به
 * برنامه، پایگاه واقعی یا آزمون‌های مخزن دست نمی‌زند. در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را
 * برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/sales-barcode-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی کد بارکد، بی شناسه، بی تاریخ) برای مقایسه
 *   ... --compare docs/audit/sales-barcode-scenarios-2026-11-25.json
 *                                مقایسه با نتیجهٔ ثبت‌شدهٔ ۲۰۲۶-۱۱-۲۵؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_ONLY=<regex>  فقط سناریوهای هم‌نام    AUD_VERBOSE=1  ریز هر گام
 *
 * پس از هر عملیات هفت سنجش: گزارش فروش با ردیف‌های خام، صندوق امانی با ردیف‌های خام، دفتر موجودی،
 * موجودی با سندها، ماندهٔ هر بارکد با دفتر مصرفش، «پول داده = پول پس‌گرفته + اعتبار زنده + کالای مانده
 * (+ زیان ثبت‌شدهٔ اصلاح جبرانی)»، و بی‌اثر بودنِ هر کارِ ردشده.
 * قاعدهٔ مالک (دفتر آزمون، «شرط مالک برای ۴-۶۸ تا ۴-۷۳»): هر تغییرِ کم‌ریسک پیش و پس با همین ابزار
 * سنجیده و با نتیجهٔ ثبت‌شده مقایسه می‌شود؛ فقط تفاوت‌های خواسته‌شده پذیرفته است.
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
const dir = mkdtempSync(join(tmpdir(), 'sales-barcode-scenarios-'))
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
  return { id, title, shiftId, creditFloor, variants: [], manualIssued: 0, steps: [], findings: [], findingKeys: new Set(), refusals: [], certs: [], notes: [], allowLoss: !!opts.allowLoss, lastValue: null }
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
  scenarios.push({ id, title, ms, steps: ctx.steps, refusals: ctx.refusals, findings: ctx.findings, certs: ctx.certs, notes: ctx.notes, value: ctx.lastValue })
  if (VERBOSE) for (const note of ctx.notes) console.log('    · ' + note)
  console.log(`${unexpected ? '✗' : '✓'} ${id} ${title} — steps ${ctx.steps.length}, refusals ${ctx.refusals.length}${unexpected ? `, FINDINGS ${unexpected}: ${[...new Set(ctx.findings.map((f) => f.type))].join(',')}` : ''}`)
}

// =================================================================== part 1 (127 scenarios)
const SALE_TYPES = {
  T1: { title: 'نقد', tender: 'CASH', codes: [] },
  T2: { title: 'کارت', tender: 'CARD', codes: [] },
  T3: { title: 'نقد+کارت', tender: 'SPLIT', codes: [] },
  T4: { title: 'نقد + ۱ بارکد', tender: 'CASH', codes: [50_000] },
  T5: { title: 'فقط بارکد (۲ بارکد)', tender: 'NONE', codes: [120_000, 80_000] },
  T6: { title: 'نقد+کارت + ۲ بارکد', tender: 'SPLIT', codes: [30_000, 40_000] }
}
/** root sale: X 120k + Y 80k (optionally qty for X) */
async function rootSale(ctx, typeKey, { xQty = 1 } = {}) {
  const T = SALE_TYPES[typeKey]
  const X = V(ctx, 'X', 120_000), Y = V(ctx, 'Y', 80_000)
  const total = 120_000 * xQty + 80_000
  // فقط بارکد: بارکدها کل فاکتور را می‌پوشانند (با ۲ عدد X هم)
  const codes = T.tender === 'NONE' ? [total - 80_000, 80_000] : T.codes
  const credits = []
  for (const a of codes) credits.push({ ...(await issueManual(ctx, a)), requestedAmount: a })
  const cover = codes.reduce((s, a) => s + a, 0)
  const s = await sale(ctx, { items: [{ v: X, qty: xQty }, { v: Y }], tender: T.tender, credits, due: total - cover, label: `root sale [${T.title}] total ${total}` })
  if (!s.ok) throw new Error('root sale failed: ' + s.error)
  return { X, Y, invoiceId: s.invoiceId, credits, sale: s }
}

// ---------- A) sales matrix
for (const items of [1, 3]) for (const tender of ['CASH', 'CARD', 'SPLIT']) for (const codes of [0, 1, 3]) {
  const id = `A-${items}i-${tender}-${codes}bc`
  await run(id, `فروش ${items} قلمی، ${tender}، ${codes} بارکد`, async (ctx) => {
    const vs = Array.from({ length: items }, (_, i) => V(ctx, `I${i + 1}`, [90_000, 150_000, 60_000][i]))
    const credits = []
    for (let i = 0; i < codes; i++) credits.push({ ...(await issueManual(ctx, [20_000, 35_000, 15_000][i])), requestedAmount: [20_000, 35_000, 15_000][i] })
    const s = await sale(ctx, { items: vs.map((v) => ({ v })), tender, credits })
    if (s.ok && codes) {
      for (const c of credits) {
        const v2 = V(ctx, 'again', 50_000)
        await sale(ctx, { items: [{ v: v2 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: c.requestedAmount }], label: `spend used barcode again`, expect: 'refuse' })
        resetCodeGate()
      }
    }
  })
}
for (const items of [1, 3]) for (const codes of [1, 3]) {
  await run(`A-${items}i-ONLYBC-${codes}bc`, `فروش ${items} قلمی فقط با ${codes} بارکد`, async (ctx) => {
    const vs = Array.from({ length: items }, (_, i) => V(ctx, `I${i + 1}`, [40_000, 30_000, 20_000][i]))
    const total = vs.reduce((s, v) => s + v.price, 0)
    const shares = codes === 1 ? [total] : [Math.floor(total / 3), Math.floor(total / 3), total - 2 * Math.floor(total / 3)]
    const credits = []
    for (const a of shares) credits.push({ ...(await issueManual(ctx, a)), requestedAmount: a })
    await sale(ctx, { items: vs.map((v) => ({ v })), tender: 'NONE', credits })
  })
}
await run('A-8bc', 'فروش با ۸ بارکد (سقف)', async (ctx) => {
  const v = V(ctx, 'I', 100_000)
  const credits = []
  for (let i = 0; i < 8; i++) credits.push({ ...(await issueManual(ctx, 10_000)), requestedAmount: 10_000 })
  await sale(ctx, { items: [{ v }], tender: 'CASH', credits })
})
await run('A-9bc', 'فروش با ۹ بارکد (بیش از سقف)', async (ctx) => {
  const v = V(ctx, 'I', 100_000)
  const credits = []
  for (let i = 0; i < 9; i++) credits.push({ ...(await issueManual(ctx, 10_000)), requestedAmount: 10_000 })
  await sale(ctx, { items: [{ v }], tender: 'CASH', credits, expect: 'either' })
})
await run('A-partial-single', 'سهم جزئی از بارکد یک‌بارمصرف، بعد خرج باقی‌مانده، بعد بار سوم', async (ctx) => {
  const c = await issueManual(ctx, 100_000)
  const v1 = V(ctx, 'I1', 70_000), v2 = V(ctx, 'I2', 50_000), v3 = V(ctx, 'I3', 50_000)
  await sale(ctx, { items: [{ v: v1 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 40_000 }], label: 'use 40k of 100k single-use' })
  ctx.notes.push(`after partial: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}`)
  await sale(ctx, { items: [{ v: v2 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 50_000 }], label: 'use remaining 60k? (50k)', expect: 'either' })
  ctx.notes.push(`after 2nd: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}`)
  await sale(ctx, { items: [{ v: v3 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 10_000 }], label: 'third use of single-use code', expect: 'either' })
  ctx.notes.push(`after 3rd: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}`)
  resetCodeGate()
}, { allowLoss: true })
await run('A-multi-use', 'بارکد چندبارمصرف: سه خرید تا تمام شدن، بار چهارم رد', async (ctx) => {
  const c = await issueManual(ctx, 90_000, { multiUse: true, maxUses: 3 })
  for (let i = 0; i < 3; i++) {
    const v = V(ctx, `I${i}`, 40_000)
    await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], label: `multi-use spend ${i + 1}/3` })
  }
  const v = V(ctx, 'I4', 40_000)
  await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 10_000 }], label: 'multi-use 4th spend', expect: 'refuse' })
  resetCodeGate()
})
await run('A-expired', 'بارکد منقضی', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() - 86_400_000, c.id)
  const v = V(ctx, 'I', 100_000)
  const r1 = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], label: 'expired code, cash only for the rest', expect: 'refuse' })
  ctx.notes.push('expired msg: ' + (r1.error ?? '').slice(0, 300))
  resetCodeGate()
  const r2 = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], due: 100_000, label: 'expired code, full cash', expect: 'either' })
  if (r2.ok) ctx.notes.push('outcomes: ' + JSON.stringify(r2.res.storeCreditOutcomes))
  resetCodeGate()
}, { allowLoss: true })
await run('A-void', 'بارکد باطل‌شده', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  await storeCreditService.void({ id: c.id, reason: 'آزمون ابطال', managerPassword: PW, userId })
  const v = V(ctx, 'I', 100_000)
  const r = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], label: 'void code', expect: 'refuse' })
  ctx.notes.push('void msg: ' + (r.error ?? '').slice(0, 300))
  resetCodeGate()
}, { allowLoss: true })
await run('A-dup-in-request', 'یک بارکد دو بار در یک درخواست', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const r = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 15_000 }, { code: c.code, requestedAmount: 15_000 }], label: 'same code twice in one sale', expect: 'refuse' })
  ctx.notes.push('dup msg: ' + (r.error ?? '').slice(0, 300))
  resetCodeGate()
})
await run('A-idem-retry', 'تکرار درخواست با همان کلید (شبکه/دوبار کلیک)', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const key = `aud-idem-${ctx.id}`
  const s1 = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], key, label: 'first submit' })
  const s2 = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], key, label: 'same key retry' })
  if (s1.ok && s2.ok && n(s1.res.id) !== n(s2.res.id)) finding(ctx, 'IDEMPOTENT_RETRY_NEW_INVOICE', 'same key', { a: s1.res.id, b: s2.res.id })
  ctx.notes.push(`credit used=${n(rawCredit(c.id).usedAmount)} redemptions=${seed.count('StoreCreditRedemption', 'creditId=?', c.id)}`)
  await sale(ctx, { items: [{ v }, { v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], key, label: 'same key, different cart', expect: 'refuse' })
  resetCodeGate()
})
await run('A-race', 'دو صندوق: هر دو بارکد را «معتبر» دیدند، یکی زودتر ثبت کرد', async (ctx) => {
  const c = await issueManual(ctx, 40_000)
  await step(ctx, 'cashier B: lookup (valid)', 'ok', () => storeCreditService.lookup({ code: c.code, userId }))
  const v1 = V(ctx, 'I1', 60_000), v2 = V(ctx, 'I2', 60_000)
  await sale(ctx, { items: [{ v: v1 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 40_000 }], label: 'cashier A saves first' })
  const b = await sale(ctx, { items: [{ v: v2 }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 40_000 }], label: 'cashier B saves (code already used)', expect: 'refuse' })
  ctx.notes.push('B msg: ' + (b.error ?? '').slice(0, 400))
  resetCodeGate()
})
await run('A-over-balance', 'درخواست بیش از موجودی بارکد', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const r = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 50_000 }], label: 'request 50k from a 30k barcode', expect: 'either' })
  ctx.notes.push('msg: ' + (r.error ?? JSON.stringify(r.res?.storeCreditOutcomes ?? '')).slice(0, 300))
  resetCodeGate()
})
await run('A-credit-gt-total', 'بارکد بزرگ‌تر از جمع فاکتور (باقی‌مانده روی بارکد)', async (ctx) => {
  const c = await issueManual(ctx, 150_000)
  const v = V(ctx, 'I', 100_000), v2 = V(ctx, 'I2', 50_000)
  await sale(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: null }], due: 0, label: 'barcode 150k on 100k invoice (full-balance mode)' })
  ctx.notes.push(`after: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}`)
  await sale(ctx, { items: [{ v: v2 }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: null }], due: 0, label: 'use the 50k remainder', expect: 'either' })
  ctx.notes.push(`after 2: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}`)
  resetCodeGate()
}, { allowLoss: true })
await run('A-overpay-with-credit', 'بارکد + نقد بیشتر از جمع (اضافه‌پرداخت)', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 30_000 }], due: 100_000, label: 'barcode 30k + cash 100k on 100k', expect: 'either' })
  resetCodeGate()
})
await run('A-code-gate-lock', 'قفل سراسری ورود کد: سه بارکد مصرف‌شده پشت‌سرهم، بعد بارکد سالم', async (ctx) => {
  resetCodeGate()
  const used = await issueManual(ctx, 20_000)
  const good = await issueManual(ctx, 20_000)
  const v0 = V(ctx, 'I0', 20_000)
  await sale(ctx, { items: [{ v: v0 }], tender: 'NONE', credits: [{ code: used.code, requestedAmount: 20_000 }], due: 0, label: 'customer 1 spends barcode U' })
  for (let i = 1; i <= 3; i++) {
    const r = await step(ctx, `cashier checks used barcode U (attempt ${i})`, 'refuse', () => storeCreditService.lookup({ code: used.code, userId }))
    ctx.notes.push(`attempt ${i}: ${(r.error ?? '').split('\n').slice(-1)[0].slice(0, 200)}`)
  }
  const look = await step(ctx, 'next customer: lookup of a GOOD barcode', 'ok', () => storeCreditService.lookup({ code: good.code, userId }))
  ctx.notes.push('good-lookup: ' + (look.error ?? 'OK').slice(0, 300))
  const v = V(ctx, 'I', 50_000)
  const s = await sale(ctx, { items: [{ v }], tender: 'CASH', credits: [{ code: good.code, requestedAmount: 20_000 }], label: 'next customer pays with GOOD barcode', expect: 'ok' })
  ctx.notes.push('good-sale: ' + (s.error ?? JSON.stringify(s.res?.storeCreditOutcomes)).slice(0, 300))
  resetCodeGate()
})

// ---------- B) returns: 6 sale types × 6 methods (partial X then the rest Y with the next method)
const METHODS = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']
for (const typeKey of Object.keys(SALE_TYPES)) {
  for (let mi = 0; mi < METHODS.length; mi++) {
    const m1 = METHODS[mi], m2 = METHODS[(mi + 1) % METHODS.length]
    const declined = m1 === 'DECLINED' || m2 === 'DECLINED'
    await run(`B-${typeKey}-${m1}`, `برگشت از فروش [${SALE_TYPES[typeKey].title}]: جزئی ${m1} سپس بقیه ${m2}`, async (ctx) => {
      const root = await rootSale(ctx, typeKey)
      const r1 = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: m1, expect: 'either', label: `partial return X(120k) ${m1}` })
      const r2 = await ret(ctx, root.invoiceId, { full: true, method: m2, expect: 'either', label: `return rest Y(80k) ${m2}` })
      for (const r of [r1, r2]) if (r.ok) for (const c of r.credits ?? []) {
        await certLifecycle(ctx, n(c.id), `credit from ${r === r1 ? 'partial' : 'final'} return`)
        await spendTwice(ctx, n(c.id), `credit #${c.id}`)
      }
    }, { allowLoss: declined })
  }
}

// ---------- C) exchange chains, 3 steps, from every sale type
const POS_PAY = ['CASH', 'CARD', 'SPLIT', 'BARCODE']
const NEG_MODE = ['CASH', 'CARD', 'STORE_CREDIT', 'CARD_TO_CARD', 'UNSELECTED']
let chainNo = 0
async function chainExchange(ctx, invoiceId, srcV, sign, k, label) {
  const price = srcV.price + (sign > 0 ? 30_000 : sign < 0 ? -30_000 : 0)
  const nv = V(ctx, `${srcV.label}x`, price)
  const item = itemFor(invoiceId, srcV)
  if (!item) throw new Error(`item ${srcV.label} not on invoice ${invoiceId}`)
  let code
  const pay = POS_PAY[k % POS_PAY.length]
  if (sign > 0 && pay === 'BARCODE') code = (await issueManual(ctx, 30_000)).code
  const r = await exch(ctx, invoiceId, { lines: [{ saleItemId: n(item.id), qty: 1 }], repl: [{ v: nv }], pay, refundMode: NEG_MODE[k % NEG_MODE.length], code, label, expect: 'either' })
  resetCodeGate()
  return { r, nv }
}
const CHAIN_KINDS = ['EX-EX-EX', 'EX-EX-RET', 'RET-EX-EX', 'PRET-EX-RET']
const SIGNS = [[1, -1, 0], [-1, 1, -1], [0, -1, 1], [-1, -1, 1], [1, 1, -1], [-1, 0, -1]]
for (const typeKey of Object.keys(SALE_TYPES)) {
  for (const kind of CHAIN_KINDS) {
    const k = chainNo++
    const signs = SIGNS[k % SIGNS.length]
    await run(`C-${typeKey}-${kind}`, `زنجیره ${kind} از فروش [${SALE_TYPES[typeKey].title}] علامت‌ها ${signs.join('/')}`, async (ctx) => {
      const root = await rootSale(ctx, typeKey, { xQty: kind === 'PRET-EX-RET' ? 2 : 1 })
      const issued = []
      const take = (r) => { if (r?.ok) for (const c of r.credits ?? []) issued.push({ id: n(c.id), from: r.label ?? '' }) }
      let inv = root.invoiceId, cur = root.X
      if (kind === 'EX-EX-EX' || kind === 'EX-EX-RET') {
        const s1 = await chainExchange(ctx, inv, cur, signs[0], k, 'step1 exchange X on root'); take(s1.r)
        if (!s1.r.ok) return
        inv = s1.r.exchangeInvoiceId; cur = s1.nv
        const s2 = await chainExchange(ctx, inv, cur, signs[1], k + 1, 'step2 exchange on exchange-invoice-1'); take(s2.r)
        if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        if (kind === 'EX-EX-EX') { const s3 = await chainExchange(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-2'); take(s3.r) }
        else { const r3 = await ret(ctx, inv, { full: true, method: METHODS[k % 4], expect: 'either', label: `step3 return of exchange-invoice-2 ${METHODS[k % 4]}` }); take(r3) }
      } else if (kind === 'RET-EX-EX') {
        const r1 = await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.Y).id), qty: 1 }], method: METHODS[k % 4], expect: 'either', label: `step1 return Y ${METHODS[k % 4]}` }); take(r1)
        const s2 = await chainExchange(ctx, inv, cur, signs[1], k + 1, 'step2 exchange X on root'); take(s2.r)
        if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        const s3 = await chainExchange(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-1'); take(s3.r)
      } else {
        const r1 = await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.X).id), qty: 1 }], method: METHODS[(k + 1) % 4], expect: 'either', label: `step1 partial return 1 of 2 X ${METHODS[(k + 1) % 4]}` }); take(r1)
        const s2 = await chainExchange(ctx, inv, cur, signs[1], k + 1, 'step2 exchange the other X'); take(s2.r)
        if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        const r3 = await ret(ctx, inv, { full: true, method: METHODS[(k + 2) % 4], expect: 'either', label: `step3 return exchange-invoice-1 ${METHODS[(k + 2) % 4]}` }); take(r3)
      }
      for (const [i, c] of issued.entries()) await certLifecycle(ctx, c.id, `chain credit (${c.from})`, { reprint: i % 2 === 0 })
      for (const c of issued) await spendTwice(ctx, c.id, `chain credit #${c.id}`)
    })
  }
}

// ---------- D) print rules
await run('D-shift-closed', 'چاپ دوباره بعد از بسته شدن شیفت', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return finding(ctx, 'NO_CREDIT', 'return STORE_CREDIT', null)
  openReturnPanel(); printers()
  const p1 = await invoke(IPC.creditDeliveryPrint, { id: n(c.id) })
  ctx.notes.push('first print: ' + (p1.ok ? 'OK' : p1.error))
  sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), ctx.shiftId)
  printers()
  const rp = await invoke(IPC.creditSellerReprint, { id: n(c.id), reasonCode: 'INCOMPLETE' })
  ctx.notes.push('seller reprint after close: ' + (rp.ok ? 'OK (!)' : rp.error))
  if (rp.ok) finding(ctx, 'REPRINT_AFTER_SHIFT_CLOSE', 'seller', c.id)
  sql.prepare('UPDATE "Shift" SET closedAt=NULL WHERE id=?').run(ctx.shiftId)
  const r2 = await ret(ctx, root.invoiceId, { full: true, method: 'STORE_CREDIT' })
  sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), ctx.shiftId)
  const c2 = r2.credits?.[0]
  if (c2) { printers(); const fp = await invoke(IPC.creditDeliveryPrint, { id: n(c2.id) }); ctx.notes.push('FIRST print after shift close: ' + (fp.ok ? 'OK' : fp.error)) }
})
await run('D-manager-print', 'چاپ مدیر: بی نشست رد، با نشست مدیر پذیرفته، نسخه دوم برچسب‌دار', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  clearPanelSessions(sender.id)
  notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', sender.id)
  printers()
  let p = await invoke(IPC.printCredit, { id: n(c.id), copies: 2, deviceName: 'Axiom', silent: true })
  ctx.notes.push('printCredit seller session: ' + (p.ok ? 'OK (!)' : p.error))
  if (p.ok) finding(ctx, 'MANAGER_PRINT_WITHOUT_MANAGER', 'printCredit', c.id)
  notePanelUnlocked(PANEL_KEYS.creditManagement, 'MANAGER', sender.id)
  printers()
  p = await invoke(IPC.printCredit, { id: n(c.id), copies: 2, deviceName: 'Axiom', silent: true })
  ctx.notes.push('printCredit manager: ' + (p.ok ? `OK calls=${mock.state.printCalls.length}` : p.error))
  printers()
  p = await invoke(IPC.printCredit, { id: n(c.id), reprint: true, copies: 1, deviceName: 'Axiom', silent: true })
  ctx.notes.push('printCredit manager reprint: ' + (p.ok ? `OK labelled=${(mock.state.windows.at(-1)?._html ?? '').includes('نسخه‌ی مجدد')}` : p.error))
  ctx.notes.push(`printCount=${n(rawCredit(n(c.id)).printCount)}`)
  clearPanelSessions(sender.id)
  openReturnPanel()
  const rev = await invoke(IPC.creditManagerCodeReveal, { sourceId: n(c.id), sourceSubKind: 'CREDIT' })
  ctx.notes.push('code reveal (seller): ' + (rev.ok ? 'OK (!)' : rev.error))
  if (rev.ok && JSON.stringify(rev.data ?? '').includes(rawCredit(n(c.id)).code)) finding(ctx, 'SELLER_CAN_REVEAL_CODE', 'reveal', c.id)
})
await run('D-cancel-then-retry', 'چاپ نخست لغو شد ⇒ دوباره چاپ نخست', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  openReturnPanel(); printers(); mock.state.printOutcome = 'canceled'
  const p1 = await invoke(IPC.creditDeliveryPrint, { id: n(c.id) })
  ctx.notes.push(`canceled first print: ${p1.ok ? 'OK' : p1.error} printCount=${n(rawCredit(n(c.id)).printCount)}`)
  printers()
  const p2 = await invoke(IPC.creditDeliveryPrint, { id: n(c.id) })
  ctx.notes.push(`retry first print: ${p2.ok ? 'OK' : p2.error} printCount=${n(rawCredit(n(c.id)).printCount)}`)
  printers(); mock.state.printOutcome = 'crash'
  const r3 = await ret(ctx, root.invoiceId, { full: true, method: 'STORE_CREDIT' })
  const c3 = r3.credits?.[0]
  if (c3) {
    const p3 = await invoke(IPC.creditDeliveryPrint, { id: n(c3.id) })
    ctx.notes.push(`unknown-outcome first print: ${p3.ok ? 'OK' : p3.error} printCount=${n(rawCredit(n(c3.id)).printCount)}`)
    printers()
    const p4 = await invoke(IPC.creditDeliveryPrint, { id: n(c3.id) })
    ctx.notes.push(`after unknown: first print again: ${p4.ok ? 'OK' : p4.error}`)
    printers()
    const p5 = await invoke(IPC.creditSellerReprint, { id: n(c3.id), reasonCode: 'INCOMPLETE' })
    ctx.notes.push(`after unknown: seller reprint: ${p5.ok ? 'OK' : p5.error}`)
  }
})
await run('D-code-leak-scan', 'کد بارکد در خروجی‌های قابل دید فروشنده نباشد', async (ctx) => {
  const root = await rootSale(ctx, 'T4')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const Z = V(ctx, 'Z', 50_000)
  const e = await exch(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.Y).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'STORE_CREDIT', label: 'exchange Y→Z (-30k) STORE_CREDIT' })
  const codes = seed.rows('SELECT id,code,source,status,amount,usedAmount FROM "StoreCredit" WHERE id>?', ctx.creditFloor).filter((c) => n(c.amount) - n(c.usedAmount) > 0 && ['ACTIVE', 'PARTIALLY_USED'].includes(c.status))
  const probes = {
    saleGet: () => salesService.get(root.invoiceId),
    exchangeInvoiceGet: () => salesService.get(e.exchangeInvoiceId),
    payments: () => salesService.payments({ invoiceId: root.invoiceId }),
    lineage: () => salesService.creditSettlementLineage({ invoiceId: root.invoiceId }),
    returnList: () => salesService.returnList({ fromJalali: today, toJalali: today }),
    returnGet: () => salesService.returnGet(r.returnId),
    exchangeList: () => salesService.exchangeList({ fromJalali: today, toJalali: today }),
    exchangeGet: () => salesService.exchangeGet({ id: e.returnId }),
    creditList: () => salesService.creditList({ fromJalali: today, toJalali: today }),
    reportRows: () => salesService.reportRows({ shiftId: ctx.shiftId }),
    reportItems: () => salesService.reportItems({ fromJalali: today, toJalali: today }),
    byReturnCode: async () => salesService.findByReturnCode(seed.one('SELECT returnCode FROM "SaleInvoice" WHERE id=?', root.invoiceId).returnCode),
    exchangeReplay: async () => { const row = seed.one('SELECT exchangeRequestResultJson j FROM "SaleReturn" WHERE id=?', e.returnId); return row?.j ?? '' },
    creditReportList: () => storeCreditService.reportList ? storeCreditService.reportList({ fromJalali: today, toJalali: today }) : null
  }
  for (const [name, fn] of Object.entries(probes)) {
    let out
    try { out = await fn() } catch (err) { ctx.notes.push(`${name}: error ${String(err?.message ?? err).slice(0, 120)}`); continue }
    const text = typeof out === 'string' ? out : JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v))
    const leaked = codes.filter((c) => text.includes(c.code)).map((c) => `#${c.id}/${c.source}`)
    ctx.notes.push(`${name}: ${leaked.length ? 'LEAK ' + leaked.join(',') : 'clean'}`)
    if (leaked.length) finding(ctx, 'LIVE_CODE_IN_READ_API', name, leaked)
  }
})
await run('D-partial-then-reprint', 'گواهی چاپ شد، بخشی خرج شد، بعد چاپ دوباره فروشنده', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  openReturnPanel(); printers()
  await invoke(IPC.creditDeliveryPrint, { id: n(c.id) })
  const v = V(ctx, 'I', 50_000)
  await sale(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 50_000 }], due: 0, label: 'spend 50k of the 120k return credit' })
  const row = rawCredit(n(c.id))
  ctx.notes.push(`after partial spend: status=${row.status} used=${n(row.usedAmount)}/${n(row.amount)}`)
  printers()
  const rp = await invoke(IPC.creditSellerReprint, { id: n(c.id), reasonCode: 'INCOMPLETE' })
  ctx.notes.push('seller reprint of partially used credit: ' + (rp.ok ? 'OK' : rp.error))
  const v2 = V(ctx, 'I2', 70_000)
  await sale(ctx, { items: [{ v: v2 }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 70_000 }], due: 0, label: 'spend the remaining 70k' })
  ctx.notes.push(`after full: status=${rawCredit(n(c.id)).status}`)
  resetCodeGate()
})

// ---------- E) cash-out probes
async function bcOnlySale(ctx, price = 100_000) {
  const X = V(ctx, 'X', price)
  const c = await issueManual(ctx, price)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: price }], due: 0, label: `sale ${price} paid 100% by barcode` })
  return { X, c, invoiceId: s.invoiceId }
}
for (const m of ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']) {
  await run(`E-bconly-return-${m}`, `فروش تمام‌بارکد ⇒ برگشت کامل با ${m}`, async (ctx) => {
    const s = await bcOnlySale(ctx)
    const r = await ret(ctx, s.invoiceId, { full: true, method: m, expect: 'either' })
    if (r.ok) ctx.notes.push(`refundMethod=${r.res.refundMethod} refundAmount=${n(r.res.refundAmount)} restored=${n(r.res.sourceCreditRestoredAmount)} original credit status=${rawCredit(s.c.id).status}/${n(rawCredit(s.c.id).usedAmount)}`)
    for (const c of r.credits ?? []) await certLifecycle(ctx, n(c.id), 'credit after bc-only return')
  })
}
await run('E-bconly-fullrefund', 'فروش تمام‌بارکد ⇒ برگشت نقدی «مبلغ کامل با رمز مدیر»', async (ctx) => {
  const s = await bcOnlySale(ctx)
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', expect: 'either', extra: { managerFullRefund: true, managerPassword: PW, overrideReason: 'آزمون ممیزی مبلغ کامل' } })
})
for (const m of ['CASH', 'CARD', 'CARD_TO_CARD', 'UNSELECTED']) {
  await run(`E-bconly-exchange-cheaper-${m}`, `فروش تمام‌بارکد ⇒ تعویض با کالای ارزان‌تر، بازپرداخت ${m}`, async (ctx) => {
    const s = await bcOnlySale(ctx)
    const Z = V(ctx, 'Z', 60_000)
    const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, s.X).id), qty: 1 }], repl: [{ v: Z }], refundMode: m, expect: 'either', label: 'exchange 100k → 60k' })
    if (e.ok) ctx.notes.push(`cashRefunded=${n(e.res.cashRefunded)} cardRefunded=${n(e.res.cardRefunded)} newCredit=${n(e.res.newStoreCreditAmount)} successors=${JSON.stringify((e.res.sourceCreditSuccessors ?? []).map((x) => x.amount))}`)
    for (const c of e.credits ?? []) await certLifecycle(ctx, n(c.id), 'credit from bc-only exchange')
  })
}
await run('E-mixed-partials-cash', 'فروش ۶۰٪ بارکد + ۴۰٪ نقد ⇒ برگشت قلم‌به‌قلم همه نقدی', async (ctx) => {
  const a = V(ctx, 'A', 50_000), b = V(ctx, 'B', 50_000), d = V(ctx, 'D', 50_000), e = V(ctx, 'E', 50_000)
  const c = await issueManual(ctx, 120_000)
  const s = await sale(ctx, { items: [{ v: a }, { v: b }, { v: d }, { v: e }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 120_000 }], label: 'sale 200k = 120k barcode + 80k cash' })
  for (const v of [a, b, d, e]) await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, v).id), qty: 1 }], method: 'CASH', expect: 'either', label: `return ${v.label} CASH` })
  const raw = rawPhysical(ctx.shiftId)
  ctx.notes.push(`total cash out ${raw.refundCash} vs cash in ${raw.cash}`)
})
await run('E-mixed-partials-cash-reverse', 'همان، ولی برگشت اول قلم‌ها با «بدون انتخاب» و آخری نقدی', async (ctx) => {
  const a = V(ctx, 'A', 50_000), b = V(ctx, 'B', 50_000)
  const c = await issueManual(ctx, 60_000)
  const s = await sale(ctx, { items: [{ v: a }, { v: b }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 60_000 }], label: 'sale 100k = 60k barcode + 40k cash' })
  await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, a).id), qty: 1 }], method: 'STORE_CREDIT', expect: 'either', label: 'return A STORE_CREDIT' })
  await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, b).id), qty: 1 }], method: 'CASH', expect: 'either', label: 'return B CASH' })
})
await run('E-ex-paid-by-bc-then-cash-return', 'نقد ⇒ تعویض گران‌تر با پرداخت بارکد ⇒ برگشت سند تعویض نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 130_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const c = await issueManual(ctx, 30_000)
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c.code, label: 'exchange 100k→130k, diff by barcode' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return exchange invoice CASH' })
  resetCodeGate()
})
await run('E-ex-paid-by-bc-then-card-return', 'نقد ⇒ تعویض گران‌تر با بارکد ⇒ برگشت سند تعویض کارتی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 130_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CARD', label: 'sale 100k card' })
  const c = await issueManual(ctx, 30_000)
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c.code, label: 'exchange 100k→130k, diff by barcode' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CARD', expect: 'either', label: 'return exchange invoice CARD' })
  resetCodeGate()
})
await run('E-credit-spent-then-delete-return', 'برگشت با اعتبار ⇒ خرج اعتبار ⇒ ابطال همان برگشت', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  const v = V(ctx, 'I', 120_000)
  await sale(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 120_000 }], due: 0, label: 'spend the return credit' })
  await step(ctx, 'returnDelete after credit spent', 'refuse', () => salesService.returnDelete({ id: r.returnId, userId, reason: 'آزمون ابطال پس از مصرف', managerPassword: PW, panelPassword: PW }))
  await step(ctx, 'returnUpdate (change lines) after credit spent', 'refuse', () => salesService.returnUpdate({ id: r.returnId, lines: [{ saleItemId: n(itemFor(root.invoiceId, root.Y).id), qty: 1 }], userId, managerPassword: PW, panelPassword: PW, overrideReason: 'آزمون ویرایش پس از مصرف' }))
  const rv = await step(ctx, 'returnReconcileVoid CONSUMED without recovery', 'either', () => salesService.returnReconcileVoid({ id: r.returnId, userId, reason: 'آزمون اصلاح جبرانی', panelPassword: PW, creditOutcome: 'CONSUMED', cashRecovered: 0 }))
  ctx.notes.push('reconcile: ' + (rv.ok ? JSON.stringify(brief(rv.res)) : rv.error).slice(0, 300))
  resetCodeGate()
}, { allowLoss: true })
await run('E-credit-unspent-then-delete-return', 'برگشت با اعتبار ⇒ ابطال برگشت پیش از خرج ⇒ خرج اعتبار', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  await step(ctx, 'returnDelete before credit spent', 'either', () => salesService.returnDelete({ id: r.returnId, userId, reason: 'آزمون ابطال پیش از مصرف', managerPassword: PW, panelPassword: PW }))
  ctx.notes.push(`credit after delete: ${rawCredit(n(c.id)).status}`)
  const v = V(ctx, 'I', 120_000)
  await sale(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 120_000 }], due: 0, label: 'try to spend credit of the voided return', expect: 'refuse' })
  resetCodeGate()
})
await run('E-invoice-edit-bc', 'ویرایش فاکتورِ پرداخت‌شده با بارکد (حذف یک قلم)', async (ctx) => {
  const a = V(ctx, 'A', 60_000), b = V(ctx, 'B', 40_000)
  const c = await issueManual(ctx, 100_000)
  const s = await sale(ctx, { items: [{ v: a }, { v: b }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 100_000 }], due: 0, label: 'sale 100k by barcode' })
  await step(ctx, 'edit invoice: remove B (keepPayments)', 'either', () => salesService.update({ id: s.invoiceId, userId, shiftId: ctx.shiftId, lines: [lineOf(a)], payments: [], keepPayments: true }))
  const credPay = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND storeCreditId IS NOT NULL', s.invoiceId)
  if (credPay) {
    await step(ctx, 'delete the barcode payment row (needs the نسیه password)', 'either', () => salesService.deletePayment({ id: n(credPay.id), userId, managerPassword: PW, reason: 'آزمون حذف پرداخت اعتبار' }))
    await step(ctx, 'edit the barcode payment amount', 'refuse', () => salesService.updatePayment({ id: n(credPay.id), amount: 50_000, userId, managerPassword: PW, reason: 'آزمون ویرایش پرداخت اعتبار' }))
  }
  resetCodeGate()
}, { allowLoss: true })
await run('E-overpay-credit-then-cash', 'برگشت بی‌بازپرداخت ⇒ اضافه‌دریافت ⇒ صدور اعتبار ⇒ برگشت بعدی نقدی', async (ctx) => {
  const a = V(ctx, 'A', 50_000), b = V(ctx, 'B', 50_000)
  const s = await sale(ctx, { items: [{ v: a }, { v: b }], tender: 'CASH', label: 'sale 100k cash' })
  await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, a).id), qty: 1 }], method: 'DECLINED', expect: 'either', label: 'return A, customer declines refund' })
  const oc = await step(ctx, 'overpayCreditIssue (manager)', 'either', () => salesService.overpayCreditIssue({ invoiceId: s.invoiceId, userId, managerPassword: PW }))
  if (oc.ok) ctx.notes.push('overpay credit: ' + JSON.stringify(brief(oc.res)))
  await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, b).id), qty: 1 }], method: 'CASH', expect: 'either', label: 'return B CASH' })
  await step(ctx, 'overpayCreditIssue again', 'either', () => salesService.overpayCreditIssue({ invoiceId: s.invoiceId, userId, managerPassword: PW }))
  const newOver = seed.rows('SELECT id FROM "StoreCredit" WHERE id>? AND source=?', ctx.creditFloor, 'OVERPAY')
  for (const c of newOver) await certLifecycle(ctx, n(c.id), 'overpay credit (seller print?)', { reprint: false })
}, { allowLoss: true })
await run('E-return-credit-spent-sale-returned-cash', 'اعتبار برگشت ⇒ خرید تازه با آن ⇒ برگشت خرید تازه نقدی', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  const v = V(ctx, 'N', 120_000)
  const s2 = await sale(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 120_000 }], due: 0, label: 'new sale paid by return credit' })
  if (!s2.ok) return
  for (const m of ['CASH', 'CARD', 'CARD_TO_CARD']) {
    const rr = await ret(ctx, s2.invoiceId, { full: true, method: m, expect: 'either', label: `return new sale ${m}` })
    if (rr.ok) { ctx.notes.push(`${m}: refund=${n(rr.res.refundAmount)} method=${rr.res.refundMethod} restored=${n(rr.res.sourceCreditRestoredAmount)}`); break }
  }
  const succ = seed.rows('SELECT id,amount,source,returnId,status FROM "StoreCredit" WHERE id>? ORDER BY id', ctx.creditFloor)
  for (const x of succ.filter((x) => x.id > n(c.id))) await certLifecycle(ctx, n(x.id), 'successor credit (customer needs a paper?)', { reprint: false })
})
await run('E-unselected-ex-credit-spent-return-cash', 'تعویض منفی بی‌انتخاب ⇒ اعتبار ⇒ خرج ⇒ برگشت نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 70_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'UNSELECTED', expect: 'either', label: 'exchange 100k→70k UNSELECTED' })
  const c = e.credits?.[0]
  if (!c) return ctx.notes.push('no credit from UNSELECTED exchange')
  await certLifecycle(ctx, n(c.id), 'UNSELECTED exchange credit', { reprint: false })
  const N = V(ctx, 'N', 30_000)
  const s2 = await sale(ctx, { items: [{ v: N }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 30_000 }], due: 0, label: 'spend exchange credit' })
  if (s2.ok) await ret(ctx, s2.invoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return the credit-paid sale CASH' })
  resetCodeGate()
})
await run('E-c2c-cancel', 'برگشت کارت‌به‌کارت ⇒ مدیر لغو می‌کند ⇒ تلاش برای برگشت نقدی', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CARD_TO_CARD', payC2C: false })
  const req = seed.one('SELECT id FROM "CardTransferRequest" WHERE returnId=?', r.returnId ?? 0)
  if (!req) return
  const rc = await step(ctx, 'manager cancels C2C request', 'either', () => cardTransferService.cancel({ id: n(req.id), userId, managerPassword: PW, reason: 'آزمون لغو کارت‌به‌کارت' }))
  ctx.notes.push('cancel: ' + (rc.ok ? 'OK' : rc.error).slice(0, 200))
  await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CASH', expect: 'either', label: 'return X again CASH after C2C cancel' })
  await ret(ctx, root.invoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return rest CASH' })
}, { allowLoss: true })
await run('E-chain-neg-cash-then-return-cash', 'نقد ⇒ تعویض ارزان‌تر با بازپرداخت نقدی ⇒ برگشت سند تعویض نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 70_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', label: 'exchange 100k→70k CASH refund' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'ok', label: 'return exchange invoice CASH' })
})
await run('E-mixed-ex-up-cash-return-cash', 'بارکد+نقد ⇒ تعویض گران‌تر با نقد ⇒ برگشت سند تعویض نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 150_000)
  const c = await issueManual(ctx, 60_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 60_000 }], label: 'sale 100k = 60k barcode + 40k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'CASH', label: 'exchange 100k→150k +50k cash' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return exchange invoice CASH' })
  resetCodeGate()
})
await run('E-bc-tender-ex-on-bc-invoice-return-cash', 'فروش بارکدی ⇒ تعویض گران‌تر با بارکد دیگر ⇒ برگشت همه نقدی', async (ctx) => {
  const s = await bcOnlySale(ctx)
  const Z = V(ctx, 'Z', 140_000)
  const c2 = await issueManual(ctx, 40_000)
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, s.X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c2.code, label: 'exchange 100k→140k diff by barcode' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return exchange invoice CASH' })
  resetCodeGate()
})
await run('E-ex-partial-payout', 'تعویض منفی با پرداخت جزئی نقد (باقی اعتبار)', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 40_000)
  const s = await sale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', payout: 20_000, label: 'exchange 100k→40k, pay 20k cash, rest credit' })
  for (const c of e.credits ?? []) await certLifecycle(ctx, n(c.id), 'remainder credit of partial payout')
  await exch(ctx, s.invoiceId, { lines: [], repl: [{ v: V(ctx, 'Q', 10_000) }], refundMode: 'CASH', label: 'exchange with nothing returned', expect: 'refuse' })
})
await run('E-credit-as-ex-tender-other-invoice-void', 'اعتبار برگشت برای مابه‌التفاوت تعویض فاکتور دیگر ⇒ ابطال آن تعویض', async (ctx) => {
  const root = await rootSale(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  const X2 = V(ctx, 'X2', 100_000), Z = V(ctx, 'Z', 150_000)
  const s2 = await sale(ctx, { items: [{ v: X2 }], tender: 'CASH', label: 'another sale 100k cash' })
  const e = await exch(ctx, s2.invoiceId, { lines: [{ saleItemId: n(itemFor(s2.invoiceId, X2).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c.code, label: 'exchange 100k→150k diff 50k by return credit' })
  if (e.ok) {
    await step(ctx, 'returnDelete of that exchange', 'either', () => salesService.returnDelete({ id: e.returnId, userId, reason: 'آزمون ابطال تعویض', managerPassword: PW, panelPassword: PW }))
    ctx.notes.push(`credit after: status=${rawCredit(n(c.id)).status} used=${n(rawCredit(n(c.id)).usedAmount)}`)
  }
  resetCodeGate()
})

// =================================================================== part 2 (31 verification scenarios)
const SALE_TYPES_V2 = {
  T1: { title: 'نقد', tender: 'CASH', codes: [] },
  T3: { title: 'نقد+کارت', tender: 'SPLIT', codes: [] },
  T5: { title: 'فقط بارکد (۲ بارکد)', tender: 'NONE', codes: [120_000, 80_000] },
  T6L: { title: 'نقد+کارت + ۲ بارکد (دو ردیف پرداخت، بدون پرچم ترکیبی)', tender: 'LEGACY2', codes: [30_000, 40_000] }
}
async function sale2(ctx, o) { return sale(ctx, { ...o, receiptCheck: false }) }
async function rootSale2(ctx, typeKey, { xQty = 1 } = {}) {
  const T = SALE_TYPES_V2[typeKey]
  const X = V(ctx, 'X', 120_000), Y = V(ctx, 'Y', 80_000)
  const total = 120_000 * xQty + 80_000
  const codes = T.tender === 'NONE' ? [total - 80_000, 80_000] : T.codes
  const credits = []
  for (const a of codes) credits.push({ ...(await issueManual(ctx, a)), requestedAmount: a })
  const cover = codes.reduce((s, a) => s + a, 0)
  const s = await sale2(ctx, { items: [{ v: X, qty: xQty }, { v: Y }], tender: T.tender, credits, due: total - cover, label: `root sale [${T.title}] total ${total}` })
  if (!s.ok) throw new Error('root sale failed: ' + s.error)
  return { X, Y, invoiceId: s.invoiceId, credits }
}
async function chainExchange2(ctx, invoiceId, srcV, sign, k, label) {
  const price = srcV.price + (sign > 0 ? 30_000 : sign < 0 ? -30_000 : 0)
  const nv = V(ctx, `${srcV.label}x`, price)
  const item = itemFor(invoiceId, srcV)
  if (!item) throw new Error(`item ${srcV.label} not on invoice ${invoiceId}`)
  const pay = POS_PAY[k % POS_PAY.length]
  const code = sign > 0 && pay === 'BARCODE' ? (await issueManual(ctx, 30_000)).code : undefined
  let r = await exch(ctx, invoiceId, { lines: [{ saleItemId: n(item.id), qty: 1 }], repl: [{ v: nv }], pay, refundMode: NEG_MODE[k % NEG_MODE.length], code, label, expect: 'either' })
  if (!r.ok && /روش تسویه انتخاب نشده/.test(r.error ?? '')) {
    ctx.notes.push(`${label}: UNSELECTED refused (real money) → seller picks STORE_CREDIT`)
    r = await exch(ctx, invoiceId, { lines: [{ saleItemId: n(item.id), qty: 1 }], repl: [{ v: nv }], refundMode: 'STORE_CREDIT', label: label + ' (retry STORE_CREDIT)', expect: 'ok' })
  }
  resetCodeGate()
  return { r, nv }
}
const RMETHODS = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT']
let chainNoV2 = 0
async function chain(ctx, typeKey, kind, k) {
  const signs = SIGNS[k % SIGNS.length]
  const root = await rootSale2(ctx, typeKey, { xQty: kind === 'PRET-EX-RET' ? 2 : 1 })
  const issued = []
  const take = (r) => { if (r?.ok) for (const c of r.credits ?? []) issued.push({ id: n(c.id) }) }
  let inv = root.invoiceId, cur = root.X
  if (kind === 'EX-EX-EX' || kind === 'EX-EX-RET') {
    const s1 = await chainExchange2(ctx, inv, cur, signs[0], k, 'step1 exchange X on root'); take(s1.r); if (!s1.r.ok) return
    inv = s1.r.exchangeInvoiceId; cur = s1.nv
    const s2 = await chainExchange2(ctx, inv, cur, signs[1], k + 1, 'step2 exchange on exchange-invoice-1'); take(s2.r); if (!s2.r.ok) return
    inv = s2.r.exchangeInvoiceId; cur = s2.nv
    if (kind === 'EX-EX-EX') { const s3 = await chainExchange2(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-2'); take(s3.r) }
    else take(await ret(ctx, inv, { full: true, method: RMETHODS[k % 4], expect: 'ok', label: `step3 return of exchange-invoice-2 ${RMETHODS[k % 4]}` }))
  } else if (kind === 'RET-EX-EX') {
    take(await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.Y).id), qty: 1 }], method: RMETHODS[k % 4], expect: 'ok', label: `step1 return Y ${RMETHODS[k % 4]}` }))
    const s2 = await chainExchange2(ctx, inv, cur, signs[1], k + 1, 'step2 exchange X on root'); take(s2.r); if (!s2.r.ok) return
    inv = s2.r.exchangeInvoiceId; cur = s2.nv
    const s3 = await chainExchange2(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-1'); take(s3.r)
  } else {
    take(await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.X).id), qty: 1 }], method: RMETHODS[(k + 1) % 4], expect: 'ok', label: `step1 partial return 1 of 2 X ${RMETHODS[(k + 1) % 4]}` }))
    const s2 = await chainExchange2(ctx, inv, cur, signs[1], k + 1, 'step2 exchange the other X'); take(s2.r); if (!s2.r.ok) return
    inv = s2.r.exchangeInvoiceId; cur = s2.nv
    take(await ret(ctx, inv, { full: true, method: RMETHODS[(k + 2) % 4], expect: 'ok', label: `step3 return exchange-invoice-1 ${RMETHODS[(k + 2) % 4]}` }))
  }
  for (const [i, c] of issued.entries()) await certLifecycle(ctx, c.id, 'chain credit', { reprint: i % 2 === 0 })
  for (const c of issued) await spendTwice(ctx, c.id, `chain credit #${c.id}`)
}

await run('V1-split-bc', 'نقد+کارت+بارکد: محمولهٔ صندوق، با allowPartial، و دو ردیف بی‌پرچم', async (ctx) => {
  const v = V(ctx, 'I', 100_000)
  const c1 = await issueManual(ctx, 30_000), c2 = await issueManual(ctx, 30_000), c3 = await issueManual(ctx, 30_000)
  const a = await sale2(ctx, { items: [{ v }], tender: 'SPLIT', credits: [{ code: c1.code, requestedAmount: 30_000 }], label: 'POS payload: barcode 30k + cash 35k + card 35k (splitPayment)', expect: 'either' })
  ctx.notes.push('POS payload: ' + (a.ok ? 'ACCEPTED' : a.error))
  resetCodeGate()
  const b = await sale2(ctx, { items: [{ v }], tender: 'SPLIT', credits: [{ code: c2.code, requestedAmount: 30_000 }], extra: { allowPartial: true }, label: 'same + allowPartial:true', expect: 'either' })
  if (b.ok) { const inv = seed.one('SELECT grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?', b.invoiceId); ctx.notes.push(`allowPartial: ACCEPTED grand=${n(inv.grandTotal)} paid=${n(inv.paidTotal)} credit used=${n(rawCredit(c2.id).usedAmount)}`) }
  else ctx.notes.push('allowPartial: ' + b.error)
  resetCodeGate()
  const c = await sale2(ctx, { items: [{ v }], tender: 'LEGACY2', credits: [{ code: c3.code, requestedAmount: 30_000 }], label: 'two payment rows without splitPayment flag', expect: 'either' })
  ctx.notes.push('legacy two rows: ' + (c.ok ? 'ACCEPTED' : c.error))
  resetCodeGate()
})
await run('V1-split-nobc-control', 'نقد+کارت بدون بارکد (کنترل)', async (ctx) => {
  const v = V(ctx, 'I', 100_000)
  await sale2(ctx, { items: [{ v }], tender: 'SPLIT', label: 'split 50k+50k, no barcode' })
})
await run('V2-exchange-bc-plus-split', 'تعویض گران‌تر: مابه‌التفاوت با بارکد + نقد + کارت', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 150_000)
  const s = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const c = await issueManual(ctx, 20_000)
  const replacements = [lineOf(Z)]
  const lines = [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }]
  const p = await salesService.previewExchangeFunding({ invoiceId: s.invoiceId, lines, replacements })
  const diff = n(p.effectiveDiff)
  const input = { userId, shiftId: ctx.shiftId, invoiceId: s.invoiceId, lines, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `aud2-exs-${++keySeq}`,
    exchangeCreditCode: c.code, idempotencyKey: `aud2-exsc-${keySeq}`, splitPayment: true,
    payments: [{ methodId: cashM, amount: 15_000, destination: 'CASH' }, { methodId: cardM, amount: diff - 20_000 - 15_000, destination: 'CARD' }] }
  const r = await step(ctx, `exchange +${diff}: barcode 20k + cash 15k + card ${diff - 35_000}`, 'either', () => salesService.createExchange(input))
  ctx.notes.push('exchange barcode+split: ' + (r.ok ? JSON.stringify(brief(r.res)) : r.error))
  if (r.ok) {
    const again = await step(ctx, 'same request key again (retry)', 'either', () => salesService.createExchange(input))
    ctx.notes.push('replay: ' + (again.ok ? `returnId ${again.res.returnId} (first ${r.res.returnId})` : again.error))
    ctx.notes.push(`credit used=${n(rawCredit(c.id).usedAmount)} redemptions=${seed.count('StoreCreditRedemption', 'creditId=?', c.id)}`)
  }
  resetCodeGate()
})
await run('V3-code-gate-pos-flow', 'قفل ورود کد با روند واقعی صندوق (بررسی + ثبت)', async (ctx) => {
  resetCodeGate()
  const U = await issueManual(ctx, 20_000), E = await issueManual(ctx, 25_000), G = await issueManual(ctx, 30_000)
  sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() - 86_400_000, E.id)
  const v0 = V(ctx, 'I0', 20_000)
  await sale2(ctx, { items: [{ v: v0 }], tender: 'NONE', credits: [{ code: U.code, requestedAmount: 20_000 }], due: 0, label: 'customer 1 spends barcode U (ok)' })
  const look = async (code, label, expect) => {
    const r = await step(ctx, label, expect, () => storeCreditService.lookup({ code, userId }))
    ctx.notes.push(`${label}: ${r.ok ? 'OK' : r.error.split('\n').slice(-1)[0].slice(0, 160)}`)
    return r
  }
  const v1 = V(ctx, 'I1', 50_000)
  await look(U.code, 'customer 2: cashier presses «بررسی» on used barcode U', 'refuse')
  const s2 = await sale2(ctx, { items: [{ v: v1 }], tender: 'CASH', credits: [{ code: U.code, requestedAmount: null }], due: 50_000, label: 'customer 2: sale saved with U still in the field, full cash', expect: 'either' })
  ctx.notes.push('customer 2 sale: ' + (s2.ok ? 'ACCEPTED outcomes=' + JSON.stringify(s2.res.storeCreditOutcomes.map((o) => o.status + ':' + o.message.split('\n').slice(-1)[0].slice(0, 120))) : s2.error))
  await look(E.code, 'customer 3: «بررسی» on expired barcode E', 'refuse')
  await look(G.code, 'customer 4: «بررسی» on GOOD barcode G', 'ok')
  const v4 = V(ctx, 'I4', 60_000)
  const s4 = await sale2(ctx, { items: [{ v: v4 }], tender: 'CASH', credits: [{ code: G.code, requestedAmount: 30_000 }], label: 'customer 4: pay 30k with G + 30k cash', expect: 'ok' })
  ctx.notes.push('customer 4 sale: ' + (s4.ok ? 'OK' : s4.error))
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 130_000)
  const s5 = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', label: 'customer 5: cash sale (sales still work)' })
  const e5 = await exch(ctx, s5.invoiceId, { lines: [{ saleItemId: n(itemFor(s5.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: G.code, label: 'customer 5: exchange +30k paid with GOOD barcode G (service call)', expect: 'either' })
  ctx.notes.push('exchange with G: ' + (e5.ok ? 'OK' : e5.error))
  resetCodeGate()
}, { allowLoss: true })
await run('V3b-code-gate-success-resets', 'شمارنده با یک بارکد درست صفر می‌شود؟', async (ctx) => {
  resetCodeGate()
  const U = await issueManual(ctx, 20_000), G = await issueManual(ctx, 30_000)
  const v0 = V(ctx, 'I0', 20_000)
  await sale2(ctx, { items: [{ v: v0 }], tender: 'NONE', credits: [{ code: U.code, requestedAmount: 20_000 }], due: 0, label: 'spend U' })
  for (let i = 1; i <= 2; i++) await step(ctx, `lookup used U #${i}`, 'refuse', () => storeCreditService.lookup({ code: U.code, userId }))
  await step(ctx, 'lookup good G (resets?)', 'ok', () => storeCreditService.lookup({ code: G.code, userId }))
  for (let i = 3; i <= 4; i++) await step(ctx, `lookup used U #${i}`, 'refuse', () => storeCreditService.lookup({ code: U.code, userId }))
  const r = await step(ctx, 'lookup good G again', 'ok', () => storeCreditService.lookup({ code: G.code, userId }))
  ctx.notes.push('after success in between: ' + (r.ok ? 'not locked' : r.error.slice(0, 120)))
  resetCodeGate()
})
async function reconcileCase(ctx, locks, password) {
  seed.setting(SETTING_KEYS.panelLocks, { ...DEFAULT_LOCKS, ...locks })
  try {
    const root = await rootSale2(ctx, 'T1')
    const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
    const c = r.credits?.[0]
    const v = V(ctx, 'N', 120_000)
    await sale2(ctx, { items: [{ v }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 120_000 }], due: 0, label: 'spend the 120k return credit on new goods' })
    const rv = await step(ctx, `returnReconcileVoid CONSUMED, cashRecovered 0, password=${password ? 'yes' : 'NONE'}`, 'either',
      () => salesService.returnReconcileVoid({ id: r.returnId, userId, reason: 'مشتری کالا را پس گرفت', ...(password ? { panelPassword: password } : {}), creditOutcome: 'CONSUMED', cashRecovered: 0 }))
    ctx.notes.push('reconcile: ' + (rv.ok ? 'ACCEPTED' : rv.error.slice(0, 200)))
    if (rv.ok) {
      const corr = seed.one('SELECT unrecoveredAmount, creditOutcome, creditAffectedAmount, approvingManagerId FROM "ReturnCorrection" WHERE returnId=?', r.returnId)
      ctx.notes.push('correction row: ' + JSON.stringify(corr))
    }
  } finally {
    seed.setting(SETTING_KEYS.panelLocks, DEFAULT_LOCKS)
  }
}
await run('V4a-reconcile-default-locks-nopass', 'ابطال جبرانی پس از خرج اعتبار، قفل‌ها پیش‌فرض، بی رمز', (ctx) => reconcileCase(ctx, {}, null), { allowLoss: true })
await run('V4b-reconcile-correction-lock-off', 'ابطال جبرانی پس از خرج اعتبار، قفل «اصلاح برگشت» خاموش، بی رمز', (ctx) => reconcileCase(ctx, { [PANEL_KEYS.salesReturnCorrection]: false }, null), { allowLoss: true })
await run('V4c-reconcile-both-locks-off', 'ابطال جبرانی پس از خرج اعتبار، قفل «اصلاح برگشت» و «برگشت» خاموش، بی رمز', (ctx) => reconcileCase(ctx, { [PANEL_KEYS.salesReturnCorrection]: false, [PANEL_KEYS.salesReturn]: false }, null), { allowLoss: true })
await run('V4d-returnUpdate-correction-lock-off', 'ویرایش برگشتِ دارای اعتبار، قفل «اصلاح برگشت» خاموش، بی رمز', async (ctx) => {
  seed.setting(SETTING_KEYS.panelLocks, { ...DEFAULT_LOCKS, [PANEL_KEYS.salesReturnCorrection]: false })
  try {
    const X = V(ctx, 'X', 50_000)
    const s = await sale2(ctx, { items: [{ v: X, qty: 3 }], tender: 'CASH', label: 'sale 3×50k cash' })
    const r = await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], method: 'STORE_CREDIT' })
    const up = await step(ctx, 'returnUpdate qty 1→2 without password (more credit?)', 'either', () => salesService.returnUpdate({ id: r.returnId, lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 2 }], userId, overrideReason: 'آزمون افزایش' }))
    ctx.notes.push('update: ' + (up.ok ? JSON.stringify(brief(up.res)) : up.error.slice(0, 200)))
  } finally {
    seed.setting(SETTING_KEYS.panelLocks, DEFAULT_LOCKS)
  }
}, { allowLoss: true })
await run('V5-c2c-cancel-then-void', 'کارت‌به‌کارت لغو شد ⇒ ابطال سند برگشت (بستن پرونده)', async (ctx) => {
  const root = await rootSale2(ctx, 'T1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CARD_TO_CARD', payC2C: false })
  const req = seed.one('SELECT id FROM "CardTransferRequest" WHERE returnId=?', r.returnId)
  await step(ctx, 'manager cancels C2C (goods stay pending)', 'ok', () => cardTransferService.cancel({ id: n(req.id), reason: 'مشتری منصرف شد', managerPassword: PW, userId }))
  const d = await step(ctx, 'returnDelete to close the case', 'ok', () => salesService.returnDelete({ id: r.returnId, userId, reason: 'لغو کارت‌به‌کارت', managerPassword: PW, panelPassword: PW }))
  ctx.notes.push('delete: ' + (d.ok ? 'OK' : d.error))
  await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CASH', label: 'new return of X by CASH after closing the case' })
}, { allowLoss: true })
for (const m of ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']) {
  await run(`V6-B-T6L-${m}`, `برگشت از فاکتور نقد+کارت+۲بارکد: جزئی ${m} سپس بقیه`, async (ctx) => {
    const root = await rootSale2(ctx, 'T6L')
    const r1 = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: m, expect: 'either', label: `partial return X ${m}` })
    if (!r1.ok && m === 'UNSELECTED') await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CASH', label: 'seller then picks CASH' })
    const m2 = m === 'CASH' ? 'CARD' : 'CASH'
    const r2 = await ret(ctx, root.invoiceId, { full: true, method: m2, label: `return rest ${m2}` })
    for (const r of [r1, r2]) if (r.ok) for (const c of r.credits ?? []) { await certLifecycle(ctx, n(c.id), 'credit'); await spendTwice(ctx, n(c.id), `credit #${c.id}`) }
  }, { allowLoss: m === 'DECLINED' })
}
for (const kind of ['EX-EX-EX', 'EX-EX-RET', 'RET-EX-EX', 'PRET-EX-RET']) {
  const k = chainNoV2++
  await run(`V6-C-T6L-${kind}`, `زنجیره ${kind} از فاکتور نقد+کارت+۲بارکد`, (ctx) => chain(ctx, 'T6L', kind, k))
}
for (const [typeKey, kind, k] of [['T1', 'PRET-EX-RET', 3], ['T3', 'EX-EX-EX', 8], ['T3', 'EX-EX-RET', 9], ['T5', 'PRET-EX-RET', 19], ['T1', 'EX-EX-EX', 4], ['T5', 'RET-EX-EX', 14]]) {
  await run(`V7-C-${typeKey}-${kind}`, `زنجیره ${kind} از [${SALE_TYPES_V2[typeKey].title}] با انتخاب روش توسط فروشنده`, (ctx) => chain(ctx, typeKey, kind, k))
}
await run('V8-payout-above-real-money', 'تعویض ارزان‌تر روی فاکتور مختلط با درخواست نقد بیش از پول واقعی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 20_000)
  const c = await issueManual(ctx, 60_000)
  const s = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 60_000 }], label: 'sale 100k = 60k barcode + 40k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', payout: 80_000, label: 'exchange 100k→20k asking 80k cash', expect: 'either' })
  if (!e.ok) await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', label: 'same, amount left blank', expect: 'ok' })
  resetCodeGate()
})
await run('V8b-return-amount-above-safe', 'برگشت نقدی با مبلغ تایپ‌شده بیش از حق امن', async (ctx) => {
  const X = V(ctx, 'X', 100_000)
  const c = await issueManual(ctx, 60_000)
  const s = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', credits: [{ code: c.code, requestedAmount: 60_000 }], label: 'sale 100k = 60k barcode + 40k cash' })
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', amount: 100_000, expect: 'refuse', label: 'return asking 100k cash' })
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', amount: 30_000, expect: 'refuse', label: 'return asking 30k (less than safe 40k)' })
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', label: 'return, amount blank (= safe)' })
  resetCodeGate()
})
await run('V10-card-refund-wrong-password', 'بازپرداخت کارت‌خوان با رمز غلط', async (ctx) => {
  const X = V(ctx, 'X', 100_000)
  const s = await sale2(ctx, { items: [{ v: X }], tender: 'CARD', label: 'sale 100k card' })
  const input = returnInput(ctx, s.invoiceId, { full: true, method: 'CARD' })
  input.cardPosOverride = { managerPassword: 'غلط-۱۲۳', reason: 'آزمون', acknowledgedNoReverse: true }
  await step(ctx, 'return CARD with wrong manager password', 'refuse', () => salesService.createReturn(input))
  const inp2 = returnInput(ctx, s.invoiceId, { full: true, method: 'CARD' }); delete inp2.cardPosOverride
  await step(ctx, 'return CARD without override', 'refuse', () => salesService.createReturn(inp2))
  sql.prepare('DELETE FROM "AuthLockout"').run()
})
await run('V12-bc-tender-twice', 'یک بارکد برای مابه‌التفاوت دو تعویض', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  for (let i = 1; i <= 2; i++) {
    const X = V(ctx, `X${i}`, 100_000), Z = V(ctx, `Z${i}`, 130_000)
    const s = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', label: `sale ${i} 100k cash` })
    await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c.code, label: `exchange ${i} +30k with the same barcode`, expect: i === 1 ? 'ok' : 'refuse' })
  }
  resetCodeGate()
})
await run('V15-exchange-replay', 'تکرار ثبت تعویض با همان کلید (دوبار کلیک)', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 60_000)
  const s = await sale2(ctx, { items: [{ v: X }], tender: 'CASH', label: 'sale 100k cash' })
  const lines = [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], replacements = [lineOf(Z)]
  const p = await salesService.previewExchangeFunding({ invoiceId: s.invoiceId, lines, replacements })
  const input = { userId, shiftId: ctx.shiftId, invoiceId: s.invoiceId, lines, replacements, expectedSettlementDiff: n(p.effectiveDiff), exchangeSettlementDecision: 'METHOD', refundMode: 'STORE_CREDIT', requestIdempotencyKey: `aud2-rep-${++keySeq}` }
  await step(ctx, 'exchange 100k→60k STORE_CREDIT', 'ok', () => salesService.createExchange(input))
  await step(ctx, 'same key again', 'either', () => salesService.createExchange(input))
  ctx.notes.push(`credits issued=${seed.count('StoreCredit', 'id>?', ctx.creditFloor)}`)
})

// =================================================================== summary, snapshot, compare
const byType = new Map()
for (const f of allFindings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1)
const summary = {
  scenarios: scenarios.length,
  steps: scenarios.reduce((s, x) => s + x.steps.length, 0),
  refusals: scenarios.reduce((s, x) => s + x.refusals.length, 0),
  certificates: scenarios.reduce((s, x) => s + x.certs.length, 0),
  scenariosWithFindings: scenarios.filter((x) => x.findings.length).length,
  findingTypes: Object.fromEntries(byType)
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, scenarios }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))

// Normalised result: no barcode/return codes, no ids, no dates or times — only behaviour and amounts.
const secretCodes = [
  ...seed.rows('SELECT code FROM "StoreCredit"').map((r) => String(r.code)),
  ...seed.rows('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').map((r) => String(r.returnCode))
].filter((c) => c.length >= 4).sort((a, b) => b.length - a.length)
const normText = (t) => {
  let s = String(t ?? '').split('\n')[0]
  for (const c of secretCodes) if (s.includes(c)) s = s.split(c).join('«کد»')
  return s.replace(/[0-9۰-۹][0-9۰-۹٬,\/:.]*/g, '#').slice(0, 180)
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
const okOrRefused = (v) => (v == null ? null : v === 'OK' ? 'OK' : 'REFUSED: ' + normText(String(v).replace(/^REFUSED: ?/, '')))
const snapshot = scenarios.map((s) => ({
  id: s.id,
  steps: s.steps.map((st) => [normText(st.label), st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? normBrief(st.brief) : normText(st.msg)]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${normText(f.label)}`))].sort(),
  certs: s.certs.map((c) => ({ label: normText(c.label), source: c.source, delivery: c.delivery, firstPrint: okOrRefused(c.firstPrint), secondFirstPrint: c.secondFirstPrint ?? null,
    sellerReprint1: okOrRefused(c.sellerReprint1), sellerReprint2: c.sellerReprint2 ?? null, certHasCode: c.certHasCode ?? null, printCount: c.printCount })),
  value: s.value
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/sales-barcode-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
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
    for (const key of ['findings', 'certs', 'value']) {
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
