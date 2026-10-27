import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discounted-invoice-mixed-credit-chain-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const { planReturnCreditSources } = await import('../../src/shared/returnCreditPolicy.ts')

const dirDb = process.env.HARNESS_DB
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('isolated discounted mixed tender exchange-chain cashier')
const cash = seed.insert('PaymentMethod', { key: 'DEC-MIX-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'discounted invoice mixed tender exchange chain', number: 9412, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const n = value => Number(value ?? 0)
let variantSeq = 0
function variant(label, price) {
  const product = seed.product(`DEC-MIX-${++variantSeq}-${label}`, seed.category(`DEC-MIX-cat-${variantSeq}`))
  const id = seed.variant(product, `DEC-MIX-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const items = [variant('original-A-10m',10_000_000), variant('original-B-10m',10_000_000), variant('replacement-A1-8.5m',8_500_000), variant('replacement-B1-9.5m',9_500_000)]
const [A,B,A1,B1] = items
const issued = await storeCreditService.issueManual({ amount: 2_000_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'isolated ALL credit for discounted invoice exchange chain' })
const sourceBefore = seed.one('SELECT id,code,amount,status,restrictScope,expiresAt,expiresAtJalali FROM "StoreCredit" WHERE id=?', issued.id)
const sale = await salesService.create({
  userId, shiftId,
  lines: [A,B].map(item=>({variantId:item.id,qty:1,unitPrice:item.price,discount:0,tax:0})),
  invoiceDiscount: 2_000_000,
  storeCredits: [{ code: sourceBefore.code, requestedAmount: 2_000_000 }],
  payments: [{ methodId: cash, amount: 16_000_000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 'discounted-mixed-credit-root-sale'
})
const rootItems = seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
const sourceItem = item => rootItems.find(row=>n(row.variantId)===item.id)
const rootInvoice = seed.one('SELECT grandTotal,discountTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
const sourceAfterSale = seed.one('SELECT id,amount,usedAmount,status,restrictScope,expiresAt,expiresAtJalali FROM "StoreCredit" WHERE id=?', issued.id)
assert.equal(n(rootInvoice.grandTotal),18_000_000)
assert.equal(n(rootInvoice.discountTotal),2_000_000)
assert.equal(n(rootInvoice.paidTotal),18_000_000)
assert.equal(sourceAfterSale.status,'USED')

const exchangeA = await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(sourceItem(A).id),qty:1}],
  replacements:[{variantId:A1.id,qty:1,unitPrice:A1.price,discount:0,tax:0}],
  refundMode:RefundMethod.CASH,idempotencyKey:'discounted-mixed-A-to-A1'
})
const sourceAfterExchangeA = seed.one('SELECT id,amount,usedAmount,status,expiresAt,expiresAtJalali FROM "StoreCredit" WHERE id=?', issued.id)
const successorsAfterA = seed.rows('SELECT id,amount,usedAmount,status,expiresAt,source,returnId FROM "StoreCredit" WHERE id<>? ORDER BY id', issued.id).map(row=>({id:n(row.id),amount:n(row.amount),usedAmount:n(row.usedAmount),status:row.status,expiresAt:row.expiresAt==null?null:n(row.expiresAt),source:row.source,returnId:n(row.returnId)}))
const exchangeB = await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(sourceItem(B).id),qty:1}],
  replacements:[{variantId:B1.id,qty:1,unitPrice:B1.price,discount:0,tax:0}],
  methodId:cash,idempotencyKey:'discounted-mixed-B-to-B1'
})
const exchangeChildPayments = [exchangeA,exchangeB].map(exchange=>({
  invoiceId:n(exchange.exchangeInvoiceId),
  payments:seed.rows('SELECT p.amount,p.destination,m.kind methodKind FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? ORDER BY p.seq',exchange.exchangeInvoiceId).map(row=>({amount:n(row.amount),destination:row.destination,methodKind:row.methodKind}))
}))
const rootCreditAllocations=seed.rows('SELECT returnId,amount,redemptionId,creditRestored,saleItemId FROM "CreditReturnAllocation" WHERE invoiceId=? ORDER BY id',sale.id).map(row=>({returnId:n(row.returnId),amount:n(row.amount),redemptionId:n(row.redemptionId),creditRestored:!!row.creditRestored,saleItemId:row.saleItemId==null?null:n(row.saleItemId)}))
const originalCreditRedemption=n(seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL',sale.id).amount)
const originalCashPayment=n(seed.one('SELECT COALESCE(SUM(p.amount),0) amount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? AND m.kind=\'CASH\' AND p.voidedAt IS NULL',sale.id).amount)
const originalRedemption=seed.one('SELECT id,creditId,amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL ORDER BY seq LIMIT 1',sale.id)
const sourcePlanA=planReturnCreditSources({
  lines:[{saleItemId:n(sourceItem(A).id),variantId:A.id,value:n(exchangeA.returnTotal),categoryPath:[]}],
  sources:[{redemptionId:n(originalRedemption.id),creditId:n(originalRedemption.creditId),amount:n(originalRedemption.amount),restrictScope:'ALL'}]
})
const firstExchangeAllocation=rootCreditAllocations.find(row=>row.returnId===n(exchangeA.returnId))?.amount??0
const firstReturnExpectedCash=n(exchangeA.returnTotal)-originalCreditRedemption
const firstReplacementCreditUsed=Math.max(0,n(exchangeA.exchangeTotal)-firstReturnExpectedCash)
const reconstructedCashRemoval=n(exchangeA.returnTotal)-firstExchangeAllocation
const reconstructedCashRemaining=originalCashPayment-reconstructedCashRemoval
const expectedCashRemaining=originalCashPayment-firstReturnExpectedCash
const childRows=[]
let childReturnBlocked = null
for(const [label,exchange] of [['A1',exchangeA],['B1',exchangeB]]) {
  const item=seed.one('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',exchange.exchangeInvoiceId)
  console.log(`Returning ${label}; childTotal=${exchange.exchangeTotal}; initialSourceReturn=${exchange.returnTotal}; exchangeDiff=${exchange.diff}; cashIn=${exchange.cashReceived??0}; cashOut=${exchange.cashRefunded??0}`)
  try {
    const ret=await salesService.createReturn({userId,shiftId,invoiceId:n(exchange.exchangeInvoiceId),full:true,refundMethod:RefundMethod.CASH})
    const row=seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',ret.id)
    childRows.push({label,exchangeInvoiceId:n(exchange.exchangeInvoiceId),itemId:n(item.id),replacementInvoiceTotal:n(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId).grandTotal),returnId:n(ret.id),returnTotal:n(row.total),refundMethod:row.refundMethod,cashRefunded:n(row.refundAmount),returnedSourceCreditAmount:n(ret.sourceCreditRestoredAmount??0)})
  } catch (error) {
    childReturnBlocked = { label, exchangeInvoiceId:n(exchange.exchangeInvoiceId), attemptedReturnTotal:n(item.lineTotal), message:String(error?.message??error) }
    break
  }
}
const sourceAfterAll=seed.one('SELECT id,amount,usedAmount,status,expiresAtJalali FROM "StoreCredit" WHERE id=?',issued.id)
const allCredits=seed.rows('SELECT id,code,amount,usedAmount,status,expiresAtJalali,source,restrictScope,returnId FROM "StoreCredit" ORDER BY id').map(row=>({id:n(row.id),amount:n(row.amount),usedAmount:n(row.usedAmount),status:row.status,expiresAtJalali:row.expiresAtJalali,source:row.source,scope:row.restrictScope,returnId:row.returnId==null?null:n(row.returnId)}))
const rootReturns=seed.rows('SELECT id,total,kind,exchangeDiff,refundMethod,refundAmount FROM "SaleReturn" WHERE invoiceId=? ORDER BY id',sale.id).map(row=>({id:n(row.id),total:n(row.total),kind:row.kind,exchangeDiff:n(row.exchangeDiff),refundMethod:row.refundMethod,refundAmount:n(row.refundAmount)}))
const allReturns=seed.rows('SELECT invoiceId,total,kind,refundMethod,refundAmount FROM "SaleReturn" ORDER BY id').map(row=>({invoiceId:n(row.invoiceId),total:n(row.total),kind:row.kind,refundMethod:row.refundMethod,refundAmount:n(row.refundAmount)}))
const cashRefunded=allReturns.filter(row=>row.refundMethod===RefundMethod.CASH).reduce((sum,row)=>sum+row.refundAmount,0)
const failedChildInvoice = n(exchangeB.exchangeInvoiceId)
const failedChildReturnCount = n(seed.one('SELECT COUNT(*) count FROM "SaleReturn" WHERE invoiceId=?',failedChildInvoice).count)
const checks={
  gross20mDiscount2mNet18m: n(rootInvoice.discountTotal)===2_000_000&&n(rootInvoice.grandTotal)===18_000_000,
  originalBarcodeFullyUsedAndStaysUsed: sourceAfterSale.status==='USED'&&n(sourceAfterSale.usedAmount)===2_000_000,
  firstReturnAtDiscountedNet9m: n(exchangeA.returnTotal)===9_000_000,
  firstReplacement8_5mDiffNegative500k: n(exchangeA.exchangeTotal)===8_500_000&&n(exchangeA.diff)===-500_000,
  firstSurplusIsSourceCreditNotCash: n(exchangeA.cashRefunded)===0&&n(exchangeA.sourceCreditRestoredAmount)===500_000&&String(exchangeA.refundMode)==='STORE_CREDIT',
  secondReturnAtDiscountedNet9m: n(exchangeB.returnTotal)===9_000_000,
  secondReplacement9_5mCollects500kCash: n(exchangeB.diff)===500_000&&n(exchangeB.cashReceived)===500_000,
  firstReplacementReturnSucceededAt8500k: childRows.length>=1&&childRows[0].label==='A1'&&childRows[0].returnTotal===8_500_000,
  secondReplacementReturnBlockedWithTraceabilityError: childReturnBlocked?.label==='B1'&&childReturnBlocked.message.includes('۹٬۰۰۰٬۰۰۰')&&childReturnBlocked.message.includes('۷٬۵۰۰٬۰۰۰'),
  rejectedB1ReturnCreatedNoDocument: failedChildReturnCount===0,
  allOriginalItemsReturnAtNet18m: rootReturns.reduce((sum,row)=>sum+row.total,0)===18_000_000,
  oldBarcodeStillUsedAfterChain: sourceAfterAll.status==='USED'&&n(sourceAfterAll.usedAmount)===2_000_000,
  noCashRefundExceedsMoneyPaidAfterTender: cashRefunded-n(exchangeB.cashReceived)<=16_000_000,
  successorsKeepSourceExpiryAndALLScope: allCredits.slice(1).every(row=>row.expiresAtJalali===sourceBefore.expiresAtJalali&&row.scope==='ALL'),
  originalSourceMixIs2mCreditAnd16mCash: originalCreditRedemption===2_000_000&&originalCashPayment===16_000_000,
  returnPolicyPlanConfirms2mCreditAnd7mMoney: sourcePlanA.credit===2_000_000&&sourcePlanA.realMoneyRight===7_000_000&&sourcePlanA.shares[0]?.saleItemId===null,
  firstReturnUses2mCreditAnd7mActualCash: n(exchangeA.returnTotal)===9_000_000&&firstReturnExpectedCash===7_000_000,
  replacementConsumes1_5mCreditAndLeaves500kSurplus: firstReplacementCreditUsed===1_500_000&&n(exchangeA.sourceCreditRestoredAmount)===500_000,
  only500kOfCreditReturnRecordedAtRoot: firstExchangeAllocation===500_000,
  reconstructionOverstatesCashRemovalBy1_5m: reconstructedCashRemoval===8_500_000&&firstReturnExpectedCash===7_000_000,
  reconstructionLeaves7_5mInsteadOf9mCash: reconstructedCashRemaining===7_500_000&&expectedCashRemaining===9_000_000
}
assert.ok(Object.values(checks).every(Boolean),`discount/mixed-credit chain checks ${JSON.stringify(checks)}; A=${JSON.stringify({returnTotal:exchangeA.returnTotal,diff:exchangeA.diff,refundMode:exchangeA.refundMode,cashRefunded:exchangeA.cashRefunded,sourceCreditRestoredAmount:exchangeA.sourceCreditRestoredAmount,sourceCreditSuccessors:exchangeA.sourceCreditSuccessors})}; B=${JSON.stringify({returnTotal:exchangeB.returnTotal,diff:exchangeB.diff,cashReceived:exchangeB.cashReceived})}; child=${JSON.stringify(childRows)}; blocked=${JSON.stringify(childReturnBlocked)}; credits=${JSON.stringify(allCredits)}; cashRefunded=${cashRefunded}`)
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:dirDb,verdict:'BLOCKED_AS_OBSERVED',checks,
  originalSale:{invoiceId:n(sale.id),grossGoods:20_000_000,invoiceDiscount:2_000_000,netInvoice:18_000_000,storeCredit:2_000_000,cashPaid:16_000_000,oldBarcodeAfterSale:sourceAfterSale.status},
  chain:[{source:'A',discountedNetReturn:n(exchangeA.returnTotal),replacement:n(exchangeA.exchangeTotal),diff:n(exchangeA.diff),cashRefunded:n(exchangeA.cashRefunded),sourceCreditRestored:n(exchangeA.sourceCreditRestoredAmount),appliedRefundMode:exchangeA.refundMode,successors:successorsAfterA},{source:'B',discountedNetReturn:n(exchangeB.returnTotal),replacement:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),cashReceived:n(exchangeB.cashReceived)}],
  exchangeChildPayments,rootCreditAllocations,sourceMixDiagnostic:{originalCreditRedemption,originalCashPayment,policyPlannedFirstReturn:{credit:sourcePlanA.credit,realMoneyRight:sourcePlanA.realMoneyRight,shares:sourcePlanA.shares},firstExchangeReturn:n(exchangeA.returnTotal),firstExchangeCreditAllocationRecorded:firstExchangeAllocation,expectedCashFromFirstReturn:firstReturnExpectedCash,firstReplacement:n(exchangeA.exchangeTotal),creditConsumedByReplacement:firstReplacementCreditUsed,creditSurplusSuccessor:n(exchangeA.sourceCreditRestoredAmount),reconstructedCashRemoval,reconstructedCashRemaining,expectedCashRemaining,unexplainedCashGap:expectedCashRemaining-reconstructedCashRemaining},childReturns:childRows,childReturnBlocked,rootReturns,sourceBarcodeBefore: {amount:n(sourceBefore.amount),scope:sourceBefore.restrictScope,expiresAt:sourceBefore.expiresAtJalali},sourceBarcodeAfter: {amount:n(sourceAfterAll.amount),usedAmount:n(sourceAfterAll.usedAmount),status:sourceAfterAll.status}, credits:allCredits,
  final:{originalGoodsReturnTotal:rootReturns.reduce((sum,row)=>sum+row.total,0),replacementReturnTotal:childRows.reduce((sum,row)=>sum+row.returnTotal,0),cashRefunded,additionalCashReceived:n(exchangeB.cashReceived),netCashRefunded:cashRefunded-n(exchangeB.cashReceived),activeSuccessorCredit:allCredits.slice(1).filter(row=>row.status==='ACTIVE').reduce((sum,row)=>sum+row.amount,0)},
  safety:{liveDatabase:false,productionCodeChanged:false,checksOrDebt:false,realMoneyMoved:false}}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true});writeFileSync(join(reports,'deep-e2e-discounted-invoice-credit-mixed-exchange-chain.json'),JSON.stringify(summary,null,2)+'\n')
const fa=value=>Number(value??0).toLocaleString('fa-IR')
const md=[
  '# زنجیرهٔ تخفیف فاکتور با اعتبار `ALL` و پرداخت نقدی', '',
  `**نتیجهٔ جریان:** BLOCKED هنگام برگشت B1؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checkpoint اجرای آزمون درست ثبت شد.`,
  `**DB:** SQLite موقت ایزوله (${dirDb}).`, '',
  '## فروش اولیه',
  '- قیمت ناخالص دو قلم: ۱۰٬۰۰۰٬۰۰۰ + ۱۰٬۰۰۰٬۰۰۰ = ۲۰٬۰۰۰٬۰۰۰.',
  '- تخفیف فاکتور ۲٬۰۰۰٬۰۰۰؛ جمع فاکتور ۱۸٬۰۰۰٬۰۰۰، تسویه با بارکد عادی `ALL` به مبلغ ۲٬۰۰۰٬۰۰۰ و وجه نقد ۱۶٬۰۰۰٬۰۰۰.',
  '- هر قلم برای برگشت عادی/تعویض ۹٬۰۰۰٬۰۰۰ ارزش خالص دارد.', '',
  '## زنجیرهٔ واقعی',
  `1. برگشت A با ارزش خالص ${fa(exchangeA.returnTotal)} و جایگزینی با ${fa(exchangeA.exchangeTotal)}؛ مابه‌التفاوت ۵۰۰٬۰۰۰ بود. چون سهم برگشتیِ این بار از منبع بارکدی آمد، درخواست CASH به ${exchangeA.refundMode} تبدیل شد؛ وجه برگشتی صفر و successor منبعی ${fa(exchangeA.sourceCreditRestoredAmount)} ساخته شد.`,
  `2. برگشت B با ارزش خالص ${fa(exchangeB.returnTotal)} و جایگزینی با ${fa(exchangeB.exchangeTotal)}؛ مشتری فقط ${fa(exchangeB.cashReceived)} مابه‌التفاوت نقدی پرداخت کرد.`,
  `3. برگشت A1 به مبلغ ${fa(childRows[0]?.returnTotal??0)} پذیرفته شد؛ ${fa(childRows[0]?.cashRefunded??0)} وجه و ${fa(childRows[0]?.returnedSourceCreditAmount??0)} سهم اعتبار منبعی برگشت خورد.`,
  `4. برگشت B1 به مبلغ ${fa(childReturnBlocked?.attemptedReturnTotal??0)} **بدون ثبت سند متوقف شد**: ${childReturnBlocked?.message??'خطا ثبت نشده'}`, '',
  '## نتیجهٔ مالی و بارکد تا نقطهٔ توقف',
  `- برگشت اقلام فاکتور اصلی: ${fa(rootReturns.reduce((sum,row)=>sum+row.total,0))}؛ دقیقاً خالص همان فاکتور، نه قیمت ناخالص.`,
  `- کد اولیهٔ ۲٬۰۰۰٬۰۰۰ پس از مصرف USED ماند. دو جانشینِ ثبت‌شده ${allCredits.slice(1).map(row=>fa(row.amount)).join(' + ')} هستند؛ مجموع ${fa(allCredits.slice(1).reduce((sum,row)=>sum+row.amount,0))} و هر دو تاریخ انقضای منبع را حفظ کردند.`,
  `- تا پیش از تلاش ناموفق B1، ${fa(cashRefunded)} وجه نقد برگشت و ${fa(exchangeB.cashReceived)} دریافت شد؛ خالص خروج نقد ${fa(cashRefunded-n(exchangeB.cashReceived))}. درخواست ردشده هیچ سند/تغییر دیگری نساخت.`,
  '- نتیجهٔ مهم: تخفیف ۲میلیونی به نسبت برای برگشت دو قلم اصلی منظور شد؛ اما زنجیرهٔ mixed-credit در برگشت کالای دوم جایگزین، به‌علت ناسازگاری در ردگیری پول واقعی کامل نشد. این را نباید PASS کامل کل زنجیره گزارش کرد.',
  '',
  '## علت مستقیمِ اختلاف ۱٬۵۰۰٬۰۰۰',
  `- خرید اولیه واقعاً ${fa(originalCreditRedemption)} اعتبار + ${fa(originalCashPayment)} وجه نقد داشت. برگشت اول A به ارزش ${fa(exchangeA.returnTotal)} با سیاست pool کل فاکتور، ${fa(originalCreditRedemption)} سهم اعتباری و ${fa(firstReturnExpectedCash)} سهم پولی داشت.`,
  `- کالای جایگزین A1 به ارزش ${fa(exchangeA.exchangeTotal)} ابتدا ${fa(firstReturnExpectedCash)} از پول را مصرف کرد و ${fa(firstReplacementCreditUsed)} از اعتبار را؛ فقط ${fa(exchangeA.sourceCreditRestoredAmount)} اعتبار اضافه باقی ماند و successor شد.`,
  `- ردیف CreditReturnAllocation برای برگشت A فقط همان surplusِ ${fa(firstExchangeAllocation)} را ثبت کرده است. اما بازسازی برگشت قبلی در SalesService.ts:1863, بر پایهٔ «کل برگشت − اعتبار ثبت‌شده» پول را کم می‌کند: ${fa(exchangeA.returnTotal)} − ${fa(firstExchangeAllocation)} = ${fa(reconstructedCashRemoval)} پولِ فرضی. در حالی که پول واقعیِ مصرف‌شده برای A فقط ${fa(firstReturnExpectedCash)} بود.`,
  `- بنابراین از ۱۶٬۰۰۰٬۰۰۰ پول اولیه، این بازسازی ${fa(reconstructedCashRemaining)} باقی‌مانده حساب می‌کند؛ ماندهٔ درست پس از مصرف ۷٬۰۰۰٬۰۰۰ پول برای A باید ${fa(expectedCashRemaining)} باشد. اختلاف دقیق ${fa(expectedCashRemaining-reconstructedCashRemaining)} است؛ همین باعث می‌شود برگشت B1 با خطای «۹٬۰۰۰٬۰۰۰ حق وجه، فقط ۷٬۵۰۰٬۰۰۰ قابل‌ردیابی» متوقف شود.`,
  '- در کد، تعویض مبلغ اعتبارِ مصرف‌شده روی کالای جایگزین را از اعتبارِ مازاد جدا می‌کند (SalesService.ts:7592–7605)، ولی ردیف allocation منبع برگشت را فقط برای backedSurplus می‌نویسد (7696–7722). بازسازی برگشت بعدی آن ردیف را به‌عنوان کل سهم اعتبار می‌خواند (1863–1875). پس علت مستقیم، ناهماهنگی معنای این دفتر است: «اعتبارِ برگشتی/مصرف‌شده در تعویض» با «فقط اعتبارِ باقی‌مانده‌ای که به مشتری برگشته» یکی گرفته شده است.',
  '- این ریشه‌یابی از مقادیر DB ایزوله و مسیرهای کد بالا به‌دست آمد؛ هنوز production code را اصلاح نکردم. اصلاح باید سهم اعتباریِ مصرف‌شده در replacement را هم در بازسازی زنجیره قابل‌ردیابی نگه دارد، بی‌آنکه آن را دوباره به مشتری صادر کند.',
  '',
  '## محدوده',
  '- همهٔ عملیات رسمی فروش/تعویض/برگشت در SQLite موقت ایزوله انجام شد؛ DB واقعی، چک، بدهی، stage یا reset استفاده نشد.',
  '- هیچ production code تغییر نکرد؛ پنجرهٔ Electron و چاپ فیزیکی اجرا نشدند.'
]
writeFileSync(join(reports,'deep-e2e-discounted-invoice-credit-mixed-exchange-chain.md'),md.join('\n')+'\n')
console.log(`Mixed credit/discount exchange chain: BLOCKED_AS_OBSERVED; ${Object.keys(checks).length}/${Object.keys(checks).length} checkpoints verified; B1 error=${childReturnBlocked?.message}; old credit=${sourceAfterAll.status}; successors=${allCredits.slice(1).map(row=>row.amount).join('+')}; net cash refund so far=${cashRefunded-n(exchangeB.cashReceived)}`)
await db.$disconnect?.()
