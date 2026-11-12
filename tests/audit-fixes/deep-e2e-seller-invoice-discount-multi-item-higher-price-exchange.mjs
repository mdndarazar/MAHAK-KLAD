/* Four-item invoice-wide seller discount; exchange one line for a higher-priced
 * item. Isolated SQLite-only probe of the current behavior and ledger totals.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'mahak-seller-discount-multi-high-exchange-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user('multi-item seller invoice discount higher-price exchange probe')
const shiftId=seed.insert('Shift',{name:'multi-item seller discount high-price',number:9363,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'MULTI-SELLER-DISC-HIGH-CASH',label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const sourceCategory=seed.category('multi invoice source category'),replacementCategory=seed.category('multi invoice replacement category')
function variant(name,price,category){const p=seed.product(`multi-high-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const originals=['A-returned','B-kept','C-kept','D-kept'].map(name=>variant(name,20_000_000,sourceCategory))
const replacement=variant('replacement-3m',30_000_000,replacementCategory)
const result={scenario:'4 x 2m toman = 8m toman gross; invoice discount 800k toman; exchange one item to 3m toman',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const gross=80_000_000,invoiceDiscount=8_000_000,net=72_000_000,discountShare=2_000_000,sourceReturn=18_000_000,targetPrice=30_000_000,expectedCurrentDiff=12_000_000
 const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:originals.map(variantId=>({variantId,qty:1,unitPrice:20_000_000,discount:0,tax:0})),invoiceDiscount,payments:[{methodId:cash,amount:net,destination:'CASH'}]})
 const root=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const itemA=items.find(x=>n(x.variantId)===originals[0])
 const replacementLine={variantId:replacement,qty:1,unitPrice:targetPrice,discount:0,tax:0}
 const lines=[{saleItemId:n(itemA.id),qty:1}]
 const preview=await salesService.previewExchangeFunding({invoiceId:n(sale.id),lines,replacements:[replacementLine]})
 assert.equal(preview.ok,true)
 const exchange=await salesService.createExchange({userId,shiftId,invoiceId:n(sale.id),lines,replacements:[replacementLine],methodId:cash,managerPassword:DEFAULT_MANAGER_PASSWORD,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:'multi-item-seller-discount-high-price'})
 const returnRow=seed.one('SELECT total,exchangeDiff,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
 const payments=seed.rows('SELECT p.amount,p.kind,p.destination,m.kind methodKind,m.key FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? ORDER BY p.id',shiftId)
 const rawCash=n(seed.one("SELECT COALESCE(SUM(p.amount),0) amount FROM \"Payment\" p JOIN \"PaymentMethod\" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL",shiftId).amount)
 const refund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const blue=n(await physicalMovementForCustodyShift(shiftId)),report=await salesService.reportRows({shiftId})
 const stock=[...originals,replacement].map((id,i)=>({name:['A returned','B kept','C kept','D kept','replacement'][i],actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 result.sale={gross,invoiceDiscount,net,lineCount:items.length,lineGrossPrice:2_000_000}
 result.exchange={returnedItemGross:2_000_000,allocatedInvoiceDiscountShare:discountShare,sourceReturnValue:n(exchange.returnTotal),replacementGross:targetPrice,replacementInvoiceDiscount:n(child.discountTotal),actualDifference:n(exchange.diff),previewDifference:n(preview.effectiveDiff),cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),settlement:exchange.settlement??null}
 result.reconciliation={rawPayments:payments,rawCash,refund,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)}
 assert.equal(items.length,4);assert.equal(n(root.grandTotal),net);assert.equal(n(root.paidTotal),net);assert.equal(n(root.discountTotal),invoiceDiscount)
 assert.equal(n(exchange.returnTotal),sourceReturn);assert.equal(n(returnRow.total),sourceReturn);assert.equal(n(exchange.exchangeTotal),targetPrice)
 assert.equal(n(preview.effectiveDiff),expectedCurrentDiff);assert.equal(n(exchange.diff),expectedCurrentDiff)
 assert.equal(n(child.grandTotal),targetPrice);assert.equal(n(child.paidTotal),targetPrice);assert.equal(n(child.discountTotal),0);assert.ok(root.settledAt!=null&&child.settledAt!=null)
 assert.equal(n(exchange.cashReceived),expectedCurrentDiff);assert.equal(rawCash,net+expectedCurrentDiff);assert.equal(refund,0);assert.equal(blue,net+expectedCurrentDiff)
 assert.deepEqual(stock.map(x=>x.actual),[10,9,9,9,9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(result.reconciliation.cheques,0)
 result.policyComparison={currentNoCarryoverDifference:expectedCurrentDiff,ifPriorShareTransferredOnceDifference:targetPrice-discountShare-sourceReturn,spread:expectedCurrentDiff-(targetPrice-discountShare-sourceReturn)}
 result.status='PASS'
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-seller-invoice-discount-multi-item-higher-price-exchange');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,'result.json'),JSON.stringify(result,null,2)+'\n')
 const md=[
 '# تعویض قلم گران‌تر از فاکتور چندقلمی با تخفیف کلی','',`**وضعیت تست و reconciliation:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## مثال','- چهار قلم، هرکدام ۲٬۰۰۰٬۰۰۰ تومان؛ جمع ناخالص ۸٬۰۰۰٬۰۰۰ تومان.','- تخفیف کلی فاکتور ۸۰۰٬۰۰۰ تومان؛ خالص/پرداخت اولیه ۷٬۲۰۰٬۰۰۰ تومان.','- قلم A به ارزش ناخالص ۲٬۰۰۰٬۰۰۰ تومان برگشت خورد و با قلم ۳٬۰۰۰٬۰۰۰ تومانی جایگزین شد.','- چون چهار قلم هم‌قیمت‌اند، سهم تخفیف A برابر ۲۰۰٬۰۰۰ تومان و ارزش خالص برگشت A برابر ۱٬۸۰۰٬۰۰۰ تومان است.',
 '','## رفتار فعلی سیستم',`- مبلغ برگشت قلم A: ${result.exchange?.sourceReturnValue??'—'} ریال معادل ۱٬۸۰۰٬۰۰۰ تومان.`,`- جایگزین با قیمت کامل ثبت شد: ${result.exchange?.replacementGross??'—'} ریال معادل ۳٬۰۰۰٬۰۰۰ تومان.`,`- مابه‌التفاوت واقعی و دریافتی: ${result.exchange?.actualDifference??'—'} ریال معادل ۱٬۲۰۰٬۰۰۰ تومان.`,`- اگر فروشنده «بله» بزند و همان سهم ۲۰۰٬۰۰۰ تومان منتقل شود، مابه‌التفاوت به ۱٬۰۰۰٬۰۰۰ تومان می‌رسد؛ با «خیر»، سیستم فعلی ۱٬۲۰۰٬۰۰۰ تومان می‌گیرد.`,
 '','## تطبیق',`- ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'فقط یک SQLite موقت و ایزوله استفاده شد؛ هیچ production/staging، دیتابیس واقعی یا وجه واقعی درگیر نشد و منطق production تغییر نکرد.' ]
 writeFileSync(join(outdir,'summary.md'),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
