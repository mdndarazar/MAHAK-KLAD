/**
 * Six additional isolated financial/inventory/credit flows.
 * Uses only a fresh temporary SQLite harness; no live DB or production edits.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-additional-06-policy-flows.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-additional-06-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('additional-six-flow audit cashier')
const cash = seed.insert('PaymentMethod', { key: 'A06-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'A06-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category('additional-six-flow')
const n = x => Number(x ?? 0)
const results = [], seq = { variant: 0 }
const rawCredit = id => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId FROM "StoreCredit" WHERE id=?', id)

function variant(ctx, name, price, stock = 10) {
  const product = seed.product(`A06-${++seq.variant}-${name}`, category)
  const id = seed.variant(product, `A06-${seq.variant}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  const v = { id, name, price, baseline: stock, expected: stock }
  ctx.variants.push(v)
  return v
}
const line = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const items = invoiceId => seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
function addCredit(ctx, id, label) {
  if (id == null) return null
  const prior = ctx.credits.find(x => x.id === Number(id))
  if (prior) return prior
  const c = rawCredit(id)
  assert.ok(c, `credit ${id} exists`)
  const entry = { id: n(c.id), code: c.code, label }
  ctx.credits.push(entry)
  return entry
}
function addReturnCredits(ctx, returnId, prefix) {
  return seed.rows('SELECT id,code,amount FROM "StoreCredit" WHERE returnId=? ORDER BY id', returnId)
    .map((r, i) => addCredit(ctx, r.id, `${prefix}-${i + 1}`))
}
function stockAdjust(ctx, changes = {}) {
  for (const [id, delta] of Object.entries(changes)) {
    const v = ctx.variants.find(x => x.id === Number(id))
    assert.ok(v, `known variant ${id}`)
    v.expected += delta
  }
}
function rawPhysical(shiftId) {
  const p = seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.amount), refundCard: n(r.amount) }
}
async function checkpoint(ctx, operation, { flow = {}, stock = {}, note = '' } = {}) {
  for (const k of Object.keys(ctx.expected)) ctx.expected[k] += n(flow[k])
  stockAdjust(ctx, stock)
  const report = await salesService.reportRows({ shiftId: ctx.shiftId })
  const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  const raw = rawPhysical(ctx.shiftId)
  assert.deepEqual(reported, ctx.expected, `${ctx.name}/${operation}: report vs expected physical totals`)
  assert.deepEqual(raw, reported, `${ctx.name}/${operation}: independent raw financial docs vs report`)
  const blue = n(await physicalMovementForCustodyShift(ctx.shiftId))
  const blueExpected = ctx.expected.cash + ctx.expected.card - ctx.expected.refundCash - ctx.expected.refundCard
  const blueRaw = raw.cash + raw.card - raw.refundCash - raw.refundCard
  assert.equal(blue, blueExpected, `${ctx.name}/${operation}: blue movement`)
  assert.equal(blueRaw, blue, `${ctx.name}/${operation}: independent raw blue`)
  const stockRows = ctx.variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledgerDelta = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, v.expected, `${ctx.name}/${operation}: stock for ${v.name}`)
    assert.equal(actual, v.baseline + ledgerDelta, `${ctx.name}/${operation}: stock ledger for ${v.name}`)
    return { sku: v.name, baseline: v.baseline, expected: v.expected, actual, ledgerDelta }
  })
  const creditRows = ctx.credits.map(c => {
    const r = rawCredit(c.id)
    const delivery = seed.one('SELECT status,handoffType,deliveredAt,userId,note FROM "StoreCreditDelivery" WHERE creditId=?', c.id)
    const redemptions = seed.rows('SELECT amount,remainderAfter,seq,reversedAt,invoiceId FROM "StoreCreditRedemption" WHERE creditId=? ORDER BY id', c.id)
    return { id: n(r.id), code: r.code, label: c.label, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source, returnId: r.returnId == null ? null : n(r.returnId), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), sourceInvoiceId: r.sourceInvoiceId == null ? null : n(r.sourceInvoiceId), delivery: delivery ?? null, redemptions: redemptions.map(x => ({ amount: n(x.amount), remainderAfter: n(x.remainderAfter), seq: n(x.seq), reversed: !!x.reversedAt, invoiceId: x.invoiceId == null ? null : n(x.invoiceId) })) }
  })
  const invoices = seed.rows('SELECT id,receiptNo,status,grandTotal,paidTotal,sourceInvoiceId,exchangeReturnId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', ctx.shiftId)
    .map(i => ({ id: n(i.id), receiptNo: i.receiptNo, status: i.status, grandTotal: n(i.grandTotal), paidTotal: n(i.paidTotal), sourceInvoiceId: i.sourceInvoiceId == null ? null : n(i.sourceInvoiceId), exchangeReturnId: i.exchangeReturnId == null ? null : n(i.exchangeReturnId), items: items(i.id).map(x => ({ id: n(x.id), variantId: n(x.variantId), qty: n(x.qty), unitPrice: n(x.unitPrice), lineTotal: n(x.lineTotal) })) }))
  const returns = seed.rows('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,voidedAt FROM "SaleReturn" WHERE shiftId=? ORDER BY id', ctx.shiftId)
    .map(r => ({ id: n(r.id), invoiceId: n(r.invoiceId), kind: r.kind, total: n(r.total), refundMethod: r.refundMethod, refundAmount: n(r.refundAmount), refundStoreCreditAmount: n(r.refundStoreCreditAmount), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), exchangeTotal: n(r.exchangeTotal), exchangeDiff: n(r.exchangeDiff), exchangeSettlement: r.exchangeSettlement, voided: !!r.voidedAt }))
  const event = { scenario: ctx.name, operation, note, expected: { ...ctx.expected, blue: blueExpected }, reported, raw, blue, blueRaw, stock: stockRows, credits: creditRows, invoices, returns }
  ctx.events.push(event)
  return event
}
async function runScenario(name, fn) {
  const shiftId = seed.insert('Shift', { name: `A06 ${name}`, number: results.length + 60, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
  const ctx = { name, shiftId, variants: [], credits: [], events: [], expected: { cash: 0, card: 0, refundCash: 0, refundCard: 0 } }
  try {
    await checkpoint(ctx, 'baseline: no physical flows; opening stock and documents captured')
    const detail = await fn(ctx)
    results.push({ name, status: 'PASS', detail, events: ctx.events })
  } catch (e) {
    let postFailure = null
    try {
      const report = await salesService.reportRows({ shiftId })
      postFailure = { rawPhysical: rawPhysical(shiftId), reported: { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }, stocks: ctx.variants.map(v => ({ sku: v.name, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), baseline: v.baseline })), invoiceCount: seed.count('SaleInvoice', 'shiftId=?', shiftId), returnCount: seed.count('SaleReturn', 'shiftId=?', shiftId), creditIds: ctx.credits.map(c => c.id) }
    } catch (verifyError) { postFailure = { verificationError: String(verifyError?.message ?? verifyError) } }
    results.push({ name, status: 'FAIL', error: String(e?.message ?? e), stack: String(e?.stack ?? ''), postFailure, events: ctx.events })
  }
}
const cashPay = amount => [{ methodId: cash, amount, destination: 'CASH' }]
const splitPay = (cashAmount, cardAmount) => [
  ...(cashAmount ? [{ methodId: cash, amount: cashAmount, destination: 'CASH' }] : []),
  ...(cardAmount ? [{ methodId: card, amount: cardAmount, destination: 'CARD' }] : [])
]
const issue = async (amount, { multiUse = false, expiresAt = null } = {}) => {
  const row = await storeCreditService.issueManual({ amount, multiUse, maxUses: multiUse ? 10 : 1, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
  if (expiresAt != null) sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(expiresAt, row.id)
  const saved = rawCredit(row.id)
  return { id: n(saved.id), code: saved.code, expiresAt: saved.expiresAt, amount: n(saved.amount), usedAmount: n(saved.usedAmount), usedCount: n(saved.usedCount), status: saved.status }
}

// 1. Four-item mixed-tender chain: return A, exchange B, exchange C+D,
// then exchange the B1 child again. The same original funding must never leak cash.
await runScenario('01 multi-item return + repeated exchange chain', async ctx => {
  const A = variant(ctx, 'A-original-100k', 100_000), B = variant(ctx, 'B-original-200k', 200_000), C = variant(ctx, 'C-original-300k', 300_000), D = variant(ctx, 'D-original-400k', 400_000)
  const B1 = variant(ctx, 'B1-first-replacement-180k', 180_000), C1 = variant(ctx, 'C1-replacement-320k', 320_000), D1 = variant(ctx, 'D1-replacement-420k', 420_000), B2 = variant(ctx, 'B2-reexchange-160k', 160_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(A), line(B), line(C), line(D)], payments: splitPay(600_000, 400_000), saleRequestIdempotencyKey: 'a06-chain-invoice' })
  assert.equal(n(sale.grandTotal), 1_000_000)
  await checkpoint(ctx, 'sale A+B+C+D = 1,000,000; cash 600,000 + POS 400,000', { flow: { cash: 600_000, card: 400_000 }, stock: { [A.id]: -1, [B.id]: -1, [C.id]: -1, [D.id]: -1 } })
  const root = items(sale.id)
  const byVariant = id => root.find(x => n(x.variantId) === id)
  const retA = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: false, lines: [{ saleItemId: n(byVariant(A.id).id), qty: 1 }], refundMethod: 'CASH', refundAmount: 100_000 })
  await checkpoint(ctx, `return A for cash; return document #${retA.id}`, { flow: { refundCash: 100_000 }, stock: { [A.id]: 1 }, note: 'cash payout 100,000; blue falls from 1,000,000 to 900,000' })
  const exB = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, lines: [{ saleItemId: n(byVariant(B.id).id), qty: 1 }], replacements: [line(B1)], refundMode: 'STORE_CREDIT' })
  assert.equal(n(exB.diff), -20_000)
  addReturnCredits(ctx, exB.returnId, 'B-exchange-credit')
  const invoiceB1 = n(exB.exchangeInvoiceId), itemB1 = items(invoiceB1)[0]
  await checkpoint(ctx, `exchange B 200,000 -> B1 180,000; store credit 20,000; return #${exB.returnId}, child invoice ${invoiceB1}`, { stock: { [B.id]: 1, [B1.id]: -1 }, note: 'no physical refund; blue remains 900,000; returned value is a noncash credit asset' })
  const exCD = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, lines: [{ saleItemId: n(byVariant(C.id).id), qty: 1 }, { saleItemId: n(byVariant(D.id).id), qty: 1 }], replacements: [line(C1), line(D1)], methodId: cash })
  assert.equal(n(exCD.diff), 40_000)
  assert.equal(n(exCD.cashReceived), 40_000)
  const invoiceCD = n(exCD.exchangeInvoiceId)
  await checkpoint(ctx, `exchange C+D 700,000 -> C1+D1 740,000; cash +40,000; return #${exCD.returnId}, child invoice ${invoiceCD}`, { flow: { cash: 40_000 }, stock: { [C.id]: 1, [D.id]: 1, [C1.id]: -1, [D1.id]: -1 }, note: 'new cash received is separate from the prior B store-credit difference; blue becomes 940,000' })
  const exB2 = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: invoiceB1, lines: [{ saleItemId: n(itemB1.id), qty: 1 }], replacements: [line(B2)], refundMode: 'STORE_CREDIT' })
  assert.equal(n(exB2.diff), -20_000)
  addReturnCredits(ctx, exB2.returnId, 'B1-reexchange-credit')
  const retDocs = seed.rows('SELECT invoiceId,exchangeInvoiceId,exchangeDiff FROM "SaleReturn" WHERE shiftId=? ORDER BY id', ctx.shiftId)
  assert.equal(retDocs.length, 4, 'one simple return and three exchange documents')
  assert.equal(n(retDocs[3].invoiceId), invoiceB1, 're-exchange source is invoice containing already-exchanged B1')
  assert.equal(n(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?', exB2.exchangeInvoiceId).sourceInvoiceId), invoiceB1)
  await checkpoint(ctx, `re-exchange B1 from child invoice -> B2 160,000; second 20,000 credit; return #${exB2.returnId}`, { stock: { [B1.id]: 1, [B2.id]: -1 }, note: 'B1 was exchanged once already; B1 returns, B2 leaves stock, blue remains 940,000' })
  return `4 original items; return A; exchange B, exchange C+D together, and re-exchange B1 from its own child invoice. Final blue=940,000; one return paid 100,000 cash, one collected 40,000 cash, two 20,000 differences stayed as store credit.`
})

// 2. No selected method: verify no real payout, only backed value is credited,
// and a delivery row is retained for the hand-off/print workflow.
await runScenario('02 no-method return creates only non-expiring backed credit', async ctx => {
  const v = variant(ctx, 'no-method-item-250k', 250_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(v)], payments: cashPay(250_000), saleRequestIdempotencyKey: 'a06-none-sale' })
  const item = items(sale.id)[0]
  await checkpoint(ctx, 'cash sale 250,000', { flow: { cash: 250_000 }, stock: { [v.id]: -1 } })
  const before = { payments: seed.count('Payment', 'createdShiftId=?', ctx.shiftId), movements: seed.count('CashMovement', 'shiftId=?', ctx.shiftId), returns: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId), stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock) }
  let gateError = ''
  try { await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'NONE' }) }
  catch (e) { gateError = String(e?.message ?? e) }
  assert.match(gateError, /اضافه.?دریافت|اضافه‌دریافت/)
  assert.deepEqual({ payments: seed.count('Payment', 'createdShiftId=?', ctx.shiftId), movements: seed.count('CashMovement', 'shiftId=?', ctx.shiftId), returns: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId), stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock) }, before, 'unconfirmed no-method/overpay attempt is mutation-free')
  await checkpoint(ctx, `unconfirmed no-method attempt blocked: ${gateError}; no mutation`)
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'NONE', confirmOverpay: true, overpayAsCredit: true, overpayManagerPassword: DEFAULT_MANAGER_PASSWORD })
  const created = addReturnCredits(ctx, ret.id, 'no-method-credit')
  const creditAmount = created.reduce((sum, c) => sum + n(rawCredit(c.id).amount), 0)
  assert.equal(creditAmount, 250_000, 'issued credit must not exceed actual cash backing')
  assert.equal(n(ret.refundAmount), 0)
  assert.equal(seed.count('Payment', 'createdShiftId=?', ctx.shiftId), before.payments)
  assert.equal(seed.count('CashMovement', 'shiftId=?', ctx.shiftId), before.movements)
  assert.equal(seed.count('SaleReturn', 'shiftId=?', ctx.shiftId), before.returns + 1)
  for (const c of created) {
    const row = rawCredit(c.id), delivery = seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', c.id)
    assert.equal(row.expiresAt, null, 'auto-issued credit is non-expiring')
    assert.ok(delivery, 'delivery/handoff record exists; pending status must not imply false completion')
  }
  await checkpoint(ctx, `return #${ret.id} with NONE; no payout; ${created.length} credit(s), delivery records retained`, { stock: { [v.id]: 1 }, note: `cash paid=250,000; cash/POS refund=0; credit value=${creditAmount}; verify StoreCreditDelivery rows in checkpoint` })
  return 'No selected method created no cash/POS payment or refund movement; 250,000 backed amount became non-expiring credit and has a delivery record.'
})

// 3. A live, partially redeemed source is restored on the same ID/code; no successor.
await runScenario('03 partial return restores a live source credit in place', async ctx => {
  const c = await issue(400_000, { multiUse: true })
  addCredit(ctx, c.id, 'live-original-credit')
  await checkpoint(ctx, 'issue 400,000 multi-use source credit; no physical flow')
  const v = variant(ctx, 'credit-funded-item-300k', 300_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(v)], payments: [], storeCreditCode: c.code, saleRequestIdempotencyKey: 'a06-live-source-sale' })
  assert.equal(n(sale.storeCreditApplied), 300_000)
  const item = items(sale.id)[0]
  await checkpoint(ctx, 'sale 300,000 from original credit; original has 100,000 remaining', { stock: { [v.id]: -1 } })
  const beforeCode = rawCredit(c.id).code
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'NONE' })
  assert.equal(n(ret.sourceCreditRestoredAmount), 300_000)
  const after = rawCredit(c.id)
  assert.equal(n(after.id), c.id); assert.equal(after.code, beforeCode)
  assert.equal(n(after.usedAmount), 0); assert.equal(after.status, 'ACTIVE')
  const successors = seed.count('StoreCredit', 'returnId=?', ret.id)
  assert.equal(successors, 0, 'no successor for a live partially consumed source')
  await checkpoint(ctx, `return #${ret.id}; same ID/code returned to 400,000 available; no successor`, { stock: { [v.id]: 1 }, note: 'valid half-used source restored in place; physical blue remains zero' })
  return 'The original live credit retains ID/code and is reset to its original available balance; return created zero successors.'
})

// 4. A fully USED source stays USED, and its successor keeps the raw expiry.
await runScenario('04 used source stays USED and successor preserves raw expiry', async ctx => {
  const rawExpiry = Date.UTC(2031, 6, 8, 9, 10, 11)
  const c = await issue(180_000, { multiUse: false, expiresAt: rawExpiry })
  addCredit(ctx, c.id, 'fully-used-original-credit')
  const sourceSnapshot = rawCredit(c.id)
  await checkpoint(ctx, 'issue single-use 180,000 credit with explicit raw expiry')
  const v = variant(ctx, 'used-credit-funded-item-180k', 180_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(v)], payments: [], storeCreditCode: c.code, saleRequestIdempotencyKey: 'a06-used-source-sale' })
  assert.equal(n(sale.storeCreditApplied), 180_000)
  await checkpoint(ctx, 'fully redeem source credit; source must become USED', { stock: { [v.id]: -1 } })
  assert.equal(rawCredit(c.id).status, 'USED')
  const item = items(sale.id)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'NONE' })
  assert.equal(n(rawCredit(c.id).id), c.id)
  assert.equal(rawCredit(c.id).status, 'USED', 'the consumed code is never reactivated')
  const successors = seed.rows('SELECT id,code,amount,expiresAt,status,usedAmount FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
  assert.equal(successors.length, 1)
  assert.notEqual(n(successors[0].id), c.id)
  assert.notEqual(successors[0].code, sourceSnapshot.code)
  assert.equal(n(successors[0].amount), 180_000)
  assert.equal(successors[0].expiresAt, sourceSnapshot.expiresAt, 'successor stores unmodified raw source expiry')
  assert.equal(successors[0].status, 'ACTIVE')
  addCredit(ctx, successors[0].id, 'successor-of-used-credit')
  await checkpoint(ctx, `return #${ret.id}; old code remains USED; fresh successor ${successors[0].code} retains raw expiry`, { stock: { [v.id]: 1 }, note: 'source ID/code is immutable history; successor ID/code is distinct and raw expiry copied in DB' })
  return 'USED source ID/code remains USED; a distinct successor ID/code receives 180,000 and preserves the source raw expiry without adding an API field.'
})

// 5. Two fully-consumed source codes produce two successors (not a pooled single code).
await runScenario('05 preserve successor count for two USED source shares', async ctx => {
  const a = await issue(50_000), b = await issue(50_000)
  addCredit(ctx, a.id, 'used-share-1'); addCredit(ctx, b.id, 'used-share-2')
  await checkpoint(ctx, 'issue two independent 50,000 source barcodes')
  const v = variant(ctx, 'two-code-funded-item-100k', 100_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(v)], payments: [], storeCredits: [{ code: a.code }, { code: b.code }], saleRequestIdempotencyKey: 'a06-two-source-sale' })
  assert.equal(n(sale.storeCreditApplied), 100_000)
  assert.equal(rawCredit(a.id).status, 'USED'); assert.equal(rawCredit(b.id).status, 'USED')
  await checkpoint(ctx, 'sale 100,000; each of two source barcodes fully USED', { stock: { [v.id]: -1 } })
  const item = items(sale.id)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'NONE' })
  const successors = seed.rows('SELECT id,code,amount,status,usedAmount FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
  assert.equal(successors.length, 2, 'one successor for each USED source share')
  assert.equal(successors.reduce((sum, c) => sum + n(c.amount), 0), 100_000)
  assert.ok(successors.every(c => c.status === 'ACTIVE' && n(c.usedAmount) === 0))
  assert.ok(successors.every(c => ![a.id, b.id].includes(n(c.id))))
  addReturnCredits(ctx, ret.id, 'used-source-successor')
  assert.equal(rawCredit(a.id).status, 'USED'); assert.equal(rawCredit(b.id).status, 'USED')
  await checkpoint(ctx, `return #${ret.id}; two original USED codes retained; exactly two successors total 100,000`, { stock: { [v.id]: 1 }, note: 'source shares remain separate; no consolidation into a single successor' })
  return `Two source codes remained USED; return produced exactly ${successors.length} new codes totalling 100,000, preserving source-share count.`
})

// 6. One accepted and one blocked repeated return: the rejected duplicate must
// be mutation-free and the official return document remains in history.
await runScenario('06 duplicate return is blocked without mutating history', async ctx => {
  const v = variant(ctx, 'one-return-only-item-90k', 90_000)
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [line(v)], payments: cashPay(90_000), saleRequestIdempotencyKey: 'a06-duplicate-sale' })
  const item = items(sale.id)[0]
  await checkpoint(ctx, 'cash sale 90,000', { flow: { cash: 90_000 }, stock: { [v.id]: -1 } })
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 90_000 })
  await checkpoint(ctx, `official return #${ret.id}; 90,000 cash refunded once`, { flow: { refundCash: 90_000 }, stock: { [v.id]: 1 } })
  const before = { returns: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId), cashMoves: seed.count('CashMovement', 'shiftId=?', ctx.shiftId), stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), physical: rawPhysical(ctx.shiftId) }
  let error = ''
  try { await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 90_000 }) }
  catch (e) { error = String(e?.message ?? e) }
  assert.ok(error, 'duplicate over-return must be blocked')
  const after = { returns: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId), cashMoves: seed.count('CashMovement', 'shiftId=?', ctx.shiftId), stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), physical: rawPhysical(ctx.shiftId) }
  assert.deepEqual(after, before, 'blocked duplicate has no cash, stock, or document mutation')
  await checkpoint(ctx, `blocked duplicate return: ${error}; no extra documents or stock`, { note: 'official original return remains present; no deletion/rewrite' })
  return `Second return was blocked (${error}); the first return document remains, and cash/stock/doc totals are equivalent at the checkpoint.`
})

const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  totalScenarios: results.length, passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status !== 'PASS').length,
  policy: { fullyUsedOriginalRemainsUsed: true, livePartialSourceRestoresInPlace: true, usedSourceSuccessorCountPreserved: true, noMethodNoPhysicalPayout: true },
  results
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-additional-06-policy-flows.json'), JSON.stringify(summary, null, 2) + '\n')
const md = [
  '# تکمیل آزمون: شش جریان مستقل سیاست مالی/انبار/اعتبار', '',
  `**وضعیت:** ${summary.passed}/${summary.totalScenarios} PASS · ${summary.failed} FAIL.`,
  `**DB:** SQLite موقت ایزوله در ${summary.isolatedDatabase}.`, '',
  'Blue برابر نقد واقعی + POS واقعی − بازپرداخت نقد − بازپرداخت POS محاسبه شد و در هر checkpoint با گزارش سرویس و اسناد خام تطبیق داده شد. موجودی هر SKU با دفتر StockMovement تطبیق شد. اعتبارها، redemptions، delivery/handoff و اسناد برگشت/تعویض نیز هر مرحله snapshot شده‌اند.', '',
  ...results.map((r, i) => [`## ${i + 1}. ${r.name} — ${r.status}`, '', r.detail ?? `خطا: ${r.error}`, '', '| Checkpoint | Expected flow / Blue | Raw + report + stock + credit/document evidence |', '|---|---|---|', ...r.events.map(e => `| ${e.operation} | ${JSON.stringify({ expected: e.expected, blue: e.blue })} | ${JSON.stringify({ reported: e.reported, raw: e.raw, stock: e.stock, credits: e.credits, invoices: e.invoices, returns: e.returns })} |`), ...(r.error ? [``, `- Error: ${r.error}`, `- Post-failure: ${JSON.stringify(r.postFailure)}`] : [])].join('\n')),
  '', '## احتیاط',
  '- هیچ چک/نسیه/دریافت یا تسویهٔ نسیه‌ای اجرا نشد.',
  '- تست ششم درخواست برگشت تکراری را از مسیر رسمی سرویس رد کرد؛ سند برگشت معتبر حذف یا بازنویسی نشد.',
  '- هیچ دیتابیس زنده، stage، reset یا production source تغییر نکرد.'
].join('\n')
writeFileSync(join(out, 'deep-e2e-additional-06-policy-flows.md'), md + '\n')
console.log(`Additional 06: ${summary.passed}/${summary.totalScenarios} PASS; ${summary.failed} FAIL; report=${join(out, 'deep-e2e-additional-06-policy-flows.md')}`)
await db.$disconnect?.()
if (summary.failed > 0) process.exitCode = 1
