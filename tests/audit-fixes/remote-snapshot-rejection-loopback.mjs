import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Real child and IPC, with isolated state. No shop DB, Electron or phone.
test('child returns sanitized diagnostics for a rejected snapshot without disclosing its data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-reject-snapshot-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[{name:'PRIVATE',id:0}],auditPage:async()=>[]}
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000})
  await assert.rejects(hub.refreshOnce(),error=>{assert.equal(error.message,'Hub rejected snapshot (invalid-payload)');assert.ok(!error.message.includes('PRIVATE'));return true})
 } finally {if(hub)await hub.stop();state.close();rmSync(dir,{recursive:true,force:true})}
})
