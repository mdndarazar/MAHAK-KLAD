import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync,copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,getRequestStatus,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child, loopback and isolated SQLite files; restoreExclusive is invoked
// explicitly. Not BackupService, Electron, external writers, Windows or phone.
test('restore barrier revokes a mobile-approved grant and waits for active reads before replacement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-restore-admission-')),hubDir=join(dir,'hub'),childFile=join(dir,'hub.cjs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const shop=join(dir,'shop.db'),replacement=join(dir,'replacement.db')
 for (const [path,value] of [[shop,1],[replacement,2]]) {const db=new DatabaseSync(path);db.exec(`CREATE TABLE data (value INTEGER); INSERT INTO data VALUES (${value})`);db.close()}
 const state=openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'harness.db')
 const session=await import('../../src/main/services/panelSession.ts'),{prisma}=await import('../../src/main/db/client.ts')
 initRemoteGrantRegistry({notePanelUnlocked:session.notePanelUnlocked,clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions})
 let hold=false,release,entered,hub,restore,refresh
 const reader={latestBoundaryTotals:async()=>{if(hold){entered();await new Promise(r=>{release=r})}return null},openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}}
 const barrier=createExperimentalRestoreBarrier()
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,restoreBarrier:barrier,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(session.isPanelUnlocked('shifts',42),true)
  const pending=requestCode('shifts',43),started=new Promise(r=>{entered=r});hold=true;refresh=hub.refreshOnce();await started
  let replaced=false
  restore=hub.restoreExclusive(async()=>{copyFileSync(replacement,shop);replaced=true})
  assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(session.isPanelUnlocked('shifts',42),false)
  assert.equal(getRequestStatus(43,'shifts',pending.requestId),'UNAVAILABLE');assert.throws(()=>requestCode('shifts',44),/admission closed/)
  assert.equal(replaced,false);assert.equal(barrier.status().state,'DRAINING')
  release();await assert.rejects(refresh,/Restore in progress/);await restore
  assert.equal(replaced,true);const db=new DatabaseSync(shop,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM data').get().value,2)}finally{db.close()}
  assert.equal(barrier.status().state,'OPEN');assert.throws(()=>requestCode('shifts',44),/admission closed/)
  assert.notEqual((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
 } finally {release?.();await restore?.catch(()=>{});await refresh?.catch(()=>{});if(hub)await hub.stop().catch(()=>{});revokeAll();session.clearPanelSessions(42);state.close();await prisma.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
