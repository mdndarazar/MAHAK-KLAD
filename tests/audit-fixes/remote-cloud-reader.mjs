import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'

// Fresh throwaway SQLite file, constructed from the repository's migrations.
const dir = mkdtempSync(join(tmpdir(), 'mahak-cloud-reader-'))
const db = createClient(join(dir, 'isolated.db'))
const seed = makeSeeder(db)
const sql = db.$harness.db
const read = createCloudReader(db)

test('empty database produces no fabricated boundary or events', async () => {
  assert.equal(await read.latestBoundary(), null)
  assert.deepEqual(await read.auditPage(0), [])
})
test('reads only explicit audit fields, in bounded ordered pages', async () => {
  for (let i=0; i<203; i++) seed.insert('AuditLog', {at: 1700000000000+i, action:'SALE_CREATE', entity:'SaleInvoice', before:'secret', after:'secret', note:'secret'})
  const first = await read.auditPage(0)
  assert.equal(first.length, 200)
  assert.deepEqual(Object.keys(first[0]).sort(), ['action','at','entity','id'])
  assert.equal(first[0].at, '1700000000000')
  assert.ok(!JSON.stringify(first).includes('secret'))
  const second = await read.auditPage(first.at(-1).id)
  assert.equal(second.length, 3)
  assert.ok(second[0].id > first.at(-1).id)
  assert.equal((await read.auditPage(0, 1)).length, 1)
})
test('blue value uses latest boundary even when no discrepancy case exists, preserving 64-bit precision', async () => {
  for (let i=1; i<=9; i++) seed.insert('CustodyAggregateBoundary', {boundaryKind:'OPENING', operationalDay:'1405-01-01', totalTheoreticalDifference:123n, idempotencyKey:`b${i}`})
  const id = seed.insert('CustodyAggregateBoundary', {boundaryKind:'HANDOVER', operationalDay:'1405-01-02', totalTheoreticalDifference:-9007199254740993n, idempotencyKey:'b10'})
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM "CustodyDiscrepancyCase"').get().n, 0)
  const boundary = await read.latestBoundary()
  assert.equal(boundary.id, id)
  assert.equal(boundary.kind, 'HANDOVER')
  assert.equal(boundary.totalTheoreticalDifference, '-9007199254740993')
  assert.deepEqual(Object.keys(boundary).sort(), ['at','id','kind','operationalDay','totalTheoreticalDifference'])
})
test('invalid cursor and page size are rejected without querying', async () => {
  let count=0; const reader=createCloudReader({$queryRawUnsafe:async()=>{ count++; return [] }})
  for (const [cursor, limit] of [[-1,1],[1.5,1],[Number.MAX_SAFE_INTEGER+1,1],['1 OR 1=1',1],[0,0],[0,201],[0,Infinity],[0,'2']]) {
    await assert.rejects(reader.auditPage(cursor,limit))
  }
  assert.equal(count,0)
})
test('only fixed SELECTs execute and no data is written', async () => {
  const before=sql.prepare('SELECT COUNT(*) n FROM "AuditLog"').get().n
  const observed=[]
  const proxy={$queryRawUnsafe: async (query,...params)=>{observed.push([query,params]);return db.$queryRawUnsafe(query,...params)}}
  const reader=createCloudReader(proxy)
  await reader.auditPage(0,3); await reader.latestBoundary()
  assert.equal(observed.length,2)
  for(const [query] of observed) assert.match(query,/^SELECT\b/)
  assert.ok(observed.every(([query])=>!query.includes(';')))
  assert.deepEqual(observed[0][1],[0,3])
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM "AuditLog"').get().n,before)
})
test('invalid database output fails closed', async () => {
  for (const result of [null, {}, [{id:'01',at:'1',action:'x',entity:'y'}], [{id:'1',at:'1',action:'x',entity:'y'},{id:'1',at:'1',action:'x',entity:'y'}]]) {
    const reader=createCloudReader({$queryRawUnsafe:async()=>result})
    await assert.rejects(reader.auditPage(0))
  }
  const boundary=createCloudReader({$queryRawUnsafe:async()=>[{id:'1',at:'1',kind:'x',operationalDay:'1',totalTheoreticalDifference:'1.2'}]})
  await assert.rejects(boundary.latestBoundary())
})
test('database errors propagate and release single-flight slot', async () => {
  let calls=0; const reader=createCloudReader({$queryRawUnsafe:async()=>{calls++;if(calls===1)throw Error('SQLITE_BUSY'); return []}})
  await assert.rejects(reader.auditPage(0),/SQLITE_BUSY/)
  assert.deepEqual(await reader.auditPage(0),[])
})
test('timeout does not allow additional queries until real query settles', async () => {
  let finish; let calls=0
  const reader=createCloudReader({$queryRawUnsafe:()=>{calls++;return new Promise(resolve=>{finish=resolve})}},10)
  await assert.rejects(reader.auditPage(0),/timeout/)
  await assert.rejects(reader.latestBoundary(),/busy/)
  assert.equal(calls,1)
  let idle=false;const waiting=reader.waitForIdle().then(()=>{idle=true})
  await new Promise(resolve=>setImmediate(resolve));assert.equal(idle,false)
  finish([]);await waiting;assert.equal(idle,true);await new Promise(resolve=>setImmediate(resolve))
  const next=reader.latestBoundary(); await new Promise(resolve=>setImmediate(resolve));finish([])
  assert.equal(await next,null);assert.equal(calls,2)
})
test('configuration and concurrent requests are bounded', async () => {
  assert.throws(()=>createCloudReader({},0))
  assert.throws(()=>createCloudReader({$queryRawUnsafe:async()=>[]},30001))
  let finish; const reader=createCloudReader({$queryRawUnsafe:()=>new Promise(resolve=>{finish=resolve})})
  const first=reader.auditPage(0);await assert.rejects(reader.auditPage(0),/busy/)
  await new Promise(resolve=>setImmediate(resolve)); finish([]); assert.deepEqual(await first,[])
})
