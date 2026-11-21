import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createAuditSync } from '../../src/main/services/cloud/auditSync.ts'
import { createLoopbackAuditTransport } from '../../src/main/services/cloud/loopbackAuditTransport.ts'
import { createLocalAuditReceiver } from '../../src/main/services/cloud/localAuditReceiver.ts'

const key=Buffer.alloc(32,0x4b), path='/internal/v1/audit'
const hash=x=>createHash('sha256').update(x).digest('hex')
const mac=fields=>createHmac('sha256',key).update(JSON.stringify(fields)).digest('hex')
const dir=mkdtempSync(join(tmpdir(),'mahak-real-hub-test-')), hubPath=join(dir,'hub.db')
let clock=Date.now(), db, server, port
const initial={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
const makeBatch=(events)=>({version:1,storeId:initial.storeId,epoch:initial.epoch,events,digest:hash(JSON.stringify([1,initial.storeId,initial.epoch,events.map(e=>[e.id,e.at,e.action,e.entity])]))})
const e=(id,action='SALE_CREATE')=>({id,at:'1700000000000',action,entity:'SaleInvoice'})
async function start(){db=new DatabaseSync(hubPath);db.exec('PRAGMA synchronous=FULL');server=createServer(createLocalAuditReceiver(db,key,{now:()=>clock,requestTimeoutMs:500}));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port}
async function stop(){server.closeAllConnections();await new Promise(r=>server.close(r));db.close()}
function send(batch,{nonce='0123456789abcdef0123456789abcdef',time=clock,signature,body:customBody,headers={}}={}){
  const body=Buffer.from(customBody??JSON.stringify(batch)),sig=signature??mac(['mahak-audit-request-v1','POST',path,time,nonce,hash(body)])
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,method:'POST',path,headers:{'content-type':'application/json','content-length':body.length,'x-mahak-time':String(time),'x-mahak-nonce':nonce,'x-mahak-signature':sig,...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
    });req.on('error',reject);req.end(body)
  })
}
await start()
try {
 await test('audit cycle commits to separate SQLite hub before signed response advances state',async()=>{
   const shop=createClient(join(dir,'shop-test.db')),seed=makeSeeder(shop),stateDir=join(dir,'state');mkdirSync(stateDir)
   const state=openCloudStateStore(stateDir);state.save(initial)
   try {
     seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',before:'SECRET',after:'SECRET'})
     const before=shop.$harness.db.prepare('SELECT total_changes() n').get().n
     const sync=createAuditSync({state,reader:createCloudReader(shop),transport:createLoopbackAuditTransport(`http://127.0.0.1:${port}${path}`,key,1000),readRestoreMarker:async()=>null})
     assert.deepEqual(await sync.runOnce(),{sent:1,lastAcked:1});assert.equal(state.load().lastAcked,1)
     assert.equal(shop.$harness.db.prepare('SELECT total_changes() n').get().n,before)
     assert.deepEqual({...db.prepare('SELECT at,action,entity FROM remote_audit_events WHERE audit_id=1').get()},{at:'1700000000000',action:'SALE_CREATE',entity:'SaleInvoice'})
   }finally{state.close();await shop.$disconnect()}
 })
 await test('retries with fresh nonce are idempotent, exact request replay is rejected',async()=>{
   const b=makeBatch([e(2)]),opts={nonce:'11111111111111111111111111111111'}
   const first=await send(b,opts);assert.equal(first.status,200)
   assert.equal(first.headers['x-mahak-ack-signature'],mac(['mahak-audit-ack-v1',opts.nonce,200,hash(first.body)]))
   assert.equal((await send(b,opts)).status,409)
   assert.equal((await send(b,{nonce:'22222222222222222222222222222222'})).status,200)
   assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events WHERE audit_id=2').get().n,1)
 })
 await test('event conflict rolls back whole batch and nonce',async()=>{
   const nonce='33333333333333333333333333333333'
   assert.equal((await send(makeBatch([e(2,'MUTATED'),e(3)]),{nonce})).status,409)
   assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events WHERE audit_id=3').get().n,0)
   assert.equal((await send(makeBatch([e(2),e(3)]),{nonce})).status,200)
 })
 await test('reject unauthenticated, stale, malformed and modified bodies',async()=>{
   const b=makeBatch([e(4)])
   assert.equal((await send(b,{signature:'0'.repeat(64)})).status,401)
   assert.equal((await send(b,{time:clock-60001})).status,401)
   assert.equal((await send(b,{body:'{'})).status,400)
   b.events[0].action='MUTATED';assert.equal((await send(b)).status,400)
   const secret=makeBatch([{...e(4),private:'SECRET'}]);assert.equal((await send(secret)).status,400)
   assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events WHERE audit_id=4').get().n,0)
 })
 await test('database write failure cannot acknowledge or partially persist the batch',async()=>{
   db.exec("CREATE TRIGGER fail_test_insert BEFORE INSERT ON remote_audit_events WHEN NEW.audit_id = 8 BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END;")
   const nonce='77777777777777777777777777777777',b=makeBatch([e(7),e(8)])
   try{assert.equal((await send(b,{nonce})).status,409)
     assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events WHERE audit_id IN (7,8)').get().n,0)
     assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_nonces WHERE nonce=?').get(nonce).n,0)
   }finally{db.exec('DROP TRIGGER fail_test_insert')}
   assert.equal((await send(b,{nonce})).status,200)
 })
 await test('restart retains persisted events and replay records',async()=>{
   await stop();await start()
   assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events').get().n,5)
   assert.equal((await send(makeBatch([e(2)]),{nonce:'11111111111111111111111111111111'})).status,409)
   assert.equal((await send(makeBatch([e(2)]),{nonce:'44444444444444444444444444444444'})).status,200)
 })
 await test('clock rollback fails closed after expiring nonce cleanup, including across restart',async()=>{
   clock+=120001
   assert.equal((await send(makeBatch([e(5)]),{nonce:'55555555555555555555555555555555'})).status,200)
   clock-=120001
   await stop();await start()
   assert.equal((await send(makeBatch([e(6)]),{nonce:'66666666666666666666666666666666'})).status,409)
   assert.equal(db.prepare('SELECT count(*) n FROM remote_audit_events WHERE audit_id=6').get().n,0)
 })
}finally{await stop()}
