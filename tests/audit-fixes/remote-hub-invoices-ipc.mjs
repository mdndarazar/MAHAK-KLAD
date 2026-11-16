import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { remoteImplementationReady } from '../../src/shared/remoteAuthChannels.ts'

// Genuine parent + separate child + loopback HTTP + temporary SQLite only.
// This is not Electron, actual restore coordination, HTTPS or a phone.
const dir=mkdtempSync(join(tmpdir(),'mahak-hub-invoice-ipc-')),childFile=join(dir,'child.cjs')
await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
const shop=createClient(join(dir,'isolated-shop.db')),seed=makeSeeder(shop),customer=seed.customer('مشتری نمونه','09120000000')
seed.insert('SaleInvoice',{receiptNo:123,customerId:customer,issuedAtJalali:'1405/01/02',grandTotal:9007199254740993n,note:'SECRET-NOTE'})
const real=createCloudReader(shop),origin='https://shop.example',payload={fromDay:'1405/01/01',toDay:'1405/01/03',afterId:0}
const stateValue={version:1,storeId:'test_store',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
let marker=null,block=null,notifyStart=null,calls=0
const reader={latestBoundaryTotals:()=>real.latestBoundaryTotals(),openShiftsPage:(...a)=>real.openShiftsPage(...a),auditPage:(...a)=>real.auditPage(...a),
 invoiceFactsPage:async(...a)=>{calls++;if(notifyStart)notifyStart();if(block)await block;return (await real.invoiceFactsPage(...a)).map(r=>({...r,unexpected:'SECRET-EXTRA'}))}}
const base={nodeExecutable:process.execPath,childFile,origin,owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,77),
 snapshotMaxAgeMs:5000,reader,enableInvoiceFacts:true,state:{load:()=>({...stateValue}),save:()=>{}},readRestoreMarker:async()=>marker,timeoutMs:5000}
async function start(options={}) {return startExperimentalHubSupervisor({...base,...options,directory:mkdtempSync(join(tmpdir(),'mahak-hub-invoice-db-'))})}
function send(port,path,{method='GET',body,headers={}}={}){
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:{host:'shop.example',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
 });req.on('error',reject);req.end(data??undefined)})
}
const post=(port,path,body,headers={})=>send(port,path,{method:'POST',body,headers:{origin,'x-mahak-request':'1',...headers}})
async function login(port){const r=await post(port,'/api/login',{username:'owner',password:'owner-test-password'});assert.equal(r.status,200);return r.headers['set-cookie'][0].split(';')[0]}
try {
 await test('invalid or incomplete explicit opt-in is rejected',async()=>{
  await assert.rejects(start({enableInvoiceFacts:'true'}),/Invalid/)
  await assert.rejects(start({reader:{latestBoundaryTotals:reader.latestBoundaryTotals,openShiftsPage:reader.openShiftsPage,auditPage:reader.auditPage}}),/Invalid/)
 })
 await test('optional process bridge reads bounded facts without writing source or exposing private fields',async()=>{
  assert.equal(remoteImplementationReady(),false)
  const supervisor=await start();try{
   const port=supervisor.mobilePort
   assert.equal((await post(port,'/api/invoices',payload)).status,401);assert.equal(calls,0)
   const cookie=await login(port),before=shop.$harness.db.prepare('SELECT total_changes() n').get().n
   const response=await post(port,'/api/invoices',payload,{cookie});assert.equal(response.status,200)
   const parsed=JSON.parse(response.body);assert.equal(parsed.invoices.length,1);assert.equal(parsed.invoices[0].grandTotal,'9007199254740993')
   assert.equal(parsed.invoices[0].customerName,'مشتری نمونه');assert.ok(!response.body.includes('SECRET-'))
   assert.equal(calls,1);assert.equal(shop.$harness.db.prepare('SELECT total_changes() n').get().n,before)
   assert.equal((await post(port,'/api/invoices',payload,{cookie})).status,429)
  }finally{await supervisor.stop()}
 })
 await test('logout during the parent read prevents disclosure across child HTTP',async()=>{
  let release,started;block=new Promise(r=>{release=r});const ready=new Promise(r=>{started=r});notifyStart=started
  const supervisor=await start();try{
   const port=supervisor.mobilePort,cookie=await login(port),pending=post(port,'/api/invoices',payload,{cookie})
   await ready;assert.equal((await post(port,'/api/logout',undefined,{cookie})).status,200);release()
   const response=await pending;assert.equal(response.status,403);assert.ok(!response.body.includes('مشتری نمونه'))
  }finally{release();block=null;notifyStart=null;await supervisor.stop()}
 })
 await test('changed restore marker fails closed after an in-flight read',async()=>{
  let release,started;block=new Promise(r=>{release=r});const ready=new Promise(r=>{started=r});notifyStart=started
  const supervisor=await start();try{
   const port=supervisor.mobilePort,cookie=await login(port),pending=post(port,'/api/invoices',payload,{cookie})
   await ready;marker='a'.repeat(64);release()
   const response=await pending;assert.equal(response.status,503);assert.ok(!response.body.includes('مشتری نمونه'))
  }finally{release();marker=null;block=null;notifyStart=null;await supervisor.stop()}
 })
 await test('changed store epoch fails closed after an in-flight read',async()=>{
  let release,started;block=new Promise(r=>{release=r});const ready=new Promise(r=>{started=r});notifyStart=started
  const supervisor=await start();try{
   const port=supervisor.mobilePort,cookie=await login(port),pending=post(port,'/api/invoices',payload,{cookie})
   await ready;stateValue.epoch='abcdefab-cdef-4abc-8abc-abcdefabcdef';release()
   const response=await pending;assert.equal(response.status,503);assert.ok(!response.body.includes('مشتری نمونه'))
  }finally{release();stateValue.epoch='12345678-1234-4123-8123-123456789abc';block=null;notifyStart=null;await supervisor.stop()}
 })
 await test('mutating a shared state object during an invoice read fails closed',async()=>{
  let release,started;block=new Promise(r=>{release=r});const ready=new Promise(r=>{started=r});notifyStart=started
  const mutable={...stateValue},supervisor=await start({state:{load:()=>mutable,save:()=>{}}})
  try{
   const port=supervisor.mobilePort,cookie=await login(port),pending=post(port,'/api/invoices',payload,{cookie})
   await ready;mutable.epoch='abcdefab-cdef-4abc-8abc-abcdefabcdef';release()
   const response=await pending;assert.equal(response.status,503);assert.ok(!response.body.includes('مشتری نمونه'))
  }finally{release();block=null;notifyStart=null;await supervisor.stop()}
 })
 await test('stuck parent read times out in the child and a late result is not delivered',async()=>{
  let release,started;block=new Promise(r=>{release=r});const ready=new Promise(r=>{started=r});notifyStart=started
  const supervisor=await start();try{
   const port=supervisor.mobilePort,cookie=await login(port),pending=post(port,'/api/invoices',payload,{cookie})
   await ready;const response=await pending;assert.equal(response.status,503);assert.ok(!response.body.includes('مشتری نمونه'));release()
   await new Promise(r=>setImmediate(r))
  }finally{release();block=null;notifyStart=null;await supervisor.stop()}
 })
 await test('without an explicit provider, child keeps invoice endpoint disabled',async()=>{
  const supervisor=await start({enableInvoiceFacts:false})
  try{const cookie=await login(supervisor.mobilePort);assert.equal((await post(supervisor.mobilePort,'/api/invoices',payload,{cookie})).status,404)}finally{await supervisor.stop()}
 })
} finally {await shop.$disconnect()}
