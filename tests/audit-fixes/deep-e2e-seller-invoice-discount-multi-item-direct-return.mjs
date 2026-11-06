/* Direct partial return after a seller-entered invoice-wide discount.
 * Four equal-price lines; return exactly one. Isolated temporary SQLite only.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-seller-discount-multi-direct-return-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user('seller-discount multi-item direct return')
const shiftId=seed.insert('Shift',{name:'seller-discount multi direct return',number:9351,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'SELLER-DISCOUNT-MULTI-RETURN-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category('seller discount multi direct return')
const variants=['A-returned','B-kept','C-kept','D-kept'].map(name=>{const p=seed.product(`discount-return-${name}`,category),v=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=10000000 WHERE id=?').run(v);return v})
const result={scenario:'4 lines x 10m; invoice-level discount 10m; direct cash return of one line',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const totalGross=40_000_000,invoiceDiscount=10_000_000,netPaid=30_000_000
 const sale=await salesService.create({userId,shiftId,lines:variants.map(variantId=>({variantId,qty:1,unitPrice:10_000_000,discount:0,tax:0})),invoiceDiscount,payments:[{methodId:cash,amount:netPaid,destination:'CASH'}]})
 const invoice=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const returnedItem=items.find(i=>n(i.variantId)===variants[0])
 const returnOperation=await salesService.createReturn({userId,shiftId,invoiceId:n(invoice.id),full:false,lines:[{saleItemId:n(returnedItem.id),qty:1}],refundMethod:'CASH'})
 const ret=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,voidedAt FROM "SaleReturn" WHERE id=?',returnOperation.id)
 const refundCash=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type='RETURN_REFUND'",shiftId).amount)
 const payments=seed.rows('SELECT p.amount,p.kind,m.kind methodKind,m.key FROM "Payment" p LEFT JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? ORDER BY p.id',shiftId)
 const stock=variants.map((id,i)=>({name:['A returned','B kept','C kept','D kept'][i],actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 const expectedDiscountShare=Math.round(invoiceDiscount*10_000_000/totalGross),expectedRefund=10_000_000-expectedDiscountShare
 result.sale={gross:totalGross,invoiceDiscount,net: n(invoice.grandTotal),paid:n(invoice.paidTotal),lineCount:items.length,lineGrossPrices:items.map(i=>n(i.unitPrice))}
 result.return={returnedVariantId:n(returnedItem.variantId),grossLinePrice:10_000_000,allocatedInvoiceDiscountShare:expectedDiscountShare,storedReturnTotal:n(ret.total),refundMethod:ret.refundMethod,actualCashRefund:n(ret.refundAmount),storeCredit:n(ret.refundStoreCreditAmount)}
 result.reconciliation={cashRefundMovement:refundCash,rawPayments:payments,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)}
 assert.equal(n(invoice.grandTotal),netPaid);assert.equal(n(invoice.paidTotal),netPaid);assert.equal(n(invoice.discountTotal),invoiceDiscount)
 assert.equal(items.length,4)
 assert.equal(n(ret.total),expectedRefund);assert.equal(n(ret.refundAmount),expectedRefund);assert.equal(refundCash,expectedRefund)
 assert.equal(blue,netPaid-expectedRefund)
 assert.deepEqual(stock.map(x=>x.actual),[10,9,9,9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(result.reconciliation.cheques,0)
 result.status='PASS'
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-seller-invoice-discount-multi-item-direct-return');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,'result.json'),JSON.stringify(result,null,2)+'\n')
 const md=[
 '# برگشت مستقیم یک قلم از فاکتور چندقلمی با تخفیف کلی فروشنده','',`**وضعیت اجرا و reconciliation:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## فاکتور آزمایشی','- چهار قلم جداگانه، هرکدام ۱۰٬۰۰۰٬۰۰۰ ریال؛ جمع ناخالص ۴۰٬۰۰۰٬۰۰۰ ریال.','- تخفیف کلی فاکتور ۱۰٬۰۰۰٬۰۰۰ ریال؛ مبلغ خالص/پرداخت‌شده ۳۰٬۰۰۰٬۰۰۰ ریال.','- فقط قلم A برگشت خورد؛ B، C و D نزد مشتری ماندند.','',
 '## مقدار برگشت',`- سهم نسبتی تخفیف هر قلم: ${result.return?.allocatedInvoiceDiscountShare??'—'} ریال.`,`- مبلغ ثبت‌شدهٔ برگشت: ${result.return?.storedReturnTotal??'—'} ریال.`,`- وجه نقدی که واقعاً برگشت: ${result.return?.actualCashRefund??'—'} ریال.`,`- پاسخ: ${result.return?.storedReturnTotal===7_500_000?'سیستم سهم تخفیف را حساب کرد؛ برای قلم برگشتی ۷٬۵۰۰٬۰۰۰ ریال برگرداند.':'نتیجه با محاسبهٔ سهم نسبتیِ fixture برابر نبود؛ جزئیات خام را ببینید.'}`,'',
 '## تطبیق دفترها و موجودی',`- ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'فقط SQLite موقت و ایزوله؛ هیچ دیتابیس واقعی/staging یا وجه واقعی استفاده نشد و production تغییر نکرد.'
 ]
 writeFileSync(join(outdir,'summary.md'),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
