import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { build } from 'esbuild'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalHubScheduler } from '../../src/main/services/cloud/experimentalHubScheduler.ts'
import { remoteImplementationReady } from '../../src/shared/remoteAuthChannels.ts'

// Portable Node 24 compatibility test; on Windows CI this uses a real Windows
// child and temporary SQLite files, not Electron, DPAPI, HTTPS, or a phone.
assert.equal(Number(process.versions.node.split('.')[0]),24,'Node 24 required')
const dir=mkdtempSync(join(tmpdir(),'mahak-win24-test-')),hub=mkdtempSync(join(tmpdir(),'mahak-win24-hub-')),childFile=join(dir,'hub.cjs')
await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node24',logLevel:'silent'})
const store=createClient(join(dir,'isolated-store.db')),seed=makeSeeder(store)
seed.insert('CustodyAggregateBoundary',{boundaryKind:'HANDOVER',operationalDay:'1405-01-02',idempotencyKey:'b1',at:1700000000001,theoreticalExpectedTotal:9007199254740993n,observedOperationalTotal:9007199254740973n,totalTheoreticalDifference:-20n})
seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',note:'PRIVATE'})
const state=openCloudStateStore(join(dir,'state'))
state.save({version:1,storeId:'win24_store',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
const reader=createCloudReader(store),origin='https://store.example'
const options={nodeExecutable:process.execPath,childFile,directory:hub,origin,owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,77),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:10000}
function send(port,path,{method='GET',body,headers={}}={}){
  const data=body===undefined?null:Buffer.from(JSON.stringify(body))
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:{host:'store.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
    const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
  });req.on('error',reject);req.end(data??undefined)})
}
let supervisor,scheduler,timer
try {
  await test('Node 24 starts an isolated child and default remote readiness remains disabled',async()=>{
    assert.equal(remoteImplementationReady(),false)
    supervisor=await startExperimentalHubSupervisor(options)
    const response=await send(supervisor.mobilePort,'/api/login',{method:'POST',body:{username:'owner',password:'owner-test-password'},headers:{origin,'x-mahak-request':'1'}})
    assert.equal(response.status,200)
    const cookie=response.headers['set-cookie'][0].split(';')[0]
    assert.equal((await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})).status,503)
    const before=store.$harness.db.prepare('SELECT total_changes() n').get().n
    const complete=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('sync timeout')),10000)
      scheduler=createExperimentalHubScheduler(supervisor,{intervalMs:50,startDelayMs:0,onStatus:s=>{if(s.snapshot==='OK'&&s.audit==='OK')resolve()}})
    })
    scheduler.start();await complete;clearTimeout(timer)
    const value=await send(supervisor.mobilePort,'/api/custody',{headers:{cookie}})
    assert.equal(value.status,200);assert.equal(JSON.parse(value.body).boundary.theoreticalExpectedTotal,'9007199254740993')
    assert.equal(state.load().lastAcked,1);assert.equal(store.$harness.db.prepare('SELECT total_changes() n').get().n,before)
  })
  await test('stop and restart preserve durable state; wrong key fails closed',async()=>{
    await scheduler.stop();scheduler=null;await supervisor.stop();supervisor=null
    assert.equal(existsSync(join(hub,'remote-hub.lock')),false)
    await assert.rejects(startExperimentalHubSupervisor({...options,owner:null,auditKey:Buffer.alloc(32,4)}),/unavailable/)
    supervisor=await startExperimentalHubSupervisor({...options,owner:null})
    assert.deepEqual(await supervisor.syncOnce(),{sent:0,lastAcked:1})
    await supervisor.stop();supervisor=null
  })
} finally {if(timer)clearTimeout(timer);if(scheduler)await scheduler.stop();if(supervisor)await supervisor.stop();state.close();await store.$disconnect()}
