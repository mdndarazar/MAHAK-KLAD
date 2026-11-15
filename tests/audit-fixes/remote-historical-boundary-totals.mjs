import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'

// No production database or Electron process: migrations on an isolated SQLite file.
const dir = mkdtempSync(join(tmpdir(), 'mahak-boundary-totals-'))
const db = createClient(join(dir, 'isolated.db'))
const seed = makeSeeder(db)
const sql = db.$harness.db
const reader = createCloudReader(db)
const changes = () => sql.prepare('SELECT total_changes() AS n').get().n

await test('no boundary yields null, never an invented zero or live value', async () => {
  const before=changes(); assert.equal(await reader.latestBoundaryTotals(),null); assert.equal(changes(),before)
})
await test('preserves stored historical expected, observed and difference as three distinct values', async () => {
  for (let n=1;n<=9;n++) seed.insert('CustodyAggregateBoundary', {
    boundaryKind:'OPENING',operationalDay:'1405-01-01',idempotencyKey:`fixture-${n}`,
    theoreticalExpectedTotal:50n,observedOperationalTotal:55n,totalTheoreticalDifference:5n,at:1700000000000
  })
  const id=seed.insert('CustodyAggregateBoundary',{
    boundaryKind:'HANDOVER',operationalDay:'1405-01-02',idempotencyKey:'fixture-10',at:1700000000001,
    theoreticalExpectedTotal:9007199254740993n,observedOperationalTotal:9007199254740973n,totalTheoreticalDifference:-20n
  })
  const before=changes(); const result=await reader.latestBoundaryTotals(); assert.equal(changes(),before)
  assert.deepEqual(result,{
    source:'HISTORICAL_BOUNDARY',id,atDatabaseValue:'1700000000001',kind:'HANDOVER',operationalDay:'1405-01-02',
    theoreticalExpectedTotal:'9007199254740993',observedOperationalTotal:'9007199254740973',totalTheoreticalDifference:'-20'
  })
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"').get().n,0)
})
await test('does not recalculate, silently repair or add unspecified columns', async () => {
  // Deliberately inconsistent fixture: a reader must return stored evidence, not rewrite it.
  seed.insert('CustodyAggregateBoundary',{
    boundaryKind:'FINAL_CLOSE',operationalDay:'1405-01-03',idempotencyKey:'fixture-11',
    theoreticalExpectedTotal:100n,observedOperationalTotal:101n,totalTheoreticalDifference:7n,at:1700000000002
  })
  const observed=[]
  const guarded=createCloudReader({$queryRawUnsafe:async(q,...args)=>{
    observed.push(q);return db.$queryRawUnsafe(q,...args)
  }})
  const before=changes();const result=await guarded.latestBoundaryTotals();assert.equal(changes(),before)
  assert.equal(result.totalTheoreticalDifference,'7')
  assert.equal(result.theoreticalExpectedTotal,'100')
  assert.equal(result.observedOperationalTotal,'101')
  assert.deepEqual(Object.keys(result).sort(),['atDatabaseValue','id','kind','observedOperationalTotal','operationalDay','source','theoreticalExpectedTotal','totalTheoreticalDifference'])
  assert.equal(observed.length,1); assert.match(observed[0],/^SELECT\b/); assert.ok(!observed[0].includes(';'))
})
await test('invalid amount or extra rows fail closed', async () => {
  const valid={id:'1',at:'1',kind:'OPENING',operationalDay:'1405-01-01',theoreticalExpectedTotal:'100',observedOperationalTotal:'101',totalTheoreticalDifference:'1'}
  for(const result of [[{...valid,theoreticalExpectedTotal:'1.1'}],[{...valid,observedOperationalTotal:null}],[valid,valid]]) {
    await assert.rejects(createCloudReader({$queryRawUnsafe:async()=>result}).latestBoundaryTotals())
  }
})
await test('new historical query shares the existing reader single-flight lock', async () => {
  let finish
  const r=createCloudReader({$queryRawUnsafe:()=>new Promise(resolve=>{finish=resolve})})
  const first=r.latestBoundaryTotals();await assert.rejects(r.auditPage(0),/busy/)
  await new Promise(resolve=>setImmediate(resolve));finish([]);assert.equal(await first,null)
})
await db.$disconnect()
