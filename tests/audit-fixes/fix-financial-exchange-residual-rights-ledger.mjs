import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDatabase, introspect } from '../../test/harness/schema.mjs'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-residual-ledger-'))
const { db, applied } = buildDatabase(join(dir, 'rights.db'))
const tables = introspect(db)
assert.ok(applied.includes('20271020780000_exchange_residual_right_event_ledger'))
assert.ok(tables.has('ExchangeResidualRightEvent'))
for (const field of [
  'eventKey', 'rightKey', 'rightKind', 'eventKind', 'amount', 'availableDelta', 'reservedDelta', 'spentDelta',
  'sourceInvoiceId', 'childInvoiceId', 'returnId', 'sourceEventId', 'rootShareId', 'expiresAt',
  'operationKey', 'relatedInvoiceId', 'relatedPaymentId', 'reversesEventId'
]) assert.ok(tables.get('ExchangeResidualRightEvent').columns.has(field), `missing persisted field ${field}`)

const insert = db.prepare(`INSERT INTO "ExchangeResidualRightEvent" (
  eventKey, rightKey, rightKind, eventKind, amount, availableDelta, reservedDelta, spentDelta,
  sourceInvoiceId, childInvoiceId, returnId, sourceEventId, rootShareId, expiresAt, operationKey
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const add = (row) => insert.run(
  row.eventKey, row.rightKey, row.rightKind, row.eventKind, row.amount,
  row.availableDelta, row.reservedDelta, row.spentDelta,
  row.sourceInvoiceId ?? 1, row.childInvoiceId ?? 2, row.returnId ?? 3,
  row.sourceEventId ?? 4, row.rootShareId ?? 'credit:4', row.expiresAt ?? null, row.operationKey ?? null
)
const bOpened = {
  eventKey: 'open:right-B', rightKey: 'right-B', rightKind: 'B', eventKind: 'OPENED',
  amount: 122_654, availableDelta: 122_654, reservedDelta: 0, spentDelta: 0,
  expiresAt: '2026-11-20T00:00:00.000Z'
}
const nOpened = {
  eventKey: 'open:right-N', rightKey: 'right-N', rightKind: 'N', eventKind: 'OPENED',
  amount: 857_346, availableDelta: 857_346, reservedDelta: 0, spentDelta: 0
}
add(bOpened)
add(nOpened)
assert.equal(db.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent"').get().n, 2)

assert.throws(() => add({
  ...nOpened, eventKey: 'bad:n-expiry', rightKey: 'bad-N', expiresAt: '2026-11-20T00:00:00.000Z'
}), /CHECK constraint failed/)
assert.throws(() => add({
  ...nOpened, eventKey: 'bad:delta', rightKey: 'bad-delta', availableDelta: 857_345
}), /CHECK constraint failed/)
assert.throws(() => add({
  ...nOpened, eventKey: 'bad:kind', rightKey: 'bad-kind', rightKind: 'CASH'
}), /CHECK constraint failed/)
assert.throws(() => add({
  ...nOpened, eventKey: 'bad:scope', rightKey: 'bad-scope', sourceEventId: 0
}), /CHECK constraint failed/)
assert.throws(() => add({
  ...nOpened, eventKey: 'bad:overflow', rightKey: 'bad-overflow', amount: 9_007_199_254_740_992,
  availableDelta: 9_007_199_254_740_992
}), /CHECK constraint failed/)
assert.throws(() => add({
  ...bOpened, eventKey: 'open:right-B:duplicate', rightKey: 'right-B'
}), /UNIQUE constraint failed/)

assert.throws(() => db.prepare('UPDATE "ExchangeResidualRightEvent" SET amount=1 WHERE eventKey=?').run('open:right-B'), /append-only/)
assert.throws(() => db.prepare('DELETE FROM "ExchangeResidualRightEvent" WHERE eventKey=?').run('open:right-N'), /append-only/)

const countBeforeRollback = db.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent"').get().n
db.exec('BEGIN')
try {
  add({
    eventKey: 'reserve:rollback', rightKey: 'right-B', rightKind: 'B', eventKind: 'RESERVED',
    amount: 1, availableDelta: -1, reservedDelta: 1, spentDelta: 0,
    expiresAt: bOpened.expiresAt, operationKey: 'rollback-reservation'
  })
  db.exec('ROLLBACK')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
assert.equal(db.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent"').get().n, countBeforeRollback,
  'SQLite transaction rollback removes a partial reservation event')

db.close()
console.log('✓ exchange residual rights schema: B/N constraints, exact event deltas, safe Rial scope, one OPENED event, append-only and rollback')
