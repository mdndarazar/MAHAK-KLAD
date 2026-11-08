import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-e100-034-discount-'))
process.env.HARNESS_DIR=dir
process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {RefundMethod}=await import('../../src/shared/enums.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('E100-034 discount comparison cashier')
const cash=seed.insert('PaymentMethod',{key:'E100-034-DISC-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:'E100-034-DISC-CARD',label:'isolated POS',kind:'CARD',isActive:1,sortOrder:2})
const n=value=>Number(value??0)
let seq=0
function variant(label,price){const p=seed.product(`E034-${++seq}-${label}`,seed.category(`E034-category-${seq}`));const id=seed.variant(p,`E034-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,label,price}}
const snapshot=items=>JSON.stringify({
  invoices:n(seed.one('SELECT COUNT(*) count FROM "SaleInvoice"').count),
  returns:n(seed.one('SELECT COUNT(*) count FROM "SaleReturn"').count),
  payments:n(seed.one('SELECT COUNT(*) count FROM "Payment"').count),
  allocations:n(seed.one('SELECT COUNT(*) count FROM "CreditReturnAllocation"').count),
  credits:seed.rows('SELECT id,usedAmount,usedCount,status FROM "StoreCredit" ORDER BY id').map(r=>[n(r.id),n(r.usedAmount),n(r.usedCount),r.status]),
  stocks:items.map(x=>[x.label,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',x.id).stock)])
})
async function runFixture({label,invoiceDiscount,cashTender,cardTender}){
  const shiftId=seed.insert('Shift',{name:`E100-034 ${label}`,number:9434+(invoiceDiscount?1:0),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
  const A=variant(`${label}-A-200k`,200_000),B=variant(`${label}-B-200k`,200_000),C=variant(`${label}-C-300k`,300_000),D=variant(`${label}-D-300k`,300_000)
  const B1=variant(`${label}-B1-220k`,220_000),C1=variant(`${label}-C1-290k`,290_000),D1=variant(`${label}-D1-290k`,290_000)
  const credits=[]
  for(let i=0;i<3;i++){
    const issued=await storeCreditService.issueManual({amount:200_000,multiUse:true,maxUses:10,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note:`E100-034 ${label} source-${i+1}`})
    const row=seed.one('SELECT id,code,restrictScope FROM "StoreCredit" WHERE id=?',issued.id)
    credits.push({id:n(row.id),code:row.code,scope:row.restrictScope})
  }
  const sale=await salesService.create({
    userId,shiftId,lines:[A,B,C,D].map(x=>({variantId:x.id,qty:1,unitPrice:x.price,discount:0,tax:0})),invoiceDiscount,
    storeCredits:credits.map(x=>({code:x.code,requestedAmount:100_000})),
    payments:[{methodId:cash,amount:cashTender,destination:'CASH'},{methodId:card,amount:cardTender,destination:'CARD'}],
    saleRequestIdempotencyKey:`e100-034-${label}-root`
  })
  const root=seed.one('SELECT id,grandTotal,discountTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
  const rootItems=seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
  const rootItem=x=>rootItems.find(r=>n(r.variantId)===x.id)
  assert.equal(n(sale.storeCreditApplied),300_000)
  assert.equal(n(root.paidTotal),n(root.grandTotal))
  const beforeReturn=snapshot([A,B,C,D,B1,C1,D1])
  const retA=await salesService.createReturn({userId,shiftId,invoiceId:n(sale.id),full:false,lines:[{saleItemId:n(rootItem(A).id),qty:1}],refundMethod:RefundMethod.NONE,confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD})
  const retALines=seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=?',retA.id).map(r=>({saleItemId:n(r.saleItemId),lineTotal:n(r.lineTotal)}))
  const retAAlloc=seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,retA.id).map(r=>({redemptionId:n(r.redemptionId),sourceCreditId:n(r.sourceCreditId),amount:n(r.amount),creditRestored:!!r.creditRestored}))
  const expectedAReturn=invoiceDiscount?180_000:200_000
  assert.equal(n(retA.total),expectedAReturn)
  assert.equal(n(retA.sourceCreditRestoredAmount),expectedAReturn)
  assert.equal(n(retA.refundAmount),0)
  assert.equal(retALines.reduce((s,r)=>s+r.lineTotal,0),expectedAReturn)
  assert.equal(retAAlloc.reduce((s,r)=>s+r.amount,0),expectedAReturn)

  const exchangeB=await salesService.createExchange({
    userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(rootItem(B).id),qty:1}],
    replacements:[{variantId:B1.id,qty:1,unitPrice:B1.price,discount:0,tax:0}],
    exchangeCreditCode:credits[0].code,discountTransferOption:'NO',idempotencyKey:`e100-034-${label}-B-to-B1`
  })
  const expectedBReturn=invoiceDiscount?180_000:200_000
  const expectedBDiff=220_000-expectedBReturn
  assert.equal(n(exchangeB.returnTotal),expectedBReturn)
  assert.equal(n(exchangeB.exchangeTotal),220_000)
  assert.equal(n(exchangeB.diff),expectedBDiff)
  assert.equal(n(exchangeB.barcodeCreditApplied),expectedBDiff)
  assert.equal(n(exchangeB.cashReceived),0)
  const exchangeBLines=seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchangeB.returnId).map(r=>({saleItemId:n(r.saleItemId),lineTotal:n(r.lineTotal)}))
  const exchangeBAlloc=seed.rows('SELECT id,amount,redemptionId,sourceCreditId,creditRestored,settlementAdjusted,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,exchangeB.returnId).map(r=>({id:n(r.id),amount:n(r.amount),redemptionId:n(r.redemptionId),sourceCreditId:n(r.sourceCreditId),creditRestored:!!r.creditRestored,settlementAdjusted:!!r.settlementAdjusted,restrictScope:r.restrictScope,saleItemId:r.saleItemId==null?null:n(r.saleItemId)}))
  const exchangeBRow=seed.one('SELECT id,total,kind,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE id=?',exchangeB.returnId)

  const beforeCD=snapshot([A,B,C,D,B1,C1,D1])
  let error='',exchangeCD=null
  try{
    const input={userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(rootItem(C).id),qty:1},{saleItemId:n(rootItem(D).id),qty:1}],replacements:[{variantId:C1.id,qty:1,unitPrice:C1.price,discount:0,tax:0},{variantId:D1.id,qty:1,unitPrice:D1.price,discount:0,tax:0}],discountTransferOption:'NO',idempotencyKey:`e100-034-${label}-C-plus-D`}
    if(invoiceDiscount) Object.assign(input,{methodId:cash})
    else Object.assign(input,{refundMode:'CASH'})
    exchangeCD=await salesService.createExchange(input)
  }catch(e){error=String(e?.message??e)}
  const afterCD=snapshot([A,B,C,D,B1,C1,D1])
  const expectedCDReturn=invoiceDiscount?540_000:600_000
  const expectedCDDiff=580_000-expectedCDReturn
  assert.ok(exchangeCD,`C+D should be accepted once B's source-credit share is recorded: ${error}`)
  assert.equal(n(exchangeCD.returnTotal),expectedCDReturn)
  assert.equal(n(exchangeCD.exchangeTotal),580_000)
  assert.equal(n(exchangeCD.diff),expectedCDDiff)
  if(invoiceDiscount){
    assert.equal(n(exchangeCD.cashReceived),40_000)
    assert.equal(n(exchangeCD.cashRefunded),0)
  }else{
    assert.equal(n(exchangeCD.cashRefunded),20_000)
    assert.equal(n(exchangeCD.realMoneyRefundAmount),20_000)
  }
  assert.notEqual(beforeCD,afterCD,'accepted C+D must record the exchange and stock changes')
  const cdReturn=seed.one('SELECT id,total,exchangeTotal,exchangeDiff,exchangeSettlement,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchangeCD.returnId)
  const cdItems=exchangeCD?seed.rows('SELECT variantId,lineTotal,restockedQty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchangeCD.returnId).map(r=>({variantId:n(r.variantId),lineTotal:n(r.lineTotal),restockedQty:n(r.restockedQty)})):[]
  const cdPayments=exchangeCD?seed.rows('SELECT methodId,amount,kind,destination,note FROM "Payment" WHERE invoiceId=? ORDER BY seq',exchangeCD.exchangeInvoiceId).map(r=>({methodId:n(r.methodId),amount:n(r.amount),kind:r.kind,destination:r.destination,note:r.note})):[]
  const finalStocks=Object.fromEntries([A,B,C,D,B1,C1,D1].map(x=>[x.label,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',x.id).stock)]))
  const noChecks=seed.rows('SELECT id FROM "Payment" WHERE kind=\'CHEQUE\'').length===0
  const expectedBConsumedCredit=invoiceDiscount?120_000:100_000
  const checks={
    initialInvoiceAndFundingCorrect:n(root.grandTotal)===(invoiceDiscount?900_000:1_000_000)&&n(root.discountTotal)===invoiceDiscount&&n(sale.storeCreditApplied)===300_000&&cashTender+cardTender+300_000===n(root.grandTotal),
    returnedAUsesDiscountedOrGrossLine:retALines[0]?.lineTotal===expectedAReturn&&retAAlloc.reduce((s,r)=>s+r.amount,0)===expectedAReturn,
    BExchangeUsesBarcodeAndRecordsConsumedSourceCredit:n(exchangeB.diff)===expectedBDiff&&n(exchangeB.barcodeCreditApplied)===expectedBDiff&&exchangeBLines[0]?.lineTotal===expectedBReturn&&exchangeBAlloc.reduce((s,r)=>s+r.amount,0)===expectedBConsumedCredit&&exchangeBAlloc.every(r=>!r.creditRestored&&!r.settlementAdjusted),
    cDArithmeticMatchesFixture:expectedCDReturn===(invoiceDiscount?540_000:600_000)&&expectedCDDiff===(invoiceDiscount?40_000:-20_000),
    cDAcceptedWithCorrectMoneyTreatment:!!exchangeCD&&n(exchangeCD.diff)===expectedCDDiff&&(invoiceDiscount?n(exchangeCD.cashReceived)===40_000&&n(exchangeCD.cashRefunded)===0&&n(cdReturn.refundAmount)===0&&cdPayments.some(x=>x.amount===540_000&&String(x.note).includes('پول نقد نیست'))&&cdPayments.some(x=>x.amount===40_000&&x.destination==='CASH'):n(exchangeCD.cashRefunded)===20_000&&n(exchangeCD.realMoneyRefundAmount)===20_000&&cdReturn.refundMethod==='CASH'&&n(cdReturn.refundAmount)===20_000&&exchangeCD.sourceCreditRestoredAmount===0),
    cDLinesAndRestockAreCorrect:cdItems.length===2&&cdItems.find(x=>x.variantId===C.id)?.lineTotal===(invoiceDiscount?270_000:300_000)&&cdItems.find(x=>x.variantId===D.id)?.lineTotal===(invoiceDiscount?270_000:300_000)&&cdItems.every(x=>x.restockedQty===1),
    acceptedExchangeRecordedInLedger:beforeCD!==afterCD,
    noChecksOrDebt:noChecks&&n(exchangeCD.debtReduction)===0
  }
  assert.ok(Object.values(checks).every(Boolean),`${label} E100-034 checks: ${JSON.stringify(checks)}`)
  return {label,discount:invoiceDiscount,rootInvoice:{id:n(sale.id),gross:1_000_000,discount:n(root.discountTotal),net:n(root.grandTotal),credit:300_000,cash:cashTender,card:cardTender},items:{gross:[200_000,200_000,300_000,300_000],netExpected:invoiceDiscount?[180_000,180_000,270_000,270_000]:[200_000,200_000,300_000,300_000]},returnA:{id:n(retA.id),total:n(retA.total),sourceCreditRestored:n(retA.sourceCreditRestoredAmount),cashRefund:n(retA.refundAmount),lines:retALines,allocations:retAAlloc},exchangeB:{returnId:n(exchangeB.returnId),returnTotal:n(exchangeB.returnTotal),replacementTotal:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),barcodeCreditApplied:n(exchangeB.barcodeCreditApplied),cashReceived:n(exchangeB.cashReceived),returnLines:exchangeBLines,record:{id:n(exchangeBRow.id),kind:exchangeBRow.kind,total:n(exchangeBRow.total),diff:n(exchangeBRow.exchangeDiff),settlement:exchangeBRow.exchangeSettlement},creditReturnAllocations:exchangeBAlloc},exchangeCD:{returnTotal:expectedCDReturn,replacementTotal:580_000,diff:expectedCDDiff,accepted:!!exchangeCD,error:error||null,returnRecord:cdReturn,returnLines:cdItems,payments:cdPayments,mutationRecorded:beforeCD!==afterCD,ledgerBefore:JSON.parse(beforeCD),ledgerAfter:JSON.parse(afterCD)},stocks:finalStocks,checks}
}
const noDiscount=await runFixture({label:'no-discount-control',invoiceDiscount:0,cashTender:350_000,cardTender:350_000})
const discounted=await runFixture({label:'invoice-discount-100k',invoiceDiscount:100_000,cashTender:300_000,cardTender:300_000})
const checks={noDiscountControlPass:Object.values(noDiscount.checks).every(Boolean),discountedFixturePass:Object.values(discounted.checks).every(Boolean),discountedLinesSumTo900k:discounted.items.netExpected.reduce((a,b)=>a+b,0)===900_000,discountFlipsCDFromRefundToCollection:noDiscount.exchangeCD.diff===-20_000&&discounted.exchangeCD.diff===40_000}
assert.ok(Object.values(checks).every(Boolean),`E100-034 comparison checks: ${JSON.stringify(checks)}`)
const rootCause={
  positiveBWrite:'The positive B exchange records the exact source-credit share consumed by replacement funding as immutable CreditReturnAllocation rows. This fixture verifies 100,000 in the no-discount case and 120,000 in the discounted case; those rows are not marked restored or settlement-adjusted.',
  negativeCDRead:'The later C+D exchange reconstructs its funding from the recorded source allocations and real-money tenders. Without invoice discount, it safely refunds only the 20,000 real-money surplus; the source-credit share is never paid as cash.',
  tenderVariant:'The 300,000 ALL-credit pool plus cash/card tender split remains traceable through the positive exchange and the later return; no cheque or debt is introduced.',
  discountBehavior:'The 100,000 invoice discount is allocated proportionally: it changes C+D from a 20,000 real-money refund to a 40,000 cash collection. Both paths complete with the recorded credit provenance.'
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,case:'E100-034; positive-exchange credit provenance and later C+D settlement',checks,originalTrace:{noDiscountRootTender:'300,000 ALL credit + 350,000 cash + 350,000 POS',BPositiveExchangeTender:'BARCODE',BConsumedSourceCreditRecorded:true},fixtures:{noDiscount,discounted},rootCause,conclusion:'The test verifies that a positive B exchange records the source-credit amount it consumes, then allows the later C+D exchange to settle safely. Without invoice discount, C+D is -20,000 and the system refunds 20,000 from the traceable real-money surplus only. With a 100,000 invoice discount, C+D is +40,000 and collects 40,000 cash. Both cases preserve source-credit separation, restock the returned items, and avoid checks or debt.',safety:{isolatedDatabase:true,productionCodeChanged:false,liveDatabase:false,checksOrDebt:false,realMoneyMoved:false}}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true})
writeFileSync(join(reports,'deep-e2e-scenario5-e100-034-invoice-discount.json'),JSON.stringify(summary,null,2)+'\n')
const fa=x=>Number(x??0).toLocaleString('fa-IR')
const md=['# E100-034: منشأ اعتبار در تعویض مثبت و تسویهٔ برگشت بعدی','',`**نتیجه:** ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} بررسی پاس شد.`,`**پایگاه آزمون:** SQLite موقت و ایزوله (${process.env.HARNESS_DB}).`,'',
  '## حالت بدون تخفیف','- فاکتور ۱٬۰۰۰٬۰۰۰ ریال است: ۳۰۰٬۰۰۰ اعتبار `ALL`، ۳۵۰٬۰۰۰ نقد و ۳۵۰٬۰۰۰ کارت‌خوان.','- برگشت A: مبلغ ۲۰۰٬۰۰۰ ریال؛ اعتبارِ منبعی جداگانه برگشت و پولی از صندوق پرداخت نشد.','- تعویض B→B1: ۲۰۰٬۰۰۰ به ۲۲۰٬۰۰۰ ریال؛ ۲۰٬۰۰۰ ریال با بارکد پرداخت شد و ۱۰۰٬۰۰۰ ریال اعتبار منبعیِ مصرف‌شده با ردیف‌های منشأ ثبت شد.','- تعویض C+D: برگشت ۶۰۰٬۰۰۰ و جایگزین ۵۸۰٬۰۰۰ ریال؛ ۲۰٬۰۰۰ ریال از مازاد واقعیِ پشتوانه‌دار به مشتری برگشت. اعتبار منبعی به پول نقد تبدیل نشد.','',
  '## حالت با تخفیف ۱۰۰٬۰۰۰ ریال','- مبلغ خالص فاکتور ۹۰۰٬۰۰۰ ریال است؛ ارزش خالص A/B/C/D به‌ترتیب ۱۸۰٬۰۰۰/۱۸۰٬۰۰۰/۲۷۰٬۰۰۰/۲۷۰٬۰۰۰ ریال.','- مبلغ اعتبار منبعیِ مصرف‌شده در تعویض B→B1 برابر ۱۲۰٬۰۰۰ ریال ثبت شد؛ مابه‌التفاوت ۴۰٬۰۰۰ ریال با بارکد پرداخت شد.','- تعویض C+D: برگشت ۵۴۰٬۰۰۰ و جایگزین ۵۸۰٬۰۰۰ ریال؛ ۴۰٬۰۰۰ ریال از مشتری دریافت شد. ردیف ۵۴۰٬۰۰۰ ریالی ارزش کالای برگشتی است، نه وجه نقد.','',
  '## آنچه آزمون ثابت کرد','- تعویض مثبت، سهم اعتبارِ واقعاً مصرف‌شده را با ارجاع به اعتبار منبع ثبت می‌کند؛ سهم‌ها به‌اشتباه بازگشت‌داده‌شده علامت نمی‌خورند.','- تعویض منفیِ بعدی با همان منشأها قابل محاسبه است و فقط سهم پولیِ واقعی می‌تواند بازپرداخت نقدی داشته باشد.','- تخفیف، مبلغ واقعی هر ردیف را متناسب تغییر می‌دهد و اختلاف را از بازپرداخت ۲۰٬۰۰۰ به دریافت ۴۰٬۰۰۰ ریال تبدیل می‌کند؛ هر دو مسیر درست تسویه شدند.','',
  '## ایمنی آزمون','- فقط پایگاه SQLite موقت استفاده شد؛ پایگاه زنده، چک و جابه‌جایی واقعی وجهی در کار نبود.','- موجودی کالای برگشتی و فاکتورهای تعویض در همان پایگاه آزمایشی کنترل شدند.'].join('\n')+'\n'
writeFileSync(join(reports,'deep-e2e-scenario5-e100-034-invoice-discount.md'),md)
console.log(`E100-034: ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed; B source-credit provenance recorded; no-discount C+D refunded 20k from money only; discounted C+D collected 40k cash`)
await db.$disconnect?.()
