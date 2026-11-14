/* Controlled SQLite-only probes for seller-entered invoice-level discounts:
 * unequal-price exchanges and same-price replacement (including a 4-line bill).
 */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const scenario=String(process.env.MAHAK_SELLER_DISCOUNT_CASE??'').toUpperCase()
assert.ok(['SINGLE-LOW','SINGLE-EQUAL','SINGLE-HIGH','MULTI-EQUAL-CROSS-CATEGORY'].includes(scenario),'Set MAHAK_SELLER_DISCOUNT_CASE to SINGLE-LOW, SINGLE-EQUAL, SINGLE-HIGH, or MULTI-EQUAL-CROSS-CATEGORY')
const dir=mkdtempSync(join(tmpdir(),`mahak-seller-discount-${scenario.toLowerCase()}-`))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`seller invoice discount exchange ${scenario}`)
const shiftId=seed.insert('Shift',{name:`seller-discount-${scenario}`,number:9200+['SINGLE-LOW','SINGLE-EQUAL','SINGLE-HIGH','MULTI-EQUAL-CROSS-CATEGORY'].indexOf(scenario),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`SELLER-DISCOUNT-${scenario}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const sourceCategory=seed.category(`source category ${scenario}`),replacementCategory=seed.category(`different replacement category ${scenario}`)
function variant(label,price,category=sourceCategory){const p=seed.product(`${scenario}-${label}`,category),v=seed.variant(p,label);sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price,v);return v}
const multi=scenario==='MULTI-EQUAL-CROSS-CATEGORY'
const base=multi?10_000_000:20_000_000
const invoiceDiscount=multi?10_000_000:2_000_000
const originals=multi?['A','B','C','D'].map(label=>({label,variantId:variant(`source-${label}`,base),unitPrice:base})): [{label:'source',variantId:variant('source',base),unitPrice:base}]
const replacementPrice=scenario==='SINGLE-LOW'?10_000_000:scenario==='SINGLE-HIGH'?30_000_000:base
const replacement=variant('replacement-different-product',replacementPrice,replacementCategory)
const totalGross=originals.reduce((s,x)=>s+x.unitPrice,0),netTotal=totalGross-invoiceDiscount
const out={scenario,isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING',setup:{lineCount:originals.length,totalGross,invoiceDiscount,netTotal,sourceUnitPrice:base,replacementPrice,replacementIsDifferentProduct:true,replacementIsDifferentCategory:true}}
try{
 const sale=await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' }, userId,shiftId,lines:originals.map(x=>({variantId:x.variantId,qty:1,unitPrice:x.unitPrice,discount:0,tax:0})),invoiceDiscount,payments:[{methodId:cash,amount:netTotal,destination:'CASH'}]})
 const root=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
 const items=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
 assert.equal(items.length,originals.length)
 const source=items.find(i=>n(i.variantId)===originals[0].variantId)
 const preview=await salesService.previewExchangeFunding({invoiceId:sale.id,lines:[{saleItemId:n(source.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}]})
 assert.equal(preview.ok,true)
 const operation=await salesService.createExchange({userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:n(source.id),qty:1}],replacements:[{variantId:replacement,qty:1,unitPrice:replacementPrice,discount:0,tax:0}],methodId:cash,refundMode:n(preview.effectiveDiff)<0?'CASH':undefined,managerPassword:DEFAULT_MANAGER_PASSWORD,expectedSettlementDiff:n(preview.effectiveDiff),idempotencyKey:`seller-discount-${scenario}`})
 const child=seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?',operation.exchangeInvoiceId)
 const rootAfter=seed.one('SELECT grandTotal,paidTotal,discountTotal FROM "SaleInvoice" WHERE id=?',sale.id)
 const returned=seed.one('SELECT total,exchangeDiff,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?',operation.returnId)
 const cashLedger=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"Payment\" WHERE createdShiftId=? AND kind='CASH' AND voidedAt IS NULL",shiftId).amount)
 const refundLedger=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')",shiftId).amount)
 const blue=n(await physicalMovementForCustodyShift(shiftId)),report=await salesService.reportRows({shiftId})
 const stock=[...originals.map(x=>x.variantId),replacement].map((id,i)=>({label:i<originals.length?`source-${originals[i].label}`:'replacement',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
 const proportionalShare=Math.round(invoiceDiscount*base/totalGross)
 const expectedReturn=base-proportionalShare
 const actualDiff=replacementPrice-expectedReturn
 out.sale={gross:totalGross,invoiceDiscount,netPaid:netTotal,items:items.map((it,i)=>({label:originals[i].label,gross:n(it.unitPrice),recordedLineDiscount:n(it.discount),lineTotal:n(it.lineTotal)}))}
 out.exchange={sourceGross:base,allocatedInvoiceDiscountShare:proportionalShare,sourceReturnValue:n(operation.returnTotal),replacementGross:replacementPrice,replacementCategoryDifferent:true,actualDifference:n(operation.diff),previewDifference:n(preview.effectiveDiff),cashReceived:n(operation.cashReceived),cashRefunded:n(operation.cashRefunded),replacementInvoiceDiscount:n(child.discountTotal),refundMethod:returned.refundMethod}
 out.reconciliation={cashLedger,refundLedger,blue,reportTotals:report.totals,stock,payments:seed.rows('SELECT p.id,p.invoiceId,p.amount,p.kind,p.destination,m.kind methodKind,m.key FROM "Payment" p LEFT JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? ORDER BY p.id',shiftId),cashMovements:seed.rows('SELECT type,amount FROM "CashMovement" WHERE shiftId=? ORDER BY id',shiftId),cheques:seed.count('Payment',`createdShiftId=? AND UPPER(kind) IN ('CHECK','CHEQUE')`,shiftId)}
 assert.equal(n(root.grandTotal),netTotal);assert.equal(n(root.paidTotal),netTotal);assert.equal(n(root.discountTotal),invoiceDiscount)
 assert.equal(n(operation.returnTotal),expectedReturn)
 assert.equal(n(returned.total),expectedReturn)
 assert.equal(n(operation.exchangeTotal),replacementPrice)
 assert.equal(n(operation.diff),actualDiff);assert.equal(n(preview.effectiveDiff),actualDiff)
 assert.equal(n(child.grandTotal),replacementPrice);assert.equal(n(child.paidTotal),replacementPrice)
 assert.ok(root.settledAt!=null&&child.settledAt!=null)
 assert.deepEqual(stock.map(x=>x.actual),[...originals.map((_,i)=>i===0?10:9),9]);for(const x of stock)assert.equal(x.actual,10+x.ledger)
 out.status='PASS'
}catch(error){out.status='FAIL';out.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const reports=resolve(process.cwd(),'reports','deep-e2e-seller-invoice-discount-exchange-policy');mkdirSync(reports,{recursive:true})
 const slug=scenario.toLowerCase();writeFileSync(join(reports,`${slug}.json`),JSON.stringify(out,null,2)+'\n')
 const md=[`# Seller invoice-discount exchange — ${scenario}`,'',`**Technical and ledger reconciliation:** ${out.status}`,`**Isolated SQLite:** ${out.isolatedDatabase}`,'',
 '## Fixture',`- Original receipt: ${out.setup?.lineCount} item(s), gross ${out.setup?.totalGross}, invoice-level discount ${out.setup?.invoiceDiscount}, net paid ${out.setup?.netTotal}.`,`- Source item: ${out.setup?.sourceUnitPrice}; replacement: ${out.setup?.replacementPrice}; replacement is a different product and category.`,
 '','## Observed exchange',`- ${JSON.stringify(out.exchange??out.failure??null)}`,'',
 '## Ledger reconciliation',`- ${JSON.stringify(out.reconciliation??null)}`,'',
 'Only isolated temporary SQLite was used. No production/staging/live database or real money; no production logic changed.']
 writeFileSync(join(reports,`${slug}.md`),md.join('\n')+'\n')
 await db.$disconnect?.();if(out.status!=='PASS')process.exitCode=1
}
