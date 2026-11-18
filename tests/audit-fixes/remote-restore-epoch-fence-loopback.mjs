import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync,mkdirSync,rmSync,copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child and isolated SQLite. Direct experimental barrier; no BackupService,
// Electron, Windows, external writer, phone, actual protected key or tunnel.
test('restoring fences old epoch before mutation, and restart rejects old ledgers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-restore-epoch-')),hubDir=join(dir,'hub'),stateDir=join(dir,'state'),childFile=join(dir,'child.cjs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const dbFile=join(dir,'shop.db'),source=join(dir,'backup.db')
 for(const [path,value] of [[dbFile,1],[source,2]]){const db=new DatabaseSync(path);db.exec(`CREATE TABLE x (value INTEGER); INSERT INTO x VALUES (${value})`);db.close()}
 let state=openCloudStateStore(stateDir),hub
 const epoch='12345678-1234-4123-8123-123456789abc'
 state.save({version:1,storeId:'store_test',epoch,lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}},state,restoreBarrier:createExperimentalRestoreBarrier(),readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}}
 try {
  hub=await startExperimentalHubSupervisor(options)
  let rotated
  await hub.restoreExclusive(async()=>{rotated=state.load().epoch;assert.notEqual(rotated,epoch);assert.equal(state.load().lastAcked,0);copyFileSync(source,dbFile)})
  await assert.rejects(hub.syncOnce(),/unavailable/);await assert.rejects(hub.refreshOnce(),/unavailable/)
  const db=new DatabaseSync(dbFile,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM x').get().value,2)}finally{db.close()}
  await hub.stop();hub=null;state.close();state=openCloudStateStore(stateDir)
  assert.equal(state.load().epoch,rotated)
  assert.throws(()=>state.openRevocationLedger(),/ledger/);assert.throws(()=>state.openGrantReplayLedger(),/ledger/)
  await assert.rejects(startExperimentalHubSupervisor({...options,state,owner:null}),/ledger/)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
