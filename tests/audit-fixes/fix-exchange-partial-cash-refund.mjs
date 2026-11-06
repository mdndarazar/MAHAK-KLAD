/**
 * Negative exchange refund split: actual cash is capped by source-traced money,
 * the seller-selected remainder is issued as unrestricted ordinary store credit,
 * and accounting records both components without overstating drawer outflow.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-partial-cash-refund.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-partial-refund-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { confirmStoreCreditDelivery } = await import('../../src/main/services/StoreCreditService.ts')
const { exchangeRefundPartOf, calculateReturnTotals } = await import('../../src/shared/accounting.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('exchange-partial-refund')
const shiftId = seed.insert('Shift', {
  name: 'exchange-partial-refund', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'EXCHANGE-PARTIAL-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const categoryA = seed.category('partial-refund-A')
const categoryB = seed.category('partial-refund-B')
const productA = seed.product('partial-refund-original', categoryA)
const productB = seed.product('partial-refund-replacement', categoryB)
const makeVariant = (productId, code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=30,salePrice=? WHERE id=?').run(price, id)
  return id
}
const sourceVariant = makeVariant(productA, 'PR-SOURCE', 8_000_000)
const replacementVariant = makeVariant(productB, 'PR-REPLACEMENT', 4_000_000)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const sourceSale = await salesService.create({
  userId, shiftId, lines: [line(sourceVariant, 8_000_000)],
  payments: [{ methodId: cashMethodId, amount: 8_000_000, destination: 'CASH' }]
})
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sourceSale.id)
const request = (refundAmount) => salesService.createExchange({
  userId, shiftId, invoiceId: sourceSale.id,
  lines: [{ saleItemId: Number(sourceItem.id), qty: 1 }],
  replacements: [line(replacementVariant, 4_000_000)],
  refundMode: 'CASH', refundAmount
})

const countsBefore = {
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', sourceVariant).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
}
await assert.rejects(() => request(5_000_000), /از سهم وجه واقعی|بیشتر/u,
  'cash payout above the actual negative-difference right is rejected')
assert.deepEqual({
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', sourceVariant).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
}, countsBefore, 'over-refund rejection rolls back invoices, stock, credit, cash, and return writes')

const exchange = await request(2_000_000)
assert.equal(exchange.diff, -4_000_000)
assert.equal(exchange.refundMode, 'CASH')
assert.equal(exchange.cashRefunded, 2_000_000)
assert.equal(exchange.newStoreCreditAmount, 2_000_000)
assert.equal(exchange.storeCredit?.amount, 2_000_000)
const returnRow = seed.one('SELECT * FROM "SaleReturn" WHERE id=?', exchange.returnId)
assert.equal(Number(returnRow.refundAmount), 2_000_000, 'refundAmount remains the real cash component')
assert.equal(Number(returnRow.refundStoreCreditAmount), 2_000_000, 'separate column records the new barcode component')
assert.equal(returnRow.refundMethod, 'CASH')
assert.equal(returnRow.exchangeSettlement, 'CASH_REFUND')
assert.equal(exchangeRefundPartOf(returnRow), 4_000_000, 'both components consume the one refund entitlement exactly once')
const generated = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=?', exchange.returnId)
assert.equal(Number(generated.amount), 2_000_000)
assert.equal(generated.restrictScope, 'ALL')
assert.equal(generated.restrictVariantIdsJson, null)
assert.equal(generated.restrictCategoryIdsJson, null)
assert.equal(Number(generated.usedAmount), 0)
const cashOut = seed.one('SELECT SUM(amount) amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', exchange.returnId, 'EXCHANGE_REFUND')
assert.equal(Number(cashOut.amount), 2_000_000, 'only cash actually paid leaves the drawer')

const totals = calculateReturnTotals([{
  id: exchange.returnId, kind: 'EXCHANGE', total: 8_000_000, exchangeTotal: 4_000_000,
  exchangeDiff: -4_000_000, exchangeSettlement: 'CASH_REFUND', refundMethod: 'CASH',
  refundAmount: 2_000_000, refundStoreCreditAmount: 2_000_000
}])
assert.equal(totals.exchangeCashRefunds, 2_000_000)
assert.equal(totals.exchangeStoreCreditIssued, 2_000_000)
const exchangeReportRow = await salesService.exchangeGet({ id: exchange.returnId })
assert.equal(exchangeReportRow.cashRefunded, 2_000_000)
assert.equal(Number(exchangeReportRow.storeCreditAmount), 2_000_000)

// Zero requested cash is a full credit settlement, not a misleading CASH_REFUND.
const zeroCashSource = await salesService.create({
  userId, shiftId, lines: [line(sourceVariant, 8_000_000)],
  payments: [{ methodId: cashMethodId, amount: 8_000_000, destination: 'CASH' }]
})
const zeroCashItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', zeroCashSource.id)
const zeroCashBefore = seed.count('CashMovement', '1=1')
const allCreditExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: zeroCashSource.id,
  lines: [{ saleItemId: Number(zeroCashItem.id), qty: 1 }],
  replacements: [line(replacementVariant, 4_000_000)],
  refundMode: 'CASH', refundAmount: 0
})
assert.equal(allCreditExchange.settlement, 'CREDIT')
assert.equal(allCreditExchange.refundMode, 'STORE_CREDIT')
assert.equal(allCreditExchange.cashRefunded, 0)
assert.equal(allCreditExchange.newStoreCreditAmount, 4_000_000)
assert.equal(seed.count('CashMovement', '1=1'), zeroCashBefore)
const allCreditReturnRow = seed.one('SELECT * FROM "SaleReturn" WHERE id=?', allCreditExchange.returnId)
assert.equal(allCreditReturnRow.exchangeSettlement, 'CREDIT')
assert.equal(allCreditReturnRow.refundMethod, 'STORE_CREDIT')
assert.equal(Number(allCreditReturnRow.refundAmount), 4_000_000)
assert.equal(Number(allCreditReturnRow.refundStoreCreditAmount), 0)
assert.equal(exchangeRefundPartOf(allCreditReturnRow), 4_000_000)

// The returned barcode is ACTIVE at issue; handoff confirmation is audit-only.
assert.equal(generated.status, 'ACTIVE')
await confirmStoreCreditDelivery({ id: generated.id, userId })
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', generated.id).status, 'ACTIVE')

// The automatically issued barcode is not tied to either exchange item/category.
const unrelatedSaleVariant = makeVariant(productA, 'PR-UNRELATED', 2_000_000)
const unrelatedPurchase = await salesService.create({
  userId, shiftId, lines: [line(unrelatedSaleVariant, 2_000_000)], payments: [],
  storeCreditCode: generated.code, storeCreditIdempotencyKey: 'partial-refund-credit-spend-any-product-0001'
})
assert.ok(unrelatedPurchase.id)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', generated.id).usedAmount), 2_000_000)

const cardSource = await salesService.create({
  userId, shiftId, lines: [line(sourceVariant, 8_000_000)],
  payments: [{ methodId: cashMethodId, amount: 8_000_000, destination: 'CASH' }]
})
const cardSourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', cardSource.id)
const movementsBeforeCardRefund = seed.count('CashMovement', '1=1')
const cardPartial = await salesService.createExchange({
  userId, shiftId, invoiceId: cardSource.id,
  lines: [{ saleItemId: Number(cardSourceItem.id), qty: 1 }],
  replacements: [line(replacementVariant, 4_000_000)],
  refundMode: 'CARD', refundAmount: 1_500_000,
  cardPosOverride: {
    acknowledgedNoReverse: true,
    reason: 'بازپرداخت کارتی جزئی در آزمون',
    managerPassword: DEFAULT_MANAGER_PASSWORD
  }
})
assert.equal(cardPartial.diff, -4_000_000)
assert.equal(cardPartial.cashRefunded, 0, 'a card payout is never reported as cash drawer outflow')
assert.equal(cardPartial.cardRefunded, 1_500_000)
assert.equal(cardPartial.payoutAmount, 1_500_000, 'the card payout is reported separately from the credit remainder')
assert.equal(cardPartial.newStoreCreditAmount, 2_500_000)
const cardPartialRow = seed.one('SELECT * FROM "SaleReturn" WHERE id=?', cardPartial.returnId)
assert.equal(cardPartialRow.refundMethod, 'CARD')
assert.equal(Number(cardPartialRow.refundAmount), 1_500_000)
assert.equal(Number(cardPartialRow.refundStoreCreditAmount), 2_500_000)
assert.equal(exchangeRefundPartOf(cardPartialRow), 4_000_000)
const cardReport = await salesService.exchangeGet({ id: cardPartial.returnId })
assert.equal(cardReport.cashRefunded, 0)
assert.equal(cardReport.cardRefunded, 1_500_000)
assert.equal(seed.count('CashMovement', '1=1'), movementsBeforeCardRefund, 'card payout and credit remainder do not leave the cash drawer')
const cardCredit = seed.one('SELECT id,amount,status FROM "StoreCredit" WHERE returnId=?', cardPartial.returnId)
assert.equal(Number(cardCredit.amount), 2_500_000)
assert.equal(cardCredit.status, 'ACTIVE', 'new return/exchange barcodes are usable at issuance')
assert.equal(seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', cardCredit.id).status, 'PENDING')

await assert.rejects(() => request(2_000_000), /قابل برگشت|قبلاً|برگشت شده|تعداد/u,
  'retrying an already completed exchange cannot issue a second barcode or pay cash again')
assert.equal(seed.count('StoreCredit', 'returnId=?', exchange.returnId), 1)
assert.equal(Number(seed.one('SELECT SUM(amount) amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', exchange.returnId, 'EXCHANGE_REFUND').amount), 2_000_000)

console.log('✓ negative exchange: excessive cash rejected atomically; partial cash/card plus unrestricted credit is persisted separately; only cash changes drawer; barcode works on an unrelated product; replay cannot duplicate settlement')
