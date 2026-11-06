import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-b-first-a-second-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('B-first-A-second operation audit')
const cashMethod=seed.insert('PaymentMethod',{key:'BFAS-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const n=x=>Number(x??0),line=(id,price)=>({variantId:id,qty:1,unitPrice:price,discount:0,tax:0})
let seq=0
function variant(cat,label,price){const p=seed.product(`BFAS-${++seq}-${label}`,cat),id=seed.variant(p,`BFAS-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,label,price}}
function rawCredit(id){return seed.one('SELECT id,code,amount,usedAmount,status,expiresAt,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE id=?',id)}
async function issue(cat,note){const r=await storeCreditService.issueManual({amount:50_000,multiUse:false,maxUses:1,carryRemainder:true,days:30,restrictScope:'CATEGORY',restrictCategoryIds:[cat],userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note});return{...r,code:rawCredit(r.id).code}}
function creditsByReturn(id){return seed.rows('SELECT id,code,amount,expiresAt,status,source,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE returnId=? ORDER BY id',id).map(x=>({id:n(x.id),code:x.code,amount:n(x.amount),expiresAt:x.expiresAt==null?null:n(x.expiresAt),status:x.status,source:x.source,restrictScope:x.restrictScope,restrictCategoryIdsJson:x.restrictCategoryIdsJson}))}
async function snapshot(shift,vs,creditIds){return{blue:n(await physicalMovementForCustodyShift(shift)),stocks:vs.map(v=>({label:v.label,stock:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock)})),credits:creditIds.map(id=>{const c=rawCredit(id);return{id:n(c.id),amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt)}}),returns:seed.rows('SELECT id,kind,total,refundMethod,refundAmount,exchangeDiff FROM "SaleReturn" WHERE shiftId=? ORDER BY id',shift).map(r=>({id:n(r.id),kind:r.kind,total:n(r.total),method:r.refundMethod,refundAmount:n(r.refundAmount),diff:r.exchangeDiff==null?null:n(r.exchangeDiff)}))}}
const specs=[
{id:'B-exchange_then_A-cash-return',bAction:'EXCHANGE',aAction:'RETURN'},
{id:'B-exchange_then_A-exchange',bAction:'EXCHANGE',aAction:'EXCHANGE'},
{id:'B-return_then_A-cash-return',bAction:'RETURN',aAction:'RETURN'},
{id:'B-return_then_A-exchange',bAction:'RETURN',aAction:'EXCHANGE'}]
const cases=[]
for(const spec of specs){
 const shiftId=seed.insert('Shift',{name:`BFAS ${spec.id}`,number:900+cases.length,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
 const cats={A:seed.category(`BFAS-${spec.id}-A`),B:seed.category(`BFAS-${spec.id}-B`),CD:seed.category(`BFAS-${spec.id}-CD`)}
 const A=variant(cats.A,'A-200k',200_000),B=variant(cats.B,'B-200k',200_000),C=variant(cats.CD,'C-300k',300_000),D=variant(cats.CD,'D-300k',300_000),A1=variant(cats.A,'A1-180k',180_000),B1=variant(cats.B,'B1-180k',180_000)
 const vs=[A,B,C,D,A1,B1],entry={id:spec.id,aAction:spec.aAction,bAction:spec.bAction,verdict:'HARNESS_ERROR',steps:[]};cases.push(entry)
 try{
  const bCredit=await issue(cats.B,`${spec.id}: B-only 50k`),cd=[];for(let i=0;i<3;i++)cd.push(await issue(cats.CD,`${spec.id}: C/D-only 50k ${i+1}`))
  const root=await salesService.create({userId,shiftId,lines:[A,B,C,D].map(v=>line(v.id,v.price)),storeCredits:[bCredit,...cd].map(c=>({code:c.code,requestedAmount:50_000})),payments:[{methodId:cashMethod,amount:800_000,destination:'CASH'}],saleRequestIdempotencyKey:`bfas-${spec.id}-root`})
  if(n(root.grandTotal)!==1_000_000||n(root.storeCreditApplied)!==200_000||n(root.paidTotal)!==1_000_000)throw new Error('Base sale mismatch')
  const items=seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',root.id),itemA=items.find(x=>n(x.variantId)===A.id),itemB=items.find(x=>n(x.variantId)===B.id),cids=[bCredit.id,...cd.map(c=>c.id)]
  entry.setup={invoiceId:n(root.id),total:n(root.grandTotal),creditApplied:n(root.storeCreditApplied),cashPaid:800_000,bSource:{code:bCredit.code,amount:50_000,scope:'B only'}}
  async function performB(){
   const before=await snapshot(shiftId,vs,cids);let result=null,error=''
   try{result=spec.bAction==='EXCHANGE'
    ?await salesService.createExchange({userId,shiftId,invoiceId:n(root.id),lines:[{saleItemId:n(itemB.id),qty:1}],replacements:[line(B1.id,B1.price)],refundMode:'STORE_CREDIT',idempotencyKey:`bfas-${spec.id}-B`})
    :await salesService.createReturn({userId,shiftId,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(itemB.id),qty:1}],refundMethod:'STORE_CREDIT'})
   }catch(e){error=String(e?.message??e)}
   const after=await snapshot(shiftId,vs,cids)
   if(!result)return{step:`B first: ${spec.bAction==='EXCHANGE'?'B→B1 exchange':'full B return'}`,accepted:false,error,mutationFree:JSON.stringify(before)===JSON.stringify(after),before,after}
   const rid=spec.bAction==='EXCHANGE'?result.returnId:result.id
   return{step:`B first: ${spec.bAction==='EXCHANGE'?'B→B1 exchange':'full B return'}`,accepted:true,returnId:n(rid),diff:result.diff==null?null:n(result.diff),total:result.total==null?null:n(result.total),sourceCreditRestoredAmount:n(result.sourceCreditRestoredAmount),issuedCredits:creditsByReturn(rid),oldBSource:{status:rawCredit(bCredit.id).status,usedAmount:n(rawCredit(bCredit.id).usedAmount)},after}
  }
  async function performA(){
   const before=await snapshot(shiftId,vs,cids);let result=null,error=''
   try{result=spec.aAction==='RETURN'
    ?await salesService.createReturn({userId,shiftId,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(itemA.id),qty:1}],refundMethod:'CASH',refundAmount:200_000})
    :await salesService.createExchange({userId,shiftId,invoiceId:n(root.id),lines:[{saleItemId:n(itemA.id),qty:1}],replacements:[line(A1.id,A1.price)],refundMode:'STORE_CREDIT',idempotencyKey:`bfas-${spec.id}-A`})
   }catch(e){error=String(e?.message??e)}
   const after=await snapshot(shiftId,vs,cids)
   if(!result)return{step:`A second: ${spec.aAction==='RETURN'?'cash return 200,000':'A→A1 exchange'}`,accepted:false,error,mutationFree:JSON.stringify(before)===JSON.stringify(after),before,after}
   const rid=spec.aAction==='RETURN'?result.id:result.returnId
   return{step:`A second: ${spec.aAction==='RETURN'?'cash return 200,000':'A→A1 exchange 200,000→180,000'}`,accepted:true,returnId:n(rid),diff:result.diff==null?null:n(result.diff),refundAmount:n(result.refundAmount),sourceCreditRestoredAmount:n(result.sourceCreditRestoredAmount),issuedCredits:creditsByReturn(rid),after}
  }
  const bStep=await performB();entry.steps.push(bStep)
  if(bStep.accepted){const aStep=await performA();entry.steps.push(aStep);entry.verdict=aStep.accepted?'ACCEPTED':'BLOCKED'}else{entry.steps.push({step:`A second: ${spec.aAction==='RETURN'?'cash return':'A→A1 exchange'}`,accepted:null,reason:'Skipped because the first B operation was rejected.'});entry.verdict='BLOCKED'}
 }catch(e){entry.verdict='HARNESS_ERROR';entry.error=String(e?.message??e);entry.stack=String(e?.stack??'')}
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,suite:'Reverse-order controls: B operation first, then A operation; four independent sequences.',totals:{cases:cases.length,accepted:cases.filter(c=>c.verdict==='ACCEPTED').length,blocked:cases.filter(c=>c.verdict==='BLOCKED').length,harnessErrors:cases.filter(c=>c.verdict==='HARNESS_ERROR').length},cases}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-b-first-a-second-operation.json'),JSON.stringify(summary,null,2)+'\n')
const lines=['# ابتدا عملیات B، سپس برگشت/تعویض A','',`**نتیجه:** ${summary.totals.accepted}/${summary.totals.cases} زنجیره کامل؛ ${summary.totals.blocked} متوقف؛ ${summary.totals.harnessErrors} خطای harness.`,`**DB:** SQLite موقت (${summary.isolatedDatabase})؛ فقط محیط آزمایشی.`,
 '**فاکتور:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ منبع B محدود به B و سه منبع دیگر محدود به C/D؛ پرداخت نقدی ۸۰۰٬۰۰۰. ترتیب آزمایش: عملیات B اول، سپس عملیات A.', '', '| مسیر | عملیات B اول | عملیات A دوم | نتیجه |','|---|---|---|---|',...cases.map(c=>`| ${c.id} | ${c.steps[0]?.accepted?'PASS':'BLOCKED'}${c.steps[0]?.error?`: ${c.steps[0].error}`:''} | ${c.steps[1]?.accepted===null?'ردیابی نشد':c.steps[1]?.accepted?'PASS':'BLOCKED'} | ${c.verdict} |`), '', '## جزئیات',...cases.flatMap(c=>[`### ${c.id} — ${c.verdict}`,...c.steps.map(s=>`- **${s.step}**: ${s.accepted===null?'ردیابی نشد':s.accepted?'پذیرفته شد':'رد شد'}${s.error?`; خطا: ${s.error}`:''}${s.mutationFree===undefined?'':`; بدون mutation: ${s.mutationFree}`}${s.issuedCredits?`; اعتبارهای صادرشده: ${JSON.stringify(s.issuedCredits)}`:''}${s.sourceCreditRestoredAmount===undefined?'':`; سهم اعتبار منبع برگشتی: ${n(s.sourceCreditRestoredAmount).toLocaleString('fa-IR')}`}`),c.error?`- Harness: ${c.error}`:'']), '', '## ایمنی','- SQLite موقت ایزوله؛ هیچ production source، DB واقعی یا stage تغییر نکرد.','- هیچ چک یا عملیات نسیه/تسویهٔ نسیه اجرا نشد.']
writeFileSync(join(out,'deep-e2e-b-first-a-second-operation.md'),lines.join('\n')+'\n')
console.log(`B-first/A-second: ACCEPTED=${summary.totals.accepted}; BLOCKED=${summary.totals.blocked}; HARNESS_ERROR=${summary.totals.harnessErrors}`)
await db.$disconnect?.();if(summary.totals.blocked||summary.totals.harnessErrors)process.exitCode=1
