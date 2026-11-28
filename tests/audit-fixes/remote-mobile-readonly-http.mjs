import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { createMobileReadOnlyHandler, startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

// Real loopback HTTP and isolated SQLite files only. HTTPS proxy and phone are not tested.
const dir=mkdtempSync(join(tmpdir(),'mahak-mobile-http-')),shop=createClient(join(dir,'shop-isolated.db')),seed=makeSeeder(shop)
seed.insert('CustodyAggregateBoundary',{boundaryKind:'HANDOVER',operationalDay:'1405-01-02',idempotencyKey:'b1',at:1700000000001,theoreticalExpectedTotal:9007199254740993n,observedOperationalTotal:9007199254740973n,totalTheoreticalDifference:-20n})
seed.insert('Shift',{name:'shift-alpha',number:1,dayJalali:'1405/01/02',openedAt:1700000000000,note:'PRIVATE-NOTE'})
const db=new DatabaseSync(join(dir,'hub-isolated.db')),identity=createHubIdentity(db,{panels:['custody','shifts'],approvalPanels:[]})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const ownerToken=identity.login('owner','owner-test-password').token
const invitation=identity.createInvite(ownerToken,'746392','VIEWER',[{panel:'custody',view:true,approve:false}]).invite
assert.equal(identity.acceptInvite(invitation,'viewer','viewer-test-password','217384'),true)
assert.equal(identity.approveMember(ownerToken,'746392','viewer'),true)
const baseReader=createCloudReader(shop);let custodyCalls=0,shiftCalls=0,block=null
const reader={latestBoundaryTotals:async()=>{custodyCalls++;if(block)await block.wait;return baseReader.latestBoundaryTotals()},openShiftsPage:async(...a)=>{shiftCalls++;return baseReader.openShiftsPage(...a)}}
const origin='https://shop.example',hub=await startMobileReadOnlyHub({origin,identity,reader})
function send(path,{method='GET',body,headers={}}={}){
 const data=body===undefined?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body))
 return new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:hub.port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}))
  });req.on('error',reject);req.end(data??undefined)
 })
}
const json=x=>JSON.parse(x.body.toString())
const post=(path,body,headers={})=>send(path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
let viewerCookie,ownerCookie
try {
 await test('requires exact HTTPS origin configuration and serves a restricted PWA over loopback',async()=>{
  for(const bad of ['http://shop.example','https://shop.example/path','https://u:p@shop.example','not a URL'])assert.throws(()=>createMobileReadOnlyHandler({origin:bad,identity,reader}))
  const html=await send('/');assert.equal(html.status,200);assert.match(html.body.toString(),/<!doctype html>/i)
  assert.match(html.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(html.headers['cache-control'],'no-store')
  assert.equal((await send('/',{headers:{host:'other.example'}})).status,421)
  const manifest=json(await send('/manifest.webmanifest'));assert.equal(manifest.start_url,'/');assert.equal(manifest.icons.length,2)
  for(const [path,width] of [['/icon-192.png',192],['/icon-512.png',512]]){const r=await send(path);assert.equal(r.status,200);assert.equal(r.body.readUInt32BE(16),width);assert.equal(r.body.readUInt32BE(20),width)}
  const sw=(await send('/mobile-sw.js')).body.toString();assert.ok(!sw.includes('caches.'));assert.ok(!sw.includes('/api/'))
 })
 await test('unauthenticated and cross-origin requests cannot read or sign in',async()=>{
  assert.equal((await send('/api/custody')).status,401);assert.equal(custodyCalls,0)
  assert.equal((await send('/api/login',{method:'POST',body:{username:'owner',password:'owner-test-password'}})).status,403)
  assert.equal((await post('/api/login',{username:'owner',password:'owner-test-password'},{origin:'https://evil.example'})).status,403)
  assert.equal((await post('/api/login',{username:'owner',password:'wrong-test-password'})).status,401)
  assert.equal((await post('/api/login',{username:'owner',password:'owner-test-password',extra:true})).status,400)
 })
 await test('cookies are secure and ACL blocks the reader before data access',async()=>{
  const login=await post('/api/login',{username:'viewer',password:'viewer-test-password'});assert.equal(login.status,200)
  const set=login.headers['set-cookie'][0];assert.match(set,/HttpOnly/);assert.match(set,/Secure/);assert.match(set,/SameSite=Strict/)
  viewerCookie=set.split(';')[0];assert.deepEqual(json(await send('/api/session',{headers:{cookie:viewerCookie}})),{user:{username:'viewer',role:'VIEWER'}})
  const denied=await send('/api/shifts',{headers:{cookie:viewerCookie}});assert.equal(denied.status,403);assert.equal(shiftCalls,0)
 })
 await test('historical amounts and shifts are read only with sensitive fields omitted',async()=>{
  const login=await post('/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200);ownerCookie=login.headers['set-cookie'][0].split(';')[0]
  const before=shop.$harness.db.prepare('SELECT total_changes() n').get().n
  const b=json(await send('/api/custody',{headers:{cookie:viewerCookie}})).boundary
  assert.equal(b.source,'HISTORICAL_BOUNDARY');assert.equal(b.theoreticalExpectedTotal,'9007199254740993');assert.equal(b.totalTheoreticalDifference,'-20')
  const response=await send('/api/shifts',{headers:{cookie:ownerCookie}});assert.equal(response.status,200)
  assert.equal(json(response).shifts[0].name,'shift-alpha');assert.ok(!response.body.toString().includes('PRIVATE-NOTE'))
  assert.equal(shop.$harness.db.prepare('SELECT total_changes() n').get().n,before)
 })
 await test('ACL is checked again after a slow read, preventing disclosure on concurrent revocation',async()=>{
  let unblock,started;const wait=new Promise(r=>{unblock=r}),ready=new Promise(r=>{started=r})
  const original=reader.latestBoundaryTotals;block={wait};reader.latestBoundaryTotals=async()=>{started();return original()}
  const reading=send('/api/custody',{headers:{cookie:viewerCookie}});await ready
  assert.equal(identity.setAcl(ownerToken,'746392','viewer',[]),true);unblock()
  const response=await reading;assert.equal(response.status,403);assert.ok(!response.body.toString().includes('9007199254740993'))
  reader.latestBoundaryTotals=original;block=null
 })
 await test('logout invalidates session; no mobile approval or admin endpoint exists',async()=>{
  assert.equal((await post('/api/logout',undefined,{cookie:ownerCookie,origin:'https://evil.example'})).status,403)
  assert.equal((await post('/api/logout',undefined,{cookie:ownerCookie})).status,200)
  assert.equal((await send('/api/session',{headers:{cookie:ownerCookie}})).status,401)
  assert.equal((await post('/api/approve',{pin:'123456'},{cookie:viewerCookie})).status,404)
 })
} finally {await hub.close();db.close();await shop.$disconnect()}
