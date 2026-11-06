import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve,join} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-e100-018-provenance-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs'),{makeSeeder}=await import('../../test/harness/seed.mjs'),{salesService}=await import('../../src/main/services/SalesService.ts'),{storeCreditService}=await import('../../src/main/services/StoreCreditService.ts'),{physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts'),{DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts'),{toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,userId=seed.user('E100-018 exchange provenance matrix'),cash=seed.insert('PaymentMethod',{key:'E018P-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1}),card=seed.insert('PaymentMethod',{key:'E018P-CARD',label:'isolated POS',kind:'CARD',isActive:1,sortOrder:2}),allCategory=seed.category('E100-018-ALL'),n=x=>Number(x??0),line=(id,price)=>({variantId:id,qty:1,unitPrice:price,discount:0,tax:0});let seq=0
function variant(label,price){const p=seed.product(`E018P-${++seq}-${label}`,allCategory),id=seed.variant(p,`E018P-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,label,price}}
const raw=id=>seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?',id)
async function snap(shift,vs,cids){return{blue:n(await physicalMovementForCustodyShift(shift)),stocks:vs.map(v=>({label:v.label,stock:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock)})),credits:cids.map(id=>{const c=raw(id);return{id:n(c.id),code:c.code,amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,scope:c.restrictScope}}),returns:seed.rows('SELECT id,kind,total,exchangeDiff,refundMethod,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE shiftId=? ORDER BY id',shift).map(r=>({id:n(r.id),kind:r.kind,total:n(r.total),diff:r.exchangeDiff==null?null:n(r.exchangeDiff),method:r.refundMethod,settlement:r.exchangeSettlement,exchangeInvoiceId:r.exchangeInvoiceId==null?null:n(r.exchangeInvoiceId)})),invoices:seed.rows('SELECT id,grandTotal,paidTotal,status,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id',shift).map(i=>({id:n(i.id),total:n(i.grandTotal),paid:n(i.paidTotal),status:i.status,parent:i.sourceInvoiceId==null?null:n(i.sourceInvoiceId)}))}}
const specs=[
 {id:'A-return_Bplus_CplusDminus',target:'CD_NEG',includeB:true},
 {id:'A-return_Bplus_CplusDplus',target:'CD_POS',includeB:true},
 {id:'A-return_Bplus_Cminus',target:'C_NEG',includeB:true},
 {id:'A-return_Bplus_Dminus',target:'D_NEG',includeB:true},
 {id:'A-return_Bplus_child-B1minus',target:'B1_CHILD_NEG',includeB:true},
 {id:'A-return_Bplus_CD-full-return',target:'CD_RETURN',includeB:true},
 {id:'A-return_direct_CplusDminus-control',target:'CD_NEG',includeB:false}
]
const cases=[]
for(const spec of specs){
 const shift=seed.insert('Shift',{name:`E018P ${spec.id}`,number:1400+cases.length,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId}),A=variant('A-200k',200000),B=variant('B-200k',200000),C=variant('C-300k',300000),D=variant('D-300k',300000),B1=variant('B1-220k',220000),B2=variant('B2-200k',200000),C1=variant('C1-290k',290000),D1=variant('D1-290k',290000),C2=variant('C2-310k',310000),D2=variant('D2-310k',310000),vs=[A,B,C,D,B1,B2,C1,D1,C2,D2],entry={id:spec.id,target:spec.target,includeB:spec.includeB,verdict:'HARNESS_ERROR',steps:[]};cases.push(entry)
 try{
  const source=[];for(let i=0;i<6;i++){const c=await storeCreditService.issueManual({amount:100000,multiUse:false,maxUses:1,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note:`${spec.id}: ordinary ALL source ${i+1}`});source.push(c)}
  const root=await salesService.create({userId,shiftId:shift,lines:[A,B,C,D].map(v=>line(v.id,v.price)),storeCredits:source.map(c=>({code:raw(c.id).code,requestedAmount:100000})),payments:[{methodId:cash,amount:200000,destination:'CASH'},{methodId:card,amount:200000,destination:'CARD'}],saleRequestIdempotencyKey:`e018p-${spec.id}-root`})
  if(n(root.grandTotal)!==1000000||n(root.storeCreditApplied)!==600000||n(root.paidTotal)!==1000000)throw new Error('Root invoice totals mismatch')
  const items=seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',root.id),src={A:items.find(x=>n(x.variantId)===A.id),B:items.find(x=>n(x.variantId)===B.id),C:items.find(x=>n(x.variantId)===C.id),D:items.find(x=>n(x.variantId)===D.id)},cids=source.map(x=>x.id)
  entry.setup={invoiceId:n(root.id),cash:200000,card:200000,credit:600000,scope:'ALL for all six codes'}
  const ret=await salesService.createReturn({userId,shiftId:shift,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(src.A.id),qty:1}],refundMethod:'NONE',confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD})
  const aAlloc=seed.rows('SELECT id,sourceCreditId,redemptionId,amount FROM "CreditReturnAllocation" WHERE returnId=?',ret.id).map(x=>({id:n(x.id),sourceCreditId:n(x.sourceCreditId),redemptionId:n(x.redemptionId),amount:n(x.amount)}))
  entry.steps.push({step:'return A through invoice-wide credit pool',accepted:true,returnId:n(ret.id),sourceCreditRestoredAmount:n(ret.sourceCreditRestoredAmount),allocationCount:aAlloc.length,allocations:aAlloc,after:await snap(shift,vs,cids)})
  let bExchange=null
  if(spec.includeB){
   bExchange=await salesService.createExchange({userId,shiftId:shift,invoiceId:n(root.id),lines:[{saleItemId:n(src.B.id),qty:1}],replacements:[line(B1.id,B1.price)],methodId:card,idempotencyKey:`e018p-${spec.id}-B`})
   const bRet=seed.one('SELECT id,invoiceId,total,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE id=?',bExchange.returnId)
   const bAlloc=seed.rows('SELECT id,sourceCreditId,redemptionId,amount FROM "CreditReturnAllocation" WHERE returnId=?',bExchange.returnId).map(x=>({id:n(x.id),sourceCreditId:n(x.sourceCreditId),redemptionId:n(x.redemptionId),amount:n(x.amount)}))
   const childItems=seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',bExchange.exchangeInvoiceId)
   const childB1=childItems.find(x=>n(x.variantId)===B1.id)
   entry.child={invoiceId:n(bExchange.exchangeInvoiceId),saleItemId:childB1?n(childB1.id):null}
   entry.steps.push({step:'B→B1 positive exchange 200k→220k (+20k card)',accepted:true,returnId:n(bExchange.returnId),exchangeInvoiceId:n(bExchange.exchangeInvoiceId),diff:n(bExchange.diff),allocationCount:bAlloc.length,allocations:bAlloc,returnDocument:bRet?{total:n(bRet.total),diff:n(bRet.exchangeDiff),settlement:bRet.exchangeSettlement}:null,after:await snap(shift,vs,cids)})
  }
  const before=await snap(shift,vs,cids);let result=null,error=''
  try{
   if(spec.target==='CD_NEG'||spec.target==='CD_POS'){
    const replacements=spec.target==='CD_NEG'?[line(C1.id,C1.price),line(D1.id,D1.price)]:[line(C2.id,C2.price),line(D2.id,D2.price)]
    result=await salesService.createExchange({userId,shiftId:shift,invoiceId:n(root.id),lines:[{saleItemId:n(src.C.id),qty:1},{saleItemId:n(src.D.id),qty:1}],replacements,refundMode:spec.target==='CD_NEG'?'STORE_CREDIT':undefined,methodId:spec.target==='CD_POS'?cash:undefined,idempotencyKey:`e018p-${spec.id}-target`})
   }else if(spec.target==='C_NEG'||spec.target==='D_NEG'){
    const item=spec.target==='C_NEG'?src.C:src.D,repl=spec.target==='C_NEG'?C1:D1
    result=await salesService.createExchange({userId,shiftId:shift,invoiceId:n(root.id),lines:[{saleItemId:n(item.id),qty:1}],replacements:[line(repl.id,repl.price)],refundMode:'STORE_CREDIT',idempotencyKey:`e018p-${spec.id}-target`})
   }else if(spec.target==='CD_RETURN'){
    result=await salesService.createReturn({userId,shiftId:shift,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(src.C.id),qty:1},{saleItemId:n(src.D.id),qty:1}],refundMethod:'STORE_CREDIT'})
   }else{
    const childItemId=entry.child?.saleItemId
    if(!childItemId)throw new Error('B child invoice has no B1 line')
    result=await salesService.createExchange({userId,shiftId:shift,invoiceId:entry.child.invoiceId,lines:[{saleItemId:childItemId,qty:1}],replacements:[line(B2.id,B2.price)],refundMode:'STORE_CREDIT',idempotencyKey:`e018p-${spec.id}-child-reexchange`})
   }
  }catch(e){error=String(e?.message??e)}
  const after=await snap(shift,vs,cids)
  const label={CD_NEG:'C+D negative difference −20k',CD_POS:'C+D positive difference +20k',C_NEG:'C negative difference −10k',D_NEG:'D negative difference −10k',CD_RETURN:'full C+D return',B1_CHILD_NEG:'B1 re-exchange from child invoice −20k'}[spec.target]
  if(!result){entry.steps.push({step:`target: ${label}`,accepted:false,error,mutationFree:JSON.stringify(before)===JSON.stringify(after),before,after});entry.verdict='BLOCKED'}
  else{const returnId=result.returnId??result.id,issued=seed.rows('SELECT id,code,amount,expiresAt,status FROM "StoreCredit" WHERE returnId=? ORDER BY id',returnId).map(x=>({id:n(x.id),code:x.code,amount:n(x.amount),expiresAt:x.expiresAt==null?null:n(x.expiresAt),status:x.status}));entry.steps.push({step:`target: ${label}`,accepted:true,returnId:n(returnId),exchangeInvoiceId:result.exchangeInvoiceId==null?null:n(result.exchangeInvoiceId),diff:result.diff==null?null:n(result.diff),sourceCreditRestoredAmount:n(result.sourceCreditRestoredAmount),issued,after});entry.verdict='ACCEPTED'}
 }catch(e){entry.error=String(e?.message??e);entry.stack=String(e?.stack??'');entry.verdict='HARNESS_ERROR'}
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,suite:'E100-018 follow-up: invoice-wide credits; return A, optional positive B exchange, then test exchange direction/selection or child invoice.',totals:{cases:cases.length,accepted:cases.filter(c=>c.verdict==='ACCEPTED').length,blocked:cases.filter(c=>c.verdict==='BLOCKED').length,harnessErrors:cases.filter(c=>c.verdict==='HARNESS_ERROR').length},cases}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-scenario2-exchange-provenance-matrix.json'),JSON.stringify(summary,null,2)+'\n')
const lines=['# E100-018: تفکیک گیت تعویض‌های بعدی','',`**نتیجه:** ${summary.totals.accepted}/${summary.totals.cases} هدف پذیرفته؛ ${summary.totals.blocked} رد؛ ${summary.totals.harnessErrors} خطای harness.`,`**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,'**همهٔ بارکدها عادی ALL:** شش کد ۱۰۰٬۰۰۰؛ فروش ۱٬۰۰۰٬۰۰۰ با ۶۰۰٬۰۰۰ اعتبار، ۲۰۰٬۰۰۰ نقد و ۲۰۰٬۰۰۰ POS. A با اعتبار invoice-wide برگردانده شد؛ سپس در شش شاخه B→B1=220 (+20) با کارت انجام شد. شاخهٔ هفتم، کنترل بدون تعویض B است.','', '| هدف پس از A (و B، جز کنترل) | نتیجه | بدون تغییر پس از رد | پیام |','|---|---|---|---|',...cases.map(c=>{const x=c.steps.at(-1);return`| ${c.id} | ${x?.accepted?'پذیرفته شد':'رد شد'} | ${x?.mutationFree??'—'} | ${x?.error??'—'} |`}), '', '## رویدادهای کلیدی',...cases.flatMap(c=>[`### ${c.id} — ${c.verdict}`,...c.steps.map(s=>`- **${s.step}**: ${s.accepted?'پذیرفته شد':'رد شد'}${s.error?`; ${s.error}`:''}${s.mutationFree===undefined?'':`; mutation-free=${s.mutationFree}`}${s.allocationCount===undefined?'':`; allocationهای همین برگشت=${s.allocationCount}`}`)]),'','## ایمنی','- فقط SQLite موقت؛ هیچ چک، نسیه، stage یا DB واقعی استفاده نشد.','- هیچ production code تغییر نکرد.']
writeFileSync(join(out,'deep-e2e-scenario2-exchange-provenance-matrix.md'),lines.join('\n')+'\n')
console.log(`E100-018 exchange matrix: ACCEPTED=${summary.totals.accepted}/${summary.totals.cases}; BLOCKED=${summary.totals.blocked}; HARNESS_ERROR=${summary.totals.harnessErrors}`)
await db.$disconnect?.();if(summary.totals.harnessErrors)process.exitCode=1
