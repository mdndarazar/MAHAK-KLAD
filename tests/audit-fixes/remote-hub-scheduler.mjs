import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as yieldNow } from 'node:timers/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalHubScheduler } from '../../src/main/services/cloud/experimentalHubScheduler.ts'
import { remoteSettingEnabled } from '../../src/main/services/cloud/remoteSettings.ts'

// Fake timers and temporary SQLite/real loopback child. Not Electron, HTTPS,
// Windows, a phone, actual restore coordination or production key protection.
function manual() {
  let time=0,id=0;const tasks=new Map()
  return {
    now:()=>time, setClock:t=>{time=t},
    timers:{set:(fn,ms)=>{const key=++id;tasks.set(key,{fn,at:time+ms});return key},clear:key=>tasks.delete(key)},
    get size(){return tasks.size},
    async advance(ms){time+=ms;const due=[...tasks].filter(([,v])=>v.at<=time);for(const [key,task] of due){tasks.delete(key);task.fn()}for(let i=0;i<6;i++)await yieldNow()}
  }
}
await test('single-flight ticks use bounded backoff and keep refreshing while audit is paused',async()=>{
  const clock=manual();let refresh=0,audit=0,fail=true,notifications=0
  const scheduler=createExperimentalHubScheduler({refreshOnce:async()=>{refresh++},syncOnce:async()=>{audit++;if(fail)throw new Error('network');return {sent:0,lastAcked:0}}},
    {intervalMs:10,startDelayMs:0,retryPauseMs:100,failureLimit:3,now:clock.now,timers:clock.timers,onStatus:()=>{notifications++;throw new Error('UI failure')}})
  scheduler.start();scheduler.start();assert.equal(clock.size,1)
  await clock.advance(0);await clock.advance(10);await clock.advance(10)
  assert.equal(refresh,3);assert.equal(audit,3);assert.equal(scheduler.status().audit,'PAUSED');assert.equal(scheduler.status().auditFailures,3)
  await clock.advance(10);await clock.advance(10);assert.equal(refresh,5);assert.equal(audit,3)
  fail=false;await clock.advance(80);assert.equal(audit,4);assert.equal(scheduler.status().audit,'OK');assert.equal(scheduler.status().auditFailures,0)
  assert.ok(notifications>0);await scheduler.stop();assert.equal(clock.size,0);assert.throws(()=>scheduler.start(),/stopped/)
})
await test('stop waits for in-flight work and prevents audit and rescheduling',async()=>{
  const clock=manual();let release,audit=0
  const waiting=new Promise(resolve=>{release=resolve})
  const scheduler=createExperimentalHubScheduler({refreshOnce:()=>waiting,syncOnce:async()=>{audit++;return {sent:0,lastAcked:0}}},
    {intervalMs:10,startDelayMs:0,now:clock.now,timers:clock.timers})
  scheduler.start();await clock.advance(0)
  assert.equal(scheduler.status().inFlight,true)
  let finished=false;const stopping=scheduler.stop().then(()=>{finished=true});await yieldNow();assert.equal(finished,false)
  release();await stopping;await yieldNow()
  assert.equal(audit,0);assert.equal(scheduler.status().running,false);assert.equal(scheduler.status().inFlight,false);assert.equal(clock.size,0)
})
await test('clock rollback prevents audit; source errors and invalid settings are reported safely',async()=>{
  const clock=manual();clock.setClock(100);let audit=0,override=null
  const s=createExperimentalHubScheduler({refreshOnce:async()=>{throw new Error('source')},syncOnce:async()=>{audit++;return {sent:0,lastAcked:0}}},
    {intervalMs:10,startDelayMs:0,now:()=>override ?? clock.now(),timers:clock.timers})
  s.start();await clock.advance(0);assert.equal(s.status().snapshot,'ERROR');assert.equal(audit,1)
  await clock.advance(10);assert.equal(audit,2)
  override=1;await clock.advance(10);assert.equal(audit,2);assert.equal(s.status().audit,'PAUSED')
  await s.stop()
  assert.throws(()=>createExperimentalHubScheduler(null),/Invalid/)
  assert.throws(()=>createExperimentalHubScheduler({refreshOnce:async()=>{},syncOnce:async()=>{}},{intervalMs:0}),/Invalid/)
})
await test('scheduler drives a real isolated child and authenticated audit sync',async()=>{
  assert.equal(remoteSettingEnabled(mkdtempSync(join(tmpdir(),'mahak-default-off-'))),false)
  const dir=mkdtempSync(join(tmpdir(),'mahak-scheduler-')),hub=mkdtempSync(join(tmpdir(),'mahak-scheduler-hub-')),childFile=join(dir,'hub.cjs')
  await build({entryPoints:[new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url).pathname],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  const store=createClient(join(dir,'isolated-shop.db')),seed=makeSeeder(store)
  seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',note:'PRIVATE'})
  const state=openCloudStateStore(join(dir,'state'))
  state.save({version:1,storeId:'store_scheduler',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
  const before=store.$harness.db.prepare('SELECT total_changes() n').get().n
  const supervisor=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hub,origin:'https://store.example',
    owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,73),snapshotMaxAgeMs:5000,reader:createCloudReader(store),state,readRestoreMarker:async()=>null,timeoutMs:3000})
  let scheduler, timeout
  try {
    const completed=new Promise((resolve,reject)=>{
      timeout=setTimeout(()=>reject(new Error('scheduled sync timeout')),3000)
      scheduler=createExperimentalHubScheduler(supervisor,{intervalMs:25,startDelayMs:0,onStatus:status=>{if(status.snapshot==='OK' && status.audit==='OK')resolve()}})
    })
    scheduler.start();await completed
    assert.equal(state.load().lastAcked,1);assert.equal(store.$harness.db.prepare('SELECT total_changes() n').get().n,before)
  } finally {clearTimeout(timeout);if(scheduler)await scheduler.stop();await supervisor.stop();state.close();await store.$disconnect()}
})
