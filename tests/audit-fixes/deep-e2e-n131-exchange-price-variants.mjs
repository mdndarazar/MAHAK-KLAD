/* N131 follow-up: invoice-discounted 100,000 source exchanged into two
 * undiscounted replacement prices (90,000 and 110,000), one fresh DB/run each.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const replacementPrice=Number(process.env.MAHAK_N131_REPLACEMENT)
assert.ok([90_000,110_000].includes(replacementPrice),'MAHAK_N131_REPLACEMENT must be 90000 or 110000')
const dir=mkdtempSync(join(tmpdir(),`mahak-n131-exchange-${replacementPrice}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`N131 exchange ${replacementPrice}`)
const shiftId=seed.insert('Shift',{name:`N131 exchange ${replacementPrice}`,number:replacementPrice,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`N131-${replacementPrice}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`N131 replacement ${replacementPrice}`)
const sourceProduct=seed.product(`N131 source ${replacementPrice}`,category)
const replacementProduct=seed.product(`N131 replacement product ${replacementPrice}`,category)
const source=seed.variant(sourceProduct,'discounted-source'),replacement=seed.variant(replacementProduct,`replacement-${replacementPrice}`)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=100000 WHERE id=?').run(source)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(replacementPrice,replacement)
const result={scenario:`N131 source 100000 with invoice discount 10000 -> undiscounted replacement ${replacementPrice}`,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:[{variantId:source,qty:1,unitPrice:100_000,discount:0,tax:0}],invoiceDiscount:10_000,payments:[{methodId:cash,amount:90_000,destination:'CASH'}]})
 const sourceItem=seed.one('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
 const preview=await salesService.previewExchangeFunding({invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}]})
 assert.equal(preview.ok,true)
 const operation=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}],methodId:cash,refundMode:n(preview.effectiveDiff)<0?'CASH':undefined,expectedSettlementDiff:n(preview.effectiveDiff),managerPassword:DEFAULT_MANAGER_PASSWORD,idempotencyKey:`n131-price-${replacementPrice}`})
 const root=seed.one('SELECT grandTotal,paidTotal,discountTotal,status,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE id=?',operation.exchangeInvoiceId)
 const returnRow=seed.one('SELECT total,exchangeDiff,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',operation.returnId)
 const raw=seed.one(`SELECT
 COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
 FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const refund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 const stocks=[source,replacement].map((id,i)=>({name:i?'replacement':'source',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const chequeCount=seed.count('Payment',`createdShiftId=? AND UPPER(kind) IN ('CHECK','CHEQUE')`,shiftId)
 result.sale={gross:100_000,invoiceDiscount:n(root.discountTotal),net:n(root.grandTotal),paid:n(root.paidTotal)}
 result.exchange={sourceVariant:source,replacementVariant:replacement,replacementGross:replacementPrice,replacementDiscount:n(child.discountTotal),sourceReturnValue:n(operation.returnTotal),previewDiff:n(preview.effectiveDiff),committedDiff:n(operation.diff),cashReceived:n(operation.cashReceived),cashRefunded:n(operation.cashRefunded),refundMethod:returnRow.refundMethod,childInvoiceId:n(child.id),childItems:seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',child.id)}
 result.ledgers={rawCash:n(raw.cash),rawCard:n(raw.card),cashRefund:refund,blue,reportTotals:report.totals,stock:stocks,cheques:chequeCount}
 assert.equal(n(operation.returnTotal),90_000,'source return value must be net of invoice discount')
 assert.equal(n(operation.exchangeTotal),replacementPrice)
 assert.equal(n(operation.diff),n(preview.effectiveDiff))
 assert.equal(n(root.grandTotal),90_000);assert.equal(n(root.paidTotal),90_000)
 assert.equal(n(child.grandTotal),replacementPrice);assert.equal(n(child.paidTotal),replacementPrice)
 for(const inv of [root,child])assert.ok(inv.settledAt!=null)
 assert.equal(n(raw.cash),90_000+Math.max(n(operation.diff),0))
 assert.equal(n(raw.card),0)
 assert.equal(refund,Math.max(-n(operation.diff),0))
 assert.equal(blue,n(raw.cash)-refund)
 assert.deepEqual(stocks.map(x=>x.actual),[10,9])
 for(const x of stocks)assert.equal(x.actual,10+x.ledger)
 assert.equal(chequeCount,0)
 result.status='PASS'
 result.sale={gross:100_000,invoiceDiscount:n(root.discountTotal),net:n(root.grandTotal),cashPaid:n(root.paidTotal)}
 result.exchange={replacementGross:replacementPrice,replacementDiscount:n(child.discountTotal),sourceReturnValue:n(operation.returnTotal),previewDiff:n(preview.effectiveDiff),committedDiff:n(operation.diff),cashReceived:n(operation.cashReceived),cashRefunded:n(operation.cashRefunded),refundMethod:returnRow.refundMethod}
 result.ledgers={rawCash:n(raw.cash),rawCard:n(raw.card),cashRefund:refund,blue,reportTotals:report.totals,stock:stocks,cheques:chequeCount}
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-n131-exchange-price-variants');mkdirSync(outdir,{recursive:true})
 const slug=replacementPrice===90_000?'replacement-90000':'replacement-110000'
 writeFileSync(join(outdir,`${slug}.json`),JSON.stringify(result,null,2)+'\n')
 const md=[`# N131: تعویض با جایگزین ${replacementPrice.toLocaleString('fa-IR')} ریالی`,'',`**نتیجه:** ${result.status}`,`**SQLite ایزوله:** ${result.isolatedDatabase}`,'',
 '## ورودی','- کالای مبدأ: قیمت ۱۰۰٬۰۰۰؛ تخفیف فاکتور ۱۰٬۰۰۰؛ مبلغ خالص پرداخت‌شده ۹۰٬۰۰۰.','- کالای جایگزین: بدون تخفیف صریح در درخواست تعویض.',
 '','## مشاهدهٔ سیستم',`- ارزش برگشت مبدأ (پس از سهم تخفیف): ${result.exchange?.sourceReturnValue??'—'}.`,`- قیمت جایگزین: ${result.exchange?.replacementGross??'—'}؛ تخفیف ثبت‌شده روی فاکتور جایگزین: ${result.exchange?.replacementDiscount??'—'}.`,`- اختلاف واقعی تعویض: ${result.exchange?.committedDiff??'—'}؛ نقد دریافتی: ${result.exchange?.cashReceived??'—'}؛ نقد برگشتی: ${result.exchange?.cashRefunded??'—'}.`,'',
 '## تطبیق',`- ${JSON.stringify(result.ledgers??result.failure??null)}`,'','بدون تغییر در production؛ یک دیتابیس آزمایشی مستقل برای این قیمت جایگزین.']
 writeFileSync(join(outdir,`${slug}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
