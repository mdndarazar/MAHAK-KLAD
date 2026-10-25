/** S4 zero-difference integration: actual 5M gift + 20M cash sale across 3 lines.
 * Proves source roots, paired transfer, persisted item matrix, and pooled
 * gift-first settlement when a replacement item is returned. This is not
 * sign-off for nonzero exchange diff.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s4-three-line-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s4-three-line-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { allocateExchangeFundingByLine } = await import('../../src/shared/exchangeFundingAllocation.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S4 exact integration')
const categoryId = seed.category('S4 exact category')
const productId = seed.product('S4 exact item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S4 exact shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantNo = 0
const variant = (price) => {
  const id = seed.variant(productId, `S4-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=30, salePrice=? WHERE id=?').run(price, id)
  return id
}
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })

const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 5_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'S4 mixed-source fixture', userId
}))
const sourcePrices = [10_000_000, 10_000_000, 5_000_000]
const sourceVariants = sourcePrices.map((price) => variant(price))
const replacementVariants = sourcePrices.map((price) => variant(price))
const sourceSale = await salesService.create({
  userId,
  shiftId,
  lines: sourceVariants.map((variantId, index) => item(variantId, sourcePrices[index])),
  payments: [{ methodId: cashMethodId, amount: 20_000_000, destination: 'CASH' }],
  storeCreditCode: gift.code,
  storeCreditAmount: 5_000_000,
  storeCreditIdempotencyKey: 's4-exact-mixed-source-sale'
})
assert.equal(sourceSale.grandTotal, 25_000_000)
assert.equal(sourceSale.storeCreditApplied, 5_000_000)
const sourceView = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.deepEqual(sourceView.unresolved, [])
assert.deepEqual(sourceView.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
], 'the ordinary-sale reader proves both real tender roots before the exchange attempt')

// Compute the candidate S4 item matrix from the real persisted source events,
// but do not persist or treat this planner output as authorization.
const candidateLineIds = [1001, 1002, 1003]
const candidateMatrix = allocateExchangeFundingByLine(
  sourcePrices.map((amount, index) => ({ saleItemId: candidateLineIds[index], amount })),
  sourceView.sources.map(({ event, sourceKind, available }) => ({
    sourceEventId: Number(event.id), sourceKind, amount: available
  }))
)
const candidateByLineAndKind = candidateMatrix
  .map(({ saleItemId, sourceKind, amount }) => ({
    saleItemId, sourceKind, amount,
    lineIndex: candidateLineIds.indexOf(saleItemId)
  }))
  .sort((a, b) => a.lineIndex - b.lineIndex || a.sourceKind.localeCompare(b.sourceKind))
  .map(({ saleItemId, sourceKind, amount }) => ({ saleItemId, sourceKind, amount }))
assert.deepEqual(candidateByLineAndKind, [
  { saleItemId: 1001, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: 1001, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: 1002, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: 1002, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: 1003, sourceKind: 'SOURCE_CASH', amount: 4_000_000 },
  { saleItemId: 1003, sourceKind: 'SOURCE_GIFT', amount: 1_000_000 }
], 'candidate matrix reconciles each of the three replacement lines exactly')

const sourceItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sourceSale.id)
const creditsBeforeExchange = seed.count('StoreCredit', '1=1')
const exchangeRequest = {
  invoiceId: sourceSale.id,
  lines: sourceItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  replacements: replacementVariants.map((variantId, index) => item(variantId, sourcePrices[index])),
  refundMode: 'STORE_CREDIT', userId, shiftId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'S4 equal-value mixed-source integration',
  idempotencyKey: 'exchange-request:integration-s4-0001'
}
const exchange = await salesService.createExchange(exchangeRequest)
const afterFirstExchange = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}
const replayedExchange = await salesService.createExchange(exchangeRequest)
assert.equal(replayedExchange.replayed, true, 'same exchange request key/payload replays instead of retrying mutations')
assert.equal(replayedExchange.returnId, exchange.returnId)
assert.equal(replayedExchange.exchangeInvoiceId, exchange.exchangeInvoiceId)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}, afterFirstExchange, 'same-key replay must have no duplicate return, child, tender, transfer, credit, or stock effects')
const afterMismatchProbe = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}
await assert.rejects(() => salesService.createExchange({ ...exchangeRequest, note: 'different economic request' }),
  /کلید.*درخواست متفاوت|payload متفاوت|fingerprint/iu,
  'same key bound to a different exchange payload must be rejected as an idempotency conflict')
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}, afterMismatchProbe, 'mismatched-key rejection must have no transactional effects')
assert.equal(exchange.returnTotal, 25_000_000)
assert.equal(exchange.exchangeTotal, 25_000_000)
assert.equal(exchange.diff, 0)
assert.equal(seed.count('StoreCredit', '1=1'), creditsBeforeExchange,
  'a zero-difference exchange issues no new B/N balance')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'the original gift root is carried, never reactivated')

const childItems = seed.rows('SELECT id, qty FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', exchange.exchangeInvoiceId)
const childView = await getCurrentExchangeFundingSources(db, exchange.exchangeInvoiceId)
assert.equal(childView.snapshotExists, true)
assert.equal(childView.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(childView.unresolved, [])
assert.deepEqual(childView.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
])
assert.deepEqual(childView.lineAllocations.map(({ saleItemId, sourceKind, amount }) => ({ saleItemId, sourceKind, amount })), [
  { saleItemId: childItems[0].id, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: childItems[1].id, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: childItems[2].id, sourceKind: 'SOURCE_CASH', amount: 4_000_000 },
  { saleItemId: childItems[0].id, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: childItems[1].id, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: childItems[2].id, sourceKind: 'SOURCE_GIFT', amount: 1_000_000 }
])
const transferRows = seed.rows(`SELECT kind, amount, parentEventId FROM "ExchangeFundingEvent"
  WHERE returnId=? AND kind IN ('TRANSFER_OUT','TRANSFER_IN') ORDER BY id`, exchange.returnId)
assert.equal(transferRows.filter(({ kind }) => kind === 'TRANSFER_OUT').length, 2)
assert.equal(transferRows.filter(({ kind }) => kind === 'TRANSFER_IN').length, 2)
assert.equal(transferRows.filter(({ kind }) => kind === 'TRANSFER_OUT').reduce((sum, row) => sum + Number(row.amount), 0), -25_000_000)
assert.equal(transferRows.filter(({ kind }) => kind === 'TRANSFER_IN').reduce((sum, row) => sum + Number(row.amount), 0), 25_000_000)
for (const incoming of transferRows.filter(({ kind }) => kind === 'TRANSFER_IN')) {
  assert.ok(transferRows.some((outgoing) => outgoing.kind === 'TRANSFER_OUT' &&
    Number(outgoing.parentEventId) === Number(incoming.parentEventId) &&
    Number(outgoing.amount) === -Number(incoming.amount)), 'every gift/cash transfer-in has its exact paired transfer-out')
}

// Reconcile the actual exchange row with the report and the persisted funding
// journal. Carried ExchangeCredit is not a new cash/card receipt.
const reportBefore = await salesService.exchangeList({ returnId: exchange.returnId, take: 1 })
assert.equal(reportBefore.rows.length, 1)
const reportRow = reportBefore.rows[0]
assert.equal(reportRow.returnTotal, 25_000_000)
assert.equal(reportRow.exchangeTotal, 25_000_000)
assert.equal(reportRow.diff, 0)
assert.equal(reportRow.returnedItems.reduce((sum, row) => sum + row.lineTotal, 0), 25_000_000)
assert.equal(reportRow.replacementItems.reduce((sum, row) => sum + row.lineTotal, 0), 25_000_000)
assert.equal(reportRow.cashReceived, 0, 'the child ExchangeCredit is not reported as cash received')
assert.equal(reportRow.cardReceived, 0, 'carried source funding is not reported as a new card receipt')
assert.equal(reportBefore.totals.returnTotal, 25_000_000)
assert.equal(reportBefore.totals.exchangeTotal, 25_000_000)
assert.equal(reportBefore.totals.diffTotal, 0)
assert.equal(reportBefore.totals.cashReceivedTotal, 0)
assert.equal(reportBefore.totals.cardReceivedTotal, 0)
assert.equal(childView.sources.reduce((sum, source) => sum + source.available, 0), reportRow.exchangeTotal,
  'the report replacement amount reconciles to proven child funding, without claiming a new tender')
const reportDetail = await salesService.exchangeGet({ id: exchange.returnId })
assert.deepEqual({ returnTotal: reportDetail.returnTotal, exchangeTotal: reportDetail.exchangeTotal,
  diff: reportDetail.diff, cashReceived: reportDetail.cashReceived, cardReceived: reportDetail.cardReceived },
{ returnTotal: reportRow.returnTotal, exchangeTotal: reportRow.exchangeTotal,
  diff: reportRow.diff, cashReceived: reportRow.cashReceived, cardReceived: reportRow.cardReceived })
assert.equal(seed.count('CashMovement', '1=1'), afterFirstExchange.cashMovements,
  'reading exchange report/detail is side-effect free')

const thirdChildItemId = childItems[2].id
const preview = await salesService.returnProvenancePreview({
  invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: thirdChildItemId, qty: 1 }]
})
assert.equal(preview.returnTotal, 5_000_000)
assert.deepEqual(preview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 5_000_000 }
], 'the whole gift-credit pool is used first; the replacement line matrix is not prorated')
assert.equal(preview.settlementReady, true)
assert.equal(preview.cashRight, 0)
assert.equal(preview.giftOpportunity, 5_000_000,
  'a 5M-rial returned item receives 5M credit when the original invoice used a 5M-rial barcode')
const beforeChildReturn = {
  returns: seed.count('SaleReturn', 'invoiceId=?', exchange.exchangeInvoiceId),
  cashMovements: seed.count('CashMovement', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  entitlements: seed.count('ReturnEntitlement', '1=1'),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  stockMovements: seed.count('StockMovement', '1=1')
}
const childReturn = await salesService.createReturn({
  invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: thirdChildItemId, qty: 1 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  idempotencyKey: 's4-pooled-child-return-500k-0001'
})
assert.equal(childReturn.total, 5_000_000)
assert.equal(childReturn.refundMethod, 'NONE')
assert.equal(childReturn.refundAmount, 0)
assert.equal(childReturn.creditOpportunity.restored, 5_000_000)
assert.deepEqual(childReturn.creditOpportunity.pendingDelivery.map(({ amount }) => amount), [5_000_000],
  'one 5M barcode is staged for delivery, not 1M credit plus 4M money')
assert.equal(seed.count('SaleReturn', 'invoiceId=? AND voidedAt IS NULL', exchange.exchangeInvoiceId),
  beforeChildReturn.returns + 1)
assert.equal(seed.count('CashMovement', '1=1'), beforeChildReturn.cashMovements,
  'returning the credit-funded value creates no cash movement')
const childPooledAllocation = seed.rows('SELECT sourceKind, amountDelta, allocationVersion FROM "ExchangeFundingReturnLineAllocation" WHERE returnId=? AND eventKind=?',
  childReturn.id, 'ALLOCATION')
assert.deepEqual(childPooledAllocation.map(({ sourceKind, amountDelta, allocationVersion }) => ({
  sourceKind, amountDelta: Number(amountDelta), allocationVersion
})), [{ sourceKind: 'SOURCE_GIFT', amountDelta: 5_000_000, allocationVersion: 4 }])
const pooledReturnEventCount = seed.count('ExchangeFundingEvent', '1=1')
const replayedChildReturn = await salesService.createReturn({
  invoiceId: exchange.exchangeInvoiceId, lines: [{ saleItemId: thirdChildItemId, qty: 1 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  idempotencyKey: 's4-pooled-child-return-500k-0001'
})
assert.equal(replayedChildReturn.replayed, true, 'same-key child-return retry replays its settled result')
assert.equal(seed.count('ExchangeFundingEvent', '1=1'), pooledReturnEventCount,
  'same-key replay creates no additional transfer, credit or ledger events')

// Void the child return first: pooled source attribution, issued barcode, and
// physical stock must reverse together before the parent exchange is voidable.
const voidedChildReturn = await salesService.returnDelete({
  id: childReturn.id, userId, reason: 'S4 pooled child-return reversal integration',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'S4 pooled child-return reversal integration'
})
assert.equal(voidedChildReturn.voided, true)
assert.ok(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', childReturn.id).voidedAt)
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnId=? AND eventKind=?',
  childReturn.id, 'REVERSAL'), 1, 'pooled allocation has one immutable inverse row')
assert.equal(seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?',
  childReturn.creditOpportunity.pendingDelivery[0].creditId).status, 'VOID',
  'void invalidates the unclaimed pooled barcode')
const replayAfterChildVoid = await salesService.createReturn({
  invoiceId: exchange.exchangeInvoiceId, lines: [{ saleItemId: thirdChildItemId, qty: 1 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  idempotencyKey: 's4-pooled-child-return-500k-0001'
})
assert.equal(replayAfterChildVoid.replayed, true)
assert.ok(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', childReturn.id).voidedAt,
  'retry after void replays history and cannot resurrect the return')

// S12/S4 reversal probe: now void the untouched exchange pair and verify both source
// balances and stock return exactly, while the original gift redemption stays USED.
const sourceFundingBeforeVoid = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.deepEqual(sourceFundingBeforeVoid.activeReturnIds, [exchange.returnId])
assert.equal(sourceFundingBeforeVoid.sources.reduce((sum, row) => sum + row.available, 0), 0)
const sourceAndReplacementStockBeforeVoid = seed.rows(
  'SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
  ...sourceVariants, ...replacementVariants
)
const cashMovementsBeforeVoid = seed.count('CashMovement', '1=1')
const voidedExchange = await salesService.returnDelete({
  id: exchange.returnId, userId, reason: 'S4 mixed transfer reversal integration',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'S4 mixed transfer reversal integration'
})
assert.equal(voidedExchange.exchangeVoided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'voiding the exchange restores the original sale, not a second spendable gift balance')
assert.equal(seed.count(`ExchangeFundingEvent`, 'returnId=? AND kind IN (?, ?)', exchange.returnId,
  'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN'), 4, 'both mixed-source transfer pairs are reversed append-only')
const sourceFundingAfterVoid = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.deepEqual(sourceFundingAfterVoid.activeReturnIds, [])
assert.deepEqual(sourceFundingAfterVoid.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
])
assert.deepEqual(seed.rows(
  'SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
  ...sourceVariants, ...replacementVariants
), sourceAndReplacementStockBeforeVoid.map((row, index) => ({
  ...row,
  stock: Number(row.stock) + (index < sourceVariants.length ? -1 : 1)
})), 'void preserves the unreceived source return and reverses the replacement sale exactly once')
assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBeforeVoid,
  'zero-difference exchange reversal moves no cash')
assert.equal(seed.one('SELECT voidedAt IS NOT NULL AS voided FROM "SaleInvoice" WHERE id=?', exchange.exchangeInvoiceId).voided, 1)
assert.equal(seed.one('SELECT voidedAt IS NOT NULL AS voided FROM "SaleReturn" WHERE id=?', exchange.returnId).voided, 1)
const effectsAfterVoid = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}
const replayAfterVoid = await salesService.createExchange(exchangeRequest)
assert.equal(replayAfterVoid.replayed, true)
assert.equal(replayAfterVoid.returnId, exchange.returnId)
assert.equal(replayAfterVoid.exchangeInvoiceId, exchange.exchangeInvoiceId)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id',
    ...sourceVariants, ...replacementVariants)
}, effectsAfterVoid, 'retry of the original key after a later void must replay, never resurrect the exchange')

// S4 variation: repeat the exact three-line exchange after the first pair is
// safely voided, but reverse both source-line order and replacement-line order.
// Persisted per-item allocations must remain tied to value/root, not request order.
const reversedSourceItems = [...sourceItems].reverse()
const reversedReplacementVariants = [...replacementVariants].reverse()
const reversedRequest = {
  ...exchangeRequest,
  lines: reversedSourceItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  replacements: reversedReplacementVariants.map((variantId) => {
    const match = replacementVariants.indexOf(variantId)
    return item(variantId, sourcePrices[match])
  }),
  idempotencyKey: 'exchange-request:integration-s4-reversed-order-0001',
  note: 'S4 reordered three-line exchange regression'
}
const reversedExchangeBefore = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cash: seed.count('CashMovement', '1=1')
}
const reversedExchange = await salesService.createExchange(reversedRequest, { goodsReceiptRequired: false })
assert.equal(reversedExchange.returnTotal, 25_000_000)
assert.equal(reversedExchange.exchangeTotal, 25_000_000)
assert.equal(reversedExchange.diff, 0)
const reorderedChildView = await getCurrentExchangeFundingSources(db, reversedExchange.exchangeInvoiceId)
assert.deepEqual(reorderedChildView.unresolved, [])
assert.equal(reorderedChildView.lineAllocationStatus, 'PERSISTED_RECONCILED')
const reorderedItems = seed.rows(`SELECT id, variantId, lineTotal FROM "SaleInvoiceItem"
  WHERE invoiceId=? ORDER BY id`, reversedExchange.exchangeInvoiceId)
for (const lineRow of reorderedItems) {
  const lineValue = Number(lineRow.lineTotal)
  const giftShare = Number(5_000_000n * BigInt(lineValue) / 25_000_000n)
  const cashShare = lineValue - giftShare
  const cells = reorderedChildView.lineAllocations.filter((row) => row.saleItemId === Number(lineRow.id))
  assert.deepEqual(cells.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CASH', amount: cashShare },
    { sourceKind: 'SOURCE_GIFT', amount: giftShare }
  ], 'reordered S4 items retain the canonical per-line gift/cash shares')
}
assert.deepEqual(reorderedChildView.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
])
assert.equal(seed.count('StoreCredit', '1=1'), reversedExchangeBefore.credits,
  'reordered S4 exchange issues no credit barcode')
assert.equal(seed.count('CashMovement', '1=1'), reversedExchangeBefore.cash,
  'reordered S4 exchange moves no cash')
const reorderedReport = await salesService.exchangeGet({ id: reversedExchange.returnId })
assert.equal(reorderedReport.returnTotal, 25_000_000)
assert.equal(reorderedReport.exchangeTotal, 25_000_000)
assert.equal(reorderedReport.diff, 0)
assert.equal(reorderedReport.cashReceived, 0)
assert.equal(reorderedReport.cardReceived, 0)
const reversedExchangeReplay = await salesService.createExchange(reversedRequest, { goodsReceiptRequired: false })
assert.equal(reversedExchangeReplay.replayed, true)
assert.equal(reversedExchangeReplay.exchangeInvoiceId, reversedExchange.exchangeInvoiceId)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  cash: seed.count('CashMovement', '1=1')
}, {
  returns: reversedExchangeBefore.returns + 1,
  children: reversedExchangeBefore.children + 1,
  events: reversedExchangeBefore.events + 4,
  payments: reversedExchangeBefore.payments + 1,
  credits: reversedExchangeBefore.credits,
  cash: reversedExchangeBefore.cash
}, 'reordered same-key retry has one source return, one child, and exactly two transfer pairs')
const reversedVoid = await salesService.returnDelete({
  id: reversedExchange.returnId, userId, reason: 'S4 reordered exchange safe void',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'S4 reordered exchange safe void'
})
assert.equal(reversedVoid.exchangeVoided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
const rootFundingAfterReorderedVoid = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.deepEqual(rootFundingAfterReorderedVoid.unresolved, [])
assert.deepEqual(rootFundingAfterReorderedVoid.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
])
assert.equal(seed.count('CashMovement', '1=1'), reversedExchangeBefore.cash)

async function pooledAcceptanceCase(label, creditAmount) {
  const cashAmount = 10_000_000 - creditAmount
  const caseCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount: creditAmount, multiUse: false, maxUses: 1,
    carryRemainder: false, days: 30, note: `${label} pooled-return fixture`, userId
  }))
  const sourceCaseVariants = [variant(5_000_000), variant(5_000_000)]
  const replacementCaseVariants = [variant(5_000_000), variant(5_000_000)]
  const caseSale = await salesService.create({
    userId, shiftId, lines: sourceCaseVariants.map((variantId) => item(variantId, 5_000_000)),
    payments: cashAmount > 0 ? [{ methodId: cashMethodId, amount: cashAmount, destination: 'CASH' }] : [],
    storeCreditCode: caseCredit.code, storeCreditAmount: creditAmount,
    storeCreditIdempotencyKey: `${label}-pooled-sale`
  })
  const caseItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', caseSale.id)
  const caseExchange = await salesService.createExchange({
    invoiceId: caseSale.id, lines: caseItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
    replacements: replacementCaseVariants.map((variantId) => item(variantId, 5_000_000)),
    refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD,
    overrideReason: `${label} zero-difference pooled-return acceptance`,
    idempotencyKey: `${label}-pooled-exchange`
  }, { goodsReceiptRequired: false })
  const childItemsForCase = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',
    caseExchange.exchangeInvoiceId)
  const previewCase = await salesService.returnProvenancePreview({ invoiceId: caseExchange.exchangeInvoiceId,
    lines: [{ saleItemId: childItemsForCase[0].id, qty: 1 }] })
  const expectedCredit = Math.min(5_000_000, creditAmount)
  const expectedCash = 5_000_000 - expectedCredit
  assert.equal(previewCase.returnTotal, 5_000_000)
  assert.equal(previewCase.giftOpportunity, expectedCredit, `${label}: pooled credit is min(R,C), not per-line share`)
  assert.equal(previewCase.cashRight, expectedCash, `${label}: only the excess over pooled credit is real-money right`)
  assert.equal(previewCase.settlementReady, true)
  const actualReturn = await salesService.createReturn({
    invoiceId: caseExchange.exchangeInvoiceId,
    lines: [{ saleItemId: childItemsForCase[0].id, qty: 1 }],
    refundMethod: expectedCash > 0 ? 'CASH' : 'NONE', refundAmount: expectedCash,
    userId, shiftId
  })
  assert.equal(actualReturn.total, 5_000_000)
  assert.equal(actualReturn.creditOpportunity.restored, expectedCredit)
  assert.equal(actualReturn.refundAmount, expectedCash,
    `${label}: the real-money remainder is actually paid only under the customer's selected tender`)
  assert.equal(actualReturn.creditOpportunity.pendingDelivery.reduce((sum, row) => sum + row.amount, 0), expectedCredit)
  const ledgerByKind = seed.rows('SELECT sourceKind, SUM(amountDelta) AS amount FROM "ExchangeFundingReturnLineAllocation" WHERE returnId=? AND eventKind=? GROUP BY sourceKind ORDER BY sourceKind',
    actualReturn.id, 'ALLOCATION').map((row) => ({ sourceKind: row.sourceKind, amount: Number(row.amount) }))
  const expectedLedger = []
  if (expectedCash > 0) expectedLedger.push({ sourceKind: 'SOURCE_CASH', amount: expectedCash })
  expectedLedger.push({ sourceKind: 'SOURCE_GIFT', amount: expectedCredit })
  assert.deepEqual(ledgerByKind, expectedLedger, `${label}: v4 ledger matches pooled preview and actual settlement`)
  assert.ok(seed.rows('SELECT id FROM "ExchangeFundingReturnLineAllocation" WHERE returnId=? AND allocationVersion=4',
    actualReturn.id).length > 0)

  const remainingCreditPool = creditAmount - expectedCredit
  const expectedSecondCredit = Math.min(5_000_000, remainingCreditPool)
  const expectedSecondCash = 5_000_000 - expectedSecondCredit
  const secondPreview = await salesService.returnProvenancePreview({ invoiceId: caseExchange.exchangeInvoiceId,
    lines: [{ saleItemId: childItemsForCase[1].id, qty: 1 }] })
  assert.equal(secondPreview.returnTotal, 5_000_000)
  assert.equal(secondPreview.giftOpportunity, expectedSecondCredit,
    `${label}: subsequent return spends only the pooled credit still unreturned`)
  assert.equal(secondPreview.cashRight, expectedSecondCash)
  const secondReturn = await salesService.createReturn({
    invoiceId: caseExchange.exchangeInvoiceId,
    lines: [{ saleItemId: childItemsForCase[1].id, qty: 1 }],
    refundMethod: expectedSecondCash > 0 ? 'CASH' : 'NONE', refundAmount: expectedSecondCash,
    userId, shiftId
  })
  assert.equal(secondReturn.creditOpportunity.restored, expectedSecondCredit)
  assert.equal(secondReturn.refundAmount, expectedSecondCash)
  const secondLedgerByKind = seed.rows('SELECT sourceKind, SUM(amountDelta) AS amount FROM "ExchangeFundingReturnLineAllocation" WHERE returnId=? AND eventKind=? GROUP BY sourceKind ORDER BY sourceKind',
    secondReturn.id, 'ALLOCATION').map((row) => ({ sourceKind: row.sourceKind, amount: Number(row.amount) }))
  const expectedSecondLedger = []
  if (expectedSecondCash > 0) expectedSecondLedger.push({ sourceKind: 'SOURCE_CASH', amount: expectedSecondCash })
  if (expectedSecondCredit > 0) expectedSecondLedger.push({ sourceKind: 'SOURCE_GIFT', amount: expectedSecondCredit })
  assert.deepEqual(secondLedgerByKind, expectedSecondLedger,
    `${label}: active return history keeps pooled credit and money rights cumulative`)
  return { previewCase, actualReturn, secondPreview, secondReturn, caseExchange }
}
const creditSix = await pooledAcceptanceCase('pooled-c600', 6_000_000)
assert.equal(creditSix.previewCase.giftOpportunity, 5_000_000,
  'R=500k,C=600k returns only the 500k item value as credit')
const creditFour = await pooledAcceptanceCase('pooled-c400', 4_000_000)
assert.equal(creditFour.previewCase.giftOpportunity, 4_000_000)
assert.equal(creditFour.previewCase.cashRight, 1_000_000,
  'R=500k,C=400k returns 400k credit plus 100k actual-money right')

// Customer-selected conversion of a real-money right to a fresh barcode is
// distinct from the returned public-credit pool and is voidable while unspent.
const conversionRoot = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 4_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'pooled cash-right conversion fixture', userId
}))
const conversionSourceVariant = variant(5_000_000)
const conversionReplacementVariant = variant(5_000_000)
const conversionSale = await salesService.create({
  userId, shiftId, lines: [item(conversionSourceVariant, 5_000_000)],
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
  storeCreditCode: conversionRoot.code, storeCreditAmount: 4_000_000,
  storeCreditIdempotencyKey: 'pooled-cash-right-conversion-sale'
})
const conversionSaleItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', conversionSale.id)
const conversionExchange = await salesService.createExchange({
  invoiceId: conversionSale.id, lines: [{ saleItemId: conversionSaleItem.id, qty: 1 }],
  replacements: [item(conversionReplacementVariant, 5_000_000)], refundMode: 'STORE_CREDIT',
  userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD,
  idempotencyKey: 'pooled-cash-right-conversion-exchange'
}, { goodsReceiptRequired: false })
const conversionChildItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',
  conversionExchange.exchangeInvoiceId)
const convertedReturn = await salesService.createReturn({
  invoiceId: conversionExchange.exchangeInvoiceId,
  lines: [{ saleItemId: conversionChildItem.id, qty: 1 }],
  refundMethod: 'STORE_CREDIT', refundAmount: 1_000_000, userId, shiftId
})
assert.equal(convertedReturn.creditOpportunity.restored, 4_000_000)
assert.equal(Number(convertedReturn.storeCredit.amount), 1_000_000,
  'only the real-money remainder is converted to the customer-selected new barcode')
const convertedCreditId = Number(convertedReturn.storeCredit.id)
assert.equal(seed.one('SELECT cashConverted FROM "ReturnEntitlement" WHERE returnId=?', convertedReturn.id).cashConverted,
  1_000_000)
const conversionVoid = await salesService.returnDelete({
  id: convertedReturn.id, userId, reason: 'void unused customer-selected real-right barcode',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'void unused customer-selected real-right barcode'
})
assert.equal(conversionVoid.voided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', convertedCreditId).status, 'CANCELED')
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnId=? AND eventKind=?',
  convertedReturn.id, 'REVERSAL'), 2, 'both pooled credit and real-money attribution reverse append-only')

console.log('✓ S4 integration: pooled R=500k/C=500k, C=600k, C=400k end-to-end; cumulative v4 ledger, cash and customer-selected barcode settlement, item-matrix independence, and void/replay reversal')
