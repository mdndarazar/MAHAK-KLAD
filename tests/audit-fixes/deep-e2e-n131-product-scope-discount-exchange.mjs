/* Tests whether a variant-scoped bulk discount explains no discount on an
 * excluded exchange replacement. Two fresh DBs: replacement included/excluded.
 */
import assert from 'node:assert/strict'
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'

const replacementScope=String(process.env.MAHAK_N131_SCOPE??'').toUpperCase()
assert.ok(['INCLUDED','EXCLUDED'].includes(replacementScope),'MAHAK_N131_SCOPE must be INCLUDED or EXCLUDED')
const dir=mkdtempSync(join(tmpdir(),`mahak-n131-product-scope-${replacementScope.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {priceAdjustService}=await import('../../src/main/services/PriceAdjustService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`N131 variant-scoped discount ${replacementScope}`)
const shiftId=seed.insert('Shift',{name:`N131 scope ${replacementScope}`,number:500+(replacementScope==='INCLUDED'?1:2),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`N131-SCOPE-${replacementScope}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`N131 scope ${replacementScope}`)
function makeVariant(name,price){const p=seed.product(`N131-${replacementScope}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const A=makeVariant('A-source',100_000),B=makeVariant('B-kept',200_000),A1=makeVariant('A1-eligible',100_000),C=makeVariant('C-not-eligible',100_000)
const scopedVariants=replacementScope==='INCLUDED'?[A,B,A1]:[A,B]
const result={scenario:`variant-scoped 10% product discount; replacement ${replacementScope.toLowerCase()} in scope`,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const batch=await priceAdjustService.apply({kind:'DISCOUNT',mode:'PERCENT',value:10,scope:'VARIANTS',variantIds:scopedVariants,userId,password:DEFAULT_MANAGER_PASSWORD,note:`N131 eligibility probe ${replacementScope}`})
 const priceOf=id=>n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?',id).salePrice)
 const discountedIds=seed.rows('SELECT variantId FROM "PriceChangeItem" WHERE batchId=? ORDER BY variantId',batch.batchId).map(x=>n(x.variantId))
 const active=await priceAdjustService.activeDiscounts({variantIds:[A,B,A1,C]})
 const activeIds=active.map(x=>n(x.variantId)).sort((x,y)=>x-y)
 const replacement=replacementScope==='INCLUDED'?A1:C
 const replacementPrice=priceOf(replacement)
 assert.deepEqual(discountedIds.slice().sort((x,y)=>x-y),scopedVariants.slice().sort((x,y)=>x-y))
 assert.equal(priceOf(A),90_000);assert.equal(priceOf(B),180_000)
 assert.equal(priceOf(A1),replacementScope==='INCLUDED'?90_000:100_000)
 assert.equal(priceOf(C),100_000)
 const saleTotal=priceOf(A)+priceOf(B)
 const sale=await salesService.create({userId,shiftId,lines:[{variantId:A,qty:1,unitPrice:priceOf(A),discount:0,tax:0},{variantId:B,qty:1,unitPrice:priceOf(B),discount:0,tax:0}],payments:[{methodId:cash,amount:saleTotal,destination:'CASH'}]})
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const sourceItem=items.find(i=>n(i.variantId)===A)
 const preview=await salesService.previewExchangeFunding({invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}]})
 assert.equal(preview.ok,true)
 const exchange=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:n(sourceItem.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}],methodId:cash,managerPassword:DEFAULT_MANAGER_PASSWORD,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`n131-scope-${replacementScope}`})
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
 const returnRow=seed.one('SELECT total,exchangeDiff,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
 const raw=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const refund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const blue=n(await physicalMovementForCustodyShift(shiftId)),report=await salesService.reportRows({shiftId})
 const stock=[A,B,A1,C].map((id,i)=>({name:['A source returned','B kept','A1 eligible option','C excluded option'][i],actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const expectedDiff=replacementScope==='INCLUDED'?0:10_000
 assert.equal(n(exchange.returnTotal),90_000);assert.equal(n(returnRow.total),90_000)
 assert.equal(n(exchange.exchangeTotal),replacementPrice);assert.equal(n(exchange.diff),expectedDiff);assert.equal(n(preview.effectiveDiff),expectedDiff)
 assert.equal(n(child.grandTotal),replacementPrice);assert.equal(n(child.paidTotal),replacementPrice);assert.equal(n(child.discountTotal),0);assert.ok(child.settledAt!=null)
 assert.equal(n(raw.cash),saleTotal+Math.max(expectedDiff,0));assert.equal(n(raw.card),0);assert.equal(refund,Math.max(-expectedDiff,0));assert.equal(blue,n(raw.cash)-refund)
 assert.deepEqual(stock.map(x=>x.actual),[10,9,replacement===A1?9:10,replacement===C?9:10]);for(const s of stock)assert.equal(s.actual,10+s.ledger)
 result.status='PASS'
 result.priceAdjustment={batchId:batch.batchId,title:batch.title,kind:'DISCOUNT',mode:'PERCENT',percent:10,scope:'VARIANTS',scopedIds:scopedVariants,changedIds:discountedIds,activeDiscountVariantIds:activeIds,prices:{A:priceOf(A),B:priceOf(B),A1:priceOf(A1),C:priceOf(C)}}
 result.sale={items:[{name:'A',salePrice:priceOf(A),paidLine:n(items.find(i=>n(i.variantId)===A).lineTotal)},{name:'B',salePrice:priceOf(B),paidLine:n(items.find(i=>n(i.variantId)===B).lineTotal)}],total:saleTotal,paid:n(seed.one('SELECT paidTotal FROM "SaleInvoice" WHERE id=?',sale.id).paidTotal)}
 result.exchange={replacementScope,replacementVariantId:replacement,replacementPrice,sourceReturnValue:n(exchange.returnTotal),actualDiff:n(exchange.diff),cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),childDiscount:n(child.discountTotal),returnMethod:returnRow.refundMethod}
 result.interpretation=replacementScope==='INCLUDED'?'Replacement A1 was actually included in the active variant-scoped discount; its sale price fell to 90,000 and the exchange difference was zero.':'Replacement C was explicitly outside the active variant-scoped discount; it stayed at 100,000 and the system charged a 10,000 difference. This is consistent with a product-specific discount that does not apply to excluded SKUs; it does not answer the separate invoice-level N131 policy.'
 result.reconciliation={rawCash:n(raw.cash),rawCard:n(raw.card),refund,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND UPPER(kind) IN ('CHECK','CHEQUE')`,shiftId)}
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-n131-product-scope-discount');mkdirSync(outdir,{recursive:true})
 const slug=replacementScope.toLowerCase()
 writeFileSync(join(outdir,`${slug}.json`),JSON.stringify(result,null,2)+'\n')
 const md=[`# N131 product-scope probe — replacement ${slug}`,'',`**اجرای reconciliation:** ${result.status}`,`**SQLite:** ${result.isolatedDatabase}`,'',
 '## تخفیف محصول‌محور','- PriceAdjust واقعی با kind=DISCOUNT، mode=PERCENT، value=10 و scope=VARIANTS اعمال شد.','- در هر دو اجرا A و B داخل scope بودند؛ A از ۱۰۰٬۰۰۰ به ۹۰٬۰۰۰ و B از ۲۰۰٬۰۰۰ به ۱۸۰٬۰۰۰ رسید.','- جایگزین A1 فقط در اجرای included داخل scope بود؛ جایگزین C در اجرای excluded بیرون scope ماند.',
 '','## مشاهدهٔ برگشت/تعویض',`- ${JSON.stringify(result.exchange??result.failure??null)}`,`- PriceAdjust: ${JSON.stringify(result.priceAdjustment??null)}`,'',
 '## تطبیق',`- ${JSON.stringify(result.reconciliation??null)}`,'',
 'این آزمون دربارهٔ تخفیف گروهیِ مختص SKUهاست؛ N131 قبلی تخفیف invoice-level داشت. دو نوع تخفیف عمداً از هم تفکیک شده‌اند. فقط SQLite موقت؛ بدون پول یا DB واقعی/staging و بدون تغییر production.']
 writeFileSync(join(outdir,`${slug}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
