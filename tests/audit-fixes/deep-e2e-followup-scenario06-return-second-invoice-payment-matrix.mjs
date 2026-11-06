/**
 * Independent scenario 5 of 10: simple return from customer-presented exchange
 * invoice 2, with zero/one/four barcode purchase funding and all return methods.
 * Temporary SQLite only.
 */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-s06-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up return-from-exchange-invoice cashier')
const shiftId=seed.insert('Shift',{name:'follow-up simple return from invoice 2',number:7,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F06-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:'F06-CARD',label:'POS test',kind:'CARD',isActive:1,sortOrder:2})
const cat=seed.category('followup-s06');let seq=0
const mk=(name,price)=>{const p=seed.product(`S06-${++seq}-${name}`,cat),id=seed.variant(p,`S06-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,name,price}}
const line=v=>({variantId:v.id,qty:1,unitPrice:v.price,discount:0,tax:0})
const n=x=>Number(x??0),variants=[],credits=[],branches=[]
const expected={cash:0,card:0,refundCash:0,refundCard:0}
const raw=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) x FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) x FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return{cash:n(p.cash),card:n(p.card),refundCash:n(c.x),refundCard:n(r.x)}
}
const check=async(label)=>{
 const report=await salesService.reportRows({shiftId}),actual={cash:n(report.totals.cashTotal),card:n(report.totals.cardTotal),refundCash:n(report.totals.refundCashTotal),refundCard:n(report.totals.refundCardTotal)}
 assert.deepEqual(actual,expected,`${label}: report expected physical totals`);const independent=raw();assert.deepEqual(independent,actual,`${label}: raw docs equal report`)
 const blue=n(await physicalMovementForCustodyShift(shiftId)),blueExpected=expected.cash+expected.card-expected.refundCash-expected.refundCard;assert.equal(blue,blueExpected);assert.equal(independent.cash+independent.card-independent.refundCash-independent.refundCard,blue)
 const stock=variants.map(v=>{const actualStock=n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock),delta=n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',v.id).d);assert.equal(actualStock,10+delta);return{variant:v.name,actual:actualStock,ledgerDelta:delta}})
 const creditState=credits.map(c=>{const r=seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?',c.id);return{label:c.label,amount:n(r.amount),usedAmount:n(r.usedAmount),usedCount:n(r.usedCount),status:r.status,expiresAt:r.expiresAt,source:r.source}})
 return{label,expected:{...expected},actual,independent,blue,blueExpected,stock,credits:creditState}
}
await check('baseline')
async function issueSet(label,count,total){const set=[];if(!count)return set;for(let i=0;i<count;i++){const x=await storeCreditService.issueManual({amount:total/count,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD});const r=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',x.id);const c={id:n(r.id),code:r.code,label:`${label}-sale-code-${i+1}`};credits.push(c);set.push(c)}return set}
async function run({name,count,creditTotal,cashTender,cardTender,refundMethod}){
 const b={name,status:'PASS',count,creditTotal,cashTender,cardTender,refundMethod,events:[]}
 const root=mk(`${name}-root-A-1m`,1000000),rep=mk(`${name}-invoice2-replacement-B-800k`,800000);variants.push(root,rep)
 const codes=await issueSet(name,count,creditTotal);b.events.push(await check(`${name}: issue ${count} barcode(s)`))
 try{
  const sale=await salesService.create({userId,shiftId,lines:[line(root)],payments:[{methodId:cash,amount:cashTender,destination:'CASH'},{methodId:card,amount:cardTender,destination:'CARD'}],storeCredits:codes.map(c=>({code:c.code})),saleRequestIdempotencyKey:`s06-${name}-sale`})
  assert.equal(n(sale.grandTotal),1000000);assert.equal(n(sale.storeCreditApplied),creditTotal)
  expected.cash+=cashTender;expected.card+=cardTender;b.saleId=n(sale.id);b.events.push(await check(`${name}: source sale`))
  const rootItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
  const ex=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:n(rootItem.id),qty:1}],replacements:[line(rep)],refundMode:'STORE_CREDIT'})
  assert.equal(n(ex.diff),-200000);b.exchange1={returnId:n(ex.returnId),invoice2:n(ex.exchangeInvoiceId),diff:n(ex.diff),sourceCreditRestored:n(ex.sourceCreditRestoredAmount),newStoreCredit:n(ex.newStoreCreditAmount)}
  const invoice2=seed.one('SELECT id,sourceInvoiceId,exchangeReturnId,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',ex.exchangeInvoiceId)
  assert.equal(n(invoice2.sourceInvoiceId),n(sale.id));assert.equal(n(invoice2.grandTotal),800000);b.invoice2={id:n(invoice2.id),sourceInvoiceId:n(invoice2.sourceInvoiceId),grandTotal:n(invoice2.grandTotal),paidTotal:n(invoice2.paidTotal),status:invoice2.status}
  const firstCredits=seed.rows('SELECT id,code,amount,source,status,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id',ex.returnId)
  b.exchange1Credits=firstCredits.map(c=>({id:n(c.id),amount:n(c.amount),source:c.source,status:c.status,expiresAt:c.expiresAt}))
  b.events.push(await check(`${name}: exchange creates invoice 2`))
  const exchangeItem=seed.one('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=?',invoice2.id);assert.equal(n(exchangeItem.variantId),rep.id)
  const retInput={userId,shiftId,invoiceId:n(invoice2.id),full:false,lines:[{saleItemId:n(exchangeItem.id),qty:1}],refundMethod}
  if(refundMethod==='CASH'||refundMethod==='CARD'||refundMethod==='CARD_TO_CARD')retInput.refundAmount=800000
  if(refundMethod==='CARD')retInput.cardPosOverride={acknowledgedNoReverse:true,reason:`S06 ${name} POS return`,managerPassword:DEFAULT_MANAGER_PASSWORD}
  const ret=await salesService.createReturn(retInput)
  assert.equal(n(ret.total),800000);b.return2={id:n(ret.id),invoiceId:n(ret.invoiceId),total:n(ret.total),refundMethod:ret.refundMethod,refundAmount:n(ret.refundAmount),refundStoreCreditAmount:n(ret.refundStoreCreditAmount),sourceCreditRestored:n(ret.sourceCreditRestoredAmount),returnCredit:n(ret.returnCreditAmount)}
  if(refundMethod==='CASH'){assert.equal(n(ret.refundAmount),800000);expected.refundCash+=800000}
  if(refundMethod==='CARD'){assert.equal(n(ret.refundAmount),800000);expected.refundCard+=800000}
  if(refundMethod==='CARD_TO_CARD'){
   const req=seed.one('SELECT id,status,amount,operationKind,returnId FROM "CardTransferRequest" WHERE returnId=?',ret.id);assert.ok(req);assert.equal(req.status,'PENDING');assert.equal(n(req.amount),800000);b.transferPending={id:n(req.id),status:req.status,amount:n(req.amount),operationKind:req.operationKind}
   b.events.push(await check(`${name}: invoice-2 return C2C pending`))
   await cardTransferService.pay({id:n(req.id),paidAmount:800000,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`S06-${name}-RETURN-C2C`})
   const paid=seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?',req.id);assert.equal(paid.status,'PAID');assert.equal(n(paid.paidAmount),800000);b.transferPaid={status:paid.status,paidAmount:n(paid.paidAmount),paidMethod:paid.paidMethod,trackingNo:paid.trackingNo}
  }
  const successors=seed.rows('SELECT id,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id',ret.id)
  b.returnCredits=successors.map(c=>({id:n(c.id),amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,expiresAt:c.expiresAt,source:c.source}))
  if(refundMethod==='STORE_CREDIT')assert.equal(successors.reduce((s,c)=>s+n(c.amount),0),800000,'STORE_CREDIT return must produce 800k value')
  b.events.push(await check(`${name}: simple return of item printed on invoice 2 (${refundMethod})`))
  b.status='PASS'
 }catch(e){
  b.status='FAIL';b.failure={message:String(e?.message??e),stack:String(e?.stack??'')}
  try{b.events.push(await check(`${name}: post-error rollback`));b.rollbackVerified=true}catch(post){b.rollbackVerified=false;b.postError=String(post?.message??post)}
 }
 branches.push(b)
}
await run({name:'ZERO-CODE',count:0,creditTotal:0,cashTender:800000,cardTender:200000,refundMethod:'CASH'})
await run({name:'ONE-CODE',count:1,creditTotal:100000,cashTender:100000,cardTender:800000,refundMethod:'CARD'})
await run({name:'FOUR-CODES-C2C',count:4,creditTotal:100000,cashTender:450000,cardTender:450000,refundMethod:'CARD_TO_CARD'})
await run({name:'FOUR-CODES-STORE-CREDIT',count:4,creditTotal:100000,cashTender:450000,cardTender:450000,refundMethod:'STORE_CREDIT'})
const physicalRaw=raw(),blue=n(await physicalMovementForCustodyShift(shiftId)),blueExpected=expected.cash+expected.card-expected.refundCash-expected.refundCard
assert.deepEqual(physicalRaw,expected);assert.equal(blue,blueExpected)
const summary={generatedAt:new Date().toISOString(),independentScenario:5,status:branches.every(b=>b.status==='PASS')?'PASS':'FAIL',isolatedDatabase:process.env.HARNESS_DB,
 policy:{multipleFundingCounts:[0,1,4],saleOfGoodsThenExchangeInvoice2Return:true,returnModes:['CASH','CARD','CARD_TO_CARD','STORE_CREDIT']},physicalExpected:expected,physicalRaw,blue,blueExpected,branches}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario06-return-second-invoice-payment-matrix.json'),JSON.stringify(summary,null,2)+'\n')
const md=[`# سناریوی مستقل ۵ از ۱۰ — برگشت ساده از فاکتور دوم و چهار مسیر پرداخت`,``,`**نتیجه:** ${summary.status} (${branches.filter(b=>b.status==='PASS').length}/${branches.length} funding/settlement branches PASS).`,``,`## طراحی عددی`,`- همهٔ فاکتورهای ریشه ۱٬۰۰۰٬۰۰۰ ریال؛ تنوع منابع: صفر بارکد، یک بارکد ۱۰۰٬۰۰۰، یا چهار بارکدِ ۲۵٬۰۰۰. CASH و POS باقیمانده را تکمیل کردند.`,`- هر کالا با تعویض اول به B با قیمت ۸۰۰٬۰۰۰ رفت و فاکتور ۲ ساخته شد. سپس مشتری فاکتور ۲ را آورد و همان B را به‌صورت برگشت ساده، با هرکدام از چهار روش زیر، پس داد.`,``,`## نتیجه هر مسیر`,`| Funding در فروش | روش برگشت از فاکتور ۲ | مبلغ برگشت | وضعیت | Blue پس از مسیر | نتیجه/خطا |`,`|---|---|---:|---|---:|---|`,...branches.map(b=>`| ${b.name}: ${b.count} کد/${b.creditTotal} اعتبار | ${b.refundMethod} | ۸۰۰٬۰۰۰ | ${b.status} | ${b.events.at(-1)?.blue??'—'} | ${b.failure?.message??`invoice2=${b.invoice2?.id}؛ اسناد و stock تطبیق شد`} |`),``,`## تشریح پاسخ هر مسیر`,`- CASH: پول از CashMovement برگشت؛ blue به‌اندازهٔ ۸۰۰٬۰۰۰ کم شد.`,`- CARD: POS refund با تأیید تست مدیر ثبت شد؛ blue به‌اندازهٔ ۸۰۰٬۰۰۰ کم شد.`,`- CARD_TO_CARD: درخواست ۸۰۰٬۰۰۰ pending و سپس در هارنس مدیر-paid ثبت شد؛ انتقال بانکی واقعی انجام نشد و blue تغییر نکرد.`,`- STORE_CREDIT: اگر پذیرفته شد، ماندهٔ ۸۰۰٬۰۰۰ به اعتبار خرید تبدیل شد؛ blue تغییر نمی‌کند و اعتبار/انقضایش در JSON موجود است.`,``,`## جمع و سیاست`,`- نقد/POS دریافت‌شده: ${JSON.stringify({cash:expected.cash,card:expected.card})}; بازپرداخت نقد/POS: ${JSON.stringify({cash:expected.refundCash,card:expected.refundCard})}.`,`- مرجع آبی سرویس: ${blue}; independent raw: ${JSON.stringify(physicalRaw)}؛ انتظار نهایی ${blueExpected}.`,`- این سناریو مشخصاً برگشتِ کالای جایگزینِ درج‌شده در فاکتور دوم را آزمود. چهار شاخه باید هرکدام در JSON از نظر فروش، exchange invoice, return docs, credit state, stock, report and raw ledger بازبینی شوند. دیتابیس واقعی دست‌نخورده ماند.`]
writeFileSync(join(out,'deep-e2e-followup-scenario06-return-second-invoice-payment-matrix.md'),md.join('\n')+'\n')
console.log(`Scenario 5 ${summary.status}; branches=${branches.map(b=>`${b.name}:${b.status}`).join(', ')}; blue=${blue}`)
await db.$disconnect?.()
if(summary.status==='FAIL')process.exitCode=1
