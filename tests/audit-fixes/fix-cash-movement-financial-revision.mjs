/** Cash movement insert/update/delete must stale custody-blue observations too.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-cash-movement-financial-revision.mjs
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-cash-revision-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'client-stub.db')
const { splitStatements } = await import('../../src/main/db/migrator.ts')
const migrationRoot = join(process.cwd(), 'prisma/migrations')
const migrationName = '20271021470000_cash_movement_financial_revision'
const sql = new DatabaseSync(join(dir, 'existing-shop.db'))
sql.exec('PRAGMA foreign_keys = OFF')
for (const name of readdirSync(migrationRoot).filter((name) => name < migrationName).sort()) {
  try { sql.exec(readFileSync(join(migrationRoot, name, 'migration.sql'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
const migration = readFileSync(join(migrationRoot, migrationName, 'migration.sql'), 'utf8')
const statements = splitStatements(migration)
assert.equal(statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement)).length, 3)
for (const statement of statements) sql.exec(statement)
const revision = () => Number(sql.prepare('SELECT financialRevision FROM "CustodyState" WHERE key=?').get('MAIN').financialRevision)
const movementId = sql.prepare(`INSERT INTO "CashMovement" (amount, type, occurredAt)
  VALUES (?, ?, ?) RETURNING id`).get(5_000, 'WITHDRAWAL', Date.now()).id
assert.equal(revision(), 1, 'cash-out insert must invalidate any observed cash total')
sql.prepare('UPDATE "CashMovement" SET amount=? WHERE id=?').run(7_000, movementId)
assert.equal(revision(), 2, 'cash movement edits must invalidate a count')
sql.exec('BEGIN')
sql.prepare('DELETE FROM "CashMovement" WHERE id=?').run(movementId)
assert.equal(revision(), 3, 'revision advances in the writer transaction')
sql.exec('ROLLBACK')
assert.equal(revision(), 2, 'a rolled-back movement deletion cannot leave a false revision')
assert.equal(Number(sql.prepare('SELECT amount FROM "CashMovement" WHERE id=?').get(movementId).amount), 7_000)
sql.prepare('DELETE FROM "CashMovement" WHERE id=?').run(movementId)
assert.equal(revision(), 3, 'committed cash movement deletion advances the fence')
console.log('✓ CashMovement insert/update/delete bump financialRevision; rollback remains atomic')
