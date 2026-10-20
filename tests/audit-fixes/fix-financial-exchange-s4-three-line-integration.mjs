/** S4 zero-difference integration: actual 5M gift + 20M cash sale across 3 lines.
 * Proves source roots, paired transfer, persisted item matrix, and keeps later
 * child-return settlement closed. This is not sign-off for nonzero exchange diff.
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

const thirdChildItemId = childItems[2].id
const preview = await salesService.returnProvenancePreview({
  invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: thirdChildItemId, qty: 1 }]
})
assert.equal(preview.returnTotal, 5_000_000)
assert.deepEqual(preview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_CASH', amount: 4_000_000 },
  { sourceKind: 'SOURCE_GIFT', amount: 1_000_000 }
])
assert.equal(preview.settlementReady, false)
assert.equal(preview.cashRight, 0)
assert.equal(preview.giftOpportunity, 0)
const beforeChildReturn = {
  returns: seed.count('SaleReturn', 'invoiceId=?', exchange.exchangeInvoiceId),
  cashMovements: seed.count('CashMovement', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  entitlements: seed.count('ReturnEntitlement', '1=1'),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  stockMovements: seed.count('StockMovement', '1=1')
}
await assert.rejects(() => salesService.createReturn({
  invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: thirdChildItemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 5_000_000, userId, shiftId
}), /تخصیص منشأ به قلم/)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', exchange.exchangeInvoiceId),
  cashMovements: seed.count('CashMovement', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  entitlements: seed.count('ReturnEntitlement', '1=1'),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  stockMovements: seed.count('StockMovement', '1=1')
}, beforeChildReturn, 'child return is attributable but still cannot settle cash/credit or change stock/ledger')

// S12/S4 reversal probe: void the untouched exchange pair and verify both source
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
  stock: Number(row.stock) + (index < sourceVariants.length ? 0 : 1)
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

console.log('✓ S4 integration: mixed-source carry/matrix, same-key replay and mismatch, child return remains attribution-only, pair void reverses once, post-void retry cannot resurrect')
