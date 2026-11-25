/**
 * آزمون سناریوهای «فاکتور فروش عمده» با بارکد اعتبار، برگشت، تعویض و زنجیره — همتای عمدهٔ
 * `docs/audit/sales-barcode-scenarios.mjs` (فروش تکی). خواستهٔ مالک (۲۰۲۶-۱۱-۲۵): رفتار عمده مثل فروش تکی،
 * با این فرق که در عمده بیش از یک بارکد اعتبار زده نمی‌شود.
 *
 * فاکتور عمده درست به شکلی فرستاده می‌شود که صفحهٔ «فاکتور فروش عمده» (`SalesInvoice.tsx`) می‌فرستد: یک کادر
 * بارکد با بررسی خودکار، یک ردیف پرداخت بی مقصد، «مبلغ دریافتی» = قابل پرداخت − مبلغ بارکد، تخفیف درصدی روی
 * ردیف‌ها و بی کلید تکرار. برگشت و تعویض همان صفحهٔ مشترک «برگشت از فروش» است.
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت و چاپگر شبیه‌سازی‌شده؛ به برنامه، پایگاه واقعی یا آزمون‌های مخزن دست
 * نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/wholesale-barcode-scenarios.mjs
 *   ... --out <file.json>     نتیجهٔ فشرده (بی کد بارکد، بی شناسه، بی تاریخ)
 *   ... --compare docs/audit/wholesale-barcode-scenarios-2026-11-25.json   مقایسه با نتیجهٔ ثبت‌شده (خروج ۱ اگر تفاوت باشد)
 *   AUD_ONLY=<regex>  AUD_VERBOSE=1
 * هفت سنجش پس از هر عملیات همان ابزار فروش تکی است.
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
const dir = mkdtempSync(join(tmpdir(), 'wholesale-barcode-scenarios-'))
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

// =================================================================== wholesale helpers
/**
 * فاکتور عمده درست مثل صفحهٔ «فاکتور فروش عمده» (`SalesInvoice.tsx`) فرستاده می‌شود:
 *  - orderType = WHOLESALE، تاریخ فاکتور، کسر/بی‌کسر موجودی، تخفیف درصدی روی هر ردیف (قیمت لیست + تخفیف)؛
 *  - فقط یک کادر بارکد (`storeCreditCode`، بی مبلغ دلخواه) که صفحه پیش از ثبت خودکار «بررسی» می‌کند؛
 *  - یک ردیف پرداخت بی مقصد (روش نقد یا کارت) با «مبلغ دریافتی» = قابل پرداخت − min(مبلغ بارکد از بررسی، قابل پرداخت)؛
 *  - بی کلید تکرار درخواست.
 * «نقد + کارت» در صفحهٔ عمده امروز نیست (۴-۵۶)؛ جاهایی که آمده، همان محمولهٔ سمت سرور است که ۴-۵۶ خواهد فرستاد.
 */
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
/** spend once in a wholesale invoice (must work), spend again in another wholesale invoice (must fail) */
async function spendTwiceW(ctx, creditId, label) {
  const c = rawCredit(creditId)
  const bal = n(c.amount) - n(c.usedAmount)
  if (bal <= 0 || !['ACTIVE', 'PARTIALLY_USED'].includes(c.status)) { ctx.notes.push(`${label}: credit #${creditId} not spendable (status ${c.status}, balance ${bal})`); return }
  resetCodeGate()
  const v = V(ctx, `wspend-${creditId}`, bal + 10_000)
  const s1 = await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, label: `${label}: spend credit #${creditId} (${bal}) once in a wholesale invoice` })
  if (s1.ok && n(s1.res.storeCreditApplied) !== bal) finding(ctx, 'SPEND_APPLIED_MISMATCH', label, { creditId, bal, applied: n(s1.res.storeCreditApplied) })
  const v2 = V(ctx, `wspend2-${creditId}`, bal + 10_000)
  await wsale(ctx, { items: [{ v: v2 }], tender: 'CASH', code: c.code, paid: 10_000, lookup: false, label: `${label}: spend credit #${creditId} AGAIN in a wholesale invoice`, expect: 'refuse' })
  resetCodeGate()
}
const W_TYPES = {
  W1: { title: 'عمده نقد', tender: 'CASH', code: 0 },
  W2: { title: 'عمده کارت', tender: 'CARD', code: 0 },
  W4: { title: 'عمده نقد + ۱ بارکد', tender: 'CASH', code: 50_000 },
  W5: { title: 'عمده فقط بارکد', tender: 'CASH', code: 'ALL' },
  W6: { title: 'عمده کارت + ۱ بارکد', tender: 'CARD', code: 70_000 },
  W7: { title: 'عمده ۱۰٪ تخفیف + ۱ بارکد + نقد', tender: 'CASH', code: 30_000, percent: 10 }
}
async function rootW(ctx, typeKey, { xQty = 1 } = {}) {
  const T = W_TYPES[typeKey]
  const X = V(ctx, 'X', 120_000), Y = V(ctx, 'Y', 80_000)
  const items = [{ v: X, qty: xQty }, { v: Y }]
  const payable = payableOf(wLines(items, T.percent ?? 0))
  let code = null
  if (T.code) code = (await issueManual(ctx, T.code === 'ALL' ? payable : T.code)).code
  const s = await wsale(ctx, { items, tender: T.tender, code, percent: T.percent ?? 0, label: `root wholesale [${T.title}] payable ${payable}` })
  if (!s.ok) throw new Error('root wholesale sale failed: ' + s.error)
  return { X, Y, invoiceId: s.invoiceId }
}

