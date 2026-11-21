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
test('panic keeps failed desktop cleanup unacknowledged and retries through child outbox',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-supervisor-revoke-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub')
 const {mkdirSync}=await import('node:fs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const stateValue={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
 const state=openCloudStateStore(join(dir,'state'));state.save(stateValue);state.initializeRevocationLedger()
 const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]}
 let cleared=0, failCleanup=true
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{cleared++;if(failCleanup)throw new Error("injected failure")},clearPanelSessions:()=>{}})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}})
  const send=(path,body,cookie)=>new Promise((resolve,reject)=>{
   const data=Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':data.length,...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
  })
  const login=await send('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}))
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',42),true)
  const pending=requestCode('settings',43)
  const result=await send('/api/panic',{pin:'746392'},login.cookie)
  assert.equal(result.status,503,JSON.stringify(result));assert.equal(isGrantActiveForWindow('shifts',42),false)
  assert.equal(getRequestStatus(43,'settings',pending.requestId),'UNAVAILABLE')
  assert.match(result.cookie,/mahak_session=/)
  assert.notEqual((await send('/api/login',{username:'owner',password:'owner-test-password'})).status,200)
  const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
  inspect.exec('PRAGMA busy_timeout=5000')
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,1)
    assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,0)
    assert.equal(state.openRevocationLedger().load(),null)
    failCleanup=false
    const deadline=Date.now()+6000
    while (inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n!==1 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50))
    assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,1)
    assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,0)
    assert.ok(cleared>=2)
  } finally {inspect.close()}
  assert.equal(state.openRevocationLedger().load().id,1)
  await hub.stop();hub=null;state.close()
  const reopened=openCloudStateStore(join(dir,'state'));try {assert.equal(reopened.openRevocationLedger().load().id,1)}finally{reopened.close()}
 } finally {failCleanup=false;if(hub)await hub.stop();revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
