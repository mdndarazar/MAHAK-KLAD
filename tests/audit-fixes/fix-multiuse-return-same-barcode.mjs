/** A returned share from a multi-use credit must restore onto that same barcode,
 * may be reused under decideRedeem's unchanged usedCount, and is safely debited
 * again if the return is voided. Inventory and immutable adjustment rows are checked.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-multiuse-return-same-barcode.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-multiuse-return-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
process.env.HARNESS_BIGINT = '1'
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { isExpiredAt } = await import('../../src/shared/credit.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('multiuse return same barcode')
const categoryId = seed.category('multiuse category')
const product = seed.product('multiuse product', categoryId)
const variant = seed.variant(product)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'multiuse shift', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 60_000, userId, staffConfirmed: 1 })
sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(10, 50_000, variant)
const multiUse = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 100_000, multiUse: true, maxUses: 2,
  carryRemainder: true, days: 30, userId, note: 'same barcode partial-return test'
}))
const original = await salesService.create({
  userId, shiftId,
  lines: [1, 2, 3].map(() => ({ variantId: variant, qty: 1, unitPrice: 50_000, discount: 0, tax: 0 })),
  payments: [{ methodId: cashMethodId, amount: 50_000, destination: 'CASH' }],
  storeCreditCode: multiUse.code, storeCreditAmount: 100_000, storeCreditIdempotencyKey: 'multiuse-return-first-use'
})
assert.equal(Number(original.grandTotal), 150_000)
assert.equal(Number(original.storeCreditApplied), 100_000)
const saleItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', original.id)
assert.equal(Number(seed.one('SELECT usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id)).usedAmount), 100_000)
assert.equal(seed.one('SELECT usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id)).usedCount, 1)
const beforeCreditCount = seed.one('SELECT COUNT(*) AS n FROM "StoreCredit"').n
const returned = await salesService.createReturn({
  invoiceId: original.id, full: false, lines: [{ saleItemId: saleItems[0].id, qty: 1 }],
  refundMethod: 'NONE', userId, shiftId
})
assert.equal(returned.creditOpportunity.restored, 50_000)
assert.equal(returned.creditOpportunity.expiredShare, 0)
assert.deepEqual(returned.creditOpportunity.pendingDelivery, [], 'no replacement barcode is issued')
const allocation = seed.one('SELECT kind, amount, parentCreditId, successorCreditId FROM "CreditReturnAllocation" WHERE returnId=?', Number(returned.id))
assert.equal(allocation.kind, 'MULTI_USE_RESTORED')
assert.equal(Number(allocation.amount), 50_000)
assert.equal(allocation.parentCreditId, Number(multiUse.id))
assert.equal(allocation.successorCreditId, null)
let restored = seed.one('SELECT status, usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id))
assert.equal(Number(restored.usedAmount), 50_000, 'the returned share increases balance on the original barcode')
assert.equal(restored.usedCount, 1, 'return never rewinds usedCount')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCredit"').n, beforeCreditCount, 'no separate successor credit is created')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCreditBalanceAdjustment" WHERE returnId=? AND kind=?',
  Number(returned.id), 'RETURN_MULTI_USE_RESTORED').n, 1)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(variant).stock), 8,
  'the first returned item is added back once')

const returnedSecond = await salesService.createReturn({
  invoiceId: original.id, full: false, lines: [{ saleItemId: saleItems[1].id, qty: 1 }],
  refundMethod: 'NONE', userId, shiftId
})
assert.equal(returnedSecond.creditOpportunity.restored, 50_000,
  'a second partial return restores the remaining share from the same original redemption')
assert.deepEqual(returnedSecond.creditOpportunity.pendingDelivery, [])
const afterSecondReturn = seed.one('SELECT status, usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id))
assert.equal(Number(afterSecondReturn.usedAmount), 0, 'both returned credit shares have restored the original barcode balance')
assert.equal(afterSecondReturn.usedCount, 1)
const secondAllocation = seed.one('SELECT kind, amount, successorCreditId FROM "CreditReturnAllocation" WHERE returnId=?', Number(returnedSecond.id))
assert.equal(secondAllocation.kind, 'MULTI_USE_RESTORED')
assert.equal(Number(secondAllocation.amount), 50_000)
assert.equal(secondAllocation.successorCreditId, null)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(variant).stock), 9,
  'the second returned item is added back once')

sql.prepare('UPDATE "ProductVariant" SET salePrice=? WHERE id=?').run(30_000, variant)
const reuse = await salesService.create({
  userId, shiftId, lines: [{ variantId: variant, qty: 1, unitPrice: 30_000, discount: 0, tax: 0 }],
  payments: [], storeCreditCode: multiUse.code, storeCreditIdempotencyKey: 'multiuse-return-second-use'
})
assert.equal(reuse.storeCreditApplied, 30_000, 'the original barcode is reusable while one use remains')
restored = seed.one('SELECT status, usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id))
assert.equal(Number(restored.usedAmount), 30_000)
assert.equal(restored.usedCount, 2)

await salesService.returnDelete({ id: Number(returnedSecond.id), userId, reason: 'void multiuse credit return',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'test reversal after reuse' })
const afterVoid = seed.one('SELECT status, usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(multiUse.id))
assert.equal(Number(afterVoid.usedAmount), 80_000, 'void reverses the returned share on the same barcode')
assert.equal(afterVoid.usedCount, 2, 'void also preserves real redemption count')
assert.equal(afterVoid.status, 'USED', 'maxUses exhaustion remains enforced by the original counter')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCreditBalanceAdjustment" WHERE returnId=? AND kind=?',
  Number(returnedSecond.id), 'RETURN_MULTI_USE_RESTORATION_REVERSED').n, 1)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(variant).stock), 7,
  'void removes the returned unit once while both original and later sale deductions remain')
const returnedThird = await salesService.createReturn({
  invoiceId: original.id, full: false, lines: [{ saleItemId: saleItems[2].id, qty: 1 }],
  refundMethod: 'NONE', userId, shiftId
})
assert.equal(returnedThird.creditOpportunity.restored, 50_000,
  'a later partial return ignores the voided allocation but retains the still-active one')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', Number(multiUse.id)).usedAmount), 30_000)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(variant).stock), 8)

// If later spending consumed the returned balance, void must fail closed rather
// than create a negative or duplicated balance.
const riskVariant = seed.variant(product, 'overdraw protection')
sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(10, 50_000, riskVariant)
const riskCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 100_000, multiUse: true, maxUses: 3, carryRemainder: true,
  days: 30, userId, note: 'void restoration overdraw guard'
}))
const riskSale = await salesService.create({ userId, shiftId,
  lines: [1, 2].map(() => ({ variantId: riskVariant, qty: 1, unitPrice: 50_000, discount: 0, tax: 0 })),
  payments: [], storeCreditCode: riskCredit.code, storeCreditIdempotencyKey: 'risk-credit-original-use' })
const riskItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', Number(riskSale.id))
const riskReturn = await salesService.createReturn({ invoiceId: riskSale.id, full: false,
  lines: [{ saleItemId: riskItems[0].id, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
const riskReuse = await salesService.create({ userId, shiftId,
  lines: [{ variantId: riskVariant, qty: 1, unitPrice: 50_000, discount: 0, tax: 0 }],
  payments: [], storeCreditCode: riskCredit.code, storeCreditIdempotencyKey: 'risk-credit-reuse' })
assert.equal(Number(riskReuse.storeCreditApplied), 50_000)
const riskStateBeforeVoid = seed.one('SELECT usedAmount, usedCount FROM "StoreCredit" WHERE id=?', Number(riskCredit.id))
assert.equal(Number(riskStateBeforeVoid.usedAmount), 100_000)
const riskStockBeforeVoid = Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(riskVariant).stock)
await assert.rejects(salesService.returnDelete({ id: Number(riskReturn.id), userId,
  reason: 'attempt overdraw return void', managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'must fail closed after reuse' }), /مانده را منفی می‌کند/u)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', Number(riskCredit.id)).usedAmount), 100_000)
assert.equal(Number(seed.one('SELECT usedCount FROM "StoreCredit" WHERE id=?', Number(riskCredit.id)).usedCount), 2)
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', Number(riskReturn.id)).voidedAt, null)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(riskVariant).stock), riskStockBeforeVoid)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCreditBalanceAdjustment" WHERE returnId=? AND kind=?',
  Number(riskReturn.id), 'RETURN_MULTI_USE_RESTORATION_REVERSED').n, 0)

const expiresAt = new Date('2026-12-01T23:59:59.999Z')
assert.equal(isExpiredAt({ amount: 1, status: 'ACTIVE', expiresAt }, expiresAt), false,
  'inclusive expiry boundary remains valid at the exact saved deadline')
assert.equal(isExpiredAt({ amount: 1, status: 'ACTIVE', expiresAt }, expiresAt.getTime() + 1), true,
  'credit expires immediately after the saved deadline')
console.log('✓ repeated partial multi-use returns restore one barcode; reuse keeps usedCount; void reverses same barcode and stock; expiry is inclusive')