// =================================================================== A) wholesale sales
for (const items of [1, 3]) for (const tender of ['CASH', 'CARD']) for (const codes of [0, 1]) {
  await run(`WA-${items}i-${tender}-${codes}bc`, `عمده ${items} قلمی، ${tender}، ${codes} بارکد`, async (ctx) => {
    const vs = Array.from({ length: items }, (_, i) => V(ctx, `I${i + 1}`, [90_000, 150_000, 60_000][i]))
    const c = codes ? await issueManual(ctx, 35_000) : null
    const s = await wsale(ctx, { items: vs.map((v) => ({ v })), tender, code: c?.code })
    if (s.ok && c) {
      const v2 = V(ctx, 'again', 50_000)
      await wsale(ctx, { items: [{ v: v2 }], tender: 'CASH', code: c.code, paid: 15_000, lookup: false, label: 'spend used barcode again (wholesale)', expect: 'refuse' })
      resetCodeGate()
    }
  })
}
for (const items of [1, 3]) {
  await run(`WA-${items}i-ONLYBC`, `عمده ${items} قلمی فقط با ۱ بارکد`, async (ctx) => {
    const vs = Array.from({ length: items }, (_, i) => V(ctx, `I${i + 1}`, [40_000, 30_000, 20_000][i]))
    const c = await issueManual(ctx, vs.reduce((s, v) => s + v.price, 0))
    await wsale(ctx, { items: vs.map((v) => ({ v })), tender: 'CASH', code: c.code })
  })
}
for (const items of [1, 3]) for (const codes of [0, 1]) {
  await run(`WA-${items}i-SPLIT-${codes}bc`, `عمده ${items} قلمی، نقد+کارت (محمولهٔ آیندهٔ ۴-۵۶)، ${codes} بارکد`, async (ctx) => {
    const vs = Array.from({ length: items }, (_, i) => V(ctx, `I${i + 1}`, [90_000, 150_000, 60_000][i]))
    const c = codes ? await issueManual(ctx, 30_000) : null
    await wsale(ctx, { items: vs.map((v) => ({ v })), tender: 'SPLIT', code: c?.code, expect: 'either', label: `wholesale ${items} item(s) cash+card${codes ? ' + 1 barcode' : ''} (server payload of ۴-۵۶)` })
    resetCodeGate()
  })
}
await run('WA-2bc-array', 'عمده با ۲ بارکد (باید رد شود)', async (ctx) => {
  const v = V(ctx, 'I', 100_000)
  const c1 = await issueManual(ctx, 20_000), c2 = await issueManual(ctx, 20_000)
  await step(ctx, 'wholesale with two barcodes (array)', 'refuse', () => salesService.create({
    orderType: 'WHOLESALE', issuedAtJalali: today, deductInventory: true, lines: wLines([{ v }]), userId, shiftId: ctx.shiftId,
    storeCredits: [{ code: c1.code, requestedAmount: null }, { code: c2.code, requestedAmount: null }], payments: [{ methodId: cashM, amount: 60_000 }]
  }))
  await step(ctx, 'wholesale with legacy code + array', 'refuse', () => salesService.create({
    orderType: 'WHOLESALE', issuedAtJalali: today, deductInventory: true, lines: wLines([{ v }]), userId, shiftId: ctx.shiftId,
    storeCreditCode: c1.code, storeCredits: [{ code: c2.code, requestedAmount: null }], payments: [{ methodId: cashM, amount: 60_000 }]
  }))
  ctx.notes.push(`credits untouched: ${n(rawCredit(c1.id).usedAmount)}/${n(rawCredit(c2.id).usedAmount)}`)
})
await run('WA-partially-used-barcode', 'بارکدِ بخشی‌خرج‌شده در عمده: فرمول صفحه با «مبلغ کل» بارکد', async (ctx) => {
  const c = await issueManual(ctx, 100_000)
  const p = V(ctx, 'P', 60_000)
  await sale(ctx, { items: [{ v: p }], tender: 'NONE', credits: [{ code: c.code, requestedAmount: 60_000 }], due: 0, label: 'POS: spend 60k of the 100k barcode (40k left)' })
  const w = V(ctx, 'W', 100_000)
  const r1 = await wsale(ctx, { items: [{ v: w }], tender: 'CASH', code: c.code, expect: 'either', label: 'wholesale 100k with the 40k-left barcode (page computes paid from the full 100k)' })
  ctx.notes.push(`page: barcode shown as ${r1.uiCreditApplied ?? 'n/a'} → paid ${r1.paid ?? 'n/a'}; server: ${r1.ok ? 'ACCEPTED' : r1.error}`)
  const w2 = V(ctx, 'W2', 100_000)
  const r2 = await wsale(ctx, { items: [{ v: w2 }], tender: 'CASH', code: c.code, paid: 60_000, lookup: false, label: 'same with paid = 60k (the real remaining 40k)', expect: 'ok' })
  if (r2.ok) ctx.notes.push(`with correct paid: barcode applied ${n(r2.res.storeCreditApplied)}`)
  resetCodeGate()
})
await run('WA-paid-full-plus-barcode', 'عمده: «مبلغ دریافتی» دستی کامل + بارکد', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const r = await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, paid: 100_000, expect: 'either', label: 'wholesale 100k: barcode 30k + cashier typed paid 100k' })
  if (r.ok) ctx.notes.push(`barcode applied ${n(r.res.storeCreditApplied)}; outcomes ${JSON.stringify((r.res.storeCreditOutcomes ?? []).map((o) => o.status))}; barcode status ${rawCredit(c.id).status}`)
  resetCodeGate()
})
await run('WA-partial-typing-lock', 'عمده: بررسی خودکار کدِ نیمه‌تایپ‌شده و قفل ۱۰ دقیقه‌ای', async (ctx) => {
  resetCodeGate()
  const c = await issueManual(ctx, 30_000)
  for (const part of [c.code.slice(0, 3), c.code.slice(0, 5), c.code.slice(0, 7)])
    await step(ctx, `page auto-check while typing (${part.length} of ${c.code.length} characters)`, 'refuse', () => storeCreditService.lookup({ code: part, userId }))
  const full = await step(ctx, 'page auto-check of the FULL correct code', 'ok', () => storeCreditService.lookup({ code: c.code, userId }))
  ctx.notes.push('full code after typing pauses: ' + (full.ok ? 'OK' : full.error.split('\n')[0]))
  const v = V(ctx, 'I', 100_000)
  await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, paid: 70_000, lookup: false, label: 'wholesale with that correct barcode during the lock', expect: 'ok' })
  resetCodeGate()
})
await run('WA-expired-void', 'عمده: بارکد منقضی و باطل', async (ctx) => {
  const e = await issueManual(ctx, 30_000), x = await issueManual(ctx, 30_000)
  sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() - 86_400_000, e.id)
  await storeCreditService.void({ id: x.id, reason: 'آزمون ابطال', managerPassword: PW, userId })
  const v = V(ctx, 'I', 100_000)
  await wsale(ctx, { items: [{ v }], tender: 'CASH', code: e.code, expect: 'either', label: 'wholesale with expired barcode (page check refuses it, paid = full)' })
  resetCodeGate()
  const v2 = V(ctx, 'I2', 100_000)
  await wsale(ctx, { items: [{ v: v2 }], tender: 'CASH', code: x.code, expect: 'either', label: 'wholesale with void barcode (page check refuses it, paid = full)' })
  resetCodeGate()
}, { allowLoss: true })
await run('WA-race-retry', 'عمده: دو صندوق با یک بارکد و تکرار همان ثبت', async (ctx) => {
  const c = await issueManual(ctx, 40_000)
  const v1 = V(ctx, 'I1', 60_000), v2 = V(ctx, 'I2', 60_000)
  const a = await wsale(ctx, { items: [{ v: v1 }], tender: 'CASH', code: c.code, label: 'window A saves with the barcode' })
  const b = await wsale(ctx, { items: [{ v: v2 }], tender: 'CASH', code: c.code, paid: 20_000, lookup: false, label: 'window B (checked earlier) saves with the same barcode', expect: 'refuse' })
  ctx.notes.push('B: ' + (b.error ?? 'ACCEPTED').slice(0, 200))
  const again = await wsale(ctx, { items: [{ v: v1 }], tender: 'CASH', code: c.code, paid: 20_000, lookup: false, label: 'window A presses save again (no request key in wholesale)', expect: 'refuse' })
  ctx.notes.push(`retry: ${again.ok ? 'ACCEPTED (second invoice!)' : 'refused'}; redemptions=${seed.count('StoreCreditRedemption', 'creditId=?', c.id)}`)
  resetCodeGate()
})
await run('WA-credit-gt-total', 'عمده: بارکد بزرگ‌تر از فاکتور (مانده روی همان بارکد)', async (ctx) => {
  const c = await issueManual(ctx, 150_000)
  const v = V(ctx, 'I', 100_000), v2 = V(ctx, 'I2', 50_000)
  const r = await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, label: 'wholesale 100k with a 150k barcode' })
  ctx.notes.push(`after: status=${rawCredit(c.id).status} used=${n(rawCredit(c.id).usedAmount)}; remainder reference returned: ${r.ok ? JSON.stringify(r.res.storeCreditRemainder ?? null) : 'n/a'}`)
  await wsale(ctx, { items: [{ v: v2 }], tender: 'CASH', code: c.code, label: 'spend the 50k left on the same barcode' })
  ctx.notes.push(`after 2: status=${rawCredit(c.id).status}`)
  resetCodeGate()
})
await run('WA-backdated', 'عمده با تاریخ دیروز + بارکد', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const y = toJalaliDate(new Date(Date.now() - 86_400_000))
  await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, issuedAtJalali: y, expect: 'either', label: `wholesale dated yesterday (${y}) with a barcode issued today` })
  resetCodeGate()
})
await run('WA-no-deduct', 'عمده «بدون کسر از موجودی» + بارکد، بعد برگشت', async (ctx) => {
  const c = await issueManual(ctx, 50_000)
  const X = V(ctx, 'X', 120_000), Y = V(ctx, 'Y', 80_000)
  const s = await wsale(ctx, { items: [{ v: X }, { v: Y }], tender: 'CASH', code: c.code, deduct: false, label: 'wholesale without stock deduction, barcode 50k + cash' })
  if (!s.ok) return
  const r = await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], method: 'CASH', expect: 'either', label: 'return X CASH (no restock expected)' })
  for (const cr of r.credits ?? []) { await certLifecycle(ctx, n(cr.id), 'credit from no-deduct return'); await spendTwiceW(ctx, n(cr.id), `credit #${cr.id}`) }
})
await run('WA-returncode-lookup', 'کد برگشت فاکتور عمده با بارکد', async (ctx) => {
  const c = await issueManual(ctx, 30_000)
  const v = V(ctx, 'I', 100_000)
  const s = await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, label: 'wholesale with barcode' })
  if (!s.ok) return
  const code = seed.one('SELECT returnCode FROM "SaleInvoice" WHERE id=?', s.invoiceId)?.returnCode
  ctx.notes.push(`return code issued: ${code ? 'yes' : 'NO'}`)
  if (code) await step(ctx, 'return page: scan the wholesale return code', 'ok', () => salesService.findByReturnCode(code))
})

