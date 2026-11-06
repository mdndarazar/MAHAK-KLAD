/** Scenario 2: return the barcode-funded 400k and refund the remaining 100k cash. Isolated SQLite only. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-s02-')); process.env.HARNESS_DIR=dir; process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up scenario 02 cashier')
const shiftId=seed.insert('Shift',{name:'follow-up scenario 02',number:2,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F02-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const cat=seed.category('followup-s02')
const mkVariant=(name,price)=>{const p=seed.product(name,cat),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const a=mkVariant('S02-A-500k',500000),b=mkVariant('S02-B-500k',500000)
const credit=[]
for(let i=0;i<4;i++){
 const x=await storeCreditService.issueManual({amount:100000,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD})
 const r=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',x.id);credit.push({id:Number(r.id),code:r.code})
}
const initial={cash:0,card:0,refundCash:0,refundCard:0}
const independent=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) a FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const cardRefund=seed.one(`SELECT COALESCE(SUM(refundAmount),0) a FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return {cash:Number(p.cash),card:Number(p.card),refundCash:Number(c.a),refundCard:Number(cardRefund.a)}
}
const events=[]
async function snap(label,expected){
 const rows=await salesService.reportRows({shiftId})
 const actual={cash:Number(rows.totals.cashTotal??0),card:Number(rows.totals.cardTotal??0),refundCash:Number(rows.totals.refundCashTotal??0),refundCard:Number(rows.totals.refundCardTotal??0)}
 assert.deepEqual(actual,expected,`${label}: expected vs report`)
 const raw=independent();assert.deepEqual(raw,actual,`${label}: raw documents vs report`)
 const blue=Number(await physicalMovementForCustodyShift(shiftId));const expectedBlue=expected.cash+expected.card-expected.refundCash-expected.refundCard
 assert.equal(blue,expectedBlue);assert.equal(raw.cash+raw.card-raw.refundCash-raw.refundCard,blue)
 const stock=[a,b].map(id=>({variantId:id,actual:Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:Number(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 for(const x of stock) assert.equal(x.actual,10+x.ledger)
 const credits=credit.map(x=>{const r=seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?',x.id);return {id:x.id,amount:Number(r.amount),usedAmount:Number(r.usedAmount),usedCount:Number(r.usedCount),status:r.status}})
 events.push({label,expected,actual,raw,blue,expectedBlue,stock,credits})
}
await snap('baseline',initial)
const sale=await salesService.create({userId,shiftId,lines:[{variantId:a,qty:1,unitPrice:500000,discount:0,tax:0},{variantId:b,qty:1,unitPrice:500000,discount:0,tax:0}],
 payments:[{methodId:cash,amount:600000,destination:'CASH'}],storeCredits:credit.map(x=>({code:x.code})),saleRequestIdempotencyKey:'followup-s02-mixed-sale'})
assert.equal(Number(sale.grandTotal),1000000);assert.equal(Number(sale.storeCreditApplied),400000)
const expectedSale={cash:600000,card:0,refundCash:0,refundCard:0};await snap('sale: 600k cash + 4×100k credit',expectedSale)
const item=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',sale.id,a)
const ret=await salesService.createReturn({userId,shiftId,invoiceId:sale.id,full:false,lines:[{saleItemId:Number(item.id),qty:1}],refundMethod:'CASH',refundAmount:100000})
assert.equal(Number(ret.total),500000);assert.equal(Number(ret.refundAmount),100000);assert.equal(Number(ret.sourceCreditRestoredAmount),400000)
assert.equal(Number(seed.one('SELECT COALESCE(SUM(amount),0) value FROM "CashMovement" WHERE shiftId=? AND refId=? AND type=?',shiftId,ret.id,'RETURN_REFUND').value),100000)
const successorRows=seed.rows('SELECT id,amount,status,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id',ret.id)
assert.equal(successorRows.reduce((s,x)=>s+Number(x.amount),0),400000)
assert.equal(successorRows.length,4)
for(const c of successorRows)assert.equal(c.status,'ACTIVE')
const expectedAfter={cash:600000,card:0,refundCash:100000,refundCard:0};await snap('return: restore 400k source credit + refund 100k cash',expectedAfter)
const invoice=seed.one('SELECT grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?',sale.id)
const salePayments=seed.rows(`SELECT m.key,m.kind,p.amount,p.overpayAmount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? ORDER BY p.id`,sale.id)
const retDoc=seed.one('SELECT total,refundMethod,refundAmount,refundStoreCreditAmount,voidedAt FROM "SaleReturn" WHERE id=?',ret.id)
const movement=seed.rows('SELECT type,amount FROM "CashMovement" WHERE shiftId=? ORDER BY id',shiftId)
const output={generatedAt:new Date().toISOString(),scenario:2,status:'PASS',isolatedDatabase:process.env.HARNESS_DB,
 amounts:{invoice:1000000,cashPaid:600000,creditPaid:400000,returnedItem:500000,sourceCreditRestored:400000,cashRefund:100000,physicalBlueAfterSale:600000,physicalBlueAfterReturn:500000},
 invoice:{grandTotal:Number(invoice.grandTotal),paidTotal:Number(invoice.paidTotal),status:invoice.status,payments:salePayments},
 return:{id:ret.id,total:Number(retDoc.total),refundMethod:retDoc.refundMethod,refundAmount:Number(retDoc.refundAmount),refundStoreCreditAmount:Number(retDoc.refundStoreCreditAmount),voided:!!retDoc.voidedAt},
 successors:successorRows.map(x=>({id:Number(x.id),amount:Number(x.amount),status:x.status,expiresAt:x.expiresAt})),cashMovements:movement,events}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario02.json'),JSON.stringify(output,null,2)+'\n')
const md=`# Follow-up scenario 2 — barcode return plus cash residual\n\n**Status: PASS (isolated service-layer test).**\n\n## مثال مبلغی ریزبه‌ریز\n- دو کالا: ۵۰۰٬۰۰۰ + ۵۰۰٬۰۰۰ = **۱٬۰۰۰٬۰۰۰ ریال**.\n- پرداخت فروش: **۶۰۰٬۰۰۰ نقد** + چهار بارکدِ **۱۰۰٬۰۰۰** = ۴۰۰٬۰۰۰ اعتبار.\n- پس از فروش، مرجع آبی: **۶۰۰٬۰۰۰**؛ اعتبار خرید در آن شمرده نشد.\n- کالای ۵۰۰٬۰۰۰ ریالی برگشت داده شد: **۴۰۰٬۰۰۰ اعتبار منبع** به چهار بارکد جانشین برگشت و **۱۰۰٬۰۰۰ ریال نقد** پرداخت شد.\n- پس از برگشت: مرجع آبی = ۶۰۰٬۰۰۰ − ۱۰۰٬۰۰۰ = **۵۰۰٬۰۰۰ ریال**؛ کالای برگشتی به موجودی برگشت.\n\n## نتیجه نسبت به سیاست اعلام‌شده\n**مطابق در این سناریو:** ۴۰۰٬۰۰۰ ریال اعتبار به پول نقد تبدیل نشد؛ ۱۰۰٬۰۰۰ ریالِ باقیمانده واقعاً از صندوق برگشت؛ مرجع آبی با محاسبهٔ مستقل اسناد خام برابر شد. چهار بارکد جانشین هرکدام ۱۰۰٬۰۰۰ ریال و ACTIVE بودند.\n\n## شواهد\n- فاکتور: ${JSON.stringify(output.invoice)}\n- برگشت: ${JSON.stringify(output.return)}\n- بارکدهای جانشین: ${JSON.stringify(output.successors)}\n- اسناد حرکت نقد و checkpointها: ${JSON.stringify({cashMovements:output.cashMovements,events:output.events})}\n\n**محدودیت:** این مورد فقط مسیر برگشت نقدیِ ۱۰۰٬۰۰۰ را تأیید می‌کند؛ کارت، کارت‌به‌کارت مدیر و صدور اعتبارِ بدون انقضا هنوز در سناریوهای جداگانه باید آزموده شوند. دیتابیس آزمایشی موقت بود و دادهٔ واقعی تغییر نکرد.\n`
writeFileSync(join(out,'deep-e2e-followup-scenario02.md'),md)
console.log(`Scenario 2 PASS; blue ${events.at(-1).blue}; report=${join(out,'deep-e2e-followup-scenario02.md')}`)
await db.$disconnect?.()
