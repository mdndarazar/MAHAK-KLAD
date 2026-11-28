import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

// Loopback-only isolated test, not a browser or HTTPS deployment.
const dir=mkdtempSync(join(tmpdir(),'mahak-invoice-cap-')),db=new DatabaseSync(join(dir,'hub.sqlite'))
const identity=createHubIdentity(db,{panels:['custody','shifts','invoices'],approvalPanels:[]})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const owner=identity.login('owner','owner-test-password').token
const invite=identity.createInvite(owner,'746392','VIEWER',[]).invite
assert.equal(identity.acceptInvite(invite,'viewer','viewer-test-password','482931'),true)
assert.equal(identity.approveMember(owner,'746392','viewer'),true)
const origin='https://shop.example',reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],invoiceFactsPage:async()=>[]}
let hub=await startMobileReadOnlyHub({origin,identity,reader})
function send(path,{method='GET',body,headers={}}={}){
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:hub.port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
 });req.on('error',reject);req.end(data??undefined)})
}
const post=(path,body,headers={})=>send(path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
async function login(username,password){const r=await post('/api/login',{username,password});assert.equal(r.status,200);return r.headers['set-cookie'][0].split(';')[0]}
const value=r=>JSON.parse(r.body)
try {
 let ownerCookie,viewerCookie
 await test('capabilities are private and current per session/ACL',async()=>{
  assert.equal((await send('/api/capabilities')).status,401)
  ownerCookie=await login('owner','owner-test-password');viewerCookie=await login('viewer','viewer-test-password')
  assert.deepEqual(value(await send('/api/capabilities',{headers:{cookie:ownerCookie}})),{invoices:true})
  assert.deepEqual(value(await send('/api/capabilities',{headers:{cookie:viewerCookie}})),{invoices:false})
  assert.equal(identity.setAcl(owner,'746392','viewer',[{panel:'invoices',view:true,approve:false}]),true)
  assert.deepEqual(value(await send('/api/capabilities',{headers:{cookie:viewerCookie}})),{invoices:true})
  assert.equal(identity.setAcl(owner,'746392','viewer',[]),true)
  assert.deepEqual(value(await send('/api/capabilities',{headers:{cookie:viewerCookie}})),{invoices:false})
 })
 await test('reader capability is false if no invoice provider is supplied',async()=>{
  await hub.close();hub=await startMobileReadOnlyHub({origin,identity,reader:{latestBoundaryTotals:reader.latestBoundaryTotals,openShiftsPage:reader.openShiftsPage}})
  assert.deepEqual(value(await send('/api/capabilities',{headers:{cookie:ownerCookie}})),{invoices:false})
 })
} finally {await hub.close();db.close()}
