import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fork } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'

// Real child, HTTP and temporary files. No Electron, real shop DB, Windows or phone.
test('supervisor uses child clock before source reads and rejects slow refresh',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-child-clock-')),hubDir=join(dir,'hub'),childFile=join(dir,'hub.cjs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 let slow=false,hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:300,reader:{latestBoundaryTotals:async()=>{if(slow)await delay(500);return null},openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const original=Date.now
  try {Date.now=()=>original()+60_000;await hub.refreshOnce()} finally {Date.now=original}
  assert.equal((await send('GET','/api/shifts',undefined,login.cookie)).status,200)
  slow=true;await assert.rejects(hub.refreshOnce(),/snapshot-expired/)
  assert.equal((await send('GET','/api/shifts',undefined,login.cookie)).status,503)
 } finally {if(hub)await hub.stop();state.close();rmSync(dir,{recursive:true,force:true})}
})

test('child capture is one-shot, rejects reuse and expires before publication',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-capture-ipc-')),hubDir=join(dir,'hub'),childFile=join(dir,'hub.cjs');mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const child=fork(childFile,[],{stdio:['ignore','ignore','ignore','ipc']}),queue=[],waiters=[]
 child.on('message',m=>{const w=waiters.shift();if(w){clearTimeout(w.timer);w.resolve(m)}else queue.push(m)})
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const w={resolve,reject,timer:setTimeout(()=>reject(new Error('child timed out')),5000)};waiters.push(w)})
 const send=async m=>{child.send(m);return next()},value={boundary:null,shifts:[]}
 try {
  assert.equal((await send({type:'start',config:{directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1).toString('hex'),snapshotMaxAgeMs:200}})).type,'ready')
  assert.equal((await send({type:'beginSnapshot',id:1,captureId:1})).ok,true)
  assert.equal((await send({type:'snapshot',id:2,captureId:1,value})).ok,true)
  assert.equal((await send({type:'snapshot',id:3,captureId:1,value})).reason,'invalid-capture')
  assert.equal((await send({type:'beginSnapshot',id:4,captureId:1})).reason,'invalid-capture')
  assert.equal((await send({type:'beginSnapshot',id:5,captureId:2})).ok,true)
  await delay(350)
  assert.equal((await send({type:'snapshot',id:6,captureId:2,value})).reason,'snapshot-expired')
  assert.equal((await send({type:'beginSnapshot',id:7,captureId:3})).ok,true)
  assert.equal((await send({type:'invalidateSnapshot',id:8})).ok,true)
  assert.equal((await send({type:'snapshot',id:9,captureId:3,value})).reason,'invalid-capture')
  assert.equal((await send({type:'stop'})).type,'stopped')
  await new Promise(resolve=>child.once('exit',resolve))
 } finally {if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve))}rmSync(dir,{recursive:true,force:true})}
})
