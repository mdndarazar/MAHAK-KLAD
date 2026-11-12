/* Isolated SQLite probes for global manager price adjustments during exchange.
 * Run one case per fresh database via MAHAK_GLOBAL_EXCHANGE_CASE.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const key=String(process.env.MAHAK_GLOBAL_EXCHANGE_CASE??'').toLowerCase()
const caseNames=[]
for(const promo of ['fixed','percent'])for(const phase of ['active','reverted'])for(const target of (phase==='active'?[9,10,11]:[8,9,10,11]))caseNames.push(`${phase}-${promo}-${target}m`)
assert.ok(caseNames.includes(key),`MAHAK_GLOBAL_EXCHANGE_CASE must be one of: ${caseNames.join(', ')}`)
const [,phase,promo,targetLabel]=key.match(/^(active|reverted)-(fixed|percent)-(\d+)m$/)
const baseTargetM=Number(targetLabel)
const dir=mkdtempSync(join(tmpdir(),`mahak-global-exchange-${key}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {priceAdjustService}=await import('../../src/main/services/PriceAdjustService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`global adjustment exchange ${key}`)
const shiftId=seed.insert('Shift',{name:`global adjustment exchange ${key}`,number:7800+caseNames.indexOf(key),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`GLOBAL-${key}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`global adjustment ${key}`)
function makeVariant(name,price){const p=seed.product(`GLOBAL-${key}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const sourceBase=10_000_000, targetBase=baseTargetM*1_000_000
const source=makeVariant('original-10m',sourceBase),target=makeVariant(`replacement-${baseTargetM}m`,targetBase)
const adjustment={kind:'DISCOUNT',mode:promo==='fixed'?'AMOUNT':'PERCENT',value:promo==='fixed'?1_000_000:10,scope:'ALL',target:'SALE',userId,password:DEFAULT_MANAGER_PASSWORD,note:`isolated global ${promo} discount`}
const result={case:key,phase,promo,targetBase,targetType:baseTargetM===10?'equal-retail':baseTargetM>10?'higher-retail':'lower-retail',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
const priceOf=id=>n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?',id).salePrice)
try{
 const batch=await priceAdjustService.apply(adjustment)
 const sourceAfterAdjustment=priceOf(source),targetAfterAdjustment=priceOf(target)
 assert.equal(sourceAfterAdjustment,9_000_000,'10m source should be 9m after either global 1m or 10% adjustment')
 let reverted=null
 const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:[{variantId:source,qty:1,unitPrice:sourceAfterAdjustment,discount:0,tax:0}],payments:[{methodId:cash,amount:sourceAfterAdjustment,destination:'CASH'}]})
 const sourceItem=seed.one('SELECT id,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',sale.id,source)
 assert.equal(n(sourceItem.unitPrice),9_000_000);assert.equal(n(sourceItem.lineTotal),9_000_000)
 if(phase==='reverted'){
   reverted=await priceAdjustService.revert({batchId:batch.batchId,userId,password:DEFAULT_MANAGER_PASSWORD})
 }
 const targetCurrent=priceOf(target)
 const lines=[{saleItemId:n(sourceItem.id),qty:1}],replacements=[{variantId:target,qty:1,unitPrice:targetCurrent,discount:0,tax:0}]
 const preview=await salesService.previewExchangeFunding({invoiceId:n(sale.id),lines,replacements})
 assert.equal(preview.ok,true,preview.error??'exchange preview must be available')
 const expectedDiff=targetCurrent-9_000_000
 const input={userId,shiftId,invoiceId:n(sale.id),lines,replacements,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`global-${key}`}
 if(expectedDiff>0)input.methodId=cash
 if(expectedDiff<0)input.refundMode='CASH'
 const exchange=await salesService.createExchange(input)
 const ret=seed.one('SELECT id,total,exchangeDiff,exchangeSettlement,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
 const cashIn=n(seed.one("SELECT COALESCE(SUM(p.amount),0) amount FROM \"Payment\" p JOIN \"PaymentMethod\" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL",shiftId).amount)
 const cashOut=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const blue=n(await physicalMovementForCustodyShift(shiftId))
 const stock=[source,target].map((id,i)=>({name:i?'replacement':'source',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 assert.equal(n(exchange.returnTotal),9_000_000);assert.equal(n(ret.total),9_000_000)
 assert.equal(n(preview.effectiveDiff),expectedDiff);assert.equal(n(exchange.diff),expectedDiff);assert.equal(n(ret.exchangeDiff),expectedDiff)
 assert.equal(n(exchange.exchangeTotal),targetCurrent);assert.equal(n(child.grandTotal),targetCurrent);assert.equal(n(child.paidTotal),targetCurrent);assert.equal(n(child.discountTotal),0);assert.ok(child.settledAt!=null)
 assert.equal(n(exchange.cashReceived),Math.max(expectedDiff,0));assert.equal(n(exchange.cashRefunded),Math.max(-expectedDiff,0))
 assert.equal(cashIn,9_000_000+Math.max(expectedDiff,0));assert.equal(cashOut,Math.max(-expectedDiff,0));assert.equal(blue,cashIn-cashOut)
 assert.deepEqual(stock.map(s=>s.actual),[10,9]);for(const s of stock)assert.equal(s.actual,10+s.ledger)
 result.status='PASS'
 result.priceAdjustment={batchId:n(batch.batchId),scope:'ALL',kind:'DISCOUNT',mode:adjustment.mode,value:adjustment.value,sourceBase,sourceAfterDiscount:sourceAfterAdjustment,targetBase,targetAfterDiscount:targetAfterAdjustment,reverted:phase==='reverted'?{restoredCount:n(reverted.restoredCount),targetRestoredPrice:targetCurrent}:null}
 result.sale={grossBeforeDiscount:sourceBase,paid:n(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?',sale.id).grandTotal),sourceUnitPrice:n(sourceItem.unitPrice),sourceLineDiscount:n(sourceItem.discount)}
 result.exchange={sourceReturnNet:n(exchange.returnTotal),replacementPriceAtExchange:targetCurrent,replacementBase:targetBase,diff:n(exchange.diff),direction:expectedDiff>0?'collect-from-customer':expectedDiff<0?'refund-to-customer':'zero',cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),refundMethod:ret.refundMethod,exchangeSettlement:ret.exchangeSettlement}
 result.reconciliation={cashIn,cashOut,blue,stock,previewDiff:n(preview.effectiveDiff)}
 result.policyProbe={yesNoChoiceAvailableInCurrentExchangeApi:false,meaning:'No yes/no discount-transfer decision is implemented or passed to createExchange. Exchange uses the source invoice line net and current replacement ProductVariant.salePrice.'}
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-global-price-adjustment-exchange-behavior');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,`${key}.json`),JSON.stringify(result,null,2)+'\n')
 const toman=x=>Math.round(Number(x??0)/10).toLocaleString('fa-IR')
 const md=[`# تخفیف گروهی مدیر در تعویض — ${key}`,'',`**نتیجه:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## ورودی و رفتار مشاهده‌شده',`- تخفیف واقعی PriceAdjust با scope=ALL و نوع ${promo==='fixed'?'مبلغ ثابت ۱٬۰۰۰٬۰۰۰ ریال':'۱۰٪'} روی همهٔ واریانت‌های fixture اعمال شد.`,`- قیمت اسمی قلم مبدأ ۱۰٬۰۰۰٬۰۰۰ ریال؛ فاکتور هنگام فروش ${toman(result.sale?.paid)} تومان دریافت کرد.`,`- قیمت جایگزین در زمان تعویض ${toman(result.priceAdjustment?.targetAfterDiscount??result.exchange?.replacementPriceAtExchange)} تومان بود؛ خالص برگشت مبدأ ${toman(result.exchange?.sourceReturnNet)} تومان.`,`- اختلاف واقعی ${toman(result.exchange?.diff)} تومان؛ مسیر ${result.exchange?.direction??result.failure?.message}.`,
 '', '## تطبیق',`- ${JSON.stringify(result.reconciliation??null)}`,'',
 'تست فقط با SQLite موقت/ایزوله انجام شد. هیچ DB واقعی/staging یا وجه واقعی استفاده نشد و هیچ منطق production تغییر نکرد. در کد/ API فعلی گزینهٔ انتقال تخفیف بله/خیر وجود ندارد.']
 writeFileSync(join(outdir,`${key}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
