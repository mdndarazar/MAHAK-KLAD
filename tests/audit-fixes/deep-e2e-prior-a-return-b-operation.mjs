import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-prior-a-b-operation-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('prior-A-return-B-operation-audit')
const cashMethod = seed.insert('PaymentMethod', { key: 'PARBO-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const n = x => Number(x ?? 0)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
let sequence = 0

function addVariant(categoryId,label,price) {
  const product=seed.product(`PARBO-${++sequence}-${label}`,categoryId), id=seed.variant(product,`PARBO-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id)
  return {id,label,price}
}
function rawCredit(id) {
  return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE id=?',id)
}
async function issueRestricted(amount,categoryId,note) {
  const x=await storeCreditService.issueManual({amount,multiUse:false,maxUses:1,carryRemainder:true,days:30,
    restrictScope:'CATEGORY',restrictCategoryIds:[categoryId],userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note})
  return {...x,code:rawCredit(x.id).code}
}
function issuedCredits(returnId) {
  return seed.rows('SELECT id,code,amount,expiresAt,expiresAtJalali,status,source,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE returnId=? ORDER BY id',returnId)
    .map(c=>({id:n(c.id),code:c.code,amount:n(c.amount),expiresAt:c.expiresAt==null?null:n(c.expiresAt),expiresAtJalali:c.expiresAtJalali,status:c.status,source:c.source,restrictScope:c.restrictScope,restrictCategoryIdsJson:c.restrictCategoryIdsJson}))
}
async function snapshot(shiftId,variants,creditIds) {
  return { blue:n(await physicalMovementForCustodyShift(shiftId)),
    stocks:variants.map(v=>({label:v.label,stock:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock)})),
    credits:creditIds.map(id=>{const c=rawCredit(id);return{id:n(c.id),amount:n(c.amount),usedAmount:n(c.usedAmount),usedCount:n(c.usedCount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt)}}),
    returns:seed.rows('SELECT id,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeDiff,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE shiftId=? ORDER BY id',shiftId)
      .map(r=>({id:n(r.id),kind:r.kind,total:n(r.total),method:r.refundMethod,refundAmount:n(r.refundAmount),refundCredit:n(r.refundStoreCreditAmount),diff:n(r.exchangeDiff),settlement:r.exchangeSettlement,exchangeInvoiceId:r.exchangeInvoiceId==null?null:n(r.exchangeInvoiceId)})),
    invoiceCount:seed.count('SaleInvoice','shiftId=?',shiftId), paymentCount:seed.count('Payment','createdShiftId=?',shiftId),
    allocationCount:seed.count('CreditReturnAllocation','invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)',shiftId) }
}

const specs=[
  {id:'A-cash-return_then_B-exchange',aAction:'RETURN',bAction:'EXCHANGE'},
  {id:'A-cash-return_then_B-return',aAction:'RETURN',bAction:'RETURN'},
  {id:'A-exchange_then_B-exchange',aAction:'EXCHANGE',bAction:'EXCHANGE'},
  {id:'A-exchange_then_B-return',aAction:'EXCHANGE',bAction:'RETURN'}
]
const cases=[]
for(const spec of specs){
  const shiftId=seed.insert('Shift',{name:`PARBO ${spec.id}`,number:800+cases.length,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
  const cat={A:seed.category(`PARBO-${spec.id}-A`),B:seed.category(`PARBO-${spec.id}-B`),CD:seed.category(`PARBO-${spec.id}-CD`)}
  const A=addVariant(cat.A,'A-200k',200_000),B=addVariant(cat.B,'B-200k',200_000),C=addVariant(cat.CD,'C-300k',300_000),D=addVariant(cat.CD,'D-300k',300_000)
  const A1=addVariant(cat.A,'A1-180k',180_000),B1=addVariant(cat.B,'B1-180k',180_000)
  const variants=[A,B,C,D,A1,B1]
  const entry={id:spec.id,aAction:spec.aAction,bAction:spec.bAction,verdict:'HARNESS_ERROR',steps:[]}
  cases.push(entry)
  try{
    const bCredit=await issueRestricted(50_000,cat.B,`${spec.id}: B-only source`)
    const cdCredits=[]
    for(let i=0;i<3;i++)cdCredits.push(await issueRestricted(50_000,cat.CD,`${spec.id}: C/D-only source ${i+1}`))
    const root=await salesService.create({userId,shiftId,lines:[A,B,C,D].map(v=>line(v.id,v.price)),
      storeCredits:[bCredit,...cdCredits].map(c=>({code:c.code,requestedAmount:50_000})),
      payments:[{methodId:cashMethod,amount:800_000,destination:'CASH'}],saleRequestIdempotencyKey:`parbo-${spec.id}-root`})
    if(n(root.grandTotal)!==1_000_000||n(root.storeCreditApplied)!==200_000||n(root.paidTotal)!==1_000_000)throw new Error('Base invoice did not settle as total 1,000,000 / restricted credits 200,000 / cash 800,000')
    const rootItems=seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',root.id)
    const sourceA=rootItems.find(x=>n(x.variantId)===A.id),sourceB=rootItems.find(x=>n(x.variantId)===B.id)
    const allCreditIds=[bCredit.id,...cdCredits.map(c=>c.id)]
    entry.setup={rootInvoiceId:n(root.id),total:n(root.grandTotal),creditsApplied:n(root.storeCreditApplied),cashPaid:800_000,
      bSource:{id:n(bCredit.id),code:bCredit.code,amount:50_000,scope:'B category only'},otherSources:cdCredits.map(c=>({id:n(c.id),code:c.code,amount:50_000,scope:'C/D categories only'}))}
    let aResult
    if(spec.aAction==='RETURN'){
      aResult=await salesService.createReturn({userId,shiftId,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(sourceA.id),qty:1}],refundMethod:'CASH',refundAmount:200_000})
      entry.steps.push({step:'A first: cash refund 200,000',accepted:true,returnId:n(aResult.id),total:n(aResult.total),refundMethod:aResult.refundMethod,refundAmount:n(aResult.refundAmount),sourceCreditRestoredAmount:n(aResult.sourceCreditRestoredAmount),successors:aResult.sourceCreditSuccessors??[],issuedCredits:issuedCredits(aResult.id),after:await snapshot(shiftId,variants,allCreditIds)})
    }else{
      aResult=await salesService.createExchange({userId,shiftId,invoiceId:n(root.id),lines:[{saleItemId:n(sourceA.id),qty:1}],replacements:[line(A1.id,A1.price)],refundMode:'STORE_CREDIT',idempotencyKey:`parbo-${spec.id}-A-exchange`})
      entry.steps.push({step:'A first: A→A1 (200,000→180,000)',accepted:true,returnId:n(aResult.returnId),exchangeInvoiceId:n(aResult.exchangeInvoiceId),diff:n(aResult.diff),sourceCreditRestoredAmount:n(aResult.sourceCreditRestoredAmount),issuedCredits:issuedCredits(aResult.returnId),after:await snapshot(shiftId,variants,allCreditIds)})
    }
    const beforeB=await snapshot(shiftId,variants,allCreditIds)
    let bResult=null,bError=''
    try{
      if(spec.bAction==='EXCHANGE'){
        bResult=await salesService.createExchange({userId,shiftId,invoiceId:n(root.id),lines:[{saleItemId:n(sourceB.id),qty:1}],replacements:[line(B1.id,B1.price)],refundMode:'STORE_CREDIT',idempotencyKey:`parbo-${spec.id}-B-exchange`})
      }else{
        bResult=await salesService.createReturn({userId,shiftId,invoiceId:n(root.id),full:false,lines:[{saleItemId:n(sourceB.id),qty:1}],refundMethod:'STORE_CREDIT'})
      }
    }catch(e){bError=String(e?.message??e)}
    const afterB=await snapshot(shiftId,variants,allCreditIds)
    if(!bResult){
      entry.steps.push({step:`B second: ${spec.bAction==='EXCHANGE'?'B→B1 exchange':'full B return'}`,accepted:false,error:bError,mutationFree:JSON.stringify(beforeB)===JSON.stringify(afterB),before:beforeB,after:afterB})
      entry.verdict=JSON.stringify(beforeB)===JSON.stringify(afterB)?'BLOCKED':'BLOCKED_WITH_MUTATION'
    }else{
      const rid=spec.bAction==='EXCHANGE'?bResult.returnId:bResult.id
      entry.steps.push({step:`B second: ${spec.bAction==='EXCHANGE'?'B→B1 exchange':'full B return'}`,accepted:true,returnId:n(rid),exchangeInvoiceId:bResult.exchangeInvoiceId==null?null:n(bResult.exchangeInvoiceId),total:n(bResult.total),diff:bResult.diff==null?null:n(bResult.diff),refundMethod:bResult.refundMethod??null,refundAmount:n(bResult.refundAmount),refundStoreCreditAmount:n(bResult.refundStoreCreditAmount),returnCreditAmount:n(bResult.returnCreditAmount),sourceCreditRestoredAmount:n(bResult.sourceCreditRestoredAmount),sourceCreditSuccessors:(bResult.sourceCreditSuccessors??[]).map(c=>({id:n(c.id),amount:n(c.amount),expiresAt:c.expiresAt??null})),issuedCredits:issuedCredits(rid),oldBSource:{status:rawCredit(bCredit.id).status,usedAmount:n(rawCredit(bCredit.id).usedAmount)},after:afterB})
      entry.verdict='ACCEPTED'
    }
  }catch(e){entry.error=String(e?.message??e);entry.stack=String(e?.stack??'');entry.verdict='HARNESS_ERROR'}
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,
  suite:'Does a prior cash-backed A return or exchange block the next B exchange or B return? Four isolated flows; B-only credit share 50,000; C/D-only other sources.',
  totals:{cases:cases.length,accepted:cases.filter(x=>x.verdict==='ACCEPTED').length,blocked:cases.filter(x=>x.verdict==='BLOCKED'||x.verdict==='BLOCKED_WITH_MUTATION').length,blockedWithMutation:cases.filter(x=>x.verdict==='BLOCKED_WITH_MUTATION').length,harnessErrors:cases.filter(x=>x.verdict==='HARNESS_ERROR').length},cases}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true})
writeFileSync(join(out,'deep-e2e-prior-a-return-b-operation.json'),JSON.stringify(summary,null,2)+'\n')
const lines=['# برگشت/تعویض A پیش از تعویض/برگشت B','',
  `**نتیجه:** ${summary.totals.accepted} پذیرفته؛ ${summary.totals.blocked} رد؛ ${summary.totals.blockedWithMutation} رد همراه mutation؛ ${summary.totals.harnessErrors} خطای harness.`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}); هیچ DB واقعی یا stage استفاده نشد.`,
  '**فاکتور پایه:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ اعتبار ۵۰٬۰۰۰ فقط برای B و سه اعتبار ۵۰٬۰۰۰ فقط برای C/D؛ نقد=۸۰۰٬۰۰۰. A پشتوانهٔ پول واقعی دارد و بیرون از scope اعتبارهاست.',
  '**چهار مسیر مستقل:** A برگشت نقدی→B تعویض؛ A برگشت نقدی→B برگشت؛ A→A1 تعویض→B تعویض؛ A→A1 تعویض→B برگشت. هر مسیر DB/shift مستقل دارد.', '',
  '| مسیر | مرحلهٔ A | مرحلهٔ B | نتیجهٔ B |', '|---|---|---|---|',
  ...cases.map(c=>{const a=c.steps.find(s=>s.step.startsWith('A first'));const b=c.steps.find(s=>s.step.startsWith('B second'));return `| ${c.id} | ${a?.accepted?'انجام شد':'ناموفق'} | ${b?.accepted?'پذیرفته شد':'رد شد'}${b?.error?`: ${b.error}`:''} | ${c.verdict} |`}),
  '', '## جزئیات', ...cases.flatMap(c=>[`### ${c.id} — ${c.verdict}`,
    ...c.steps.map(s=>`- **${s.step}**: ${s.accepted?'پذیرفته شد':'رد شد'}${s.error?`; پیام: ${s.error}`:''}${s.mutationFree===undefined?'':`; بدون تغییرِ ردشده: ${s.mutationFree}`}${s.issuedCredits?`; اعتبارهای صادرشده: ${JSON.stringify(s.issuedCredits)}`:''}${s.sourceCreditRestoredAmount===undefined?'':`; سهم اعتبار منبع برگشتی: ${n(s.sourceCreditRestoredAmount).toLocaleString('fa-IR')}`}`),
    c.error?`- خطای harness: ${c.error}`:'']),
  '', '## ایمنی', '- فقط service-layer روی SQLite موقت؛ در هیچ سناریویی چک یا مسیر نسیه/تسویهٔ نسیه اجرا نشد.', '- production source، DB واقعی و stage تغییر نکردند.']
writeFileSync(join(out,'deep-e2e-prior-a-return-b-operation.md'),lines.join('\n')+'\n')
console.log(`prior A -> B operation: ACCEPTED=${summary.totals.accepted}; BLOCKED=${summary.totals.blocked}; BLOCKED_WITH_MUTATION=${summary.totals.blockedWithMutation}; HARNESS_ERROR=${summary.totals.harnessErrors}; report=reports/deep-e2e-prior-a-return-b-operation.md`)
await db.$disconnect?.()
if(summary.totals.harnessErrors||summary.totals.blockedWithMutation)process.exitCode=1
