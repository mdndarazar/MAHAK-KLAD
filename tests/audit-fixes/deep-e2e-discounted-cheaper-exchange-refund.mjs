/* Six requested cheaper/equal exchange scenarios plus payout-method controls.
 * Each invocation uses a fresh temporary SQLite database.
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const caseName=String(process.env.MAHAK_CHEAPER_EXCHANGE_CASE??'').toUpperCase()
const validCases=['SINGLE-800-CASH','SINGLE-900-CASH','SINGLE-700-CASH','MULTI-800-CASH','MULTI-900-CASH','MULTI-700-CASH','SINGLE-700-C2C','SINGLE-700-STORE','MULTI-700-C2C','MULTI-700-STORE']
assert.ok(validCases.includes(caseName),`MAHAK_CHEAPER_EXCHANGE_CASE must be one of: ${validCases.join(', ')}`)
const dir=mkdtempSync(join(tmpdir(),`mahak-cheaper-exchange-${caseName.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`cheaper exchange refund ${caseName}`)
const shiftId=seed.insert('Shift',{name:`cheaper exchange ${caseName}`,number:9500+validCases.indexOf(caseName),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`CHEAPER-${caseName}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const category=seed.category(`cheaper exchange ${caseName}`)
let seq=0
function variant(name,price){const p=seed.product(`cheap-${caseName}-${++seq}-${name}`,category),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const single=caseName.startsWith('SINGLE')
const targetToman=Number(caseName.match(/-(800|900|700)-/)[1])*1000
const targetPrice=targetToman*10 // rial; 1 toman = 10 rial
const refundMode=caseName.endsWith('C2C')?'CARD_TO_CARD':caseName.endsWith('STORE')?'STORE_CREDIT':'CASH'
const originalLinePrice=10_000_000 // 1,000,000 toman
const originalCount=single?1:4
const invoiceDiscount=single?2_000_000:8_000_000 // 200k toman discount share on the exchanged line in both fixtures
const sourceShare=2_000_000,sourceNet=originalLinePrice-sourceShare,diff=targetPrice-sourceNet
const originals=Array.from({length:originalCount},(_,i)=>({name:`source-${i+1}`,variantId:variant(`source-${i+1}`,originalLinePrice)}))
const target=variant('replacement',targetPrice)
const result={caseName,single,refundMode,targetToman,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const gross=originalLinePrice*originalCount,net=gross-invoiceDiscount,sourceShare=Math.round(invoiceDiscount*originalLinePrice/gross),sourceNet=originalLinePrice-sourceShare,diff=targetPrice-sourceNet
 const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:originals.map(x=>({variantId:x.variantId,qty:1,unitPrice:originalLinePrice,discount:0,tax:0})),invoiceDiscount,payments:[{methodId:cash,amount:net,destination:'CASH'}]})
 const root=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 const sourceItem=items.find(x=>n(x.variantId)===originals[0].variantId)
 const lines=[{saleItemId:n(sourceItem.id),qty:1}],replacements=[{variantId:target,qty:1,unitPrice:targetPrice,discount:0,tax:0}]
 const preview=await salesService.previewExchangeFunding({invoiceId:n(sale.id),lines,replacements})
 assert.equal(preview.ok,true)
 const input={userId,shiftId,invoiceId:n(sale.id),lines,replacements,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`cheaper-${caseName}`}
 if(diff>0)input.methodId=cash
 else if(diff<0)input.refundMode=refundMode
 if(refundMode==='CARD_TO_CARD'&&diff<0)input.managerPassword=DEFAULT_MANAGER_PASSWORD
 const exchange=await salesService.createExchange(input)
 const ret=seed.one('SELECT id,total,exchangeDiff,exchangeSettlement,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?',exchange.returnId)
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',exchange.exchangeInvoiceId)
 let transfer=null,transferPaid=null,credits=[]
 if(diff<0&&refundMode==='CARD_TO_CARD'){
   transfer=seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1',exchange.returnId)
   assert.ok(transfer,'manager card-to-card choice should create a linked transfer request')
   await cardTransferService.pay({id:n(transfer.id),paidAmount:n(transfer.amount),userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`CHEAPER-${caseName}`})
   transferPaid=seed.one('SELECT status,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?',transfer.id)
 }
 if(diff<0&&refundMode==='STORE_CREDIT')credits=seed.rows('SELECT id,amount,usedAmount,status,source,returnId,exchangeInvoiceId FROM "StoreCredit" WHERE returnId=? ORDER BY id',exchange.returnId)
 const payments=seed.rows('SELECT p.amount,p.kind,p.destination,m.kind methodKind,m.key FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? ORDER BY p.id',shiftId)
 const cashIn=n(seed.one("SELECT COALESCE(SUM(p.amount),0) amount FROM \"Payment\" p JOIN \"PaymentMethod\" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL",shiftId).amount)
 const cashOut=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const report=await salesService.reportRows({shiftId}),blue=n(await physicalMovementForCustodyShift(shiftId))
 const stock=[...originals.map(x=>x.variantId),target].map((id,i)=>({name:i<originals.length?`source-${i+1}`:'replacement',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const storeCreditTotal=credits.reduce((s,c)=>s+n(c.amount),0)
 result.sale={lineCount:originalCount,gross,invoiceDiscount,net:n(root.grandTotal),paid:n(root.paidTotal),sourceLineGross:originalLinePrice}
 result.exchange={sourceDiscountShare:sourceShare,sourceNetReturn:n(exchange.returnTotal),replacementGross:targetPrice,diff:n(exchange.diff),previewDiff:n(preview.effectiveDiff),refundMode:exchange.refundMode??null,exchangeSettlement:ret.exchangeSettlement,refundMethod:ret.refundMethod,refundAmount:n(ret.refundAmount),refundStoreCreditAmount:n(ret.refundStoreCreditAmount),cashReceived:n(exchange.cashReceived),cashRefunded:n(exchange.cashRefunded),cardRefunded:n(exchange.cardRefunded),newStoreCreditAmount:n(exchange.newStoreCreditAmount)}
 result.refundChannel={requested:refundMode,transferRequest:transfer?{id:n(transfer.id),amount:n(transfer.amount),operationKind:transfer.operationKind}:null,transferAfterManagerPayment:transferPaid?{status:transferPaid.status,amount:n(transferPaid.amount),paidAmount:n(transferPaid.paidAmount),paidMethod:transferPaid.paidMethod,trackingNo:transferPaid.trackingNo}:null,credits:credits.map(c=>({id:n(c.id),amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,source:c.source,returnId:n(c.returnId)})),creditTotal:storeCreditTotal}
 result.reconciliation={payments,cashIn,cashOut,blue,reportTotals:report.totals,stock,cheques:seed.count('Payment',`createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`,shiftId)}
 assert.equal(items.length,originalCount);assert.equal(n(root.grandTotal),net);assert.equal(n(root.paidTotal),net);assert.equal(n(root.discountTotal),invoiceDiscount)
 assert.equal(n(exchange.returnTotal),sourceNet);assert.equal(n(ret.total),sourceNet);assert.equal(n(exchange.diff),diff);assert.equal(n(preview.effectiveDiff),diff)
 assert.equal(n(exchange.exchangeTotal),targetPrice);assert.equal(n(child.grandTotal),targetPrice);assert.equal(n(child.paidTotal),targetPrice);assert.equal(n(child.discountTotal),0)
 if(diff>0){assert.equal(n(exchange.cashReceived),diff);assert.equal(cashOut,0)}
 else if(diff===0){assert.equal(n(exchange.cashReceived),0);assert.equal(n(exchange.cashRefunded),0);assert.equal(cashOut,0)}
 else if(refundMode==='CASH'){assert.equal(n(exchange.cashRefunded),-diff);assert.equal(cashOut,-diff)}
 else if(refundMode==='CARD_TO_CARD'){assert.equal(n(transferPaid?.paidAmount),-diff);assert.equal(transferPaid?.status,'PAID');assert.equal(cashOut,0)}
 else {assert.equal(storeCreditTotal,-diff);assert.equal(cashOut,0)}
 const expectedCashIn=net+Math.max(diff,0)
 assert.equal(cashIn,expectedCashIn)
 const expectedBlue=expectedCashIn-cashOut
 assert.equal(blue,expectedBlue)
 assert.deepEqual(stock.map(x=>x.actual),[...originals.map((_,i)=>i===0?10:9),9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 assert.equal(result.reconciliation.cheques,0)
 result.status='PASS'
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-discounted-cheaper-exchange-refund');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,`${caseName.toLowerCase()}.json`),JSON.stringify(result,null,2)+'\n')
 const toToman=x=>Number(x??0)/10,fa=x=>Math.round(toToman(x)).toLocaleString('fa-IR')
 const md=[`# تعویض با کالای ارزان‌تر/هم‌قیمت — ${caseName}`,'',`**نتیجهٔ تست و تطبیق:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 '## فاکتور و تعویض',`- نوع فاکتور: ${single?'تک‌قلمی':'چندقلمی'}؛ خطوط ${result.sale?.lineCount??'—'}؛ ناخالص ${fa(result.sale?.gross)} تومان؛ تخفیف کل ${fa(result.sale?.invoiceDiscount)} تومان؛ خالص پرداخت ${fa(result.sale?.net)} تومان.`,`- قیمت روی برچسب قلم برگشتی: ${fa(originalLinePrice)} تومان؛ سهم تخفیف همان قلم ${fa(sourceShare)} تومان؛ ارزش خالص برگشت ${fa(sourceNet)} تومان.`,`- قیمت جایگزین ${fa(targetPrice)} تومان؛ اختلاف ${fa(Math.abs(diff))} تومان ${diff>0?'دریافت از مشتری':diff<0?'بازپرداخت به مشتری':'بدون مابه‌التفاوت'}.`,`- روش/ثبت بازپرداخت: ${refundMode}${result.refundChannel?.transferAfterManagerPayment?`؛ کارت‌به‌کارت مدیر ${fa(result.refundChannel.transferAfterManagerPayment.paidAmount)} تومان با وضعیت ${result.refundChannel.transferAfterManagerPayment.status}`:''}${(result.refundChannel?.creditTotal??0)>0?`؛ اعتبار بارکدی صادرشده ${fa(result.refundChannel.creditTotal)} تومان`:''}.`,
 '','## تطبیق عدد آبی و انبار',`- ${JSON.stringify(result.reconciliation??result.failure??null)}`,'',
 'Only temporary isolated SQLite; no production/staging/live database or real money. Manager card-to-card is only a test-harness record; no actual bank transfer.']
 writeFileSync(join(outdir,`${caseName.toLowerCase()}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
