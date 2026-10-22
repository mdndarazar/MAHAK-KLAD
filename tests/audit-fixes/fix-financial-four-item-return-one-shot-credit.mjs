/**
 * Regression scenario: four 20M items funded by 75M real money + a fully
 * consumed one-shot 5M gift barcode; return one 20M item.
 * Isolated SQLite harness with real sale/return services, NOT a customer DB.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-four-item-return-one-shot-credit.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-four-item-return-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('four-item return test')
const categoryId = seed.category('four-item return')
const productId = seed.product('20M item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const variantIds = ['A', 'B', 'C', 'D'].map((suffix) => {
  const id = seed.variant(productId, `FOUR-20M-${suffix}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=? WHERE id=?').run(20_000_000, id)
  return id
})
const lines = variantIds.map((variantId) => ({ variantId, qty: 1, unitPrice: 20_000_000, discount: 0, tax: 0 }))
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 5_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'one-shot gift 5M', userId
}))
const sale = await salesService.create({ userId, shiftId, lines,
  payments: [{ methodId: cashMethodId, amount: 75_000_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 5_000_000,
  storeCreditIdempotencyKey: 'four-items-one-shot-gift-5m' })
assert.equal(sale.grandTotal, 80_000_000)
assert.equal(sale.storeCreditApplied, 5_000_000)
assert.equal(seed.one('SELECT status, usedAmount FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', gift.id).usedAmount), 5_000_000)

const returnedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1', sale.id)
const preview = await salesService.returnProvenancePreview({ invoiceId: sale.id,
  lines: [{ saleItemId: returnedItem.id, qty: 1 }] })
assert.deepEqual([preview.returnTotal, preview.debtReduced, preview.giftOpportunity, preview.cashRight],
  [20_000_000, 0, 5_000_000, 15_000_000])
const returned = await salesService.createReturn({ invoiceId: sale.id, full: false,
  lines: [{ saleItemId: returnedItem.id, qty: 1 }], refundMethod: 'CASH',
  refundAmount: 15_000_000, userId, shiftId })
assert.equal(returned.total, 20_000_000)
assert.equal(returned.refundAmount, 15_000_000)
assert.equal(returned.creditOpportunity.restored, 5_000_000)
assert.equal(returned.creditOpportunity.pendingDelivery.length, 1)
const successorId = returned.creditOpportunity.pendingDelivery[0].creditId
const successor = seed.one('SELECT amount, status FROM "StoreCredit" WHERE id=?', successorId)
assert.deepEqual([Number(successor.amount), successor.status], [5_000_000, 'DRAFT'])
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'a fully consumed one-shot source barcode is not reactivated')
assert.equal(Number(seed.one('SELECT amount FROM "CreditReturnAllocation" WHERE returnId=?', returned.id).amount), 5_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) AS amount FROM "CashMovement" WHERE refType=? AND refId=?',
  'SaleReturn', returned.id).amount), 15_000_000)
const secondItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1 OFFSET 1', sale.id)
const secondPreview = await salesService.returnProvenancePreview({ invoiceId: sale.id,
  lines: [{ saleItemId: secondItem.id, qty: 1 }] })
assert.deepEqual([secondPreview.giftOpportunity, secondPreview.cashRight], [0, 20_000_000],
  'after restoring the full gift on the first return, it cannot be restored again')
const secondReturn = await salesService.createReturn({ invoiceId: sale.id, full: false,
  lines: [{ saleItemId: secondItem.id, qty: 1 }], refundMethod: 'CASH',
  refundAmount: 20_000_000, userId, shiftId })
assert.equal(secondReturn.creditOpportunity?.restored ?? 0, 0)
assert.equal(secondReturn.refundAmount, 20_000_000)

const giftForBarcodeChoice = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 5_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'one-shot gift 5M, barcode refund alternative', userId
}))
const saleForBarcodeChoice = await salesService.create({ userId, shiftId, lines,
  payments: [{ methodId: cashMethodId, amount: 75_000_000, destination: 'CASH' }],
  storeCreditCode: giftForBarcodeChoice.code, storeCreditAmount: 5_000_000,
  storeCreditIdempotencyKey: 'four-items-barcode-choice-gift-5m' })
const barcodeChoiceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1',
  saleForBarcodeChoice.id)
const barcodeChoicePreview = await salesService.returnProvenancePreview({ invoiceId: saleForBarcodeChoice.id,
  lines: [{ saleItemId: barcodeChoiceItem.id, qty: 1 }] })
assert.deepEqual([barcodeChoicePreview.giftOpportunity, barcodeChoicePreview.cashRight], [5_000_000, 15_000_000])
const barcodeChoiceReturn = await salesService.createReturn({ invoiceId: saleForBarcodeChoice.id, full: false,
  lines: [{ saleItemId: barcodeChoiceItem.id, qty: 1 }], refundMethod: 'STORE_CREDIT',
  refundAmount: 15_000_000, userId, shiftId })
assert.equal(barcodeChoiceReturn.creditOpportunity.restored, 5_000_000)
assert.equal(barcodeChoiceReturn.storeCredit.amount, 15_000_000)
assert.equal(barcodeChoiceReturn.storeCredit.status, 'ACTIVE')
assert.equal(barcodeChoiceReturn.creditOpportunity.pendingDelivery.length, 1)
assert.equal(Number(seed.one('SELECT amount FROM "StoreCredit" WHERE id=?',
  barcodeChoiceReturn.creditOpportunity.pendingDelivery[0].creditId).amount), 5_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) AS amount FROM "CashMovement" WHERE refType=? AND refId=?',
  'SaleReturn', barcodeChoiceReturn.id).amount ?? 0), 0)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftForBarcodeChoice.id).status, 'USED')

// Explicit manager-only exception: this voucher is limited to item A. Returning
// item B must not restore any of it; returning A restores the 2M source share,
// and the remaining 18M real-money right may become a separate new barcode.
const productScopedGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, restrictScope: 'VARIANTS',
  restrictVariantIds: [variantIds[0]], note: 'manager gift earmarked to item A', userId
}))
const scopedSale = await salesService.create({ userId, shiftId,
  lines: [lines[0], lines[1]],
  payments: [{ methodId: cashMethodId, amount: 38_000_000, destination: 'CASH' }],
  storeCreditCode: productScopedGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 'scoped-credit-for-a-only' })
const scopedItems = seed.rows('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', scopedSale.id)
const itemA = scopedItems.find((item) => Number(item.variantId) === variantIds[0])
const itemB = scopedItems.find((item) => Number(item.variantId) === variantIds[1])
const previewB = await salesService.returnProvenancePreview({ invoiceId: scopedSale.id,
  lines: [{ saleItemId: itemB.id, qty: 1 }] })
assert.deepEqual([previewB.giftOpportunity, previewB.cashRight], [0, 20_000_000])
const returnB = await salesService.createReturn({ invoiceId: scopedSale.id, full: false,
  lines: [{ saleItemId: itemB.id, qty: 1 }], refundMethod: 'CASH',
  refundAmount: 20_000_000, userId, shiftId })
assert.equal(returnB.creditOpportunity?.restored ?? 0, 0)
const previewA = await salesService.returnProvenancePreview({ invoiceId: scopedSale.id,
  lines: [{ saleItemId: itemA.id, qty: 1 }] })
assert.deepEqual([previewA.giftOpportunity, previewA.cashRight], [2_000_000, 18_000_000])
const returnA = await salesService.createReturn({ invoiceId: scopedSale.id, full: false,
  lines: [{ saleItemId: itemA.id, qty: 1 }], refundMethod: 'STORE_CREDIT',
  refundAmount: 18_000_000, userId, shiftId })
assert.equal(returnA.creditOpportunity.restored, 2_000_000)
assert.equal(returnA.creditOpportunity.pendingDelivery.length, 0)
assert.equal(returnA.reversedCreditRedemptions, 1)
const restoredScopedCredit = seed.one('SELECT amount, status, restrictScope, restrictVariantIdsJson FROM "StoreCredit" WHERE returnId=? AND sourceInvoiceId=? AND amount=?',
  returnA.id, scopedSale.id, 2_000_000)
assert.deepEqual([Number(restoredScopedCredit.amount), restoredScopedCredit.status,
  restoredScopedCredit.restrictScope, restoredScopedCredit.restrictVariantIdsJson],
  [2_000_000, 'ACTIVE', 'VARIANTS', JSON.stringify([variantIds[0]])])
assert.equal(returnA.storeCredit.amount, 18_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', productScopedGift.id).status, 'USED')

console.log('PASS: general voucher is pooled across goods; explicitly A-restricted manager voucher is restored only when A returns; 20M return => 5M source credit + customer choice for 15M')