// =================================================================== B) returns of wholesale invoices
const METHODS = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']
for (const typeKey of Object.keys(W_TYPES)) {
  for (let mi = 0; mi < METHODS.length; mi++) {
    const m1 = METHODS[mi], m2 = METHODS[(mi + 1) % METHODS.length]
    const declined = m1 === 'DECLINED' || m2 === 'DECLINED'
    await run(`WB-${typeKey}-${m1}`, `برگشت از فاکتور [${W_TYPES[typeKey].title}]: جزئی ${m1} سپس بقیه ${m2}`, async (ctx) => {
      const root = await rootW(ctx, typeKey)
      const r1 = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: m1, expect: 'either', label: `partial return X ${m1}` })
      const r2 = await ret(ctx, root.invoiceId, { full: true, method: m2, expect: 'either', label: `return rest Y ${m2}` })
      for (const r of [r1, r2]) if (r.ok) for (const c of r.credits ?? []) {
        await certLifecycle(ctx, n(c.id), `credit from ${r === r1 ? 'partial' : 'final'} return`)
        await spendTwiceW(ctx, n(c.id), `credit #${c.id}`)
      }
    }, { allowLoss: declined })
  }
}

// =================================================================== C) exchange chains on wholesale invoices
const POS_PAY = ['CASH', 'CARD', 'SPLIT', 'BARCODE']
const NEG_MODE = ['CASH', 'CARD', 'STORE_CREDIT', 'CARD_TO_CARD', 'UNSELECTED']
const SIGNS = [[1, -1, 0], [-1, 1, -1], [0, -1, 1], [-1, -1, 1], [1, 1, -1], [-1, 0, -1]]
const RMETHODS = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT']
async function chainExchangeW(ctx, invoiceId, srcV, sign, k, label) {
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
let chainNo = 0
for (const typeKey of Object.keys(W_TYPES)) {
  for (const kind of ['EX-EX-EX', 'EX-EX-RET', 'RET-EX-EX', 'PRET-EX-RET']) {
    const k = chainNo++
    const signs = SIGNS[k % SIGNS.length]
    await run(`WC-${typeKey}-${kind}`, `زنجیره ${kind} از فاکتور [${W_TYPES[typeKey].title}] علامت‌ها ${signs.join('/')}`, async (ctx) => {
      const root = await rootW(ctx, typeKey, { xQty: kind === 'PRET-EX-RET' ? 2 : 1 })
      const issued = []
      const take = (r) => { if (r?.ok) for (const c of r.credits ?? []) issued.push({ id: n(c.id) }) }
      let inv = root.invoiceId, cur = root.X
      if (kind === 'EX-EX-EX' || kind === 'EX-EX-RET') {
        const s1 = await chainExchangeW(ctx, inv, cur, signs[0], k, 'step1 exchange X on the wholesale invoice'); take(s1.r); if (!s1.r.ok) return
        inv = s1.r.exchangeInvoiceId; cur = s1.nv
        const s2 = await chainExchangeW(ctx, inv, cur, signs[1], k + 1, 'step2 exchange on exchange-invoice-1'); take(s2.r); if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        if (kind === 'EX-EX-EX') { const s3 = await chainExchangeW(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-2'); take(s3.r) }
        else take(await ret(ctx, inv, { full: true, method: RMETHODS[k % 4], expect: 'ok', label: `step3 return of exchange-invoice-2 ${RMETHODS[k % 4]}` }))
      } else if (kind === 'RET-EX-EX') {
        take(await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.Y).id), qty: 1 }], method: RMETHODS[k % 4], expect: 'ok', label: `step1 return Y ${RMETHODS[k % 4]}` }))
        const s2 = await chainExchangeW(ctx, inv, cur, signs[1], k + 1, 'step2 exchange X on the wholesale invoice'); take(s2.r); if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        const s3 = await chainExchangeW(ctx, inv, cur, signs[2], k + 2, 'step3 exchange on exchange-invoice-1'); take(s3.r)
      } else {
        take(await ret(ctx, inv, { lines: [{ saleItemId: n(itemFor(inv, root.X).id), qty: 1 }], method: RMETHODS[(k + 1) % 4], expect: 'ok', label: `step1 partial return 1 of 2 X ${RMETHODS[(k + 1) % 4]}` }))
        const s2 = await chainExchangeW(ctx, inv, cur, signs[1], k + 1, 'step2 exchange the other X'); take(s2.r); if (!s2.r.ok) return
        inv = s2.r.exchangeInvoiceId; cur = s2.nv
        take(await ret(ctx, inv, { full: true, method: RMETHODS[(k + 2) % 4], expect: 'ok', label: `step3 return exchange-invoice-1 ${RMETHODS[(k + 2) % 4]}` }))
      }
      const exInv = seed.one('SELECT orderType FROM "SaleInvoice" WHERE id=?', inv)
      ctx.notes.push(`last chain invoice orderType: ${exInv?.orderType}`)
      for (const [i, c] of issued.entries()) await certLifecycle(ctx, c.id, 'chain credit', { reprint: i % 2 === 0 })
      for (const c of issued) await spendTwiceW(ctx, c.id, `chain credit #${c.id}`)
    })
  }
}

