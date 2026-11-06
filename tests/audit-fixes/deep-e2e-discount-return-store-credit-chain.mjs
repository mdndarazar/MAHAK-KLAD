/* Chain probe for invoice-wide discounts: discounted sale -> return one item
 * as a credit barcode -> redeem barcode on next sale -> return that sale to
 * credit again. Run SINGLE and MULTI in separate temporary SQLite databases.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const mode=String(process.env.MAHAK_DISCOUNT_CREDIT_CHAIN??'').toUpperCase()
assert.ok(['SINGLE','MULTI'].includes(mode),'MAHAK_DISCOUNT_CREDIT_CHAIN must be SINGLE or MULTI')
const dir=mkdtempSync(join(tmpdir(),`mahak-discount-credit-chain-${mode.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`discount credit chain ${mode}`)
const shiftId=seed.insert('Shift',{name:`discount credit chain ${mode}`,number:9360+(mode==='SINGLE'?1:2),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`DISCOUNT-CREDIT-CHAIN-${mode}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`discount credit chain ${mode}`)
let seq=0
function variant(name,price){const p=seed.product(`chain-${mode}-${++seq}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const line=(variantId,unitPrice)=>({variantId,qty:1,unitPrice,discount:0,tax:0})
const oneItemPrice=10_000_000
const originalCount=mode==='SINGLE'?1:4
const invoiceDiscount=mode==='SINGLE'?1_000_000:10_000_000
const originals=Array.from({length:originalCount},(_,i)=>({name:`original-${i+1}`,variantId:variant(`original-${i+1}`,oneItemPrice),unitPrice:oneItemPrice}))
const replacementPrice=mode==='SINGLE'?oneItemPrice-invoiceDiscount:oneItemPrice-invoiceDiscount/originalCount
const returnVariant=originals[0].variantId
const secondProduct=variant('second-sale-good',replacementPrice)
const result={mode,scenario:'discounted invoice -> STORE_CREDIT return -> barcode-funded new sale -> STORE_CREDIT return of that sale',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING',fixture:{originalCount,itemGross:oneItemPrice,invoiceDiscount,replacementPrice}}
try{
 const totalGross=oneItemPrice*originalCount,net=totalGross-invoiceDiscount
 const sale1=await salesService.create({userId,shiftId,lines:originals.map(x=>line(x.variantId,x.unitPrice)),invoiceDiscount,payments:[{methodId:cash,amount:net,destination:'CASH'}]})
 const sale1Items=seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale1.id)
 const returningItem=sale1Items.find(x=>n(x.variantId)===returnVariant)
 const return1=await salesService.createReturn({userId,shiftId,invoiceId:n(sale1.id),full:mode==='SINGLE',lines:[{saleItemId:n(returningItem.id),qty:1}],refundMethod:'STORE_CREDIT'})
 const return1Row=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',return1.id)
 const codes1=seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,source,restrictScope,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id',return1.id)
 const barcode1=codes1.find(c=>n(c.amount)===replacementPrice)
 assert.ok(barcode1,'first return must issue a store-credit barcode equal to the discounted net value of the returned line')
 const sale2=await salesService.create({userId,shiftId,lines:[line(secondProduct,replacementPrice)],storeCredits:[{code:barcode1.code,requestedAmount:replacementPrice}],payments:[],saleRequestIdempotencyKey:`discount-chain-${mode}-redeem-1`})
 const sale2Item=seed.one('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',sale2.id)
 const barcode1AfterSale=seed.one('SELECT id,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?',barcode1.id)
 const return2=await salesService.createReturn({userId,shiftId,invoiceId:n(sale2.id),full:true,lines:[{saleItemId:n(sale2Item.id),qty:1}],refundMethod:'STORE_CREDIT'})
 const return2Row=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',return2.id)
 const codes2=seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,source,restrictScope,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id',return2.id)
 const allCredits=seed.rows('SELECT id,amount,usedAmount,status,source,restrictScope,returnId FROM "StoreCredit" ORDER BY id')
 const activeBalance=allCredits.filter(c=>c.status==='ACTIVE').reduce((s,c)=>s+Math.max(0,n(c.amount)-n(c.usedAmount)),0)
 const cashRefund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const cashPayments=n(seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "Payment" WHERE createdShiftId=? AND methodId=? AND kind=\'CASH\' AND voidedAt IS NULL',shiftId,cash).amount)
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 const stock=[...originals.map(x=>x.variantId),secondProduct].map((id,i)=>({name:i<originals.length?`original-${i+1}`:'second-sale-good',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 result.originalSale={gross:totalGross,discount:invoiceDiscount,net:net,paid:n(sale1.paidTotal),lines:originalCount}
 result.firstReturn={grossReturnedLine:oneItemPrice,allocatedInvoiceDiscountShare:oneItemPrice-replacementPrice,netReturn:n(return1Row.total),method:return1Row.refundMethod,barcodeCount:codes1.length,barcodeAmount:codes1.reduce((s,c)=>s+n(c.amount),0),barcodeAmounts:codes1.map(c=>n(c.amount)),source:codes1.map(c=>c.source),activeBarcodeAmount:n(barcode1.amount)}
 result.redemption={secondSaleGross:n(sale2.grandTotal),storeCreditApplied:n(sale2.storeCreditApplied),paidTotal:n(sale2.paidTotal),barcodeAmount:n(barcode1.amount),barcodeAfter:{amount:n(barcode1AfterSale.amount),usedAmount:n(barcode1AfterSale.usedAmount),usedCount:n(barcode1AfterSale.usedCount),status:barcode1AfterSale.status}}
 result.secondReturn={returnedItemPrice:n(sale2Item.lineTotal),returnTotal:n(return2Row.total),method:return2Row.refundMethod,refundAmount:n(return2Row.refundAmount),refundStoreCreditAmount:n(return2Row.refundStoreCreditAmount),newBarcodeCount:codes2.length,newBarcodeAmount:codes2.reduce((s,c)=>s+n(c.amount),0),newBarcodeAmounts:codes2.map(c=>n(c.amount)),source:codes2.map(c=>c.source),activeCreditBalanceAfterReturn:activeBalance}
 result.reconciliation={originalCashReceived:cashPayments,cashRefunded:cashRefund,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)}
 assert.equal(n(sale1.grandTotal),net);assert.equal(n(sale1.paidTotal),net)
 assert.equal(n(return1Row.total),replacementPrice);assert.equal(result.firstReturn.barcodeAmount,replacementPrice)
 assert.equal(n(sale2.grandTotal),replacementPrice);assert.equal(n(sale2.storeCreditApplied),replacementPrice);assert.equal(n(sale2.paidTotal),replacementPrice)
 assert.equal(n(return2Row.total),replacementPrice)
 assert.equal(activeBalance,replacementPrice,'after barcode-funded resale is returned, the chain must preserve the same usable amount')
 assert.equal(cashRefund,0);assert.equal(cashPayments,net);assert.equal(blue,net)
 assert.deepEqual(stock.map(x=>x.actual),[...originals.map((_,i)=>i===0&&mode==='SINGLE'?10:mode==='MULTI'&&i===0?10:9),10])
 for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(result.reconciliation.cheques,0)
 result.status='PASS'
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-discount-return-store-credit-chain');mkdirSync(outdir,{recursive:true})
 const slug=mode.toLowerCase();writeFileSync(join(outdir,`${slug}.json`),JSON.stringify(result,null,2)+'\n')
 const money=x=>Number(x??0).toLocaleString('fa-IR')
 const md=[`# زنجیرهٔ تخفیف و بارکد اعتبار — ${mode==='SINGLE'?'تک‌قلمی':'چندقلمی'}`,'',`**نتیجهٔ اجرا و تطبیق:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## زنجیره‌ای که اجرا شد','۱. فروش فاکتور با تخفیف کلی فروشنده.','۲. برگشت یک کالا با روش STORE_CREDIT و صدور بارکد.','۳. مصرف کامل همان بارکد برای خرید تازه.','۴. برگشت کامل کالای خرید دوم با STORE_CREDIT و سنجش اعتبار باقی‌مانده/جایگزین.',
 '','## نتیجهٔ مبلغ‌ها',`- فاکتور اولیه: ${result.originalSale?.gross??'—'} ناخالص، تخفیف ${result.originalSale?.discount??'—'}، خالص ${result.originalSale?.net??'—'}.`,`- برگشت اول: ارزش خالص ${result.firstReturn?.netReturn??'—'}؛ مجموع بارکد اول ${result.firstReturn?.barcodeAmount??'—'}.`,`- خرید دوم با بارکد: قیمت ${result.redemption?.secondSaleGross??'—'} و اعتبار مصرف‌شده ${result.redemption?.storeCreditApplied??'—'}.`,`- برگشت دوم: ${result.secondReturn?.returnTotal??'—'}؛ بارکدهای صادرشده در مرحلهٔ دوم ${result.secondReturn?.newBarcodeAmount??'—'}؛ ماندهٔ فعال کل ${result.secondReturn?.activeCreditBalanceAfterReturn??'—'}.`,
 `- تطبیق وجه/موجودی: ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'Only a temporary isolated SQLite database was used; no production/staging or live database, real payment, or production code change.']
 writeFileSync(join(outdir,`${slug}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
