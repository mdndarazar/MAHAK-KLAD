/* Four equal-price goods, seller invoice-wide discount, one partial return;
 * select store-credit barcode instead of cash. Isolated SQLite only.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-seller-discount-multi-return-barcode-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user('seller discount return barcode probe')
const shiftId=seed.insert('Shift',{name:'seller discount return barcode',number:9352,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'SELLER-DISCOUNT-BARCODE-PROBE-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category('seller discount return barcode probe')
const variants=['A-returned','B-kept','C-kept','D-kept'].map(name=>{const p=seed.product(`barcode-${name}`,category),v=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=10000000 WHERE id=?').run(v);return v})
const result={scenario:'4 x 10m; invoice discount 10m; return one item to STORE_CREDIT barcode',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const totalGross=40_000_000,invoiceDiscount=10_000_000,netPaid=30_000_000,expectedShare=2_500_000,expectedCredit=7_500_000
 const sale=await salesService.create({userId,shiftId,lines:variants.map(variantId=>({variantId,qty:1,unitPrice:10_000_000,discount:0,tax:0})),invoiceDiscount,payments:[{methodId:cash,amount:netPaid,destination:'CASH'}]})
 const invoice=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const item=items.find(i=>n(i.variantId)===variants[0])
 const retResult=await salesService.createReturn({userId,shiftId,invoiceId:n(invoice.id),full:false,lines:[{saleItemId:n(item.id),qty:1}],refundMethod:'STORE_CREDIT',creditDays:30})
 const ret=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,voidedAt FROM "SaleReturn" WHERE id=?',retResult.id)
 const credits=seed.rows('SELECT id,code,amount,usedAmount,status,source,restrictScope,returnId,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id',retResult.id)
 const creditTotal=credits.reduce((s,c)=>s+n(c.amount),0)
 const physicalRefund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type='RETURN_REFUND'",shiftId).amount)
 const physicalCashIn=n(seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "Payment" WHERE createdShiftId=? AND methodId=? AND kind=\'CASH\' AND voidedAt IS NULL',shiftId,cash).amount)
 const stock=variants.map((id,i)=>({name:['A returned','B kept','C kept','D kept'][i],actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 result.sale={gross:totalGross,invoiceDiscount,net:n(invoice.grandTotal),paid:n(invoice.paidTotal),lineCount:items.length}
 result.return={grossLinePrice:10_000_000,allocatedInvoiceDiscountShare:expectedShare,storedTotal:n(ret.total),refundMethod:ret.refundMethod,returnRecordRefundAmount:n(ret.refundAmount),returnRecordStoreCreditAmount:n(ret.refundStoreCreditAmount),actualCashRefund:physicalRefund}
 result.barcodeCredit={count:credits.length,totalAmount:creditTotal,amounts:credits.map(c=>n(c.amount)),statuses:credits.map(c=>c.status),sources:credits.map(c=>c.source),scopes:credits.map(c=>c.restrictScope),usedAmounts:credits.map(c=>n(c.usedAmount)),expiresAt:credits.map(c=>c.expiresAt==null?null:n(c.expiresAt)),hasRedeemableBarcode:credits.every(c=>typeof c.code==='string'&&c.code.length>0)}
 result.reconciliation={cashRefundMovement:physicalRefund,cashInitiallyReceived:physicalCashIn,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)}
 assert.equal(n(invoice.grandTotal),netPaid);assert.equal(n(invoice.paidTotal),netPaid);assert.equal(n(invoice.discountTotal),invoiceDiscount);assert.equal(items.length,4)
 assert.equal(n(ret.total),expectedCredit);assert.equal(n(ret.refundAmount),expectedCredit)
 assert.equal(creditTotal,expectedCredit);assert.ok(credits.length>0);assert.ok(result.barcodeCredit.hasRedeemableBarcode)
 assert.equal(physicalRefund,0);assert.equal(physicalCashIn,netPaid);assert.equal(blue,netPaid)
 assert.deepEqual(stock.map(x=>x.actual),[10,9,9,9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(result.reconciliation.cheques,0)
 result.status='PASS'
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-seller-invoice-discount-multi-item-return-barcode');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,'result.json'),JSON.stringify(result,null,2)+'\n')
 const md=[
 '# برگشت یک قلم از فاکتور چندقلمی با صدور بارکد اعتبار','',`**وضعیت اجرا و reconciliation:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## ورودی','- چهار قلم ۱۰٬۰۰۰٬۰۰۰ ریالی؛ جمع ناخالص ۴۰٬۰۰۰٬۰۰۰ ریال.','- تخفیف کلی فاکتور ۱۰٬۰۰۰٬۰۰۰ ریال؛ مبلغ خالص و پرداخت نقدی ۳۰٬۰۰۰٬۰۰۰ ریال.','- یک قلم برگشت خورد؛ روش بازپرداخت STORE_CREDIT با مهلت ۳۰ روز انتخاب شد.',
 '','## نتیجهٔ بارکد اعتبار',`- سهم تخفیف قلم: ${result.return?.allocatedInvoiceDiscountShare??'—'} ریال.`,`- مبلغ خود برگشت: ${result.return?.storedTotal??'—'} ریال.`,`- مجموع اعتبار بارکدی صادرشده: ${result.barcodeCredit?.totalAmount??'—'} ریال؛ تعداد بارکد: ${result.barcodeCredit?.count??'—'}.`,`- روش انتخاب‌شده: ${result.return?.refundMethod??'—'}؛ مبلغ ثبت‌شده در سند برگشت: ${result.return?.storedTotal??'—'} ریال؛ وجه نقد واقعیِ خارج‌شده: ${result.reconciliation?.cashRefundMovement??'—'} ریال.`,
 `- ${result.status==='PASS'?'تأیید شد: بارکد اعتبار نیز ۷٬۵۰۰٬۰۰۰ ریال است؛ سهم ۲٬۵۰۰٬۰۰۰ ریالی تخفیف از مبلغ ناخالص قلم کسر شده و به بارکد برگشت اعتباری داده نشد.':'تست با خطا مواجه شد؛ جزئیات خام را ببینید.'}`,'',
 '## تطبیق',`- ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'بارکد واقعی فقط در SQLite موقت ساخته شد و مقدار/وضعیتش گزارش شد؛ مقدار redeemable code افشا نشده است. هیچ production/staging، دیتابیس واقعی یا وجه واقعی درگیر نبود و هیچ منطق production تغییر نکرد.' ]
 writeFileSync(join(outdir,'summary.md'),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
