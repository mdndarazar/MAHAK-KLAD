/**
 * Independent scenario 3 of the follow-up campaign: four barcode tenders at sale,
 * then test CASH/CARD/CARD_TO_CARD/STORE_CREDIT exchange differences and an
 * EXCHANGE_CREDIT barcode applied to a positive difference. Temporary SQLite only.
 */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-s04-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up settlement matrix cashier')
const shiftId=seed.insert('Shift',{name:'follow-up multi-barcode settlement matrix',number:5,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F04-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:'F04-CARD',label:'POS test',kind:'CARD',isActive:1,sortOrder:2})
const category=seed.category('followup-s04')
let productSeq=0
const makeVariant=(name,price)=>{const p=seed.product(`S04-${++productSeq}-${name}`,category),id=seed.variant(p,`S04-${productSeq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,name,price}}
const line=v=>({variantId:v.id,qty:1,unitPrice:v.price,discount:0,tax:0})
const asNum=x=>Number(x??0)
const credits=[];const variants=[];const allInvoices=[];const branches=[]
const expected={cash:0,card:0,refundCash:0,refundCard:0}
const raw=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
 FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) value FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) value FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return{cash:asNum(p.cash),card:asNum(p.card),refundCash:asNum(c.value),refundCard:asNum(r.value)}
}
const assertCheckpoint=async(label)=>{
 const report=await salesService.reportRows({shiftId})
 const reported={cash:asNum(report.totals.cashTotal),card:asNum(report.totals.cardTotal),refundCash:asNum(report.totals.refundCashTotal),refundCard:asNum(report.totals.refundCardTotal)}
 assert.deepEqual(reported,expected,`${label}: service report equals expected physical flows`)
 const independent=raw();assert.deepEqual(independent,reported,`${label}: raw doc aggregation equals report`)
 const blue=asNum(await physicalMovementForCustodyShift(shiftId));const blueExpected=expected.cash+expected.card-expected.refundCash-expected.refundCard
 assert.equal(blue,blueExpected,`${label}: blue equals physical cash+POS net`)
 assert.equal(independent.cash+independent.card-independent.refundCash-independent.refundCard,blue)
 const stock=variants.map(v=>{const actual=asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock);const delta=asNum(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',v.id).d);assert.equal(actual,10+delta,`${label}: raw stock ledger ${v.name}`);return{variant:v.name,expected:10+delta,actual,ledgerDelta:delta}})
 const currentCredits=credits.map(c=>{const r=seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?',c.id);return{label:c.label,amount:asNum(r.amount),usedAmount:asNum(r.usedAmount),usedCount:asNum(r.usedCount),status:r.status,expiresAt:r.expiresAt,source:r.source}})
 return{label,expected:{...expected},reported,independent,blue,blueExpected,stock,credits:currentCredits}
}
const base=await assertCheckpoint('baseline')
const createBarcodeSet=async(label,eachAmount)=>{
 const set=[]
 for(let i=0;i<4;i++){
  const issued=await storeCreditService.issueManual({amount:eachAmount,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD})
  const r=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',issued.id)
  const credit={id:asNum(r.id),code:r.code,label:`${label}-code-${i+1}`};credits.push(credit);set.push(credit)
 }
 return set
}
async function downBranch(mode){
 const branch={mode,status:'PASS',saleAmount:1000000,barcodeTender:100000,cashTender:450000,cardTender:450000,exchangeReturned:1000000,replacement:800000,difference:-200000,events:[]}
 const source=makeVariant(`${mode}-source-1m`,1000000),replacement=makeVariant(`${mode}-replacement-800k`,800000);variants.push(source,replacement)
 const set=await createBarcodeSet(mode,25000)
 branch.events.push(await assertCheckpoint(`${mode}: four barcode fixtures issued`))
 try{
  const sale=await salesService.create({userId,shiftId,lines:[line(source)],payments:[{methodId:cash,amount:450000,destination:'CASH'},{methodId:card,amount:450000,destination:'CARD'}],storeCredits:set.map(x=>({code:x.code})),saleRequestIdempotencyKey:`s04-${mode}-sale`})
  branch.saleId=asNum(sale.id);allInvoices.push(asNum(sale.id));assert.equal(asNum(sale.grandTotal),1000000);assert.equal(asNum(sale.storeCreditApplied),100000)
  expected.cash+=450000;expected.card+=450000
  branch.events.push(await assertCheckpoint(`${mode}: sale 450k cash + 450k POS + 4×25k credit`))
  const sourceItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
  const input={userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:asNum(sourceItem.id),qty:1}],replacements:[line(replacement)],refundMode:mode}
  if(mode==='CARD')input.cardPosOverride={acknowledgedNoReverse:true,reason:'آزمون ایزوله بازپرداخت اختلاف به کارت',managerPassword:DEFAULT_MANAGER_PASSWORD}
  const ex=await salesService.createExchange(input)
  branch.returnId=asNum(ex.returnId);branch.exchangeInvoiceId=asNum(ex.exchangeInvoiceId);allInvoices.push(branch.exchangeInvoiceId)
  assert.equal(asNum(ex.diff),-200000);assert.equal(asNum(ex.realMoneyRefundAmount),100000);assert.equal(asNum(ex.sourceCreditRestoredAmount),100000)
  if(mode==='CASH'){assert.equal(asNum(ex.cashRefunded),100000);expected.refundCash+=100000}
  if(mode==='CARD'){assert.equal(asNum(ex.cardRefunded),100000);expected.refundCard+=100000}
  if(mode==='CARD_TO_CARD'){
   const req=seed.one('SELECT id,status,amount,returnId FROM "CardTransferRequest" WHERE returnId=?',ex.returnId)
   assert.ok(req,'C2C exchange creates a linked request')
   assert.equal(req.status,'PENDING');assert.equal(asNum(req.amount),100000)
   branch.transferBefore={id:asNum(req.id),status:req.status,amount:asNum(req.amount)}
  }
  branch.exchange={diff:asNum(ex.diff),realMoneyRefundAmount:asNum(ex.realMoneyRefundAmount),sourceCreditRestoredAmount:asNum(ex.sourceCreditRestoredAmount),cashRefunded:asNum(ex.cashRefunded),cardRefunded:asNum(ex.cardRefunded),newStoreCreditAmount:asNum(ex.newStoreCreditAmount),exchangeCreditRefundAmount:asNum(ex.exchangeCreditRefundAmount)}
  const returnRow=seed.one('SELECT refundMethod,refundAmount,refundStoreCreditAmount,exchangeSettlement,restockPending FROM "SaleReturn" WHERE id=?',ex.returnId)
  branch.returnDocument={refundMethod:returnRow.refundMethod,refundAmount:asNum(returnRow.refundAmount),refundStoreCreditAmount:asNum(returnRow.refundStoreCreditAmount),exchangeSettlement:returnRow.exchangeSettlement,restockPending:!!returnRow.restockPending}
  branch.events.push(await assertCheckpoint(`${mode}: exchange diff settlement`))
  if(mode==='CARD_TO_CARD'){
   const req=seed.one('SELECT id,status,amount,returnId FROM "CardTransferRequest" WHERE returnId=?',ex.returnId)
   assert.ok(req);assert.equal(req.status,'PENDING');assert.equal(asNum(req.amount),100000)
   branch.transferBefore={id:asNum(req.id),status:req.status,amount:asNum(req.amount)}
   branch.events.push(await assertCheckpoint('CARD_TO_CARD pending request; blue unchanged'))
   await cardTransferService.pay({id:asNum(req.id),paidAmount:100000,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`S04-${mode}-TRANSFER`})
   const paid=seed.one('SELECT status,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?',req.id)
   assert.equal(paid.status,'PAID');assert.equal(asNum(paid.paidAmount),100000)
   branch.transferAfter={status:paid.status,amount:asNum(paid.amount),paidAmount:asNum(paid.paidAmount),paidMethod:paid.paidMethod,trackingNo:paid.trackingNo}
   branch.events.push(await assertCheckpoint('CARD_TO_CARD manager-paid; physical blue unchanged'))
  }
  const generated=seed.rows('SELECT id,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id',ex.returnId)
  branch.generatedCredits=generated.map(x=>({id:asNum(x.id),amount:asNum(x.amount),usedAmount:asNum(x.usedAmount),status:x.status,expiresAt:x.expiresAt,source:x.source}))
  const expectedCreditTotal=mode==='STORE_CREDIT'?200000:100000
  assert.equal(generated.reduce((s,x)=>s+asNum(x.amount),0),expectedCreditTotal,`${mode}: source credit restored plus any real-money credit`)
  assert.ok(generated.every(x=>x.status==='ACTIVE'),`${mode}: generated/returned barcodes ACTIVE`)
  branch.status='PASS'
 }catch(error){
  branch.status='FAIL';branch.failure={message:String(error?.message??error),stack:String(error?.stack??'')}
  try{branch.events.push(await assertCheckpoint(`${mode}: post-error rollback`));branch.rollbackVerified=true}catch(post){branch.rollbackVerified=false;branch.postError=String(post?.message??post)}
 }
 branches.push(branch)
}
for(const mode of ['CASH','CARD','CARD_TO_CARD','STORE_CREDIT'])await downBranch(mode)

// Positive exchange difference: fund the new 200k difference with a fifth barcode,
// while the original sale itself was also paid by four distinct barcode tenders.
{
 const mode='EXCHANGE_CREDIT_TENDER'
 const branch={mode,status:'PASS',saleAmount:800000,cashTender:200000,cardTender:200000,barcodeTender:400000,difference:200000,exchangeCreditTender:200000,events:[]}
 const source=makeVariant('positive-source-800k',800000),replacement=makeVariant('positive-replacement-1m',1000000);variants.push(source,replacement)
 const saleCodes=await createBarcodeSet('positive-sale',100000)
 const differenceCode=(await storeCreditService.issueManual({amount:200000,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD}))
 const dc=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',differenceCode.id);const differenceCredit={id:asNum(dc.id),code:dc.code,label:'positive-exchange-difference-code'};credits.push(differenceCredit)
 branch.events.push(await assertCheckpoint('positive branch: 5 codes issued'))
 try{
  const sale=await salesService.create({userId,shiftId,lines:[line(source)],payments:[{methodId:cash,amount:200000,destination:'CASH'},{methodId:card,amount:200000,destination:'CARD'}],storeCredits:saleCodes.map(x=>({code:x.code})),saleRequestIdempotencyKey:'s04-positive-source-sale'})
  branch.saleId=asNum(sale.id);allInvoices.push(branch.saleId);assert.equal(asNum(sale.grandTotal),800000);assert.equal(asNum(sale.storeCreditApplied),400000)
  expected.cash+=200000;expected.card+=200000;branch.events.push(await assertCheckpoint('positive branch: sale 200k cash + 200k POS + 4×100k credit'))
  const item=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
  const ex=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:asNum(item.id),qty:1}],replacements:[line(replacement)],exchangeCreditCode:differenceCredit.code,idempotencyKey:'s04-positive-difference-credit'})
  assert.equal(asNum(ex.diff),200000);assert.equal(asNum(ex.barcodeCreditApplied),200000);assert.equal(asNum(ex.cashReceived),0);assert.equal(asNum(ex.cardReceived),0)
  branch.returnId=asNum(ex.returnId);branch.exchangeInvoiceId=asNum(ex.exchangeInvoiceId);allInvoices.push(branch.exchangeInvoiceId)
  const creditAfter=seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?',differenceCredit.id)
  assert.equal(asNum(creditAfter.usedAmount),200000);assert.equal(creditAfter.status,'USED')
  branch.exchange={diff:asNum(ex.diff),barcodeCreditApplied:asNum(ex.barcodeCreditApplied),cashReceived:asNum(ex.cashReceived),cardReceived:asNum(ex.cardReceived),differenceCredit:{amount:asNum(creditAfter.amount),usedAmount:asNum(creditAfter.usedAmount),usedCount:asNum(creditAfter.usedCount),status:creditAfter.status}}
  branch.events.push(await assertCheckpoint('positive difference settled by a distinct barcode credit'))
  branch.status='PASS'
 }catch(error){branch.status='FAIL';branch.failure={message:String(error?.message??error),stack:String(error?.stack??'')};try{branch.events.push(await assertCheckpoint('positive branch post-error rollback'));branch.rollbackVerified=true}catch(post){branch.rollbackVerified=false;branch.postError=String(post?.message??post)}}
 branches.push(branch)
}
const summary={generatedAt:new Date().toISOString(),independentScenario:3,status:branches.every(x=>x.status==='PASS')?'PASS':'FAIL',isolatedDatabase:process.env.HARNESS_DB,
 userPolicy:{storeCreditIsNonPhysical:true,blue:'cash received + POS received - cash refunds - POS refunds',creditTenderCount:4,settlementModesTested:['CASH','CARD','CARD_TO_CARD','STORE_CREDIT'],positiveExchangeCreditBarcode:true},
 physicalExpected:expected,physicalIndependent:raw(),blueActual:asNum(await physicalMovementForCustodyShift(shiftId)),branches,allInvoiceIds:allInvoices}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario04-multi-barcode-settlement-matrix.json'),JSON.stringify(summary,null,2)+'\n')
const md=[`# سناریوی مستقل ۳ از ۱۰ — چهار بارکد، چند tender، ماتریس تسویهٔ تعویض`,``,`**نتیجهٔ کل:** ${summary.status} · ${branches.filter(x=>x.status==='PASS').length}/${branches.length} شاخه PASS. دیتابیس SQLite موقت.`,``,`## مثال اصلی برای چهار شاخهٔ برگشت`,`- فاکتور فروش: ۱٬۰۰۰٬۰۰۰ ریال؛ پرداخت واقعی ۴۵۰٬۰۰۰ نقد + ۴۵۰٬۰۰۰ POS؛ چهار بارکدِ ۲۵٬۰۰۰ ریالی = ۱۰۰٬۰۰۰ اعتبار.`,`- کالای ۱٬۰۰۰٬۰۰۰ ریالی با کالای ۸۰۰٬۰۰۰ ریالی تعویض شد؛ اختلاف ۲۰۰٬۰۰۰ ریال. منابع مورد انتظار از سند خام: ۱۰۰٬۰۰۰ پول واقعی + ۱۰۰٬۰۰۰ منبع اعتباری؛ اعتبار به پول فیزیکی تبدیل نمی‌شود.`,`- چهار حالت جداگانه آزموده شد: CASH، CARD، CARD_TO_CARD، STORE_CREDIT.`,``,`## نتیجهٔ هر حالت`,`| مسیر | وضعیت | مبلغ فیزیکی تسویه | ماندهٔ اعتبار | نتیجه/خطا |`,`|---|---|---:|---:|---|`,...branches.map(b=>`| ${b.mode} | ${b.status} | ${b.exchange?.cashRefunded??0} نقد / ${b.exchange?.cardRefunded??0} POS / ${b.transferAfter?.paidAmount??0} کارت‌به‌کارت | ${b.generatedCredits?.reduce((s,x)=>s+x.amount,0)??b.exchange?.differenceCredit?.amount??0} | ${(b.failure?.message??'تطبیق شد').replaceAll('|','\\|')} |`),``,`## فاکتور مثبت با بارکد به‌عنوان مابه‌التفاوت`,`- فروش ۸۰۰٬۰۰۰: ۲۰۰٬۰۰۰ نقد + ۲۰۰٬۰۰۰ POS + چهار بارکد ۱۰۰٬۰۰۰.` ,`- تعویض به کالای ۱٬۰۰۰٬۰۰۰؛ اختلاف مثبت ۲۰۰٬۰۰۰ با یک بارکد جداگانهٔ ۲۰۰٬۰۰۰ تسویه شد؛ ماندهٔ همان بارکد صفر و وضعیت USED.` ,``,`## مرجع آبی و محدودیت‌ها`,`- انتظار تجمیعی فیزیکی: ${JSON.stringify(summary.physicalExpected)}; محاسبهٔ مستقل اسناد خام: ${JSON.stringify(summary.physicalIndependent)}; blue service: ${summary.blueActual}.`,`- تمام بارکدهای فروش و جانشین‌ها، مانده، تعداد مصرف، status و expiry در JSON ثبت شده‌اند؛ stock و StockMovement در هر checkpoint تطبیق شدند.`,`- CARD_TO_CARD «ثبت درخواست و ثبت پرداخت مدیر در هارنس» است؛ انتقال بانکی واقعی انجام نشده. کارت POS refund، manager override تست شده است.`,`- دیتابیس و دادهٔ فروشگاه واقعی تغییر نکردند.`]
writeFileSync(join(out,'deep-e2e-followup-scenario04-multi-barcode-settlement-matrix.md'),md.join('\n')+'\n')
console.log(`Scenario 3 ${summary.status}; branches=${branches.map(x=>`${x.mode}:${x.status}`).join(', ')}; blue=${summary.blueActual}`)
await db.$disconnect?.()
if(summary.status==='FAIL')process.exitCode=1
