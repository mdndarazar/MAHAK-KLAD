/** S7 mixed-tender isolation: one exchange yields separate N right lineages
 * for cash/card/cleared-cheque. A later bounce quarantines only cheque; the
 * card branch remains UNKNOWN until reviewed and the cash branch stays live.
 * Exercises actual SalesService and residual-right service paths.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s7-mixed-tender-quarantine-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-s7-mixed-quarantine-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { getCurrentSaleFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { getExchangeResidualRightBalance, setS7NResidualRightSourceDisposition,
  reviewS7CardSourceBankStatement } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('S7 mixed tender lineage')
const categoryId = seed.category('S7 mixed category')
const productId = seed.product('S7 mixed product', categoryId)
const method = (key, kind) => seed.insert('PaymentMethod', { key, label: key, kind, isActive: 1 })
const cashMethodId = method('CASH', 'CASH')
const cardMethodId = method('CARD', 'CARD')
const chequeMethodId = method('CHEQUE', 'CUSTOM')
const shiftId = seed.insert('Shift', { name: 'S7 mixed shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const variant = (code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=40, salePrice=? WHERE id=?').run(price, id)
  return id
}
const sourceVariant = variant('S7-MIXED-SOURCE-4M', 4_000_000)
const replacementVariant = variant('S7-MIXED-REPLACEMENT-2M', 2_000_000)
const unrelatedVariant = variant('S7-MIXED-UNRELATED-100K', 100_000)
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const sale = await salesService.create({ userId, shiftId, lines: [item(sourceVariant, 4_000_000)],
  payments: [
    { methodId: cashMethodId, amount: 1_000_000, destination: 'CASH', reference: 'S7-CASH-RECON-001' },
    { methodId: cardMethodId, amount: 1_500_000, destination: 'CARD', reference: 'S7-CARD-STATEMENT-001' }
  ] })
const cheque = await salesService.addPayment({ invoiceId: sale.id, userId, methodId: chequeMethodId,
  kind: 'CHEQUE', amount: 1_500_000, chequeNo: 'S7-CHQ-001', bankName: 'S7 bank',
  dueDateJalali: toJalaliDate(new Date()), idempotencyKey: 's7-mixed-cheque-payment-0001' })
await salesService.setChequeStatus({ id: cheque.payment.id, userId, status: 'CLEARED',
  destination: 'MANAGER', managerPassword: DEFAULT_MANAGER_PASSWORD })
const funding = await getCurrentSaleFundingSources(db, sale.id)
assert.equal(funding.stale, false)
assert.deepEqual(funding.sources.map(({ sourceKind, available }) => ({ sourceKind, available }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CARD', available: 1_500_000 },
    { sourceKind: 'SOURCE_CASH', available: 1_000_000 },
    { sourceKind: 'SOURCE_CHEQUE', available: 1_500_000 }
  ])
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
const exchange = await salesService.createExchange({ invoiceId: sale.id,
  lines: [{ saleItemId: sourceItem.id, qty: 1 }], replacements: [item(replacementVariant, 2_000_000)],
  userId, shiftId, refundMode: 'S1_RESIDUAL_RIGHTS', goodsReceiptRequired: false,
  idempotencyKey: 's7-mixed-three-proven-sources-0001' })
const rights = exchange.residualRights.rights.filter((right) => right.rightKind === 'N')
assert.equal(rights.length, 3)
assert.deepEqual(rights.map((right) => right.amount).sort((a, b) => a - b), [500_000, 750_000, 750_000])
const openingBySource = new Map(funding.sources.map((source) => [Number(source.event.id), source.sourceKind]))
const sourceIdOf = (right) => Number(String(right.rightKey).match(/:source:(\d+):N$/)?.[1])
const cashRight = rights.find((right) => openingBySource.get(sourceIdOf(right)) === 'SOURCE_CASH')
const cardRight = rights.find((right) => openingBySource.get(sourceIdOf(right)) === 'SOURCE_CARD')
const chequeRight = rights.find((right) => openingBySource.get(sourceIdOf(right)) === 'SOURCE_CHEQUE')
assert.ok(cashRight && cardRight && chequeRight)
for (const right of rights) {
  await confirmCreditDelivery({ creditId: right.creditId, witnessKind: 'CUSTOMER_HANDOFF',
    witnessRef: `S7 delivery for ${right.rightKey}`, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
}
const chequeBounced = await salesService.setChequeStatus({ id: cheque.payment.id, userId,
  status: 'BOUNCED', managerPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(chequeBounced.cheque.chequeStatus, 'BOUNCED')
assert.equal(seed.count('ExchangeResidualRightCorrectionEvent', 'rightKey=? AND eventKind=?',
  chequeRight.rightKey, 'SOURCE_QUARANTINED'), 1,
  'the real cheque-status service appends one source-local quarantine event atomically')
const cardQuarantine = await setS7NResidualRightSourceDisposition({
  rightKey: cardRight.rightKey, operationKey: 's7-card-proof-unknown-0001', action: 'QUARANTINE',
  evidenceKind: 'CARD_UNKNOWN', evidenceRef: 'S7 card statement not yet matched',
  reason: 'Card source remains unproven until bank statement review',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(cardQuarantine.quarantined, true)
const cardQuarantineReplay = await setS7NResidualRightSourceDisposition({
  rightKey: cardRight.rightKey, operationKey: 's7-card-proof-unknown-0001', action: 'QUARANTINE',
  evidenceKind: 'CARD_UNKNOWN', evidenceRef: 'S7 card statement not yet matched',
  reason: 'Card source remains unproven until bank statement review',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(cardQuarantineReplay.replayed, true)
const cashBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, cashRight.rightKey))
const cardBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, cardRight.rightKey))
const chequeBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, chequeRight.rightKey))
assert.deepEqual([cashBalance.available, cardBalance.available, chequeBalance.available],
  [500_000, 0, 0], 'only the card-unknown and bounced-cheque branches are quarantined')
await assert.rejects(() => setS7NResidualRightSourceDisposition({
  rightKey: cardRight.rightKey, operationKey: 's7-premature-card-release-0001', action: 'RELEASE',
  evidenceKind: 'CARD_STATEMENT_REVIEW', evidenceRef: 'S7-CARD-STATEMENT-001',
  reason: 'A transaction reference alone is not independent bank proof',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /مدرک/)
const cardPaymentId = Number(funding.sources.find((source) => source.sourceKind === 'SOURCE_CARD').event.sourcePaymentId)
const cardBankEvidence = await reviewS7CardSourceBankStatement({
  paymentId: cardPaymentId, confirmedAmount: 1_500_000,
  document: { name: 'S7-card-statement.pdf', bytes: Buffer.from('%PDF-1.4\\nS7 bank statement row\\n%%EOF') },
  reviewNote: 'Manager matched exact card payment against this bank statement',
  attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
const bankEvidenceReplay = await reviewS7CardSourceBankStatement({
  paymentId: cardPaymentId, confirmedAmount: 1_500_000,
  document: { name: 'S7-card-statement.pdf', bytes: Buffer.from('%PDF-1.4\\nS7 bank statement row\\n%%EOF') },
  reviewNote: 'Manager matched exact card payment against this bank statement',
  attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(bankEvidenceReplay.replayed, true)
const storedEvidence = seed.one('SELECT id FROM "ExchangeResidualRightPaymentEvidence" WHERE paymentId=?', cardPaymentId)
assert.throws(() => sql.prepare('UPDATE "ExchangeResidualRightPaymentEvidence" SET reviewNote=? WHERE id=?')
  .run('mutated evidence', storedEvidence.id), /immutable/u)
assert.throws(() => sql.prepare('DELETE FROM "ExchangeResidualRightPaymentEvidence" WHERE id=?')
  .run(storedEvidence.id), /immutable/u)
const releasedCard = await setS7NResidualRightSourceDisposition({
  rightKey: cardRight.rightKey, operationKey: 's7-release-card-after-statement-0001', action: 'RELEASE',
  evidenceKind: 'CARD_STATEMENT_REVIEW', evidenceRef: cardBankEvidence.sha256,
  reason: 'Reviewed statement reference matches the original card payment record',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(releasedCard.quarantined, false)
const releaseReplay = await setS7NResidualRightSourceDisposition({
  rightKey: cardRight.rightKey, operationKey: 's7-release-card-after-statement-0001', action: 'RELEASE',
  evidenceKind: 'CARD_STATEMENT_REVIEW', evidenceRef: cardBankEvidence.sha256,
  reason: 'Reviewed statement reference matches the original card payment record',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(releaseReplay.replayed, true)
const afterRelease = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, cardRight.rightKey))
assert.equal(afterRelease.available, 750_000)
assert.equal(afterRelease.sourceQuarantined, false)
assert.equal((await db.$transaction((tx) => getExchangeResidualRightBalance(tx, cashRight.rightKey))).available, 500_000)
assert.equal((await db.$transaction((tx) => getExchangeResidualRightBalance(tx, chequeRight.rightKey))).available, 0)
const unrelated = await salesService.create({ userId, shiftId,
  lines: [item(unrelatedVariant, 100_000)],
  payments: [{ methodId: cashMethodId, amount: 100_000, destination: 'CASH' }] })
assert.equal(unrelated.grandTotal, 100_000,
  'quarantining one lineage does not block the customer or unrelated sale')
const blockedCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', chequeRight.creditId).code
await assert.rejects(() => salesService.create({ userId, shiftId,
  lines: [item(unrelatedVariant, 100_000)], payments: [], storeCreditCode: blockedCode,
  storeCreditAmount: 100_000, storeCreditIdempotencyKey: 's7-bounced-orphan-no-cash-0001' }))
assert.equal(seed.count('CashMovement', '1=1'), 0,
  'quarantine and orphan N redemption do not fabricate cash movements')
console.log('✓ S7 mixed tender production integration: 1M cash + 1.5M card + 1.5M cleared cheque split to 500K/750K/750K N; bounced cheque quarantines only cheque, card stays UNKNOWN until review, cash and unrelated sales remain live')
