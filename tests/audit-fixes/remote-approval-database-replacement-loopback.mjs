import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,consumeOneShot,getRequestStatus,isGrantActiveForWindow,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

test('database file replacement during mobile approval closes desktop admission and cancels the request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-approval-restore-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const databaseFile=join(dir,'shop.db'), replacement=join(dir,'replacement.db')
 for (const p of [databaseFile,replacement]) {const db=new DatabaseSync(p);db.exec('CREATE TABLE test_value (value TEXT)');db.close()}
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 let marker=null, hold=false, reached, release
 const entered=new Promise(r=>{reached=r}), gate=new Promise(r=>{release=r})
 const readRestoreMarker=async()=>{if(hold){reached();await gate}return marker}
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker,databaseFile,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{
   const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)
  })
  const owner=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(owner.status,200)
  // A normal SQLite write changes the contents, but not the file identity.
  const liveDb=new DatabaseSync(databaseFile);liveDb.exec("INSERT INTO test_value VALUES ('ordinary-write')");liveDb.close()
  const prior=requestCode('shifts',41);let priorSeen=false
  for(let i=0;i<30 && !priorSeen;i++){const r=await send('GET','/api/requests',undefined,owner.cookie);priorSeen=r.body.requests?.some(x=>x.requestId===prior.requestId);if(!priorSeen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(priorSeen)
  assert.equal((await send('POST','/api/approve',{requestId:prior.requestId,code:prior.code,pin:'746392'},owner.cookie)).status,200)
  assert.equal(consumeOneShot(41,'shifts',prior.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',41),true)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30 && !seen;i++){const r=await send('GET','/api/requests',undefined,owner.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen)
  hold=true
  const approval=send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},owner.cookie).catch(()=>null)
  await entered;renameSync(databaseFile,join(dir,'old.db'));renameSync(replacement,databaseFile);release()
  await approval
  assert.equal(isGrantActiveForWindow('shifts',41),false)
  assert.equal(getRequestStatus(42,'shifts',p.requestId),'UNAVAILABLE')
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),false)
  assert.throws(()=>requestCode('shifts',43),/admission closed/)
 } finally {release();if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
