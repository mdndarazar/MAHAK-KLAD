/**
 * Partial exchange from a mixed, fully proven ordinary sale:
 * 4 x 30M = 120M, funded by 110M actual cash + a 10M barcode.
 * Return one 30M item and replace it with a 20M item. The 10M barcode share
 * must return as a rooted non-cash successor; the replacement carries 20M real
 * money, and no cash/card refund is allowed.
 *
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-partial-mixed-source.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-partial-mixed-exchange-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('partial mixed exchange cashier')
const shiftId = seed.insert('Shift', { name: 'partial mixed exchange', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const categoryId = seed.category('partial mixed exchange category')
const productId = seed.product('partial mixed exchange product', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'PARTIAL-MIX-CASH', label: 'Cash',
  kind: 'CASH', isActive: 1, sortOrder: 1 })
let serial = 0
const variant = (price) => {
  const id = seed.variant(productId, `PARTIAL-MIX-${++serial}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=30, salePrice=? WHERE id=?').run(price, id)
  return id
}
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })

const expiry = new Date(Date.now() + 30 * 86_400_000)
const sourceCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 10_000_000, multiUse: false, maxUses: 1,
  carryRemainder: true, days: 30, expiresAt: expiry,
  note: '10M barcode source for partial mixed exchange', userId
}))
const soldVariants = [variant(30_000_000), variant(30_000_000), variant(30_000_000), variant(30_000_000)]
const sale = await salesService.create({
  userId, shiftId,
  lines: soldVariants.map((variantId) => item(variantId, 30_000_000)),
  payments: [{ methodId: cashMethodId, amount: 110_000_000, destination: 'CASH' }],
  storeCreditCode: sourceCredit.code,
  storeCreditAmount: 10_000_000,
  storeCreditIdempotencyKey: 'partial-mixed-source-redemption'
})
const sourceFunding = await getCurrentSaleFundingSources(db, sale.id)
assert.equal(sourceFunding.snapshotExists, true)
assert.deepEqual(sourceFunding.unresolved, [])
assert.deepEqual(sourceFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 110_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 10_000_000 }
])
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', sourceCredit.id).status, 'USED')
const sourceExpiry = Number(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', sourceCredit.id).expiresAt)
const returnedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', sale.id, soldVariants[0])
const preview = await salesService.returnProvenancePreview({
  invoiceId: sale.id, lines: [{ saleItemId: returnedItem.id, qty: 1 }]
})
assert.deepEqual([preview.returnTotal, preview.debtReduced, preview.giftOpportunity, preview.cashRight],
  [30_000_000, 0, 10_000_000, 20_000_000], 'the UI receives exact provenance rights before asking about payout')
const replacementVariant = variant(20_000_000)

// CASH here is deliberately not permission to cash out the returned barcode:
// the only cash-like share left after the replacement is zero.
const result = await salesService.createExchange({
  userId, shiftId, invoiceId: sale.id,
  lines: [{ saleItemId: returnedItem.id, qty: 1 }],
  replacements: [{ variantId: replacementVariant, qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(result.returnTotal, 30_000_000)
assert.equal(result.exchangeTotal, 20_000_000)
assert.equal(result.diff, -10_000_000)
assert.equal(result.settlement, 'S1_RESIDUAL_RIGHTS')
assert.equal(result.cashRefunded, 0)
assert.equal(result.cardToCard, 0)
assert.equal(result.storeCredit.amount, 10_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', sourceCredit.id).status, 'USED',
  'a fully consumed source barcode stays USED permanently')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', sourceCredit.id).usedAmount), 10_000_000)

const returnRow = seed.one('SELECT creditRestored, realMoneyRefundAmount FROM "SaleReturn" WHERE id=?', result.returnId)
assert.equal(Number(returnRow.creditRestored), 10_000_000)
assert.equal(Number(returnRow.realMoneyRefundAmount), 0)
const successor = seed.one('SELECT id, amount, status, expiresAt FROM "StoreCredit" WHERE id=?', result.storeCredit.id)
assert.deepEqual([Number(successor.amount), successor.status, Number(successor.expiresAt)],
  [10_000_000, 'DRAFT', sourceExpiry])
const allocation = seed.one('SELECT parentCreditId, rootCreditId, amount, successorCreditId, originalExpiresAt FROM "CreditReturnAllocation" WHERE successorCreditId=?', result.storeCredit.id)
assert.deepEqual([Number(allocation.parentCreditId), Number(allocation.rootCreditId), Number(allocation.amount),
  Number(allocation.successorCreditId), Number(allocation.originalExpiresAt)],
  [sourceCredit.id, sourceCredit.id, 10_000_000, result.storeCredit.id, sourceExpiry])

const exchangeFunding = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
assert.deepEqual(exchangeFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 }
], 'replacement consumes only the proven 20M real-money share')
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', result.returnId, 'EXCHANGE_REFUND').n), 0, 'no physical cash left the drawer')
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "Payment" WHERE invoiceId=? AND amount<0', result.exchangeInvoiceId).n),
  0, 'no negative/fake refund payment')

// A second partial exchange on the same source invoice sees the earlier
// restored credit and transferred cash, rather than reusing either share.
const secondOriginalItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',
  sale.id, soldVariants[1])
const secondReplacementVariant = variant(15_000_000)
const repeatResult = await salesService.createExchange({
  userId, shiftId, invoiceId: sale.id,
  lines: [{ saleItemId: secondOriginalItem.id, qty: 1 }],
  replacements: [{ variantId: secondReplacementVariant, qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(repeatResult.returnTotal, 30_000_000)
assert.equal(repeatResult.exchangeTotal, 15_000_000)
assert.equal(repeatResult.cashRefunded, 15_000_000,
  'the already-restored gift share is not returned a second time')
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', repeatResult.returnId).creditRestored),
  0)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', repeatResult.returnId, 'EXCHANGE_REFUND').amount), 15_000_000)
console.log('✓ repeated partial exchange: earlier returned/carry shares are not reused')

// A lower-priced replacement leaves 5M actual cash in addition to the same
// 10M non-cash source share. Only that 5M may leave the drawer.
const secondExpiry = new Date(Date.now() + 30 * 86_400_000 + 1_000)
const secondCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 10_000_000, multiUse: false, maxUses: 1,
  carryRemainder: true, days: 30, expiresAt: secondExpiry,
  note: 'second 10M barcode source for partial mixed exchange', userId
}))
const secondSoldVariants = [variant(30_000_000), variant(30_000_000), variant(30_000_000), variant(30_000_000)]
const secondSale = await salesService.create({
  userId, shiftId,
  lines: secondSoldVariants.map((variantId) => item(variantId, 30_000_000)),
  payments: [{ methodId: cashMethodId, amount: 110_000_000, destination: 'CASH' }],
  storeCreditCode: secondCredit.code,
  storeCreditAmount: 10_000_000,
  storeCreditIdempotencyKey: 'partial-mixed-source-redemption-two'
})
const secondReturnedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',
  secondSale.id, secondSoldVariants[0])
const replacement15m = variant(15_000_000)
const secondResult = await salesService.createExchange({
  userId, shiftId, invoiceId: secondSale.id,
  lines: [{ saleItemId: secondReturnedItem.id, qty: 1 }],
  replacements: [{ variantId: replacement15m, qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(secondResult.settlement, 'CASH_REFUND')
assert.equal(secondResult.cashRefunded, 5_000_000)
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', secondResult.returnId).creditRestored),
  10_000_000)
assert.equal(Number(seed.one('SELECT realMoneyRefundAmount FROM "SaleReturn" WHERE id=?', secondResult.returnId).realMoneyRefundAmount),
  5_000_000)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', secondResult.returnId, 'EXCHANGE_REFUND').amount), 5_000_000)
assert.equal(Number(secondResult.storeCredit.amount), 10_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', secondCredit.id).status, 'USED')

// The same 5M real-money residual can instead become a manager transfer request;
// pending or later manager-account payment is not a drawer/POS movement.
const thirdExpiry = new Date(Date.now() + 30 * 86_400_000 + 2_000)
const thirdCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 10_000_000, multiUse: false, maxUses: 1,
  carryRemainder: true, days: 30, expiresAt: thirdExpiry,
  note: 'third 10M barcode source for partial mixed exchange', userId
}))
const thirdSoldVariants = [variant(30_000_000), variant(30_000_000), variant(30_000_000), variant(30_000_000)]
const thirdSale = await salesService.create({
  userId, shiftId,
  lines: thirdSoldVariants.map((variantId) => item(variantId, 30_000_000)),
  payments: [{ methodId: cashMethodId, amount: 110_000_000, destination: 'CASH' }],
  storeCreditCode: thirdCredit.code,
  storeCreditAmount: 10_000_000,
  storeCreditIdempotencyKey: 'partial-mixed-source-redemption-three'
})
const thirdReturnedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',
  thirdSale.id, thirdSoldVariants[0])
const replacementThird15m = variant(15_000_000)
const thirdResult = await salesService.createExchange({
  userId, shiftId, invoiceId: thirdSale.id,
  lines: [{ saleItemId: thirdReturnedItem.id, qty: 1 }],
  replacements: [{ variantId: replacementThird15m, qty: 1 }],
  refundMode: 'CARD_TO_CARD'
})
assert.equal(thirdResult.cardToCard, 5_000_000)
assert.equal(thirdResult.cardTransfer.status, 'PENDING')
assert.equal(Number(seed.one('SELECT refundAmount FROM "SaleReturn" WHERE id=?', thirdResult.returnId).refundAmount),
  5_000_000)
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refType=? AND refId=?',
  'SaleReturn', thirdResult.returnId).n), 0, 'a pending manager transfer does not move drawer cash')
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "Payment" WHERE invoiceId=? AND amount<0',
  thirdResult.exchangeInvoiceId).n), 0)
const blueBeforeManagerPayment = await physicalMovementForCustodyShift(shiftId)
const managerPayment = await cardTransferService.pay({ id: thirdResult.cardTransfer.id,
  paidAmount: 5_000_000, managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
assert.equal(managerPayment.releasedQty, 1)
assert.equal(managerPayment.stockStillPending, false)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', thirdSoldVariants[0]).stock, 30,
  'manager payment returns only the original exchange item to stock')
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementThird15m).stock, 29,
  'the replacement stays deducted after manager payment')
assert.equal(await physicalMovementForCustodyShift(shiftId), blueBeforeManagerPayment,
  'manager C2C payment and its inventory release do not change blue')
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refType=? AND refId=?',
  'SaleReturn', thirdResult.returnId).n), 0, 'C2C payment does not create a cash-drawer movement')
console.log('✓ partial 30M→15M: exactly 5M real cash may be refunded; source credit stays non-cash')
console.log('✓ partial 30M→15M C2C: manager payment returns only the returned item; replacement, drawer and blue stay unchanged')
