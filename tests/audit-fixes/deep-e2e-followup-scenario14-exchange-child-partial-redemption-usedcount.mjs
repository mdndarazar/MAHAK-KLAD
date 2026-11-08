/* Isolated N-1 regression: a live multi-use credit has one independent
 * redemption plus a second redemption in an exchange lineage. Returning the
 * exchange child must reverse only its redemption and decrement usedCount once. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s14-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('S14 N-1 exchange-child cashier')
const shiftId = seed.insert('Shift', { name: 'S14 N-1', number: 14, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const category = seed.category('S14 N-1 category')
const makeVariant = (sku, price) => {
  const product = seed.product(`S14-${sku}`, category), id = seed.variant(product, sku)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return id
}
const independentVariant = makeVariant('independent-100', 100000)
const originalVariant = makeVariant('exchange-original-400', 400000)
const replacementVariant = makeVariant('exchange-replacement-550', 550000)
const cash = seed.insert('PaymentMethod', { key: 'S14-CASH', label: 'cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const line = variantId => ({ variantId, qty: 1, unitPrice: Number(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?', variantId).salePrice), discount: 0, tax: 0 })
const issued = await storeCreditService.issueManual({ amount: 500000, multiUse: true, maxUses: 10, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
const sourceBefore = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)

// First completed redemption lives on an unrelated invoice and must remain used.
const independentSale = await salesService.create({
  userId, shiftId, lines: [line(independentVariant)],
  storeCredits: [{ code: sourceBefore.code, requestedAmount: 100000 }],
  saleRequestIdempotencyKey: 's14-independent-redemption'
})
assert.equal(Number(independentSale.storeCreditApplied), 100000)
let source = seed.one('SELECT usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', issued.id)
assert.equal(Number(source.usedAmount), 100000)
assert.equal(Number(source.usedCount), 1)
assert.equal(source.status, 'PARTIALLY_USED')

// A different, cash-paid source invoice is exchanged; the same credit funds the
// positive 150k difference, creating a second complete redemption in the chain.
const sourceSale = await salesService.create({
  userId, shiftId, lines: [line(originalVariant)],
  payments: [{ methodId: cash, amount: 400000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 's14-exchange-source-sale'
})
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sourceSale.id)
const exchange = await salesService.createExchange({
  userId, shiftId, invoiceId: Number(sourceSale.id),
  lines: [{ saleItemId: Number(sourceItem.id), qty: 1 }],
  replacements: [line(replacementVariant)],
  exchangeCreditCode: sourceBefore.code,
  idempotencyKey: 's14-use-source-in-exchange'
})
assert.equal(Number(exchange.diff), 150000)
assert.equal(Number(exchange.barcodeCreditApplied), 150000)
source = seed.one('SELECT usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', issued.id)
assert.equal(Number(source.usedAmount), 250000)
assert.equal(Number(source.usedCount), 2)
assert.equal(source.status, 'PARTIALLY_USED')
const independentRedemption = seed.one('SELECT id,amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?', independentSale.id, issued.id)
const exchangeRedemption = seed.one('SELECT id,amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?', exchange.exchangeInvoiceId, issued.id)
assert.equal(Number(independentRedemption.amount), 100000)
assert.equal(Number(exchangeRedemption.amount), 150000)

const childItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', exchange.exchangeInvoiceId)
const returned = await salesService.createReturn({
  userId, shiftId, invoiceId: Number(exchange.exchangeInvoiceId), full: false,
  lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
  refundMethod: 'CASH', confirmOverpay: true
})
assert.equal(Number(returned.sourceCreditRestoredAmount), 150000)
assert.equal(Number(returned.refundAmount), 400000)
assert.equal((returned.sourceCreditSuccessors ?? []).length, 0, 'live source restored in place; no USED successor')
source = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
assert.equal(Number(source.id), Number(sourceBefore.id))
assert.equal(source.code, sourceBefore.code)
assert.equal(Number(source.amount), 500000)
assert.equal(Number(source.usedAmount), 100000, 'unrelated redemption remains used')
assert.equal(Number(source.usedCount), 1, 'one fully-returned redemption decrements count from two to one')
assert.equal(source.status, 'PARTIALLY_USED')
assert.equal(source.expiresAt, sourceBefore.expiresAt)
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', exchangeRedemption.id).reversedAt != null, true)
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', independentRedemption.id).reversedAt, null)
assert.equal(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId=? AND sourceCreditId=? AND creditRestored=1', returned.id, issued.id).n, 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit" WHERE returnId=?', returned.id).n, 0, 'no new credit barcode was needed')
console.log('Scenario 14 PASS: child return reversed only the exchange redemption; live credit kept the same ID/code/expiry, usedAmount=100000, usedCount=1, PARTIALLY_USED; unrelated redemption remained active and no successor was created.')
await db.$disconnect?.()
