/**
 * Independent scenario 4 of 10. Compare zero/one/four barcode purchases,
 * exercise all return settlement channels over the second-invoice chain, and
 * spend a no-expiry barcode as a positive exchange difference. Isolated SQLite.
 */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-s05-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up zero-one-four credit cashier')
const shiftId=seed.insert('Shift',{name:'follow-up credit-count + second exchange',number:6,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F05-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:'F05-CARD',label:'POS test',kind:'CARD',isActive:1,sortOrder:2})
const category=seed.category('followup-s05');let seq=0
const variant=(name,price)=>{const p=seed.product(`S05-${++seq}-${name}`,category),id=seed.variant(p,`S05-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,name,price}}
const line=v=>({variantId:v.id,qty:1,unitPrice:v.price,discount:0,tax:0})
const asNum=x=>Number(x??0),products=[],credits=[],allBranches=[]
const expected={cash:0,card:0,refundCash:0,refundCard:0}
const raw=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) v FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) v FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return{cash:asNum(p.cash),card:asNum(p.card),refundCash:asNum(c.v),refundCard:asNum(r.v)}
}
const checkpoint=async(label)=>{
 const report=await salesService.reportRows({shiftId});const actual={cash:asNum(report.totals.cashTotal),card:asNum(report.totals.cardTotal),refundCash:asNum(report.totals.refundCashTotal),refundCard:asNum(report.totals.refundCardTotal)}
 assert.deepEqual(actual,expected,`${label}: report equals expected`);const independent=raw();assert.deepEqual(independent,actual,`${label}: raw sources equal service report`)
 const blue=asNum(await physicalMovementForCustodyShift(shiftId));const expectedBlue=expected.cash+expected.card-expected.refundCash-expected.refundCard
 assert.equal(blue,expectedBlue,`${label}: blue`);assert.equal(independent.cash+independent.card-independent.refundCash-independent.refundCard,blue)
 const stocks=products.map(p=>{const actualStock=asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',p.id).stock),movement=asNum(seed.one('SELECT COALESCE(SUM(delta),0) v FROM "StockMovement" WHERE variantId=?',p.id).v);assert.equal(actualStock,10+movement,`${label}: stock ledger ${p.name}`);return{variant:p.name,actual:actualStock,ledgerDelta:movement}})
 const creditSnapshot=credits.map(c=>{const r=seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?',c.id);return{label:c.label,amount:asNum(r.amount),usedAmount:asNum(r.usedAmount),usedCount:asNum(r.usedCount),status:r.status,expiresAt:r.expiresAt,source:r.source}})
 return{label,expected:{...expected},actual,independent,blue,expectedBlue,stocks,credits:creditSnapshot}
}
await checkpoint('baseline')
async function makeCodes(label,count,total){
 const arr=[];if(count===0)return arr
 const each=total/count
 for(let i=0;i<count;i++){
  const issued=await storeCreditService.issueManual({amount:each,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD})
  const r=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',issued.id);const x={id:asNum(r.id),code:r.code,label:`${label}-barcode-${i+1}`};credits.push(x);arr.push(x)
 }
 return arr
}
async function runBranch({name,codeCount,creditTotal,cashTender,cardTender,firstMode,secondMode,exchangeUp=false}){
 const b={name,status:'PASS',codeCount,creditTotal,cashTender,cardTender,firstMode,secondMode,events:[]}
 const root=variant(`${name}-root-A-1m`,1000000),rep1=variant(`${name}-B-800k`,800000),rep2=variant(`${name}-C-${exchangeUp?'900k':'700k'}`,exchangeUp?900000:700000)
 products.push(root,rep1,rep2)
 const saleCodes=await makeCodes(name,codeCount,creditTotal)
 b.events.push(await checkpoint(`${name}: issued ${codeCount} sale barcodes`))
 try{
  const sale=await salesService.create({userId,shiftId,lines:[line(root)],payments:[{methodId:cash,amount:cashTender,destination:'CASH'},{methodId:card,amount:cardTender,destination:'CARD'}],storeCredits:saleCodes.map(x=>({code:x.code})),saleRequestIdempotencyKey:`s05-${name}-sale`})
  b.saleId=asNum(sale.id);assert.equal(asNum(sale.grandTotal),1000000);assert.equal(asNum(sale.storeCreditApplied),creditTotal)
  expected.cash+=cashTender;expected.card+=cardTender;b.events.push(await checkpoint(`${name}: source sale`))
  const rootItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
  const ex1=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:asNum(rootItem.id),qty:1}],replacements:[line(rep1)],refundMode:firstMode,
   ...(firstMode==='CARD'?{cardPosOverride:{acknowledgedNoReverse:true,reason:`S05 ${name} POS refund`,managerPassword:DEFAULT_MANAGER_PASSWORD}}:{})})
  b.exchange1={returnId:asNum(ex1.returnId),invoiceId:asNum(ex1.exchangeInvoiceId),diff:asNum(ex1.diff),realMoneyRefundAmount:asNum(ex1.realMoneyRefundAmount),sourceCreditRestoredAmount:asNum(ex1.sourceCreditRestoredAmount),cashRefunded:asNum(ex1.cashRefunded),cardRefunded:asNum(ex1.cardRefunded),newStoreCreditAmount:asNum(ex1.newStoreCreditAmount)}
  assert.equal(asNum(ex1.diff),-200000);assert.ok(ex1.exchangeInvoiceId)
  if(firstMode==='CASH'){assert.equal(asNum(ex1.cashRefunded),codeCount===0?200000:100000);expected.refundCash+=asNum(ex1.cashRefunded)}
  if(firstMode==='CARD'){assert.equal(asNum(ex1.cardRefunded),100000);expected.refundCard+=100000}
  const invoice2=seed.one('SELECT id,sourceInvoiceId,exchangeReturnId,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',ex1.exchangeInvoiceId)
  assert.equal(asNum(invoice2.sourceInvoiceId),asNum(sale.id));b.invoice2={id:asNum(invoice2.id),sourceInvoiceId:asNum(invoice2.sourceInvoiceId),grandTotal:asNum(invoice2.grandTotal),paidTotal:asNum(invoice2.paidTotal)}
  const ex1Credit=seed.rows('SELECT id,code,amount,source,status,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id',ex1.returnId)
  b.exchange1Credits=ex1Credit.map(c=>({id:asNum(c.id),code:c.code,amount:asNum(c.amount),source:c.source,status:c.status,expiresAt:c.expiresAt}))
  if(firstMode==='CARD_TO_CARD'){
   const req=seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?',ex1.returnId);assert.ok(req);assert.equal(req.status,'PENDING');assert.equal(asNum(req.amount),100000)
   b.cardTransferBefore={id:asNum(req.id),status:req.status,amount:asNum(req.amount)}
   b.events.push(await checkpoint(`${name}: first exchange C2C request pending`))
   await cardTransferService.pay({id:asNum(req.id),paidAmount:100000,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`S05-${name}-C2C`})
   const paid=seed.one('SELECT status,paidAmount,paidMethod FROM "CardTransferRequest" WHERE id=?',req.id);assert.equal(paid.status,'PAID');assert.equal(asNum(paid.paidAmount),100000);b.cardTransferAfter={status:paid.status,paidAmount:asNum(paid.paidAmount),paidMethod:paid.paidMethod}
  }
  b.events.push(await checkpoint(`${name}: first exchange ${firstMode}`))
  const item2=seed.one('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=?',invoice2.id);assert.equal(asNum(item2.variantId),rep1.id)
  let ex2
  if(exchangeUp){
   // The no-expiry $100k credit created from real money in the first STORE_CREDIT settlement pays the positive difference.
   const usable=ex1Credit.find(c=>c.source==='EXCHANGE'&&asNum(c.amount)===100000)
   assert.ok(usable,'first exchange must create the no-expiry 100k real-money barcode')
   ex2=await salesService.createExchange({userId,shiftId,invoiceId:asNum(invoice2.id),lines:[{saleItemId:asNum(item2.id),qty:1}],replacements:[line(rep2)],exchangeCreditCode:usable.code,idempotencyKey:`s05-${name}-positive-ex2`})
   assert.equal(asNum(ex2.diff),100000);assert.equal(asNum(ex2.barcodeCreditApplied),100000);assert.equal(asNum(ex2.cashReceived),0);assert.equal(asNum(ex2.cardReceived),0)
   const used=seed.one('SELECT usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?',usable.id);assert.equal(asNum(used.usedAmount),100000);assert.equal(used.status,'USED');b.exchangeDifferenceCredit={amount:100000,usedAmount:asNum(used.usedAmount),usedCount:asNum(used.usedCount),status:used.status,expiresAt:usable.expiresAt}
  }else{
   const input={userId,shiftId,invoiceId:asNum(invoice2.id),lines:[{saleItemId:asNum(item2.id),qty:1}],replacements:[line(rep2)],refundMode:secondMode}
   if(secondMode==='CARD')input.cardPosOverride={acknowledgedNoReverse:true,reason:`S05 ${name} second-generation POS refund`,managerPassword:DEFAULT_MANAGER_PASSWORD}
   ex2=await salesService.createExchange(input)
   assert.equal(asNum(ex2.diff),-100000)
   if(secondMode==='CASH'){assert.equal(asNum(ex2.cashRefunded),100000);expected.refundCash+=100000}
   if(secondMode==='CARD'){assert.equal(asNum(ex2.cardRefunded),100000);expected.refundCard+=100000}
   if(secondMode==='CARD_TO_CARD'){
    const req=seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?',ex2.returnId);assert.ok(req);assert.equal(req.status,'PENDING');assert.equal(asNum(req.amount),100000)
    await cardTransferService.pay({id:asNum(req.id),paidAmount:100000,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`S05-${name}-C2C-2`})
   }
  }
  b.exchange2={returnId:asNum(ex2.returnId),invoiceId:asNum(ex2.exchangeInvoiceId),diff:asNum(ex2.diff),sourceInvoiceId:asNum(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?',ex2.exchangeInvoiceId).sourceInvoiceId),cashRefunded:asNum(ex2.cashRefunded),cardRefunded:asNum(ex2.cardRefunded),cashReceived:asNum(ex2.cashReceived),cardReceived:asNum(ex2.cardReceived),barcodeCreditApplied:asNum(ex2.barcodeCreditApplied),sourceCreditRestoredAmount:asNum(ex2.sourceCreditRestoredAmount),newStoreCreditAmount:asNum(ex2.newStoreCreditAmount)}
  assert.equal(b.exchange2.sourceInvoiceId,asNum(invoice2.id),'generation-three invoice points to customer-presented invoice 2')
  b.events.push(await checkpoint(`${name}: second operation from invoice 2 using ${exchangeUp?'barcode credit positive difference':secondMode}`))
  b.status='PASS'
 }catch(e){
  b.status='FAIL';b.failure={message:String(e?.message??e),stack:String(e?.stack??'')}
  try{b.events.push(await checkpoint(`${name}: post-error rollback`));b.rollbackVerified=true}catch(post){b.rollbackVerified=false;b.postError=String(post?.message??post)}
 }
 allBranches.push(b)
}
// In each root-sale configuration: total = 1M. zero codes => 500k cash + 500k POS;
// one code => 100k credit + 450k cash + 450k POS; four codes => 4×25k credit + same 900k physical.
await runBranch({name:'ZERO-CODE',codeCount:0,creditTotal:0,cashTender:500000,cardTender:500000,firstMode:'CASH',secondMode:'CARD'})
await runBranch({name:'ONE-CODE',codeCount:1,creditTotal:100000,cashTender:450000,cardTender:450000,firstMode:'CARD_TO_CARD',secondMode:'STORE_CREDIT'})
await runBranch({name:'FOUR-CODES',codeCount:4,creditTotal:100000,cashTender:450000,cardTender:450000,firstMode:'STORE_CREDIT',secondMode:null,exchangeUp:true})
const finalBlue=asNum(await physicalMovementForCustodyShift(shiftId));const finalRaw=raw();const finalExpectedBlue=expected.cash+expected.card-expected.refundCash-expected.refundCard
assert.deepEqual(finalRaw,expected);assert.equal(finalBlue,finalExpectedBlue)
const summary={generatedAt:new Date().toISOString(),independentScenario:4,status:allBranches.every(b=>b.status==='PASS')?'PASS':'FAIL',isolatedDatabase:process.env.HARNESS_DB,
 fundingVariations:['no barcode','one barcode','four barcodes'],settlementVariations:['CASH','CARD','CARD_TO_CARD','STORE_CREDIT'],positiveDifferenceBarcodeTest:true,
 physicalExpected:expected,physicalRaw:finalRaw,blueActual:finalBlue,blueExpected:finalExpectedBlue,branches:allBranches}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario05-credit-count-second-chain.json'),JSON.stringify(summary,null,2)+'\n')
const md=[`# سناریوی مستقل ۴ از ۱۰ — صفر/یک/چهار بارکد و تعویض نسل دوم`,``,`**نتیجه:** ${summary.status} (${allBranches.filter(b=>b.status==='PASS').length}/${allBranches.length} funding branches PASS).`,``,`## طراحی سناریو`,`- سه شاخهٔ خرید: بدون بارکد؛ یک بارکد ۱۰۰٬۰۰۰؛ چهار بارکد ۲۵٬۰۰۰.`,`- هر فاکتور خرید ۱٬۰۰۰٬۰۰۰ ریال. پرداخت‌ها به‌ترتیب: ۵۰۰٬۰۰۰ نقد + ۵۰۰٬۰۰۰ POS؛ یا ۱۰۰٬۰۰۰ اعتبار + ۴۵۰٬۰۰۰ نقد + ۴۵۰٬۰۰۰ POS.`,`- هر شاخه یک تعویض به فاکتور ۲ و عملیات بعدی روی همان فاکتور دوم دارد. روش‌های خروجی بین شاخه‌ها پوشش داده شدند: CASH، CARD، CARD_TO_CARD و STORE_CREDIT.`,``,`## نتیجهٔ هر شاخه`,`| خرید/اعتبار | عملیات ۱ | عملیات ۲ از فاکتور ۲ | وضعیت | نتیجه |`,`|---|---|---|---|---|`,...allBranches.map(b=>`| ${b.name}: ${b.codeCount} بارکد، ${b.creditTotal} اعتبار | ${b.firstMode} | ${b.exchangeUp?'مابه‌التفاوت مثبت با بارکد':b.secondMode} | ${b.status} | ${b.failure?.message??`فاکتور ۳ از فاکتور ۲ ساخته شد؛ اختلاف مرحله دوم ${b.exchange2?.diff??'—'}`} |`),``,`## شاخهٔ چهاربارکدی: مثال مبلغی`,`- خرید ۱٬۰۰۰٬۰۰۰ = ۴۵۰٬۰۰۰ نقد + ۴۵۰٬۰۰۰ POS + ۴×۲۵٬۰۰۰ اعتبار.`,`- تعویض اول: کالای ۱٬۰۰۰٬۰۰۰ به کالای ۸۰۰٬۰۰۰؛ STORE_CREDIT.`,`- تعویض از فاکتور ۲: کالای ۸۰۰٬۰۰۰ به ۹۰۰٬۰۰۰؛ اختلاف مثبت ۱۰۰٬۰۰۰ با بارکد بدون انقضای ساخته‌شده از پول واقعی در تعویض اول پرداخت شد.`,``,`## نتیجه نسبت به سیاست شما`,`مرجع آبیِ تجمیعی ${finalBlue} = دریافت نقدی ${expected.cash} + POS ${expected.card} − بازپرداخت نقدی ${expected.refundCash} − POS ${expected.refundCard}; اسناد خام نیز ${JSON.stringify(finalRaw)} را دادند. اعتبارها وارد blue نشدند.`,``,`جزئیات هر سند، هر بارکد، مانده/وضعیت، stock ledger و checkpointها در JSON ثبت شده است. کارت‌به‌کارت در این آزمون درخواست و ثبت پرداخت مدیر را شبیه‌سازی می‌کند؛ انتقال بانکی واقعی انجام نمی‌شود. دیتابیس واقعی تغییر نکرد.`]
writeFileSync(join(out,'deep-e2e-followup-scenario05-credit-count-second-chain.md'),md.join('\n')+'\n')
console.log(`Scenario 4 ${summary.status}; branches=${allBranches.map(b=>`${b.name}:${b.status}`).join(', ')}; blue=${finalBlue}`)
await db.$disconnect?.()
if(summary.status==='FAIL')process.exitCode=1
