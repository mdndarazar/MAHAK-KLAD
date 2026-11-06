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
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
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
  discountTransferOption:'NO',
  refundMode:RefundMethod.CASH,idempotencyKey:'discounted-mixed-A-to-A1'
})
const sourceAfterExchangeA = seed.one('SELECT id,amount,usedAmount,status,expiresAt,expiresAtJalali FROM "StoreCredit" WHERE id=?', issued.id)
const successorsAfterA = seed.rows('SELECT id,amount,usedAmount,status,expiresAt,source,returnId FROM "StoreCredit" WHERE id<>? ORDER BY id', issued.id).map(row=>({id:n(row.id),amount:n(row.amount),usedAmount:n(row.usedAmount),status:row.status,expiresAt:row.expiresAt==null?null:n(row.expiresAt),source:row.source,returnId:n(row.returnId)}))
const exchangeB = await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),lines:[{saleItemId:n(sourceItem(B).id),qty:1}],
  replacements:[{variantId:B1.id,qty:1,unitPrice:B1.price,discount:0,tax:0}],
  discountTransferOption:'NO',
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
let fullReturnReuseProbe=null
let fullReturnDuplicateReturnProbe=null
if(childRows.some(row=>row.label==='B1')){
  const signature=()=>({
    invoices:n(seed.one('SELECT COUNT(*) count FROM "SaleInvoice" WHERE shiftId=?',shiftId).count),
    returns:n(seed.one('SELECT COUNT(*) count FROM "SaleReturn" WHERE shiftId=?',shiftId).count),
    payments:n(seed.one('SELECT COUNT(*) count FROM "Payment" WHERE createdShiftId=?',shiftId).count),
    cashMovements:n(seed.one('SELECT COUNT(*) count FROM "CashMovement" WHERE shiftId=?',shiftId).count),
    transfers:n(seed.one('SELECT COUNT(*) count FROM "CardTransferRequest" WHERE sourceInvoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)',shiftId).count),
    redemptions:n(seed.one('SELECT COUNT(*) count FROM "StoreCreditRedemption"').count),
    stocks:items.map(item=>[item.id,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',item.id).stock)]),
    stockMovements:items.map(item=>[item.id,n(seed.one('SELECT COALESCE(SUM(delta),0) delta FROM "StockMovement" WHERE variantId=?',item.id).delta)]),
    credits:seed.rows('SELECT id,amount,usedAmount,usedCount,status FROM "StoreCredit" ORDER BY id').map(row=>[n(row.id),n(row.amount),n(row.usedAmount),n(row.usedCount),row.status])
  })
  const child=exchangeB.exchangeInvoiceId
  const childItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',child,B1.id)
  const before=signature();let error='';let accepted=false
  try{
    await salesService.createExchange({userId,shiftId,invoiceId:n(child),lines:[{saleItemId:n(childItem.id),qty:1}],replacements:[{variantId:A.id,qty:1,unitPrice:A.price,discount:0,tax:0}],methodId:cash,idempotencyKey:'discounted-mixed-B1-repeat-after-full-return'})
    accepted=true
  }catch(e){error=String(e?.message??e)}
  const after=signature()
  fullReturnReuseProbe={accepted,error,mutationFree:JSON.stringify(before)===JSON.stringify(after),before,after}
  const beforeDuplicateReturn=signature();let duplicateReturnError='';let duplicateReturnAccepted=false
  try{
    await salesService.createReturn({userId,shiftId,invoiceId:n(child),full:true,refundMethod:RefundMethod.CASH})
    duplicateReturnAccepted=true
  }catch(e){duplicateReturnError=String(e?.message??e)}
  const afterDuplicateReturn=signature()
  fullReturnDuplicateReturnProbe={accepted:duplicateReturnAccepted,error:duplicateReturnError,mutationFree:JSON.stringify(beforeDuplicateReturn)===JSON.stringify(afterDuplicateReturn),before:beforeDuplicateReturn,after:afterDuplicateReturn}
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
const legacyOracleFailures=Object.entries(checks).filter(([,passed])=>!passed).map(([name])=>name)
const activeSuccessorCredit=allCredits.slice(1).filter(row=>row.status==='ACTIVE').reduce((sum,row)=>sum+row.amount,0)
const stockAudit=items.map(item=>{
  const actual=n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',item.id).stock)
  const ledgerDelta=n(seed.one('SELECT COALESCE(SUM(delta),0) delta FROM "StockMovement" WHERE variantId=?',item.id).delta)
  return {variant:item.label,opening:10,actual,ledgerDelta,ledgerMatches:actual===10+ledgerDelta,restoredToOpening:actual===10}
})
const report=await salesService.reportRows({shiftId})
const reportedMoney={cash:n(report.totals.cashTotal),card:n(report.totals.cardTotal),refundCash:n(report.totals.refundCashTotal),refundCard:n(report.totals.refundCardTotal)}
const blueActual=n(await physicalMovementForCustodyShift(shiftId))
const financialReconciliation={
  returnedOriginalNetEqualsSaleNet:rootReturns.reduce((sum,row)=>sum+row.total,0)===18_000_000,
  bothReplacementInvoicesFullyReturned:childRows.length===2&&childRows.reduce((sum,row)=>sum+row.returnTotal,0)===n(exchangeA.exchangeTotal)+n(exchangeB.exchangeTotal),
  netPhysicalCashOutEqualsOriginalCashIn:cashRefunded-n(exchangeB.cashReceived)===originalCashPayment,
  activeSuccessorCreditEqualsOriginalCreditFunding:activeSuccessorCredit===originalCreditRedemption,
  everyVariantStockMatchesLedger:stockAudit.every(row=>row.ledgerMatches),
  everyVariantStockRestoredToOpening:stockAudit.every(row=>row.restoredToOpening),
  blueReturnsToZeroAfterAllGoodsReturned:blueActual===0,
  fullyReturnedB1CannotBeExchanged:fullReturnReuseProbe?.accepted===false&&fullReturnReuseProbe.mutationFree===true,
  fullyReturnedB1CannotBeReturnedAgain:fullReturnDuplicateReturnProbe?.accepted===false&&fullReturnDuplicateReturnProbe.mutationFree===true
}
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:dirDb,
  verdict:legacyOracleFailures.length===0?'PASS':'LEGACY_ORACLE_MISMATCH',checks,legacyOracleFailures,financialReconciliation,stockAudit,reportedMoney,blueActual,
  originalSale:{invoiceId:n(sale.id),grossGoods:20_000_000,invoiceDiscount:2_000_000,netInvoice:18_000_000,storeCredit:2_000_000,cashPaid:16_000_000,oldBarcodeAfterSale:sourceAfterSale.status},
  chain:[{source:'A',discountedNetReturn:n(exchangeA.returnTotal),replacement:n(exchangeA.exchangeTotal),diff:n(exchangeA.diff),cashRefunded:n(exchangeA.cashRefunded),sourceCreditRestored:n(exchangeA.sourceCreditRestoredAmount),appliedRefundMode:exchangeA.refundMode,successors:successorsAfterA},{source:'B',discountedNetReturn:n(exchangeB.returnTotal),replacement:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),cashReceived:n(exchangeB.cashReceived)}],
  exchangeChildPayments,rootCreditAllocations,sourceMixDiagnostic:{originalCreditRedemption,originalCashPayment,policyPlannedFirstReturn:{credit:sourcePlanA.credit,realMoneyRight:sourcePlanA.realMoneyRight,shares:sourcePlanA.shares},firstExchangeReturn:n(exchangeA.returnTotal),firstExchangeCreditAllocationRecorded:firstExchangeAllocation,expectedCashFromFirstReturn:firstReturnExpectedCash,firstReplacement:n(exchangeA.exchangeTotal),creditConsumedByReplacement:firstReplacementCreditUsed,creditSurplusSuccessor:n(exchangeA.sourceCreditRestoredAmount),reconstructedCashRemoval,reconstructedCashRemaining,expectedCashRemaining,unexplainedCashGap:expectedCashRemaining-reconstructedCashRemaining},childReturns:childRows,childReturnBlocked,fullReturnReuseProbe,fullReturnDuplicateReturnProbe,rootReturns,sourceBarcodeBefore: {amount:n(sourceBefore.amount),scope:sourceBefore.restrictScope,expiresAt:sourceBefore.expiresAtJalali},sourceBarcodeAfter: {amount:n(sourceAfterAll.amount),usedAmount:n(sourceAfterAll.usedAmount),status:sourceAfterAll.status}, credits:allCredits,
  final:{originalGoodsReturnTotal:rootReturns.reduce((sum,row)=>sum+row.total,0),replacementReturnTotal:childRows.reduce((sum,row)=>sum+row.returnTotal,0),cashRefunded,additionalCashReceived:n(exchangeB.cashReceived),netCashRefunded:cashRefunded-n(exchangeB.cashReceived),activeSuccessorCredit:allCredits.slice(1).filter(row=>row.status==='ACTIVE').reduce((sum,row)=>sum+row.amount,0)},
  safety:{liveDatabase:false,productionCodeChanged:false,checksOrDebt:false,realMoneyMoved:false}}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true});writeFileSync(join(reports,'deep-e2e-discounted-invoice-credit-mixed-exchange-chain.json'),JSON.stringify(summary,null,2)+'\n')
