import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, createGrant, consumeOneShot, isGrantActiveForWindow, getRequestStatus, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child HTTP, outbox, durable ledger and registry with temporary files.
// Grants are created directly, not through mobile approval; panel callbacks are
// injected. Electron, a real tunnel and a phone are outside this test.
test('failed member revocation blocks new desktop admissions even after outbox retry ACK', async () => {
  const dir=mkdtempSync(join(tmpdir(),'mahak-revocation-admission-')), childFile=join(dir,'child.cjs'), hubDir=join(dir,'hub')
  mkdirSync(hubDir)
  await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  const state=openCloudStateStore(join(dir,'state'))
  state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
  state.initializeRevocationLedger()
  let failNotice=true, notices=0, hub
  initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
  const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2),onRevocation:()=>{notices++;if(failNotice)throw new Error('notification unavailable')}}}
  try {
    hub=await startExperimentalHubSupervisor(options)
    const send=(path,body,cookie)=>new Promise((resolve,reject)=>{
      const data=Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':data.length,...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
    })
    const login=await send('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
    const invite=await send('/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'shifts',view:true,approve:false}]},login.cookie);assert.equal(invite.status,200)
    assert.equal((await send('/api/invite/accept',{invite:invite.body.invite,username:'manager',password:'manager-test-password',pin:'482931'})).status,200)
    assert.equal((await send('/api/member/approve',{username:'manager',pin:'746392'},login.cookie)).status,200)
    const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true});inspect.exec('PRAGMA busy_timeout=5000')
    try {
      const memberId=inspect.prepare("SELECT id FROM remote_members WHERE username='manager'").get().id
      const p=requestCode('shifts',42)
      assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId,requestId:p.requestId,ttlMs:60000}))
      assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true)
      const unrelated=requestCode('settings',43)
      assert.equal((await send('/api/member/remove',{username:'manager',pin:'746392'},login.cookie)).status,503)
      assert.equal(isGrantActiveForWindow('shifts',42),false)
      assert.equal(getRequestStatus(43,'settings',unrelated.requestId),'UNAVAILABLE')
      assert.throws(()=>requestCode('shifts',44),/admission closed/)
      assert.equal(createGrant({panel:'settings',ownerWindowId:43,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:unrelated.requestId,ttlMs:60000}),null)
      assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,1)
      assert.equal(state.openRevocationLedger().load(),null)
      failNotice=false
      const deadline=Date.now()+8000
      while(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n!==1 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50))
      assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,1)
      assert.ok(notices>=2)
      assert.throws(()=>requestCode('shifts',44),/admission closed/)
      assert.equal(isGrantActiveForWindow('shifts',42),false)
    } finally {inspect.close()}
    await hub.stop();hub=null
    hub=await startExperimentalHubSupervisor({...options,owner:null})
    assert.ok(requestCode('shifts',44).requestId)
    await hub.stop();hub=null
  } finally {failNotice=false;if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
