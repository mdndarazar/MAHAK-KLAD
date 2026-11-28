import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

test('startup checks live database before opening desktop admission',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-start-fence-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const databaseFile=join(dir,'shop.db'),replacement=join(dir,'replacement.db')
 for(const path of [databaseFile,replacement]) {const db=new DatabaseSync(path);db.exec('CREATE TABLE test_value (value TEXT)');db.close()}
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 state.initializeRevocationLedger()
 let entered,release
 const reached=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 try {
  const result=startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>{entered();await gate;return null},databaseFile,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}}).then(hub=>({hub}),error=>({error}))
  await reached
  assert.throws(()=>requestCode('shifts',41),/admission closed/)
  renameSync(databaseFile,join(dir,'old.db'));renameSync(replacement,databaseFile);release()
  const outcome=await result
  if(outcome.hub) {await outcome.hub.stop();assert.fail('startup should reject replaced database')}
  assert.ok(outcome.error)
  assert.throws(()=>requestCode('shifts',42),/admission closed/)
 } finally {release();revokeAll();state.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
