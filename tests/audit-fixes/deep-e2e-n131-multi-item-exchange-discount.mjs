/* N131 policy-confirmed follow-up: invoice-level discount on a two-item sale,
 * then exchange one discounted item for 90k and 110k replacements (fresh DBs).
 */
import assert from 'node:assert/strict'
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'

const replacementPrice=Number(process.env.MAHAK_N131_REPLACEMENT)
assert.ok([90_000,110_000].includes(replacementPrice),'MAHAK_N131_REPLACEMENT must be 90000 or 110000')
const dir=mkdtempSync(join(tmpdir(),`mahak-n131-multi-${replacementPrice}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`N131 multi-item ${replacementPrice}`)
const shiftId=seed.insert('Shift',{name:`N131 multi-item ${replacementPrice}`,number:300+replacementPrice,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`N131-MULTI-${replacementPrice}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`N131 multi-item ${replacementPrice}`)
const productA=seed.product(`N131 source-A ${replacementPrice}`,category),productB=seed.product(`N131 source-B ${replacementPrice}`,category),productC=seed.product(`N131 replacement-C ${replacementPrice}`,category)
const sourceA=seed.variant(productA,'source-A'),sourceB=seed.variant(productB,'source-B'),replacement=seed.variant(productC,'replacement-C')
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=100000 WHERE id=?').run(sourceA)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=200000 WHERE id=?').run(sourceB)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(replacementPrice,replacement)
const line=(variantId,unitPrice,discount=0)=>({variantId,qty:1,unitPrice,discount,tax:0})
const out={scenario:`two-line discounted source; exchange A for ${replacementPrice}; replacement receives no explicit discount`,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const sale=await salesService.create({userId,shiftId,lines:[line(sourceA,100_000),line(sourceB,200_000)],invoiceDiscount:30_000,payments:[{methodId:cash,amount:270_000,destination:'CASH'}]})
 const root=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,status,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const sourceItem=items.find(x=>n(x.variantId)===sourceA)
 assert.ok(sourceItem);assert.equal(items.length,2)
 const preview=await salesService.previewExchangeFunding({invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[line(replacement,replacementPrice)]})
 assert.equal(preview.ok,true)
 const exchange=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[line(replacement,replacementPrice)],methodId:cash,managerPassword:DEFAULT_MANAGER_PASSWORD,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`n131-multi-${replacementPrice}`})
 const ret=seed.one('SELECT id,total,exchangeDiff,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
 const childPayments=seed.rows('SELECT p.amount,p.kind,m.kind methodKind,m.key FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? ORDER BY p.id',child.id)
 const raw=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const cashRefund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 const stock=[sourceA,sourceB,replacement].map((id,i)=>({name:['source A returned','source B retained','replacement C'][i],actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const checkCount=seed.count('Payment',`createdShiftId=? AND UPPER(kind) IN ('CHECK','CHEQUE')`,shiftId)
 const expectedDiff=replacementPrice-100_000 // source item's 10k invoice-discount share carries once
 const actualDiff=replacementPrice-90_000 // observed: source return 90k; replacement has no discount
 assert.equal(n(root.grandTotal),270_000);assert.equal(n(root.paidTotal),270_000);assert.equal(n(root.discountTotal),30_000)
 assert.equal(n(exchange.returnTotal),90_000,'10% of invoice discount (10,000) allocated to the 100,000 source line')
 assert.equal(n(ret.total),90_000)
 assert.equal(n(exchange.exchangeTotal),replacementPrice)
 assert.equal(n(exchange.diff),actualDiff);assert.equal(n(preview.effectiveDiff),actualDiff)
 assert.equal(n(child.grandTotal),replacementPrice);assert.equal(n(child.paidTotal),replacementPrice);assert.equal(n(child.discountTotal),0)
 assert.ok(root.settledAt!=null&&child.settledAt!=null)
 assert.equal(n(raw.cash),270_000+Math.max(actualDiff,0));assert.equal(n(raw.card),0)
 assert.equal(cashRefund,Math.max(-actualDiff,0));assert.equal(blue,n(raw.cash)-cashRefund)
 assert.deepEqual(stock.map(x=>x.actual),[10,9,9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(checkCount,0)
 out.status='PASS'
 out.sourceSale={items:[{name:'A',gross:100_000,discountShare:10_000,net:90_000},{name:'B',gross:200_000,discountShare:20_000,net:180_000}],invoiceGross:300_000,invoiceDiscount:30_000,netPaid:270_000}
 out.exchangedLine={sourceGross:100_000,sourceDiscountShare:10_000,sourceNetValue:n(exchange.returnTotal),replacementGross:replacementPrice,replacementExplicitDiscount:n(child.discountTotal),actualExchangeDiff:n(exchange.diff),policyExpectedDiff:expectedDiff,policyDelta:n(exchange.diff)-expectedDiff,cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),childPayments}
 out.reconciliation={rawCash:n(raw.cash),rawCard:n(raw.card),cashRefund,blue,reportTotals:report.totals,stock,cheques:checkCount}
}catch(error){out.status='FAIL';out.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const dirOut=resolve(process.cwd(),'reports','deep-e2e-n131-multi-item-exchange-discount');mkdirSync(dirOut,{recursive:true})
 const slug=replacementPrice===90_000?'replacement-90000':'replacement-110000'
 writeFileSync(join(dirOut,`${slug}.json`),JSON.stringify(out,null,2)+'\n')
 const md=[`# N131 چندقلمی — جایگزین ${replacementPrice.toLocaleString('fa-IR')} ریالی`,'',`**وضعیت اجرا و تطبیق:** ${out.status}`,`**SQLite مستقل:** ${out.isolatedDatabase}`,'',
 '## فاکتور چندقلمی','- قلم A: ۱۰۰٬۰۰۰ ریال؛ قلم B: ۲۰۰٬۰۰۰ ریال؛ جمع ناخالص ۳۰۰٬۰۰۰ ریال.','- تخفیف فاکتور ۳۰٬۰۰۰ ریال (۱۰٪)؛ فاکتور خالص و پرداخت نقدی کامل ۲۷۰٬۰۰۰ ریال.','- سهم متناسب تخفیف: A برابر ۱۰٬۰۰۰ و B برابر ۲۰٬۰۰۰؛ پس ارزش خالص A برای برگشت/تعویض ۹۰٬۰۰۰ است.','',
 '## تعویض قلم A','- قلم B در فاکتور اصلی باقی ماند؛ فقط A با کالای جایگزین عوض شد. روی جایگزین تخفیف صریحی وارد نشد تا انتقال خودکار سنجیده شود.',
 `- قیمت جایگزین: ${out.exchangedLine?.replacementGross??'—'}؛ برگشت خالص A: ${out.exchangedLine?.sourceNetValue??'—'}.`,
 `- اختلاف واقعی: ${out.exchangedLine?.actualExchangeDiff??'—'}؛ اختلاف موردانتظار با انتقال همان ۱۰٬۰۰۰ تخفیف: ${out.exchangedLine?.policyExpectedDiff??'—'}؛ فاصله: ${out.exchangedLine?.policyDelta??'—'}.`,
 `- دریافت/بازپرداخت نقد واقعی: ${out.exchangedLine?.cashReceived??'—'} / ${out.exchangedLine?.cashRefunded??'—'}.`,'',
 '## تطبیق',`- ${JSON.stringify(out.reconciliation??out.failure??null)}`,'',
 'تست فقط روی service layer و SQLite موقت انجام شد؛ قیمت جایگزین با رمز مدیر در fixture مجاز شد تا آزمایش سیاست تخفیف از گیت قیمت جدا بماند؛ production تغییر نکرد.' ]
 writeFileSync(join(dirOut,`${slug}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(out.status!=='PASS')process.exitCode=1
}
