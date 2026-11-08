/* Isolated follow-up for parent-suite cases 7 and 8, because case 7 throws
 * before the parent runner can reach case 8. Set MAHAK_MATRIX_CASE=7 or 8.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const which = Number(process.env.MAHAK_MATRIX_CASE)
assert.ok(which === 7 || which === 8, 'MAHAK_MATRIX_CASE must be 7 or 8')
const dir = mkdtempSync(join(tmpdir(), `mahak-exch-credit-case${which}-`))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const today = toJalaliDate(new Date()), userId = seed.user(`matrix case ${which}`)
const shiftId = seed.insert('Shift', { name: `matrix case ${which}`, number: 100 + which, dayJalali: today, openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: `M${which}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: `M${which}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cheque = seed.insert('PaymentMethod', { key: `M${which}-CHEQUE`, label: 'isolated cheque', kind: 'CHEQUE', isActive: 1, sortOrder: 3 })
const category = seed.category(`matrix case ${which}`), product = seed.product(`matrix goods ${which}`, category)
let vseq = 0
const variant = price => { const id=seed.variant(product, `m${which}-${++vseq}`); sql.prepare('UPDATE "ProductVariant" SET stock=100,salePrice=? WHERE id=?').run(price,id); return id }
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const n = x => Number(x ?? 0)
const snapshot = async () => ({
  invoices: seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId),
  returns: seed.count('SaleReturn', 'shiftId=?', shiftId), payments: seed.count('Payment', 'createdShiftId=?', shiftId),
  cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'),
  stock: [0,1,2,3].slice(0,vseq).map(i => { const id=i+1; return { id, onHand:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock), ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d) } }),
  blue: n(await physicalMovementForCustodyShift(shiftId))
})
const out={case:which,status:'RUNNING',isolatedDatabase:process.env.HARNESS_DB}
try {
  if (which === 7) {
    const source=variant(1_000_000), replacement=variant(500_000)
    const sale=await salesService.create({ userId,shiftId,lines:[line(source,1_000_000)],payments:[{methodId:cash,amount:700_000,destination:'CASH'}] })
    const item=n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',sale.id).id)
    const before=await snapshot(); let error=''
    try { await salesService.createExchange({ userId,shiftId,invoiceId:sale.id,lines:[{saleItemId:item,qty:1}],replacements:[line(replacement,500_000)],refundMode:'STORE_CREDIT' }) }
    catch(e){error=String(e?.message??e)}
    const after=await snapshot()
    assert.ok(error,'expected case-7 behavior should be captured as a block, not a hidden successful pass')
    assert.deepEqual(after,before,'blocked exchange must leave invoice, return, payment, credit, stock and blue unchanged')
    const report=await salesService.reportRows({shiftId})
    out.status='BLOCKED'
    out.amounts={sourceSale:1_000_000,cashActuallyPaid:700_000,remainingDebt:300_000,replacement:500_000,negativeDifference:500_000,expectedDebtReduction:300_000,expectedStoreCredit:200_000,expectedCashRefund:0}
    out.actual={error,mutationFree:true,sourceInvoiceId:n(sale.id),reportTotals:report.totals,before,after}
    out.policyAssessment='The parent scenario expects debt to be reduced by 300,000 first and only the remaining 200,000 to become non-cash store credit. The service rejected the exchange instead; the recorded business error says 1,000,000 real-money backing was required although only 700,000 cash was received.'
  } else {
    const cashItem=variant(2_000_000), chequeItem=variant(2_000_000)
    const sale=await salesService.create({ userId,shiftId,lines:[line(cashItem,2_000_000),line(chequeItem,2_000_000)],payments:[{methodId:cash,amount:1_000_000,destination:'CASH'},{methodId:card,amount:1_500_000,destination:'CARD'}] })
    const chequeId=seed.insert('Payment',{invoiceId:sale.id,methodId:cheque,amount:1_500_000,kind:'CHEQUE',seq:3,chequeStatus:'PENDING',paidAt:Date.now(),paidAtJalali:today})
    const item=n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',sale.id,cashItem).id)
    const returned=await salesService.createReturn({invoiceId:sale.id,lines:[{saleItemId:item,qty:1}],refundMethod:'CASH',refundAmount:500_000,userId,shiftId})
    const pending=seed.one('SELECT chequeStatus,amount FROM "Payment" WHERE id=?',chequeId)
    const raw=seed.one(`SELECT
      COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
      COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
      FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
    const refund=n(seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type='RETURN_REFUND'",shiftId).amount)
    const report=await salesService.reportRows({shiftId}), blue=n(await physicalMovementForCustodyShift(shiftId))
    const stock=[cashItem,chequeItem].map((id,i)=>({name:i===0?'returned cash-paid item':'kept item with pending cheque',actual:n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),ledger:n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',id).d)}))
    assert.equal(n(returned.refundAmount),500_000)
    assert.equal(pending.chequeStatus,'PENDING')
    assert.equal(n(pending.amount),1_500_000)
    assert.equal(refund,500_000)
    assert.equal(n(raw.cash),1_000_000)
    assert.equal(n(raw.card),1_500_000)
    assert.equal(blue,2_000_000)
    assert.equal(stock[0].actual,100); assert.equal(stock[0].ledger,0)
    assert.equal(stock[1].actual,99); assert.equal(stock[1].ledger,-1)
    out.status='PASS'
    out.amounts={grossSale:4_000_000,cashPaid:1_000_000,cardPaid:1_500_000,pendingCheque:1_500_000,returnedItemValue:2_000_000,cashRefund:500_000}
    out.actual={returnId:n(returned.id),refund:n(returned.refundAmount),pendingChequeStatus:pending.chequeStatus,rawCash:n(raw.cash),rawCard:n(raw.card),cashRefund:refund,blue,reportTotals:report.totals,stock}
    out.policyAssessment='The returned item was 2,000,000; the still-pending cheque share (1,500,000) was not treated as money received, so only the 500,000 actually cash-backed remainder was refunded. The cheque remains pending.'
  }
} catch(error){out.status='HARNESS_OR_ASSERTION_FAILURE';out.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally {
 const dirOut=resolve(process.cwd(),'reports','deep-e2e-exchange-credit-tender-case7-8')
 mkdirSync(dirOut,{recursive:true});writeFileSync(join(dirOut,`case${which}.json`),JSON.stringify(out,null,2)+'\n')
 await db.$disconnect?.()
 if(out.status==='HARNESS_OR_ASSERTION_FAILURE')process.exitCode=1
}
