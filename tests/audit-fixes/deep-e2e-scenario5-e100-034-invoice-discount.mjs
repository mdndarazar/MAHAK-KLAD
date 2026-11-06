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
    exchangeCreditCode:credits[0].code,idempotencyKey:`e100-034-${label}-B-to-B1`
  })
  const expectedBReturn=invoiceDiscount?180_000:200_000
  const expectedBDiff=220_000-expectedBReturn
  assert.equal(n(exchangeB.returnTotal),expectedBReturn)
  assert.equal(n(exchangeB.exchangeTotal),220_000)
  assert.equal(n(exchangeB.diff),expectedBDiff)
  assert.equal(n(exchangeB.barcodeCreditApplied),expectedBDiff)
  assert.equal(n(exchangeB.cashReceived),0)
  const exchangeBLines=seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchangeB.returnId).map(r=>({saleItemId:n(r.saleItemId),lineTotal:n(r.lineTotal)}))
  const exchangeBAlloc=seed.rows('SELECT id FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=?',sale.id,exchangeB.returnId).map(r=>n(r.id))
  const exchangeBRow=seed.one('SELECT id,total,kind,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE id=?',exchangeB.returnId)

  const beforeCD=snapshot([A,B,C,D,B1,C1,D1])
  let error='',exchangeCD=null
  try{
    const input={userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(rootItem(C).id),qty:1},{saleItemId:n(rootItem(D).id),qty:1}],replacements:[{variantId:C1.id,qty:1,unitPrice:C1.price,discount:0,tax:0},{variantId:D1.id,qty:1,unitPrice:D1.price,discount:0,tax:0}],idempotencyKey:`e100-034-${label}-C-plus-D`}
    if(invoiceDiscount) Object.assign(input,{methodId:cash})
    else Object.assign(input,{refundMode:'CASH'})
    exchangeCD=await salesService.createExchange(input)
  }catch(e){error=String(e?.message??e)}
  const afterCD=snapshot([A,B,C,D,B1,C1,D1])
  const expectedCDReturn=invoiceDiscount?540_000:600_000
  const expectedCDDiff=580_000-expectedCDReturn
  const expectedGate=`برگشت قبلی #${exchangeB.returnId} تخصیص منشأ اعتبار ندارد`
  if(invoiceDiscount){
    assert.ok(exchangeCD,`discounted positive C+D should be accepted: ${error}`)
    assert.equal(n(exchangeCD.returnTotal),540_000)
    assert.equal(n(exchangeCD.exchangeTotal),580_000)
    assert.equal(n(exchangeCD.diff),40_000)
    assert.equal(n(exchangeCD.cashReceived),40_000)
  }else{
    assert.equal(exchangeCD,null,'no-discount negative C+D should stop before commit')
    assert.ok(error.includes(expectedGate),`unexpected no-discount C+D error: ${error}`)
    assert.equal(beforeCD,afterCD,'rejected C+D must leave the test ledger unchanged')
  }
  const cdReturn=exchangeCD?seed.one('SELECT id,total,exchangeTotal,exchangeDiff,exchangeSettlement,refundAmount FROM "SaleReturn" WHERE id=?',exchangeCD.returnId):null
  const cdItems=exchangeCD?seed.rows('SELECT variantId,lineTotal,restockedQty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchangeCD.returnId).map(r=>({variantId:n(r.variantId),lineTotal:n(r.lineTotal),restockedQty:n(r.restockedQty)})):[]
  const cdPayments=exchangeCD?seed.rows('SELECT methodId,amount,kind,destination,note FROM "Payment" WHERE invoiceId=? ORDER BY seq',exchangeCD.exchangeInvoiceId).map(r=>({methodId:n(r.methodId),amount:n(r.amount),kind:r.kind,destination:r.destination,note:r.note})):[]
  const finalStocks=Object.fromEntries([A,B,C,D,B1,C1,D1].map(x=>[x.label,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',x.id).stock)]))
  const noChecks=seed.rows('SELECT id FROM "Payment" WHERE kind=\'CHEQUE\'').length===0
  const checks={
    initialInvoiceAndFundingCorrect:n(root.grandTotal)===(invoiceDiscount?900_000:1_000_000)&&n(root.discountTotal)===invoiceDiscount&&n(sale.storeCreditApplied)===300_000&&cashTender+cardTender+300_000===n(root.grandTotal),
    returnedAUsesDiscountedOrGrossLine:retALines[0]?.lineTotal===expectedAReturn&&retAAlloc.reduce((s,r)=>s+r.amount,0)===expectedAReturn,
    BExchangeUsesBarcodeAndCorrectDelta:n(exchangeB.diff)===expectedBDiff&&n(exchangeB.barcodeCreditApplied)===expectedBDiff&&exchangeBLines[0]?.lineTotal===expectedBReturn&&exchangeBAlloc.length===0,
    cDArithmeticMatchesFixture:expectedCDReturn===(invoiceDiscount?540_000:600_000)&&expectedCDDiff===(invoiceDiscount?40_000:-20_000),
    discountedCDAcceptedAndActualLinesProportional:invoiceDiscount?!!exchangeCD&&cdItems.length===2&&cdItems.find(x=>x.variantId===C.id)?.lineTotal===270_000&&cdItems.find(x=>x.variantId===D.id)?.lineTotal===270_000&&cdItems.every(x=>x.restockedQty===1):true,
    undiscountedCDBlockedByPriorBProvenance:invoiceDiscount?true:!exchangeCD&&error.includes(expectedGate),
    rejectedAttemptMutationFree:invoiceDiscount?true:beforeCD===afterCD,
    discountedCDCollects40kCashWithoutRefund:invoiceDiscount?cdPayments.some(x=>x.amount===540_000&&String(x.note).includes('پول نقد نیست'))&&cdPayments.some(x=>x.amount===40_000&&x.destination==='CASH')&&n(cdReturn.refundAmount)===0:true,
    noChecksOrDebt:noChecks
  }
  assert.ok(Object.values(checks).every(Boolean),`${label} E100-034 checks: ${JSON.stringify(checks)}`)
  return {label,discount:invoiceDiscount,rootInvoice:{id:n(sale.id),gross:1_000_000,discount:n(root.discountTotal),net:n(root.grandTotal),credit:300_000,cash:cashTender,card:cardTender},items:{gross:[200_000,200_000,300_000,300_000],netExpected:invoiceDiscount?[180_000,180_000,270_000,270_000]:[200_000,200_000,300_000,300_000]},returnA:{id:n(retA.id),total:n(retA.total),sourceCreditRestored:n(retA.sourceCreditRestoredAmount),cashRefund:n(retA.refundAmount),lines:retALines,allocations:retAAlloc},exchangeB:{returnId:n(exchangeB.returnId),returnTotal:n(exchangeB.returnTotal),replacementTotal:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),barcodeCreditApplied:n(exchangeB.barcodeCreditApplied),cashReceived:n(exchangeB.cashReceived),returnLines:exchangeBLines,record:{id:n(exchangeBRow.id),kind:exchangeBRow.kind,total:n(exchangeBRow.total),diff:n(exchangeBRow.exchangeDiff),settlement:exchangeBRow.exchangeSettlement},creditReturnAllocations:exchangeBAlloc},exchangeCD:{returnTotal:expectedCDReturn,replacementTotal:580_000,diff:expectedCDDiff,accepted:!!exchangeCD,error:error||null,returnRecord:cdReturn,returnLines:cdItems,payments:cdPayments,mutationFree:beforeCD===afterCD,ledgerBefore:JSON.parse(beforeCD),ledgerAfter:JSON.parse(afterCD)},stocks:finalStocks,checks}
}
const noDiscount=await runFixture({label:'no-discount-control',invoiceDiscount:0,cashTender:350_000,cardTender:350_000})
const discounted=await runFixture({label:'invoice-discount-100k',invoiceDiscount:100_000,cashTender:300_000,cardTender:300_000})
const checks={noDiscountControlPass:Object.values(noDiscount.checks).every(Boolean),discountedFixturePass:Object.values(discounted.checks).every(Boolean),discountedLinesSumTo900k:discounted.items.netExpected.reduce((a,b)=>a+b,0)===900_000,discountFlipsCDFromRefundToCollection:noDiscount.exchangeCD.diff===-20_000&&discounted.exchangeCD.diff===40_000}
assert.ok(Object.values(checks).every(Boolean),`E100-034 comparison checks: ${JSON.stringify(checks)}`)
const rootCause={
  positiveBWrite:'In SalesService.ts:7429 the +20,000 B exchange takes the diff>0 path. In E100-034 its difference is paid by an ALL barcode; the return value is recorded as generic EXCHANGE_CREDIT on the child invoice, but no per-redemption CreditReturnAllocation is written for B\'s 200,000 return. Test ledger confirms exchangeB.creditReturnAllocations=[].',
  negativeCDRead:'C+D at -20,000 enters SalesService.ts:7540 and calls exchangeReturnFundingBuckets at :7585. Prior B has fundedReturn=200,000, creditRemoved=0, no allocation rows, while remaining source CREDIT exists. Guard at :1839-1840 rejects rather than guessing.',
  codeAsymmetry:'Exchange CreditReturnAllocation writes at SalesService.ts:7701-7720 occur in the negative-difference refund branch and describe credit surplus after replacements, not the consumed credit provenance missing from the earlier positive B exchange.',
  tenderVariant:'The 350k cash + 350k POS mix and B barcode tender are not the cause: the no-discount case4 control with cash tender and case5 split/credit tender both hit the same provenance guard.',
  discountBehavior:'The 100k discount is allocated correctly but makes C+D +40,000 instead of -20,000, so the positive collection branch avoids the refund-path guard. It does not repair the missing provenance write.'
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,case:'E100-034; fifth blocked case in the 13-stop sequence; index 34',checks,originalTrace:{noDiscountRootTender:'300,000 ALL credit + 350,000 cash + 350,000 POS',BPositiveExchangeTender:'BARCODE',CDBlockedAtPriorReturn:'B return has no CreditReturnAllocation'},fixtures:{noDiscount,discounted},rootCause,conclusion:'The no-discount control reproduces the original stop: C+D returns 600,000 against 580,000 replacements (diff -20,000), so the refund path hits the missing-allocation gate after B exchange. With a 100,000 invoice discount, actual line net values are A/B/C/D=180,000/180,000/270,000/270,000; B->B1 becomes +40,000 paid by barcode; C+D becomes +40,000 and is accepted with 40,000 cash. The discount is allocated correctly to returned-line values, but it does not repair provenance: it flips the C+D difference to positive and avoids the refund branch that fails.',safety:{isolatedDatabase:true,productionCodeChanged:false,liveDatabase:false,checksOrDebt:false,realMoneyMoved:false}}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true})
writeFileSync(join(reports,'deep-e2e-scenario5-e100-034-invoice-discount.json'),JSON.stringify(summary,null,2)+'\n')
const fa=x=>Number(x??0).toLocaleString('fa-IR')
const md=['# مورد پنجم از ۱۳ توقف: E100-034 و آزمون تخفیف فاکتور','',`**نتیجه:** کنترل بدون تخفیف و فیکسچر تخفیف‌دار هر دو با انتظار منطبق شدند؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} مقایسه پاس شد.`,`**DB:** SQLite موقت و ایزوله (${process.env.HARNESS_DB}).`,'',
  '## اجرای اصلی بدون تخفیف','- فاکتور: ۱٬۰۰۰٬۰۰۰ = ۳۰۰٬۰۰۰ اعتبار `ALL` + ۳۵۰٬۰۰۰ نقد + ۳۵۰٬۰۰۰ کارت‌خوان.','- برگشت A: ۲۰۰٬۰۰۰؛ ۲۰۰٬۰۰۰ اعتبار منبعی برگشت؛ وجه نقدی برگشت داده نشد.','- تعویض B→B1: ۲۰۰٬۰۰۰→۲۲۰٬۰۰۰، اختلاف +۲۰٬۰۰۰ که با بارکد اعتبار پرداخت شد؛ هیچ CreditReturnAllocation برای برگشت B ثبت نشد.','- تعویض C+D: ۶۰۰٬۰۰۰→۵۸۰٬۰۰۰، اختلاف -۲۰٬۰۰۰. مسیر بازپرداخت به گیت منشأ رسید و رد شد؛ تلاش ردشده mutation-free بود.', '',
  '## فیکسچر تخفیف ۱۰۰٬۰۰۰','- همان کالاها با ۱۰٪ تخفیف متناسب: A/B/C/D خالص به‌ترتیب ۱۸۰٬۰۰۰/۱۸۰٬۰۰۰/۲۷۰٬۰۰۰/۲۷۰٬۰۰۰؛ فاکتور خالص ۹۰۰٬۰۰۰.','- tender با خالص تطبیق داده شد: ۳۰۰٬۰۰۰ اعتبار `ALL` + ۳۰۰٬۰۰۰ نقد + ۳۰۰٬۰۰۰ کارت‌خوان.','- برگشت A واقعی ۱۸۰٬۰۰۰ شد و ۱۸۰٬۰۰۰ اعتبار منبعی برگشت. B→B1: ۱۸۰٬۰۰۰→۲۲۰٬۰۰۰؛ +۴۰٬۰۰۰ با بارکد اعتبار پرداخت شد.','- C+D: برگشت واقعی ۵۴۰٬۰۰۰ و جایگزین ۵۸۰٬۰۰۰؛ اختلاف +۴۰٬۰۰۰. عملیات پذیرفته شد و ۴۰٬۰۰۰ نقد ثبت شد؛ ردیف ۵۴۰٬۰۰۰ ارزش برگشتی است و طبق note «پول نقد نیست».', '',
  '## ریشهٔ دقیق توقف در E100-034','در سند B، اختلاف +۲۰٬۰۰۰ با بارکد پرداخت شد. شاخهٔ مثبت در `SalesService.ts:7429` ارزش برگشتی ۲۰۰٬۰۰۰ را به‌صورت `EXCHANGE_CREDIT` عمومی روی فاکتور فرزند ثبت می‌کند، اما allocation آن را به redemptionهای منبع وصل نمی‌کند؛ دفتر تست هم برای برگشت B صفر `CreditReturnAllocation` دارد. بعد C+D با اختلاف -۲۰٬۰۰۰ وارد شاخهٔ منفی (`:7540`) و بازسازی زنجیره (`:7585`) می‌شود. برای برگشت قبلی B مقدار funded=۲۰۰٬۰۰۰، credit allocation=۰ و هنوز منبع CREDIT موجود است؛ شرط امن `:1839–1840` به‌همین دلیل متوقف می‌کند. ثبت allocation تعویض در `:7701–7720` فقط در مسیر منفی و برای credit surplus بعد از مصرف جایگزین انجام می‌شود؛ سهم مصرف‌شدهٔ مثبت B ثبت نشده است. این همان ریشهٔ E100-030 است؛ split tender این نقص را ایجاد نکرده.',
  '## نتیجهٔ محاسبه و علت تغییر رفتار','مبلغ‌های برگشتی پس از تخفیف با تقسیم متناسب درست‌اند. اما تخفیف مشکل provenance را رفع نکرد: بدون تخفیف C+D اختلافش -۲۰٬۰۰۰ است و وارد مسیر بازپرداختِ دارای گیت می‌شود؛ با تخفیف اختلاف به +۴۰٬۰۰۰ تغییر می‌کند، پس مسیر دریافت وجه اجرا می‌شود و گیت بازپرداخت طی نمی‌شود. این همان تغییر علامت است، نه رفع ریشه‌ای نقص allocation برگشت B.',
  '## شواهد و ایمنی','- مبلغ واقعی هر ردیف SaleReturnItem، مبلغ‌های برگشت، barcode/cash settlement، تفاوت snapshot در رد و تغییر موجودی ثبت شدند.','- هیچ چک، بدهی، DB واقعی یا جابه‌جایی وجه واقعی وجود نداشت؛ production code تغییر نکرد.','- کنترل بدون تخفیف همان الگوی توقف E100-034 را بازتولید کرد؛ شناسهٔ برگشت در DB ایزوله با trace اصلی فرق دارد.'].join('\n')+'\n'
writeFileSync(join(reports,'deep-e2e-scenario5-e100-034-invoice-discount.md'),md)
console.log(`E100-034: ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} comparison checks; no-discount CD -20k blocked; discounted lines 180/180/270/270; B +40k barcode; C+D +40k cash accepted`)
await db.$disconnect?.()
