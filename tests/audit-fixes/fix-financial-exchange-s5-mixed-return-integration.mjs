/** S5: real 15M mixed-tender sale and 5M return.
 * Proves exact 2M gift branch + 3M real-money right (no proportional split)
 * across immediate cash payout and reserved/card-to-card payout, including
 * expiry, witnessed delivery, bank evidence, and channel/report separation.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s5-mixed-return-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s5-mixed-return-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { confirmCreditDelivery, reconcileBankDocument, viewReturnEntitlement } =
  await import('../../src/main/services/ReturnEntitlementService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S5 mixed return')
const categoryId = seed.category('S5 category')
const productId = seed.product('S5 mixed item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S5 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantNo = 0
const variant = (price) => {
  const id = seed.variant(productId, `S5-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=50, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
async function makeMixedSale(prices, key, expiresAt = null) {
  assert.equal(prices.reduce((sum, n) => sum + n, 0), 15_000_000)
  const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
    carryRemainder: false, days: 30, note: `S5 root gift ${key}`, userId
  }))
  if (expiresAt != null) sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(expiresAt, gift.id)
  const variants = prices.map((price) => variant(price))
  const sale = await salesService.create({
    userId, shiftId,
    lines: variants.map((variantId, index) => line(variantId, prices[index])),
    payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
    storeCreditCode: gift.code, storeCreditAmount: 2_000_000,
    storeCreditIdempotencyKey: `s5-sale-${key}`
  })
  assert.equal(sale.grandTotal, 15_000_000)
  assert.equal(sale.storeCreditApplied, 2_000_000)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
  return { gift, variants, sale, items: seed.rows(
    'SELECT id, variantId, lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id
  ) }
}
async function createReturn(sale, itemId, amount, method, refundAmount, key) {
  return salesService.createReturn({
    invoiceId: sale.id, full: false,
    lines: [{ saleItemId: itemId, qty: 1 }],
    refundMethod: method, refundAmount, userId, shiftId,
    idempotencyKey: `s5-return-${key}`
  }, { goodsReceiptRequired: false })
}
async function proveBankPayout(returnId, requestId, amount, key) {
  let claim = await viewReturnEntitlement(returnId)
  assert.equal(claim.cashRight, amount)
  assert.equal(claim.cashReserved, amount)
  assert.equal(claim.cashPaid, 0)
  assert.equal(claim.open, 0)
  assert.equal(claim.state, 'OPEN')
  const opened = seed.rows('SELECT kind, amount FROM "ReturnEntitlementEvent" WHERE entitlementId=? ORDER BY id',
    seed.one('SELECT id FROM "ReturnEntitlement" WHERE returnId=?', returnId).id)
  assert.deepEqual(opened.map((row) => [row.kind, Number(row.amount)]), [
    ['CASH_RIGHT_OPENED', amount], ['BANK_RESERVED', amount]
  ])
  const beforeCash = seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', returnId)
  const declaration = await cardTransferService.pay({
    id: requestId, paidAmount: amount, managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  assert.equal(declaration.bankEvidenceState, 'UNKNOWN_BANK')
  claim = await viewReturnEntitlement(returnId)
  assert.equal(claim.cashReserved, amount, 'manager declaration does not release a Rial of reservation')
  assert.equal(claim.cashPaid, 0, 'tracking/declaration is not proof of actual bank payout')
  assert.equal(claim.open, 0)
  assert.equal(seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', returnId), beforeCash)
  const bytes = Buffer.from(`%PDF-1.7\nS5 bank statement ${key} amount=${amount}\n%%EOF\n`)
  const proof = await reconcileBankDocument({
    requestId, confirmedAmount: amount,
    document: { name: `s5-bank-${key}.pdf`, bytes },
    reviewNote: `تطبیق حساب بانکی، تاریخ و مبلغ برگشت S5 ${key}`,
    attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
  })
  assert.equal(proof.cashPaid, amount)
  assert.equal(proof.cashReserved, 0)
  assert.equal(proof.open, 0)
  assert.equal(proof.state, 'OPEN')
  assert.equal(proof.replayed, false)
  assert.equal(seed.one('SELECT confirmedAmount FROM "BankStatementEvidence" WHERE requestId=?', requestId)
    .confirmedAmount, amount)
  assert.equal(seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', returnId), beforeCash,
    'manager-bank transfer is evidenced in its external channel, not duplicated as drawer cash')
  assert.equal((await reconcileBankDocument({
    requestId, confirmedAmount: amount, document: { name: `s5-bank-${key}.pdf`, bytes },
    reviewNote: `تطبیق حساب بانکی، تاریخ و مبلغ برگشت S5 ${key}`,
    attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD
  })).replayed, true)
  return proof
}

// Scenario A: one 5M line, immediate drawer payout. Wrong amount is rejected
// before creating a return, credit branch, or cash movement.
const cashCase = await makeMixedSale([5_000_000, 5_000_000, 5_000_000], 'cash')
const cashItem = cashCase.items[0]
const beforeInvalidAttempt = {
  returns: seed.count('SaleReturn', 'invoiceId=?', cashCase.sale.id),
  credits: seed.count('StoreCredit', 'source=?', 'EXCHANGE'),
  cash: seed.count('CashMovement', 'refType=?', 'SaleReturn')
}
await assert.rejects(() => createReturn(cashCase.sale, Number(cashItem.id), 5_000_000,
  'CASH', 2_999_999, 'cash-off-by-one'), /سهم اعتبار|حق بازپرداخت|سازگار/)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', cashCase.sale.id),
  credits: seed.count('StoreCredit', 'source=?', 'EXCHANGE'),
  cash: seed.count('CashMovement', 'refType=?', 'SaleReturn')
}, beforeInvalidAttempt, 'one-Rial mismatch is atomic and creates no money/credit side effect')

const cashReturn = await createReturn(cashCase.sale, Number(cashItem.id), 5_000_000,
  'CASH', 3_000_000, 'cash-exact')
assert.equal(cashReturn.total, 5_000_000)
assert.equal(cashReturn.refundAmount, 3_000_000)
assert.equal(cashReturn.creditOpportunity.restored, 2_000_000)
assert.equal(cashReturn.creditOpportunity.expiredShare, 0)
assert.equal(cashReturn.creditOpportunity.pendingDelivery.length, 1)
const cashAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', cashReturn.id)
assert.equal(Number(cashAllocation.amount), 2_000_000)
assert.equal(Number(cashAllocation.rootCreditId), cashCase.gift.id)
assert.equal(cashAllocation.kind, 'BRANCH')
assert.equal(Number(cashAllocation.supplementUnspent), 0)
assert.equal(new Date(cashAllocation.originalExpiresAt).getTime(), new Date(cashCase.gift.expiresAt).getTime())
const cashBranch = seed.one('SELECT * FROM "StoreCredit" WHERE id=?',
  cashReturn.creditOpportunity.pendingDelivery[0].creditId)
assert.equal(Number(cashBranch.amount), 2_000_000)
assert.equal(cashBranch.status, 'DRAFT')
assert.equal(new Date(cashBranch.expiresAt).getTime(), new Date(cashCase.gift.expiresAt).getTime(),
  'B inherits the original root expiry and never gets a fresh term')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', cashCase.gift.id).status, 'USED')
assert.equal(seed.count('CashMovement', 'refType=? AND refId=? AND type=?',
  'SaleReturn', cashReturn.id, 'RETURN_REFUND'), 1)
assert.equal(seed.one('SELECT amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?',
  'SaleReturn', cashReturn.id, 'RETURN_REFUND').amount, 3_000_000)
assert.equal(seed.count('CardTransferRequest', 'returnId=?', cashReturn.id), 0)
const cashReport = (await salesService.returnList({ take: 500 })).find((row) => row.id === cashReturn.id)
assert.ok(cashReport)
assert.equal(cashReport.total, 5_000_000)
assert.equal(cashReport.refundMethod, 'CASH')
assert.equal(cashReport.refundAmount, 3_000_000)
assert.equal(cashReport.cashRefundAmount, 3_000_000)
assert.equal(cashReport.storeCreditReference, null,
  'the accounting report does not expose a redeemable gift code/branch credential')
assert.equal(cashReport.fundingAttribution.status, 'NOT_APPLICABLE')
console.log('✓ S5 actual CASH channel: 5M return = B 2M + drawer refund 3M; 1-Rial mismatch has zero effects')

// The branch remains non-spendable until witnessed handoff. After delivery it
// is usable for exactly its face value; the source gift stays USED.
await assert.rejects(() => findRedeemable(db, cashBranch.code), /پیش‌نویس/)
const cashDelivery = {
  creditId: Number(cashBranch.id), witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'تحویل سهم B به مشتری با رسید و شاهد',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}
assert.equal((await confirmCreditDelivery(cashDelivery)).status, 'DELIVERED')
assert.equal((await confirmCreditDelivery(cashDelivery)).replayed, true)
const bSpendVariant = variant(2_000_000)
const bSpend = await salesService.create({
  userId, shiftId, lines: [line(bSpendVariant, 2_000_000)], payments: [],
  storeCreditCode: cashBranch.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's5-spend-delivered-b-once'
})
assert.equal(bSpend.storeCreditApplied, 2_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', cashBranch.id).status, 'USED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', cashCase.gift.id).status, 'USED')
assert.equal(Number(seed.one('SELECT amount FROM "StoreCreditRedemption" WHERE creditId=? AND invoiceId=?',
  cashBranch.id, bSpend.id).amount), 2_000_000)

// Scenario B: the 2M gift share is restored by the first 2M return; the next
// 3M return is entirely the real-money right, reserved and reviewed in the
// manager-bank channel. Manager declaration alone is not payout.
const bankCase = await makeMixedSale([2_000_000, 3_000_000, 10_000_000], 'bank-chunks')
const firstChunk = await createReturn(bankCase.sale, Number(bankCase.items[0].id),
  2_000_000, 'NONE', 0, 'bank-chunk-2m')
assert.equal(firstChunk.total, 2_000_000)
assert.equal(firstChunk.creditOpportunity.restored, 2_000_000)
assert.equal(firstChunk.cardTransfer, null)
const firstBranch = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=?', firstChunk.id)
assert.equal(Number(firstBranch.amount), 2_000_000)
assert.equal(firstBranch.status, 'DRAFT')
assert.equal(new Date(firstBranch.expiresAt).getTime(), new Date(bankCase.gift.expiresAt).getTime())

const secondChunk = await createReturn(bankCase.sale, Number(bankCase.items[1].id),
  3_000_000, 'CARD_TO_CARD', 3_000_000, 'bank-chunk-3m')
assert.equal(secondChunk.total, 3_000_000)
assert.equal(secondChunk.creditOpportunity?.restored ?? 0, 0,
  'the fully restored one-shot gift is never restored again')
assert.equal(secondChunk.cardTransfer.amount, 3_000_000)
const secondBankProof = await proveBankPayout(secondChunk.id, secondChunk.cardTransfer.id, 3_000_000, 'chunk-3m')
assert.equal(secondBankProof.cashPaid, 3_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) AS total FROM "CreditReturnAllocation" WHERE invoiceId=?',
  bankCase.sale.id).total), 2_000_000)
assert.equal(Number(seed.one('SELECT SUM(confirmedAmount) AS total FROM "BankStatementEvidence" WHERE requestId=?',
  secondChunk.cardTransfer.id).total), 3_000_000)
assert.equal(seed.count('CashMovement', 'refType=? AND refId IN (?,?)',
  'SaleReturn', firstChunk.id, secondChunk.id), 0,
  'external manager-bank settlement is not misreported as cash drawer payout')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', bankCase.gift.id).status, 'USED')
for (const branch of [firstBranch]) {
  await assert.rejects(() => findRedeemable(db, branch.code), /پیش‌نویس/)
  const delivery = { creditId: Number(branch.id), witnessKind: 'CUSTOMER_HANDOFF',
    witnessRef: `تحویل شاهددار شاخهٔ S5 ${branch.id}`, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId }
  assert.equal((await confirmCreditDelivery(delivery)).status, 'DELIVERED')
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', branch.id).status, 'ACTIVE')
}
assert.equal(new Date(firstBranch.expiresAt).getTime(), new Date(bankCase.gift.expiresAt).getTime())
console.log('✓ S5 bank channel: B=2M restored once, remaining 3M reserved and paid with reviewed bank evidence; original root expiry retained')

// An expiry-bound B cannot be delivered after its root deadline; waiting for
// delivery never extends the opportunity.
const expiryAt = Date.now() + 4_000
const expiryCase = await makeMixedSale([5_000_000, 5_000_000, 5_000_000], 'expiry', expiryAt)
const expiryReturn = await createReturn(expiryCase.sale, Number(expiryCase.items[0].id),
  5_000_000, 'CASH', 3_000_000, 'expiry-bound-b')
assert.equal(expiryReturn.creditOpportunity.restored, 2_000_000)
const expiringBranch = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=?', expiryReturn.id)
assert.equal(expiringBranch.status, 'DRAFT')
assert.equal(new Date(expiringBranch.expiresAt).getTime(), expiryAt)
await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiryAt - Date.now() + 25)))
await assert.rejects(() => confirmCreditDelivery({
  creditId: Number(expiringBranch.id), witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'تحویل پس از موعد اصلی که باید رد شود',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /انقضای اصلی/)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', expiringBranch.id).status, 'DRAFT')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', expiryCase.gift.id).status, 'USED')
await assert.rejects(() => findRedeemable(db, expiringBranch.code), /مهلت اعتبار|تمام شده|منقضی/)
console.log('✓ S5 expiry: B retains root deadline; pending delivery cannot revive/extend expired gift opportunity')

console.log('✓ S5 integration: exact source return 2M gift + 3M real-money choice, cash/bank paths, B delivery/expiry, reporting, and fail-closed amount mismatch')
