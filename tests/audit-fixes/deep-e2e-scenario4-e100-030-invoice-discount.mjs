import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-030-discount-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('E100-030 isolated discount regression cashier')
const cash = seed.insert('PaymentMethod', { key: 'E100-030-DISC-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'E100-030 discounted fixture', number: 9430, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const n = value => Number(value ?? 0)
let seq=0
function variant(label,price) {
  const product=seed.product(`E030D-${++seq}-${label}`,seed.category(`E030D-category-${seq}`))
  const id=seed.variant(product,`E030D-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id)
  return {id,label,price}
}
const A=variant('A-root-200k',200_000), B=variant('B-root-200k',200_000), C=variant('C-root-300k',300_000), D=variant('D-root-300k',300_000)
const B1=variant('B1-220k',220_000), C1=variant('C1-290k',290_000), D1=variant('D1-290k',290_000)
const codes=[]
for(let i=1;i<=6;i++) {
  const issued=await storeCreditService.issueManual({amount:100_000,multiUse:true,maxUses:2,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note:`E100-030 discounted source-${i}`})
  const row=seed.one('SELECT id,code,amount,status,restrictScope,expiresAtJalali FROM "StoreCredit" WHERE id=?',issued.id)
  codes.push({id:n(row.id),code:row.code,amount:n(row.amount),scope:row.restrictScope,expiresAtJalali:row.expiresAtJalali})
}
assert.ok(codes.every(code=>code.scope==='ALL'))
const sale=await salesService.create({
  userId,shiftId,
  lines:[A,B,C,D].map(item=>({variantId:item.id,qty:1,unitPrice:item.price,discount:0,tax:0})),
  invoiceDiscount:100_000,
  storeCredits:codes.map(code=>({code:code.code,requestedAmount:50_000})),
  payments:[{methodId:cash,amount:600_000,destination:'CASH'}],
  saleRequestIdempotencyKey:'e100-030-discounted-root'
})
const rootInvoice=seed.one('SELECT id,grandTotal,discountTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
const rootItems=seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
const rootItem=item=>rootItems.find(row=>n(row.variantId)===item.id)
assert.equal(n(rootInvoice.grandTotal),900_000)
assert.equal(n(rootInvoice.discountTotal),100_000)
assert.equal(n(rootInvoice.paidTotal),900_000)
const beforeCredits=seed.rows('SELECT id,usedAmount,status FROM "StoreCredit" ORDER BY id').map(row=>({id:n(row.id),usedAmount:n(row.usedAmount),status:row.status}))

// E100-030's original first operation: return A, with its 10% allocated invoice discount.
const returnedA=await salesService.createReturn({
  userId,shiftId,invoiceId:n(sale.id),full:false,
  lines:[{saleItemId:n(rootItem(A).id),qty:1}],refundMethod:RefundMethod.NONE,
  confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD
})
assert.equal(n(returnedA.total),180_000)
assert.equal(n(returnedA.sourceCreditRestoredAmount),180_000)
assert.equal(n(returnedA.refundAmount),0)
const returnAAllocations=seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored,saleItemId FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,returnedA.id).map(row=>({redemptionId:n(row.redemptionId),sourceCreditId:n(row.sourceCreditId),amount:n(row.amount),creditRestored:!!row.creditRestored,saleItemId:row.saleItemId==null?null:n(row.saleItemId)}))
assert.equal(returnAAllocations.reduce((sum,row)=>sum+row.amount,0),180_000)

// Discount-adjusted B net value is 180k; replacing it for 220k must collect 40k, not 20k.
const exchangeB=await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),
  lines:[{saleItemId:n(rootItem(B).id),qty:1}],
  replacements:[{variantId:B1.id,qty:1,unitPrice:220_000,discount:0,tax:0}],
  methodId:cash,idempotencyKey:'e100-030-discounted-B-to-B1'
})
assert.equal(n(exchangeB.returnTotal),180_000)
assert.equal(n(exchangeB.exchangeTotal),220_000)
assert.equal(n(exchangeB.diff),40_000)
assert.equal(n(exchangeB.cashReceived),40_000)
const exchangeBReturn=seed.one('SELECT id,total,kind,exchangeDiff,refundMethod,refundAmount,exchangeSettlement FROM "SaleReturn" WHERE id=?',exchangeB.returnId)
const exchangeBAllocations=seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored,saleItemId FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,exchangeB.returnId).map(row=>({redemptionId:n(row.redemptionId),sourceCreditId:n(row.sourceCreditId),amount:n(row.amount),creditRestored:!!row.creditRestored,saleItemId:row.saleItemId==null?null:n(row.saleItemId)}))
assert.equal(exchangeBAllocations.length,0,'positive exchange consumed all returned funding; no source-credit surplus row was written')

const snapshot=()=>JSON.stringify({
  invoiceCount:n(seed.one('SELECT COUNT(*) count FROM "SaleInvoice"').count),
  returnCount:n(seed.one('SELECT COUNT(*) count FROM "SaleReturn"').count),
  paymentCount:n(seed.one('SELECT COUNT(*) count FROM "Payment"').count),
  allocationCount:n(seed.one('SELECT COUNT(*) count FROM "CreditReturnAllocation"').count),
  cashMovementCount:n(seed.one('SELECT COUNT(*) count FROM "CashMovement"').count),
  stocks:[A,B,C,D,B1,C1,D1].map(item=>[item.id,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',item.id).stock)]),
  credits:seed.rows('SELECT id,usedAmount,status FROM "StoreCredit" ORDER BY id').map(row=>[n(row.id),n(row.usedAmount),row.status])
})
const beforeAttempt=snapshot()
let failure=''
let exchangeCD=null
try {
  exchangeCD=await salesService.createExchange({
    userId,shiftId,invoiceId:n(sale.id),
    lines:[{saleItemId:n(rootItem(C).id),qty:1},{saleItemId:n(rootItem(D).id),qty:1}],
    replacements:[{variantId:C1.id,qty:1,unitPrice:C1.price,discount:0,tax:0},{variantId:D1.id,qty:1,unitPrice:D1.price,discount:0,tax:0}],
    methodId:cash,idempotencyKey:'e100-030-discounted-C-plus-D'
  })
} catch(error) { failure=String(error?.message??error) }
const afterAttempt=snapshot()
if(exchangeCD) {
  assert.equal(n(exchangeCD.returnTotal),540_000)
  assert.equal(n(exchangeCD.exchangeTotal),580_000)
  assert.equal(n(exchangeCD.diff),40_000)
  assert.equal(n(exchangeCD.cashReceived),40_000)
  assert.notEqual(afterAttempt,beforeAttempt,'accepted C+D exchange must create its normal documents/payment/stock changes')
} else {
  assert.ok(failure.includes(`برگشت قبلی #${exchangeB.returnId} تخصیص منشأ اعتبار ندارد`),`unexpected E100-030 discounted error: ${failure}`)
  assert.equal(afterAttempt,beforeAttempt,'rejected C+D exchange must be mutation-free')
}

const sourceCreditsAfter=seed.rows('SELECT id,amount,usedAmount,status,restrictScope,expiresAtJalali FROM "StoreCredit" ORDER BY id').map(row=>({id:n(row.id),amount:n(row.amount),usedAmount:n(row.usedAmount),status:row.status,scope:row.restrictScope,expiresAtJalali:row.expiresAtJalali}))
const exchangeCDReturn=exchangeCD?seed.one('SELECT id,total,kind,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchangeCD.returnId):null
const exchangeCDInvoice=exchangeCD?seed.one('SELECT id,grandTotal,paidTotal,status,orderType,sourceInvoiceId FROM "SaleInvoice" WHERE id=?',exchangeCD.exchangeInvoiceId):null
const exchangeCDPayments=exchangeCD?seed.rows('SELECT id,methodId,amount,kind,destination,storeCreditId,note FROM "Payment" WHERE invoiceId=? ORDER BY seq',exchangeCD.exchangeInvoiceId).map(row=>({id:n(row.id),methodId:n(row.methodId),amount:n(row.amount),kind:row.kind,destination:row.destination,storeCreditId:row.storeCreditId==null?null:n(row.storeCreditId),note:row.note})):[]
const grossGoods=rootItems.reduce((sum,row)=>sum+n(row.lineTotal),0)
const discountPerGrossUnit=n(rootInvoice.discountTotal)/grossGoods
const finalItems=rootItems.map(row=>{const grossLine=n(row.lineTotal);const allocatedDiscount=Math.round(grossLine*discountPerGrossUnit);return {saleItemId:n(row.id),variantId:n(row.variantId),grossLine,allocatedDiscount,netExpected:grossLine-allocatedDiscount}})
const actualReturnLines=returnId=>seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',returnId).map(row=>({saleItemId:n(row.saleItemId),lineTotal:n(row.lineTotal)}))
const returnALines=actualReturnLines(returnedA.id), exchangeBLines=actualReturnLines(exchangeB.returnId), exchangeCDLines=exchangeCD?actualReturnLines(exchangeCD.returnId):[]
const checks={
  invoiceNet900kAfter100kDiscount:n(rootInvoice.grandTotal)===900_000&&n(rootInvoice.discountTotal)===100_000,
  sixALLBarcodesApplied300kAndCash600k:n(sale.storeCreditApplied)===300_000&&n(rootInvoice.paidTotal)===900_000,
  proportionalNetLines180180270270:finalItems.map(row=>row.netExpected).join(',')==='180000,180000,270000,270000'&&finalItems.reduce((sum,row)=>sum+row.allocatedDiscount,0)===100_000&&finalItems.reduce((sum,row)=>sum+row.netExpected,0)===900_000,
  ActualReturnItemLinesMatchDiscountedValues:returnALines.find(row=>row.saleItemId===n(rootItem(A).id))?.lineTotal===180_000&&exchangeBLines.find(row=>row.saleItemId===n(rootItem(B).id))?.lineTotal===180_000&&(!exchangeCD||(exchangeCDLines.find(row=>row.saleItemId===n(rootItem(C).id))?.lineTotal===270_000&&exchangeCDLines.find(row=>row.saleItemId===n(rootItem(D).id))?.lineTotal===270_000)),
  AReturnUsesDiscounted180kAndCreditSource:returnAAllocations.reduce((sum,row)=>sum+row.amount,0)===180_000&&n(returnedA.total)===180_000,
  BExchangeUses180kNetAndCollects40k:n(exchangeB.returnTotal)===180_000&&n(exchangeB.diff)===40_000&&n(exchangeB.cashReceived)===40_000,
  BExchangeHasNoCreditSurplusAllocation:exchangeBAllocations.length===0,
  CDNetReturnWouldBe540kAndReplacement580k:finalItems.filter(row=>row.variantId===C.id||row.variantId===D.id).reduce((s,r)=>s+r.netExpected,0)===540_000&&C1.price+D1.price===580_000,
  CDOutcomeIsCorrectlyClassified:exchangeCD?(n(exchangeCD.returnTotal)===540_000&&n(exchangeCD.exchangeTotal)===580_000&&n(exchangeCD.diff)===40_000&&n(exchangeCD.cashReceived)===40_000):failure.includes('تخصیص منشأ اعتبار ندارد'),
  CDOutcomeMatchesMutationState:exchangeCD?afterAttempt!==beforeAttempt:afterAttempt===beforeAttempt,
  CDLedgerSeparates540kReturnValueFrom40kCash:!exchangeCD||(exchangeCDPayments.reduce((sum,row)=>sum+row.amount,0)===580_000&&exchangeCDPayments.some(row=>row.amount===540_000&&row.destination==null&&String(row.note).includes('پول نقد نیست'))&&exchangeCDPayments.some(row=>row.amount===40_000&&row.destination==='CASH')),
  CDReturnInvoiceAndInventoryPersist:!exchangeCD||(n(exchangeCDReturn.total)===540_000&&n(exchangeCDReturn.exchangeDiff)===40_000&&exchangeCDReturn.exchangeSettlement==='CASH'&&n(exchangeCDInvoice.grandTotal)===580_000&&n(exchangeCDInvoice.paidTotal)===580_000&&JSON.parse(afterAttempt).stocks[2][1]===10&&JSON.parse(afterAttempt).stocks[3][1]===10&&JSON.parse(afterAttempt).stocks[5][1]===9&&JSON.parse(afterAttempt).stocks[6][1]===9),
  noChecksOrDebt:seed.rows('SELECT id FROM "Payment" WHERE kind=\'CHEQUE\'').length===0
}
assert.ok(Object.values(checks).every(Boolean),`discounted E100-030 checks: ${JSON.stringify(checks)}`)
const summary={
  generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,verdict:exchangeCD?'C+D_ACCEPTED':'C+D_BLOCKED',checks,
  originalCaseReference:{blockedIndex:30,case:'E100-030',theFourthBlockedScenario:true,originalNoDiscountRun:'Root 1,000,000; 300,000 ALL credit + 700,000 cash; A return then B->B1 positive exchange; C+D return=600,000 versus replacements=580,000 (diff=-20,000), so the negative/refund branch hit the prior-return source-allocation gate.'},
  discountFixture:{grossGoods:1_000_000,invoiceDiscount:100_000,netInvoice:900_000,creditTender:300_000,cashTender:600_000,barcodeCount:6,eachRedeemed:50_000,scope:'ALL'},
  discountedLineValues:finalItems,
  acceptedOperations:{rootInvoice:n(sale.id),rootSettled:rootInvoice.settledAt!=null,returnA:{id:n(returnedA.id),total:n(returnedA.total),sourceCreditRestored:n(returnedA.sourceCreditRestoredAmount),cashRefund:n(returnedA.refundAmount),returnLines:returnALines,allocations:returnAAllocations},exchangeB:{returnId:n(exchangeB.returnId),exchangeInvoiceId:n(exchangeB.exchangeInvoiceId),returnTotal:n(exchangeB.returnTotal),replacementTotal:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),cashReceived:n(exchangeB.cashReceived),returnLines:exchangeBLines,returnRecord:{id:n(exchangeBReturn.id),kind:exchangeBReturn.kind,settlement:exchangeBReturn.exchangeSettlement},creditAllocations:exchangeBAllocations},...(exchangeCD?{exchangeCD:{returnId:n(exchangeCD.returnId),exchangeInvoiceId:n(exchangeCD.exchangeInvoiceId),returnTotal:n(exchangeCD.returnTotal),replacementTotal:n(exchangeCD.exchangeTotal),diff:n(exchangeCD.diff),cashReceived:n(exchangeCD.cashReceived),returnRecord:{id:n(exchangeCDReturn.id),total:n(exchangeCDReturn.total),kind:exchangeCDReturn.kind,exchangeDiff:n(exchangeCDReturn.exchangeDiff),settlement:exchangeCDReturn.exchangeSettlement,refundAmount:n(exchangeCDReturn.refundAmount)},invoice:{id:n(exchangeCDInvoice.id),grandTotal:n(exchangeCDInvoice.grandTotal),paidTotal:n(exchangeCDInvoice.paidTotal),status:exchangeCDInvoice.status},payments:exchangeCDPayments,returnLines:exchangeCDLines,inventoryAfter:JSON.parse(afterAttempt).stocks}}:{})},
  attemptedOperation:{attempt:'exchange C+D together',accepted:!!exchangeCD,discountedReturnValue:540_000,replacementValue:580_000,expectedDifference:40_000,error:failure||null,mutationFree:beforeAttempt===afterAttempt},
  observedLedger:{preAttempt:JSON.parse(beforeAttempt),postAttempt:JSON.parse(afterAttempt),sourceCredits:sourceCreditsAfter},
  conclusion:exchangeCD?'With the 100,000 invoice discount, A/B/C/D net to 180,000/180,000/270,000/270,000. B->B1 correctly collects +40,000; C+D is also +40,000 and was accepted. Its ledger records 540,000 as returned-value tender (explicitly not cash) plus 40,000 actual cash; the replacement invoice is settled for 580,000. The no-discount C+D difference was -20,000, which took the negative/refund path and hit the source-allocation guard. The discount reduced the return value enough to flip the difference positive, so the positive/collection path ran instead; this is not a fix for the missing-allocation condition.':'The discounted item values are A/B/C/D = 180,000/180,000/270,000/270,000. B->B1 correctly collects +40,000, but C+D remains rejected at the prior-return source-allocation gate, with no mutation.',
  safety:{liveDatabase:false,productionCodeChanged:false,checksOrDebt:false,realMoneyMoved:false}
}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true})
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-invoice-discount.json'),JSON.stringify(summary,null,2)+'\n')
const fa=value=>Number(value??0).toLocaleString('fa-IR')
const md=[
  '# مورد چهارم از ۱۳ توقف: E100-030 با تخفیف فاکتور', '',
  `**نتیجه:** ${exchangeCD?'C+D_ACCEPTED':'C+D_BLOCKED'}؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checkpoint درست.`,
  `**DB:** SQLite موقت ایزوله (${process.env.HARNESS_DB}).`,
  '**شناسایی مورد:** مورد چهارم در ترتیب توقف‌های JSON، `E100-030` (index=30) است؛ نه E100-041.', '',
  '## سناریوی اصلی بدون تخفیف',
  'فاکتور چهار قلمی ۱٬۰۰۰٬۰۰۰ بود؛ ۶ بارکد عادی `ALL` جمعاً ۳۰۰٬۰۰۰ مصرف کردند و ۷۰۰٬۰۰۰ نقد پرداخت شد. برگشت A=۲۰۰٬۰۰۰ با روش NONE، ۲۰۰٬۰۰۰ سهم منبع اعتبار را برگرداند. سپس B=۲۰۰٬۰۰۰ با B1=۲۲۰٬۰۰۰ تعویض شد و ۲۰٬۰۰۰ نقد دریافت شد. در C+D، برگشت ۶۰۰٬۰۰۰ و جایگزین ۵۸۰٬۰۰۰ بود؛ پس اختلاف **-۲۰٬۰۰۰** شد و مسیر بازپرداخت (negative-diff) اجرا شد، اما با «برگشت قبلی #110 تخصیص منشأ اعتبار ندارد» متوقف شد. این ترتیب از JSON اجرای اصلی بازیابی شد.',
  'در شاخهٔ این خطا، کد تعویض فقط وقتی متوقف می‌شود که برگشت قبلی هنوز ارزش funded داشته باشد، allocation اعتباریِ ثبت‌شده نداشته باشد و در زنجیره منبع CREDIT باقی مانده باشد؛ چون سهم منبع را با حدس بازسازی نمی‌کند. شمارهٔ #110 شناسهٔ اجرای اصلی است.',
  '', 
  '## همان مورد با تخفیف ۱۰٪',
  '- قیمت ناخالص: A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ تخفیف کل ۱۰۰٬۰۰۰؛ فاکتور خالص ۹۰۰٬۰۰۰.',
  '- پرداخت: اعتبار `ALL` برابر ۳۰۰٬۰۰۰ (۶ کد × مصرف ۵۰٬۰۰۰) + نقد ۶۰۰٬۰۰۰.',
  '- ارزش خالص هر قلم پس از تخصیص متناسب تخفیف: A=۱۸۰٬۰۰۰، B=۱۸۰٬۰۰۰، C=۲۷۰٬۰۰۰، D=۲۷۰٬۰۰۰.',
  `- برگشت A به ${fa(returnedA.total)} ثبت شد و ${fa(returnedA.sourceCreditRestoredAmount)} اعتبار منبعی برگرداند؛ بازپرداخت وجه صفر بود.`,
  `- تعویض B: ارزش خالص برگشت ${fa(exchangeB.returnTotal)}، قیمت B1 برابر ${fa(exchangeB.exchangeTotal)}؛ پس اختلاف درست **+${fa(exchangeB.diff)}** است. مشتری ${fa(exchangeB.cashReceived)} نقد پرداخت کرد. بدون تخفیف اختلاف +۲۰٬۰۰۰ بود؛ تخفیف اختلاف را به +۴۰٬۰۰۰ تغییر داد، نه اینکه نادیده گرفته شود.`,
  `- تعویض C+D: ارزش خالص برگشت ${fa(540_000)} و جایگزین‌ها ${fa(580_000)}؛ اختلاف درست **+${fa(40_000)}** است. ${exchangeCD?`عملیات پذیرفته شد و ${fa(exchangeCD.cashReceived)} نقد دریافت شد.`:`عملیات رد شد: ${failure}`}`, '',
  '## تفاوت نتیجهٔ C+D با اجرای بدون تخفیف',
  exchangeCD
    ? `در اجرای بدون تخفیف، C+D با گیت تخصیص منشأ رد شده بود؛ اما با تخفیف ۱۰۰٬۰۰۰، همان تلاش پذیرفته شد. ثبت مالی: ردیف ۵۴۰٬۰۰۰ بابت ارزش برگشتی (در یادداشت سیستم تصریح شده «پول نقد نیست») و ردیف ۴۰٬۰۰۰ با مقصد صندوق CASH؛ invoice تعویض با جمع/پرداخت ۵۸۰٬۰۰۰ در وضعیت SETTLED ثبت شد. موجودی C و D هر کدام یک واحد برگشت و C1 و D1 هر کدام یک واحد کم شد؛ کدهای اعتبار پس از تعویض تغییر نکردند. بنابراین خطای اجرای اصلی را نمی‌توان به حالت تخفیف‌دار تعمیم داد.`
    : 'در هر دو اجرا C+D در گیت تخصیص منشأ رد شد. برگشت A دارای allocationهای اعتبار بود؛ تعویض B منبع برگشت را در جایگزین مصرف کرد و surplus اعتباری نداشت. دفترِ پیش/پس از تلاش C+D یکسان ماند.',
  'علت مستقیم تفاوت مسیر روشن است: بدون تخفیف، C+D اختلاف منفی ۲۰٬۰۰۰ داشت و وارد شاخهٔ بازپرداخت شد؛ همان شاخه برای بازسازی منشأ برگشت‌های قبلی گیت تخصیص را اجرا کرد و عملیات را امن رد کرد. با تخفیف، مبلغ برگشت C+D به ۵۴۰٬۰۰۰ افتاد و اختلاف به +۴۰٬۰۰۰ تغییر علامت داد؛ این بار مشتری باید پول اضافه می‌پرداخت، پس شاخهٔ دریافت وجه اجرا شد و گیت مخصوص بازپرداخت اصلاً طی نشد. بنابراین **تخفیف مشکل گیت را رفع نکرد**؛ فقط مبلغ خالص را عوض کرد و جریان را به شاخهٔ دیگری برد. برای علت هر رد دیگر، باید همان حالت و مبلغ جداگانه تست شود.',
  '',
  '## نتیجهٔ تخفیف و ایمنی',
  '- **محاسبهٔ تخفیف:** نسبت تخصیص ۱۰۰٬۰۰۰ تخفیف به چهار قلم و مبلغ واقعی SaleReturnItemها ۱۸۰/۱۸۰/۲۷۰/۲۷۰ assert شدند؛ اختلاف‌های B و C+D بر مبنای خالص به‌ترتیب +۴۰٬۰۰۰ و +۴۰٬۰۰۰ است.',
  exchangeCD?'- **رفتار زنجیره:** C+D پذیرفته شد؛ snapshot پیش/پس و سند/دریافت ۴۰٬۰۰۰ نقدی در JSON ثبت شده است.':'- **رفتار زنجیره:** C+D به‌صورت mutation-free رد شد؛ snapshot پیش/پس در JSON ثبت شده است.',
  '- هیچ چک، بدهی، stage، reset یا DB واقعی استفاده نشد؛ production code تغییر نکرد.',
  '- این یک اجرای branch نیست: runner جدید فقط جریان مستقل E100-030 را با `invoiceDiscount=100000` بازساخت تا اثر تخفیف سنجیده شود.'
]
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-invoice-discount.md'),md.join('\n')+'\n')
console.log(`E100-030 discounted scenario: ${exchangeCD?'C+D_ACCEPTED':'C+D_BLOCKED'}; ${Object.keys(checks).length}/${Object.keys(checks).length} checkpoints; net invoice=900k; item nets=180/180/270/270; B exchange +40k; C+D ${exchangeCD?'accepted for +40k cash':'safely rejected'}`)
await db.$disconnect?.()
