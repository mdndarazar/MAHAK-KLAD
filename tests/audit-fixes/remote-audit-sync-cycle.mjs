import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createAuditSync } from '../../src/main/services/cloud/auditSync.ts'

// Actual SQLite migrations + state files are all fresh and isolated; transport is a fake.
const initial={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'mahak-audit-sync-'))
  const db=createClient(join(dir,'isolated.db')), seed=makeSeeder(db), sql=db.$harness.db
  const stateDir=join(dir,'sync');mkdirSync(stateDir);const state=openCloudStateStore(stateDir);state.save(initial)
  const reader=createCloudReader(db);let marker=null
  const insert=(n=1)=>{for(let i=0;i<n;i++)seed.insert('AuditLog',{at:1700000000000+i,action:'SALE_CREATE',entity:'SaleInvoice',before:'SECRET',after:'SECRET',note:'SECRET'})}
  const ack=(b)=>({version:1,storeId:b.storeId,epoch:b.epoch,lastId:b.events.at(-1).id,digest:b.digest})
  const agent=(transport,override={})=>createAuditSync({state,reader,transport,readRestoreMarker:async()=>marker,...override})
  return {dir,db,sql,state,stateDir,reader,insert,ack,agent,setMarker:(v)=>{marker=v},close:async()=>{state.close();await db.$disconnect()}}
}
await test('real isolated SQLite pages are sent with acknowledgment before cursor persistence',async()=>{
  const f=setup();try {
    f.insert(203);const before=f.sql.prepare('SELECT total_changes() n').get().n;const batches=[]
    const a=f.agent({send:async b=>{batches.push(structuredClone(b));return f.ack(b)}})
    assert.deepEqual(await a.runOnce(),{sent:200,lastAcked:200});assert.deepEqual(await a.runOnce(),{sent:3,lastAcked:203})
    assert.deepEqual(await a.runOnce(),{sent:0,lastAcked:203});assert.equal(batches.length,2)
    assert.equal(batches[0].events.length,200);assert.equal(batches[1].events.length,3)
    assert.ok(!JSON.stringify(batches).includes('SECRET'));assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before)
    assert.equal(f.state.load().lastAcked,203);assert.match(f.state.load().anchorHash,/^[a-f0-9]{64}$/)
  } finally {await f.close()}
  const reopened=openCloudStateStore(f.stateDir);assert.equal(reopened.load().lastAcked,203);reopened.close()
})
await test('errors and mismatched acknowledgments never advance cursor',async()=>{
  const f=setup();try {
    f.insert();let count=0
    const a=f.agent({send:async b=>{count++;if(count===1)throw Error('offline');const ack=f.ack(b)
      if(count===2)ack.epoch='wrong';if(count===3)ack.digest='0'.repeat(64);if(count===4)ack.lastId++
      return ack}})
    for(let i=0;i<4;i++){await assert.rejects(a.runOnce());assert.equal(f.state.load().lastAcked,0)}
    assert.deepEqual(await a.runOnce(),{sent:1,lastAcked:1})
  } finally {await f.close()}
})
await test('ack lost after receiver commits causes safe idempotent resend with identical event IDs',async()=>{
  const f=setup();try {
    f.insert(2);const ids=new Map();let attempt=0
    const a=f.agent({send:async b=>{attempt++;for(const e of b.events){const key=`${b.storeId}/${b.epoch}/${e.id}`;const v=JSON.stringify(e);assert.ok(!ids.has(key)||ids.get(key)===v);ids.set(key,v)}
      if(attempt===1)throw Error('ack lost');return f.ack(b)}})
    await assert.rejects(a.runOnce(),/ack lost/);assert.equal(f.state.load().lastAcked,0)
    assert.deepEqual(await a.runOnce(),{sent:2,lastAcked:2});assert.equal(ids.size,2);assert.equal(attempt,2)
  } finally {await f.close()}
})
await test('local state write failure after ack leaves batch pending for replay',async()=>{
  const f=setup();try {
    f.insert();let fail=true,sends=0
    const state={load:()=>f.state.load(),save:s=>{if(fail){fail=false;throw Error('disk failed')}f.state.save(s)}}
    const a=f.agent({send:async b=>{sends++;return f.ack(b)}},{state})
    await assert.rejects(a.runOnce(),/disk failed/);assert.equal(f.state.load().lastAcked,0)
    assert.deepEqual(await a.runOnce(),{sent:1,lastAcked:1});assert.equal(sends,2)
  } finally {await f.close()}
})
await test('parallel cycles are rejected until outstanding transport settles',async()=>{
  const f=setup();try {
    f.insert();let resolve,called;const calledP=new Promise(r=>{called=r})
    const a=f.agent({send:b=>new Promise(r=>{resolve=()=>r(f.ack(b));called()})})
    const first=a.runOnce();await calledP;await assert.rejects(a.runOnce(),/busy/);resolve();assert.equal((await first).lastAcked,1)
  } finally {await f.close()}
})
await test('restore marker changes before or during send pause sync without advancing',async()=>{
  const f=setup();try {
    f.insert();let sends=0;f.setMarker('a'.repeat(64))
    const a=f.agent({send:async b=>{sends++;return f.ack(b)}})
    await assert.rejects(a.runOnce(),/Restore detected/);assert.equal(sends,0)
    f.setMarker(null);const b=f.agent({send:async batch=>{f.setMarker('b'.repeat(64));return f.ack(batch)}})
    await assert.rejects(b.runOnce(),/Restore detected/);assert.equal(f.state.load().lastAcked,0)
  } finally {await f.close()}
})
await test('changed previously acknowledged row is detected and no new data sent',async()=>{
  const f=setup();try {
    f.insert();const a=f.agent({send:async b=>f.ack(b)});await a.runOnce()
    f.sql.prepare('UPDATE "AuditLog" SET "action"=? WHERE id=?').run('ALTERED',1);f.insert()
    let sent=false;const b=f.agent({send:async batch=>{sent=true;return f.ack(batch)}})
    await assert.rejects(b.runOnce(),/history change/);assert.equal(sent,false);assert.equal(f.state.load().lastAcked,1)
  } finally {await f.close()}
})
await test('changed batch during acknowledgment is detected and no cursor is saved',async()=>{
  const f=setup();try {
    f.insert(2)
    const a=f.agent({send:async b=>{f.sql.prepare('UPDATE "AuditLog" SET "action"=? WHERE id=?').run('ALTERED',1);return f.ack(b)}})
    await assert.rejects(a.runOnce(),/history change/);assert.equal(f.state.load().lastAcked,0)
  } finally {await f.close()}
})
await test('oversized or malformed event never reaches transport',async()=>{
  const f=setup();try {
    f.insert();f.sql.prepare('UPDATE "AuditLog" SET "action"=? WHERE id=?').run('x'.repeat(501),1)
    let sent=false;const a=f.agent({send:async b=>{sent=true;return f.ack(b)}})
    await assert.rejects(a.runOnce(),/too large/);assert.equal(sent,false);assert.equal(f.state.load().lastAcked,0)
  } finally {await f.close()}
})
await test('missing state and malformed restore marker fail closed',async()=>{
  const f=setup();try {
    const a=f.agent({send:async b=>f.ack(b)},{state:{load:()=>null,save:()=>assert.fail()}})
    await assert.rejects(a.runOnce(),/not initialized/)
    f.setMarker('wrong');await assert.rejects(f.agent({send:async b=>f.ack(b)}).runOnce(),/Invalid restore marker/)
  } finally {await f.close()}
})
