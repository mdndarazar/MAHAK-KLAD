import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'

// Temporary SQLite, generated from repository migrations. These are raw stored
// rows, NOT equivalent to the desktop's financial report or a mobile endpoint.
const dir=mkdtempSync(join(tmpdir(),'mahak-invoice-facts-'))
const db=createClient(join(dir,'isolated.db')),seed=makeSeeder(db),sql=db.$harness.db
const reader=createCloudReader(db),changes=()=>sql.prepare('SELECT total_changes() AS n').get().n
try {
 await test('empty date range stays empty and never writes to the shop',async()=>{
  const before=changes()
  assert.deepEqual(await reader.invoiceFactsPage('1405/01/01','1405/01/01',0),[])
  assert.equal(changes(),before)
 })
 await test('paged fixed SELECT returns raw facts including draft, void and exchange without recomputation',async()=>{
  const customer=seed.customer('نام نمونه','09120000000'),seller=seed.user('فروشنده نمونه')
  for(let n=1;n<=203;n++) seed.insert('SaleInvoice',{
   receiptNo:n,issuedAtJalali:'1405/01/02',status:n===1?'DRAFT':'SETTLED',orderType:n===2?'EXCHANGE':'INTERNAL',
   customerId:n===1?customer:null,userId:n===1?seller:null,voidedAt:n===2?1700000000000:null,
   grandTotal:n===1?9007199254740993n:100n,paidTotal:n===1?9007199254740900n:30n,
   note:'SECRET-NOTE',debtorNationalId:'SECRET-ID',returnCode:'SECRET-CODE'
  })
  seed.insert('SaleInvoice',{receiptNo:204,issuedAtJalali:'1405/01/03'})
  const before=changes(),first=await reader.invoiceFactsPage('1405/01/02','1405/01/02',0),second=await reader.invoiceFactsPage('1405/01/02','1405/01/02',first.at(-1).id)
  assert.equal(changes(),before);assert.equal(first.length,200);assert.equal(second.length,3)
  assert.equal(first[0].grandTotal,'9007199254740993');assert.equal(first[0].paidTotal,'9007199254740900')
  assert.equal(first[0].status,'DRAFT');assert.equal(first[1].orderType,'EXCHANGE');assert.equal(first[1].voided,true)
  assert.equal(first[0].customerName,'نام نمونه');assert.equal(first[0].customerPhone,'09120000000');assert.equal(first[0].sellerName,'فروشنده نمونه')
  assert.equal(first[1].customerName,null);assert.equal(first[1].customerPhone,null);assert.equal(first[1].sellerName,null)
  assert.ok(!JSON.stringify([first,second]).includes('SECRET-'))
  assert.deepEqual(Object.keys(first[0]).sort(),['id','receiptNo','issuedAtJalali','status','orderType','voided','grandTotal','paidTotal','customerName','customerPhone','sellerName'].sort())
 })
 await test('current customer profiles can change between reads; this is not a historical snapshot',async()=>{
  sql.prepare('UPDATE "Customer" SET "name"=?').run('نام تغییر یافته')
  assert.equal((await reader.invoiceFactsPage('1405/01/02','1405/01/02',0,1))[0].customerName,'نام تغییر یافته')
 })
 await test('invalid input is rejected before any query',async()=>{
  let calls=0;const r=createCloudReader({$queryRawUnsafe:async()=>{calls++;return []}})
  const bad=[['1405/01/02','1405/01/01',0,1],['1405/13/01','1405/12/01',0,1],['x','1405/01/01',0,1],
   ['1405/01/01','1405/01/01',-1,1],['1405/01/01','1405/01/01','1 OR 1=1',1],['1405/01/01','1405/01/01',0,201],
   ['1405/01/01','1405/01/01',Number.MAX_SAFE_INTEGER+1,1]]
  for(const args of bad)await assert.rejects(r.invoiceFactsPage(...args))
  assert.equal(calls,0)
 })
 await test('fixed parameterized SELECT and invalid database output fail closed',async()=>{
  const queries=[],r=createCloudReader({$queryRawUnsafe:async(q,...v)=>{queries.push([q,v]);return db.$queryRawUnsafe(q,...v)}})
  const before=changes();await r.invoiceFactsPage('1405/01/02','1405/01/03',4,7);assert.equal(changes(),before)
  assert.equal(queries.length,1);assert.match(queries[0][0],/^SELECT\b/);assert.ok(!queries[0][0].includes(';'))
  assert.deepEqual(queries[0][1],['1405/01/02','1405/01/03',4,7])
  const valid={id:'1',receiptNo:'1',issuedAtJalali:'1405/01/02',status:'SETTLED',orderType:'INTERNAL',voided:'0',grandTotal:'1',paidTotal:'1',customerName:null,customerPhone:null,sellerName:null}
  for(const response of [[{...valid,voided:'false'}],[{...valid,grandTotal:'1.5'}],[{...valid,customerPhone:'x'.repeat(513)}],[valid,valid],[{...valid,issuedAtJalali:'1405/01/03'}]]) {
   await assert.rejects(createCloudReader({$queryRawUnsafe:async()=>response}).invoiceFactsPage('1405/01/02','1405/01/02',0))
  }
 })
 await test('invoice reads share the reader single-flight lock',async()=>{
  let finish;const r=createCloudReader({$queryRawUnsafe:()=>new Promise(resolve=>{finish=resolve})})
  const first=r.invoiceFactsPage('1405/01/01','1405/01/02',0)
  await assert.rejects(r.auditPage(0),/busy/)
  await new Promise(resolve=>setImmediate(resolve));finish([]);assert.deepEqual(await first,[])
 })
} finally {await db.$disconnect()}
