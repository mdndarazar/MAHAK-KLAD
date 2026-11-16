import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { mkdtempSync, existsSync, readFileSync, linkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoopbackAuditTransport } from '../../src/main/services/cloud/loopbackAuditTransport.ts'
import { createAuditSync } from '../../src/main/services/cloud/auditSync.ts'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'

// A real child process, loopback HTTP and dedicated temporary SQLite files only.
// This is not Electron, Windows, HTTPS, a mobile device or production integration.
const root = process.cwd(), dir = mkdtempSync(join(tmpdir(),'mahak-child-hub-test-'))
const childFile = join(dir,'hub.cjs')
await build({entryPoints:[new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url).pathname],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
const key=Buffer.alloc(32,21), origin='https://store.example'
const config = (directory, owner = {username:'owner',password:'owner-test-password',pin:'746392'}) => ({directory,origin,owner,auditKey:key.toString('hex'),snapshotMaxAgeMs:1200})
const snapshot = {boundary:{source:'HISTORICAL_BOUNDARY',id:7,atDatabaseValue:'1700000000000',kind:'HANDOVER',operationalDay:'1405/01/01',theoreticalExpectedTotal:'9007199254740993',observedOperationalTotal:'9',totalTheoreticalDifference:'-2'},shifts:[{id:2,name:'shift',number:1,operationalDay:'1405/01/01',openedAtDatabaseValue:'1700000000000'}]}
const createChild = () => {
  const child=fork(childFile,[],{cwd:root,execArgv:[],stdio:['ignore','ignore','pipe','ipc']})
  let logs=''; child.stderr.on('data',x=>{ logs+=x.toString() })
  const queue=[], waiters=[]
  child.on('message',value=>{const waiter=waiters.shift();if(waiter){clearTimeout(waiter.timer);waiter.resolve(value)}else queue.push(value)})
  const next=()=>queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve,reject)=>{
    const waiter={resolve,reject,timer:setTimeout(()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);reject(new Error(`child message timeout: ${logs}`))},5000)};waiters.push(waiter)
  })
  const exited=()=>child.exitCode!==null || child.signalCode!==null ? Promise.resolve() : new Promise(resolve=>child.once('exit',resolve))
  const stop=async()=>{if(child.connected){child.send({type:'stop'});await next()}await exited()}
  return {child,next,exited,stop}
}
function send(port,path,{method='GET',body,headers={}}={}) {
  const data=body===undefined?null:Buffer.from(JSON.stringify(body))
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:{host:'store.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
    const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
  });req.on('error',reject);req.end(data??undefined)})
}
const login=(port,username='owner',password='owner-test-password')=>send(port,'/api/login',{method:'POST',body:{username,password},headers:{origin,'x-mahak-request':'1'}})
const hash=x=>createHash('sha256').update(x).digest('hex')
const event={id:1,at:'1700000000000',action:'SALE_CREATE',entity:'SaleInvoice'}
const batch={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',events:[event]}
batch.digest=hash(JSON.stringify([1,batch.storeId,batch.epoch,[[event.id,event.at,event.action,event.entity]]]))
const hubDir=mkdtempSync(join(tmpdir(),'mahak-child-hub-db-'))
let instance, ready, cookie
try {
  await test('isolated child starts two loopback listeners with no desktop grant API',async()=>{
    instance=createChild();instance.child.send({type:'start',config:config(hubDir)});ready=await instance.next()
    assert.equal(ready.type,'ready');assert.notEqual(ready.pid,process.pid);assert.notEqual(ready.mobilePort,ready.auditPort)
    assert.equal((await send(ready.mobilePort,'/')).status,200)
    assert.equal((await send(ready.mobilePort,'/api/custody')).status,401)
    assert.equal((await send(ready.mobilePort,'/internal/v1/audit')).status,404)
    assert.equal((await send(ready.auditPort,'/')).status,404)
    const r=await login(ready.mobilePort);assert.equal(r.status,200);cookie=r.headers['set-cookie'][0].split(';')[0]
    assert.equal((await send(ready.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
  })
  await test('private snapshots are bounded, allowlisted and expire instead of silently serving stale data',async()=>{
    instance.child.send({type:'snapshot',capturedAtMs:Date.now(),value:{...snapshot,extra:'PRIVATE'}});assert.deepEqual(await instance.next(),{type:'snapshot',ok:false})
    assert.equal((await send(ready.mobilePort,'/api/shifts',{headers:{cookie}})).status,503)
    instance.child.send({type:'snapshot',capturedAtMs:Date.now()-1500,value:snapshot});assert.deepEqual(await instance.next(),{type:'snapshot',ok:false})
    instance.child.send({type:'snapshot',capturedAtMs:Date.now()+10000,value:snapshot});assert.deepEqual(await instance.next(),{type:'snapshot',ok:false})
    instance.child.send({type:'snapshot',capturedAtMs:Date.now(),value:snapshot});assert.deepEqual(await instance.next(),{type:'snapshot',ok:true})
    const boundary=await send(ready.mobilePort,'/api/custody',{headers:{cookie}})
    assert.equal(boundary.status,200);assert.deepEqual(JSON.parse(boundary.body).boundary,snapshot.boundary)
    assert.deepEqual(JSON.parse((await send(ready.mobilePort,'/api/shifts',{headers:{cookie}})).body).shifts,snapshot.shifts)
    await delay(1250)
    assert.equal((await send(ready.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
  })
  await test('audit reaches a separate authenticated loopback port and is durably stored in hub SQLite',async()=>{
    const address=`http://127.0.0.1:${ready.auditPort}/internal/v1/audit`
    await assert.rejects(createLoopbackAuditTransport(address,Buffer.alloc(32,2)).send(batch))
    assert.equal((await createLoopbackAuditTransport(address,key).send(batch)).lastId,1)
    assert.equal((await createLoopbackAuditTransport(address,key).send(batch)).lastId,1)
  })
  await test('isolated store SELECTs and acknowledged audit synchronize across the process boundary',async()=>{
    const source=mkdtempSync(join(tmpdir(),'mahak-child-source-')),store=createClient(join(source,'isolated-shop.db')),seed=makeSeeder(store)
    seed.insert('CustodyAggregateBoundary',{boundaryKind:'HANDOVER',operationalDay:'1405-01-02',idempotencyKey:'b1',at:1700000000001,theoreticalExpectedTotal:9007199254740993n,observedOperationalTotal:9007199254740973n,totalTheoreticalDifference:-20n})
    seed.insert('Shift',{name:'test shift',number:1,dayJalali:'1405/01/02',openedAt:1700000000000,note:'PRIVATE SHIFT NOTE'})
    seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',before:'PRIVATE AUDIT',after:'PRIVATE AUDIT',note:'PRIVATE AUDIT'})
    const state=openCloudStateStore(join(source,'sync-state'))
    state.save({version:1,storeId:'store_child',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
    try {
      const reader=createCloudReader(store),before=store.$harness.db.prepare('SELECT total_changes() n').get().n,capturedAtMs=Date.now()
      const boundary=await reader.latestBoundaryTotals(),shifts=await reader.openShiftsPage(0,200)
      instance.child.send({type:'snapshot',capturedAtMs,value:{boundary,shifts}});assert.deepEqual(await instance.next(),{type:'snapshot',ok:true})
      const observed=await send(ready.mobilePort,'/api/custody',{headers:{cookie}})
      assert.equal(JSON.parse(observed.body).boundary.theoreticalExpectedTotal,'9007199254740993')
      assert.ok(!JSON.stringify(shifts).includes('PRIVATE SHIFT NOTE'))
      const sync=createAuditSync({state,reader,transport:createLoopbackAuditTransport(`http://127.0.0.1:${ready.auditPort}/internal/v1/audit`,key),readRestoreMarker:async()=>null})
      assert.deepEqual(await sync.runOnce(),{sent:1,lastAcked:1})
      assert.equal(store.$harness.db.prepare('SELECT total_changes() n').get().n,before)
    } finally {state.close();await store.$disconnect()}
  })
  await test('password hashing in child cannot block the parent event loop',async()=>{
    let ticks=0;const timer=setInterval(()=>ticks++,5)
    try { const results=await Promise.all(Array.from({length:6},()=>login(ready.mobilePort,'unknown','wrong-password')));assert.ok(results.every(r=>r.status===401));assert.ok(ticks>=3,`only ${ticks} parent timer ticks`) }
    finally {clearInterval(timer)}
  })
  await test('a second child cannot take ownership of the same database lock',async()=>{
    const second=createChild();second.child.send({type:'start',config:config(hubDir,null)})
    assert.deepEqual(await second.next(),{type:'error',operation:'start'});await second.exited()
    assert.equal(existsSync(join(hubDir,'remote-hub.lock')),true)
    assert.equal((await send(ready.mobilePort,'/api/session',{headers:{cookie}})).status,200)
  })
  await test('clean stop releases lock and restart preserves identity and audit records',async()=>{
    await instance.stop();instance=null
    assert.equal(existsSync(join(hubDir,'remote-hub.lock')),false)
    const db=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_audit_events').get().n,2)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_members').get().n,1)
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM remote_audit_events').all()).includes('PRIVATE AUDIT'))
    } finally {db.close()}
    instance=createChild();instance.child.send({type:'start',config:config(hubDir,null)});ready=await instance.next();assert.equal(ready.type,'ready')
    assert.equal((await login(ready.mobilePort)).status,200)
    assert.equal((await send(ready.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
  })
  await test('pre-existing application SQLite and symlink/hardlink files are never modified',async()=>{
    for(const kind of ['application','symlink','hardlink']) {
      const d=mkdtempSync(join(tmpdir(),'mahak-child-sentinel-')),target=join(d,'sentinel.sqlite'),candidate=join(d,'remote-hub.sqlite')
      const db=new DatabaseSync(target);db.exec('CREATE TABLE "User"(name TEXT); INSERT INTO "User" VALUES (\'do-not-modify\')');db.close()
      if(kind==='application') { const {copyFileSync}=await import('node:fs');copyFileSync(target,candidate) }
      if(kind==='symlink') symlinkSync(target,candidate)
      if(kind==='hardlink') linkSync(target,candidate)
      const before=hash(readFileSync(target)), beforeCandidate=hash(readFileSync(candidate)), child=createChild()
      child.child.send({type:'start',config:config(d)});assert.deepEqual(await child.next(),{type:'error',operation:'start'});await child.exited()
      assert.equal(hash(readFileSync(target)),before);assert.equal(hash(readFileSync(candidate)),beforeCandidate)
      assert.equal(existsSync(join(d,'remote-hub.lock')),false)
    }
  })
  await test('a stop queued immediately after start cannot leave a listener or lock behind',async()=>{
    const d=mkdtempSync(join(tmpdir(),'mahak-child-stop-')),child=createChild()
    child.child.send({type:'start',config:config(d)});child.child.send({type:'stop'})
    const first=await child.next(),second=await child.next();assert.equal(first.type,'ready');assert.deepEqual(second,{type:'stopped'});await child.exited()
    assert.equal(existsSync(join(d,'remote-hub.lock')),false)
    await assert.rejects(send(first.mobilePort,'/'))
  })
  await test('parent disconnect releases the lock; an abrupt crash leaves it fail-closed',async()=>{
    const clean=mkdtempSync(join(tmpdir(),'mahak-child-disconnect-')),first=createChild()
    first.child.send({type:'start',config:config(clean)});assert.equal((await first.next()).type,'ready')
    first.child.disconnect();await first.exited();assert.equal(existsSync(join(clean,'remote-hub.lock')),false)
    const crashed=mkdtempSync(join(tmpdir(),'mahak-child-crash-')),second=createChild()
    second.child.send({type:'start',config:config(crashed)});assert.equal((await second.next()).type,'ready')
    second.child.kill('SIGKILL');await second.exited();assert.equal(existsSync(join(crashed,'remote-hub.lock')),true)
    const third=createChild();third.child.send({type:'start',config:config(crashed,null)})
    assert.deepEqual(await third.next(),{type:'error',operation:'start'});await third.exited()
    assert.equal(existsSync(join(crashed,'remote-hub.lock')),true)
  })
} finally { if(instance) await instance.stop() }