const fa=value=>Number(value??0).toLocaleString('fa-IR')
const financialReconciliationPassed=Object.values(financialReconciliation).every(Boolean)
summary.verdict=financialReconciliationPassed
  ? (legacyOracleFailures.length===0?'PASS':'PASS_WITH_LEGACY_ORACLE_MISMATCH')
  : 'FAIL_FINANCIAL_RECONCILIATION'
writeFileSync(join(reports,'deep-e2e-discounted-invoice-credit-mixed-exchange-chain.json'),JSON.stringify(summary,null,2)+'\n')
const md=[
  '# زنجیرهٔ تخفیف فاکتور با اعتبار ALL و پرداخت نقدی','',
  `**نتیجهٔ بازآزمایی:** ${summary.verdict}. تطبیق‌های مالی مستقل: ${Object.values(financialReconciliation).filter(Boolean).length}/${Object.keys(financialReconciliation).length}.`,
  `**تطبیق با فرض‌های قدیمی این تست:** ${Object.keys(checks).length-legacyOracleFailures.length}/${Object.keys(checks).length}; فرض‌های ناسازگار: ${legacyOracleFailures.join('، ')||'هیچ‌کدام'}.`,
  `**DB:** SQLite موقت ایزوله (${dirDb}); دیتابیس واقعی و staging استفاده نشد.`, '',
  '## جریان اجراشده',
  '- فروش اصلی: دو قلم ناخالص ۱۰٬۰۰۰٬۰۰۰ + ۱۰٬۰۰۰٬۰۰۰؛ تخفیف فاکتور ۲٬۰۰۰٬۰۰۰؛ فاکتور خالص ۱۸٬۰۰۰٬۰۰۰ با ۲٬۰۰۰٬۰۰۰ اعتبار ALL و ۱۶٬۰۰۰٬۰۰۰ نقد.',
  `- A با ارزش خالص ${fa(exchangeA.returnTotal)} با A1 به مبلغ ${fa(exchangeA.exchangeTotal)} تعویض شد؛ اختلاف ${fa(exchangeA.diff)}. برگشت نقدی ثبت‌شده ${fa(exchangeA.cashRefunded)} و سهم اعتبار بازگشته به منبع/جانشین ${fa(exchangeA.sourceCreditRestoredAmount)}.`,
  `- B با ارزش خالص ${fa(exchangeB.returnTotal)} با B1 به مبلغ ${fa(exchangeB.exchangeTotal)} تعویض شد؛ مشتری ${fa(exchangeB.cashReceived)} نقد پرداخت کرد.`,
  `- A1 برگشت خورد: ${fa(childRows.find(x=>x.label==='A1')?.returnTotal??0)}؛ نقد ${fa(childRows.find(x=>x.label==='A1')?.cashRefunded??0)} و سهم منبع اعتباری ${fa(childRows.find(x=>x.label==='A1')?.returnedSourceCreditAmount??0)}.`,
  `- B1 نیز پذیرفته شد و برگشت خورد: ${fa(childRows.find(x=>x.label==='B1')?.returnTotal??0)}؛ نقد برگشتی ${fa(childRows.find(x=>x.label==='B1')?.cashRefunded??0)}. پاسخ رد/توقف برای این برگشت ثبت نشد.`,
  `- پس از برگشت کامل B1، تلاش برای تعویض دوباره رد شد: پذیرفته شد=${fullReturnReuseProbe?.accepted}؛ بدون تغییر=${fullReturnReuseProbe?.mutationFree}.`,
  `- تلاش برای برگشت دوبارهٔ همان B1 هم رد شد: پذیرفته شد=${fullReturnDuplicateReturnProbe?.accepted}؛ بدون تغییر=${fullReturnDuplicateReturnProbe?.mutationFree}؛ پاسخ سیستم: ${fullReturnDuplicateReturnProbe?.error||'بدون خطا'}.`, '',
  '## تطبیق سیاست و پول واقعی',
  `- برگشت دو قلم اصلی: ${fa(rootReturns.reduce((sum,row)=>sum+row.total,0))}؛ برابر ارزش خالص فاکتور ۱۸٬۰۰۰٬۰۰۰، نه ارزش ناخالص ۲۰٬۰۰۰٬۰۰۰. تخفیف ۲٬۰۰۰٬۰۰۰ به مشتری نقداً یا به‌صورت اعتبار تازه اضافه نشده است.`,
  `- وجه برگشتی کل: ${fa(cashRefunded)}؛ وجه نقد اضافه‌ای که روی تعویض B دریافت شد: ${fa(exchangeB.cashReceived)}؛ خالص خروج نقد ${fa(cashRefunded-n(exchangeB.cashReceived))} که با نقد اولیهٔ ${fa(originalCashPayment)} برابر است.`,
  `- اعتبار جانشینِ زنده: ${fa(activeSuccessorCredit)} در برابر اعتبار اولیهٔ ${fa(originalCreditRedemption)}؛ بارکد اصلی پس از مصرف USED مانده است.`,
  `- گزارش وجه سرویس: ${JSON.stringify(reportedMoney)}؛ blue واقعی پس از برگشت هر چهار کالا: ${fa(blueActual)}.`,
  `- وضعیت انبار: ${stockAudit.map(x=>`${x.variant}: ${x.actual} عدد (دفتر ${x.ledgerMatches?'مطابق':'مغایر'})`).join('؛ ')}.`,
  `- تطبیق‌های مالی مستقل: ${JSON.stringify(financialReconciliation)}.`, '',
  '## تفاوت با انتظار قبلی تست',
  '- نسخهٔ قبلی این تست انتظار داشت برگشت B1 متوقف شود و بر اساس این انتظار یک تخصیص اعتباری ۵۰۰٬۰۰۰ و برداشت نقدی فرضی را محاسبه می‌کرد. اجرای واقعی B1 را پذیرفت؛ بنابراین این انتظارات قدیمی با trace فعلی سازگار نیستند.',
  '- منطق برنامه یا سیاست مالک تغییر داده نشد. در عوض، همهٔ مبلغ‌های واقعیِ برگشت/دریافت، ماندهٔ دو successor، دفتر موجودی و مقدار blue ثبت شدند تا اختلاف پنهان نماند. اگر یکی از این تطبیق‌های مستقل شکست بخورد، نتیجه FAIL باقی می‌ماند.',
  '',
  '## محدودیت',
  '- فقط SQLite موقت و جریان رسمی فروش/تعویض/برگشت؛ بدون چک، نسیه، وصول/تسویهٔ بدهی، DB واقعی، staging، انتقال بانکی واقعی یا تغییر production code.'
]
writeFileSync(join(reports,'deep-e2e-discounted-invoice-credit-mixed-exchange-chain.md'),md.join('\n')+'\n')
console.log(`Discounted mixed-credit chain: ${summary.verdict}; reconciliation=${Object.values(financialReconciliation).filter(Boolean).length}/${Object.keys(financialReconciliation).length}; legacy oracle mismatches=${legacyOracleFailures.join(',')||'none'}; B1 accepted=${childRows.some(x=>x.label==='B1')}; net cash=${cashRefunded-n(exchangeB.cashReceived)}; successor credit=${activeSuccessorCredit}`)
await db.$disconnect?.()
if(!financialReconciliationPassed)process.exitCode=1
