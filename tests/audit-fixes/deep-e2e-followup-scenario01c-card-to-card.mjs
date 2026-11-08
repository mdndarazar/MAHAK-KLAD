/** Settlement-mode branch of scenario 1: test CARD_TO_CARD request and manager payment in isolated SQLite. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-followup-c2c-'));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user('follow-up c2c cashier')
const shiftId=seed.insert('Shift',{name:'follow-up C2C',number:3,dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:'F01C-CASH',label:'cash test',kind:'CASH',isActive:1,sortOrder:1})
const cat=seed.category('followup-s01c')
const mk=(name,price)=>{const p=seed.product(name,cat),id=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,id);return id}
const a=mk('A-500k',500000),b=mk('B-500k',500000)
const credits=[]
for(let i=0;i<4;i++){const x=await storeCreditService.issueManual({amount:100000,multiUse:false,carryRemainder:true,days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD});const r=seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?',x.id);credits.push({id:Number(r.id),code:r.code})}
const financial=()=>{
 const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
 COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
 const c=seed.one(`SELECT COALESCE(SUM(amount),0) value FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
 const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) value FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
 return {cash:Number(p.cash),card:Number(p.card),refundCash:Number(c.value),refundCard:Number(r.value)}
}
const checks=[]
const check=async(label,expected)=>{
 const report=await salesService.reportRows({shiftId})
 const actual={cash:Number(report.totals.cashTotal??0),card:Number(report.totals.cardTotal??0),refundCash:Number(report.totals.refundCashTotal??0),refundCard:Number(report.totals.refundCardTotal??0)}
 assert.deepEqual(actual,expected,label);const raw=financial();assert.deepEqual(raw,actual,`${label}: raw doc agreement`)
 const blue=Number(await physicalMovementForCustodyShift(shiftId));const expectedBlue=expected.cash+expected.card-expected.refundCash-expected.refundCard
 assert.equal(blue,expectedBlue)
 const stocks=[a,b].map(id=>({id,stock:Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),movement:Number(seed.one('SELECT COALESCE(SUM(delta),0) x FROM "StockMovement" WHERE variantId=?',id).x)}))
 for(const x of stocks)assert.equal(x.stock,10+x.movement)
 checks.push({label,expected,actual,raw,blue,expectedBlue,stocks})
}
await check('baseline',{cash:0,card:0,refundCash:0,refundCard:0})
const sale=await salesService.create({userId,shiftId,lines:[{variantId:a,qty:1,unitPrice:500000,discount:0,tax:0},{variantId:b,qty:1,unitPrice:500000,discount:0,tax:0}],
 payments:[{methodId:cash,amount:600000,destination:'CASH'}],storeCredits:credits.map(c=>({code:c.code})),saleRequestIdempotencyKey:'followup-s01c-mixed-sale'})
assert.equal(Number(sale.grandTotal),1000000);assert.equal(Number(sale.storeCreditApplied),400000)
await check('sale: 600k cash + 400k barcode',{cash:600000,card:0,refundCash:0,refundCard:0})
const saleItem=seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',sale.id,a)
const ret=await salesService.createReturn({userId,shiftId,invoiceId:sale.id,full:false,lines:[{saleItemId:Number(saleItem.id),qty:1}],refundMethod:'CARD_TO_CARD',refundAmount:100000})
assert.equal(Number(ret.total),500000);assert.equal(Number(ret.refundAmount),100000);assert.equal(Number(ret.sourceCreditRestoredAmount),400000)
const request=seed.one('SELECT id,kind,status,operationKind,returnId,sourceInvoiceId,amount,paidAmount,paidMethod FROM "CardTransferRequest" WHERE returnId=?',ret.id)
assert.ok(request,'CARD_TO_CARD return creates a linked transfer request')
assert.equal(request.kind,'REQUEST');assert.equal(request.status,'PENDING');assert.equal(Number(request.amount),100000)
assert.equal(seed.count('CashMovement','shiftId=?',shiftId),0,'pending C2C is not a drawer cash movement')
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',a).stock),9,'restock is held until manager confirms payment')
await check('return accepted; C2C request pending',{cash:600000,card:0,refundCash:0,refundCard:0})
await cardTransferService.pay({id:Number(request.id),paidAmount:100000,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:'TEST-C2C-S01C'})
const paid=seed.one('SELECT status,amount,paidAmount,paidMethod,trackingNo,paidByUserId FROM "CardTransferRequest" WHERE id=?',request.id)
assert.equal(paid.status,'PAID');assert.equal(Number(paid.amount),100000);assert.equal(Number(paid.paidAmount),100000);assert.equal(paid.paidMethod,'MANAGER_CARD_TO_CARD')
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',a).stock),10,'manager-confirmed transfer releases pending returned item')
await check('manager confirms 100k transfer; stock released',{cash:600000,card:0,refundCash:0,refundCard:0})
const output={generatedAt:new Date().toISOString(),scenario:'1C (settlement variant, not an independent scenario)',status:'PASS',isolatedDatabase:process.env.HARNESS_DB,
 amounts:{sale:1000000,cash:600000,credit:400000,returnedLine:500000,sourceCreditRestored:400000,c2cRequested:100000,c2cPaid:100000,blueAfterSale:600000,blueAfterReturn:600000},
 transfer:{id:Number(request.id),status:paid.status,amount:Number(paid.amount),paidAmount:Number(paid.paidAmount),paidMethod:paid.paidMethod,trackingNo:paid.trackingNo},checks}
const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true});writeFileSync(join(out,'deep-e2e-followup-scenario01c-card-to-card.json'),JSON.stringify(output,null,2)+'\n')
writeFileSync(join(out,'deep-e2e-followup-scenario01c-card-to-card.md'),`# سناریوی ۱C — شاخهٔ کارت‌به‌کارت (سناریوی مستقل جدید نیست)\n\n**نتیجه: ${output.status}.** سامانه روش CARD_TO_CARD را پذیرفت و درخواست ۱۰۰٬۰۰۰ ریالی ساخت؛ مدیر با رمز تست آن را پرداخت‌شده ثبت کرد.\n\n- فروش ۱٬۰۰۰٬۰۰۰ = ۶۰۰٬۰۰۰ نقد + ۴۰۰٬۰۰۰ در چهار بارکد ۱۰۰٬۰۰۰.\n- برگشت کالای ۵۰۰٬۰۰۰: اعتبار منبع ۴۰۰٬۰۰۰ برگشت؛ درخواست C2C برای ۱۰۰٬۰۰۰ ساخته شد؛ قبل از پرداخت مدیر موجودی در انتظار ماند.\n- پس از تأیید مدیر: درخواست ${paid.status} و ۱۰۰٬۰۰۰ پرداخت شد؛ موجودی کالای برگشتی آزاد شد.\n- مرجع آبی قبل و بعد ${output.amounts.blueAfterReturn} ماند؛ C2C نه CASH است نه POS، بنابراین در فرمول آبیِ نقد/POS وارد نشد. هیچ CashMovement نقدی ساخته نشد.\n- تطبیق مستقل خام اسناد و گزارش سرویس: ${JSON.stringify(checks)}\n\nاین آزمون نشان می‌دهد مسیر CARD_TO_CARD پذیرفته می‌شود؛ به‌تنهایی صحت همهٔ موارد پنل/چاپ واقعی یا انقضای اعتبار را ثابت نمی‌کند. دیتابیس SQLite موقت بود.`)
console.log(`Scenario 1C PASS: C2C accepted, pending then manager-paid; blue remains 600000`)
await db.$disconnect?.()
