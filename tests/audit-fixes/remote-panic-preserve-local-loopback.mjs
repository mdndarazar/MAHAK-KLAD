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
test('panic clears owned remote scopes but preserves local panel sessions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-supervisor-revoke-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub')
 const {mkdirSync}=await import('node:fs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const stateValue={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
 const state=openCloudStateStore(join(dir,'state'));state.save(stateValue);state.initializeRevocationLedger()
 const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]}
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'shop-isolated.db')
 const session=await import('../../src/main/services/panelSession.ts')
 const {prisma}=await import('../../src/main/db/client.ts')
 initRemoteGrantRegistry({notePanelUnlocked:(panel,scope,owner)=>session.noteRemotePanelUnlocked(panel,owner),clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}})
  const send=(path,body,cookie)=>new Promise((resolve,reject)=>{
   const data=Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':data.length,...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
  })
  const login=await send('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const grant=(panel,windowId)=>{
    const p=requestCode(panel,windowId)
    assert.ok(createGrant({panel,ownerWindowId:windowId,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}))
    assert.equal(consumeOneShot(windowId,panel,p.gt.slice(3)),true)
    assert.equal(isGrantActiveForWindow(panel,windowId),true)
  }
  grant('shifts',42);assert.equal(session.isPanelUnlocked('shifts',42),true)
  grant('settings',43);session.notePanelUnlocked('settings','PANEL',43)
  grant('settings',44);session.clearPanelSessions(44);session.notePanelUnlocked('settings','PANEL',44)
  session.notePanelUnlocked('settings','PANEL',45);grant('settings',45)
  session.applyPanelSessionTtlMs(10);session.notePanelUnlocked('settings','PANEL',47)
  await new Promise(resolve=>setTimeout(resolve,30));session.applyPanelSessionTtlMs(300000)
  grant('settings',47);assert.equal(session.isPanelUnlocked('settings',47),true)
  const pending=requestCode('settings',46)
  const result=await send('/api/panic',{pin:'746392'},login.cookie)
  assert.equal(result.status,200,JSON.stringify(result))
  for(const [panel,windowId] of [['shifts',42],['settings',43],['settings',44],['settings',45]])assert.equal(isGrantActiveForWindow(panel,windowId),false)
  assert.equal(session.isPanelUnlocked('shifts',42),false)
  assert.equal(session.isPanelUnlocked('settings',47),false)
  for(const owner of [43,44,45])assert.equal(session.isPanelUnlocked('settings',owner),true)
  assert.equal(getRequestStatus(46,'settings',pending.requestId),'UNAVAILABLE')
  assert.equal(state.openRevocationLedger().load().id,1)
  await hub.stop();hub=null;state.close()
  const reopened=openCloudStateStore(join(dir,'state'));try {assert.equal(reopened.openRevocationLedger().load().id,1)}finally{reopened.close()}
 } finally {if(hub)await hub.stop();revokeAll();for(const owner of [42,43,44,45,47])session.clearPanelSessions(owner);state.close();await prisma.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
