import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'

// Fresh throwaway SQLite file, constructed from the repository's migrations.
const dir = mkdtempSync(join(tmpdir(), 'mahak-audit-tail-'))
const db = createClient(join(dir, 'isolated.db'))
const seed = makeSeeder(db)
const sql = db.$harness.db
const read = createCloudReader(db)

test('empty table yields an empty tail', async () => {
  assert.deepEqual(await read.auditTail(), [])
})
test('tail returns the most recent rows in ascending id order', async () => {
  for (let i = 0; i < 7; i++) seed.insert('AuditLog', { at: 1700000000000 + i, action: 'SALE_CREATE', entity: 'SaleInvoice', before: 'secret', after: 'secret', note: 'secret' })
  const tail = await read.auditTail(3)
  assert.equal(tail.length, 3)
  assert.deepEqual(tail.map((row) => row.id), [5, 6, 7])
  assert.deepEqual(Object.keys(tail[0]).sort(), ['action', 'at', 'entity', 'id'])
  assert.ok(!JSON.stringify(tail).includes('secret'))
  const full = await read.auditTail(200)
  assert.deepEqual(full.map((row) => row.id), [1, 2, 3, 4, 5, 6, 7])
  assert.equal((await read.auditTail(1))[0].id, 7)
})
test('invalid tail size is rejected without querying', async () => {
  let count = 0
  const reader = createCloudReader({ $queryRawUnsafe: async () => { count += 1; return [] } })
  for (const limit of [-1, 0, 1.5, 201, Infinity, NaN, '2']) {
    await assert.rejects(reader.auditTail(limit))
  }
  assert.equal(count, 0)
})
test('a tail page that is not strictly descending is rejected', async () => {
  const stub = { $queryRawUnsafe: async () => [
    { id: '4', at: '4', action: 'A', entity: 'E' },
    { id: '6', at: '6', action: 'A', entity: 'E' }
  ] }
  const reader = createCloudReader(stub)
  await assert.rejects(reader.auditTail(2), /Invalid audit ordering/)
})
test('a tail page with a repeated id is rejected', async () => {
  const stub = { $queryRawUnsafe: async () => [
    { id: '7', at: '7', action: 'A', entity: 'E' },
    { id: '7', at: '7', action: 'A', entity: 'E' }
  ] }
  const reader = createCloudReader(stub)
  await assert.rejects(reader.auditTail(2), /Invalid audit ordering/)
})
test('only fixed SELECTs execute and no data is written', async () => {
  const before = sql.prepare('SELECT COUNT(*) n FROM "AuditLog"').get().n
  const observed = []
  const proxy = { $queryRawUnsafe: async (query, ...params) => { observed.push([query, params]); return db.$queryRawUnsafe(query, ...params) } }
  const reader = createCloudReader(proxy)
  await reader.auditTail(2)
  assert.equal(observed.length, 1)
  assert.match(observed[0][0], /^SELECT\b/)
  assert.ok(!observed[0][0].includes(';'))
  assert.deepEqual(observed[0][1], [2])
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM "AuditLog"').get().n, before)
})
