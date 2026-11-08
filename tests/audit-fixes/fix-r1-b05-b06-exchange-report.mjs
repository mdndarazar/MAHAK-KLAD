/**
 * R1-B05 / R1-B06 acceptance:
 * - a return may have several related credit barcodes; reports expose every
 *   safe reference and aggregate from that array, not from the old scalar;
 * - exchange receipts classify CASH, CARD, MANAGER, and UNKNOWN separately.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-r1-b05-b06-exchange-report.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-r1-b05-b06-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { returnCreditAmountOf } = await import('../../src/shared/accounting.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('گزارش چند اعتبار')
const today = toJalaliDate(new Date())
const source = seed.invoice({ grandTotal: 20_000 })
const exchangeInvoice = seed.invoice({ grandTotal: 10_000 })
const returnedAt = Date.now()
const returnId = seed.insert('SaleReturn', {
  invoiceId: source.id,
  isFull: false,
  total: 20_000,
  returnedAt,
  returnedAtJalali: today,
  returnedAtTime: '12:00:00',
  kind: 'EXCHANGE',
  exchangeInvoiceId: exchangeInvoice.id,
  exchangeReceiptNo: exchangeInvoice.receiptNo,
  exchangeTotal: 10_000,
  exchangeDiff: -10_000,
  exchangeSettlement: 'CREDIT',
  refundMethod: 'STORE_CREDIT',
  refundAmount: 10_000,
  userId
})
sql.prepare('UPDATE "SaleInvoice" SET orderType=?, exchangeReturnId=?, sourceInvoiceId=? WHERE id=?')
  .run('EXCHANGE', returnId, source.id, exchangeInvoice.id)

const cashMethod = seed.insert('PaymentMethod', { key: 'R1-B06-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: 'R1-B06-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const customMethod = seed.insert('PaymentMethod', { key: 'R1-B06-CUSTOM', label: 'سایر', kind: 'CUSTOM', isActive: 1, sortOrder: 3 })
const exchangeCreditMethod = seed.insert('PaymentMethod', { key: 'R1-B06-EXCHANGE-CREDIT', label: 'ارزش برگشتی', kind: 'EXCHANGE_CREDIT', isActive: 0, sortOrder: 4 })
const addPayment = ({ methodId, amount, seq, destination = null, kind = 'CASH', chequeStatus = null, voidedAt = null }) =>
  seed.insert('Payment', { invoiceId: exchangeInvoice.id, methodId, amount, seq, destination, kind, chequeStatus, voidedAt })
addPayment({ methodId: cashMethod, amount: 1_000, seq: 1, destination: 'CASH' })
addPayment({ methodId: cardMethod, amount: 2_000, seq: 2, destination: 'CARD' })
addPayment({ methodId: cardMethod, amount: 3_000, seq: 3, destination: 'MANAGER' })
addPayment({ methodId: customMethod, amount: 4_000, seq: 4, destination: null })
addPayment({ methodId: exchangeCreditMethod, amount: 5_000, seq: 5, destination: 'CASH' })
addPayment({ methodId: customMethod, amount: 6_000, seq: 6, destination: 'MANAGER', kind: 'CHEQUE', chequeStatus: 'PENDING' })
addPayment({ methodId: cashMethod, amount: 7_000, seq: 7, destination: 'CASH', voidedAt: new Date() })

const makeCredit = (code, amount, { returnId: linkedReturn = null, status = 'ACTIVE', usedAmount = 0 } = {}) =>
  seed.insert('StoreCredit', {
    code,
    amount,
    source: 'EXCHANGE',
    status,
    returnId: linkedReturn,
    usedAmount,
    usedCount: usedAmount > 0 ? 1 : 0,
    maxUses: 2,
    multiUse: true,
    carryRemainder: true,
    issuedAt: new Date(),
    issuedAtJalali: today,
    issuedAtTime: '12:00:00',
    note: 'R1-B05 fixture'
  })
const creditA = makeCredit('R1B05A0001', 100, { returnId })
const creditB = makeCredit('R1B05B0001', 200, { returnId, status: 'USED', usedAmount: 100 })
const scalarOnlyCredit = makeCredit('R1B05C0001', 300)
const allocationOnlyCredit = makeCredit('R1B05D0001', 400, { status: 'PARTIALLY_USED', usedAmount: 50 })
sql.prepare('UPDATE "SaleReturn" SET storeCreditId=? WHERE id=?').run(scalarOnlyCredit, returnId)
seed.insert('CreditReturnAllocation', {
  eventKey: 'r1-b05-allocation-only-credit',
  invoiceId: source.id,
  returnId,
  redemptionId: 999,
  sourceCreditId: creditA,
  restoredCreditId: allocationOnlyCredit,
  amount: 400,
  creditRestored: true,
  settlementAdjusted: false,
  restrictScope: 'ALL',
  saleItemId: null,
  policyVersion: 1,
  createdAt: new Date()
})

const range = { fromJalali: today, toJalali: today, take: 100, skip: 0 }
const exchangeResult = await salesService.exchangeList(range)
const exchange = exchangeResult.rows.find((row) => row.returnId === returnId)
assert.ok(exchange, 'exchange report row is returned')
assert.deepEqual(exchange.storeCredits.map((credit) => credit.id), [creditA, creditB, scalarOnlyCredit, allocationOnlyCredit].sort((a, b) => a - b))
assert.equal(exchange.storeCreditReference, `اعتبار #${scalarOnlyCredit}`, 'legacy scalar remains compatible')
assert.equal(exchange.storeCreditAmount, 300, 'legacy scalar remains a single-credit field')
assert.equal(exchange.storeCreditTotal, 1_000, 'aggregate counts every associated credit')
assert.equal(exchange.storeCreditUsedTotal, 150, 'used amount is summed from the full credit array')
assert.equal(exchangeResult.totals.creditIssuedTotal, 1_000, 'report total is not based on the legacy scalar')
assert.equal(exchangeResult.totals.creditUsedTotal, 150)
assert.ok(exchange.storeCredits.every((credit) => !Object.hasOwn(credit, 'code') && !Object.hasOwn(credit, 'legacyCode')))
assert.ok(JSON.stringify(exchange.storeCredits).includes(`اعتبار #${allocationOnlyCredit}`))
assert.ok(!JSON.stringify(exchange.storeCredits).includes('R1B05'))
assert.equal(exchange.cashReceived, 1_000)
assert.equal(exchange.cardReceived, 2_000)
assert.equal(exchange.managerReceived, 3_000)
assert.equal(exchange.unknownReceived, 4_000)
assert.equal(exchangeResult.totals.cashReceivedTotal, 1_000)
assert.equal(exchangeResult.totals.cardReceivedTotal, 2_000)
assert.equal(exchangeResult.totals.managerReceivedTotal, 3_000)
assert.equal(exchangeResult.totals.unknownReceivedTotal, 4_000)

const returnResult = await salesService.returnList({ ...range, includeExchanges: true })
const returnRow = returnResult.find((row) => row.id === returnId)
assert.ok(returnRow, 'return report row is returned')
assert.equal(returnRow.storeCredits.length, 4)
assert.equal(returnRow.storeCreditTotal, 1_000)
assert.equal(returnCreditAmountOf(returnRow), 1_000, 'return report amount sums the safe array')
assert.equal(returnCreditAmountOf({
  refundMethod: 'STORE_CREDIT',
  refundAmount: 999,
  storeCredits: [{ amount: 40 }, { amount: 60 }]
}), 100, 'the full array takes precedence over the old scalar/refund amount')

console.log('✓ R1-B05 all safe return credits/aggregate and R1-B06 CASH/CARD/MANAGER/UNKNOWN exchange buckets passed')
