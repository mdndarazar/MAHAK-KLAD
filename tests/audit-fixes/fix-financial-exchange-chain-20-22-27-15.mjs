/**
 * Owner-approved chained-exchange examples (20M / 22M / 27M / 15M) and the
 * global blue reference.  The 27M replacement is funded by a 25M returned
 * source plus exactly 2M received in real cash/card; the later 15M exchange
 * returns the original 5M gift share to its own root and refunds only the 7M
 * real-money remainder to the selected POS destination.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-chain-20-22-27-15.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-chain-blue-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { attachVerifiedCustodySaleOperator, salesService } = await import('../../src/main/services/SalesService.ts')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesLedger } = await import('../../src/main/services/SalesLedger.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const managerId = seed.user('manager exchange chain blue')
const userId = seed.user('cashier exchange chain blue')
const receiverId = seed.user('receiver exchange chain blue')
await custodyService.setPin({ userId: managerId, newPassword: 'ManagerChain!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: managerId, managerPassword: 'ManagerChain!' })
for (const [id, temporary, permanent] of [
  [userId, 'CashierChain!', 'CashierChain2!'],
  [receiverId, 'ReceiverChain!', 'ReceiverChain2!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: managerId, managerPassword: 'ManagerChain!', reason: 'راه‌اندازی آزمون زنجیره و عدد آبی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
const opened = await custodyService.open({ userId, password: 'CashierChain2!', operationalTotal: 0 })
const shiftId = opened.shiftId
const fence = await custodyService.actorForFinancialOperation()
const cashMethod = seed.insert('PaymentMethod', {
  key: 'CHAIN-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethod = seed.insert('PaymentMethod', {
  key: 'CHAIN-CARD', label: 'کارت‌خوان', kind: 'CARD', isActive: 1, sortOrder: 2
})
const categoryId = seed.category('exchange-chain-blue')
let variantNo = 0
const variant = (price) => {
  const id = seed.variant(seed.product(`chain item ${++variantNo}`, categoryId))
  sql.prepare('UPDATE "ProductVariant" SET stock=50, salePrice=? WHERE id=?').run(price, id)
  return id
}
const credit = (code, amount, expiresAt) => seed.insert('StoreCredit', {
  code, amount, source: 'MANUAL', usedAmount: 0, usedCount: 0, maxUses: 1,
  multiUse: 0, carryRemainder: 1, status: 'ACTIVE', issuedAt: Date.now(),
  issuedAtJalali: today, expiresAt
})
const sale = ({ item, amount, creditCode, creditAmount, cashAmount, cardAmount = 0, key }) =>
  salesService.create(attachVerifiedCustodySaleOperator({
    userId, shiftId, custodyFence: fence,
    lines: [{ variantId: item, qty: 1, unitPrice: amount, discount: 0, tax: 0 }],
    payments: [
      ...(cashAmount ? [{ methodId: cashMethod, amount: cashAmount, destination: 'CASH' }] : []),
      ...(cardAmount ? [{ methodId: cardMethod, amount: cardAmount, destination: 'CARD' }] : [])
    ],
    ...(creditCode ? {
      storeCreditCode: creditCode, storeCreditAmount: creditAmount,
      storeCreditIdempotencyKey: key
    } : {})
  }, {
    custodyShiftId: fence.expectedShiftId,
    custodianUserId: fence.expectedActorUserId,
    operatorKind: 'MANAGER_SESSION', operatorUserId: null, authMethod: 'MANAGER_SESSION'
  }))
const exchange = (input) => salesService.createExchange({ ...input, custodyFence: fence })
const saleItem = (invoiceId) => Number(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1', invoiceId
).id)
const expectBlue = async ({ cash, card, refundCash = 0, refundCard = 0, exchangeRefundCash = refundCash, exchangeRefundCard = refundCard, label }) => {
  const report = await salesService.reportRows({ shiftId })
  assert.equal(Number(report.totals.cashTotal), cash, `${label}: exact real cash receipts`)
  assert.equal(Number(report.totals.cardTotal), card, `${label}: exact real POS receipts`)
  assert.equal(Number(report.totals.refundCashTotal), refundCash, `${label}: exact cash refunds`)
  assert.equal(Number(report.totals.refundCardTotal), refundCard, `${label}: exact POS refunds`)
  assert.equal(Number(report.accounting.bridge.unexplained), 0, `${label}: source/movement bridge closes without double counting`)
  const bridge = Object.fromEntries((report.accounting.bridge.rows ?? []).map((row) => [row.key, row.sign * row.amount]))
  assert.equal(Number(bridge.exchangeCashRefunds ?? 0), -exchangeRefundCash, `${label}: exact cash-exchange-refund bridge row`)
  assert.equal(Number(bridge.exchangeCardRefunds ?? 0), -exchangeRefundCard, `${label}: exact POS-exchange-refund bridge row`)
  assert.equal(Number(bridge.cashRefunds ?? 0), -(refundCash - exchangeRefundCash), `${label}: exact simple-return cash-refund bridge row`)
  const expectedBlue = cash + card - refundCash - refundCard
  assert.equal(await physicalMovementForCustodyShift(shiftId), expectedBlue,
    `${label}: drawer + store POS blue reference; credit/debt/offset excluded`)
  return { report, expectedBlue }
}

// Scenario 20M -> 22M: only the customer's exact 2M cash/card top-up changes blue.
const rootExpiry = new Date(Date.now() + 21 * 86_400_000 + 1234)
const rootCreditId = credit('CHAINGIFT5M', 5_000_000, rootExpiry)
const original20 = await sale({
  item: variant(20_000_000), amount: 20_000_000,
  creditCode: 'CHAINGIFT5M', creditAmount: 5_000_000,
  cashAmount: 15_000_000, key: 'chain-20m-gift'
})
await expectBlue({ cash: 15_000_000, card: 0, label: '20M source sale' })
const to22 = await exchange({
  userId, shiftId, invoiceId: original20.id,
  lines: [{ saleItemId: saleItem(original20.id), qty: 1 }],
  replacements: [{ variantId: variant(22_000_000), qty: 1 }],
  splitPayment: true,
  payments: [
    { methodId: cashMethod, amount: 1_000_000, destination: 'CASH' },
    { methodId: cardMethod, amount: 1_000_000, destination: 'CARD' }
  ]
})
assert.equal(to22.returnTotal, 20_000_000)
assert.equal(to22.exchangeTotal, 22_000_000)
assert.equal(to22.diff, 2_000_000)
assert.equal(to22.cashReceived, 1_000_000)
assert.equal(to22.cardReceived, 1_000_000)
assert.equal(to22.barcodeCreditApplied, 0)
assert.equal(to22.debtReduction, 0)
assert.equal(to22.storeCredit, null)
await expectBlue({ cash: 16_000_000, card: 1_000_000, label: '20M -> 22M' })
console.log('✓ 20M → 22M: the exact 2M difference is received as 1M cash + 1M POS; neither credit nor debt is fabricated')

// Continue the same chain through 25M so that 27M is a genuine descendant:
// 22M -> 25M adds 3M real funds; then 25M -> 27M adds exactly 2M real cash/card.
// The original non-cash 5M barcode remains its own source and never enters blue.
const to25 = await exchange({
  userId, shiftId, invoiceId: to22.exchangeInvoiceId,
  lines: [{ saleItemId: saleItem(to22.exchangeInvoiceId), qty: 1 }],
  replacements: [{ variantId: variant(25_000_000), qty: 1 }],
  splitPayment: true,
  payments: [
    { methodId: cashMethod, amount: 2_000_000, destination: 'CASH' },
    { methodId: cardMethod, amount: 1_000_000, destination: 'CARD' }
  ]
})
assert.equal(to25.returnTotal, 22_000_000)
assert.equal(to25.exchangeTotal, 25_000_000)
assert.equal(to25.diff, 3_000_000)
assert.equal(to25.cashReceived, 2_000_000)
assert.equal(to25.cardReceived, 1_000_000)
assert.equal(to25.barcodeCreditApplied, 0)
assert.equal(to25.debtReduction, 0)
await expectBlue({ cash: 18_000_000, card: 2_000_000, label: '22M -> 25M' })

const to27 = await exchange({
  userId, shiftId, invoiceId: to25.exchangeInvoiceId,
  lines: [{ saleItemId: saleItem(to25.exchangeInvoiceId), qty: 1 }],
  replacements: [{ variantId: variant(27_000_000), qty: 1 }],
  splitPayment: true,
  payments: [
    { methodId: cashMethod, amount: 1_000_000, destination: 'CASH' },
    { methodId: cardMethod, amount: 1_000_000, destination: 'CARD' }
  ]
})
assert.equal(to27.returnTotal, 25_000_000)
assert.equal(to27.exchangeTotal, 27_000_000)
assert.equal(to27.diff, 2_000_000)
assert.equal(to27.cashReceived, 1_000_000)
assert.equal(to27.cardReceived, 1_000_000)
assert.equal(to27.cashDue, 2_000_000)
assert.equal(to27.barcodeCreditApplied, 0, 'the specified 2M at 27M is not covered by a barcode')
assert.equal(to27.debtReduction, 0, 'the specified 2M at 27M is not recorded as debt')
assert.equal(to27.storeCredit, null, 'no synthetic credit is issued for the 27M difference')
assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id=?').get(rootCreditId).status), 'USED')
await expectBlue({ cash: 19_000_000, card: 3_000_000, label: '25M -> 27M' })
console.log('✓ 27M case: exact 2M is 1M cash + 1M POS; no debt, synthetic barcode or duplicate drawer/POS count')

// 27M -> 15M: source-specific return. Five million gift is rooted back to its
// own barcode; only seven million of actual money is refunded in cash.
const to15 = await exchange({
  userId, shiftId, invoiceId: to27.exchangeInvoiceId,
  lines: [{ saleItemId: saleItem(to27.exchangeInvoiceId), qty: 1 }],
  replacements: [{ variantId: variant(15_000_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(to15.returnTotal, 27_000_000)
assert.equal(to15.exchangeTotal, 15_000_000)
assert.equal(to15.diff, -12_000_000)
assert.equal(to15.cashRefunded, 7_000_000,
  'only 7M real-money source remainder is refundable; 5M gift share stays non-cash')
assert.equal(to15.refundMode, 'CASH')
assert.equal(to15.debtReduction, 0)
assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id=?').get(rootCreditId).status), 'USED',
  'fully spent root remains USED after its value is returned')
const returnedGift = seed.one(
  'SELECT id, source, amount, expiresAt, returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1',
  to15.returnId
)
assert.ok(returnedGift && Number(returnedGift.id) !== rootCreditId)
assert.equal(returnedGift.source, 'MANUAL', 'returned barcode value retains its source class')
assert.equal(Number(returnedGift.amount), 5_000_000)
assert.equal(new Date(returnedGift.expiresAt).getTime(), rootExpiry.getTime(),
  'returned gift share uses the actual root barcode expiry')
const blue = await expectBlue({
  cash: 19_000_000, card: 3_000_000, refundCash: 7_000_000, refundCard: 0,
  label: '27M -> 15M'
})
assert.equal(blue.expectedBlue, 15_000_000,
  'blue ends at 15M: 19M cash + 3M POS received - 7M actual cash refund')
const ledger = await salesLedger.ledger({ fromJalali: today, toJalali: today })
assert.equal(ledger.rows.filter((row) => row.invoiceId === to15.exchangeInvoiceId && row.eventType === 'EXCHANGE_REPLACEMENT')
  .reduce((sum, row) => sum + Number(row.cashEffect), 0), -7_000_000,
  'event ledger reports only the 7M actual cash refund, not the 12M negative exchange difference')
console.log('✓ 15M case: 5M gift share returned to its own source/expiry; only 7M real funds refunded in cash; blue = 15M')

// A later full return of the 15M replacement can refund the remaining 15M
// actual-money source (22M originally received minus 7M already refunded).
// This specifically checks that the prior 5M gift restoration is not mistaken
// for cash already paid out in descendant exchanges.
const returned15 = await salesService.createReturn({
  userId, shiftId, custodyFence: fence,
  invoiceId: to15.exchangeInvoiceId,
  lines: [{ saleItemId: saleItem(to15.exchangeInvoiceId), qty: 1 }],
  refundMethod: 'CASH', refundAmount: 15_000_000
})
assert.equal(Number(returned15.refundAmount), 15_000_000,
  'descendant cash refund uses the 15M real-money remainder, not 22M owed minus noncash gift')
const cashReplacement15 = await sale({ item: variant(15_000_000), amount: 15_000_000, cashAmount: 15_000_000 })
assert.ok(cashReplacement15.id)
const blueAfterDescendant = await expectBlue({
  cash: 34_000_000, card: 3_000_000, refundCash: 22_000_000, refundCard: 0,
  exchangeRefundCash: 7_000_000, label: 'descendant 15M cash return and replacement sale'
})
assert.equal(blueAfterDescendant.expectedBlue, 15_000_000,
  'the returned 15M and new real 15M sale net to the same verified blue')

// Non-physical values stay outside blue: manager-account receipt, a pending
// cheque, and debt offset are represented in the same live shift without
// increasing the cash drawer + POS aggregate.
const managerMethod = seed.insert('PaymentMethod', {
  key: 'CHAIN-MANAGER', label: 'کارت‌به‌کارت', kind: 'CUSTOM', isActive: 1, sortOrder: 3
})
await salesService.create(attachVerifiedCustodySaleOperator({
  userId, shiftId, custodyFence: fence,
  lines: [{ variantId: variant(1_000_000), qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: managerMethod, amount: 1_000_000, destination: 'MANAGER' }]
}, {
  custodyShiftId: fence.expectedShiftId, custodianUserId: fence.expectedActorUserId,
  operatorKind: 'MANAGER_SESSION', operatorUserId: null, authMethod: 'MANAGER_SESSION'
}))
const pendingChequeSale = await sale({ item: variant(1_000_000), amount: 1_000_000, cashAmount: 0 })
await salesService.addPayment({
  invoiceId: pendingChequeSale.id, amount: 1_000_000, kind: 'CHEQUE',
  chequeNo: 'CHAIN-PENDING-1', bankName: 'test', dueDateJalali: today,
  userId, custodyFence: fence
})
const unpaidOffsetSale = await sale({ item: variant(1_000_000), amount: 1_000_000, cashAmount: 0 })
const offsetExchange = await exchange({
  userId, shiftId, invoiceId: unpaidOffsetSale.id,
  lines: [{ saleItemId: saleItem(unpaidOffsetSale.id), qty: 1 }],
  replacements: [{ variantId: variant(500_000), qty: 1 }]
})
assert.equal(offsetExchange.debtReduction, 500_000, 'offset reduces customer debt, it is not a cash refund')
assert.equal(offsetExchange.cashRefunded, 0, 'debt offset does not leave the drawer')
const afterNonPhysical = await expectBlue({
  cash: 34_000_000, card: 3_000_000, refundCash: 22_000_000, refundCard: 0,
  exchangeRefundCash: 7_000_000, label: 'manager account + pending cheque + debt offset'
})
assert.equal(Number(afterNonPhysical.report.totals.managerAccountTotal), 1_000_000,
  'manager account is reported separately, outside blue')
assert.equal(
  Number(afterNonPhysical.report.accounting.cheques.pendingFuture + afterNonPhysical.report.accounting.cheques.pendingPastDue),
  1_000_000, 'pending cheque is visible as a liability, not a physical receipt'
)
console.log('✓ manager account, pending cheque and debt offset are each kept outside the physical blue')

// At custody boundaries, the seller's declared cash+POS aggregate is checked
// against the same blue reference. Then a 1M short night count must create one
// explicit discrepancy rather than silently changing the expected amount.
const started = await custodyService.handoverStart({
  password: 'CashierChain2!', operationalTotal: 15_000_000,
  toUserId: receiverId, idempotencyKey: 'chain-blue-handover'
})
await custodyService.handoverAccept({
  handoverId: started.id, password: 'ReceiverChain2!', operationalTotal: 15_000_000
})
const handoverBoundary = seed.one(
  'SELECT operationalExpectedTotal, observedOperationalTotal, newDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1',
  'HANDOVER'
)
assert.equal(Number(handoverBoundary.operationalExpectedTotal), 15_000_000,
  'seller handover expected = actual store cash + POS blue, excluding the 5M gift barcode')
assert.equal(Number(handoverBoundary.observedOperationalTotal), 15_000_000,
  'seller-declared/receiver-counted aggregate is recorded exactly')
assert.equal(Number(handoverBoundary.newDifference), 0, 'matching handover does not create a discrepancy')
assert.equal(seed.count('CustodyDiscrepancyCase'), 0, 'no fabricated case at the matching handover')

await custodyService.finalClose({ password: 'ReceiverChain2!', operationalTotal: 14_000_000, note: 'chain blue nightly discrepancy' })
const finalBoundary = seed.one(
  'SELECT operationalExpectedTotal, observedOperationalTotal, newDifference, totalTheoreticalDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1',
  'FINAL_CLOSE'
)
assert.equal(Number(finalBoundary.operationalExpectedTotal), 15_000_000, 'nightly expected remains the verified blue total')
assert.equal(Number(finalBoundary.observedOperationalTotal), 14_000_000, 'night count is not silently rewritten')
assert.equal(Number(finalBoundary.newDifference), -1_000_000, 'nightly 1M shortfall is recorded once')
assert.equal(Number(finalBoundary.totalTheoreticalDifference), -1_000_000, 'manager total identifies the same 1M discrepancy')
assert.equal(seed.count('CustodyDiscrepancyCase'), 1, 'one case is created for the night discrepancy')
console.log('✓ custody: seller handover matches the 15M blue; end-of-day 14M count produces one 1M discrepancy')

console.log('\n✓ chained 20M / 22M / 27M / 15M financial-source, blue, handover and nightly-close checks passed')