// =================================================================== D) print and code exposure on wholesale paths
await run('WD-print-shift-closed', 'گواهی اعتبار برگشت عمده: چاپ نخست، چاپ دوباره، بستن شیفت', async (ctx) => {
  const root = await rootW(ctx, 'W1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return finding(ctx, 'NO_CREDIT', 'wholesale return STORE_CREDIT', null)
  openReturnPanel(); printers()
  const p1 = await invoke(IPC.creditDeliveryPrint, { id: n(c.id) })
  ctx.notes.push('first print: ' + (p1.ok ? 'OK' : p1.error))
  printers()
  const p2 = await invoke(IPC.creditSellerReprint, { id: n(c.id), reasonCode: 'INCOMPLETE' })
  ctx.notes.push('seller reprint (same shift): ' + (p2.ok ? 'OK' : p2.error))
  sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), ctx.shiftId)
  printers()
  const p3 = await invoke(IPC.creditSellerReprint, { id: n(c.id), reasonCode: 'INCOMPLETE' })
  ctx.notes.push('seller reprint after close: ' + (p3.ok ? 'OK (!)' : p3.error))
  if (p3.ok) finding(ctx, 'REPRINT_AFTER_SHIFT_CLOSE', 'seller', c.id)
})
await run('WD-code-leak-scan', 'کد بارکد در خروجی‌های عمده و برگشت دیده نشود', async (ctx) => {
  const root = await rootW(ctx, 'W4')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const Z = V(ctx, 'Z', 50_000)
  const e = await exch(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.Y).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'STORE_CREDIT', label: 'exchange Y→Z (-30k) STORE_CREDIT' })
  const codes = seed.rows('SELECT id,code,source,status,amount,usedAmount FROM "StoreCredit" WHERE id>?', ctx.creditFloor).filter((c) => n(c.amount) - n(c.usedAmount) > 0 && ['ACTIVE', 'PARTIALLY_USED'].includes(c.status))
  const probes = {
    saleGet: () => salesService.get(root.invoiceId),
    wholesaleList: () => salesService.list({ fromJalali: today, toJalali: today, orderType: 'WHOLESALE' }),
    exchangeInvoiceGet: () => salesService.get(e.exchangeInvoiceId),
    payments: () => salesService.payments({ invoiceId: root.invoiceId }),
    returnGet: () => salesService.returnGet(r.returnId),
    exchangeGet: () => salesService.exchangeGet({ id: e.returnId }),
    reportRows: () => salesService.reportRows({ shiftId: ctx.shiftId }),
    byReturnCode: async () => salesService.findByReturnCode(seed.one('SELECT returnCode FROM "SaleInvoice" WHERE id=?', root.invoiceId).returnCode)
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

// =================================================================== E) cash-out probes on wholesale invoices
async function bcOnlyW(ctx, price = 100_000) {
  const X = V(ctx, 'X', price)
  const c = await issueManual(ctx, price)
  const s = await wsale(ctx, { items: [{ v: X }], tender: 'CASH', code: c.code, label: `wholesale ${price} paid 100% by barcode` })
  return { X, c, invoiceId: s.invoiceId }
}
for (const m of ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'DECLINED', 'UNSELECTED']) {
  await run(`WE-bconly-return-${m}`, `فاکتور عمدهٔ تمام‌بارکد ⇒ برگشت کامل با ${m}`, async (ctx) => {
    const s = await bcOnlyW(ctx)
    const r = await ret(ctx, s.invoiceId, { full: true, method: m, expect: 'either' })
    for (const c of r.credits ?? []) await certLifecycle(ctx, n(c.id), 'credit after barcode-only wholesale return')
  })
}
await run('WE-bconly-fullrefund', 'فاکتور عمدهٔ تمام‌بارکد ⇒ برگشت نقدی «مبلغ کامل با رمز مدیر»', async (ctx) => {
  const s = await bcOnlyW(ctx)
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', expect: 'either', extra: { managerFullRefund: true, managerPassword: PW, overrideReason: 'آزمون ممیزی مبلغ کامل' } })
})
for (const m of ['CASH', 'CARD', 'CARD_TO_CARD', 'UNSELECTED']) {
  await run(`WE-bconly-exchange-cheaper-${m}`, `فاکتور عمدهٔ تمام‌بارکد ⇒ تعویض ارزان‌تر، بازپرداخت ${m}`, async (ctx) => {
    const s = await bcOnlyW(ctx)
    const Z = V(ctx, 'Z', 60_000)
    const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, s.X).id), qty: 1 }], repl: [{ v: Z }], refundMode: m, expect: 'either', label: 'exchange 100k → 60k' })
    for (const c of e.credits ?? []) await certLifecycle(ctx, n(c.id), 'credit from barcode-only wholesale exchange')
  })
}
await run('WE-mixed-partials-cash', 'عمده ۶۰٪ بارکد + ۴۰٪ نقد ⇒ برگشت قلم‌به‌قلم نقدی', async (ctx) => {
  const a = V(ctx, 'A', 50_000), b = V(ctx, 'B', 50_000), d = V(ctx, 'D', 50_000), e = V(ctx, 'E', 50_000)
  const c = await issueManual(ctx, 120_000)
  const s = await wsale(ctx, { items: [{ v: a }, { v: b }, { v: d }, { v: e }], tender: 'CASH', code: c.code, label: 'wholesale 200k = 120k barcode + 80k cash' })
  for (const v of [a, b, d, e]) await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, v).id), qty: 1 }], method: 'CASH', expect: 'either', label: `return ${v.label} CASH` })
})
await run('WE-discount-partials', 'عمده با ۲۰٪ تخفیف + بارکد ⇒ برگشت قلم‌به‌قلم کارتی', async (ctx) => {
  const a = V(ctx, 'A', 100_000), b = V(ctx, 'B', 100_000)
  const c = await issueManual(ctx, 60_000)
  const s = await wsale(ctx, { items: [{ v: a }, { v: b }], tender: 'CARD', code: c.code, percent: 20, label: 'wholesale 200k −20% = 160k: barcode 60k + card 100k' })
  for (const v of [a, b]) await ret(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, v).id), qty: 1 }], method: 'CARD', expect: 'either', label: `return ${v.label} CARD` })
})
await run('WE-ex-paid-by-bc-then-cash-return', 'عمده نقدی ⇒ تعویض گران‌تر با بارکد ⇒ برگشت سند تعویض نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 130_000)
  const s = await wsale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'wholesale 100k cash' })
  const c = await issueManual(ctx, 30_000)
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], pay: 'BARCODE', code: c.code, label: 'exchange 100k→130k, diff by barcode' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'either', label: 'return exchange invoice CASH' })
  resetCodeGate()
})
await run('WE-credit-spent-then-void-return', 'برگشت عمده با اعتبار ⇒ خرج اعتبار ⇒ ابطال/ویرایش/اصلاح جبرانی برگشت', async (ctx) => {
  const root = await rootW(ctx, 'W1')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'STORE_CREDIT' })
  const c = r.credits?.[0]
  if (!c) return
  const v = V(ctx, 'I', 120_000)
  await wsale(ctx, { items: [{ v }], tender: 'CASH', code: c.code, label: 'spend the return credit in a wholesale invoice' })
  await step(ctx, 'returnDelete after credit spent', 'refuse', () => salesService.returnDelete({ id: r.returnId, userId, reason: 'آزمون ابطال پس از مصرف', managerPassword: PW, panelPassword: PW }))
  await step(ctx, 'returnUpdate after credit spent', 'refuse', () => salesService.returnUpdate({ id: r.returnId, lines: [{ saleItemId: n(itemFor(root.invoiceId, root.Y).id), qty: 1 }], userId, managerPassword: PW, panelPassword: PW, overrideReason: 'آزمون ویرایش پس از مصرف' }))
  await step(ctx, 'returnReconcileVoid CONSUMED (with password)', 'either', () => salesService.returnReconcileVoid({ id: r.returnId, userId, reason: 'آزمون اصلاح جبرانی', panelPassword: PW, creditOutcome: 'CONSUMED', cashRecovered: 0 }))
  resetCodeGate()
}, { allowLoss: true })
await run('WE-chain-neg-cash-then-return-cash', 'عمده نقدی ⇒ تعویض ارزان‌تر با بازپرداخت نقدی ⇒ برگشت سند تعویض نقدی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 70_000)
  const s = await wsale(ctx, { items: [{ v: X }], tender: 'CASH', label: 'wholesale 100k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', label: 'exchange 100k→70k CASH refund' })
  if (e.ok) await ret(ctx, e.exchangeInvoiceId, { full: true, method: 'CASH', expect: 'ok', label: 'return exchange invoice CASH' })
})
await run('WE-payout-above-real-money', 'عمدهٔ مختلط ⇒ تعویض ارزان‌تر با درخواست نقد بیش از پول واقعی', async (ctx) => {
  const X = V(ctx, 'X', 100_000), Z = V(ctx, 'Z', 20_000)
  const c = await issueManual(ctx, 60_000)
  const s = await wsale(ctx, { items: [{ v: X }], tender: 'CASH', code: c.code, label: 'wholesale 100k = 60k barcode + 40k cash' })
  const e = await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', payout: 80_000, label: 'exchange 100k→20k asking 80k cash', expect: 'either' })
  if (!e.ok) await exch(ctx, s.invoiceId, { lines: [{ saleItemId: n(itemFor(s.invoiceId, X).id), qty: 1 }], repl: [{ v: Z }], refundMode: 'CASH', label: 'same, amount left blank', expect: 'ok' })
  resetCodeGate()
})
await run('WE-return-amount-above-safe', 'برگشت نقدی فاکتور عمدهٔ مختلط با مبلغ تایپ‌شده بیش از حق امن', async (ctx) => {
  const X = V(ctx, 'X', 100_000)
  const c = await issueManual(ctx, 60_000)
  const s = await wsale(ctx, { items: [{ v: X }], tender: 'CASH', code: c.code, label: 'wholesale 100k = 60k barcode + 40k cash' })
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', amount: 100_000, expect: 'refuse', label: 'return asking 100k cash' })
  await ret(ctx, s.invoiceId, { full: true, method: 'CASH', label: 'return, amount blank (= safe)' })
  resetCodeGate()
})
await run('WE-c2c-cancel-then-void', 'برگشت عمده با کارت‌به‌کارت ⇒ لغو ⇒ ابطال برگشت ⇒ برگشت نقدی', async (ctx) => {
  const root = await rootW(ctx, 'W4')
  const r = await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CARD_TO_CARD', payC2C: false })
  const req = seed.one('SELECT id FROM "CardTransferRequest" WHERE returnId=?', r.returnId ?? 0)
  if (!req) return ctx.notes.push('no C2C request')
  await step(ctx, 'manager cancels C2C', 'ok', () => cardTransferService.cancel({ id: n(req.id), reason: 'مشتری منصرف شد', managerPassword: PW, userId }))
  await step(ctx, 'returnDelete to close the case', 'ok', () => salesService.returnDelete({ id: r.returnId, userId, reason: 'لغو کارت‌به‌کارت', managerPassword: PW, panelPassword: PW }))
  await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.X).id), qty: 1 }], method: 'CASH', label: 'new return of X by CASH' })
}, { allowLoss: true })

