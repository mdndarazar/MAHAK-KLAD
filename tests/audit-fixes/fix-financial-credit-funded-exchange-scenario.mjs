// @ts-check
/**
 * Owner regression: exchange a 15,980,000-rial sale paid with 2,000,000 of
 * one-use store credit plus 13,980,000 cash for a 15,000,000-rial replacement.
 * The 980,000 difference is source-credit value: issue one 980,000 successor,
 * keep the original code USED, and never create a cash refund.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-funded-exchange-scenario.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedDir = mkdtempSync(join(tmpdir(), 'mahak-credit-funded-exchange-'))
process.env.HARNESS_DIR = isolatedDir
process.env.HARNESS_DB = join(isolatedDir, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const asNumber = (value) => Number(value ?? 0)
const userId = seed.user('credit-funded exchange regression cashier')
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CREDIT-FUNDED-EXCHANGE-CASH',
  label: 'isolated cash',
  kind: 'CASH',
  isActive: 1,
  sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'credit-funded exchange regression',
  number: 9801,
  dayJalali: toJalaliDate(new Date()),
  openedAt: Date.now(),
  userId
})
const categoryId = seed.category('credit-funded-exchange-regression')

function makeVariant(code, price) {
  const productId = seed.product(code, categoryId)
  const variantId = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, variantId)
  return variantId
}

const oldVariantId = makeVariant('CFX-OLD-15980000', 15_980_000)
const replacementVariantId = makeVariant('CFX-NEW-15000000', 15_000_000)
const sourceCredit = await storeCreditService.issueManual({
  amount: 2_000_000,
  multiUse: false,
  maxUses: 1,
  carryRemainder: true,
  days: 30,
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  note: 'one-use credit-funded exchange regression'
})
const sourceBeforeSale = seed.one(
  'SELECT id, code, amount, usedAmount, usedCount, status, expiresAt FROM "StoreCredit" WHERE id = ?',
  sourceCredit.id
)

const originalSale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: oldVariantId, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
  storeCredits: [{ code: sourceBeforeSale.code, requestedAmount: 2_000_000 }],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 'credit-funded-exchange-owner-sale'
})
assert.equal(asNumber(originalSale.grandTotal), 15_980_000)
assert.equal(asNumber(originalSale.storeCreditApplied), 2_000_000)
assert.equal(asNumber(originalSale.paidTotal), 15_980_000)
assert.equal(String(seed.one('SELECT status FROM "StoreCredit" WHERE id = ?', sourceCredit.id).status), 'USED')

const originalItemId = asNumber(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?',
  originalSale.id
).id)
const exchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: asNumber(originalSale.id),
  lines: [{ saleItemId: originalItemId, qty: 1 }],
  replacements: [{ variantId: replacementVariantId, qty: 1, unitPrice: 15_000_000, discount: 0, tax: 0 }],
  refundMode: 'STORE_CREDIT',
  idempotencyKey: 'credit-funded-exchange-owner-case'
})

const sourceAfterExchange = seed.one(
  'SELECT amount, usedAmount, usedCount, status FROM "StoreCredit" WHERE id = ?',
  sourceCredit.id
)
const successors = seed.rows(
  'SELECT amount, usedAmount, usedCount, status, expiresAt FROM "StoreCredit" WHERE returnId = ? ORDER BY id',
  exchange.returnId
)
const returnRow = seed.one(
  'SELECT refundMethod, refundAmount, refundStoreCreditAmount FROM "SaleReturn" WHERE id = ?',
  exchange.returnId
)
const replacementInvoice = seed.one(
  'SELECT grandTotal, paidTotal, status, settledAt FROM "SaleInvoice" WHERE id = ?',
  exchange.exchangeInvoiceId
)
const cashRefunds = asNumber(seed.one(
  "SELECT COALESCE(SUM(amount), 0) AS amount FROM \"CashMovement\" WHERE refId = ? AND type = 'EXCHANGE_REFUND'",
  exchange.returnId
).amount)
const oldStock = asNumber(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', oldVariantId).stock)
const replacementStock = asNumber(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', replacementVariantId).stock)

const checks = {
  originalPurchaseWasPaidByTwoMillionCreditAndThirteenMillionNineHundredEightyThousandCash:
    asNumber(originalSale.storeCreditApplied) === 2_000_000 && asNumber(originalSale.paidTotal) === 15_980_000,
  exchangeDifferenceIsNineHundredEightyThousandForCustomer: asNumber(exchange.diff) === -980_000,
  requestedSettlementIsStoreCredit: exchange.refundMode === 'STORE_CREDIT' && returnRow.refundMethod === 'STORE_CREDIT',
  exactlyOneSuccessorCreditWasIssued: successors.length === 1 && asNumber(successors[0].amount) === 980_000,
  successorKeepsTheOriginalCreditExpiry:
    successors.length === 1 && asNumber(successors[0].expiresAt) === asNumber(sourceBeforeSale.expiresAt),
  originalOneUseCodeRemainsUsed:
    sourceAfterExchange.status === 'USED' && asNumber(sourceAfterExchange.usedAmount) === 2_000_000 && asNumber(sourceAfterExchange.usedCount) === 1,
  noCashRefundWasCreated: cashRefunds === 0 && asNumber(exchange.cashRefunded) === 0,
  replacementInvoiceIsFullySettled:
    asNumber(replacementInvoice.grandTotal) === 15_000_000 &&
    asNumber(replacementInvoice.paidTotal) === 15_000_000 &&
    replacementInvoice.settledAt != null,
  returnedAndReplacementStockAreConsistent: oldStock === 10 && replacementStock === 9
}

assert.ok(
  Object.values(checks).every(Boolean),
  `Credit-funded exchange checks failed: ${JSON.stringify(checks)}; ` +
    `exchange=${JSON.stringify({
      returnTotal: exchange.returnTotal,
      exchangeTotal: exchange.exchangeTotal,
      diff: exchange.diff,
      refundMode: exchange.refundMode,
      settlement: exchange.settlement,
      sourceCreditRestoredAmount: exchange.sourceCreditRestoredAmount,
      cashRefunded: exchange.cashRefunded,
      successors
    })}`
)

console.log('Credit-funded exchange owner scenario: PASS')
console.log('sale=15,980,000; source credit=2,000,000; cash=13,980,000')
console.log('replacement=15,000,000; source-credit successor=980,000; cash refund=0; original code=USED')
console.log(`${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} assertions passed`)
await db.$disconnect?.()
