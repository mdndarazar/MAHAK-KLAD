import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'

const dir=mkdtempSync(join(tmpdir(),'mahak-remote-shifts-'))
const db=createClient(join(dir,'isolated.db'))
const sql=db.$harness.db,seed=makeSeeder(db),reader=createCloudReader(db)
const changes=()=>sql.prepare('SELECT total_changes() AS n').get().n
await test('empty shift table stays empty; no auto-created shift',async()=>{
  const before=changes();assert.deepEqual(await reader.openShiftsPage(0),[]);assert.equal(changes(),before)
})
await test('selects open shifts only with bounded ordered pages, no private notes or writes',async()=>{
  for(let i=0;i<203;i++) seed.insert('Shift',{
    name:`shift-${i}`,number:1,dayJalali:'1405/01/01',openedAt:1700000000000+i,note:'PRIVATE-NOTE'
  })
  seed.insert('Shift',{name:'closed',number:1,dayJalali:'1405/01/01',openedAt:1700000000000,closedAt:1700001000000})
  const before=changes(), page1=await reader.openShiftsPage(0), page2=await reader.openShiftsPage(page1.at(-1).id)
  assert.equal(changes(),before);assert.equal(page1.length,200);assert.equal(page2.length,3)
  assert.equal(page1[0].id,1);assert.equal(page1[9].id,10);assert.equal(page2[0].id,201)
  assert.equal(page1[0].openedAtDatabaseValue,'1700000000000')
  assert.deepEqual(Object.keys(page1[0]).sort(),['id','name','number','openedAtDatabaseValue','operationalDay'])
  assert.ok(!JSON.stringify([page1,page2]).includes('PRIVATE-NOTE'))
  assert.equal((await reader.openShiftsPage(0,1)).length,1)
})
await test('listing is current at read time and is not a durable change cursor',async()=>{
  const page=await reader.openShiftsPage(0,1),id=page[0].id
  sql.prepare('UPDATE "Shift" SET "closedAt"=? WHERE id=?').run(1700002000000,id)
  const fresh=await reader.openShiftsPage(0,1);assert.ok(fresh[0].id>id)
})
await test('bad cursors and malformed results fail without unsafe query',async()=>{
  let calls=0; const r=createCloudReader({$queryRawUnsafe:async()=>{calls++;return []}})
  for(const [id,limit] of [[-1,1],[0,0],[0,201],['1 OR 1=1',1],[Number.MAX_SAFE_INTEGER+1,1]]) {
    await assert.rejects(r.openShiftsPage(id,limit))
  }
  assert.equal(calls,0)
  for(const result of [[{id:'1',name:'x',number:'-1',operationalDay:'x',openedAtDatabaseValue:'1'}],[{id:'0'}],[{id:'1',name:null,number:'1'}]]) {
    await assert.rejects(createCloudReader({$queryRawUnsafe:async()=>result}).openShiftsPage(0))
  }
})
await test('only a fixed parameterized SELECT is executed',async()=>{
  const queries=[],r=createCloudReader({$queryRawUnsafe:async(q,...v)=>{queries.push({q,v});return db.$queryRawUnsafe(q,...v)}})
  const before=changes(); await r.openShiftsPage(5,7);assert.equal(changes(),before)
  assert.equal(queries.length,1);assert.match(queries[0].q,/^SELECT\b/);assert.ok(!queries[0].q.includes(';'))
  assert.deepEqual(queries[0].v,[5,7])
})
await db.$disconnect()
