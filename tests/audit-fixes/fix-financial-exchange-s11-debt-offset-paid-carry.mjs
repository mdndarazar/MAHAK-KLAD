/** S11 production-service integration: 1.5M exchange-child value consists of
 * 300K gift + 900K cash carry + 300K pending-cheque debt. A 1M replacement
 * offsets debt first, then carries 250K gift + 750K cash and opens only the
 * 50K B / 150K N paid-source remainders. Also proves late cheque clearance is
 * suspense, not new funding, and retry is idempotent.
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
assert.equal(down.storeCredit, null, 'no generic refund credit is issued for the residual')
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
  'debt offset and B/N issuance cause no cash drawer movement')

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
  ['SOURCE_GIFT', 250_000], ['SOURCE_CASH', 750_000]
])
assert.equal(grandchild.lineAllocationStatus, 'PERSISTED_RECONCILED')
const sourceLineAttribution = await recordExchangeFundingLineAllocations(db, first.exchangeInvoiceId)
assert.equal(sourceLineAttribution.deferred, true)
assert.equal(sourceLineAttribution.reason, 'EXCHANGE_DEBT_OFFSET_HISTORY',
  'the partial paid-source matrix is not persisted as though it funded debt value')
const sourceAfter = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId, { allowReturnBalanceChanges: true })
assert.deepEqual(sourceAfter.unresolved, [])
assert.deepEqual([sourceAfter.debt, sourceAfter.debtOffset], [0, 300_000])
assert.equal(sourceAfter.sources.reduce((sum, source) => sum + source.available, 0), 200_000)

const rights = seed.rows('SELECT rightKind, amount, sourceEventId, rootShareId, evidenceKind FROM "ExchangeResidualRightEvent" WHERE returnId=? AND eventKind=? ORDER BY rightKind',
  down.returnId, 'OPENED')
assert.deepEqual(rights.map((right) => [right.rightKind, right.amount]), [['B', 50_000], ['N', 150_000]])
assert.deepEqual(rights.map((right) => right.evidenceKind),
  ['PAID_SOURCE_AFTER_DEBT_OFFSET', 'PAID_SOURCE_AFTER_DEBT_OFFSET'])
const parentSourcesByKind = new Map(sourceAfter.sources.map((source) => [source.sourceKind, source]))
assert.equal(rights.find((right) => right.rightKind === 'B').sourceEventId,
  Number(parentSourcesByKind.get('SOURCE_GIFT').event.id), 'B remainder points to the gift-paid carry share')
assert.equal(rights.find((right) => right.rightKind === 'N').sourceEventId,
  Number(parentSourcesByKind.get('SOURCE_CASH').event.id), 'N remainder points to the cash-paid carry share')
assert.ok(rights.every((right) => !String(right.rootShareId).startsWith('debt:')),
  'neither residual right has debt as its root')
assert.equal(seed.count('ExchangeResidualRightEvent', `returnId=${down.returnId} AND eventKind='OPENED' AND rootShareId LIKE 'debt:%'`), 0)
assert.deepEqual([down.residualRights.giftCarry, down.residualRights.cashCarry], [250_000, 750_000])
assert.deepEqual(down.residualRights.rights.map(({ rightKind, amount }) => [rightKind, amount]),
  [['B', 50_000], ['N', 150_000]])

// Conservation: paid carry is either in the grandchild or the rooted rights;
// the debt is separately offset, and the cheque contributes zero.
const grandchildTransfers = grandchild.sources.reduce((sum, source) => sum + source.available, 0)
const residualRightTotal = rights.reduce((sum, right) => sum + right.amount, 0)
assert.equal(grandchildTransfers + residualRightTotal + offset.amount * -1, 1_500_000)
assert.equal(1_200_000, grandchildTransfers + residualRightTotal,
  'only the 1.2M paid source split becomes carry plus B/N; the 300K debt is separately offset')
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SOURCE_CHEQUE'`), 0)

const eventCountBeforeRetry = seed.count('ExchangeFundingEvent', '1=1')
const rightsCountBeforeRetry = seed.count('ExchangeResidualRightEvent', `returnId=${down.returnId} AND eventKind='OPENED'`)
const retry = await exchange(downRequest)
assert.equal(retry.exchangeInvoiceId, down.exchangeInvoiceId)
assert.equal(seed.count('ExchangeFundingEvent', '1=1'), eventCountBeforeRetry)
assert.equal(seed.count('ExchangeResidualRightEvent', `returnId=${down.returnId} AND eventKind='OPENED'`), rightsCountBeforeRetry)

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
assert.equal(afterLateClearance.sources.reduce((sum, source) => sum + source.available, 0), 200_000)
assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${first.exchangeInvoiceId} AND kind='SUSPENSE_CHEQUE_LATE'`), 1)

console.log('S11 exchange debt-offset paid-source carry: PASS (1.5M conservation; 300K debt offset; 250K GIFT + 750K CASH carry; 50K B + 150K N rights; cheque remains non-source; late clearance suspense; idempotent retry)')
