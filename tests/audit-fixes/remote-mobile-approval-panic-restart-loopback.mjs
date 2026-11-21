import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,getRequestStatus,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child HTTP, desktop registry and panelSession; all databases and keys are
// temporary. No Electron, Windows, production credentials, phone or tunnel.
test('mobile-approved panel is revoked by P2 and panic survives child and supervisor restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-approval-panic-')),childFile=join(dir,'child.cjs'),hubDir=join(dir,'hub'),stateDir=join(dir,'state');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'shop-isolated.db')
 const session=await import('../../src/main/services/panelSession.ts'),{prisma}=await import('../../src/main/db/client.ts')
 let state=openCloudStateStore(stateDir),hub
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:session.notePanelUnlocked,clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions})
 const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}}
 const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
 try {
  hub=await startExperimentalHubSupervisor(options)
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  assert.equal(getRequestStatus(42,'shifts',p.requestId),'APPROVED');assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true)
  assert.equal(isGrantActiveForWindow('shifts',42),true);assert.equal(session.isPanelUnlocked('shifts',42),true)
  const pending=requestCode('shifts',43)
  const result=await send('POST','/api/panic',{pin:'746392'},login.cookie);assert.equal(result.status,200)
  assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(session.isPanelUnlocked('shifts',42),false);assert.equal(getRequestStatus(43,'shifts',pending.requestId),'UNAVAILABLE')
  assert.equal(state.openRevocationLedger().load().id,1)
  const replay=JSON.parse(readFileSync(join(stateDir,'grant-replay-ledger.json'),'utf8'));assert.equal(replay.entries.length,1)
  await hub.stop();hub=null;state.close();state=openCloudStateStore(stateDir)
  const entry=replay.entries[0];assert.equal(state.openGrantReplayLedger().consume(entry.requestId,entry.nonce,entry.expiresAt,Math.max(replay.latest,entry.expiresAt-1)),'REPLAY')
  hub=await startExperimentalHubSupervisor({...options,state,owner:null})
  assert.notEqual((await send('POST','/api/login',{username:'owner',password:'owner-test-password'})).status,200)
  const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
  try {assert.equal(inspect.prepare('SELECT latched FROM remote_identity_panic WHERE id=1').get().latched,1);assert.equal(inspect.prepare('SELECT last_ack FROM remote_revocation_delivery WHERE id=1').get().last_ack,1);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,0)} finally {inspect.close()}
  assert.equal(session.isPanelUnlocked('shifts',42),false);assert.equal(isGrantActiveForWindow('shifts',42),false)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();session.clearPanelSessions(42);state.close();await prisma.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
