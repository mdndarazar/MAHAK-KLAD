/* Invoice-level 10% discount: prorated single-line return and exchange cases. */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const key=String(process.env.MAHAK_INVOICE_DISCOUNT_EXCHANGE_CASE??'').toUpperCase()
const cases=['DIRECT-RETURN',...['EQUAL','LOW','HIGH'].flatMap(x=>[`UI-${x}`,`AUTO-${x}`])]
assert.ok(cases.includes(key),`MAHAK_INVOICE_DISCOUNT_EXCHANGE_CASE must be one of ${cases.join(', ')}`)
const dir=mkdtempSync(join(tmpdir(),`mahak-invoice-discount-return-exchange-${key.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {SETTING_KEYS}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`invoice discount exchange ${key}`)
const shiftId=seed.insert('Shift',{name:`invoice discount exchange ${key}`,number:9100+cases.indexOf(key),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`IDE-${key}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`invoice discount exchange ${key}`)
function variant(name,price,stock=20){const p=seed.product(`IDE-${key}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock,price,id);return id}
seed.setting(SETTING_KEYS.discountPolicy,{mode:'FIXED',fixedMode:'PERCENT',fixedValue:10,allowLine:false,allowInvoice:true,maxPercent:100,maxAmount:0,wholesaleMaxPercent:100,wholesaleMaxAmount:0})
const source=variant('source-10m',10_000_000),kept=variant('kept-20m',20_000_000)
const replacementBase=key.endsWith('EQUAL')?10_000_000:key.endsWith('LOW')?8_000_000:12_000_000
const replacement=key==='DIRECT-RETURN'?null:variant(`replacement-${replacementBase}`,replacementBase)
const result={case:key,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const gross=30_000_000,invoiceDiscount=3_000_000,netPaid=27_000_000
 const sale=await salesService.create({userId,shiftId,lines:[{variantId:source,qty:1,unitPrice:10_000_000,discount:0,tax:0},{variantId:kept,qty:1,unitPrice:20_000_000,discount:0,tax:0}],invoiceDiscount,payments:[{methodId:cash,amount:netPaid,destination:'CASH'}]})
 const inv=seed.one('SELECT id,goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const sourceItem=items.find(i=>n(i.variantId)===source)
 const sourceShare=Math.round(invoiceDiscount*10_000_000/gross),sourceReturn=10_000_000-sourceShare
 let operation,returnRow,exchangeChild=null,preview=null
 if(key==='DIRECT-RETURN'){
   operation=await salesService.createReturn({userId,shiftId,invoiceId:n(sale.id),full:false,lines:[{saleItemId:n(sourceItem.id),qty:1}],refundMethod:'CASH'})
   returnRow=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',operation.id)
 }else{
   const explicit=key.startsWith('AUTO-')
   const replacementDiscount=explicit?Math.round(replacementBase*10/100):0
   const replacements=[{variantId:replacement,qty:1,unitPrice:replacementBase,discount:0,tax:0}]
   const lines=[{saleItemId:n(sourceItem.id),qty:1}]
   preview=await salesService.previewExchangeFunding({invoiceId:n(sale.id),lines,replacements,invoiceDiscount:replacementDiscount})
   assert.equal(preview.ok,true,preview.error??'preview')
   const expectedDiff=replacementBase-replacementDiscount-sourceReturn
   const input={userId,shiftId,invoiceId:n(sale.id),lines,replacements,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`ide-${key}`}
   if(explicit)input.invoiceDiscount=replacementDiscount
   if(expectedDiff>0)input.methodId=cash
   if(expectedDiff<0)input.refundMode='CASH'
   operation=await salesService.createExchange(input)
   returnRow=seed.one('SELECT id,total,exchangeDiff,exchangeSettlement,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',operation.returnId)
   exchangeChild=seed.one('SELECT id,goodsTotal,discountTotal,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?',operation.exchangeInvoiceId)
 }
 const cashIn=n(seed.one("SELECT COALESCE(SUM(p.amount),0) amount FROM \"Payment\" p JOIN \"PaymentMethod\" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL",shiftId).amount)
 const cashOut=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const blue=n(await physicalMovementForCustodyShift(shiftId))
 const stock=[source,kept,...(replacement?[replacement]:[])].map((id,i)=>({name:i===0?'returned source':i===1?'kept line':'replacement',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 assert.equal(n(inv.goodsTotal),gross);assert.equal(n(inv.discountTotal),invoiceDiscount);assert.equal(n(inv.grandTotal),netPaid);assert.equal(n(inv.paidTotal),netPaid)
 assert.equal(items.length,2);assert.equal(n(sourceItem.unitPrice),10_000_000);assert.equal(n(sourceItem.discount),0)
 assert.equal(n(returnRow.total),sourceReturn);assert.equal(sourceShare,1_000_000);assert.equal(sourceReturn,9_000_000)
 let expectedDiff=0
 if(key==='DIRECT-RETURN'){
   expectedDiff=-sourceReturn;assert.equal(n(returnRow.refundAmount),sourceReturn);assert.equal(cashIn,netPaid);assert.equal(cashOut,sourceReturn);assert.deepEqual(stock.map(s=>s.actual),[20,19]);
 }else{
   const explicit=key.startsWith('AUTO-'),d=explicit?Math.round(replacementBase/10):0
   expectedDiff=replacementBase-d-sourceReturn
   assert.equal(n(preview.effectiveDiff),expectedDiff);assert.equal(n(operation.diff),expectedDiff);assert.equal(n(returnRow.exchangeDiff),expectedDiff)
   assert.equal(n(exchangeChild.goodsTotal),replacementBase);assert.equal(n(exchangeChild.discountTotal),d);assert.equal(n(exchangeChild.grandTotal),replacementBase-d)
   assert.equal(n(operation.cashReceived),Math.max(expectedDiff,0));assert.equal(n(operation.cashRefunded),Math.max(-expectedDiff,0))
   assert.equal(cashIn,netPaid+Math.max(expectedDiff,0));assert.equal(cashOut,Math.max(-expectedDiff,0));assert.deepEqual(stock.map(s=>s.actual),[20,19,19])
 }
 assert.equal(blue,cashIn-cashOut);for(const s of stock)assert.equal(s.actual,20+s.ledger)
 result.status='PASS';result.fixture={gross,invoiceDiscount,netPaid,lines:[{gross:10_000_000,allocatedDiscount:sourceShare,netReturn:sourceReturn},{gross:20_000_000,allocatedDiscount:2_000_000,net:18_000_000}]}
 if(key==='DIRECT-RETURN')result.operation={kind:'direct partial return',returnedLineGross:10_000_000,allocatedInvoiceDiscount:sourceShare,returnValue:n(returnRow.total),cashRefund:n(returnRow.refundAmount)}
 else result.operation={kind:'exchange',uiCurrentMode:key.startsWith('UI-')?'current SalesReturn payload; no automatic replacement invoice discount':'service control with 10% invoice discount explicitly supplied; current UI does not do this',replacementGross:replacementBase,replacementDiscount:n(exchangeChild.discountTotal),replacementNet:n(exchangeChild.grandTotal),sourceReturnValue:sourceReturn,diff:n(operation.diff),cashReceived:n(operation.cashReceived),cashRefunded:n(operation.cashRefunded),settlement:returnRow.exchangeSettlement,previewDiff:n(preview.effectiveDiff)}
 result.reconciliation={cashIn,cashOut,blue,stock}
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-invoice-discount-partial-return-and-exchange');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,`${key.toLowerCase()}.json`),JSON.stringify(result,null,2)+'\n')
 const fa=x=>Math.round(Number(x??0)/10).toLocaleString('fa-IR')
 const md=[`# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — ${key}`,'',`**نتیجه:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## فاکتور مبدأ',`- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.`,`- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.`,`- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.`,
 '','## رفتار',`- ${JSON.stringify(result.operation??result.failure??null)}`,'','## تطبیق',`- ${JSON.stringify(result.reconciliation??null)}`,'',
 'SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.']
 writeFileSync(join(outdir,`${key.toLowerCase()}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
