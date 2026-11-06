import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-030-no-discount-'))
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
const userId = seed.user('E100-030 isolated no-discount regression cashier')
const cash = seed.insert('PaymentMethod', { key: 'E100-030-NODISC-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'E100-030-NODISC-CARD', label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const shiftId = seed.insert('Shift', { name: 'E100-030 no-discount fixture', number: 9431, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const n = value => Number(value ?? 0)
let seq = 0
function variant(label, price) {
  const product = seed.product(`E030N-${++seq}-${label}`, seed.category(`E030N-category-${seq}`))
  const id = seed.variant(product, `E030N-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id)
  return { id, label, price }
}
const A=variant('A-root-200k',200_000), B=variant('B-root-200k',200_000), C=variant('C-root-300k',300_000), D=variant('D-root-300k',300_000)
const B1=variant('B1-220k',220_000), C1=variant('C1-290k',290_000), D1=variant('D1-290k',290_000)
const codes=[]
for(let i=1;i<=6;i++) {
  const issued=await storeCreditService.issueManual({amount:100_000,multiUse:true,maxUses:2,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,note:`E100-030 no-discount source-${i}`})
  const row=seed.one('SELECT id,code,amount,status,restrictScope FROM "StoreCredit" WHERE id=?',issued.id)
  codes.push({id:n(row.id),code:row.code,amount:n(row.amount),scope:row.restrictScope})
}
assert.ok(codes.every(code=>code.scope==='ALL'))
const sale=await salesService.create({
  userId,shiftId,
  lines:[A,B,C,D].map(item=>({variantId:item.id,qty:1,unitPrice:item.price,discount:0,tax:0})),
  invoiceDiscount:0,
  storeCredits:codes.map(code=>({code:code.code,requestedAmount:50_000})),
  payments:[{methodId:cash,amount:700_000,destination:'CASH'}],
  saleRequestIdempotencyKey:'e100-030-no-discount-root'
})
const rootInvoice=seed.one('SELECT id,grandTotal,discountTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
const rootItems=seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
const rootItem=item=>rootItems.find(row=>n(row.variantId)===item.id)
assert.equal(n(rootInvoice.grandTotal),1_000_000)
assert.equal(n(rootInvoice.discountTotal),0)
assert.equal(n(rootInvoice.paidTotal),1_000_000)

const returnedA=await salesService.createReturn({
  userId,shiftId,invoiceId:n(sale.id),full:false,
  lines:[{saleItemId:n(rootItem(A).id),qty:1}],refundMethod:RefundMethod.NONE,
  confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD
})
assert.equal(n(returnedA.total),200_000)
assert.equal(n(returnedA.sourceCreditRestoredAmount),200_000)
assert.equal(n(returnedA.refundAmount),0)
const returnALines=seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',returnedA.id).map(row=>({saleItemId:n(row.saleItemId),lineTotal:n(row.lineTotal)}))
const returnAAllocations=seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=? ORDER BY id',sale.id,returnedA.id).map(row=>({redemptionId:n(row.redemptionId),sourceCreditId:n(row.sourceCreditId),amount:n(row.amount),creditRestored:!!row.creditRestored}))

const exchangeB=await salesService.createExchange({
  userId,shiftId,invoiceId:n(sale.id),
  lines:[{saleItemId:n(rootItem(B).id),qty:1}],
  replacements:[{variantId:B1.id,qty:1,unitPrice:B1.price,discount:0,tax:0}],
  methodId:card,idempotencyKey:'e100-030-no-discount-B-to-B1'
})
assert.equal(n(exchangeB.returnTotal),200_000)
assert.equal(n(exchangeB.exchangeTotal),220_000)
assert.equal(n(exchangeB.diff),20_000)
assert.equal(n(exchangeB.cardReceived),20_000)
assert.equal(n(exchangeB.cashReceived),0)
const exchangeBReturn=seed.one('SELECT id,total,kind,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE id=?',exchangeB.returnId)
const exchangeBLines=seed.rows('SELECT saleItemId,lineTotal FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',exchangeB.returnId).map(row=>({saleItemId:n(row.saleItemId),lineTotal:n(row.lineTotal)}))
const exchangeBAllocations=seed.rows('SELECT id FROM "CreditReturnAllocation" WHERE invoiceId=? AND returnId=?',sale.id,exchangeB.returnId).map(row=>n(row.id))
assert.equal(exchangeBAllocations.length,0)

const snapshot=()=>JSON.stringify({
  invoiceCount:n(seed.one('SELECT COUNT(*) count FROM "SaleInvoice"').count),
  returnCount:n(seed.one('SELECT COUNT(*) count FROM "SaleReturn"').count),
  paymentCount:n(seed.one('SELECT COUNT(*) count FROM "Payment"').count),
  allocationCount:n(seed.one('SELECT COUNT(*) count FROM "CreditReturnAllocation"').count),
  stock:[A,B,C,D,B1,C1,D1].map(item=>[item.label,n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',item.id).stock)]),
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
    methodId:cash,refundMode:'CASH',idempotencyKey:'e100-030-no-discount-C-plus-D'
  })
} catch(error) { failure=String(error?.message??error) }
const afterAttempt=snapshot()
const expectedGate=`برگشت قبلی #${exchangeB.returnId} تخصیص منشأ اعتبار ندارد`
assert.equal(n(exchangeCD?.returnTotal),0,'negative C+D exchange should be stopped before a return is committed')
assert.ok(failure.includes(expectedGate),`unexpected no-discount C+D error: ${failure}`)
assert.equal(afterAttempt,beforeAttempt,'blocked C+D refund-path attempt must be mutation-free')

const checks={
  invoiceIs1mWithZeroDiscountAnd700kCash:n(rootInvoice.grandTotal)===1_000_000&&n(rootInvoice.discountTotal)===0&&n(rootInvoice.paidTotal)===1_000_000&&n(sale.storeCreditApplied)===300_000,
  returnAUsesGross200kAndRestores200k:n(returnedA.total)===200_000&&n(returnedA.sourceCreditRestoredAmount)===200_000&&returnALines[0]?.lineTotal===200_000&&returnAAllocations.reduce((s,r)=>s+r.amount,0)===200_000,
  exchangeBIsPlus20kAndActuallyCollected:n(exchangeB.returnTotal)===200_000&&n(exchangeB.exchangeTotal)===220_000&&n(exchangeB.diff)===20_000&&n(exchangeB.cardReceived)===20_000&&n(exchangeB.cashReceived)===0&&exchangeBLines[0]?.lineTotal===200_000,
  exchangeBHasNoSourceCreditSurplusAllocation:exchangeBAllocations.length===0,
  CDIsMinus20kAndRefundPathFailsAtSourceGate:600_000-580_000===20_000&&failure.includes(expectedGate),
  rejectedCDAttemptLeavesLedgerAndStockUnchanged:beforeAttempt===afterAttempt,
  noChecksOrDebt:seed.rows('SELECT id FROM "Payment" WHERE kind=\'CHEQUE\'').length===0
}
assert.ok(Object.values(checks).every(Boolean),`no-discount E100-030 checks: ${JSON.stringify(checks)}`)
const summary={
  generatedAt:new Date().toISOString(),isolatedDatabase:process.env.HARNESS_DB,verdict:'C+D_BLOCKED_AS_EXPECTED',checks,
  case:'E100-030 (fourth item in the 13-stop sequence; index 30)',
  fixture:{grossGoods:1_000_000,invoiceDiscount:0,netInvoice:1_000_000,creditTender:300_000,cashTender:700_000,barcodeCount:6,eachRedeemed:50_000,scope:'ALL'},
  operations:{
    returnA:{id:n(returnedA.id),total:n(returnedA.total),sourceCreditRestored:n(returnedA.sourceCreditRestoredAmount),cashRefund:n(returnedA.refundAmount),returnLines:returnALines,creditAllocations:returnAAllocations},
    exchangeB:{returnId:n(exchangeB.returnId),exchangeInvoiceId:n(exchangeB.exchangeInvoiceId),returnTotal:n(exchangeB.returnTotal),replacementTotal:n(exchangeB.exchangeTotal),diff:n(exchangeB.diff),cashReceived:n(exchangeB.cashReceived),cardReceived:n(exchangeB.cardReceived),returnRecord:exchangeBReturn,returnLines:exchangeBLines,creditAllocations:exchangeBAllocations}
  },
  attemptedCD:{returnValue:600_000,replacementValue:580_000,diff:-20_000,refundMode:'CASH',accepted:!!exchangeCD,error:failure,expectedError:expectedGate,mutationFree:beforeAttempt===afterAttempt,ledgerBefore:JSON.parse(beforeAttempt),ledgerAfter:JSON.parse(afterAttempt)},
  rootCause:{
    directGuard:'exchangeReturnFundingBuckets rejects a prior return when fundedReturn > creditRemoved, a CREDIT bucket remains, and that prior return has zero CreditReturnAllocation rows.',
    positiveBWritePath:'B->B1 has diff +20,000. SalesService.ts:7429 enters diff>0. That path records generic EXCHANGE_CREDIT for 200,000 and cash for 20,000, but does not persist the per-redemption allocation of B\'s 200,000 returned funding; in this fixture its 20,000 positive difference is paid by POS.',
    laterNegativeCDReadPath:'C+D has diff -20,000. SalesService.ts:7540 enters diff<0 and SalesService.ts:7585 calls exchangeReturnFundingBuckets. At lines 1816-1840 the prior B return is evaluated: fundedReturn=200,000, creditRemoved=0, remaining source credits exist, allocation rows=0, so the safe guard throws.',
    allocationWritePath:'The exchange-side CreditReturnAllocation.create at SalesService.ts:7701-7720 is inside the negative-difference refund branch and writes only backed CREDIT surplus after replacement consumption; the positive B exchange never enters it.',
    visitVsDocument:'The query considers earlier return documents by id, not elapsed time or customer visit. Separate B and C+D documents can therefore hit the guard even in one visit. A single consolidated exchange has no prior B return and avoids this specific condition.'
  },
  conclusion:'With no invoice discount, C+D has return value 600,000 and replacements 580,000, so the store owes 20,000. The exact root cause is a provenance-write/read mismatch: the positive B exchange records only generic exchange-credit tender, not per-redemption CreditReturnAllocation; the later negative C+D branch requires that allocation to safely reconstruct prior funding. The missing record is refused by a protective guard, and the attempted exchange rolls back mutation-free. The invoice discount does not fix this gap; it flips C+D to +40,000, taking the positive collection branch that does not invoke the guard.',
  safety:{isolatedDatabase:true,productionCodeChanged:false,liveDatabase:false,checksOrDebt:false,realMoneyMoved:false}
}
const reports=resolve(process.cwd(),'reports');mkdirSync(reports,{recursive:true})
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-no-discount.json'),JSON.stringify(summary,null,2)+'\n')
const fa=value=>Number(value??0).toLocaleString('fa-IR')
const md=[
  '# بررسی E100-030 بدون تخفیف', '',
  `**نتیجه:** C+D به‌درستی در گیت منشأ رد شد؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checkpoint پاس شد.`,
  `**DB:** SQLite موقت و ایزوله (${process.env.HARNESS_DB}).`, '',
  '## مبالغ و عملیات',
  '- فاکتور: ناخالص/خالص ۱٬۰۰۰٬۰۰۰، تخفیف صفر، پرداخت ۳۰۰٬۰۰۰ اعتبار ALL + ۷۰۰٬۰۰۰ نقد.',
  `- برگشت A: ${fa(returnedA.total)}؛ ${fa(returnedA.sourceCreditRestoredAmount)} اعتبار منبعی برگشت، بازپرداخت پول صفر.`,
  `- تعویض B به B1: برگشت ${fa(exchangeB.returnTotal)}، جایگزین ${fa(exchangeB.exchangeTotal)}؛ +${fa(exchangeB.diff)} با کارت‌خوان دریافت شد. برگشت B allocation منشأ اعتباری نداشت.`,
  `- تعویض C+D: برگشت ۶۰۰٬۰۰۰، جایگزین ۵۸۰٬۰۰۰؛ اختلاف **-۲۰٬۰۰۰**. درخواست با refundMode=CASH در گیت متوقف شد: ${failure}`,  '',
  '## علت ریشه‌ای در کد',
  '۱) تعویض B اختلاف مثبت +۲۰٬۰۰۰ دارد و در `SalesService.ts:7429` وارد شاخهٔ `diff > 0` می‌شود. سرویس روی فاکتور جایگزین ۲۰۰٬۰۰۰ «ارزش برگشتی» عمومی ثبت و ۲۰٬۰۰۰ نقد دریافت می‌کند؛ اما سهم ۲۰۰٬۰۰۰ برگشت B را به redemptionهای اعتبارِ منبع وصل و در `CreditReturnAllocation` ذخیره نمی‌کند. در دفتر این تست، برگشت B صفر allocation دارد.',
  '۲) تعویض C+D اختلاف منفی -۲۰٬۰۰۰ دارد و در `SalesService.ts:7540` وارد شاخهٔ `diff < 0` می‌شود. این شاخه در `:7585` `exchangeReturnFundingBuckets` را صدا می‌زند و برگشت‌های قبلی را به ترتیب سند بررسی می‌کند.',
  '۳) در `SalesService.ts:1816–1840` شرط توقف دقیقاً این است: برگشت قبلی funded باشد، allocation اعتباری از آن کم نشده باشد، هنوز منبع CREDIT در زنجیره وجود داشته باشد و لیست allocation آن برگشت خالی باشد. برای برگشت B در تست: funded=۲۰۰٬۰۰۰، allocation=۰، و credit source باقی‌مانده وجود دارد؛ پس سیستم از حدس‌زدن امتناع می‌کند. این گیت محافظ درست کار می‌کند؛ نقص قبلی‌تر این است که مسیر مثبت B، منشأ لازم برای زنجیرهٔ بعدی را ننوشته است.',
  'ردیف‌های `CreditReturnAllocation` برای exchange در `SalesService.ts:7701–7720` فقط داخل مسیر منفی و برای credit surplus پس از مصرف جایگزین نوشته می‌شوند؛ بنابراین مسیر مثبت B که تمام برگشتش را به جایگزین داده، این دفتر را ثبت نمی‌کند. ریشهٔ مشکل، ناهماهنگیِ ثبت منشأ در مسیر مثبت و الزام به خواندن همان منشأ در مسیر منفی بعدی است.',
  'این به تعداد روزها یا مراجعه‌ها ربط ندارد: query برگشت‌های قبلی را با `id < returnId` پیدا می‌کند. پس جدا ثبت کردن B و C+D در یک مراجعه هم همان رفتار را دارد. اگر همهٔ اقلام در یک exchange تجمیعی بیایند، «برگشت قبلی B» وجود ندارد و این شرط خاص فعال نمی‌شود.',
  'در اجرای با تخفیف، ارزش برگشت C+D برابر ۵۴۰٬۰۰۰ شد، پس نسبت به جایگزین ۵۸۰٬۰۰۰ مشتری ۴۰٬۰۰۰ بدهکار بود. این مسیرِ دریافت وجه است و گیت مخصوص بازپرداخت را اجرا نمی‌کند. بنابراین تخفیف مشکل را حل نکرد؛ علامت اختلاف را عوض کرد و مسیر دیگری را طی کرد.', '', 
  '## ایمنی و نتیجه',
  '- تلاش ردشده mutation-free بود: تعداد فاکتورها، برگشت‌ها، پرداخت‌ها، allocationها، موجودی و وضعیت اعتبارها قبل/بعد یکسان بود.',
  '- چک، بدهی یا وجه واقعی به‌کار نرفت؛ درخواست و همهٔ سندها روی DB تست موقت بودند. production code تغییر نکرد.',
  '- اجرای runner: ۷/۷ checkpoint پاس شد.'
]
writeFileSync(join(reports,'deep-e2e-scenario4-e100-030-no-discount.md'),md.join('\n')+'\n')
console.log(`E100-030 no-discount: C+D_BLOCKED_AS_EXPECTED; ${Object.keys(checks).length}/${Object.keys(checks).length}; return=600k; replacement=580k; diff=-20k; mutation-free`)
await db.$disconnect?.()
