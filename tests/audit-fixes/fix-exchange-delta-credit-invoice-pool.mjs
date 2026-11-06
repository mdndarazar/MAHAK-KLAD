/**
 * An ordinary ALL-scope barcode used for a positive exchange delta is pooled
 * across the replacement invoice: returning any replacement restores its credit
 * share first, exactly once; it never becomes cash. Real source money remains a
 * separate pool and can be returned only after the barcode share is exhausted.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-delta-credit-invoice-pool.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-delta-credit-pool-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('exchange-delta-credit-pool')
const shiftId = seed.insert('Shift', {
  name: 'exchange-delta-credit-pool', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'EXCHANGE-DELTA-POOL-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryA = seed.category('exchange-delta-pool-A')
const categoryB = seed.category('exchange-delta-pool-B')
const productA = seed.product('exchange-delta-pool-source', categoryA)
const productB = seed.product('exchange-delta-pool-replacements', categoryB)
const variant = (productId, code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=30,salePrice=? WHERE id=?').run(price, id)
  return id
}
const sourceVariant = variant(productA, 'EDP-SOURCE', 8_000_000)
const returnedReplacementVariant = variant(productB, 'EDP-RETURN-4', 4_000_000)
const moneyReplacementVariant = variant(productB, 'EDP-RETURN-8', 8_000_000)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const credit = await storeCreditService.issueManual({
  amount: 4_000_000, multiUse: false, carryRemainder: false, restrictScope: 'ALL',
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'ordinary invoice-pooled credit'
})
const creditCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', credit.id).code
const sale = await salesService.create({
  userId, shiftId, lines: [line(sourceVariant, 8_000_000)],
  payments: [{ methodId: cashMethodId, amount: 8_000_000, destination: 'CASH' }]
})
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
const exchange = await salesService.createExchange({
  userId, shiftId, invoiceId: sale.id,
  lines: [{ saleItemId: Number(sourceItem.id), qty: 1 }],
  replacements: [line(returnedReplacementVariant, 4_000_000), line(moneyReplacementVariant, 8_000_000)],
  exchangeCreditCode: creditCode, idempotencyKey: 'exchange-delta-pool-idempotent-0001'
})
assert.equal(exchange.diff, 4_000_000)
assert.equal(exchange.barcodeCreditApplied, 4_000_000)
assert.equal(exchange.cashDue, 0)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', credit.id).usedAmount), 4_000_000)
const items = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', exchange.exchangeInvoiceId)
const firstItem = items.find((item) => Number(item.variantId) === returnedReplacementVariant)
const secondItem = items.find((item) => Number(item.variantId) === moneyReplacementVariant)
const cashMovementsBefore = seed.count('CashMovement', '1=1')

const firstReturn = await salesService.createReturn({
  userId, shiftId, invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: Number(firstItem.id), qty: 1 }],
  refundMethod: 'NONE', refundAmount: 0
})
assert.equal(Number(firstReturn.total), 4_000_000)
assert.equal(Number(firstReturn.returnCreditAmount), 4_000_000,
  'the ALL-scope barcode share is restored before any real money')
assert.equal(Number(firstReturn.sourceCreditRestoredAmount), 4_000_000)
assert.equal(Number(firstReturn.refundAmount), 0)
assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore,
  'restoring noncash credit creates no cash movement')
const allocation = seed.one('SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', firstReturn.id)
assert.equal(Number(allocation.amount), 4_000_000)
assert.equal(allocation.restrictScope, 'ALL')
assert.equal(allocation.saleItemId, null, 'ordinary credit does not acquire a replacement-line restriction')
const successor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=?', firstReturn.id)
assert.equal(Number(successor.amount), 4_000_000)
assert.equal(successor.restrictScope, 'ALL')
assert.equal(successor.restrictVariantIdsJson, null)
assert.equal(successor.restrictCategoryIdsJson, null)

const secondReturn = await salesService.createReturn({
  userId, shiftId, invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: Number(secondItem.id), qty: 1 }],
  refundMethod: 'CASH', refundAmount: 8_000_000
})
assert.equal(Number(secondReturn.returnCreditAmount), 0,
  'the same invoice-level credit is never returned twice')
assert.equal(Number(secondReturn.refundAmount), 8_000_000,
  'after the barcode share is exhausted, only traced real money may be paid')
assert.equal(Number(seed.one('SELECT SUM(amount) amount FROM "CashMovement" WHERE type=?', 'RETURN_REFUND').amount), 8_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) amount FROM "CreditReturnAllocation" WHERE invoiceId=?', exchange.exchangeInvoiceId).amount), 4_000_000)
await assert.rejects(() => salesService.createReturn({
  userId, shiftId, invoiceId: exchange.exchangeInvoiceId,
  lines: [{ saleItemId: Number(firstItem.id), qty: 1 }], refundMethod: 'NONE'
}), /قبلاً برگشت|قابل برگشت|مانده/u)
assert.equal(seed.count('StoreCredit', 'returnId=?', firstReturn.id), 1)

console.log('✓ ordinary ALL barcode used for exchange delta is pooled invoice-wide, restored once before money, and never creates cash value')
