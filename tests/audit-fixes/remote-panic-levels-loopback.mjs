import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,createGrant,consumeOneShot,isGrantActiveForWindow,revokeAll,getRequestStatus } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real supervisor/child, HTTP and registry with dedicated temporary databases.
// No Electron, real data, network tunnel, phone, production key or Windows.
test('P1 closes grants without P2 pause; P2 then latches and ends sessions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-supervisor-revoke-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub')
 const {mkdirSync}=await import('node:fs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const stateValue={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
 const state=openCloudStateStore(join(dir,'state'));state.save(stateValue);state.initializeRevocationLedger()
 const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]}
 let cleared=0
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{cleared++},clearPanelSessions:()=>{}})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}})
  const send=(path,body,cookie)=>new Promise((resolve,reject)=>{
   const data=Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':data.length,...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
  })
  const login=await send('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const invite=await send('/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'shifts',view:true,approve:false}]},login.cookie);assert.equal(invite.status,200)
  assert.equal((await send('/api/invite/accept',{invite:invite.body.invite,username:'manager',password:'manager-test-password',pin:'482931'})).status,200)
  assert.equal((await send('/api/member/approve',{username:'manager',pin:'746392'},login.cookie)).status,200)
  const manager=await send('/api/login',{username:'manager',password:'manager-test-password'});assert.equal(manager.status,200)
  assert.equal((await send('/api/panic/close',{pin:'482931'},manager.cookie)).status,403)
  assert.equal((await send('/api/panic',{pin:'482931'},manager.cookie)).status,403)
  const p=requestCode('shifts',42);assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}))
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',42),true)
  const pending=requestCode('settings',43)
  assert.equal((await send('/api/panic/close',{pin:'000000'},login.cookie)).status,403)
  assert.equal(isGrantActiveForWindow('shifts',42),true)
  const close=await send('/api/panic/close',{pin:'746392'},login.cookie)
  assert.equal(close.status,200,JSON.stringify(close));assert.equal(close.cookie,undefined)
  assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(cleared,1)
  assert.equal(getRequestStatus(43,'settings',pending.requestId),'UNAVAILABLE')
  const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
  inspect.exec('PRAGMA busy_timeout=5000')
  try {
    assert.equal(inspect.prepare('SELECT paused FROM remote_identity_meta WHERE id=1').get().paused,0)
    assert.equal(inspect.prepare('SELECT latched FROM remote_identity_panic WHERE id=1').get().latched,0)
    assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,1)
  } finally {inspect.close()}
  // P1 preserved the owner session; using it for P2 proves it wasn't logged out.
  const p2=await send('/api/panic',{pin:'746392'},login.cookie)
  assert.equal(p2.status,200,JSON.stringify(p2));assert.match(p2.cookie,/mahak_session=/)
  assert.equal((await send('/api/panic/close',{pin:'746392'},login.cookie)).status,401)
  assert.notEqual((await send('/api/login',{username:'owner',password:'owner-test-password'})).status,200)
  const inspect2=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
  inspect2.exec('PRAGMA busy_timeout=5000')
  try {
    assert.equal(inspect2.prepare('SELECT paused FROM remote_identity_meta WHERE id=1').get().paused,1)
    assert.equal(inspect2.prepare('SELECT latched FROM remote_identity_panic WHERE id=1').get().latched,1)
    assert.equal(inspect2.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,2)
  } finally {inspect2.close()}
  assert.equal(state.openRevocationLedger().load().id,2)
  await hub.stop();hub=null;state.close()
  const reopened=openCloudStateStore(join(dir,'state'));try {assert.equal(reopened.openRevocationLedger().load().id,2)}finally{reopened.close()}
 } finally {if(hub)await hub.stop();revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
