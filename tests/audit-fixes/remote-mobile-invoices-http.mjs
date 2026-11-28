import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

// Isolated SQLite and loopback HTTP only: no Electron, TLS proxy or phones.
const dir=mkdtempSync(join(tmpdir(),'mahak-mobile-invoices-')),shop=createClient(join(dir,'shop.db')),seed=makeSeeder(shop)
const customer=seed.customer('نام تست','09120000000')
seed.insert('SaleInvoice',{receiptNo:123,customerId:customer,issuedAtJalali:'1405/01/02',grandTotal:9007199254740993n,note:'SECRET_NOTE'})
const hubDb=new DatabaseSync(join(dir,'hub.db')),identity=createHubIdentity(hubDb,{panels:['invoices'],approvalPanels:[]})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const ownerToken=identity.login('owner','owner-test-password').token
const invite=identity.createInvite(ownerToken,'746392','VIEWER',[{panel:'invoices',view:true,approve:false}]).invite
assert.equal(identity.acceptInvite(invite,'viewer','viewer-test-password','482931'),true)
assert.equal(identity.approveMember(ownerToken,'746392','viewer'),true)
const base=createCloudReader(shop),origin='https://shop.example',payload={fromDay:'1405/01/01',toDay:'1405/01/03',afterId:0}
let calls=0,gate=null,startGate=null
const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],invoiceFactsPage:async(...args)=>{
 calls++;if(startGate)startGate();if(gate)await gate
 const rows=await base.invoiceFactsPage(...args);return rows.map(row=>({...row,unexpected:'SECRET_EXTRA'}))
}}
let hub=await startMobileReadOnlyHub({origin,identity,reader})
function send(path,{method='GET',body,headers={}}={}) {
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:hub.port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}))
 });req.on('error',reject);req.end(data??undefined)})
}
const post=(path,body,headers={})=>send(path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
async function login(username,password){const r=await post('/api/login',{username,password});assert.equal(r.status,200);return r.headers['set-cookie'][0].split(';')[0]}
try {
 let viewerCookie,ownerCookie
 await test('authentication, CSRF and input bounds enforced before a reader call',async()=>{
  assert.equal((await post('/api/invoices',payload)).status,401)
  viewerCookie=await login('viewer','viewer-test-password');ownerCookie=await login('owner','owner-test-password')
  assert.equal((await post('/api/invoices',payload,{cookie:ownerCookie,origin:'https://evil.example'})).status,403)
  assert.equal((await post('/api/invoices',{...payload,afterId:'1 OR 1=1'},{cookie:ownerCookie})).status,400)
  assert.equal((await post('/api/invoices',{...payload,extra:true},{cookie:ownerCookie})).status,400)
  assert.equal(calls,0)
 })
 await test('only one bounded read may run, and revoking ACL during read prevents disclosure',async()=>{
  let unblock,started;gate=new Promise(r=>{unblock=r});const ready=new Promise(r=>{started=r});startGate=started
  const reading=post('/api/invoices',payload,{cookie:viewerCookie});await ready
  assert.equal((await post('/api/invoices',payload,{cookie:ownerCookie})).status,429)
  assert.equal(identity.setAcl(ownerToken,'746392','viewer',[]),true);unblock()
  const result=await reading;assert.equal(result.status,403);assert.ok(!result.body.includes('نام تست'))
  gate=null;startGate=null
  assert.equal((await post('/api/invoices',payload,{cookie:viewerCookie})).status,403)
  assert.equal(calls,1)
 })
 await test('new handler allows owner only a fixed page; private extra fields do not cross HTTP',async()=>{
  await hub.close();hub=await startMobileReadOnlyHub({origin,identity,reader})
  const before=shop.$harness.db.prepare('SELECT total_changes() n').get().n
  const result=await post('/api/invoices',payload,{cookie:ownerCookie});assert.equal(result.status,200)
  const parsed=JSON.parse(result.body);assert.equal(parsed.invoices.length,1);assert.equal(parsed.invoices[0].grandTotal,'9007199254740993')
  assert.equal(parsed.invoices[0].customerName,'نام تست');assert.equal(parsed.hasMore,false)
  assert.ok(!result.body.includes('SECRET_NOTE'));assert.ok(!result.body.includes('SECRET_EXTRA'))
  assert.equal(shop.$harness.db.prepare('SELECT total_changes() n').get().n,before)
  assert.equal((await post('/api/invoices',payload,{cookie:ownerCookie})).status,429)
 })
 await test('malformed provider data fails closed without exposing values',async()=>{
  await hub.close();hub=await startMobileReadOnlyHub({origin,identity,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],
   invoiceFactsPage:async()=>[{id:1,receiptNo:1,issuedAtJalali:'1405/01/02',voided:false,status:'ok',orderType:'INTERNAL',grandTotal:'1.5',paidTotal:'1',customerName:'PRIVATE',customerPhone:null,sellerName:null}]}})
  const r=await post('/api/invoices',payload,{cookie:ownerCookie});assert.equal(r.status,503);assert.ok(!r.body.includes('PRIVATE'))
 })
 await test('without explicit invoice provider, the API is absent',async()=>{
  await hub.close();hub=await startMobileReadOnlyHub({origin,identity,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[]}})
  assert.equal((await post('/api/invoices',payload,{cookie:ownerCookie})).status,404)
 })
} finally {await hub.close();hubDb.close();await shop.$disconnect()}
