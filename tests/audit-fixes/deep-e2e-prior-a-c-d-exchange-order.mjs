import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-prior-a-cd-exchange-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('prior-A-C-D exchange order audit')
const cashMethod=seed.insert('PaymentMethod',{key:'PACD-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const n=x=>Number(x??0),line=(id,price)=>({variantId:id,qty:1,unitPrice:price,discount:0,tax:0})
let seq=0
function variant(cat,label,price){const p=seed.product(`PACD-${++seq}-${label}`,cat),id=seed.variant(p,`PACD-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,label,price}}
function rawCredit(id){return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE id=?',id)}
async function issue(amount,category,note){const r=await storeCreditService.issueManual({amount,multiUse:false,maxUses:1,carryRemainder:true,days:30,restrictScope:'CATEGORY',restrictCategoryIds:[category],userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note});return{...r,code:rawCredit(r.id).code}}
function issued(returnId){return seed.rows('SELECT id,code,amount,expiresAt,expiresAtJalali,status,source,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE returnId=? ORDER BY id',returnId).map(x=>({id:n(x.id),code:x.code,amount:n(x.amount),expiresAt:x.expiresAt==null?null:n(x.expiresAt),expiresAtJalali:x.expiresAtJalali,status:x.status,source:x.source,restrictScope:x.restrictScope,restrictCategoryIdsJson:x.restrictCategoryIdsJson}))}
async function snapshot(shift,variants,creditIds){return{blue:n(await physicalMovementForCustodyShift(shift)),stocks:variants.map(v=>({name:v.label,stock:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock)})),credits:creditIds.map(id=>{const c=rawCredit(id);return{id:n(c.id),amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt)}}),returns:seed.rows('SELECT id,kind,total,refundMethod,refundAmount,exchangeDiff FROM "SaleReturn" WHERE shiftId=? ORDER BY id',shift).map(r=>({id:n(r.id),kind:r.kind,total:n(r.total),method:r.refundMethod,refundAmount:n(r.refundAmount),diff:r.exchangeDiff==null?null:n(r.exchangeDiff)}))}}
const specs=[]
for(const target of ['C','D'])for(const aAction of ['RETURN','EXCHANGE'])for(const order of ['A_FIRST','TARGET_FIRST'])specs.push({id:`${order}-${aAction}-${target}-EXCHANGE`,target,aAction,order})
const cases=[]
for(const spec of specs){
 const shift=seed.insert('Shift',{name:`PACD ${spec.id}`,number:1000+cases.length,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
 const cats={A:seed.category(`PACD-${spec.id}-A`),B:seed.category(`PACD-${spec.id}-B`),C:seed.category(`PACD-${spec.id}-C`),D:seed.category(`PACD-${spec.id}-D`)}
 const A=variant(cats.A,'A-200k',200_000),B=variant(cats.B,'B-200k',200_000),C=variant(cats.C,'C-300k',300_000),D=variant(cats.D,'D-300k',300_000),A1=variant(cats.A,'A1-180k',180_000),C1=variant(cats.C,'C1-280k',280_000),D1=variant(cats.D,'D1-280k',280_000)
 const vs=[A,B,C,D,A1,C1,D1],entry={id:spec.id,target:spec.target,aAction:spec.aAction,order:spec.order,verdict:'HARNESS_ERROR',steps:[]};cases.push(entry)
 try{
  const sources={B:await issue(50_000,cats.B,`${spec.id}: B-only 50k`),C:await issue(100_000,cats.C,`${spec.id}: C-only 100k`),D:await issue(50_000,cats.D,`${spec.id}: D-only 50k`)}
  const root=await salesService.create({userId,shiftId:shift,lines:[A,B,C,D].map(v=>line(v.id,v.price)),storeCredits:Object.values(sources).map(c=>({code:c.code,requestedAmount:n(rawCredit(c.id).amount)})),payments:[{methodId:cashMethod,amount:800_000,destination:'CASH'}],saleRequestIdempotencyKey:`pacd-${spec.id}-root`})
  if(n(root.grandTotal)!==1_000_000||n(root.storeCreditApplied)!==200_000||n(root.paidTotal)!==1_000_000)throw new Error('Base totals mismatch: expected 1,000,000 total, 200,000 restricted credit and 800,000 cash')
  const items=seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',root.id),itemFor=v=>items.find(x=>n(x.variantId)===v.id)
  const itemIds={A:itemFor(A),B:itemFor(B),C:itemFor(C),D:itemFor(D)},creditIds=Object.values(sources).map(c=>c.id)
  entry.setup={invoiceId:n(root.id),total:n(root.grandTotal),creditApplied:n(root.storeCreditApplied),cashPaid:800_000,restrictedCredits:Object.fromEntries(Object.entries(sources).map(([k,c])=>[k,{id:n(c.id),code:c.code,amount:n(rawCredit(c.id).amount),scope:`${k} category only`,expiry:n(rawCredit(c.id).expiresAt)}]))}
  const targetReplacement=spec.target==='C'?C1:D1,sourceExpiry=n(rawCredit(sources[spec.target].id).expiresAt)
  async function doA(){
   const before=await snapshot(shift,vs,creditIds);let res=null,error=''
   try{res=spec.aAction==='RETURN'?await salesService.createReturn({userId,shiftId:shift,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(itemIds.A.id),qty:1}],refundMethod:'CASH',refundAmount:200_000})
    :await salesService.createExchange({userId,shiftId:shift,invoiceId:n(root.id),lines:[{saleItemId:n(itemIds.A.id),qty:1}],replacements:[line(A1.id,A1.price)],refundMode:'STORE_CREDIT',idempotencyKey:`pacd-${spec.id}-A`})}catch(e){error=String(e?.message??e)}
   const after=await snapshot(shift,vs,creditIds)
   if(!res)return{step:`A ${spec.aAction}`,accepted:false,error,mutationFree:JSON.stringify(before)===JSON.stringify(after)}
   const rid=spec.aAction==='RETURN'?res.id:res.returnId
   return{step:spec.aAction==='RETURN'?'A cash return 200,000':'A→A1 exchange 200,000→180,000',accepted:true,returnId:n(rid),refundAmount:n(res.refundAmount),diff:res.diff==null?null:n(res.diff),sourceCreditRestoredAmount:n(res.sourceCreditRestoredAmount),issued:issued(rid),after}
  }
  async function doTarget(){
   const key=spec.target,before=await snapshot(shift,vs,creditIds);let res=null,error=''
   try{res=await salesService.createExchange({userId,shiftId:shift,invoiceId:n(root.id),lines:[{saleItemId:n(itemIds[key].id),qty:1}],replacements:[line(targetReplacement.id,targetReplacement.price)],refundMode:'STORE_CREDIT',idempotencyKey:`pacd-${spec.id}-${key}`})}catch(e){error=String(e?.message??e)}
   const after=await snapshot(shift,vs,creditIds)
   if(!res)return{step:`${key}→${spec.target}1 exchange`,accepted:false,error,mutationFree:JSON.stringify(before)===JSON.stringify(after),before,after}
   const rows=issued(res.returnId),total=rows.reduce((s,x)=>s+x.amount,0),exact=rows.filter(x=>x.expiresAt===sourceExpiry).reduce((s,x)=>s+x.amount,0),source=rawCredit(sources[key].id)
   return{step:`${key}→${spec.target}1 exchange`,accepted:true,returnId:n(res.returnId),diff:n(res.diff),sourceCreditRestoredAmount:n(res.sourceCreditRestoredAmount),issued:rows,check:{expectedDifference:-20_000,actualDifference:n(res.diff),expectedSuccessor:20_000,actualIssued:total,expectedSourceExpiry:sourceExpiry,exactSourceExpiryAmount:exact,oldSourceStillUsed:source.status==='USED'&&n(source.usedAmount)===n(source.amount)},after}
  }
  const sequence=spec.order==='A_FIRST'?[doA,doTarget]:[doTarget,doA]
  let accepted=true
  for(let i=0;i<sequence.length;i++){
   const step=await sequence[i]();entry.steps.push(step)
   if(!step.accepted){accepted=false;for(const skipped of sequence.slice(i+1))entry.steps.push({step:skipped===doA?'A action':'target exchange',accepted:null,reason:'Skipped after prior step was rejected.'});break}
  }
  entry.verdict=accepted?'ACCEPTED':entry.steps.some(s=>s.accepted===false)?'BLOCKED':'INCOMPLETE'
 }catch(e){entry.error=String(e?.message??e);entry.stack=String(e?.stack??'');entry.verdict='HARNESS_ERROR'}
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,suite:'A cash return or exchange versus C/D restricted-category exchange; both orders tested; source pools are exact per category.',totals:{cases:cases.length,accepted:cases.filter(c=>c.verdict==='ACCEPTED').length,blocked:cases.filter(c=>c.verdict==='BLOCKED').length,harnessErrors:cases.filter(c=>c.verdict==='HARNESS_ERROR').length},cases}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-prior-a-c-d-exchange-order.json'),JSON.stringify(summary,null,2)+'\n')
const lines=['# آیا تعویض C یا D پس از عملیات A هم رد می‌شود؟','',`**نتیجه:** ${summary.totals.accepted}/${summary.totals.cases} زنجیره کامل؛ ${summary.totals.blocked} رد؛ ${summary.totals.harnessErrors} خطای harness.`,`**DB:** SQLite موقت و ایزوله (${summary.isolatedDatabase}).`,
 '**فاکتور:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ کل اعتبار ۲۰۰٬۰۰۰: B-only=۵۰٬۰۰۰، C-only=۱۰۰٬۰۰۰، D-only=۵۰٬۰۰۰؛ پرداخت نقدی=۸۰۰٬۰۰۰. هر اعتبار فقط به دستهٔ قلم خودش محدود است. A بیرون از scope همهٔ اعتبارهاست.',
 '**عملیات هدف:** C→C1 و D→D1 هرکدام با اختلاف ۲۰٬۰۰۰؛ در هر مسیر A یا برگشت نقدی ۲۰۰٬۰۰۰ است یا تعویض A→A1 با اختلاف ۲۰٬۰۰۰. هر مسیر پایگاه و شیفت جدا دارد.','',
 '| ترتیب و مسیر | گام اول | گام دوم | نتیجه |','|---|---|---|---|',...cases.map(c=>`| ${c.id} | ${c.steps[0]?.accepted?'PASS':'BLOCKED'}${c.steps[0]?.error?`: ${c.steps[0].error}`:''} | ${c.steps[1]?.accepted===null?'Skipped':c.steps[1]?.accepted?'PASS':'BLOCKED'}${c.steps[1]?.error?`: ${c.steps[1].error}`:''} | ${c.verdict} |`),
 '', '## جزئیات تطبیق',...cases.flatMap(c=>[`### ${c.id} — ${c.verdict}`,...c.steps.map(s=>`- **${s.step}**: ${s.accepted===null?'ردیابی نشد':s.accepted?'پذیرفته شد':'رد شد'}${s.error?`; پیام: ${s.error}`:''}${s.mutationFree===undefined?'':`; بدون تغییر پس از رد: ${s.mutationFree}`}${s.issued?`; اعتبار صادرشده: ${JSON.stringify(s.issued)}`:''}${s.check?`; بررسی منبع: ${JSON.stringify(s.check)}`:''}`),c.error?`- خطای harness: ${c.error}`:'']),
 '', '## ایمنی','- فقط SQLite آزمایشی موقت؛ هیچ production code یا DB واقعی تغییر نکرد.','- هیچ چک یا عملیات نسیه/تسویهٔ نسیه اجرا نشد.']
writeFileSync(join(out,'deep-e2e-prior-a-c-d-exchange-order.md'),lines.join('\n')+'\n')
console.log(`A then C/D exchange matrix: ACCEPTED=${summary.totals.accepted}/${summary.totals.cases}; BLOCKED=${summary.totals.blocked}; HARNESS_ERROR=${summary.totals.harnessErrors}`)
await db.$disconnect?.();if(summary.totals.blocked||summary.totals.harnessErrors)process.exitCode=1
