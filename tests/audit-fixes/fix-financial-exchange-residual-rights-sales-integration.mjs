/** S1 production-path probe: mixed paid source -> cheaper exchange -> exact carry + B/N residuals.
 * This exercises SalesService.create and createExchange, not only the ledger helper.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-residual-rights-sales-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s1-sales-integration-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, deleteCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { getExchangeResidualRightBalance } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S1 residual-right sales integration')
const categoryId = seed.category('S1 residual-right category')
const productId = seed.product('S1 residual-right item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'S1 residual-right shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const variant = (code, price) => {
  const variantId = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=? WHERE id=?').run(price, variantId)
  return variantId
}
const sourceVariant = variant('S1-SOURCE', 15_980_000)
const replacementVariant = variant('S1-REPLACEMENT', 15_000_000)
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 original gift root', userId
}))
const sourceSale = await salesService.create({
  userId, shiftId, lines: [item(sourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-original-gift-redemption-0001'
})
assert.equal(sourceSale.grandTotal, 15_980_000)
assert.equal(sourceSale.storeCreditApplied, 2_000_000)
const before = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.equal(before.stale, false)
assert.deepEqual(before.unresolved, [])
assert.deepEqual(before.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_980_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sourceSale.id)
const request = {
  invoiceId: sourceSale.id,
  lines: [{ saleItemId: sourceItem.id, qty: 1 }],
  replacements: [item(replacementVariant, 15_000_000)],
  refundMode: 'S1_RESIDUAL_RIGHTS', userId, shiftId, goodsReceiptRequired: false,
  idempotencyKey: 's1-exchange-residual-sales-0001'
}
await assert.rejects(() => salesService.createExchange({ ...request, refundMode: 'CASH',
  idempotencyKey: 's1-exchange-must-not-downgrade-to-cash-0001' }), /واجد S1/u,
  'an otherwise eligible S1 exchange cannot silently choose an ordinary cash refund')
assert.equal(seed.count('SaleReturn', 'invoiceId=?', sourceSale.id), 0,
  'rejected generic refund selection has no return side effects')
const exchange = await salesService.createExchange(request)
assert.equal(exchange.returnTotal, 15_980_000)
assert.equal(exchange.exchangeTotal, 15_000_000)
assert.equal(exchange.diff, -980_000)
assert.equal(exchange.settlement, 'S1_RESIDUAL_RIGHTS')
assert.equal(exchange.storeCredit, null, 'no generic fungible refund credit is issued')
assert.deepEqual(exchange.residualRights, {
  giftCarry: 1_877_346,
  cashCarry: 13_122_654,
  rights: [
    { rightKey: `s1-exchange:${exchange.returnId}:source:${before.sources.find((s) => s.sourceKind === 'SOURCE_GIFT').event.id}:B`,
      rightKind: 'B', amount: 122_654, available: 122_654,
      expiresAt: new Date(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', gift.id).expiresAt),
      creditId: exchange.residualRights.rights.find((r) => r.rightKind === 'B').creditId,
      publicReference: exchange.residualRights.rights.find((r) => r.rightKind === 'B').publicReference,
      deliveryStatus: 'PENDING_DELIVERY' },
    { rightKey: `s1-exchange:${exchange.returnId}:source:${before.sources.find((s) => s.sourceKind === 'SOURCE_CASH').event.id}:N`,
      rightKind: 'N', amount: 857_346, available: 857_346, expiresAt: null,
      creditId: exchange.residualRights.rights.find((r) => r.rightKind === 'N').creditId,
      publicReference: exchange.residualRights.rights.find((r) => r.rightKind === 'N').publicReference,
      deliveryStatus: 'PENDING_DELIVERY' }
  ]
})
const childFunding = await getCurrentExchangeFundingSources(db, exchange.exchangeInvoiceId)
assert.equal(childFunding.unresolved.length, 0)
assert.deepEqual(childFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 1_877_346 },
  { sourceKind: 'SOURCE_CASH', available: 13_122_654 }
])
assert.deepEqual(seed.rows('SELECT rightKind, amount FROM "ExchangeResidualRightEvent" WHERE eventKind=? ORDER BY rightKind', 'OPENED'), [
  { rightKind: 'B', amount: 122_654 }, { rightKind: 'N', amount: 857_346 }
])
assert.equal(seed.count('StoreCredit', 'exchangeResidualRightKey IS NOT NULL'), 2)
assert.equal(seed.count('CreditDelivery', 'sourceKind IN (?,?) AND status=?', 'S1_EXCHANGE_B', 'S1_EXCHANGE_N', 'PENDING_DELIVERY'), 2)
assert.equal(seed.count('CashMovement', '1=1'), 0, 'residual claim creation does not fabricate a cash movement')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
const counts = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  rights: seed.count('ExchangeResidualRightEvent', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  deliveries: seed.count('CreditDelivery', '1=1')
}
const replay = await salesService.createExchange(request)
assert.equal(replay.replayed, true)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sourceSale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  rights: seed.count('ExchangeResidualRightEvent', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  deliveries: seed.count('CreditDelivery', '1=1')
}, counts, 'idempotent retry does not duplicate exchange, rights, access codes, or delivery rows')
assert.equal(replay.residualRights.rights.length, 2)

const voidResult = await salesService.returnDelete({ id: exchange.returnId, userId,
  reason: 'S1 exchange void before delivery', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(voidResult.voided, true)
assert.equal(seed.count('ExchangeResidualRightEvent', 'returnId=? AND eventKind=?', exchange.returnId, 'VOIDED'), 2)
assert.equal(seed.count('CreditDelivery', 'sourceKind IN (?,?) AND status=?',
  'S1_EXCHANGE_B', 'S1_EXCHANGE_N', 'VOID'), 2)
assert.equal(seed.count('StoreCredit', 'exchangeResidualRightKey IS NOT NULL AND status=?', 'CANCELED'), 2)
const afterVoid = await db.$transaction((tx) => getExchangeResidualRightBalance(tx,
  exchange.residualRights.rights.find((right) => right.rightKind === 'N').rightKey))
assert.equal(afterVoid.voided, true)
assert.equal(afterVoid.available, 0)

const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const secondGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 delivered-void gate fixture', userId
}))
const secondSourceVariant = variant('S1-SOURCE-DELIVERED', 15_980_000)
const secondReplacementVariant = variant('S1-REPLACEMENT-DELIVERED', 15_000_000)
const secondSourceSale = await salesService.create({
  userId, shiftId, lines: [item(secondSourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: secondGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-delivered-gift-redemption-0001'
})
const secondSourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', secondSourceSale.id)
const deliveredExchange = await salesService.createExchange({
  invoiceId: secondSourceSale.id, lines: [{ saleItemId: secondSourceItem.id, qty: 1 }],
  replacements: [item(secondReplacementVariant, 15_000_000)], userId, shiftId,
  refundMode: 'S1_RESIDUAL_RIGHTS', goodsReceiptRequired: false, idempotencyKey: 's1-delivered-exchange-void-gate-0001'
})
for (const right of deliveredExchange.residualRights.rights) {
  const confirmed = await confirmCreditDelivery({ creditId: right.creditId, witnessKind: 'CUSTOMER_HANDOFF',
    witnessRef: `S1 witnessed delivery for ${right.rightKind}`, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
  assert.equal(confirmed.status, 'DELIVERED')
}
await assert.rejects(() => salesService.returnDelete({ id: deliveredExchange.returnId, userId,
  reason: 'S1 delivery already occurred', panelPassword: DEFAULT_MANAGER_PASSWORD }), /تحویل یا مصرف شده/u)
assert.equal(seed.count('ExchangeResidualRightEvent', 'returnId=? AND eventKind=?', deliveredExchange.returnId, 'VOIDED'), 0)
assert.equal(seed.count('CreditDelivery', 'creditId IN (?,?) AND status=?',
  ...deliveredExchange.residualRights.rights.map((r) => r.creditId), 'DELIVERED'), 2,
  'witnessed handoff is not undone by exchange void')
await assert.rejects(() => deleteCredit({
  id: deliveredExchange.residualRights.rights[0].creditId,
  reason: 'attempt to delete a live S1 right access code', managerPassword: DEFAULT_MANAGER_PASSWORD
}), /ماندهٔ زندهٔ دفتر حق/u)
const deliveredN = deliveredExchange.residualRights.rights.find((r) => r.rightKind === 'N')
const deliveredB = deliveredExchange.residualRights.rights.find((r) => r.rightKind === 'B')
const nCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', deliveredN.creditId).code
const bCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', deliveredB.creditId).code
const nRight = deliveredN.rightKey
const bRight = deliveredB.rightKey
const nPurchaseVariant = variant('S1-N-PURCHASE', 400_000)
const nPurchase = await salesService.create({ userId, shiftId,
  lines: [item(nPurchaseVariant, 400_000)], payments: [], storeCreditCode: nCode,
  storeCreditAmount: 400_000, storeCreditIdempotencyKey: 's1-checkout-n-400000-0001' })
assert.equal(nPurchase.storeCreditApplied, 400_000)
let nBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
assert.deepEqual({ available: nBalance.available, reserved: nBalance.reserved, spent: nBalance.spent },
  { available: 457_346, reserved: 0, spent: 400_000 })
const mixedPurchaseVariant = variant('S1-MIXED-PURCHASE', 580_000)
const mixedPurchase = await salesService.create({ userId, shiftId,
  lines: [item(mixedPurchaseVariant, 580_000)], payments: [], storeCreditCodes: [nCode, bCode],
  storeCreditAmount: 580_000, storeCreditIdempotencyKey: 's1-checkout-nb-580000-0001' })
assert.equal(mixedPurchase.storeCreditApplied, 580_000)
assert.equal(mixedPurchase.storeCredits.length, 2, 'both tender credentials were redeemed in one checkout')
nBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
const bBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))
assert.deepEqual({ available: nBalance.available, spent: nBalance.spent, reserved: nBalance.reserved,
  bAvailable: bBalance.available, bSpent: bBalance.spent, bReserved: bBalance.reserved },
  { available: 0, spent: 857_346, reserved: 0, bAvailable: 0, bSpent: 122_654, bReserved: 0 })
assert.equal(seed.count('ExchangeResidualRightEvent', 'rightKey IN (?,?) AND eventKind=?', nRight, bRight, 'COMMITTED'), 3)
const invoiceCountBeforeExhaustedAttempt = seed.count('SaleInvoice', '1=1')
await assert.rejects(() => salesService.create({ userId, shiftId,
  lines: [item(variant('S1-EXHAUSTED-ATTEMPT', 1), 1)], payments: [], storeCreditCodes: [nCode, bCode],
  storeCreditAmount: 1, storeCreditIdempotencyKey: 's1-checkout-exhausted-1-rial' }), /مصرف|مانده|خرج‌شده/u)
assert.equal(seed.count('SaleInvoice', '1=1'), invoiceCountBeforeExhaustedAttempt,
  'the final 1-rial retry fails atomically before a sale is committed')
assert.equal(seed.count('CashMovement', '1=1'), 0, 'B/N redemptions remain non-cash')
console.log('✓ S1 real SalesService integration: exact proportional carry, B/N issue/handoff, N=400k then N+B=580k checkout, exhausted 1-rial rejection, safe void gates')
