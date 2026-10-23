/**
 * Regression coverage for split return settlement and source-aware overpay.
 * Isolated SQLite harness only; no customer database is touched.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-return-split-source-overpay.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-return-split-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService, saleWhere } = await import('../../src/main/services/SalesService.ts')
const { buildStatements } = await import('../../src/main/services/accountingReport.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { allocateOverpay, refundFromReceivedOf, remainingOf } = await import('../../src/shared/settlement.ts')
const { calculateReturnTotals, returnCreditAmountOf } = await import('../../src/shared/accounting.ts')
const { toJalaliDate, jalaliStartOfDay, jalaliEndOfDay } = await import('../../src/shared/jalali.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('Return split/source regression')
const categoryId = seed.category('Regression goods')
const productId = seed.product('Mixed tender goods', categoryId)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const day = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, dayJalali: day, openedAt: Date.now() - 3600_000, userId })
function variant(price) {
  const id = seed.variant(productId)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
async function credit(amount, note) {
  return db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount, multiUse: false, maxUses: 1, carryRemainder: false,
    days: 30, note, userId
  }))
}

// 1) Exact requested case: 5M invoice = 4M real money + 1M source credit.
const v5m = variant(5_000_000)
const sourceGift = await credit(1_000_000, 'gift tender for mixed return test')
const mixed = await salesService.create({
  userId, shiftId, lines: [line(v5m, 5_000_000)],
  payments: [{ methodId, amount: 4_000_000, destination: 'CASH' }],
  storeCreditCode: sourceGift.code, storeCreditAmount: 1_000_000,
  storeCreditIdempotencyKey: 'split-source-gift-spend'
})
assert.equal(Number(mixed.grandTotal), 5_000_000)
assert.equal(Number(mixed.paidTotal), 5_000_000)
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', mixed.id).id
const preview = await salesService.returnProvenancePreview({ invoiceId: mixed.id, lines: [{ saleItemId, qty: 1 }] })
assert.deepEqual([preview.returnTotal, preview.debtReduced, preview.giftOpportunity, preview.cashRight],
  [5_000_000, 0, 1_000_000, 4_000_000])
const result = await salesService.createReturn({
  invoiceId: mixed.id, full: true, lines: [{ saleItemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 2_000_000, refundStoreCreditAmount: 2_000_000,
  userId, shiftId
})
const saved = seed.one('SELECT total, refundMethod, refundAmount, refundStoreCreditAmount, realMoneyRefundAmount, creditRestored FROM "SaleReturn" WHERE id=?', result.id)
assert.deepEqual([
  Number(saved.total), saved.refundMethod, Number(saved.refundAmount), Number(saved.refundStoreCreditAmount),
  Number(saved.realMoneyRefundAmount), Number(saved.creditRestored)
], [5_000_000, 'CASH', 2_000_000, 2_000_000, 4_000_000, 1_000_000])
assert.equal(Number(result.invoiceOverpaid), 0, 'restoring gift source does not create overpay')
assert.equal(Number(result.invoiceRemaining), 0)
assert.equal(Number(result.creditOpportunity?.restored), 1_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) AS n FROM "CreditReturnAllocation" WHERE returnId=?', result.id).n), 1_000_000)
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v5m).stock), 100,
  'ordinary cash+barcode return immediately restores stock')

const returnMovements = seed.rows('SELECT type, amount FROM "CashMovement" WHERE refType=\'SaleReturn\' AND refId=?', result.id)
assert.equal(returnMovements.length, 1, 'the barcode leg creates no cash movement')
assert.equal(returnMovements[0].type, 'RETURN_REFUND')
assert.equal(Number(returnMovements[0].amount), 2_000_000)
assert.throws(() => sql.prepare(`INSERT INTO "CashMovement" (amount, type, refType, refId)
  VALUES (1000000, 'RETURN_REFUND', 'SaleReturn', ?)` ).run(result.id),
  /Return cash refund exceeds the authorized real-money entitlement/,
  'database protects the full right against a second cash movement')
const totals = calculateReturnTotals([{
  kind: 'RETURN', total: Number(saved.total), refundMethod: saved.refundMethod,
  refundAmount: Number(saved.refundAmount), refundStoreCreditAmount: Number(saved.refundStoreCreditAmount),
  creditRestored: Number(saved.creditRestored)
}])
assert.equal(Number(totals.cashRefunds), 2_000_000)
assert.equal(Number(totals.storeCreditIssued), 2_000_000)
assert.equal(returnCreditAmountOf({ refundMethod: 'CASH', refundAmount: 2_000_000,
  refundStoreCreditAmount: 2_000_000 }), 2_000_000)
assert.equal(Number(totals.debtOnlyReturns), 0)
const filter = { fromJalali: day, toJalali: day }
const { statements } = await buildStatements({
  where: saleWhere(filter), from: jalaliStartOfDay(day), to: jalaliEndOfDay(day),
  period: { fromJalali: day, toJalali: day, source: 'explicit' }, filter
})
assert.equal(Number(statements.returns.cashRefunds), 2_000_000)
assert.equal(Number(statements.returns.storeCreditRefunds), 2_000_000)
assert.equal(Number(statements.returns.debtOnlyReturns), 0,
  'aggregate financial report keeps the barcode leg separate from cash and debt')
const cashBridge = statements.bridge.rows.find((row) => row.key === 'cashRefunds')
assert.equal(Number(cashBridge?.amount ?? 0), 2_000_000,
  'the cash bridge includes only the 2M cash leg, never the 2M barcode leg')
const returnHtml = await printService.returnHtml(result.id)
assert.match(returnHtml, /بارکد اعتبار از سهم پول واقعی/)
assert.match(returnHtml, /2,000,000|۲٬۰۰۰٬۰۰۰/)
assert.doesNotMatch(returnHtml, new RegExp(sourceGift.code), 'return receipt must not expose the spent source barcode')
assert.equal(refundFromReceivedOf({ kind: 'RETURN', total: 5_000_000, refundMethod: 'CASH',
  refundAmount: 2_000_000, refundStoreCreditAmount: 2_000_000 }), 4_000_000)
const creditBarcode = seed.one('SELECT id, amount FROM "StoreCredit" WHERE id=(SELECT storeCreditId FROM "SaleReturn" WHERE id=?)', result.id)
assert.equal(Number(creditBarcode.amount), 2_000_000)
// Cash received 4M minus cash movement out 2M = the blue-reference cash effect +2M.
const realCashIn = seed.rows('SELECT p.amount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? AND p.storeCreditId IS NULL AND upper(m.kind)=\'CASH\' AND p.destination=\'CASH\'', mixed.id)
const cashOut = returnMovements.reduce((sum, row) => sum + Number(row.amount), 0)
assert.equal(realCashIn.reduce((sum, row) => sum + Number(row.amount), 0) - cashOut, 2_000_000)
// DB-level ceiling prevents duplicate use of the authorized right.
assert.throws(() => sql.prepare('UPDATE "SaleReturn" SET refundStoreCreditAmount=3000000 WHERE id=?').run(result.id),
  /Return settlement legs exceed the authorized real-money entitlement/)
assert.throws(() => sql.prepare("UPDATE \"SaleReturn\" SET refundMethod='CARD' WHERE id=?").run(result.id),
  /Split store-credit refunds require the CASH primary settlement/)

// 2) Historical overpay attribution: store credit is applied to invoice value
// before actual cash, regardless of the insertion order of the payment rows.
const overpayGift = await credit(1_000_000, 'credit tender for legacy overpay provenance test')
const vLegacy = variant(5_000_000)
const legacyMixed = await salesService.create({
  userId, shiftId, lines: [line(vLegacy, 5_000_000)],
  payments: [{ methodId, amount: 4_000_000, destination: 'CASH' }],
  storeCreditCode: overpayGift.code, storeCreditAmount: 1_000_000,
  storeCreditIdempotencyKey: 'source-aware-overpay-legacy-mixed'
})
// A historical debt-only return can make the invoice-level aggregate overpaid
// while the earlier order-based row allocation incorrectly put the excess on
// the barcode tender. Use a legacy-shaped row to exercise the safe repair path.
sql.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, total, returnedAt, returnedAtJalali, kind, refundMethod, refundAmount, creditRestored)
  VALUES (?, 1000000, ?, ?, 'RETURN', 'NONE', 0, 0)`)
  .run(legacyMixed.id, Date.now(), day)
await salesService.overpayCreditIssue({ invoiceId: legacyMixed.id, amount: 1_000_000,
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
const attributed = seed.rows(`SELECT p.id, p.amount, p.overpayAmount, p.storeCreditId
  FROM "Payment" p WHERE p.invoiceId=? AND p.voidedAt IS NULL ORDER BY p.seq, p.id`, legacyMixed.id)
const cashOverpayRow = attributed.find((row) => row.storeCreditId == null)
const creditOverpayRow = attributed.find((row) => row.storeCreditId != null)
assert.equal(Number(cashOverpayRow.overpayAmount), 1_000_000,
  'invoiceDebt wires provenance so cash backs the one-million overpay')
assert.equal(Number(creditOverpayRow.overpayAmount), 0,
  'a store-credit payment is never counted as a cashable overpay source')
assert.equal(attributed.reduce((sum, row) => sum + Number(row.overpayAmount), 0), 1_000_000,
  'database row allocation conserves invoice-level overpay')
assert.equal(Number(seed.one('SELECT amount FROM "StoreCredit" WHERE source=\'OVERPAY\' AND sourceInvoiceId=?', legacyMixed.id).amount),
  1_000_000, 'the cash-backed overpay credit is issuable')
const pure = allocateOverpay([
  { id: 1, amount: 3_000_000, received: true, cashable: true },
  { id: 2, amount: 2_000_000, received: true, cashable: false }
], { payable: 4_000_000, refundFromReceived: 0 })
assert.equal(pure.get(1), 1_000_000)
assert.equal(pure.get(2), 0)
const reversed = allocateOverpay([
  { id: 2, amount: 2_000_000, received: true, cashable: false },
  { id: 1, amount: 3_000_000, received: true, cashable: true }
], { payable: 4_000_000, refundFromReceived: 0 })
assert.equal(reversed.get(1), 1_000_000)
assert.equal(reversed.get(2), 0)
assert.equal([...pure.values()].reduce((sum, amount) => sum + amount, 0), 1_000_000,
  'source-aware reattribution conserves invoice-level overpay')
assert.equal(remainingOf({ grandTotal: 4_000_000, received: 5_000_000, returnedValue: 0, refundFromReceived: 0 }).overpaid,
  1_000_000)

console.log('✓ 5M mixed sale: 2M cash + 2M new barcode + 1M source credit restored; no overpay')
console.log('✓ return stock and report totals reflect the separate settlement legs')
console.log('✓ cash ledger outflow remains 2M; real-money net effect is +2M')
console.log('✓ source-aware overpay stays on cash, independent of tender row order')
console.log('✓ DB trigger blocks settlement legs above the authorized right')
