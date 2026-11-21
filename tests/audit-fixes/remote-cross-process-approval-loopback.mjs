import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,getRequestStatus,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Experimental, real child HTTP + desktop registry; no Electron, customer data,
// production key, phone or tunnel. The injected replay DB and panel are temporary.
test('mobile approval through child to desktop registry, then member revoke and ACK',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-approval-ipc-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger()
 const replayDb=new DatabaseSync(join(dir,'replay.sqlite'));const replayStore=createDurableGrantReplay(replayDb,'store_test')
 const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]}
 let cleared=0,hub
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{cleared++},clearPanelSessions:()=>{}})
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}},replayStore}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{
   const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
  })
  const owner=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(owner.status,200)
  const invite=await send('POST','/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'shifts',view:true,approve:true}]},owner.cookie);assert.equal(invite.status,200)
  assert.equal((await send('POST','/api/invite/accept',{invite:invite.body.invite,username:'manager',password:'manager-test-password',pin:'482931'})).status,200)
  assert.equal((await send('POST','/api/member/approve',{username:'manager',pin:'746392'},owner.cookie)).status,200)
  const manager=await send('POST','/api/login',{username:'manager',password:'manager-test-password'});assert.equal(manager.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30 && !seen;i++){const r=await send('GET','/api/requests',undefined,manager.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen,'pending request arrived through parent mirror')
  const badCode=p.code==='123456'?'654321':'123456'
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:badCode,pin:'482931'},manager.cookie)).status,403)
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'000000'},manager.cookie)).status,403)
  const ok=await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'482931'},manager.cookie)
  assert.equal(ok.status,200,JSON.stringify(ok));assert.equal(getRequestStatus(42,'shifts',p.requestId),'APPROVED')
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'482931'},manager.cookie)).status,403)
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',42),true)
  assert.equal((await send('POST','/api/member/remove',{username:'manager',pin:'746392'},owner.cookie)).status,200)
  assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(cleared,1)
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'482931'},manager.cookie)).status,401)
  const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true});try{assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,1);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,0)}finally{inspect.close()}
  assert.equal(state.openRevocationLedger().load().id,1)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();replayDb.close();rmSync(dir,{recursive:true,force:true})}
})
