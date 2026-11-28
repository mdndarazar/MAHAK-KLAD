import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { createInProcessMobileApprovals } from '../../src/main/services/cloud/inProcessMobileApprovals.ts'
import { drainInProcessRevocations } from '../../src/main/services/cloud/inProcessRevocationBridge.ts'
import { initRemoteGrantRegistry, requestCode, consumeOneShot, isGrantActiveForWindow, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real loopback HTTP, isolated hub DB and in-process simulated desktop registry.
// No Windows, phone, HTTPS proxy, desktop IPC or customer database is used.
const dir=mkdtempSync(join(tmpdir(),'mahak-mobile-approval-')),db=new DatabaseSync(join(dir,'hub.db'))
const identity=createHubIdentity(db,{panels:['custody','shifts','sales-return','credit-void'],approvalPanels:['sales-return','credit-void']})
const ownerPass='owner-test-password',ownerPin='746392',managerPass='manager-test-password',managerPin='482931'
assert.equal(identity.bootstrap('owner',ownerPass,ownerPin),true)
const ownerToken=identity.login('owner',ownerPass).token
for(const [name,role,acl] of [
 ['manager','MANAGER',[{panel:'sales-return',view:true,approve:true}]],
 ['viewer','VIEWER',[{panel:'sales-return',view:true,approve:false}]]
]){
 const invite=identity.createInvite(ownerToken,ownerPin,role,acl).invite
 assert.equal(identity.acceptInvite(invite,name,managerPass,managerPin),true)
 assert.equal(identity.approveMember(ownerToken,ownerPin,name),true)
}
let opened=[];initRemoteGrantRegistry({notePanelUnlocked:(panel,scope,owner)=>opened.push({panel,scope,owner}),clearPanelScope:()=>{},clearPanelSessions:()=>assert.fail('must not clear all sessions')})
const policies={'sales-return':{tier:'NORMAL',mode:'PANEL',ttlMs:600000},'credit-void':{tier:'SENSITIVE_MONEY',mode:'ONE_SHOT',ttlMs:300000}}
const approval=createInProcessMobileApprovals({identity,replayStore:createDurableGrantReplay(db,'store_1'),key:Buffer.alloc(32,7),storeId:'store_1',policies})
const origin='https://shop.example',hub=await startMobileReadOnlyHub({origin,identity,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[]},approval,drainRevocations:()=>drainInProcessRevocations(identity)})
function send(path,{method='GET',body,headers={}}={}){
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:hub.port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
 });req.on('error',reject);req.end(data??undefined)})
}
const post=(path,body,headers={})=>send(path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
const data=r=>JSON.parse(r.body)
const login=async(username,password)=>{const r=await post('/api/login',{username,password});assert.equal(r.status,200);return r.headers['set-cookie'][0].split(';')[0]}
let managerCookie,viewerCookie,ownerCookie,pending
try{
 await test('request listing respects role and panel ACL and never reveals local credential',async()=>{
  managerCookie=await login('manager',managerPass);viewerCookie=await login('viewer',managerPass);ownerCookie=await login('owner',ownerPass)
  pending=requestCode('sales-return',101);requestCode('credit-void',102);requestCode('custody',103)
  const r=await send('/api/requests',{headers:{cookie:managerCookie}});assert.equal(r.status,200)
  assert.deepEqual(data(r).requests,[{requestId:pending.requestId,panel:'sales-return',code:pending.code}])
  assert.ok(!r.body.includes(pending.gt));assert.ok(!r.body.includes('ownerWindowId'))
  assert.deepEqual(data(await send('/api/requests',{headers:{cookie:viewerCookie}})).requests,[])
  assert.equal(data(await send('/api/requests',{headers:{cookie:ownerCookie}})).requests.length,2)
 })
 await test('cross-origin, viewer, wrong code and PIN are rejected',async()=>{
  const right={requestId:pending.requestId,code:pending.code,pin:managerPin}
  assert.equal((await post('/api/approve',right,{cookie:managerCookie,origin:'https://evil.example'})).status,403)
  assert.equal((await post('/api/approve',right,{cookie:viewerCookie})).status,403)
  assert.equal((await post('/api/approve',{...right,code:pending.code==='111111'?'222222':'111111'},{cookie:managerCookie})).status,403)
  assert.equal((await post('/api/approve',{...right,pin:'000000'},{cookie:managerCookie})).status,403)
  assert.equal(isGrantActiveForWindow('sales-return',101),false);assert.deepEqual(opened,[])
 })
 await test('mobile approval plus correct credential opens only the intended in-process panel',async()=>{
  const right={requestId:pending.requestId,code:pending.code,pin:managerPin}
  const competing=await Promise.all([post('/api/approve',right,{cookie:managerCookie}),post('/api/approve',right,{cookie:managerCookie})])
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,403])
  assert.deepEqual(data(await send('/api/requests',{headers:{cookie:managerCookie}})).requests,[])
  assert.equal((await post('/api/approve',right,{cookie:managerCookie})).status,403)
  assert.equal(consumeOneShot(102,'sales-return',pending.gt.slice(3)),false)
  assert.equal(consumeOneShot(101,'sales-return',pending.gt.slice(3)),true)
  assert.equal(isGrantActiveForWindow('sales-return',101),true)
  assert.deepEqual(opened,[{panel:'sales-return',scope:'PANEL',owner:101}])
 })
 await test('sensitive approval from owner is one-shot and never opens a reusable scope',async()=>{
  const list=data(await send('/api/requests',{headers:{cookie:ownerCookie}})).requests
  const item=list.find(x=>x.panel==='credit-void');assert.ok(item)
  // A replacement makes the old visible request invalid; obtain the new token.
  const p=requestCode('credit-void',102)
  assert.equal((await post('/api/approve',{requestId:item.requestId,code:item.code,pin:ownerPin},{cookie:ownerCookie})).status,403)
  assert.equal((await post('/api/approve',{requestId:p.requestId,code:p.code,pin:ownerPin},{cookie:ownerCookie})).status,200)
  assert.equal(consumeOneShot(102,'credit-void',p.gt.slice(3)),true)
  assert.equal(consumeOneShot(102,'credit-void',p.gt.slice(3)),false)
  assert.equal(isGrantActiveForWindow('credit-void',102),false)
 })
 await test('deleted or paused member cannot authorize new requests; pending revoke fails closed',async()=>{
  assert.equal(identity.setPaused(ownerToken,ownerPin,true),true)
  const p=requestCode('sales-return',101)
  assert.deepEqual(data(await send('/api/requests',{headers:{cookie:managerCookie}})).requests,[])
  assert.equal((await post('/api/approve',{requestId:p.requestId,code:p.code,pin:managerPin},{cookie:managerCookie})).status,403)
  assert.equal(identity.setPaused(ownerToken,ownerPin,false),true)
  assert.deepEqual(data(await send('/api/requests',{headers:{cookie:managerCookie}})).requests,[])
  drainInProcessRevocations(identity);assert.equal(isGrantActiveForWindow('sales-return',101),false)
 })
 await test('custody approval cannot be configured and mobile assets expose no PIN or tokens in storage',async()=>{
  assert.throws(()=>createInProcessMobileApprovals({identity,replayStore:createDurableGrantReplay(db,'other'),key:Buffer.alloc(32,7),storeId:'other',policies:{custody:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}),/Custody/)
  const js=(await send('/mobile.js')).body;assert.ok(!js.includes('localStorage'));assert.ok(!js.includes('innerHTML'));assert.doesNotThrow(()=>new Function(js))
 })
}finally{revokeAll();await hub.close();db.close()}
