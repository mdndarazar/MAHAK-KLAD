/** Scenario 3: generation-two exchange using the child/exchange invoice presented by the customer. Temporary SQLite only. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-s03-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up scenario 03 cashier')
const shiftId=seed.insert('Shift',{name:'follow-up second invoice exchange',number:4,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F03-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const cat=seed.category('followup-s03')
const makeVariant=(name,price)=>{const p=seed.product(name,cat),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return{id,name,price}}
const original=makeVariant('original-A-500k',500000),replacement1=makeVariant('replacement-B-450k',450000),replacement2=makeVariant('replacement-C-400k',400000)
const line=v=>({variantId:v.id,qty:1,unitPrice:v.price,discount:0,tax:0})
const physicalRaw=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
 FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) v FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) v FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return{cash:Number(p.cash),card:Number(p.card),refundCash:Number(c.v),refundCard:Number(r.v)}
}
const variants=[original,replacement1,replacement2]
const checkpoints=[]
async function check(label,expectedBlue,expectedStocks){
 const report=await salesService.reportRows({shiftId})
 const reportSums={cash:Number(report.totals.cashTotal??0),card:Number(report.totals.cardTotal??0),refundCash:Number(report.totals.refundCashTotal??0),refundCard:Number(report.totals.refundCardTotal??0)}
 const raw=physicalRaw();assert.deepEqual(raw,reportSums,`${label}: independent raw flow agrees with report`)
 const blue=Number(await physicalMovementForCustodyShift(shiftId));assert.equal(blue,expectedBlue);assert.equal(raw.cash+raw.card-raw.refundCash-raw.refundCard,blue)
 const stocks=variants.map(v=>({variant:v.name,expected:expectedStocks[v.id],actual:Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock),ledgerDelta:Number(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',v.id).d)}))
 for(const s of stocks){assert.equal(s.actual,s.expected,`${label}: ${s.variant} stock`);assert.equal(s.actual,10+s.ledgerDelta,`${label}: ${s.variant} raw stock ledger`)}
 checkpoints.push({label,blueExpected:expectedBlue,blueActual:blue,reportSums,raw,stocks})
}
await check('baseline',0,{[original.id]:10,[replacement1.id]:10,[replacement2.id]:10})
const sale=await salesService.create({userId,shiftId,lines:[line(original)],payments:[{methodId:cash,amount:500000,destination:'CASH'}],saleRequestIdempotencyKey:'followup-s03-root-sale'})
const rootItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id)
assert.equal(Number(sale.grandTotal),500000);assert.equal(Number(sale.paidTotal),500000)
await check('root sale A 500k cash',500000,{[original.id]:9,[replacement1.id]:10,[replacement2.id]:10})
const ex1=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:Number(rootItem.id),qty:1}],replacements:[line(replacement1)],refundMode:'STORE_CREDIT'})
assert.equal(Number(ex1.diff),-50000);assert.equal(Number(ex1.cashRefunded??0),0)
assert.ok(ex1.exchangeInvoiceId)
const invoice2=seed.one('SELECT id,sourceInvoiceId,exchangeReturnId,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',ex1.exchangeInvoiceId)
assert.equal(Number(invoice2.id),Number(ex1.exchangeInvoiceId));assert.equal(Number(invoice2.sourceInvoiceId),Number(sale.id))
const item2=seed.one('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?',invoice2.id)
assert.equal(Number(item2.variantId),replacement1.id);assert.equal(Number(item2.lineTotal),450000)
await check('exchange 1: A 500k → invoice 2 / B 450k; 50k store-credit difference',500000,{[original.id]:10,[replacement1.id]:9,[replacement2.id]:10})
// Customer presents invoice 2 (not the root invoice); B is the replacement item still in their possession.
const ex2=await salesService.createExchange({userId,shiftId,invoiceId:Number(invoice2.id),lines:[{saleItemId:Number(item2.id),qty:1}],replacements:[line(replacement2)],refundMode:'STORE_CREDIT'})
assert.equal(Number(ex2.diff),-50000)
assert.ok(ex2.exchangeInvoiceId)
const invoice3=seed.one('SELECT id,sourceInvoiceId,exchangeReturnId,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',ex2.exchangeInvoiceId)
assert.equal(Number(invoice3.sourceInvoiceId),Number(invoice2.id),'generation-three invoice points to the second/exchange invoice customer presented')
const childReturns=seed.rows('SELECT id,invoiceId,kind,total,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE shiftId=? ORDER BY id',shiftId)
assert.equal(childReturns.length,2);assert.equal(Number(childReturns[1].invoiceId),Number(invoice2.id));assert.equal(Number(childReturns[1].exchangeDiff),-50000)
await check('exchange 2: customer invoice 2 B 450k → invoice 3 / C 400k',500000,{[original.id]:10,[replacement1.id]:10,[replacement2.id]:9})
const credits=seed.rows('SELECT id,amount,usedAmount,status,expiresAt,returnId,source FROM "StoreCredit" WHERE sourceInvoiceId IS NOT NULL ORDER BY id')
const output={generatedAt:new Date().toISOString(),scenario:'Independent follow-up scenario 2 (generation-two exchange via customer-presented invoice 2)',status:'PASS',isolatedDatabase:process.env.HARNESS_DB,
 example:{rootSale:500000,exchange1:{returned:500000,replacement:450000,difference:-50000},exchange2:{returned:450000,replacement:400000,difference:-50000},cashInitiallyReceived:500000,physicalBlueAfterBothExchanges:500000},
 invoices:[{id:Number(sale.id),grandTotal:Number(sale.grandTotal),paidTotal:Number(sale.paidTotal),orderType:'INTERNAL'},invoice2,{id:Number(invoice3.id),sourceInvoiceId:Number(invoice3.sourceInvoiceId),exchangeReturnId:Number(invoice3.exchangeReturnId),grandTotal:Number(invoice3.grandTotal),paidTotal:Number(invoice3.paidTotal),status:invoice3.status}],
 exchangeResults:[{returnId:ex1.returnId,exchangeInvoiceId:ex1.exchangeInvoiceId,diff:Number(ex1.diff),cashRefunded:Number(ex1.cashRefunded??0),newStoreCreditAmount:Number(ex1.newStoreCreditAmount??0)},
 {returnId:ex2.returnId,exchangeInvoiceId:ex2.exchangeInvoiceId,diff:Number(ex2.diff),cashRefunded:Number(ex2.cashRefunded??0),newStoreCreditAmount:Number(ex2.newStoreCreditAmount??0)}],
 returns:childReturns.map(r=>({id:Number(r.id),invoiceId:Number(r.invoiceId),kind:r.kind,total:Number(r.total),exchangeInvoiceId:Number(r.exchangeInvoiceId),exchangeTotal:Number(r.exchangeTotal),exchangeDiff:Number(r.exchangeDiff),exchangeSettlement:r.exchangeSettlement,refundMethod:r.refundMethod,refundAmount:Number(r.refundAmount),refundStoreCreditAmount:Number(r.refundStoreCreditAmount)})),
 credits:credits.map(c=>({id:Number(c.id),amount:Number(c.amount),usedAmount:Number(c.usedAmount),status:c.status,expiresAt:c.expiresAt,returnId:Number(c.returnId),source:c.source})),checkpoints}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario03-second-invoice-exchange.json'),JSON.stringify(output,null,2)+'\n')
const md=`# سناریوی مستقل ۲ از ۱۰ — تعویض دوم با فاکتور دوم\n\n**وضعیت: PASS** در SQLite موقت.\n\n## مثال مبلغی ریزبه‌ریز\n1. فروش اولیه: کالای A به مبلغ **۵۰۰٬۰۰۰ ریال**؛ مشتری ۵۰۰٬۰۰۰ نقد پرداخت کرد؛ blue=۵۰۰٬۰۰۰.\n2. تعویض اول: A به مبلغ ۵۰۰٬۰۰۰ برگشت و B به مبلغ ۴۵۰٬۰۰۰ تحویل شد؛ اختلاف **۵۰٬۰۰۰ ریال به نفع مشتری** با STORE_CREDIT تسویه شد؛ فاکتور تعویض **شمارهٔ ۲** ساخته شد. blue تغییر نکرد.\n3. مشتری این بار **فاکتور ۲** را ارائه کرد؛ B که همان کالای جایگزینِ تعویض اول و هنوز نزد مشتری بود، به مبلغ ۴۵۰٬۰۰۰ برگشت داده شد و با C به مبلغ ۴۰۰٬۰۰۰ تعویض شد؛ اختلاف دوم **۵۰٬۰۰۰ ریال به نفع مشتری** با STORE_CREDIT ثبت شد؛ فاکتور ۳ به فاکتور ۲ متصل شد.\n\n## نتیجه‌گیری نسبت به سیاست شما\n**مطابق در این مسیر:** سیستم فاکتور دوم را به‌عنوان منبع تعویض پذیرفت؛ کالاهای A و B به موجودی برگشتند و C از موجودی کم شد؛ هر اختلاف ۵۰٬۰۰۰ ریالی اعتبار خرید بود، نه خروج نقدی؛ مرجع آبی بعد از هر تعویض روی **۵۰۰٬۰۰۰ ریال** ماند.\n\n## شواهد و تطبیق\n- زنجیرهٔ فاکتورها: ${JSON.stringify(output.invoices)}\n- اسناد تعویض: ${JSON.stringify(output.returns)}\n- اعتبارهای مرتبط: ${JSON.stringify(output.credits)}\n- Blue، جمع مستقل پرداخت/بازپرداخت و موجودی/دفتر انبار در هر checkpoint: ${JSON.stringify(checkpoints)}\n\nاین سناریو ثابت می‌کند تعویض دوم از کالای جایگزینِ درج‌شده روی فاکتور دوم کار می‌کند. هنوز سناریوی دیگرِ «برگشت ساده از فاکتور دوم» و مورد چنداعتباریِ شکست‌خورده باید جداگانه تکمیل شود. هیچ دیتابیس واقعی یا کد تولیدی تغییر نکرد.`
writeFileSync(join(out,'deep-e2e-followup-scenario03-second-invoice-exchange.md'),md)
console.log('Scenario 3 PASS: second exchange from invoice 2 accepted; blue remains 500000')
await db.$disconnect?.()
