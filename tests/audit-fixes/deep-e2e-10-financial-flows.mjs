/**
 * Isolated 10-scenario financial E2E audit. Uses a new temporary SQLite DB built
 * from the repository migrations; never opens the configured production DB.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-10-financial-flows.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-deep-e2e-10-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated-test.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('isolated deep financial audit cashier')
const cashMethod = seed.insert('PaymentMethod', { key: 'DEEP-CASH', label: 'نقدی تست', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: 'DEEP-CARD', label: 'کارت‌خوان تست', kind: 'CARD', isActive: 1, sortOrder: 2 })
const categoryId = seed.category('deep-e2e-financial')
const today = toJalaliDate(new Date())
const results = []
const allEvents = []
let variantSeq = 0
let creditSeq = 0
const asNumber = (x) => Number(x ?? 0)
const now = () => new Date().toISOString()

function makeVariant(label, price, stock = 20) {
  const productId = seed.product(`E2E ${label} ${++variantSeq}`, categoryId)
  const id = seed.variant(productId, `DEEP-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(stock, price, id)
  return { id, label, price, baseline: stock, expected: stock }
}
function makeCredit(amount, { multiUse = false, expiresAt = null } = {}) {
  return storeCreditService.issueManual({
    amount, multiUse, maxUses: multiUse ? 10 : 1, carryRemainder: true,
    days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD
  }).then((issued) => {
    const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
    if (expiresAt) sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(expiresAt, issued.id)
    const updated = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
    return { id: Number(updated.id), code: updated.code, amount: asNumber(updated.amount), expiresAt: updated.expiresAt,
      label: `credit-${++creditSeq}`, expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }
  })
}
const line = (v, qty = 1, unitPrice = v.price) => ({ variantId: v.id, qty, unitPrice, discount: 0, tax: 0 })
const saleItems = (invoiceId) => seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const stockNow = (v) => asNumber(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
const activeCredits = (credits) => credits.map((c) => {
  const r = seed.one('SELECT id,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)
  const actual = { label: c.label, amount: asNumber(r.amount), usedAmount: asNumber(r.usedAmount), usedCount: asNumber(r.usedCount), status: r.status, expiresAt: r.expiresAt }
  if (c.expectedUsedAmount != null) {
    assert.equal(actual.usedAmount, c.expectedUsedAmount, `${c.label}: expected barcode usedAmount`)
    actual.expectedUsedAmount = c.expectedUsedAmount
  }
  if (c.expectedStatus != null) {
    assert.equal(actual.status, c.expectedStatus, `${c.label}: expected barcode status`)
    actual.expectedStatus = c.expectedStatus
  }
  const redemptions = seed.rows('SELECT amount,reversedAt,invoiceId,seq FROM "StoreCreditRedemption" WHERE creditId=? ORDER BY id', c.id)
  actual.redemptions = redemptions.map((x) => ({ amount: asNumber(x.amount), reversed: !!x.reversedAt, invoiceId: Number(x.invoiceId), seq: x.seq }))
  return actual
})
const rawPhysicalSums = (shiftId) => {
  const row = seed.one(`
    SELECT
      COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cashReceived,
      COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cardReceived
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const refunds = seed.one(`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ('RETURN_REFUND','EXCHANGE_REFUND') THEN amount ELSE 0 END),0) cashRefunded
    FROM "CashMovement" WHERE shiftId=?`, shiftId)
  const cardRefunds = seed.one(`
    SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn"
    WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return {
    cashReceived: asNumber(row.cashReceived), cardReceived: asNumber(row.cardReceived),
    cashRefunded: asNumber(refunds.cashRefunded), cardRefunded: asNumber(cardRefunds.amount)
  }
}
function expectStock(ctx, adjustments = {}) {
  for (const [id, delta] of Object.entries(adjustments)) {
    const v = ctx.variants.find((candidate) => candidate.id === Number(id))
    assert.ok(v, `known variant ${id}`)
    v.expected += delta
  }
}
async function checkpoint(ctx, operation, { cash = 0, card = 0, refundCash = 0, refundCard = 0, stock = {}, note = '' } = {}) {
  ctx.expected.cash += cash
  ctx.expected.card += card
  ctx.expected.refundCash += refundCash
  ctx.expected.refundCard += refundCard
  expectStock(ctx, stock)
  const report = await salesService.reportRows({ shiftId: ctx.shiftId })
  const actualPhysical = {
    cashReceived: asNumber(report.totals.cashTotal),
    cardReceived: asNumber(report.totals.cardTotal),
    cashRefunded: asNumber(report.totals.refundCashTotal),
    cardRefunded: asNumber(report.totals.refundCardTotal)
  }
  const independentlyCalculated = rawPhysicalSums(ctx.shiftId)
  const expectedBlue = ctx.expected.cash + ctx.expected.card - ctx.expected.refundCash - ctx.expected.refundCard
  const blueActual = asNumber(await physicalMovementForCustodyShift(ctx.shiftId))
  const blueIndependent = independentlyCalculated.cashReceived + independentlyCalculated.cardReceived
    - independentlyCalculated.cashRefunded - independentlyCalculated.cardRefunded
  assert.deepEqual(actualPhysical, {
    cashReceived: ctx.expected.cash, cardReceived: ctx.expected.card,
    cashRefunded: ctx.expected.refundCash, cardRefunded: ctx.expected.refundCard
  }, `${ctx.name}/${operation}: report subtotals match independently expected physical flows`)
  assert.deepEqual(independentlyCalculated, actualPhysical,
    `${ctx.name}/${operation}: raw document aggregate matches report subtotals`)
  assert.equal(blueActual, expectedBlue, `${ctx.name}/${operation}: blue custody movement equals expected net physical cash+POS`)
  assert.equal(blueIndependent, blueActual, `${ctx.name}/${operation}: independent raw-document blue equals production aggregate`)

  const stocks = ctx.variants.map((v) => {
    const actual = stockNow(v)
    const movement = asNumber(seed.one('SELECT COALESCE(SUM(delta),0) value FROM "StockMovement" WHERE variantId=?', v.id).value)
    assert.equal(actual, v.expected, `${ctx.name}/${operation}: ${v.label} on-hand stock`)
    assert.equal(actual, v.baseline + movement,
      `${ctx.name}/${operation}: ${v.label} stock equals baseline plus raw stock-movement ledger`)
    return { variant: v.label, baseline: v.baseline, expected: v.expected, actual, ledgerDelta: movement }
  })
  const credits = activeCredits(ctx.credits)
  const invoices = ctx.invoiceIds.map((invoiceId) => {
    const invoice = seed.one('SELECT id,receiptNo,status,grandTotal,paidTotal,orderType FROM "SaleInvoice" WHERE id=?', invoiceId)
    const paymentDocuments = seed.rows(`SELECT m.key,m.kind,p.kind paymentKind,COALESCE(SUM(p.amount),0) amount
      FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId
      WHERE p.invoiceId=? AND p.voidedAt IS NULL GROUP BY m.key,m.kind,p.kind ORDER BY m.kind,m.key`, invoiceId)
      .map((p) => ({ methodKey: p.key, methodKind: p.kind, paymentKind: p.paymentKind, amount: asNumber(p.amount) }))
    const paymentTotal = paymentDocuments.reduce((sum, p) => sum + p.amount, 0)
    const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
      .map((x) => ({ id: Number(x.id), variantId: Number(x.variantId), qty: asNumber(x.qty), unitPrice: asNumber(x.unitPrice), lineTotal: asNumber(x.lineTotal) }))
    const redemptions = seed.rows('SELECT amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', invoiceId)
    return { id: Number(invoice.id), receiptNo: invoice.receiptNo, status: invoice.status,
      type: invoice.orderType, grandTotal: asNumber(invoice.grandTotal), paidTotal: asNumber(invoice.paidTotal),
      paymentDocuments, paymentTotal, items,
      activeCreditRedemptions: redemptions.filter((r) => !r.reversedAt).length }
  })
  const returnDocuments = seed.rows(`SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,
      exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,storeCreditId,voidedAt
    FROM "SaleReturn" WHERE shiftId=? ORDER BY id`, ctx.shiftId).map((r) => ({
      id: Number(r.id), invoiceId: Number(r.invoiceId), kind: r.kind, total: asNumber(r.total),
      refundMethod: r.refundMethod, refundAmount: asNumber(r.refundAmount),
      refundStoreCreditAmount: asNumber(r.refundStoreCreditAmount), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : Number(r.exchangeInvoiceId),
      exchangeTotal: asNumber(r.exchangeTotal), exchangeDiff: asNumber(r.exchangeDiff), exchangeSettlement: r.exchangeSettlement,
      storeCreditId: r.storeCreditId == null ? null : Number(r.storeCreditId), voided: !!r.voidedAt
    }))
  const cashDocuments = seed.rows('SELECT id,type,amount,refType,refId FROM "CashMovement" WHERE shiftId=? ORDER BY id', ctx.shiftId)
    .map((r) => ({ id: Number(r.id), type: r.type, amount: asNumber(r.amount), refType: r.refType, refId: r.refId == null ? null : Number(r.refId) }))
  const stockDocuments = ctx.variants.flatMap((v) => seed.rows('SELECT id,variantId,delta,reason,state,refType,refId FROM "StockMovement" WHERE variantId=? ORDER BY id', v.id)
    .map((r) => ({ id: Number(r.id), variantId: Number(r.variantId), delta: asNumber(r.delta), reason: r.reason, state: r.state, refType: r.refType, refId: r.refId == null ? null : Number(r.refId) })))
  const event = {
    at: now(), scenario: ctx.name, operation, note,
    expected: { ...ctx.expected, blue: expectedBlue },
    reported: actualPhysical, rawIndependent: independentlyCalculated,
    blueActual, blueIndependent, stock: stocks, credits, invoices,
    documents: {
      paymentRows: seed.count('Payment', 'createdShiftId=?', ctx.shiftId),
      returnRows: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId),
      cashMovements: seed.count('CashMovement', 'shiftId=?', ctx.shiftId),
      stockMovements: stockDocuments.length, returnDocuments, cashDocuments, stockDocuments
    }
  }
  ctx.events.push(event)
  allEvents.push(event)
}
async function scenario(name, setup) {
  const shiftId = seed.insert('Shift', { name: `isolated ${name}`, number: results.length + 1, dayJalali: today, openedAt: Date.now(), userId })
  const ctx = { name, shiftId, variants: [], credits: [], invoiceIds: [], events: [],
    expected: { cash: 0, card: 0, refundCash: 0, refundCard: 0 } }
  const recordInvoice = (id) => { ctx.invoiceIds.push(Number(id)); return id }
  try {
    await checkpoint(ctx, 'BASELINE', { note: 'fresh isolated shift; opening physical movement and document totals are zero' })
    const detail = await setup(ctx, { makeVariant, makeCredit, line, saleItems, recordInvoice, checkpoint })
    results.push({ name, status: 'PASS', checkpoints: ctx.events.length, detail, events: ctx.events })
  } catch (error) {
    const failure = { message: String(error?.message ?? error), stack: String(error?.stack ?? '') }
    try {
      await checkpoint(ctx, 'POST-FAILURE rollback/state verification', {
        note: 'post-error raw document, blue, stock, and credit snapshot; expected to show no uncommitted partial exchange artifacts'
      })
      failure.postFailureState = 'verified unchanged against all prior expected totals and ledgers'
    } catch (rollbackError) {
      failure.postFailureState = `FAILED: ${String(rollbackError?.message ?? rollbackError)}`
      failure.postFailureStack = String(rollbackError?.stack ?? '')
    }
    results.push({ name, status: 'FAIL', checkpoints: ctx.events.length, failure, events: ctx.events })
    console.error(`FAIL ${name}: ${failure.message}`)
  }
}

const cashPayment = (amount) => [{ methodId: cashMethod, amount, destination: 'CASH' }]
const cardPayment = (amount) => [{ methodId: cardMethod, amount, destination: 'CARD' }]
const splitPayments = (cash, card) => [
  ...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []),
  ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])
]

await scenario('01 exact cash sale and inventory', async (ctx, h) => {
  const a = h.makeVariant('01-A', 700_000), b = h.makeVariant('01-B', 300_000); ctx.variants.push(a, b)
  const invoice = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId,
    lines: [h.line(a), h.line(b)], payments: cashPayment(1_000_000) })).id)
  await h.checkpoint(ctx, 'cash sale', { cash: 1_000_000, stock: { [a.id]: -1, [b.id]: -1 }, note: 'two item invoice, exact cash settlement' })
  assert.equal(asNumber(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?', invoice).grandTotal), 1_000_000)
  return 'Invoice 1,000,000; 1,000,000 cash; two variants decrement by one.'
})

await scenario('02 split cash and POS, partial cash return', async (ctx, h) => {
  const a = h.makeVariant('02-A', 600_000), b = h.makeVariant('02-B', 400_000); ctx.variants.push(a, b)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a), h.line(b)],
    payments: splitPayments(600_000, 400_000) })).id)
  await h.checkpoint(ctx, 'split tender sale', { cash: 600_000, card: 400_000, stock: { [a.id]: -1, [b.id]: -1 } })
  const item = h.saleItems(inv)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: inv, full: false,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 600_000 })
  await h.checkpoint(ctx, 'partial cash return', { refundCash: 600_000, stock: { [a.id]: 1 }, note: `return #${ret.id}` })
  return '1,000,000 invoice paid 600,000 cash + 400,000 POS; 600,000 cash refund; returned stock restored.'
})

await scenario('03 POS sale and POS return', async (ctx, h) => {
  const a = h.makeVariant('03-A', 850_000); ctx.variants.push(a)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)], payments: cardPayment(850_000) })).id)
  await h.checkpoint(ctx, 'POS sale', { card: 850_000, stock: { [a.id]: -1 } })
  const item = h.saleItems(inv)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: inv, full: false,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], refundMethod: 'CARD', refundAmount: 850_000,
    cardPosOverride: { acknowledgedNoReverse: true, reason: 'آزمون ایزوله برگشت POS', managerPassword: DEFAULT_MANAGER_PASSWORD } })
  await h.checkpoint(ctx, 'POS refund', { refundCard: 850_000, stock: { [a.id]: 1 }, note: `return #${ret.id}` })
  return '850,000 POS receipt reversed by 850,000 POS refund; blue returns to zero.'
})

await scenario('04 exchange down with store-credit difference', async (ctx, h) => {
  const a = h.makeVariant('04-original', 1_000_000), b = h.makeVariant('04-replacement', 800_000); ctx.variants.push(a, b)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)], payments: cashPayment(1_000_000) })).id)
  await h.checkpoint(ctx, 'source sale', { cash: 1_000_000, stock: { [a.id]: -1 } })
  const item = h.saleItems(inv)[0]
  const ex = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: inv,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], replacements: [h.line(b)], refundMode: 'STORE_CREDIT' })
  ctx.credits.push(...seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=?', ex.returnId)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'exchange-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' })))
  assert.equal(ctx.credits.reduce((sum, c) => sum + c.amount, 0), 200_000)
  h.recordInvoice(ex.exchangeInvoiceId)
  assert.equal(Number(ex.diff), -200_000)
  await h.checkpoint(ctx, 'exchange down; noncash successor', { stock: { [a.id]: 1, [b.id]: -1 }, note: `exchange return #${ex.returnId}, diff -200,000, no physical refund` })
  assert.equal(asNumber(ex.cashRefunded), 0)
  return '1,000,000 cash sale exchanged for 800,000 replacement; 200,000 retained as noncash credit; blue stays 1,000,000.'
})

await scenario('05 exchange up with cash difference', async (ctx, h) => {
  const a = h.makeVariant('05-original', 500_000), b = h.makeVariant('05-replacement', 700_000); ctx.variants.push(a, b)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)], payments: cashPayment(500_000) })).id)
  await h.checkpoint(ctx, 'source sale', { cash: 500_000, stock: { [a.id]: -1 } })
  const item = h.saleItems(inv)[0]
  const ex = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: inv,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], replacements: [h.line(b)], methodId: cashMethod })
  h.recordInvoice(ex.exchangeInvoiceId)
  assert.equal(Number(ex.diff), 200_000)
  assert.equal(Number(ex.cashReceived), 200_000)
  await h.checkpoint(ctx, 'exchange up; cash difference collected', { cash: 200_000, stock: { [a.id]: 1, [b.id]: -1 } })
  return '500,000 source + 200,000 additional cash funds 700,000 replacement; blue becomes 700,000.'
})

await scenario('06 exchange down with card refund', async (ctx, h) => {
  const a = h.makeVariant('06-original', 600_000), b = h.makeVariant('06-replacement', 500_000); ctx.variants.push(a, b)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)], payments: cardPayment(600_000) })).id)
  await h.checkpoint(ctx, 'source POS sale', { card: 600_000, stock: { [a.id]: -1 } })
  const item = h.saleItems(inv)[0]
  const ex = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: inv,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], replacements: [h.line(b)], refundMode: 'CARD',
    cardPosOverride: { acknowledgedNoReverse: true, reason: 'آزمون ایزوله تعویض و برگشت POS', managerPassword: DEFAULT_MANAGER_PASSWORD } })
  h.recordInvoice(ex.exchangeInvoiceId)
  assert.equal(Number(ex.diff), -100_000)
  assert.equal(Number(ex.cardRefunded ?? ex.refundAmount ?? 0), 100_000)
  await h.checkpoint(ctx, 'exchange down; POS difference refunded', { refundCard: 100_000, stock: { [a.id]: 1, [b.id]: -1 } })
  return '600,000 POS source exchanged for 500,000 replacement; 100,000 card refund; blue net 500,000.'
})

await scenario('07 store-credit-only sale and partial remainder', async (ctx, h) => {
  const a = h.makeVariant('07-item', 600_000); ctx.variants.push(a)
  const c = await h.makeCredit(1_000_000); ctx.credits.push(c)
  await h.checkpoint(ctx, 'manual credit fixture baseline', { note: 'credit issued in isolated harness before sale; 1,000,000 available, physical blue zero' })
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)], payments: [], storeCreditCode: c.code,
    storeCreditIdempotencyKey: `deep-07-${c.id}` })
  h.recordInvoice(sale.id)
  assert.equal(Number(sale.storeCreditApplied), 600_000)
  c.expectedUsedAmount = 600_000
  c.expectedStatus = 'PARTIALLY_USED'
  await h.checkpoint(ctx, 'credit-only sale', { stock: { [a.id]: -1 } })
  const creditNow = seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id)
  assert.equal(asNumber(creditNow.usedAmount), 600_000)
  assert.equal(asNumber(creditNow.amount) - asNumber(creditNow.usedAmount), 400_000)
  return '600,000 fully settled by credit; 400,000 remains on original barcode; blue remains zero.'
})

await scenario('08 return followed by exchange chain', async (ctx, h) => {
  const a = h.makeVariant('08-source', 500_000), b = h.makeVariant('08-replacement', 450_000); ctx.variants.push(a, b)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a, 2)], payments: cashPayment(1_000_000) })).id)
  await h.checkpoint(ctx, 'two-unit source sale', { cash: 1_000_000, stock: { [a.id]: -2 } })
  const item = h.saleItems(inv)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: inv, full: false,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 500_000 })
  await h.checkpoint(ctx, 'return first unit', { refundCash: 500_000, stock: { [a.id]: 1 }, note: `return #${ret.id}` })
  const ex = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: inv,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], replacements: [h.line(b)], refundMode: 'STORE_CREDIT' })
  h.recordInvoice(ex.exchangeInvoiceId)
  const successors = seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=?', ex.returnId)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'exchange-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }))
  ctx.credits.push(...successors)
  assert.equal(successors.reduce((sum, c) => sum + c.amount, 0), 50_000)
  assert.equal(Number(ex.diff), -50_000)
  await h.checkpoint(ctx, 'exchange remaining unit down', { stock: { [a.id]: 1, [b.id]: -1 }, note: `exchange return #${ex.returnId}` })
  return '1,000,000 two-unit sale; 500,000 cash return; remaining 500,000 unit exchanged for 450,000 and 50,000 noncash difference.'
})

await scenario('09 four-barcode sale then multi-source return', async (ctx, h) => {
  const a = h.makeVariant('09-A', 500_000), b = h.makeVariant('09-B', 500_000); ctx.variants.push(a, b)
  const credits = []
  for (let i = 0; i < 4; i++) {
    const credit = await h.makeCredit(250_000)
    credits.push(credit)
    ctx.credits.push(credit)
    await h.checkpoint(ctx, `issue barcode fixture ${i + 1}/4`, { note: `credit ${i + 1} of 4 issued; physical blue remains zero` })
  }
  await h.checkpoint(ctx, 'four barcode fixture baseline', { note: 'four independent 250,000 balances, none consumed' })
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a), h.line(b)], payments: [],
    storeCredits: credits.map((c) => ({ code: c.code })), saleRequestIdempotencyKey: `deep-09-${credits[0].id}` })
  h.recordInvoice(sale.id)
  assert.equal(Number(sale.storeCreditApplied), 1_000_000)
  for (const credit of credits) { credit.expectedUsedAmount = 250_000; credit.expectedStatus = 'USED' }
  await h.checkpoint(ctx, 'four barcode sale', { stock: { [a.id]: -1, [b.id]: -1 } })
  const item = h.saleItems(sale.id)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: false,
    lines: [{ saleItemId: Number(item.id), qty: 1 }], refundMethod: 'NONE' })
  await h.checkpoint(ctx, 'return one of two pooled-funded items', { stock: { [a.id]: 1 }, note: `return #${ret.id}; no per-item credit lineage presumed` })
  const redemptions = seed.rows('SELECT amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', sale.id)
  const reversal = redemptions.filter((r) => r.reversedAt).reduce((sum, r) => sum + asNumber(r.amount), 0)
  assert.ok(reversal <= 1_000_000, 'redemption reversals never exceed original redemptions')
  const returnSuccessors = seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'return-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }))
  assert.equal(returnSuccessors.reduce((sum, c) => sum + c.amount, 0), 500_000,
    'returned 500,000 is restored as pooled source successors without assigning them to particular goods')
  ctx.credits.push(...returnSuccessors)
  await h.checkpoint(ctx, 'inspect return successor barcodes', { note: 'each returned source credit successor is independently tracked by amount/status; no source-to-line allocation assumed' })
  const replacement = h.makeVariant('09-exchange-replacement', 450_000); ctx.variants.push(replacement)
  const remainingItem = h.saleItems(sale.id).find((row) => Number(row.variantId) === b.id)
  const exchangeInput = { userId, shiftId: ctx.shiftId, invoiceId: sale.id,
    lines: [{ saleItemId: Number(remainingItem.id), qty: 1 }], replacements: [h.line(replacement)], refundMode: 'STORE_CREDIT' }
  const preview = await salesService.previewExchangeFunding(exchangeInput)
  assert.equal(preview.ok, true, `09 exchange preview: ${preview.error ?? ''}`)
  assert.equal(Number(preview.nominalDiff), -50_000, 'the sticker-price difference remains 50,000')
  exchangeInput.expectedSettlementDiff = Number(preview.effectiveDiff)
  const ex = await salesService.createExchange(exchangeInput)
  h.recordInvoice(ex.exchangeInvoiceId)
  assert.equal(Number(ex.diff), Number(preview.effectiveDiff), 'committed effective settlement matches preview')
  const exchangeSuccessors = seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id', ex.returnId)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'exchange-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }))
  ctx.credits.push(...exchangeSuccessors)
  await h.checkpoint(ctx, 'exchange remaining item after four-credit sale and return', { stock: { [b.id]: 1, [replacement.id]: -1 }, note: `exchange return #${ex.returnId}; four source barcodes stayed pooled` })
  assert.equal(ctx.credits.length, 4 + returnSuccessors.length + exchangeSuccessors.length)
  return `Four independent barcodes funded 1,000,000; 500,000 returned value restored through ${returnSuccessors.length} pooled successors; the remaining item has a 50,000 nominal price gap, but the actual settlement preview is ${asNumber(preview.effectiveDiff)} because that source-credit share is restored to its barcode lineage. Redemption reversal ${reversal}; no pooled allocation to goods is assumed.`
})

await scenario('10 mixed-tender sale, return, and exchange', async (ctx, h) => {
  const a = h.makeVariant('10-source', 1_000_000), b = h.makeVariant('10-exchange', 700_000), c = h.makeVariant('10-next', 600_000); ctx.variants.push(a, b, c)
  const inv = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a)],
    payments: splitPayments(400_000, 600_000) })).id)
  await h.checkpoint(ctx, 'mixed tender sale', { cash: 400_000, card: 600_000, stock: { [a.id]: -1 } })
  const sourceItem = h.saleItems(inv)[0]
  const ex = await salesService.createExchange({ userId, shiftId: ctx.shiftId, invoiceId: inv,
    lines: [{ saleItemId: Number(sourceItem.id), qty: 1 }], replacements: [h.line(b)], refundMode: 'STORE_CREDIT' })
  h.recordInvoice(ex.exchangeInvoiceId)
  const successors = seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=?', ex.returnId)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'exchange-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }))
  ctx.credits.push(...successors)
  assert.equal(successors.reduce((sum, c) => sum + c.amount, 0), 300_000)
  assert.equal(Number(ex.diff), -300_000)
  await h.checkpoint(ctx, 'mixed tender exchange down', { stock: { [a.id]: 1, [b.id]: -1 } })
  const exchItem = h.saleItems(ex.exchangeInvoiceId)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: ex.exchangeInvoiceId, full: false,
    lines: [{ saleItemId: Number(exchItem.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 700_000 })
  await h.checkpoint(ctx, 'return exchange replacement for cash', { refundCash: 700_000, stock: { [b.id]: 1 }, note: `return #${ret.id}` })
  const final = h.makeVariant('10-final-sale', 500_000); ctx.variants.push(final)
  const finalSale = h.recordInvoice((await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(final)], payments: cardPayment(500_000) })).id)
  await h.checkpoint(ctx, 'final POS sale after return', { card: 500_000, stock: { [final.id]: -1 } })
  return '1,000,000 split 400,000 cash + 600,000 POS; exchange down to 700,000; 700,000 cash refund; subsequent 500,000 POS sale. Blue = 200,000 net.'
})

await scenario('11 four-barcode pooled return without forced attribution', async (ctx, h) => {
  const a = h.makeVariant('11-returned', 400_000), b = h.makeVariant('11-retained', 600_000); ctx.variants.push(a, b)
  const credits = []
  for (let i = 0; i < 4; i++) {
    const credit = await h.makeCredit(250_000)
    credits.push(credit)
    ctx.credits.push(credit)
    await h.checkpoint(ctx, `issue barcode ${i + 1}/4`, { note: `individual issuance checkpoint; blue remains zero` })
  }
  const sale = await salesService.create({ userId, shiftId: ctx.shiftId, lines: [h.line(a), h.line(b)], payments: [],
    storeCredits: credits.map((c) => ({ code: c.code })), saleRequestIdempotencyKey: `deep-11-${credits[0].id}` })
  h.recordInvoice(sale.id)
  assert.equal(Number(sale.storeCreditApplied), 1_000_000)
  for (const credit of credits) { credit.expectedUsedAmount = 250_000; credit.expectedStatus = 'USED' }
  await h.checkpoint(ctx, 'four-code sale', { stock: { [a.id]: -1, [b.id]: -1 } })
  const returnedItem = h.saleItems(sale.id)[0]
  const ret = await salesService.createReturn({ userId, shiftId: ctx.shiftId, invoiceId: sale.id, full: false,
    lines: [{ saleItemId: Number(returnedItem.id), qty: 1 }], refundMethod: 'NONE' })
  await h.checkpoint(ctx, 'four-code funded partial return', { stock: { [a.id]: 1 }, note: `return #${ret.id}; pooled sources remain unattributed to goods` })
  const successors = seed.rows('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
    .map((r) => ({ id: Number(r.id), code: r.code, amount: asNumber(r.amount), expiresAt: r.expiresAt, label: 'return-successor', expectedUsedAmount: 0, expectedStatus: 'ACTIVE' }))
  assert.equal(successors.reduce((sum, c) => sum + c.amount, 0), 400_000)
  ctx.credits.push(...successors)
  await h.checkpoint(ctx, 'four-code return successor status', { note: 'every source and successor barcode is recorded; pooled allocation is not inferred' })
  return `Four barcodes × 250,000 funded 1,000,000; returned 400,000 value generated ${successors.length} successors; source attribution remains pooled.`
})

const summary = {
  generatedAt: now(), isolatedDatabase: process.env.HARNESS_DB,
  blueDefinition: 'cashReceived + posReceived - cashRefunded - posRefunded; store credit and debt are excluded',
  blueSource: 'CustodyAggregateService.physicalMovementForCustodyShift uses salesService.reportRows; each checkpoint independently sums physical Payment kinds and active return documents/CashMovement rows.',
  totalScenarios: results.length,
  completed: results.filter((r) => r.status === 'PASS').length,
  failed: results.filter((r) => r.status === 'FAIL').length,
  blocked: 0,
  results,
  events: allEvents
}
const outDir = resolve(process.cwd(), 'reports')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'deep-e2e-10-financial-flows.json'), `${JSON.stringify(summary, null, 2)}\n`)
const md = [
  '# Deep E2E financial flows — isolated harness', '',
  `Generated: ${summary.generatedAt}`, '',
  `**Overall:** ${summary.completed}/${summary.totalScenarios} PASS · ${summary.failed} FAIL · ${summary.blocked} BLOCKED.`, '',
  `**Blue reference:** ${summary.blueDefinition}. The value was independently recomputed from raw test-harness financial documents at every checkpoint and compared to the service/report aggregate.`, '',
  '| # | Scenario | Status | Checkpoints | Result / failure |', '|---:|---|---|---:|---|',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.status} | ${r.checkpoints} | ${(r.detail ?? r.failure?.message ?? '').replaceAll('|', '\\|')} |`),
  '', '## Failure diagnostics',
  ...results.filter((r) => r.status === 'FAIL').flatMap((r) => [
    `### ${r.name}`,
    `- Error: ${r.failure.message}`,
    `- After the failed operation: ${r.failure.postFailureState ?? 'no verification available'}.`,
    `- Stack: \`${String(r.failure.stack ?? '').replaceAll('\n', ' · ').replaceAll('|', '\\|')}\``, ''
  ]),
  '', '## Checkpoint evidence',
  ...allEvents.flatMap((e) => [
    `### ${e.scenario} — ${e.operation}`,
    `- Expected blue: ${e.expected.blue}; production actual: ${e.blueActual}; independently calculated from raw documents: ${e.blueIndependent}.`,
    `- Physical totals expected/reported: cash received ${e.expected.cash}/${e.reported.cashReceived}; POS received ${e.expected.card}/${e.reported.cardReceived}; cash refunds ${e.expected.refundCash}/${e.reported.cashRefunded}; POS refunds ${e.expected.refundCard}/${e.reported.cardRefunded}.`,
    `- Stock: ${e.stock.map((s) => `${s.variant} ${s.baseline}→${s.actual} (expected ${s.expected}; raw ledger Δ ${s.ledgerDelta})`).join('; ') || 'no variants registered yet'}.`,
    `- Documents: ${JSON.stringify(e.documents)}. Credits: ${JSON.stringify(e.credits)}. Invoices: ${JSON.stringify(e.invoices)}.`,
    e.note ? `- Note: ${e.note}` : '', ''
  ]),
  '## Limitations and unexecuted checks',
  '- This run uses a fresh temporary SQLite harness populated by repository migrations, not a live shop database.',
  '- Tests cover service-layer sales, returns, exchanges, physical cash/POS accounting, inventory stock movements, and credit state. They do not exercise desktop UI, physical cash drawer hardware, real POS terminals, printing, external accounting integrations, network concurrency, or production deployment migrations.',
  '- No checks, customer debt, credit sale, debt receipt, or debt settlement were used.',
  '- Detailed raw checkpoint records are in `deep-e2e-10-financial-flows.json`.'
].filter((x) => x !== '')
writeFileSync(join(outDir, 'deep-e2e-10-financial-flows.md'), `${md.join('\n')}\n`)
console.log(`RESULT ${summary.completed}/${summary.totalScenarios} PASS, ${summary.failed} FAIL; report=${join(outDir, 'deep-e2e-10-financial-flows.md')}; db=${process.env.HARNESS_DB}`)
if (summary.failed > 0 || summary.completed < 10) process.exitCode = 1
await db.$disconnect?.()
