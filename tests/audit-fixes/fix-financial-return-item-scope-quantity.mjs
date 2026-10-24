/** SQLite-level scope and active-quantity guards for SaleReturnItem.
 * Corrections are financial only; voidedAt is the sole physical quantity release.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-return-item-scope-quantity.mjs
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-return-item-scope-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { toJalaliDate } = await import('@shared/jalali')
const client = harnessClient()
const seed = makeSeeder(client)
const db = client.$harness.db
const userId = seed.user('return-scope manager')
const categoryId = seed.category('return-scope category')
const productId = seed.product('return-scope goods', categoryId)
const variantId = seed.variant(productId, 'return-scope variant')
const otherVariantId = seed.variant(productId, 'return-scope other variant')
const { id: invoiceId } = seed.invoice({ grandTotal: 2_000 })
const { id: otherInvoiceId } = seed.invoice({ grandTotal: 1_000 })
const saleItemId = seed.invoiceItem(invoiceId, { variantId, qty: 2, lineTotal: 2_000 })
const otherSaleItemId = seed.invoiceItem(otherInvoiceId, { variantId: otherVariantId, qty: 1, lineTotal: 1_000 })
const day = toJalaliDate(new Date())
let clock = 0
const makeReturn = (targetInvoiceId = invoiceId) => seed.insert('SaleReturn', {
  invoiceId: targetInvoiceId, total: 1_000, returnedAt: new Date(Date.now() + clock++),
  returnedAtJalali: day, returnedAtTime: '12:00:00', kind: 'RETURN',
  refundMethod: 'NONE', refundAmount: 0, userId
})
const addItem = (returnId, targetSaleItemId = saleItemId, qty = 1, targetVariantId = variantId) =>
  seed.insert('SaleReturnItem', { returnId, saleItemId: targetSaleItemId,
    variantId: targetVariantId, qty, unitPrice: 1_000, lineTotal: 1_000 * qty })
const insertFailure = (label, action, pattern) => {
  assert.throws(action, pattern, label)
  console.log(`  ✓ ${label}`)
}
const updateFailure = (label, sql, params, pattern) => insertFailure(label,
  () => db.prepare(sql).run(...params), pattern)

// Invoice/variant scope is checked in SQLite, independently of service code.
insertFailure('fractional sold quantity cannot enter the database',
  () => db.prepare(`INSERT INTO "SaleInvoiceItem" (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
    VALUES (?, ?, 1.5, 1000, 0, 0, 1500)`).run(otherInvoiceId, otherVariantId), /sale invoice item quantity/)
updateFailure('unreturned sold quantity cannot become fractional',
  'UPDATE "SaleInvoiceItem" SET qty=1.5 WHERE id=?', [otherSaleItemId], /sale invoice item quantity/)
updateFailure('unreturned sold quantity cannot become zero',
  'UPDATE "SaleInvoiceItem" SET qty=0 WHERE id=?', [otherSaleItemId], /sale invoice item quantity/)
insertFailure('unsafe sold quantity cannot enter the database',
  () => db.prepare(`INSERT INTO "SaleInvoiceItem" (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
    VALUES (?, ?, 9007199254740992, 0, 0, 0, 0)`).run(otherInvoiceId, otherVariantId), /sale invoice item quantity/)
updateFailure('sold quantity above JavaScript exact-integer range is rejected',
  'UPDATE "SaleInvoiceItem" SET qty=9007199254740992 WHERE id=?', [otherSaleItemId], /sale invoice item quantity/)
db.prepare('UPDATE "SaleInvoiceItem" SET qty=9007199254740991 WHERE id=?').run(otherSaleItemId)
db.prepare('UPDATE "SaleInvoiceItem" SET qty=1 WHERE id=?').run(otherSaleItemId)
const voidedDomainReturnId = makeReturn(otherInvoiceId)
db.prepare('UPDATE "SaleReturn" SET voidedAt=? WHERE id=?').run(Date.now(), voidedDomainReturnId)
insertFailure('unsafe returned quantity cannot enter even a voided evidence row',
  () => db.prepare(`INSERT INTO "SaleReturnItem" (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
    VALUES (?, ?, ?, 9007199254740992, 1000, 1000)`).run(voidedDomainReturnId, otherSaleItemId, otherVariantId),
  /sale return item quantity/)
const voidedDomainItemId = addItem(voidedDomainReturnId, otherSaleItemId, 1, otherVariantId)
updateFailure('returned quantity above JavaScript exact-integer range is rejected',
  'UPDATE "SaleReturnItem" SET qty=9007199254740992 WHERE id=?', [voidedDomainItemId], /sale return item quantity/)
db.prepare('UPDATE "SaleReturnItem" SET qty=9007199254740991 WHERE id=?').run(voidedDomainItemId)
db.prepare('UPDATE "SaleReturnItem" SET qty=1 WHERE id=?').run(voidedDomainItemId)

const firstReturnId = makeReturn()
insertFailure('sale item from another invoice cannot be linked to this return',
  () => addItem(firstReturnId, otherSaleItemId, 1, otherVariantId), /scope mismatch/)
insertFailure('variant mismatch cannot be linked to a valid invoice item',
  () => addItem(firstReturnId, saleItemId, 1, otherVariantId), /scope mismatch/)

// Two active one-unit returns consume the sold quantity. A correction does not
// release a physical unit; only voiding a SaleReturn does.
const firstItemId = addItem(firstReturnId, saleItemId, 1, variantId)
const secondReturnId = makeReturn()
const secondItemId = addItem(secondReturnId, saleItemId, 1, variantId)
const correctionId = seed.insert('ReturnCorrection', {
  returnId: firstReturnId, kind: 'VOID_RECONCILIATION', status: 'POSTED',
  reason: 'financial correction is not a physical return void',
  correctingUserId: userId, correctingShiftId: 1,
  originalDayJalali: day, operationalDayJalali: day
})
assert.ok(correctionId > 0 && firstItemId > 0 && secondItemId > 0)
insertFailure('active return-item deletion cannot release quantity outside a void',
  () => db.prepare('DELETE FROM "SaleReturnItem" WHERE id=?').run(firstItemId), /active sale return item deletion/)
insertFailure('active return deletion cannot cascade physical quantity away',
  () => db.prepare('DELETE FROM "SaleReturn" WHERE id=?').run(secondReturnId), /active sale return deletion/)
insertFailure('third active unit is rejected at the DB cap',
  () => addItem(makeReturn(), saleItemId, 1, variantId), /quantity exceeds sold quantity/)
updateFailure('active return-item quantity cannot become fractional',
  'UPDATE "SaleReturnItem" SET qty=1.5 WHERE id=?', [firstItemId], /positive integer/)
updateFailure('active return-item quantity cannot become zero',
  'UPDATE "SaleReturnItem" SET qty=0 WHERE id=?', [firstItemId], /positive integer/)
updateFailure('editing a return item cannot exceed sold quantity',
  'UPDATE "SaleReturnItem" SET qty=2 WHERE id=?', [firstItemId], /quantity exceeds sold quantity/)

// A mismatched parent invoice cannot be edited under an already-linked return.
updateFailure('SaleReturn.invoiceId cannot move below linked items',
  'UPDATE "SaleReturn" SET invoiceId=? WHERE id=?', [otherInvoiceId, firstReturnId], /invoice scope mismatch/)
// A SaleReturnItem cannot be moved to another item or edited to a different
// variant, even when the update is issued outside the application service.
updateFailure('linked return item cannot move to a sale item on another invoice',
  'UPDATE "SaleReturnItem" SET saleItemId=?, variantId=? WHERE id=?',
  [otherSaleItemId, otherVariantId, firstItemId], /scope mismatch/)
updateFailure('sold item variant cannot change under historical return items',
  'UPDATE "SaleInvoiceItem" SET variantId=? WHERE id=?', [otherVariantId, saleItemId], /scope mismatch/)
updateFailure('sold quantity cannot be lowered below active returns',
  'UPDATE "SaleInvoiceItem" SET qty=1 WHERE id=?', [saleItemId], /quantity exceeds sold quantity/)

// Void one return to release exactly one unit, then reactivation must recheck
// the current active total. An unrelated correction never changes this result.
const voidedAt = Date.now()
db.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(voidedAt, 'physical return voided', firstReturnId)
const thirdReturnId = makeReturn()
const thirdItemId = addItem(thirdReturnId, saleItemId, 1, variantId)
assert.ok(thirdItemId > 0)
updateFailure('reactivating over the sold quantity is rejected',
  'UPDATE "SaleReturn" SET voidedAt=NULL WHERE id=?', [firstReturnId], /quantity exceeds sold quantity/)
assert.notEqual(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', firstReturnId).voidedAt, null)

// Once another physical return is voided, reactivation is valid at exactly the
// sold quantity. This still has no relationship to ReturnCorrection.
db.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'second physical return voided', secondReturnId)
db.prepare('UPDATE "SaleReturn" SET voidedAt=NULL, voidReason=NULL WHERE id=?').run(firstReturnId)
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', firstReturnId).voidedAt, null)
assert.equal(seed.one(`SELECT SUM(ri.qty) AS qty FROM "SaleReturnItem" ri
  JOIN "SaleReturn" r ON r.id=ri.returnId WHERE ri.saleItemId=? AND r.voidedAt IS NULL`, saleItemId).qty, 2)

// New return request identity is unique and immutable. The sanitized response
// snapshot can be attached once inside the creating transaction, never replaced.
const idempotentReturnId = seed.insert('SaleReturn', {
  invoiceId: otherInvoiceId, total: 0, returnedAt: new Date(), returnedAtJalali: day,
  returnedAtTime: '12:30:00', kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0,
  idempotencyKey: 'return-request:test-scope-0001', idempotencyFingerprint: 'f'.repeat(64)
})
db.prepare('UPDATE "SaleReturn" SET idempotencyResponseJson=? WHERE id=?').run('{}', idempotentReturnId)
assert.throws(() => db.prepare('UPDATE "SaleReturn" SET idempotencyResponseJson=? WHERE id=?')
  .run('{"replaced":true}', idempotentReturnId), /idempotency fields are immutable/)
assert.throws(() => db.prepare('UPDATE "SaleReturn" SET idempotencyFingerprint=? WHERE id=?')
  .run('e'.repeat(64), idempotentReturnId), /idempotency fields are immutable/)
assert.throws(() => seed.insert('SaleReturn', {
  invoiceId: otherInvoiceId, total: 0, returnedAt: new Date(), returnedAtJalali: day,
  returnedAtTime: '12:31:00', kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0,
  idempotencyKey: 'return-request:test-scope-0001', idempotencyFingerprint: 'f'.repeat(64)
}), /unique constraint/i)

// Verify a second SQLite connection observes the same DB-enforced policy.
const independent = new DatabaseSync(process.env.HARNESS_DB)
try {
  assert.throws(() => independent.prepare('UPDATE "SaleReturn" SET invoiceId=? WHERE id=?')
    .run(otherInvoiceId, thirdReturnId), /invoice scope mismatch/)
  assert.throws(() => independent.prepare('DELETE FROM "SaleReturnItem" WHERE id=?').run(firstItemId),
    /active sale return item deletion/)
  assert.throws(() => independent.prepare('DELETE FROM "SaleReturn" WHERE id=?').run(thirdReturnId),
    /active sale return deletion/)
} finally {
  independent.close()
}

console.log('✓ SQLite return-item guards: invoice/variant scope, active quantity, correction retention, void/reactivation and independent connection')
