import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,createGrant,consumeOneShot,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real AuthService manager gate against harness SQLite, child HTTP and durable
// state. Local window/IPC, production Prisma, Windows, phone and tunnel untested.
test('P2 recovery requires the real local password gate, owner PIN and acknowledged revocations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-recovery-')),hubDir=join(dir,'hub'),childFile=join(dir,'hub.cjs')
 mkdirSync(hubDir);process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'shop-isolated.db')
 const {assertManagerPassword}=await import('../../src/main/services/AuthService.ts')
 const {prisma}=await import('../../src/main/db/client.ts')
 const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger()
 let cleanupFails=true,staleLedger=false
 const ledger=state.openRevocationLedger()
 const observedLedger={load:()=>staleLedger?null:ledger.load(),hasNonce:n=>ledger.hasNonce(n),save:(entry,nonce)=>ledger.save(entry,nonce)}
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{if(cleanupFails)throw new Error('injected cleanup failure')},clearPanelSessions:()=>{}})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2),ledger:observedLedger},verifyLocalRecoveryPassword:password=>assertManagerPassword(password,'بازیابی توقف اضطراری')})
  const send=(path,body,cookie)=>new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':data.length,...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}));assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true)
  assert.equal((await send('/api/panic',{pin:'746392'},login.cookie)).status,503)
  assert.equal((await send('/api/recoverPanic',{pin:'746392'},login.cookie)).status,404)
  assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD,'746392'),false)
  assert.equal((await send('/api/login',{username:'owner',password:'owner-test-password'})).status,401)
  cleanupFails=false
  const deadline=Date.now()+6000
  while(state.openRevocationLedger().load()?.id!==1&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50))
  assert.equal(state.openRevocationLedger().load().id,1)
  staleLedger=true;assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD,'746392'),false);staleLedger=false
  assert.equal(await hub.recoverPanic('wrong-manager-password','746392'),false)
  assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD,'000000'),false)
  assert.equal((await send('/api/login',{username:'owner',password:'owner-test-password'})).status,401)
  assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD,'746392'),true)
  assert.equal((await send('/api/login',{username:'owner',password:'owner-test-password'})).status,200)
  assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD,'746392'),false)
 } finally {cleanupFails=false;if(hub)await hub.stop();revokeAll();state.close();await prisma.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
