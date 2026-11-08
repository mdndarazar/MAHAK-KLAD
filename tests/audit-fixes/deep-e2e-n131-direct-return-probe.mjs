/* Focused follow-up to N131: sold a 100,000 item for net 90,000 after
 * a 10,000 invoice discount, then directly return the item and observe the
 * recorded return total/refund. One isolated temporary SQLite DB only.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-n131-direct-return-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db=harnessClient(), seed=makeSeeder(db), sql=db.$harness.db, n=x=>Number(x??0)
const userId=seed.user('N131 direct return observer')
const shiftId=seed.insert('Shift',{name:'N131 direct return isolated',number:131,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'N131-DIRECT-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category('N131 direct return category')
const product=seed.product('N131 direct return item',category)
const variant=seed.variant(product,'N131-DIRECT')
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=100000 WHERE id=?').run(variant)
const expected={cashIn:90_000,discount:10_000,initialStock:10}
const result={scenario:'N131 follow-up: direct return after invoice-level discount',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING',fixture:{stickerPrice:100_000,invoiceDiscount:10_000,netPaid:90_000}}
try{
 const sale=await salesService.create({userId,shiftId,lines:[{variantId:variant,qty:1,unitPrice:100_000,discount:0,tax:0}],invoiceDiscount:10_000,payments:[{methodId:cash,amount:90_000,destination:'CASH'}]})
 const invoice=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,status,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const item=seed.one('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
 const saleBeforeReturn={grandTotal:n(invoice.grandTotal),paidTotal:n(invoice.paidTotal),discount:n(invoice.discountTotal),status:invoice.status,settled:invoice.settledAt!=null}
 const returned=await salesService.createReturn({userId,shiftId,invoiceId:n(invoice.id),full:true,lines:[{saleItemId:n(item.id),qty:1}],refundMethod:'CASH'})
 const returnRow=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,returnedAt,voidedAt FROM "SaleReturn" WHERE id=?',returned.id)
 const rawCash=n(seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "Payment" WHERE createdShiftId=? AND kind='CASH' AND methodId=? AND voidedAt IS NULL`,shiftId,cash).amount)
 const rawRefund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type='RETURN_REFUND'",shiftId).amount)
 const stock=n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',variant).stock)
 const stockLedger=n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',variant).d)
 const report=await salesService.reportRows({shiftId})
 const blue=n(await physicalMovementForCustodyShift(shiftId))
 const checkCount=seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)
 result.status='PASS'
 result.sale={invoiceId:n(invoice.id),itemId:n(item.id),gross:100_000,discount:n(invoice.discountTotal),net:n(invoice.grandTotal),paid:n(invoice.paidTotal),settled:invoice.settledAt!=null}
 result.return={id:n(returnRow.id),storedTotal:n(returnRow.total),method:returnRow.refundMethod,refundAmount:n(returnRow.refundAmount),returnCredit:n(returnRow.refundStoreCreditAmount)}
 result.answer={systemCountsReturnedItemAs:n(returnRow.total),cashActuallyRefunded:n(returnRow.refundAmount),directCashReturn:returned.refundMethod??returnRow.refundMethod}
 result.reconciliation={expectedCashIn:expected.cashIn,rawCashIn:rawCash,rawCashRefund:rawRefund,reportTotals:report.totals,blue,stock:{initial:10,actual:stock,ledger:stockLedger},checks:checkCount}
 if(rawCash!==expected.cashIn||rawRefund!==n(returnRow.refundAmount)||stock!==10||stock!==10+stockLedger||checkCount!==0)throw new Error('Direct-return ledgers did not reconcile; see observed result fields.')
}catch(error){result.status='BLOCKED_OR_FAILED';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const out=resolve(process.cwd(),'reports','deep-e2e-n131-direct-return')
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'N131-direct-return.json'),JSON.stringify(result,null,2)+'\n')
 const md=[
 '# پیگیری محدود N131 — برگشت مستقیم پس از تخفیف فاکتور','',
 `**وضعیت:** ${result.status}`,`**SQLite موقت ایزوله:** ${result.isolatedDatabase}`,'',
 '## پرسش و مثال','- قیمت برچسب کالا: ۱۰۰٬۰۰۰ ریال.','- تخفیف روی فاکتور: ۱۰٬۰۰۰ ریال.','- مبلغ خالص فاکتور و وجه نقد پرداخت‌شده: ۹۰٬۰۰۰ ریال.','- سپس همان کالا با روش برگشت CASH مستقیماً برگشت خورد؛ بدون تعویض.','',
 `## عدد ثبت‌شدهٔ برگشت`,`- مبلغ کل برگشت در سند: ${result.return?.storedTotal??'ثبت نشد'} ریال.`,`- مبلغ نقد واقعاً برگشتی: ${result.return?.refundAmount??'ثبت نشد'} ریال.`,`- پاسخ دقیق به سؤال: سیستم مبلغ کالا را ${result.answer?.systemCountsReturnedItemAs??'—'} ریال حساب کرد و ${result.answer?.cashActuallyRefunded??'—'} ریال نقد برگرداند.`, '',
 `## تطبیق`,`- ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'این فقط یک آزمایش مستقیم برگشت برای روشن‌کردن مبلغ ثبت‌شده بود؛ N131 اصلی دربارهٔ تعویض بود. در این پیگیری هیچ سیاستی تغییر یا اصلاح نشد.'
 ]
 writeFileSync(join(out,'N131-direct-return.md'),md.join('\n')+'\n')
 await db.$disconnect?.()
 if(result.status!=='PASS')process.exitCode=1
}
