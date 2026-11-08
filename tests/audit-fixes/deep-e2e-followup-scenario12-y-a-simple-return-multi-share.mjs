/**
 * Targeted isolated R15/Y-A reproduction: one restricted multi-use credit
 * redemption is allocated across two eligible invoice lines; returning both
 * lines must restore the live source once and preserve the allocation ledger.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-y-a-r15-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('R15 isolated Y-A return cashier')
const shiftId = seed.insert('Shift', {
  name: 'R15 isolated Y-A return', number: 15,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const categoryId = seed.category('R15 eligible category')
const productA = seed.product('R15 eligible item A', categoryId)
const productB = seed.product('R15 eligible item B', categoryId)
const variantA = seed.variant(productA, 'R15-A')
const variantB = seed.variant(productB, 'R15-B')
for (const id of [variantA, variantB])
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=500000 WHERE id=?').run(id)
const cashMethod = seed.insert('PaymentMethod', {
  key: 'R15-CASH', label: 'R15 cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const issued = await storeCreditService.issueManual({
  amount: 1000000, multiUse: true, maxUses: 10, carryRemainder: true,
  restrictScope: 'VARIANTS', restrictVariantIds: [variantA, variantB],
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const source = seed.one('SELECT id,code,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', issued.id)
const line = (variantId) => ({ variantId, qty: 1, unitPrice: 500000, discount: 0, tax: 0 })
const sale = await salesService.create({
  userId, shiftId,
  lines: [line(variantA), line(variantB)],
  payments: [{ methodId: cashMethod, amount: 200000, destination: 'CASH' }],
  storeCredits: [{ code: source.code, requestedAmount: 800000 }],
  saleRequestIdempotencyKey: 'r15-y-a-multi-share-source'
})
const redemption = seed.one(
  'SELECT id,amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?',
  sale.id, issued.id
)
assert.equal(Number(redemption.amount), 800000)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', issued.id).usedAmount), 800000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', issued.id).status, 'PARTIALLY_USED')

const itemRows = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
assert.equal(itemRows.length, 2)
const before = {
  invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId),
  returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
  payments: seed.count('Payment', 'createdShiftId=?', shiftId),
  stock: [variantA, variantB].map((id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock))
}
const returned = await salesService.createReturn({
  userId, shiftId, invoiceId: Number(sale.id), full: true,
  lines: itemRows.map((row) => ({ saleItemId: Number(row.id), qty: 1 })),
  refundMethod: 'CASH'
})
assert.equal(Number(returned.total), 1000000)
assert.equal(Number(returned.sourceCreditRestoredAmount), 800000)
assert.equal(Number(returned.refundAmount), 200000)

const afterCredit = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
assert.equal(Number(afterCredit.id), Number(source.id), 'live source identity must remain unchanged')
assert.equal(afterCredit.code, source.code, 'live source code must remain unchanged')
assert.equal(Number(afterCredit.usedAmount), 0)
assert.equal(Number(afterCredit.usedCount), 0)
assert.equal(afterCredit.status, 'ACTIVE')
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit" WHERE returnId=?', returned.id).n, 0,
  'a partially-used live source returns to itself; no successor is issued')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', redemption.id).reversedAt != null, true)
assert.equal(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId=? AND sourceCreditId=?', returned.id, issued.id).n, 2,
  'both line-level provenance allocations remain in the append-only ledger')

const after = {
  invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId),
  returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
  payments: seed.count('Payment', 'createdShiftId=?', shiftId),
  stock: [variantA, variantB].map((id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock))
}
assert.deepEqual(after, { ...before, returns: before.returns + 1, stock: before.stock.map((n) => n + 1) },
  'one return document and exact stock restoration; no duplicate invoice/payment')
console.log('R15 PASS: one live restricted-credit redemption split across two returned lines restores once; source, usedCount, allocations, cash, and stock reconcile.')
