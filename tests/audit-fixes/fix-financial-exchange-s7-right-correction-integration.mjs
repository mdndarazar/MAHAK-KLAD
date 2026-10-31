/** S7 integration: an S1 N code is spent, corrected from 2M to 1M with
 * 0.5M unused-right adjustment + 0.5M disputed recovery, and later fully
 * returned with cumulative proven/disputed split. Exercises real sales,
 * exchange, checkout, delivery and return services on an isolated SQLite DB.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s7-right-correction-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-s7-right-correction-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { adjustS7NResidualRight, getExchangeResidualRightBalance,
  reserveS1ExchangeResidualRight, cancelS1ExchangeResidualRightReservation } =
  await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { invoiceRemaining } = await import('../../src/main/services/invoiceDebt.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S7 source-right correction')
const categoryId = seed.category('S7 correction category')
const productId = seed.product('S7 correction product', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'S7 shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const variant = (code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=50, salePrice=? WHERE id=?').run(price, id)
  return id
}
const originalVariant = variant('S7-ORIGINAL-4M', 4_000_000)
const replacementVariant = variant('S7-REPLACEMENT-1M', 1_000_000)
const purchaseVariant = variant('S7-N-PURCHASE-500K', 500_000)
const unrelatedVariant = variant('S7-UNRELATED-CASH', 100_000)
const item = (variantId, price, qty = 1) => ({ variantId, qty, unitPrice: price, discount: 0, tax: 0 })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 1_333_333, multiUse: true, maxUses: 100,
  carryRemainder: true, days: 90, note: 'S7 mixed root gift fixture', userId
}))
const original = await salesService.create({ userId, shiftId,
  lines: [item(originalVariant, 4_000_000)],
  payments: [{ methodId: cashMethodId, amount: 2_666_667, destination: 'CASH', reference: 'S7-CASH-RECON-0001' }],
  storeCreditCode: gift.code, storeCreditAmount: 1_333_333,
  storeCreditIdempotencyKey: 's7-root-gift-redemption-0001' })
assert.equal(original.grandTotal, 4_000_000)
assert.equal(original.storeCreditApplied, 1_333_333)
const originalItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', original.id)
const exchange = await salesService.createExchange({
  invoiceId: original.id, lines: [{ saleItemId: originalItem.id, qty: 1 }],
  replacements: [item(replacementVariant, 1_000_000)], userId, shiftId,
  refundMode: 'S1_RESIDUAL_RIGHTS', goodsReceiptRequired: false,
  idempotencyKey: 's7-open-bn-rights-0001'
})
const nRight = exchange.residualRights.rights.find((right) => right.rightKind === 'N')
const bRight = exchange.residualRights.rights.find((right) => right.rightKind === 'B')
assert.ok(nRight && bRight)
assert.equal(nRight.amount, 2_000_000)
assert.equal(bRight.amount, 1_000_000)
const nCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', nRight.creditId).code
for (const right of [nRight, bRight]) {
  const delivered = await confirmCreditDelivery({ creditId: right.creditId,
    witnessKind: 'CUSTOMER_HANDOFF', witnessRef: `S7 witnessed delivery of ${right.rightKind} code`,
    managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
  assert.equal(delivered.status, 'DELIVERED')
}
const before = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ amount: before.amount, available: before.available, spent: before.spent },
{ amount: 2_000_000, available: 2_000_000, spent: 0 })

const s2 = await salesService.create({ userId, shiftId,
  lines: [item(purchaseVariant, 500_000, 3)], payments: [], storeCreditCode: nCode,
  storeCreditAmount: 1_500_000, storeCreditIdempotencyKey: 's7-spend-n-1500000-0001' })
assert.equal(s2.storeCreditApplied, 1_500_000)
const s2Payment = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND storeCreditId=?', s2.id, nRight.creditId)
const spent = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ available: spent.available, spent: spent.spent }, { available: 500_000, spent: 1_500_000 })
assert.equal((await invoiceRemaining(db, s2.id)).remaining, 0)
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: bRight.rightKey, operationKey: 's7-forbidden-b-correction-0001',
  verifiedAmount: 500_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'B is excluded from N rights corrections', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فقط حق N/)

await db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: nRight.rightKey, operationKey: 's7-active-reservation-0001', amount: 100_000,
  relatedInvoiceId: s2.id, actorUserId: userId
}))
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-reject-reserved-adjustment-0001',
  verifiedAmount: 1_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'This correction must wait for the active right reservation to settle',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /رزرو/)
await db.$transaction((tx) => cancelS1ExchangeResidualRightReservation(tx, {
  rightKey: nRight.rightKey, operationKey: 's7-active-reservation-0001', amount: 100_000,
  relatedInvoiceId: s2.id, actorUserId: userId
}))
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-no-op-correction-0001',
  verifiedAmount: 2_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'No change must not create a false correction event',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /هیچ تغییری/)
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-wrong-manager-proof-0001',
  verifiedAmount: 1_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'Wrong manager credential must leave every right event unchanged', managerPassword: '0000', actorUserId: userId
}), /رمز/)
assert.equal(seed.count('ExchangeResidualRightCorrectionEvent', 'rightKey=?', nRight.rightKey), 0,
  'failed manager authentication appends no correction')
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-mismatched-source-evidence-0001',
  verifiedAmount: 1_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-unmatched-reference-0001',
  reason: 'Evidence must match the persisted root source payment reference',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /نوع شاهد/)
assert.equal(seed.count('ExchangeResidualRightCorrectionEvent', 'rightKey=?', nRight.rightKey), 0,
  'a mismatched root-payment evidence reference appends no correction')
const correction = await adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-proof-right-reconciliation-0001',
  verifiedAmount: 1_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'Only one million of this N lineage is supported by source reconciliation',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.deepEqual({ validAmount: correction.validAmount, rightAdjusted: correction.rightAdjusted,
  disputedRecoveryOpen: correction.disputedRecoveryOpen, available: correction.available,
  spent: correction.spent },
{ validAmount: 1_000_000, rightAdjusted: 500_000, disputedRecoveryOpen: 500_000,
  available: 0, spent: 1_000_000 })
const correctionReplay = await adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-proof-right-reconciliation-0001',
  verifiedAmount: 1_000_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'Only one million of this N lineage is supported by source reconciliation',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(correctionReplay.replayed, true)
await assert.rejects(() => adjustS7NResidualRight({
  rightKey: nRight.rightKey, operationKey: 's7-proof-right-reconciliation-0001',
  verifiedAmount: 900_000, relatedInvoiceId: s2.id, relatedPaymentId: s2Payment.id,
  evidenceKind: 'CASH_RECONCILIATION', evidenceRef: 'S7-CASH-RECON-0001',
  reason: 'Only one million of this N lineage is supported by source reconciliation',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /وضعیت|ناسازگار/)
assert.equal(seed.count('ExchangeResidualRightCorrectionEvent', 'rightKey=? AND eventKind=?',
  nRight.rightKey, 'RIGHT_ADJUST'), 1)
const appendOnlyCorrectionId = seed.one('SELECT id FROM "ExchangeResidualRightCorrectionEvent" WHERE rightKey=? AND eventKind=?',
  nRight.rightKey, 'RIGHT_ADJUST').id
assert.throws(() => sql.prepare('UPDATE "ExchangeResidualRightCorrectionEvent" SET reason=? WHERE id=?')
  .run('forged correction mutation', appendOnlyCorrectionId), /append-only/u)
assert.throws(() => sql.prepare('DELETE FROM "ExchangeResidualRightCorrectionEvent" WHERE id=?')
  .run(appendOnlyCorrectionId), /append-only/u)
assert.equal((await invoiceRemaining(db, s2.id)).remaining, 0,
  'correction does not automatically create invoice/customer debt')
assert.equal(seed.one('SELECT amount FROM "ExchangeResidualRightCorrectionEvent" WHERE rightKey=? AND eventKind=?',
  nRight.rightKey, 'DISPUTED_RECOVERY_OPEN').amount, 500_000)
const sourceOpen = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ available: sourceOpen.available, validAmount: sourceOpen.validAmount,
  spent: sourceOpen.spent, grossSpent: sourceOpen.grossSpent, disputedRecoveryOpen: sourceOpen.disputedRecoveryOpen },
{ available: 0, validAmount: 1_000_000, spent: 1_000_000, grossSpent: 1_500_000, disputedRecoveryOpen: 500_000 })
await assert.rejects(() => findRedeemable(db, nCode), /باقی‌مانده|خرج|مصرف/u,
  'same N code is blocked at its corrected zero balance; the unused unsupported 500k is not spendable')
const invoiceCountBeforeDeniedN = seed.count('SaleInvoice', '1=1')
await assert.rejects(() => salesService.create({ userId, shiftId,
  lines: [item(unrelatedVariant, 100_000)], payments: [], storeCreditCode: nCode,
  storeCreditAmount: 100_000, storeCreditIdempotencyKey: 's7-spend-corrected-zero-n-0001' }))
assert.equal(seed.count('SaleInvoice', '1=1'), invoiceCountBeforeDeniedN,
  'the denied N attempt creates no invoice')
const unrelated = await salesService.create({ userId, shiftId,
  lines: [item(unrelatedVariant, 100_000)],
  payments: [{ methodId: cashMethodId, amount: 100_000, destination: 'CASH' }] })
assert.equal(unrelated.grandTotal, 100_000,
  'the disputed lineage does not block a separate unrelated cash sale')

const s2Item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', s2.id)
const returnPiece = async (note) => salesService.createReturn({ invoiceId: s2.id, full: false,
  lines: [{ saleItemId: s2Item.id, qty: 1 }], refundMethod: 'NONE', refundAmount: 0,
  userId, shiftId, note }, { goodsReceiptRequired: false })
const s2Return1 = await returnPiece('S7 first partial return: cumulative floor')
assert.equal(s2Return1.total, 500_000)
assert.equal(seed.one('SELECT amount FROM "ExchangeResidualRightCorrectionEvent" WHERE rightKey=? AND eventKind=? AND relatedReturnId=?',
  nRight.rightKey, 'DISPUTE_OFFSET_BY_RETURN', s2Return1.id).amount, 166_666)
const afterReturn1 = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ available: afterReturn1.available, spent: afterReturn1.spent,
  disputedRecoveryOpen: afterReturn1.disputedRecoveryOpen, disputedOffset: afterReturn1.disputedOffset },
{ available: 333_334, spent: 666_666, disputedRecoveryOpen: 333_334, disputedOffset: 166_666 })
const s2Return2 = await returnPiece('S7 second partial return: cumulative floor')
assert.equal(s2Return2.total, 500_000)
assert.equal(seed.one('SELECT amount FROM "ExchangeResidualRightCorrectionEvent" WHERE rightKey=? AND eventKind=? AND relatedReturnId=?',
  nRight.rightKey, 'DISPUTE_OFFSET_BY_RETURN', s2Return2.id).amount, 166_667)
const afterReturn2 = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ available: afterReturn2.available, spent: afterReturn2.spent,
  disputedRecoveryOpen: afterReturn2.disputedRecoveryOpen, disputedOffset: afterReturn2.disputedOffset },
{ available: 666_667, spent: 333_333, disputedRecoveryOpen: 166_667, disputedOffset: 333_333 })
const s2Return3 = await returnPiece('S7 final partial return: cumulative floor')
assert.equal(s2Return3.total, 500_000)
assert.equal(s2Return3.refundAmount, 0)
assert.equal(seed.count('StoreCredit', 'returnId=?', s2Return3.id), 0,
  'proven N returns to the same code; no successor/duplicate right is minted')
assert.equal(seed.one('SELECT amount FROM "ExchangeResidualRightCorrectionEvent" WHERE rightKey=? AND eventKind=? AND relatedReturnId=?',
  nRight.rightKey, 'DISPUTE_OFFSET_BY_RETURN', s2Return3.id).amount, 166_667)
const afterReturn = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight.rightKey))
assert.deepEqual({ validAmount: afterReturn.validAmount, available: afterReturn.available,
  spent: afterReturn.spent, grossSpent: afterReturn.grossSpent, disputedRecoveryOpen: afterReturn.disputedRecoveryOpen,
  disputedRecoveryTotal: afterReturn.disputedRecoveryTotal, disputedOffset: afterReturn.disputedOffset },
{ validAmount: 1_000_000, available: 1_000_000, spent: 0, grossSpent: 0,
  disputedRecoveryOpen: 0, disputedRecoveryTotal: 500_000, disputedOffset: 500_000 })
const sameCode = await findRedeemable(db, nCode)
assert.equal(Number(sameCode.amount) - Number(sameCode.usedAmount), 1_000_000,
  'the original N credential displays only the corrected live right after the return')
const restoredUse = await salesService.create({ userId, shiftId,
  lines: [item(unrelatedVariant, 100_000)], payments: [], storeCreditCode: nCode,
  storeCreditAmount: 100_000, storeCreditIdempotencyKey: 's7-spend-restored-same-n-code-0001' })
assert.equal(restoredUse.storeCreditApplied, 100_000)
assert.equal(seed.count('StoreCredit', 'returnId=?', s2Return3.id), 0)
assert.equal(seed.count('CashMovement', '1=1'), 0,
  'right correction, disputed return offset and same-code restoration fabricate no cash')
console.log('✓ S7 production integration: witnessed N correction 2M→1M, 500k unused adjustment + 500k disputed recovery, three partial returns use cumulative-floor offsets and restore only 1M to same code; unrelated cash sale unaffected')
