import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { acquireRemoteAdmissionLease, initRemoteGrantRegistry, requestCode, getRequestStatus, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real HTTP and child; state, keys and injected failing replay store are isolated.
// This is not Electron, production keys, a phone, or a tunnel.
test('failed replay store closes approval bridge before another mobile command reaches it', async () => {
 const dir=mkdtempSync(join(tmpdir(),'mahak-approval-latch-')),childFile=join(dir,'child.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger()
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 let hub,calls=0
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}},replayStore:{consume:()=>{calls++;throw new Error('injected replay failure')}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const owner=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(owner.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,owner.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen)
  assert.notEqual((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},owner.cookie)).status,200)
  assert.equal(calls,1);assert.equal(getRequestStatus(42,'shifts',p.requestId),'UNAVAILABLE')
  const stale=await send('GET','/api/requests',undefined,owner.cookie)
  assert.ok(stale.body.requests?.some(x=>x.requestId===p.requestId),'child still has the stale request mirror')
  assert.notEqual((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},owner.cookie)).status,200)
  assert.equal(calls,1,'latched parent must not touch replay store for subsequent command')
  assert.throws(()=>requestCode('shifts',43),/admission closed/)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})

test('lease failure before startup opens is sticky and cannot reopen',()=>{
 const lease=acquireRemoteAdmissionLease()
 try {assert.equal(lease.isOpen(),false);lease.block();assert.throws(()=>lease.open(),/unavailable/);assert.equal(lease.isOpen(),false)} finally {lease.release()}
})
