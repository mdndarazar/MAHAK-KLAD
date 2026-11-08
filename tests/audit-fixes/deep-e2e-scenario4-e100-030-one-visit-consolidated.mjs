import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-e100-030-one-visit-'))
process.env.HARNESS_DIR=dir
process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/main/../shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('E100-030 one-visit consolidated cashier')
const cash=seed.insert('PaymentMethod',{key:'E100-030-ONEVISIT-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const shiftId=seed.insert('Shift',{name:'E100-030 one visit consolidated',number:9432,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const n=value=>Number(value??0)
let seq=0
function variant(label,price){const product=seed.product(`E030V-${++seq}-${label}`,seed.category(`E030V-cat-${seq}`));const id=seed.variant(product,`E030V-${seq}`);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,label,price}}
const A=variant('A-200k',200_000),B=variant('B-200k',200_000),C=variant('C-300k',300_000),D=variant('D-300k',300_000)
const B1=variant('B1-220k',220_000),C1=variant('C1-290k',290_000),D1=variant('D1-290k',290_000)
const credits=[]
for(let i=0;i<6;i++){
  const issued=await storeCreditService.issueManual({amount:100_000,multiUse:true,maxUses:2,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note:`E100-030 one-visit source-${i+1}`})
  const row=seed.one('SELECT id,code,restrictScope FROM "StoreCredit" WHERE id=?',issued.id)
  credits.push({id:n(row.id),code:row.code,scope:row.restrictScope})
}
assert.ok(credits.every(row=>row.scope==='ALL'))
const sale=await salesService.create({
  userId,shiftId,
  lines:[A,B,C,D].map(x=>({variantId:x.id,qty:1,unitPrice:x.price,discount:0,tax:0})),invoiceDiscount:0,
  storeCredits:credits.map(x=>({code:x.code,requestedAmount:50_000})),
  payments:[{methodId:cash,amount:700_000,destination:'CASH'}],saleRequestIdempotencyKey:'e100-030-one-visit-root'
})
const root=seed.one('SELECT id,grandTotal,discountTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
const items=seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
const itemFor=x=>items.find(row=>n(row.variantId)===x.id)
assert.equal(n(root.grandTotal),1_000_000)

// One customer visit, one consolidated exchange request: return all original goods,
// replace B/C/D, and return A's value as the net source-credit surplus.
const exchange=await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),
  lines:[A,B,C,D].map(x=>({saleItemId:n(itemFor(x).id),qty:1})),
  replacements:[{variantId:B1.id,qty:1,unitPrice:B1.price,discount:0,tax:0},{variantId:C1.id,qty:1,unitPrice:C1.price,discount:0,tax:0},{variantId:D1.id,qty:1,unitPrice:D1.price,discount:0,tax:0}],
  refundMode:'STORE_CREDIT',idempotencyKey:'e100-030-one-visit-all-at-once'
})
const ret=seed.one('SELECT id,total,kind,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
const returnLines=seed.rows('SELECT saleItemId,variantId,lineTotal,restockedQty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchange.returnId).map(row=>({saleItemId:n(row.saleItemId),variantId:n(row.variantId),lineTotal:n(row.lineTotal),restockedQty:n(row.restockedQty)}))
const allocations=seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored,settlementAdjusted FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,exchange.returnId).map(row=>({redemptionId:n(row.redemptionId),sourceCreditId:n(row.sourceCreditId),amount:n(row.amount),creditRestored:!!row.creditRestored,settlementAdjusted:!!row.settlementAdjusted}))
const child=seed.one('SELECT id,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
const payments=seed.rows('SELECT methodId,amount,kind,destination,storeCreditId,note FROM "Payment" WHERE invoiceId=? ORDER BY seq',exchange.exchangeInvoiceId).map(row=>({methodId:n(row.methodId),amount:n(row.amount),kind:row.kind,destination:row.destination,storeCreditId:row.storeCreditId==null?null:n(row.storeCreditId),note:row.note}))
const creditsAfter=seed.rows('SELECT id,amount,usedAmount,status FROM "StoreCredit" ORDER BY id').map(row=>({id:n(row.id),amount:n(row.amount),usedAmount:n(row.usedAmount),status:row.status}))
const stocks=Object.fromEntries([A,B,C,D,B1,C1,D1].map(x=>[x.label,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',x.id).stock)]))
const noChecks=seed.rows('SELECT id FROM "Payment" WHERE kind=\'CHEQUE\'').length===0
const checks={
  originalInvoiceNoDiscount1m:n(root.grandTotal)===1_000_000&&n(root.discountTotal)===0&&n(root.paidTotal)===1_000_000,
  oneExchangeReturnsAllFour1m:n(exchange.returnTotal)===1_000_000&&n(ret.total)===1_000_000&&returnLines.length===4&&returnLines.reduce((s,x)=>s+x.lineTotal,0)===1_000_000,
  replacementsB1C1D1Total800k:n(exchange.exchangeTotal)===800_000&&n(ret.exchangeTotal)===800_000&&n(child.grandTotal)===800_000,
  netDifferenceIsMinus200k:n(exchange.diff)===-200_000&&n(ret.exchangeDiff)===-200_000,
  allInOneReturnHasSourceCreditAllocations:allocations.length>0&&allocations.reduce((s,x)=>s+x.amount,0)===200_000&&n(exchange.sourceCreditRestoredAmount)===200_000,
  creditBackedSurplusIsNonCashNotRefundedAsCash:n(ret.refundAmount)===0&&n(ret.refundStoreCreditAmount)===0&&payments.every(x=>x.destination!=='CASH'||x.amount===0),
  replacementInvoiceSettled:n(child.paidTotal)===800_000&&child.status==='SETTLED',
  stocksShowOneReturnAndReplacement:stocks[A.label]===10&&stocks[B.label]===10&&stocks[C.label]===10&&stocks[D.label]===10&&stocks[B1.label]===9&&stocks[C1.label]===9&&stocks[D1.label]===9,
  noChecksOrDebt:noChecks
}
assert.ok(Object.values(checks).every(Boolean),`one-visit consolidated checks: ${JSON.stringify(checks)}; exchange=${JSON.stringify(exchange)}; return=${JSON.stringify(ret)}; payments=${JSON.stringify(payments)}`)
const summary={generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,verdict:'ONE_CONSOLIDATED_EXCHANGE_ACCEPTED',checks,
  scenario:{customerVisits:1,exchangeRequests:1,invoiceDiscount:0,grossAndNetInvoice:1_000_000,initialTender:{storeCredit:300_000,cash:700_000},returned:{A:200_000,B:200_000,C:300_000,D:300_000,total:1_000_000},replacements:{B1:220_000,C1:290_000,D1:290_000,total:800_000},difference:-200_000,refundMode:'STORE_CREDIT'},
  exchangeResult:{returnId:n(exchange.returnId),exchangeInvoiceId:n(exchange.exchangeInvoiceId),returnTotal:n(exchange.returnTotal),replacementTotal:n(exchange.exchangeTotal),diff:n(exchange.diff),cashReceived:n(exchange.cashReceived),cashRefund:n(exchange.cashRefund),sourceCreditRestoredAmount:n(exchange.sourceCreditRestoredAmount)},
  returnRecord:{id:n(ret.id),kind:ret.kind,total:n(ret.total),exchangeTotal:n(ret.exchangeTotal),diff:n(ret.exchangeDiff),settlement:ret.exchangeSettlement,refundMethod:ret.refundMethod,refundAmount:n(ret.refundAmount),refundStoreCreditAmount:n(ret.refundStoreCreditAmount)},returnLines,creditAllocations:allocations,
  replacementInvoice:{id:n(child.id),grandTotal:n(child.grandTotal),paidTotal:n(child.paidTotal),status:child.status},payments,creditsAfter,stocks,
  conclusion:'A single consolidated exchange during one visit returned A+B+C+D (1,000,000) and delivered B1+C1+D1 (800,000), leaving -200,000. It was accepted without any prior B-return document, so the prior-return missing-allocation gate was not applicable. A separate no-discount run executed the A return, B exchange, and C+D exchange sequentially in one uninterrupted test session on the same shift; C+D still hit the missing-allocation gate. Thus one physical visit alone does not fix the sequential-document path; consolidation into one exchange request changes the path.',
  safety:{isolatedDatabase:true,productionCodeChanged:false,liveDatabase:false,checksOrDebt:false,realMoneyMoved:false}}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true})
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-one-visit-consolidated.json'),JSON.stringify(summary,null,2)+'\n')
const fa=x=>Number(x??0).toLocaleString('fa-IR')
const md=['# E100-030 بدون تخفیف: همه‌چیز در یک مراجعه و یک تعویض یک‌جا','',`**نتیجه:** عملیات یک‌جای برگشت/تعویض پذیرفته شد؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checkpoint پاس شد.`,`**DB:** SQLite موقت و ایزوله (${process.env.HARNESS_DB}).`,'',
  '## ورودی سناریو','- فاکتور بدون تخفیف: A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع ۱٬۰۰۰٬۰۰۰ ریال.','- پرداخت اولیه: ۳۰۰٬۰۰۰ اعتبار ALL + ۷۰۰٬۰۰۰ نقد.','- مشتری در یک درخواست تمام A+B+C+D را برمی‌گرداند و B1+C1+D1 را می‌گیرد؛ هیچ سندِ تعویض جداگانه‌ای برای B قبل از این درخواست ساخته نمی‌شود.','',
  '## نتیجهٔ ثبت‌شده',`- جمع برگشت: ${fa(exchange.returnTotal)}؛ جمع کالاهای جایگزین: ${fa(exchange.exchangeTotal)}؛ اختلاف **${fa(exchange.diff)} ریال** به نفع مشتری بود.`,`- نتیجهٔ actual: ${JSON.stringify({returnRecord:ret,allocations,returnLines,payments,stocks})}`,'',
  '## آیا مشکل قبلی هنوز هست؟','- در حالت یک سند تجمیعی، مشکلِ «برگشت قبلی B تخصیص منشأ ندارد» رخ نداد؛ چون برگشت قبلی B وجود نداشت. کل کالاها در همان برگشت یک‌جا بودند و allocationهای اعتبارِ همین برگشت ثبت شدند.','- جریان مرحله‌ای هم جداگانه در یک اجرای پیوسته و همان shift تست شده: برگشت A، سپس تعویض B، سپس C+D. با وجود اینکه همه در همان مراجعه/جلسهٔ تست بودند، C+D همچنان در گیت منشأ رد شد (جزئیات در گزارش no-discount). پس یک مراجعه بودن به‌تنهایی کافی نیست؛ اگر B در سند جداگانه ثبت شود، برای سند بعدی C+D «برگشت قبلی» است.','- این سناریوی تجمیعی با اختلاف منفی ۲۰۰٬۰۰۰ است. مبلغ اضافه، خودبه‌خود پول نقد محسوب نمی‌شود؛ دفتر برگشت و تخصیص اعتبار را بررسی کنید و اعتبار را به پول تبدیل نکنید.','',
  '## ایمنی','- فقط DB تست موقت استفاده شد؛ وجه واقعی، چک، بدهی یا DB واقعی در کار نبود و production code تغییر نکرد.'].join('\n')+'\n'
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-one-visit-consolidated.md'),md)
console.log(`E100-030 one visit / one consolidated exchange: ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length}; return=1m; replacements=800k; diff=-200k; accepted`)
await db.$disconnect?.()
