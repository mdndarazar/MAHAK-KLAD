/** S11 production-service integration: 1.5M exchange-child value consists of
 * 300K gift + 900K cash carry + 300K pending-cheque debt. A 1M replacement
 * offsets debt first, then carries 900K cash + 100K gift and issues one 200K
 * non-cash successor barcode from the remaining gift root. Also proves late
 * cheque clearance is suspense, not new funding, and retry is idempotent.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s11-debt-offset-paid-carry.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s11-debt-offset-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { exchangeChequePolicyService } = await import('../../src/main/services/ExchangeChequePolicyService.ts')
const { createManagerCorrectionApprovalSecret } = await import('../../src/main/services/AuthService.ts')
const { getCurrentExchangeFundingSources, exchangeFundingBalance, recordExchangeFundingLineAllocations } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { calculateReturnTotals } = await import('@shared/accounting')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S11 manager one')
const managerTwoId = seed.user('S11 manager two')
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S11-PIN-ONE'), userId)
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S11-PIN-TWO'), managerTwoId)
const customerId = seed.customer('S11 named customer', '09120000111')
const categoryId = seed.category('S11 category')
const productId = seed.product('S11 item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S11 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S11-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })

const policyProposal = await exchangeChequePolicyService.propose({
  enabled: true, minimumDelta: 300_000, reason: 'فعال‌سازی سیاست چک برای آزمون S11',
  evidenceRef: 'S11-cheque-policy-proposal', proposerUserId: userId, proposerPin: 'S11-PIN-ONE'
})
const policy = await exchangeChequePolicyService.approve({
  proposalId: policyProposal.pending.id, approvingManagerUserId: managerTwoId,
  approvingManagerPin: 'S11-PIN-TWO', approvalReason: 'تأیید مستقل سیاست S11',
  approvalEvidenceRef: 'S11-cheque-policy-approval'
})
assert.deepEqual([policy.active.enabled, policy.active.minimumDelta], [true, 300_000])

const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 300_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 60, note: 'S11 paid gift carry', userId
}))
const sourceVariant = variant('source', 400_000)
const firstChildVariant = variant('first-child', 500_000)
const grandchildVariant = variant('grandchild', 500_000)
const root = await salesService.create({
  customerId, userId, shiftId, lines: [line(sourceVariant, 3, 400_000)],
  payments: [{ methodId: cashMethodId, amount: 900_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 300_000,
  storeCreditIdempotencyKey: 's11-root-gift-redemption-0001'
})
assert.equal(root.grandTotal, 1_200_000)
const rootItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', root.id)
const first = await exchange({
  invoiceId: root.id, lines: [{ saleItemId: rootItem.id, qty: 3 }],
  replacements: [line(firstChildVariant, 3, 500_000)],
  chequeNo: 'S11-CHILD-DEBT-300K', bankName: 'Test Bank', dueDateJalali: '1405/08/01',
  userId, shiftId, idempotencyKey: 's11-root-to-child-exchange-0001'
})
assert.equal(first.diff, 300_000)
assert.equal(first.settlement, 'CHEQUE_PENDING')
const childItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', first.exchangeInvoiceId)
assert.equal(childItems.length, 1)
const cheque = seed.one('SELECT id, kind, amount, chequeStatus FROM "Payment" WHERE invoiceId=? AND kind=?',
  first.exchangeInvoiceId, 'CHEQUE')
assert.deepEqual([cheque.kind, cheque.amount, cheque.chequeStatus], ['CHEQUE', 300_000, 'PENDING'])
const beforeFunding = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId)
assert.deepEqual(beforeFunding.unresolved, [])
assert.equal(beforeFunding.debt, 300_000)
assert.deepEqual(beforeFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 900_000 },
  { sourceKind: 'SOURCE_GIFT', available: 300_000 }
])
assert.equal(beforeFunding.lineAllocationStatus, 'UNAVAILABLE',
  'open debt does not produce a false paid-only line allocation matrix')

const beforeCashMovements = seed.count('CashMovement', '1=1')
const downRequest = {
  invoiceId: first.exchangeInvoiceId,
  lines: [{ saleItemId: childItems[0].id, qty: 3 }],
  replacements: [line(grandchildVariant, 2, 500_000)],
  refundMode: 'S11_DEBT_OFFSET_RIGHTS', userId, shiftId,
  idempotencyKey: 's11-cheaper-exchange-debt-offset-0001'
}
const down = await exchange(downRequest)
assert.deepEqual([down.returnTotal, down.exchangeTotal, down.diff, down.debtReduction],
  [1_500_000, 1_000_000, -500_000, 300_000])
assert.equal(down.settlement, 'S11_DEBT_OFFSET_RIGHTS')
assert.equal(down.storeCredit.amount, 200_000, 'the paid gift remainder is one non-cash barcode credit')
assert.equal(down.storeCredit.source, 'EXCHANGE')
assert.equal(down.storeCredit.status, 'DRAFT')
assert.equal(down.storeCredit.expiresAtJalali, seed.one('SELECT expiresAtJalali FROM "StoreCredit" WHERE id=?', gift.id).expiresAtJalali,
  'the successor barcode inherits the gift root’s exact expiry date')
assert.equal(seed.one('SELECT refundMethod, refundAmount FROM "SaleReturn" WHERE id=?', down.returnId).refundMethod, 'NONE')
assert.equal(seed.one('SELECT refundAmount FROM "SaleReturn" WHERE id=?', down.returnId).refundAmount, 0)
const reportedSettlement = calculateReturnTotals([{
  kind: 'EXCHANGE', total: 1_500_000, exchangeDiff: -500_000, debtReduction: 300_000,
  exchangeSettlement: 'S11_DEBT_OFFSET_RIGHTS', refundMethod: 'NONE'
}])
assert.deepEqual([reportedSettlement.exchangeCashRefunds, reportedSettlement.exchangeCardRefunds,
  reportedSettlement.exchangeStoreCreditIssued], [0, 0, 0],
  'the 200K source rights are not reported as cash/card payout or generic store credit')
assert.equal(seed.count('CashMovement', '1=1'), beforeCashMovements,
  'debt offset and successor barcode issuance cause no cash drawer movement')

const offsetCheque = seed.one('SELECT chequeStatus, amount, clearedAt, destination FROM "Payment" WHERE id=?', cheque.id)
assert.deepEqual([offsetCheque.chequeStatus, offsetCheque.amount, offsetCheque.clearedAt, offsetCheque.destination],
  ['DEBT_OFFSET', 300_000, null, null], 'the pending cheque itself is not promoted to paid carry')
assert.equal(await exchangeFundingBalance(db, `debt:${first.exchangeInvoiceId}`), 0)
const offset = seed.one('SELECT kind, amount, debtId, sourcePaymentId, returnId, childInvoiceId, evidenceKind FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
  first.exchangeInvoiceId, 'DEBT_OFFSET')
assert.deepEqual([offset.kind, offset.amount, offset.debtId, offset.sourcePaymentId, offset.returnId,
  offset.childInvoiceId, offset.evidenceKind],
  ['DEBT_OFFSET', -300_000, first.exchangeInvoiceId, cheque.id, down.returnId, down.exchangeInvoiceId,
    'EXCHANGE_DEBT_OFFSET'])
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SOURCE_CHEQUE'`), 0,
  'unpaid cheque does not become a source event')

const grandchild = await getCurrentExchangeFundingSources(db, down.exchangeInvoiceId)
assert.deepEqual(grandchild.unresolved, [])
assert.equal(grandchild.debt, 0)
assert.equal(grandchild.sources.reduce((sum, source) => sum + source.available, 0), 1_000_000)
assert.deepEqual(grandchild.sources.map(({ sourceKind, available }) => [sourceKind, available]), [
  ['SOURCE_CASH', 900_000], ['SOURCE_GIFT', 100_000]
])
assert.equal(grandchild.lineAllocationStatus, 'PERSISTED_RECONCILED')
const sourceLineAttribution = await recordExchangeFundingLineAllocations(db, first.exchangeInvoiceId)
assert.equal(sourceLineAttribution.deferred, true)
assert.equal(sourceLineAttribution.reason, 'EXCHANGE_DEBT_OFFSET_HISTORY',
  'the partial paid-source matrix is not persisted as though it funded debt value')
const sourceAfter = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId, { allowReturnBalanceChanges: true })
assert.deepEqual(sourceAfter.unresolved, [])
assert.deepEqual([sourceAfter.debt, sourceAfter.debtOffset], [0, 300_000])
assert.equal(sourceAfter.sources.reduce((sum, source) => sum + source.available, 0), 0,
  'the final paid-source remainder is debited to exactly one successor barcode')

assert.equal(seed.count('ExchangeResidualRightEvent', `returnId=${down.returnId} AND eventKind='OPENED'`), 0,
  'S11 no longer divides the balance into B/N residual rights')
assert.equal(down.residualRights, null)
const reissue = seed.one('SELECT kind, amount, sourceRedemptionId, sourceCreditId, parentEventId, evidenceKind, evidenceRef FROM "ExchangeFundingEvent" WHERE returnId=? AND kind=?',
  down.returnId, 'CREDIT_REISSUE_OUT')
assert.deepEqual([reissue.kind, reissue.amount, reissue.sourceCreditId, reissue.evidenceKind,
  reissue.evidenceRef], ['CREDIT_REISSUE_OUT', -200_000, gift.id, 'CREDIT_BARCODE_ISSUED',
    `StoreCredit:${down.storeCredit.id}`])
const successorAllocation = seed.one('SELECT parentCreditId, rootCreditId, originNominal, amount, kind, originalExpiresAt, successorCreditId FROM "CreditReturnAllocation" WHERE successorCreditId=?',
  down.storeCredit.id)
assert.deepEqual([successorAllocation.parentCreditId, successorAllocation.rootCreditId,
  successorAllocation.originNominal, successorAllocation.amount, successorAllocation.kind,
  successorAllocation.successorCreditId], [gift.id, gift.id, 300_000, 200_000, 'BRANCH', down.storeCredit.id])
assert.ok(successorAllocation.originalExpiresAt)
assert.ok(!String(reissue.evidenceRef).includes('debt:'), 'the successor has the paid gift root, never the debt root')
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SOURCE_CHEQUE'`), 0,
  'unpaid cheque does not become a source event')

// Conservation: paid carry is either in the grandchild or the one successor
// barcode; the pending cheque debt is independently offset and contributes no
// paid source value.
const grandchildTransfers = grandchild.sources.reduce((sum, source) => sum + source.available, 0)
assert.equal(grandchildTransfers, 1_000_000)
assert.equal(grandchildTransfers + down.storeCredit.amount, 1_200_000,
  'the 1.2M paid source is fully partitioned between carry and one barcode')
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SOURCE_CHEQUE'`), 0)

const eventCountBeforeRetry = seed.count('ExchangeFundingEvent', '1=1')
const reissuesBeforeRetry = seed.count('ExchangeFundingEvent', `returnId=${down.returnId} AND kind='CREDIT_REISSUE_OUT'`)
const retry = await exchange(downRequest)
assert.equal(retry.exchangeInvoiceId, down.exchangeInvoiceId)
assert.equal(seed.count('ExchangeFundingEvent', '1=1'), eventCountBeforeRetry)
assert.equal(seed.count('ExchangeFundingEvent', `returnId=${down.returnId} AND kind='CREDIT_REISSUE_OUT'`), reissuesBeforeRetry)

// A later bank clearance of the old cheque is quarantined in SUSPENSE and
// creates no replacement source/carry after its debt has already been offset.
const cleared = await salesService.setChequeStatus({
  id: cheque.id, status: 'CLEARED', destination: 'MANAGER',
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId
})
assert.equal(cleared.cheque.chequeStatus, 'SUSPENSE')
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SOURCE_CHEQUE'`), 0)
assert.equal(await exchangeFundingBalance(db, `debt:${first.exchangeInvoiceId}`), 0)
const afterLateClearance = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId, {
  allowReturnBalanceChanges: true
})
assert.deepEqual(afterLateClearance.unresolved, [])
assert.deepEqual([afterLateClearance.debt, afterLateClearance.debtOffset], [0, 300_000])
assert.equal(afterLateClearance.sources.reduce((sum, source) => sum + source.available, 0), 0)
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SUSPENSE_CHEQUE_LATE'`), 1)

// S12 fail-closed regression: once the offset cheque has late-cleared into
// suspense, the exchange pair cannot be voided as if the debt were untouched.
const beforeUnsafeVoid = {
  returnVoidedAt: seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', down.returnId).voidedAt,
  childVoidedAt: seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', down.exchangeInvoiceId).voidedAt,
  chequeStatus: seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.id).chequeStatus,
  fundingEvents: seed.count('ExchangeFundingEvent', '1=1'),
  rights: seed.count('ExchangeResidualRightEvent', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id')
}
await assert.rejects(() => salesService.returnDelete({
  id: down.returnId, userId, reason: 'S12 late-cleared cheque void guard',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'S12 late-cleared cheque void guard'
}), /چکِ کاهش‌دهندهٔ بدهی پس از offset تسویه/u,
'late-cleared/suspense cheque is not silently reopened by exchange void')
assert.deepEqual({
  returnVoidedAt: seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', down.returnId).voidedAt,
  childVoidedAt: seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', down.exchangeInvoiceId).voidedAt,
  chequeStatus: seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.id).chequeStatus,
  fundingEvents: seed.count('ExchangeFundingEvent', '1=1'),
  rights: seed.count('ExchangeResidualRightEvent', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id')
}, beforeUnsafeVoid, 'rejected S12 void is atomic and leaves financial, rights, cheque and stock state unchanged')

console.log('✓ S11/S12 debt-offset regression: cash-first 900K/100K carry, one 200K gift-root barcode, late-clear suspense, and guarded atomic void')
