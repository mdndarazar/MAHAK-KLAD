/**
 * Owner's four 25M-source exchange examples.  The source is 20M actual cash +
 * 5M root gift barcode; each amount is tested as a separate branch so the
 * source is never invented or used twice.  Blue is always cash + POS receipts
 * less actual cash/card refunds; the gift barcode and returned credit are not
 * physical receipts.
 *
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-owner-examples-20-22-27-15.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-owner-exchange-examples-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { attachVerifiedCustodySaleOperator, salesService } = await import('../../src/main/services/SalesService.ts')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { salesLedger } = await import('../../src/main/services/SalesLedger.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const managerId = seed.user('owner examples manager')
const userId = seed.user('owner examples cashier')
const receiverId = seed.user('owner examples receiver')
await custodyService.setPin({ userId: managerId, newPassword: 'OwnerManager22!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: managerId, managerPassword: 'OwnerManager22!' })
for (const [id, temporary, permanent] of [
  [userId, 'OwnerCashierTemp22!', 'OwnerCashier22!'],
  [receiverId, 'OwnerReceiverTemp22!', 'OwnerReceiver22!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: managerId, managerPassword: 'OwnerManager22!', reason: 'Owner exchange blue integration' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
await settingsService.saveCustodySchedulingWorkflow({
  shift: { ...await settingsService.shiftConfig(), custodyMode: 'SINGLE_SHIFT',
    singleShiftCustodianUserId: userId, singleShiftAllowMidDayHandover: true },
  managerUserId: managerId, managerPassword: 'OwnerManager22!', reason: 'owner blue handover integration'
})
const opened = await custodyService.open({ userId, password: 'OwnerCashier22!', operationalTotal: 0 })
const shiftId = opened.shiftId
const fence = await custodyService.actorForFinancialOperation()
const custodySale = (input) => salesService.create(attachVerifiedCustodySaleOperator({
  ...input, userId, shiftId, custodyFence: fence
}, {
  custodyShiftId: fence.expectedShiftId, custodianUserId: fence.expectedActorUserId,
  operatorKind: 'MANAGER_SESSION', operatorUserId: null, authMethod: 'MANAGER_SESSION'
}))
const categoryId = seed.category('owner exchange example category')
const productId = seed.product('owner exchange example product', categoryId)
const cashMethod = seed.insert('PaymentMethod', { key: 'OWNER-CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: 'OWNER-CARD', label: 'Card', kind: 'CARD', isActive: 1, sortOrder: 2 })
const today = toJalaliDate(new Date())
let serial = 0
const variant = (price) => {
  const id = seed.variant(productId, `OWNER-${++serial}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=30, salePrice=? WHERE id=?').run(price, id)
  return id
}
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const linesOf = (invoiceId) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)

async function root25(label) {
  const giftExpiry = new Date(Date.now() + 30 * 86_400_000 + serial)
  const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount: 5_000_000, multiUse: false, maxUses: 1,
    carryRemainder: false, days: 30, expiresAt: giftExpiry,
    note: `${label} 5M gift root`, userId
  }))
  const originalItem = variant(25_000_000)
  const sale = await custodySale({
    lines: [item(originalItem, 25_000_000)],
    payments: [{ methodId: cashMethod, amount: 20_000_000, destination: 'CASH' }],
    storeCreditCode: gift.code, storeCreditAmount: 5_000_000,
    storeCreditIdempotencyKey: `${label}-gift-redemption`
  })
  assert.equal(sale.grandTotal, 25_000_000)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
  const actualGiftExpiry = Number(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', gift.id).expiresAt)
  const source = await getCurrentSaleFundingSources(db, sale.id)
  assert.deepEqual(source.unresolved, [])
  assert.deepEqual(source.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
    { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
    { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
  ])
  return { shiftId, gift, giftExpiry: actualGiftExpiry, sale, originalItem, source }
}

async function blue(shiftId, expected, label) {
  const report = await salesService.reportRows({ shiftId })
  assert.equal(Number(report.totals.cashTotal), expected.cash, `${label}: actual cash receipts`)
  assert.equal(Number(report.totals.cardTotal), expected.card, `${label}: actual POS receipts`)
  assert.equal(Number(report.totals.refundCashTotal), expected.refundCash ?? 0, `${label}: cash refund`)
  assert.equal(Number(report.totals.refundCardTotal), expected.refundCard ?? 0, `${label}: POS refund`)
  const total = expected.cash + expected.card - (expected.refundCash ?? 0) - (expected.refundCard ?? 0)
  assert.equal(await physicalMovementForCustodyShift(shiftId), total, `${label}: blue physical reference`)
  return { report, total }
}

async function exchangeFromRoot(label, target, input = {}) {
  const root = await root25(label)
  const replacement = variant(target)
  const result = await salesService.createExchange({
    invoiceId: root.sale.id,
    lines: [{ saleItemId: linesOf(root.sale.id)[0].id, qty: 1 }],
    replacements: [item(replacement, target)],
    userId, shiftId: root.shiftId, custodyFence: fence, ...input
  })
  assert.equal(result.returnTotal, 25_000_000, `${label}: exact source value`)
  assert.equal(result.exchangeTotal, target, `${label}: exact replacement value`)
  assert.equal(result.diff, target - 25_000_000, `${label}: exact difference`)
  return { ...root, result }
}

// Replacement 20M: cash-first carry is 20M, and the full 5M gift remainder
// returns as one non-cash successor rooted at the original barcode.
const at20 = await exchangeFromRoot('owner-ex-20', 20_000_000, { refundMode: 'S1_RESIDUAL_RIGHTS' })
assert.equal(at20.result.settlement, 'S1_RESIDUAL_RIGHTS')
assert.equal(at20.result.storeCredit.amount, 5_000_000)
assert.equal(at20.result.cashReceived, 0)
assert.equal(at20.result.cardReceived, 0)
assert.equal(at20.result.cashRefunded, 0)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', at20.gift.id).status, 'USED')
assert.equal(Number(seed.one('SELECT amount FROM "StoreCredit" WHERE id=?', at20.result.storeCredit.id).amount), 5_000_000)
assert.equal(new Date(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', at20.result.storeCredit.id).expiresAt).getTime(), at20.giftExpiry)
const f20 = await getCurrentExchangeFundingSources(db, at20.result.exchangeInvoiceId)
assert.deepEqual(f20.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 }
])
await blue(at20.shiftId, { cash: 20_000_000, card: 0 }, 'after 20M replacement')
console.log('✓ 20M: 20M real cash carries; 5M gift returns to its own non-cash root/expiry')

// Replacement 22M: carry 20M cash + 2M gift; only the remaining 3M gift
// becomes a rooted non-cash successor.
const at22 = await exchangeFromRoot('owner-ex-22', 22_000_000, { refundMode: 'S1_RESIDUAL_RIGHTS' })
assert.equal(at22.result.settlement, 'S1_RESIDUAL_RIGHTS')
assert.equal(at22.result.storeCredit.amount, 3_000_000)
assert.equal(at22.result.cashReceived, 0)
assert.equal(at22.result.cardReceived, 0)
assert.equal(at22.result.cashRefunded, 0)
const f22 = await getCurrentExchangeFundingSources(db, at22.result.exchangeInvoiceId)
assert.deepEqual(f22.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
assert.equal(new Date(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', at22.result.storeCredit.id).expiresAt).getTime(), at22.giftExpiry)
await blue(at22.shiftId, { cash: 40_000_000, card: 0 }, 'after 22M replacement')
console.log('✓ 22M: 20M cash + 2M gift carry; the 3M remainder stays rooted non-cash')

// Replacement 27M: all 25M source value carries, and the exact 2M difference
// is genuinely received as 1M cash plus 1M POS—not debt or synthetic credit.
const at27 = await exchangeFromRoot('owner-ex-27', 27_000_000, {
  splitPayment: true,
  payments: [
    { methodId: cashMethod, amount: 1_000_000, destination: 'CASH' },
    { methodId: cardMethod, amount: 1_000_000, destination: 'CARD' }
  ]
})
assert.equal(at27.result.cashReceived, 1_000_000)
assert.equal(at27.result.cardReceived, 1_000_000)
assert.equal(at27.result.cashDue, undefined, 'the exact tender rows—not debt—settle the 2M difference')
assert.equal(at27.result.storeCredit, null)
assert.equal(at27.result.debtReduction, 0)
const f27 = await getCurrentExchangeFundingSources(db, at27.result.exchangeInvoiceId)
assert.deepEqual(f27.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 },
  { sourceKind: 'SOURCE_CASH', available: 1_000_000 },
  { sourceKind: 'SOURCE_CARD', available: 1_000_000 }
])
await blue(at27.shiftId, { cash: 61_000_000, card: 1_000_000 }, 'after 27M replacement')
console.log('✓ 27M: 25M source carries; exact 2M is 1M cash + 1M POS')

// The 15M mixed residual is split by source, not by ratio: 5M gift returns
// to its root; only the separate 5M real-money remainder is refunded in cash.
const at15 = await exchangeFromRoot('owner-ex-15-cash', 15_000_000, { refundMode: 'CASH' })
assert.equal(at15.result.settlement, 'CASH_REFUND')
assert.equal(at15.result.refundMode, 'CASH')
assert.equal(at15.result.cashRefunded, 5_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', at15.gift.id).status, 'USED')
assert.equal(Number(at15.result.storeCredit.amount), 5_000_000, 'gift share alone becomes the root-linked successor')
assert.equal(at15.result.storeCredits.length, 1, 'the gift successor is returned for the authorized print flow')
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', at15.result.returnId).creditRestored), 5_000_000)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?', 'SaleReturn', at15.result.returnId, 'EXCHANGE_REFUND').amount), 5_000_000)
const giftLink15 = seed.one('SELECT parentCreditId, rootCreditId, amount, successorCreditId, originalExpiresAt FROM "CreditReturnAllocation" WHERE successorCreditId=?', at15.result.storeCredit.id)
assert.deepEqual([Number(giftLink15.parentCreditId), Number(giftLink15.rootCreditId), Number(giftLink15.amount), Number(giftLink15.successorCreditId)],
  [at15.gift.id, at15.gift.id, 5_000_000, at15.result.storeCredit.id])
assert.equal(Number(giftLink15.originalExpiresAt), at15.giftExpiry)
const f15 = await getCurrentExchangeFundingSources(db, at15.result.exchangeInvoiceId)
assert.deepEqual(f15.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 15_000_000 }
])
const blue15 = await blue(at15.shiftId, { cash: 81_000_000, card: 1_000_000, refundCash: 5_000_000 }, 'after 15M mixed-source cash choice')
assert.equal(Number(blue15.report.accounting.returns.exchangeCashRefunds), 5_000_000,
  'the report charges only the real-money half as cash refund')
assert.equal(Number(blue15.report.accounting.returns.exchangeStoreCreditIssued), 13_000_000,
  'the cumulative 5M + 3M + 5M source-specific barcode restorations stay non-cash')
const ledger15 = await salesLedger.ledger({ fromJalali: today, toJalali: today })
assert.equal(ledger15.rows.filter((row) => row.invoiceId === at15.result.exchangeInvoiceId && row.eventType === 'EXCHANGE_REPLACEMENT')
  .reduce((sum, row) => sum + Number(row.cashEffect), 0), -5_000_000,
  'event ledger records only the actual 5M cash payout; the 5M gift restoration is non-cash')
console.log('✓ 15M cash choice: 5M root gift restored; exactly 5M real cash refunded; blue = 15M')

// The alternative customer choice converts only the 5M real-money remainder
// into a new non-cash credit; the separate 5M gift still returns to its root.
const at15Credit = await exchangeFromRoot('owner-ex-15-credit', 15_000_000, { refundMode: 'STORE_CREDIT' })
assert.equal(at15Credit.result.settlement, 'CREDIT')
assert.equal(at15Credit.result.storeCredits.length, 2, 'both independently rooted/non-cash barcodes are returned to the authorized print flow')
assert.equal(new Set(at15Credit.result.storeCredits.map((row) => row.id)).size, 2)
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', at15Credit.result.returnId).creditRestored), 5_000_000)
const returnCredits15 = seed.rows('SELECT id, amount, source FROM "StoreCredit" WHERE returnId=? ORDER BY id', at15Credit.result.returnId)
assert.equal(returnCredits15.length, 2, 'one root-linked gift successor plus one non-cash credit for the real-money choice')
assert.deepEqual(returnCredits15.map((row) => Number(row.amount)), [5_000_000, 5_000_000])
assert.equal(Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refType=? AND refId=? AND type=?', 'SaleReturn', at15Credit.result.returnId, 'EXCHANGE_REFUND').n), 0,
  'choosing a barcode for the real-money share produces no cash movement')
const blue15Credit = await blue(at15Credit.shiftId, { cash: 101_000_000, card: 1_000_000, refundCash: 5_000_000 }, 'after 15M non-cash choice')
assert.equal(blue15Credit.total, 97_000_000, 'the non-cash choice does not reduce physical blue')
assert.equal(Number(blue15Credit.report.accounting.returns.exchangeStoreCreditIssued), 23_000_000,
  'the cumulative 23M non-cash credits include every source gift return and this 5M cash-share barcode choice')
console.log('✓ 15M credit choice: both 5M shares remain non-cash and blue stays 97M for the combined shift')

// The customer's third valid choice is a real POS refund. It uses the explicit
// manager override gate and affects POS blue, never the cash-drawer refund.
const at15Card = await exchangeFromRoot('owner-ex-15-card', 15_000_000, {
  refundMode: 'CARD',
  cardPosOverride: {
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    reason: 'Owner scenario: refund only the actual 5M cash-source remainder to card',
    acknowledgedNoReverse: true
  }
})
assert.equal(at15Card.result.settlement, 'CARD_REFUND')
assert.equal(at15Card.result.cashRefunded, 5_000_000)
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', at15Card.result.returnId).creditRestored), 5_000_000)
const blue15Card = await blue(at15Card.shiftId, {
  cash: 121_000_000, card: 1_000_000, refundCash: 5_000_000, refundCard: 5_000_000
}, '15M actual POS refund choice')
assert.equal(blue15Card.total, 112_000_000, 'card refund reduces POS blue, not drawer cash')
console.log('✓ 15M card choice: 5M gift restored; only the 5M real-money remainder refunds to POS')

// Manager-account receipt, pending cheque and debt offset are visible in their
// own accounting buckets but cannot alter the physical blue.
const managerMethod = seed.insert('PaymentMethod', {
  key: 'OWNER-MANAGER', label: 'Card-to-manager', kind: 'CUSTOM', isActive: 1, sortOrder: 3
})
const managerSale = await custodySale({
  lines: [item(variant(1_000_000), 1_000_000)],
  payments: [{ methodId: managerMethod, amount: 1_000_000, destination: 'MANAGER' }]
})
const pendingSale = await custodySale({ lines: [item(variant(1_000_000), 1_000_000)], payments: [] })
await salesService.addPayment({
  invoiceId: pendingSale.id, amount: 1_000_000, kind: 'CHEQUE', chequeNo: 'OWNER-PENDING',
  bankName: 'test', dueDateJalali: today, userId, custodyFence: fence
})
const unpaidSale = await custodySale({ lines: [item(variant(1_000_000), 1_000_000)], payments: [] })
const offsetExchange = await salesService.createExchange({
  invoiceId: unpaidSale.id, lines: [{ saleItemId: linesOf(unpaidSale.id)[0].id, qty: 1 }],
  replacements: [item(variant(500_000), 500_000)], userId, shiftId, custodyFence: fence
})
assert.equal(Number(seed.one('SELECT debtReduction FROM "SaleReturn" WHERE id=?', offsetExchange.returnId).debtReduction), 500_000)
assert.equal(offsetExchange.cashRefunded, 0)
const afterNonPhysical = await blue(shiftId, {
  cash: 121_000_000, card: 1_000_000, refundCash: 5_000_000, refundCard: 5_000_000
}, 'manager account + pending cheque + debt offset')
assert.equal(Number(afterNonPhysical.report.totals.managerAccountTotal), 1_000_000)
assert.equal(Number(afterNonPhysical.report.accounting.cheques.pendingFuture + afterNonPhysical.report.accounting.cheques.pendingPastDue),
  1_000_000)
assert.ok(managerSale.id)
console.log('✓ manager account, pending cheque and offset debt remain outside blue')

// The combined blue is the seller's handover reference. A matching handover is
// clean; a 1M short final count creates one explicit night discrepancy.
const handoverStart = await custodyService.handoverStart({
  password: 'OwnerCashier22!', operationalTotal: 112_000_000,
  toUserId: receiverId, idempotencyKey: 'owner-examples-blue-handover'
})
await custodyService.handoverAccept({
  handoverId: handoverStart.id, password: 'OwnerReceiver22!', operationalTotal: 112_000_000
})
const handoverBoundary = seed.one(
  'SELECT operationalExpectedTotal, observedOperationalTotal, newDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1',
  'HANDOVER'
)
assert.equal(Number(handoverBoundary.operationalExpectedTotal), 112_000_000)
assert.equal(Number(handoverBoundary.observedOperationalTotal), 112_000_000)
assert.equal(Number(handoverBoundary.newDifference), 0)
assert.equal(seed.count('CustodyDiscrepancyCase'), 0)
await custodyService.finalClose({ password: 'OwnerReceiver22!', operationalTotal: 111_000_000, note: 'owner examples nightly count' })
const finalSnapshot = seed.one(
  'SELECT humanAmount, referenceAmount, rawDifference, freshDifference, freshStatus, shiftId FROM "CustodyBlueSnapshot" WHERE role=? ORDER BY id DESC LIMIT 1',
  'FINAL_CLOSE'
)
assert.equal(Number(finalSnapshot.humanAmount), 111_000_000)
assert.equal(Number(finalSnapshot.referenceAmount), 112_000_000)
assert.equal(Number(finalSnapshot.rawDifference), -1_000_000, 'the night snapshot explicitly records a 1M shortfall')
assert.equal(finalSnapshot.freshStatus, 'UNKNOWN_NO_REAL_PRIOR_COUNT',
  'without a prior independent count, the shortfall remains evidence—not an automatically assigned accusation')
assert.equal(seed.count('CustodyDiscrepancyCase'), 0, 'night count alone does not auto-create an accusation/case')
console.log('✓ seller handover = 112M blue; 111M night count records a 1M variance with the correct evidence status')

console.log('\n✓ owner 20M / 22M / 27M / 15M source, blue, handover and nightly checks passed')
