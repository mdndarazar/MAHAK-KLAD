import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { remoteImplementationReady } from '../../src/shared/remoteAuthChannels.ts'

// Real separate process + loopback + temporary SQLite. Not Electron, a phone,
// HTTPS, Windows, production key provisioning or permission configuration.
const dir=mkdtempSync(join(tmpdir(),'mahak-supervisor-')), childFile=join(dir,'hub.cjs')
await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
const hubDir=mkdtempSync(join(tmpdir(),'mahak-supervisor-hub-')),store=createClient(join(dir,'isolated-shop.db')),seed=makeSeeder(store)
seed.insert('CustodyAggregateBoundary',{boundaryKind:'HANDOVER',operationalDay:'1405-01-02',idempotencyKey:'b1',at:1700000000001,theoreticalExpectedTotal:9007199254740993n,observedOperationalTotal:9007199254740973n,totalTheoreticalDifference:-20n})
seed.insert('Shift',{name:'source shift',number:1,dayJalali:'1405/01/02',openedAt:1700000000000,note:'PRIVATE SHIFT NOTE'})
seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',before:'PRIVATE AUDIT',after:'PRIVATE AUDIT',note:'PRIVATE AUDIT'})
const state=openCloudStateStore(join(dir,'state'))
state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
const real=createCloudReader(store);let failBoundary=false,hold=null,marker=null,epochOverride=null
const observedState={load(){const value=state.load();return value && epochOverride ? {...value,epoch:epochOverride} : value},save:value=>state.save(value)}
const reader={
  async latestBoundaryTotals(){ if(failBoundary)throw new Error('source unavailable');if(hold)await hold;return real.latestBoundaryTotals() },
  openShiftsPage:(...args)=>real.openShiftsPage(...args), auditPage:(...args)=>real.auditPage(...args)
}
const key=Buffer.alloc(32,34),origin='https://store.example'
const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin,owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:key,snapshotMaxAgeMs:5000,reader,state:observedState,readRestoreMarker:async()=>marker,timeoutMs:3000}
function send(port,path,{method='GET',body,headers={}}={}){
  const data=body===undefined?null:Buffer.from(JSON.stringify(body))
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:{host:'store.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
  });req.on('error',reject);req.end(data??undefined)})
}
let supervisor,cookie
try {
  await test('config and unavailable runtime fail without enabling remote access',async()=>{
    assert.equal(remoteImplementationReady(),false)
    await assert.rejects(startExperimentalHubSupervisor({...options,nodeExecutable:'relative-node'}),/Invalid/)
    await assert.rejects(startExperimentalHubSupervisor({...options,auditKey:Buffer.alloc(31)}),/Invalid/)
    await assert.rejects(startExperimentalHubSupervisor({...options,nodeExecutable:join(dir,'missing-node')}),/unavailable/)
    assert.equal(existsSync(join(hubDir,'remote-hub.lock')),false)
  })
  await test('POS environment and database URL are not inherited by the child',async()=>{
    const probe=join(dir,'environment-probe.cjs')
    writeFileSync(probe, `process.on('message',m=>{if(m.type==='start')process.send({type:'ready',pid:process.pid,mobilePort:process.env.MAHAK_ENV_SECRET||process.env.DATABASE_URL?3001:3002,auditPort:3003});if(m.type==='stop'){process.send({type:'stopped'});process.disconnect()}})`)
    const originalSecret=process.env.MAHAK_ENV_SECRET, originalDatabase=process.env.DATABASE_URL
    process.env.MAHAK_ENV_SECRET='secret';process.env.DATABASE_URL='file:should-not-be-passed'
    try { const check=await startExperimentalHubSupervisor({...options,childFile:probe});assert.equal(check.mobilePort,3002);await check.stop() }
    finally {
      if(originalSecret===undefined)delete process.env.MAHAK_ENV_SECRET;else process.env.MAHAK_ENV_SECRET=originalSecret
      if(originalDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabase
    }
  })
  await test('explicit child supervisor produces no data until a read-only refresh',async()=>{
    supervisor=await startExperimentalHubSupervisor(options)
    const response=await send(supervisor.mobilePort,'/api/login',{method:'POST',body:{username:'owner',password:'owner-test-password'},headers:{origin,'x-mahak-request':'1'}})
    assert.equal(response.status,200);cookie=response.headers['set-cookie'][0].split(';')[0]
    assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
    const before=store.$harness.db.prepare('SELECT total_changes() n').get().n
    await supervisor.refreshOnce()
    const boundary=await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})
    assert.equal(boundary.status,200);assert.equal(JSON.parse(boundary.body).boundary.theoreticalExpectedTotal,'9007199254740993')
    const shifts=await send(supervisor.mobilePort,'/api/shifts',{headers:{cookie}})
    assert.equal(JSON.parse(shifts.body).shifts[0].name,'source shift');assert.ok(!shifts.body.includes('PRIVATE SHIFT NOTE'))
    assert.equal(store.$harness.db.prepare('SELECT total_changes() n').get().n,before)
  })
  await test('acknowledged audit cycle is transferred without changing the source database',async()=>{
    const before=store.$harness.db.prepare('SELECT total_changes() n').get().n
    assert.deepEqual(await supervisor.syncOnce(),{sent:1,lastAcked:1});assert.equal(state.load().lastAcked,1)
    assert.equal(store.$harness.db.prepare('SELECT total_changes() n').get().n,before)
    assert.deepEqual(await supervisor.syncOnce(),{sent:0,lastAcked:1})
  })
  await test('failed refresh immediately removes the previously published snapshot',async()=>{
    failBoundary=true
    await assert.rejects(supervisor.refreshOnce(),/source unavailable/)
    assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
    failBoundary=false;await supervisor.refreshOnce()
    assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,200)
  })
  await test('known restore marker and epoch changes reject refresh and invalidate prior snapshot',async()=>{
    marker='a'.repeat(64)
    await assert.rejects(supervisor.refreshOnce(),/Restore detected/)
    assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
    marker=null;await supervisor.refreshOnce()
    for(const change of ['marker','epoch']) {
      let release,entered
      const started=new Promise(resolve=>{entered=resolve})
      hold=new Promise(resolve=>{release=resolve})
      const original=reader.latestBoundaryTotals
      reader.latestBoundaryTotals=async()=>{entered();return original()}
      const pending=supervisor.refreshOnce();await started
      // No previous snapshot is served while a potentially slow read is pending.
      assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
      if(change==='marker')marker='b'.repeat(64)
      else epochOverride='87654321-4321-4321-8321-cba987654321'
      release();await assert.rejects(pending,/Restore detected/)
      hold=null;marker=null;epochOverride=null;reader.latestBoundaryTotals=original
      assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
      await supervisor.refreshOnce()
    }
  })
  await test('overlapping refresh is rejected instead of accumulating unbounded work',async()=>{
    let release;hold=new Promise(resolve=>{release=resolve})
    const first=supervisor.refreshOnce()
    await assert.rejects(supervisor.refreshOnce(),/busy/)
    release();await first;hold=null
  })
  await test('stop closes listeners and leaves durable hub audit free of private fields',async()=>{
    const port=supervisor.mobilePort, stopping=supervisor.stop()
    assert.equal(supervisor.stop(),stopping);await stopping;await supervisor.stop()
    await assert.rejects(supervisor.refreshOnce(),/unavailable/);await assert.rejects(send(port,'/'))
    assert.equal(existsSync(join(hubDir,'remote-hub.lock')),false)
    const db=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
    try{const rows=db.prepare('SELECT * FROM remote_audit_events').all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('PRIVATE AUDIT'))}finally{db.close()}
  })
  await test('a replaced lock is never removed and stop does not claim successful cleanup',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'mahak-supervisor-replaced-lock-'))
    const second=await startExperimentalHubSupervisor({...options,directory})
    const lock=join(directory,'remote-hub.lock');writeFileSync(lock,'not-our-lock')
    await assert.rejects(second.stop(),/without confirmed cleanup/)
    assert.equal(readFileSync(lock,'utf8'),'not-our-lock')
  })
} finally { if(supervisor)await supervisor.stop();state.close();await store.$disconnect() }