// =================================================================== F) editing a barcode-funded wholesale invoice
async function wedit(ctx, invoiceId, { items, percent = 0, label, expect = 'either' }) {
  const lines = wLines(items, percent)
  return step(ctx, label, expect, () => salesService.update({
    id: invoiceId, orderType: 'WHOLESALE', issuedAtJalali: today, deductInventory: true, wholesaleDiscountPercent: percent || null,
    invoiceDiscount: 0, invoiceTax: 0, serviceCharge: 0, lines, remoteCustomer: false, autoCentralWithdraw: false,
    storeCreditCode: null, keepPayments: true, userId, shiftId: ctx.shiftId
  }))
}
await run('WF-edit-same-total', 'ویرایش فاکتور عمدهٔ بارکدی: عوض کردن یک کالا با کالای هم‌قیمت', async (ctx) => {
  const A = V(ctx, 'A', 60_000), B = V(ctx, 'B', 40_000), C = V(ctx, 'C', 40_000)
  const c = await issueManual(ctx, 30_000)
  const s = await wsale(ctx, { items: [{ v: A }, { v: B }], tender: 'CASH', code: c.code, label: 'wholesale 100k: barcode 30k + cash 70k' })
  if (!s.ok) return
  await wedit(ctx, s.invoiceId, { items: [{ v: A }, { v: C }], label: 'edit: B → C (same price)' })
  ctx.notes.push(`barcode after edit: used ${n(rawCredit(c.id).usedAmount)} status ${rawCredit(c.id).status}`)
  const r = await ret(ctx, s.invoiceId, { full: true, method: 'CASH', expect: 'either', label: 'full return after the edit CASH' })
  if (r.ok) ctx.notes.push(`return: refund ${n(r.res.refundAmount)} restored ${n(r.res.sourceCreditRestoredAmount)}`)
  resetCodeGate()
})
await run('WF-edit-lower-total', 'ویرایش فاکتور عمدهٔ بارکدی: حذف یک کالا (جمع کمتر از پرداختی)', async (ctx) => {
  const A = V(ctx, 'A', 60_000), B = V(ctx, 'B', 40_000)
  const c = await issueManual(ctx, 30_000)
  const s = await wsale(ctx, { items: [{ v: A }, { v: B }], tender: 'CASH', code: c.code, label: 'wholesale 100k: barcode 30k + cash 70k' })
  if (!s.ok) return
  await wedit(ctx, s.invoiceId, { items: [{ v: A }], label: 'edit: remove B (payable 60k, paid 100k incl. barcode)', expect: 'refuse' })
  resetCodeGate()
})
await run('WF-edit-restricted-barcode', 'ویرایش فاکتور عمده با بارکدِ محدود به یک کالا: آن کالا را عوض کن', async (ctx) => {
  const A = V(ctx, 'A', 60_000), B = V(ctx, 'B', 40_000), C = V(ctx, 'C', 60_000)
  const issued = await storeCreditService.issueManual({ amount: 30_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId, managerPassword: PW, restrictScope: 'VARIANTS', restrictVariantIds: [A.id] })
  ctx.manualIssued += 30_000
  const code = rawCredit(issued.id).code
  const s = await wsale(ctx, { items: [{ v: A }, { v: B }], tender: 'CASH', code, label: 'wholesale 100k: barcode (only for A) 30k + cash 70k' })
  if (!s.ok) return
  const e = await wedit(ctx, s.invoiceId, { items: [{ v: C }, { v: B }], label: 'edit: A → C (barcode was only valid for A)' })
  ctx.notes.push('edit: ' + (e.ok ? 'ACCEPTED — barcode now pays for an item it was not valid for' : e.error.slice(0, 200)))
  if (e.ok) {
    const r = await ret(ctx, s.invoiceId, { full: true, method: 'CASH', expect: 'either', label: 'full return after that edit CASH' })
    ctx.notes.push('return after edit: ' + (r.ok ? `refund ${n(r.res.refundAmount)} restored ${n(r.res.sourceCreditRestoredAmount)}` : r.error.slice(0, 200)))
  }
  resetCodeGate()
})
await run('WF-edit-after-return', 'ویرایش فاکتور عمدهٔ بارکدی پس از برگشت', async (ctx) => {
  const root = await rootW(ctx, 'W4')
  await ret(ctx, root.invoiceId, { lines: [{ saleItemId: n(itemFor(root.invoiceId, root.Y).id), qty: 1 }], method: 'CASH', label: 'return Y CASH' })
  await wedit(ctx, root.invoiceId, { items: [{ v: root.X }], label: 'edit after a return', expect: 'refuse' })
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
  // کدِ نیمه‌تایپ‌شده (پیشوند تصادفیِ یک بارکد) هم مثل کد کامل پوشانده می‌شود
  s = s.replace(/«[A-Z0-9]{2,}»/g, '«کد»')
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
const snapshotDoc = { meta: { tool: 'docs/audit/wholesale-barcode-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
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
