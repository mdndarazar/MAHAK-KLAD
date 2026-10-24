/** Receipt-code cutover: historical duplicate claims, immutable reservation,
 * rollback, issuance/attachment and non-disclosing lookup. SQLite is temporary.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-receipt-never-reuse.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-receipt-cutover-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'test.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { generateReturnCode, reserveReturnCodeCandidate } = await import('../../src/main/services/ReturnCodeService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// Simulate the upgrade of an existing database with two invoices that share
// an EXPIRED code. This must not fail a UNIQUE backfill or choose a claim.
const a = seed.invoice()
const b = seed.invoice()
const legacyCode = 'H2JK34'
for (const invoice of [a, b])
  sql.prepare('UPDATE "SaleInvoice" SET returnCode = ?, returnCodeExpiresAt = ? WHERE id = ?')
    .run(legacyCode, Date.now() - 86400000, invoice.id)
sql.exec('DROP TABLE "ReceiptCodeReservation"')
const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20271020550000_receipt_codes_never_reuse/migration.sql'), 'utf8')
sql.exec(migration)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "ReceiptCodeReservation" WHERE code = ?', legacyCode).n, 1)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "SaleInvoice" WHERE returnCode = ?', legacyCode).n, 2)
assert.equal(await reserveReturnCodeCandidate(db, legacyCode, new Date()), false, 'expired legacy code is burnt')
await assert.rejects(() => salesService.findByReturnCode(legacyCode), e =>
  /چند سند/.test(e.message) && !e.message.includes(legacyCode) && !e.message.includes(String(a.receiptNo)))
console.log('✓ migration: duplicate historical claims retained, permanent unique reservation; no lookup guess/leak')

let rolledBackCode
await assert.rejects(() => db.$transaction(async tx => {
  const generated = await generateReturnCode(tx, { issuedAt: new Date() })
  rolledBackCode = generated.code
  throw new Error('deliberate rollback')
}), /deliberate rollback/)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "ReceiptCodeReservation" WHERE code = ?', rolledBackCode).n, 0)
console.log('✓ reservation rolls back together with a failed invoice transaction')

const userId = seed.user()
const cat = seed.category('test')
const product = seed.product('test item', cat)
const variantId = seed.variant(product)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', {
  name: 'morning', number: 1, userId, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600000
})
sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = 1000 WHERE id = ?').run(variantId)
const invoice = await salesService.create({
  userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 1000 }]
})
const code = invoice.returnCode
assert.ok(code)
const reservation = seed.one('SELECT invoiceId, source FROM "ReceiptCodeReservation" WHERE code = ?', code)
assert.equal(reservation.invoiceId, invoice.id)
assert.equal(reservation.source, 'ISSUED')
sql.prepare('DELETE FROM "SaleInvoice" WHERE id = ?').run(invoice.id)
assert.equal(await reserveReturnCodeCandidate(db, code, new Date(Date.now() + 800000000)), false,
  'expired/deleted invoice cannot free its code')
console.log('✓ new sale and reservation atomically linked; deleting the invoice cannot recycle its code')

assert.equal(await reserveReturnCodeCandidate(db, 'KK2345', new Date()), true)
assert.equal(await reserveReturnCodeCandidate(db, 'KK2345', new Date()), false,
  'database unique index, not a time-based lookup, enforces the collision')
await assert.rejects(() => salesService.findByReturnCode('UNKNOWN789'), e =>
  !e.message.includes('UNKNOWN789') && !e.message.includes(legacyCode))
console.log('✓ uniqueness enforced at SQLite; unknown input not echoed in error')
