/**
 * An existing shop database can add immutable blue evidence without changing
 * a historic custody row. Triggers detect all financial writes and rollback.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s401-custody-blue-migration.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-migration-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'client-stub.db')
const { splitStatements } = await import('../../src/main/db/migrator.ts')
const migrations = join(process.cwd(), 'prisma/migrations')
const migrationName = '20271020500000_custody_blue_snapshots'
const current = readFileSync(join(migrations, migrationName, 'migration.sql'), 'utf8')
const sql = new DatabaseSync(join(dir, 'existing-shop.db'))
sql.exec('PRAGMA foreign_keys = OFF')
for (const name of readdirSync(migrations).filter((name) => name < migrationName).sort()) {
  try { sql.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
// The harness intentionally permits an isolated payment without a full
// invoice/method graph; its SQLite constraints and trigger behavior stay real.
sql.exec('PRAGMA foreign_keys = OFF')
sql.prepare('UPDATE "CustodyState" SET "state"=?, "activeShiftId"=?, "epoch"=?, "updatedAt"=? WHERE "key"=?')
  .run('ACTIVE', 12, 42, Date.now(), 'MAIN')
let checked = 0
function eq(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  checked++
  console.log(`  ✓ ${name}`)
}
function reject(name, action) {
  try { action() }
  catch { checked++; console.log(`  ✓ ${name}`); return }
  throw new Error(`${name}: write unexpectedly succeeded`)
}
console.log('\n[1] Apply additive migration to a shop with existing custody')
const statements = splitStatements(current)
eq('trigger statements not split at inner semicolons', statements.filter((s) => /^CREATE TRIGGER\b/i.test(s)).length, 16)
for (const statement of statements) sql.exec(statement)
const old = sql.prepare('SELECT * FROM "CustodyState" WHERE key=?').get('MAIN')
eq('old active shift survives', old.activeShiftId, 12)
eq('old epoch survives', old.epoch, 42)
eq('new monotonic revision starts at zero', old.financialRevision, 0)
eq('snapshot table created', !!sql.prepare("SELECT name FROM sqlite_master WHERE name='CustodyBlueSnapshot'").get(), true)
eq('resolution table created', !!sql.prepare("SELECT name FROM sqlite_master WHERE name='CustodyBlueResolution'").get(), true)

console.log('\n[2] Unfenced financial writes still invalidate an unfinished count')
sql.prepare('INSERT INTO "Payment" ("invoiceId", "methodId", "amount") VALUES (?, ?, ?)').run(1, 1, 1_000_000)
const payId = sql.prepare('SELECT id FROM "Payment" ORDER BY id DESC LIMIT 1').get().id
eq('payment insert bumps revision', sql.prepare('SELECT financialRevision FROM "CustodyState"').get().financialRevision, 1)
sql.prepare('UPDATE "Payment" SET "destination"=? WHERE id=?').run('CASH', payId)
eq('destination correction bumps revision', sql.prepare('SELECT financialRevision FROM "CustodyState"').get().financialRevision, 2)
sql.exec('BEGIN')
sql.prepare('UPDATE "Payment" SET "amount"=? WHERE id=?').run(1_200_000, payId)
eq('in-flight revision is visible inside writer transaction', sql.prepare('SELECT financialRevision FROM "CustodyState"').get().financialRevision, 3)
sql.exec('ROLLBACK')
eq('failed financial write cannot advance revision', sql.prepare('SELECT financialRevision FROM "CustodyState"').get().financialRevision, 2)
eq('failed financial write cannot change payment', sql.prepare('SELECT amount FROM "Payment" WHERE id=?').get(payId).amount, 1_000_000)

console.log('\n[3] Original snapshot is immutable; manager decisions only append new rows')
sql.prepare(`INSERT INTO "CustodyBlueSnapshot" (
  "shiftId", "role", "actorUserId", "authMethod", "countOrigin", "humanAmount", "arithmeticAmount",
  "referenceFromDay", "referenceToDay", "scopeKind", "referenceStatus", "referenceAmount",
  "knownSubtotal", "ambiguousLegacyCredit", "calculationVersion", "financialRevision",
  "epochAtCount", "freshStatus", "idempotencyKey", "operationalDay"
) VALUES (12, 'IN', 7, 'CUSTODY_PIN', 'EXPLICIT_AMOUNT', 501000000, 501000000,
  '1405/07/22', '1405/07/22', 'TODAY', 'PENDING_RECONCILIATION', NULL,
  500000000, 1000000, 'sales-blue-v1', 2, 42, 'UNKNOWN_REFERENCE_PENDING', 'snapshot:fixture:1', '1405/07/22')`).run()
const snapId = sql.prepare('SELECT id FROM "CustodyBlueSnapshot"').get().id
reject('snapshot cannot be updated', () => sql.prepare('UPDATE "CustodyBlueSnapshot" SET "referenceAmount"=501000000 WHERE id=?').run(snapId))
reject('snapshot cannot be deleted', () => sql.prepare('DELETE FROM "CustodyBlueSnapshot" WHERE id=?').run(snapId))
eq('frozen reference remains unknown', sql.prepare('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?').get(snapId).referenceAmount, null)
sql.prepare(`INSERT INTO "CustodyBlueResolution" (
  "snapshotId", "managerUserId", "authMethod", "decisionKind", "evidenceDay", "evidenceReference",
  "reason", "ambiguousAmount", "effectiveReferenceAmount", "resolvedRawDifference",
  "freshStatus", "idempotencyKey"
) VALUES (?, 9, 'CUSTODY_PIN', 'RECEIVED_CARD', '1405/07/22', 'POS receipt from the same day',
  'POS proof verified against shift date', 1000000, 501000000, 0,
  'UNKNOWN_NO_REAL_PRIOR_COUNT', 'resolution:fixture:1')`).run(snapId)
eq('one later decision linked to original snapshot', sql.prepare('SELECT snapshotId FROM "CustodyBlueResolution"').get().snapshotId, snapId)
reject('resolved evidence cannot be rewritten', () => sql.prepare('UPDATE "CustodyBlueResolution" SET "resolvedRawDifference"=10').run())
reject('resolved evidence cannot be deleted', () => sql.prepare('DELETE FROM "CustodyBlueResolution"').run())
eq('original reference still null after resolution', sql.prepare('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?').get(snapId).referenceAmount, null)
console.log(`\n✓ ${checked} checks passed`)
