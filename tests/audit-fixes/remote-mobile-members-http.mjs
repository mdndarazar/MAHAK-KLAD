import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'
import { drainInProcessRevocations } from '../../src/main/services/cloud/inProcessRevocationBridge.ts'
import { initRemoteGrantRegistry, requestCode, createGrant, consumeOneShot, isGrantActiveForWindow, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'
const dir=mkdtempSync(join(tmpdir(),'mahak-mobile-members-')),db=new DatabaseSync(join(dir,'hub.db')),origin='https://shop.example'
const identity=createHubIdentity(db,{panels:['custody','shifts'],approvalPanels:['shifts']})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[]}
const noBridge=await startMobileReadOnlyHub({origin,identity,reader})
const withBridge=await startMobileReadOnlyHub({origin,identity,reader,drainRevocations:()=>drainInProcessRevocations(identity)})
initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>assert.fail('must not clear all local sessions')})
function send(hub,path,{method='GET',body,headers={}}={}){
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:hub.port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
 });req.on('error',reject);req.end(data??undefined)})
}
const post=(hub,path,body,headers={})=>send(hub,path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
const data=r=>JSON.parse(r.body)
let ownerCookie,managerCookie,invite
try{
 await test('mobile assets expose membership UI without caching or HTML injection APIs',async()=>{
  const html=await send(noBridge,'/'),js=await send(noBridge,'/mobile.js')
  assert.match(html.body,/id="accept-form"/);assert.match(html.body,/id="invite-form"/)
  assert.doesNotThrow(()=>new Function(js.body));assert.ok(!js.body.includes('innerHTML'));assert.ok(!js.body.includes('localStorage'))
 })
 await test('owner can create invite; custody never admits approval permission',async()=>{
  const login=await post(noBridge,'/api/login',{username:'owner',password:'owner-test-password'});ownerCookie=login.headers['set-cookie'][0].split(';')[0]
  assert.equal((await send(noBridge,'/api/members',{headers:{cookie:ownerCookie}})).status,200)
  const unsafe=await post(noBridge,'/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'custody',view:true,approve:true}]},{cookie:ownerCookie})
  assert.equal(unsafe.status,400)
  const result=await post(noBridge,'/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'shifts',view:true,approve:true}]},{cookie:ownerCookie})
  assert.equal(result.status,200);invite=data(result).invite;assert.match(invite,/^[A-Za-z0-9_-]{43}$/);assert.equal(result.headers['cache-control'],'no-store')
 })
 await test('invite is single-use and cannot sign in until owner approves it',async()=>{
  assert.equal((await post(noBridge,'/api/invite/accept',{invite,username:'manager',password:'manager-test-password',pin:'482931'})).status,200)
  assert.equal((await post(noBridge,'/api/invite/accept',{invite,username:'second',password:'manager-test-password',pin:'482931'})).status,400)
  assert.equal((await post(noBridge,'/api/login',{username:'manager',password:'manager-test-password'})).status,401)
  const listed=data(await send(noBridge,'/api/members',{headers:{cookie:ownerCookie}})).members
  assert.equal(listed.find(m=>m.username==='manager').status,'PENDING_OWNER_APPROVAL');assert.ok(!JSON.stringify(listed).includes('password'))
  assert.equal((await post(noBridge,'/api/member/approve',{username:'manager',pin:'000000'},{cookie:ownerCookie})).status,403)
  assert.equal((await post(noBridge,'/api/member/approve',{username:'manager',pin:'746392'},{cookie:ownerCookie})).status,200)
  const login=await post(noBridge,'/api/login',{username:'manager',password:'manager-test-password'});assert.equal(login.status,200);managerCookie=login.headers['set-cookie'][0].split(';')[0]
 })
 await test('manager cannot enumerate or manage members and cross-origin writes fail',async()=>{
  assert.equal((await send(noBridge,'/api/members',{headers:{cookie:managerCookie}})).status,403)
  assert.equal((await post(noBridge,'/api/invite/create',{pin:'482931',role:'VIEWER',acl:[]},{cookie:managerCookie})).status,403)
  assert.equal((await post(noBridge,'/api/member/remove',{username:'manager',pin:'746392'},{cookie:ownerCookie,origin:'https://evil.example'})).status,403)
 })
 await test('removal cannot start without a trusted revocation bridge',async()=>{
  assert.equal((await post(noBridge,'/api/member/remove',{username:'manager',pin:'746392'},{cookie:ownerCookie})).status,503)
  assert.equal((await send(noBridge,'/api/session',{headers:{cookie:managerCookie}})).status,200)
 })
 await test('removal drains revocation before returning success and kills existing session and grant',async()=>{
  const token=managerCookie.slice('mahak_session='.length),memberId=identity.authorize(token,'shifts','VIEW').id
  const pending=requestCode('shifts',45)
  assert.ok(createGrant({panel:'shifts',ownerWindowId:45,tier:'NORMAL',mode:'PANEL',memberId,requestId:pending.requestId,ttlMs:60000}))
  assert.equal(consumeOneShot(45,'shifts',pending.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',45),true)
  assert.equal((await post(withBridge,'/api/member/remove',{username:'manager',pin:'746392'},{cookie:ownerCookie})).status,200)
  assert.equal(isGrantActiveForWindow('shifts',45),false);assert.equal(identity.pendingRevocations().length,0)
  assert.equal((await send(withBridge,'/api/session',{headers:{cookie:managerCookie}})).status,401)
 })
}finally{revokeAll();await noBridge.close();await withBridge.close();db.close()}
