/* Isolated tests for manager invoice-level discount, per-line discount, and exchange handling. */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const key=String(process.env.MAHAK_INVOICE_ITEM_DISCOUNT_CASE??'').toUpperCase()
const cases=['PRICE-ADJUST-ALL-100','INVOICE-PERCENT-100-LINES','LINE-PERCENT-100-LINES','LINE-PERCENT-QTY-100','FIXED-PER-LINE-REJECT',...['EQUAL','HIGH','LOW'].flatMap(x=>[`EXCHANGE-UI-${x}`,`EXCHANGE-EXPLICIT-${x}`])]
assert.ok(cases.includes(key),`MAHAK_INVOICE_ITEM_DISCOUNT_CASE must be one of: ${cases.join(', ')}`)
const dir=mkdtempSync(join(tmpdir(),`mahak-invoice-item-discount-${key.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {priceAdjustService}=await import('../../src/main/services/PriceAdjustService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {SETTING_KEYS}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`invoice item discount ${key}`)
const shiftId=seed.insert('Shift',{name:`invoice item discount ${key}`,number:8700+cases.indexOf(key),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`IID-${key}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`invoice item discount ${key}`)
let seq=0
function variant(name,price,stock=200){const p=seed.product(`IID-${key}-${++seq}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock,price,id);return id}
function policy(value){return{mode:'FIXED',fixedMode:'PERCENT',fixedValue:value,allowLine:false,allowInvoice:true,maxPercent:100,maxAmount:0,wholesaleMaxPercent:100,wholesaleMaxAmount:0}}
function freeLinePolicy(){return{mode:'FREE',fixedMode:'PERCENT',fixedValue:0,allowLine:true,allowInvoice:true,maxPercent:10,maxAmount:0,wholesaleMaxPercent:100,wholesaleMaxAmount:0}}
function configurePolicy(value=10){seed.setting(SETTING_KEYS.discountPolicy,policy(value))}
const result={case:key,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 if(key==='PRICE-ADJUST-ALL-100'){
   const variants=Array.from({length:100},(_,i)=>variant(`sku-${i+1}`,100_000))
   const applied=await priceAdjustService.apply({kind:'DISCOUNT',mode:'PERCENT',value:10,scope:'ALL',target:'SALE',userId,password:DEFAULT_MANAGER_PASSWORD,note:'100 line bulk price-adjust probe'})
   const prices=variants.map(id=>n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?',id).salePrice))
   assert.equal(applied.changedCount,100);assert.ok(prices.every(x=>x===90_000))
   const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:variants.map(variantId=>({variantId,qty:1,unitPrice:90_000,discount:0,tax:0})),payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})
   const inv=seed.one('SELECT goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
   const itemAgg=seed.one('SELECT COUNT(*) count,SUM(unitPrice) gross,SUM(discount) discount,SUM(lineTotal) lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
   assert.equal(n(inv.goodsTotal),9_000_000);assert.equal(n(inv.discountTotal),0);assert.equal(n(inv.grandTotal),9_000_000);assert.equal(n(inv.paidTotal),9_000_000)
   assert.equal(n(itemAgg.count),100);assert.equal(n(itemAgg.gross),9_000_000);assert.equal(n(itemAgg.discount),0);assert.equal(n(itemAgg.lineTotal),9_000_000)
   result.status='PASS';result.observation={mechanism:'PriceAdjust scope ALL mutates each SKU salePrice; it is not an invoice discount field',skuCount:100,baseEach:100_000,adjustedEach:90_000,totalBase:10_000_000,totalAfter:9_000_000,storedInvoiceDiscount:n(inv.discountTotal),lineRows:n(itemAgg.count)}
 }else if(key==='INVOICE-PERCENT-100-LINES'){
   configurePolicy(10);const variants=Array.from({length:100},(_,i)=>variant(`invoice-sku-${i+1}`,100_000))
   const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:variants.map(variantId=>({variantId,qty:1,unitPrice:100_000,discount:0,tax:0})),invoiceDiscount:1_000_000,payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})
   const inv=seed.one('SELECT goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
   const itemAgg=seed.one('SELECT COUNT(*) count,SUM(unitPrice) gross,SUM(discount) discount,SUM(lineTotal) lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
   assert.equal(n(inv.goodsTotal),10_000_000);assert.equal(n(inv.discountTotal),1_000_000);assert.equal(n(inv.grandTotal),9_000_000);assert.equal(n(inv.paidTotal),9_000_000)
   assert.equal(n(itemAgg.count),100);assert.equal(n(itemAgg.gross),10_000_000);assert.equal(n(itemAgg.discount),0);assert.equal(n(itemAgg.lineTotal),10_000_000)
   result.status='PASS';result.observation={mechanism:'DiscountPolicy FIXED/PERCENT is an invoice-level discount; separate from line discounts',skuCount:100,eachGross:100_000,gross:10_000_000,invoiceDiscount:1_000_000,netPaid:9_000_000,itemDiscountsSum:n(itemAgg.discount),storedInvoiceDiscount:n(inv.discountTotal),storedLineTotalSum:n(itemAgg.lineTotal)}
 }else if(key==='LINE-PERCENT-100-LINES'){
   seed.setting(SETTING_KEYS.discountPolicy,freeLinePolicy());const variants=Array.from({length:100},(_,i)=>variant(`line-sku-${i+1}`,100_000))
   const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:variants.map(variantId=>({variantId,qty:1,unitPrice:100_000,discount:10_000,tax:0})),payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})
   const inv=seed.one('SELECT goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
   const agg=seed.one('SELECT COUNT(*) count,SUM(unitPrice) gross,SUM(discount) discount,SUM(lineTotal) lineTotal,MIN(lineTotal) minLine,MAX(lineTotal) maxLine FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
   assert.equal(n(inv.goodsTotal),10_000_000);assert.equal(n(inv.discountTotal),1_000_000);assert.equal(n(inv.grandTotal),9_000_000);assert.equal(n(inv.paidTotal),9_000_000)
   assert.equal(n(agg.count),100);assert.equal(n(agg.discount),1_000_000);assert.equal(n(agg.lineTotal),9_000_000);assert.equal(n(agg.minLine),90_000);assert.equal(n(agg.maxLine),90_000)
   result.status='PASS';result.observation={mechanism:'100 independently discounted rows; each 10% discount is 10,000, aggregate discount remains 10% of gross, not 100 repeated/compounded discounts',rowCount:n(agg.count),gross:n(agg.gross),discount:n(agg.discount),net:n(inv.grandTotal),perRowDiscount:10_000,perRowNet:90_000}
 }else if(key==='LINE-PERCENT-QTY-100'){
   seed.setting(SETTING_KEYS.discountPolicy,freeLinePolicy());const v=variant('single-sku-qty-100',100_000,200)
   const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:[{variantId:v,qty:100,unitPrice:100_000,discount:1_000_000,tax:0}],payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})
   const item=seed.one('SELECT qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
   const inv=seed.one('SELECT goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
   assert.equal(n(item.qty),100);assert.equal(n(item.unitPrice)*n(item.qty),10_000_000);assert.equal(n(item.discount),1_000_000);assert.equal(n(item.lineTotal),9_000_000)
   assert.equal(n(inv.discountTotal),1_000_000);assert.equal(n(inv.grandTotal),9_000_000);assert.equal(n(inv.paidTotal),9_000_000)
   result.status='PASS';result.observation={mechanism:'one row with quantity 100; 10% applies once to extended row gross (unitPrice × qty)',qty:100,unitPrice:100_000,gross:n(item.unitPrice)*n(item.qty),discount:n(item.discount),net:n(inv.grandTotal)}
 }else if(key==='FIXED-PER-LINE-REJECT'){
   configurePolicy(10);const v=variant('fixed-policy-line-discount',10_000_000);let error=''
   try{await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:[{variantId:v,qty:1,unitPrice:10_000_000,discount:1_000_000,tax:0}],payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})}catch(e){error=String(e?.message??e)}
   assert.ok(error.includes('فقط تخفیف ثابت مدیر'));assert.equal(seed.count('SaleInvoice','shiftId=?',shiftId),0);assert.equal(seed.count('Payment','createdShiftId=?',shiftId),0)
   result.status='PASS';result.observation={managerFixedInvoicePolicyAcceptsLineDiscount:false,rejection:error,mutationFree:true}
 }else{
   const explicit=key.includes('EXPLICIT'),targetKind=key.endsWith('EQUAL')?'EQUAL':key.endsWith('HIGH')?'HIGH':'LOW'
   const targetPrice=targetKind==='EQUAL'?10_000_000:targetKind==='HIGH'?11_000_000:9_000_000
   configurePolicy(10)
   const source=variant('source-10m',10_000_000),replacement=variant(`replacement-${targetKind.toLowerCase()}`,targetPrice)
   const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:[{variantId:source,qty:1,unitPrice:10_000_000,discount:0,tax:0}],invoiceDiscount:1_000_000,payments:[{methodId:cash,amount:9_000_000,destination:'CASH'}]})
   const sourceItem=seed.one('SELECT id,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',sale.id,source)
   const exchangeInvoiceDiscount=explicit?Math.round(targetPrice*10/100):0
   const effectiveReplacement=targetPrice-exchangeInvoiceDiscount
   const expectedDiff=effectiveReplacement-9_000_000
   const lines=[{saleItemId:n(sourceItem.id),qty:1}],replacements=[{variantId:replacement,qty:1,unitPrice:targetPrice,discount:0,tax:0}]
   const preview=await salesService.previewExchangeFunding({invoiceId:n(sale.id),lines,replacements,invoiceDiscount:exchangeInvoiceDiscount})
   assert.equal(preview.ok,true,preview.error??'exchange preview')
   const input={userId,shiftId,invoiceId:n(sale.id),lines,replacements,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`iid-${key}`}
   if(explicit)input.invoiceDiscount=exchangeInvoiceDiscount
   if(expectedDiff>0)input.methodId=cash
   if(expectedDiff<0)input.refundMode='CASH'
   const exchange=await salesService.createExchange(input)
   const ret=seed.one('SELECT total,exchangeDiff,exchangeSettlement,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
   const child=seed.one('SELECT goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
   const cashIn=n(seed.one("SELECT COALESCE(SUM(p.amount),0) amount FROM \"Payment\" p JOIN \"PaymentMethod\" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL",shiftId).amount)
   const cashOut=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
   const blue=n(await physicalMovementForCustodyShift(shiftId))
   assert.equal(n(sourceItem.unitPrice),10_000_000);assert.equal(n(sourceItem.discount),0);assert.equal(n(ret.total),9_000_000)
   assert.equal(n(exchange.diff),expectedDiff);assert.equal(n(preview.effectiveDiff),expectedDiff);assert.equal(n(ret.exchangeDiff),expectedDiff)
   assert.equal(n(child.goodsTotal),targetPrice);assert.equal(n(child.discountTotal),exchangeInvoiceDiscount);assert.equal(n(child.grandTotal),effectiveReplacement)
   assert.equal(n(exchange.cashReceived),Math.max(expectedDiff,0));assert.equal(n(exchange.cashRefunded),Math.max(-expectedDiff,0))
   assert.equal(cashIn,9_000_000+Math.max(expectedDiff,0));assert.equal(cashOut,Math.max(-expectedDiff,0));assert.equal(blue,cashIn-cashOut)
   result.status='PASS';result.observation={exchangeApiMode:explicit?'explicitly supplied replacement invoiceDiscount (not sent by SalesReturn UI)':'current SalesReturn-style payload; no replacement invoiceDiscount',sourceSaleGross:10_000_000,sourceInvoiceDiscount:1_000_000,sourcePaidAndReturnValue:9_000_000,replacementGross:targetPrice,replacementInvoiceDiscount:exchangeInvoiceDiscount,replacementNet:effectiveReplacement,diff:expectedDiff,direction:expectedDiff>0?'collect':expectedDiff<0?'refund':'zero',cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),currentExchangeUiHasManagerAutoDiscount:false,transferYesNoImplemented:false}
 }
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-invoice-vs-item-discount-exchange');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,`${key.toLowerCase()}.json`),JSON.stringify(result,null,2)+'\n')
 const fa=x=>Math.round(Number(x??0)/10).toLocaleString('fa-IR')
 const md=[`# تخفیف کل فاکتور در برابر تخفیف هر قلم — ${key}`,'',`**نتیجهٔ آزمون:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## نتیجهٔ قابل‌خواندن',`- ${JSON.stringify(result.observation??result.failure??null)}`,'',
 'فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.']
 writeFileSync(join(outdir,`${key.toLowerCase()}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
