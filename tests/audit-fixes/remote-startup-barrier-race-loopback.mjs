import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Exercise the interval between the guarded startup check and admission.open:
// a coordinated restore is started immediately after the check returns.
test('startup must not open admission if restore begins after its check',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-start-race-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 state.initializeRevocationLedger()
 const real=createExperimentalRestoreBarrier()
 let release,restorePromise
 const gate=new Promise(resolve=>{release=resolve})
 const barrier={status:real.status,restore:real.restore,async run(operation){const result=await real.run(operation);restorePromise=real.restore(async()=>{await gate});return result}}
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 try {
  const outcome=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}},state,readRestoreMarker:async()=>null,restoreBarrier:barrier,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}}).then(hub=>({hub}),error=>({error}))
  if(outcome.hub) {await outcome.hub.stop();assert.fail('startup must fail while restore is draining')}
  assert.ok(outcome.error);assert.equal(real.status().state,'DRAINING')
  assert.throws(()=>requestCode('shifts',41),/admission closed/)
 } finally {release();if(restorePromise)await restorePromise;revokeAll();state.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
