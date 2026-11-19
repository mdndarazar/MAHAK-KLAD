import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,getRequestStatus,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child/HTTP and file replay ledger, isolated temp dir; no Electron, real
// data, network tunnel, phone, Windows or real protected key.
test('supervisor persists mobile approval replay after state store is reopened',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-supervisor-replay-')),childFile=join(dir,'hub.cjs'),hubDir=join(dir,'hub'),stateDir=join(dir,'state');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 let state=openCloudStateStore(stateDir),hub
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}}
 try {
  hub=await startExperimentalHubSupervisor(options)
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const owner=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(owner.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30 && !seen;i++){const r=await send('GET','/api/requests',undefined,owner.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},owner.cookie)).status,200)
  assert.equal(getRequestStatus(42,'shifts',p.requestId),'APPROVED')
  const value=JSON.parse(readFileSync(join(stateDir,'grant-replay-ledger.json'),'utf8'));assert.equal(value.entries.length,1);assert.equal(value.entries[0].requestId,p.requestId)
  await hub.stop();hub=null;state.close();state=openCloudStateStore(stateDir)
  const entry=value.entries[0], now=Math.max(value.latest,entry.expiresAt-1)
  assert.equal(state.openGrantReplayLedger().consume(entry.requestId,entry.nonce,entry.expiresAt,now),'REPLAY')
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();state.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
