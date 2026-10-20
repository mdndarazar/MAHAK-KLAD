/**
 * Exercise the application migration runner, not a hand-applied SQL fixture:
 * install an older schema through applyMigrations, seed historical documents,
 * upgrade a COPY, verify money/evidence preservation and failure atomicity.
 * No shop/customer database, native Prisma engine or migration-history edits.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-real-migration-upgrade.mjs
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const cutover = '20271020550000_receipt_codes_never_reuse'
const names = readdirSync(join(root, 'prisma/migrations'))
  .filter((name) => name !== 'migration_lock.toml').sort()
const historicNames = names.filter((name) => name < cutover)
const newNames = names.filter((name) => name >= cutover)
assert.equal(newNames.length, 13, 'update this test when the financial cutover gains another migration')
const dir = mkdtempSync(join(tmpdir(), 'mahak-real-migration-upgrade-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'unused-harness.db')
const oldMigrations = join(dir, 'old-resources', 'prisma', 'migrations')
for (const name of historicNames) {
  mkdirSync(join(oldMigrations, name), { recursive: true })
  writeFileSync(join(oldMigrations, name, 'migration.sql'),
    readFileSync(join(root, 'prisma/migrations', name, 'migration.sql')))
}

const { applyMigrations } = await import('../../src/main/db/migrator.ts')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { introspect } = await import('../../test/harness/schema.mjs')
const file = join(dir, 'historical.db')
const db = new DatabaseSync(file)
const client = {
  // One synchronous SQLite connection for BEGIN IMMEDIATE through COMMIT.
  async $executeRawUnsafe(query, ...params) { return db.prepare(query).run(...params).changes },
  async $queryRawUnsafe(query, ...params) { return db.prepare(query).all(...params) }
}
// node:sqlite returns null-prototype rows; compare values as ordinary records.
const one = (query, ...params) => ({ ...db.prepare(query).get(...params) })
const rows = (query, ...params) => db.prepare(query).all(...params).map((row) => ({ ...row }))
const oldResourcesPath = process.resourcesPath
try {
  process.resourcesPath = join(dir, 'old-resources')
  const created = await applyMigrations(client, file, { touchFile: false })
  assert.deepEqual(created.applied, historicNames, 'the real runner installed the prior schema/history')
  assert.deepEqual(created.baselined, [])
  assert.deepEqual(created.skipped, [], 'a fresh install must not silently skip SQL')
} finally {
  if (oldResourcesPath === undefined) delete process.resourcesPath
  else process.resourcesPath = oldResourcesPath
}
assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok')
const seed = makeSeeder({ $harness: { db, tables: introspect(db) } })
const userId = seed.user('historic clerk')
const customerId = seed.customer('historic customer')
const cat = seed.category('historic category')
const productId = seed.product('historic product', cat)
const variantId = seed.variant(productId)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH' })
const firstInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 901, issuedAtJalali: '1405/07/20', userId, customerId,
  returnCode: ' ab3-cd4 ', returnCodeExpiresAt: Date.now() - 86_400_000,
  grandTotal: 500, paidTotal: 500
})
const secondInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 902, issuedAtJalali: '1405/07/20', userId, customerId,
  returnCode: 'AB3CD4', returnCodeExpiresAt: Date.now() - 86_400_000,
  grandTotal: 500, paidTotal: 500
})
const saleItemId = seed.insert('SaleInvoiceItem', { invoiceId: firstInvoiceId,
  variantId, qty: 1, unitPrice: 500, lineTotal: 500 })
const paymentId = seed.insert('Payment', { invoiceId: firstInvoiceId, methodId, amount: 500 })
const returnId = seed.insert('SaleReturn', { invoiceId: firstInvoiceId, kind: 'EXCHANGE',
  returnedAtJalali: '1405/07/20', total: 100, refundAmount: 0, refundMethod: 'STORE_CREDIT', userId })
const returnItemId = seed.insert('SaleReturnItem', { returnId, saleItemId, variantId, qty: 1,
  unitPrice: 100, lineTotal: 100 })
const creditId = seed.insert('StoreCredit', { code: 'HISTORIC-CREDIT', amount: 400,
  usedAmount: 100, usedCount: 1, maxUses: 10, multiUse: true, source: 'EXCHANGE',
  returnId, sourceInvoiceId: firstInvoiceId, status: 'PARTIALLY_USED', printCount: 1 })
const redemptionId = seed.insert('StoreCreditRedemption', { creditId, code: 'HISTORIC-CREDIT',
  amount: 100, remainderAfter: 300, invoiceId: secondInvoiceId, idempotencyKey: 'historic-100' })

const historical = {
  invoices: rows('SELECT id, receiptNo, returnCode, returnCodeExpiresAt, grandTotal, paidTotal FROM "SaleInvoice" ORDER BY id'),
  payment: one('SELECT id, invoiceId, methodId, amount FROM "Payment" WHERE id=?', paymentId),
  saleReturn: one('SELECT id, invoiceId, kind, total, refundMethod, refundAmount FROM "SaleReturn" WHERE id=?', returnId),
  returnItem: one('SELECT id, returnId, saleItemId, variantId, qty, lineTotal FROM "SaleReturnItem" WHERE id=?', returnItemId),
  credit: one('SELECT id, code, amount, usedAmount, usedCount, status, printCount FROM "StoreCredit" WHERE id=?', creditId),
  redemption: one('SELECT id, code, amount, creditId, invoiceId, remainderAfter, reversedAt FROM "StoreCreditRedemption" WHERE id=?', redemptionId)
}

// Even a structurally wrong, pre-existing reservation table must not result in
// a partially applied/marked migration. This copy is disposable, not the shop.
const corruptFile = join(dir, 'corrupt-copy.db')
copyFileSync(file, corruptFile)
const corruptDb = new DatabaseSync(corruptFile)
const corruptClient = {
  async $executeRawUnsafe(query, ...params) { return corruptDb.prepare(query).run(...params).changes },
  async $queryRawUnsafe(query, ...params) { return corruptDb.prepare(query).all(...params) }
}
corruptDb.exec('CREATE TABLE "ReceiptCodeReservation" ("code" TEXT PRIMARY KEY NOT NULL)')
await assert.rejects(
  () => applyMigrations(corruptClient, corruptFile, { touchFile: false }),
  (e) => e.message.includes(cutover) && e.message.includes('نسخه‌ی پشتیبان')
)
assert.equal(corruptDb.prepare('SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE migration_name=?').get(cutover).n, 0)
assert.equal(corruptDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
assert.equal(corruptDb.prepare('SELECT COUNT(*) AS n FROM "SaleInvoice"').get().n, 2)
corruptDb.close()

const upgraded = await applyMigrations(client, file, { touchFile: false })
assert.deepEqual(upgraded.applied, newNames)
assert.deepEqual(upgraded.baselined, [])
assert.deepEqual(upgraded.skipped, [], 'no financial migration statement may have been skipped')
assert.deepEqual({
  invoices: rows('SELECT id, receiptNo, returnCode, returnCodeExpiresAt, grandTotal, paidTotal FROM "SaleInvoice" ORDER BY id'),
  payment: one('SELECT id, invoiceId, methodId, amount FROM "Payment" WHERE id=?', paymentId),
  saleReturn: one('SELECT id, invoiceId, kind, total, refundMethod, refundAmount FROM "SaleReturn" WHERE id=?', returnId),
  returnItem: one('SELECT id, returnId, saleItemId, variantId, qty, lineTotal FROM "SaleReturnItem" WHERE id=?', returnItemId),
  credit: one('SELECT id, code, amount, usedAmount, usedCount, status, printCount FROM "StoreCredit" WHERE id=?', creditId),
  redemption: one('SELECT id, code, amount, creditId, invoiceId, remainderAfter, reversedAt FROM "StoreCreditRedemption" WHERE id=?', redemptionId)
}, historical, 'no existing financial record is rewritten during the cutover')
assert.deepEqual(rows('SELECT code, source, invoiceId FROM "ReceiptCodeReservation"'),
  [{ code: 'AB3CD4', source: 'HISTORICAL', invoiceId: null }],
  'duplicate historical receipt claims reserve one code without choosing an invoice')
assert.deepEqual(one('SELECT creditRestored, creditPaperSeparate, goodsReceiptRequired FROM "SaleReturn" WHERE id=?', returnId),
  { creditRestored: 0, creditPaperSeparate: 0, goodsReceiptRequired: 0 },
  'historic paper and physical stock are not assigned the new receipt protocol')
assert.deepEqual(one('SELECT compensatedAt, compensatedReturnId, expiryCaptured, expiryAtRedeem FROM "StoreCreditRedemption" WHERE id=?', redemptionId),
  { compensatedAt: null, compensatedReturnId: null, expiryCaptured: 0, expiryAtRedeem: null },
  'historic redemption never acquires invented origin or expiry')
assert.deepEqual(one('SELECT reminderConsentAt, reminderConsentPhone, reminderConsentEvidence FROM "StoreCredit" WHERE id=?', creditId),
  { reminderConsentAt: null, reminderConsentPhone: null, reminderConsentEvidence: null },
  'old holder phone and non-opt-out flag never backfill SMS permission')
for (const table of ['ReturnEntitlement', 'ReturnEntitlementEvent', 'CreditDelivery', 'BankStatementEvidence',
  'ReturnGoodsReceipt', 'ReturnGoodsReceiptSource', 'CreditReplacement', 'CreditReturnAllocation',
  'ExchangeFundingEvent', 'ExchangeFundingLineAllocation']) {
  assert.equal(one(`SELECT COUNT(*) AS n FROM "${table}"`).n, 0, `${table}: no guessed legacy rights/evidence`)
}
const addFundingEvent = db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, evidenceKind) VALUES (?, ?, ?, ?, ?, ?)`)
addFundingEvent.run('migration-test:source', 'SOURCE_CASH', 100, 'payment:1', 'payment:1', 'PAYMENT_ROW')
assert.throws(() => addFundingEvent.run('migration-test:source', 'SOURCE_CASH', 100,
  'payment:2', 'payment:2', 'PAYMENT_ROW'), /UNIQUE constraint failed/,
  'event keys enforce idempotency at the database boundary')
db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, sourceInvoiceId, evidenceKind)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('snapshot-migration-test:stale', 'SNAPSHOT_STALE', 0,
    `snapshot:${firstInvoiceId}`, `snapshot:${firstInvoiceId}`, firstInvoiceId, 'ACTIVE_RETURN_REQUIRES_WITNESSED_CORRECTION')
assert.throws(() => db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, evidenceKind) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('migration-test:zero-source', 'SOURCE_CASH', 0, 'payment:zero', 'payment:zero', 'PAYMENT_ROW'),
  /CHECK constraint failed/, 'zero is reserved for explicit snapshot-state markers, never a monetary share')
assert.throws(() => db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, sourceInvoiceId, evidenceKind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('snapshot-migration-test:invalid', 'SNAPSHOT_STALE', 1,
    `snapshot:${firstInvoiceId}`, `snapshot:${firstInvoiceId}`, firstInvoiceId, 'SYSTEM'),
  /CHECK constraint failed/, 'snapshot-state markers cannot fabricate a Rial balance')
db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, evidenceKind, reversesEventId)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('migration-test:void', 'VOID_SOURCE', -100, 'payment:1', 'payment:1', 'SALE_INVOICE_VOID', 1)
assert.throws(() => db.prepare(`INSERT INTO "ExchangeFundingEvent"
  (eventKey, kind, amount, shareId, rootShareId, evidenceKind, reversesEventId)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('migration-test:duplicate-void', 'VOID_SOURCE', -100, 'payment:1', 'payment:1', 'SALE_INVOICE_VOID', 1),
  /UNIQUE constraint failed/, 'one source event cannot be reversed twice')

const insertLineAllocation = db.prepare(`INSERT INTO "ExchangeFundingLineAllocation"
  (eventKey, sourceInvoiceId, childInvoiceId, returnId, sourceEventId, saleItemId,
   saleItemQty, saleItemValue, sourceKind, amount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const lineAllocationEventKey = `exchange-line:${secondInvoiceId}:source:9001:item:1001`
insertLineAllocation.run(lineAllocationEventKey, firstInvoiceId, secondInvoiceId, 71, 9001, 1001,
  1, 100, 'SOURCE_CASH', 100)
assert.equal(one('SELECT amount FROM "ExchangeFundingLineAllocation" WHERE eventKey=?', lineAllocationEventKey).amount, 100)
assert.throws(() => insertLineAllocation.run(lineAllocationEventKey, firstInvoiceId, secondInvoiceId,
  71, 9002, 1002, 1, 100, 'SOURCE_CASH', 100), /UNIQUE constraint failed/, 'line-allocation event keys are idempotency keys')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:duplicate`, firstInvoiceId,
  secondInvoiceId, 72, 9001, 1001, 1, 100, 'SOURCE_CASH', 100), /UNIQUE constraint failed/,
  'one transfer-in source cannot be allocated to the same item twice')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:zero`, firstInvoiceId,
  secondInvoiceId, 71, 9003, 1003, 1, 100, 'SOURCE_CASH', 0), /CHECK constraint failed/,
  'zero-value allocations are omitted instead of persisted')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:fractional`, firstInvoiceId,
  secondInvoiceId, 71, 9004, 1004, 1, 100, 'SOURCE_CASH', 0.5), /CHECK constraint failed/,
  'Rial allocations are integral at the database boundary')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:fractional-id`, firstInvoiceId,
  secondInvoiceId, 71, 9004.5, 1004, 1, 100, 'SOURCE_CASH', 1), /CHECK constraint failed/,
  'scalar event links are integral IDs')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:fractional-item-value`, firstInvoiceId,
  secondInvoiceId, 71, 9005, 1005, 1, 100.5, 'SOURCE_CASH', 1), /CHECK constraint failed/,
  'the immutable item-value snapshot is integral')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:invalid-item-qty`, firstInvoiceId,
  secondInvoiceId, 71, 9007, 1007, 0, 100, 'SOURCE_CASH', 1), /CHECK constraint failed/,
  'replacement item quantities must be positive')
assert.throws(() => insertLineAllocation.run(`${lineAllocationEventKey}:unknown`, firstInvoiceId,
  secondInvoiceId, 71, 9006, 1006, 1, 100, 'SOURCE_UNKNOWN', 1), /CHECK constraint failed/,
  'unproven source classes cannot be persisted as line allocations')
const lineAllocationId = one('SELECT id FROM "ExchangeFundingLineAllocation" WHERE eventKey=?',
  lineAllocationEventKey).id
assert.throws(() => db.prepare('UPDATE "ExchangeFundingLineAllocation" SET amount=101 WHERE id=?')
  .run(lineAllocationId), /append-only/, 'line allocations are immutable evidence')
assert.throws(() => db.prepare('DELETE FROM "ExchangeFundingLineAllocation" WHERE id=?')
  .run(lineAllocationId), /append-only/, 'line allocations cannot be erased')
assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok')
assert.deepEqual(rows('PRAGMA foreign_key_check'), [])
assert.equal(one('SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL').n, names.length)
const again = await applyMigrations(client, file, { touchFile: false })
assert.deepEqual(again.applied, [], 'startup retry does not reapply any migration')
assert.equal(one('SELECT COUNT(*) AS n FROM "SaleInvoice"').n, 2)
assert.equal(one('SELECT COUNT(*) AS n FROM "ReceiptCodeReservation"').n, 1)
db.close()
console.log(`✓ real migration runner: ${historicNames.length} older stages + ${newNames.length} cutover stages; legacy documents preserved; duplicate code reserved; corrupt copy rolled back; restart idempotent`)
