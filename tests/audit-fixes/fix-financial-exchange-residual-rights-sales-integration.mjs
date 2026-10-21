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
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources,
  transferExchangeFundingShare } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { getExchangeResidualRightBalance } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { invoiceRemaining } = await import('../../src/main/services/invoiceDebt.ts')
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
// Deliver B while its root is still live, but deliberately leave N pending so
// the same witnessed-handoff path can be exercised after B expires below.
const deliveredGiftRight = deliveredExchange.residualRights.rights.find((r) => r.rightKind === 'B')
const pendingCashRight = deliveredExchange.residualRights.rights.find((r) => r.rightKind === 'N')
const bHandoff = await confirmCreditDelivery({ creditId: deliveredGiftRight.creditId, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'S1 witnessed delivery for B before root expiry', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
assert.equal(bHandoff.status, 'DELIVERED')
await assert.rejects(() => salesService.returnDelete({ id: deliveredExchange.returnId, userId,
  reason: 'S1 delivery already occurred', panelPassword: DEFAULT_MANAGER_PASSWORD }), /تحویل یا مصرف شده/u)
assert.equal(seed.count('ExchangeResidualRightEvent', 'returnId=? AND eventKind=?', deliveredExchange.returnId, 'VOIDED'), 0)
assert.equal(seed.count('CreditDelivery', 'creditId=? AND status=?', deliveredGiftRight.creditId, 'DELIVERED'), 1,
  'witnessed B handoff is not undone by exchange void')
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
const deliveredBExpiry = seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', deliveredB.creditId).expiresAt
assert.ok(deliveredBExpiry, 'S1 B inherits the gift-root expiry')
const nPurchaseVariant = variant('S1-N-PURCHASE', 400_000)
const realDateNow = Date.now
try {
  // Keep the simulated clock beyond the captured root deadline through both
  // checks and the real SalesService checkout: the N code must work at that
  // time, not merely have a live balance when the clock is restored.
  Date.now = () => new Date(deliveredBExpiry).getTime() + 1
  const invoiceCountAtBExpiry = seed.count('SaleInvoice', '1=1')
  await assert.rejects(() => salesService.create({ userId, shiftId,
    lines: [item(variant('S1-EXPIRED-B-ATTEMPT', 1), 1)], payments: [], storeCreditCode: bCode,
    storeCreditAmount: 1, storeCreditIdempotencyKey: 's1-expired-b-sale-attempt-0001' }),
  /منقضی|انقضا|اعتبار/u,
  'expired B cannot be tender even though its same-code ledger balance is nonzero')
  assert.equal(seed.count('SaleInvoice', '1=1'), invoiceCountAtBExpiry,
    'expired-B denial commits no invoice')
  const expiredBBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight,
    new Date(new Date(deliveredBExpiry).getTime() + 1)))
  const liveNBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
  assert.equal(expiredBBalance.expired, true)
  assert.equal(expiredBBalance.available, 0)
  assert.equal(liveNBalance.expired, false)
  assert.equal(liveNBalance.available, 857_346,
    'N remains live and unchanged after the B root expiry')

  const nHandoff = await confirmCreditDelivery({ creditId: pendingCashRight.creditId,
    witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'S1 witnessed N handoff after B root expiry',
    managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
  assert.equal(nHandoff.status, 'DELIVERED',
    'N delivery with witness is allowed after root expiry even though B is EXPIRED_B')

  const nPurchase = await salesService.create({ userId, shiftId,
    lines: [item(nPurchaseVariant, 400_000)], payments: [], storeCreditCode: nCode,
    storeCreditAmount: 400_000, storeCreditIdempotencyKey: 's1-checkout-n-400000-0001' })
  assert.equal(nPurchase.storeCreditApplied, 400_000,
    'the same delivered N code remains consumable after B root expiry')
  const nBalanceAfterExpirySpend = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
  assert.deepEqual({ available: nBalanceAfterExpirySpend.available, reserved: nBalanceAfterExpirySpend.reserved,
    spent: nBalanceAfterExpirySpend.spent }, { available: 457_346, reserved: 0, spent: 400_000 })
} finally {
  Date.now = realDateNow
}
let nBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
assert.deepEqual({ available: nBalance.available, reserved: nBalance.reserved, spent: nBalance.spent },
  { available: 457_346, reserved: 0, spent: 400_000 })
const mixedPurchaseVariant = variant('S1-MIXED-PURCHASE-580-UNITS', 1_000)
sql.prepare('UPDATE "ProductVariant" SET stock=1000 WHERE id=?').run(mixedPurchaseVariant)
const mixedPurchase = await salesService.create({ userId, shiftId,
  lines: [{ variantId: mixedPurchaseVariant, qty: 580, unitPrice: 1_000, discount: 0, tax: 0 }],
  payments: [], storeCreditCodes: [nCode, bCode],
  storeCreditAmount: 580_000, storeCreditIdempotencyKey: 's1-checkout-nb-580000-0001' })
assert.equal(mixedPurchase.storeCreditApplied, 580_000)
assert.equal(mixedPurchase.storeCredits.length, 2, 'both tender credentials were redeemed in one checkout')
nBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
const bBalance = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))
assert.deepEqual({ available: nBalance.available, spent: nBalance.spent, reserved: nBalance.reserved,
  bAvailable: bBalance.available, bSpent: bBalance.spent, bReserved: bBalance.reserved },
  { available: 0, spent: 857_346, reserved: 0, bAvailable: 0, bSpent: 122_654, bReserved: 0 })
assert.equal(seed.count('ExchangeResidualRightEvent', 'rightKey IN (?,?) AND eventKind=?', nRight, bRight, 'COMMITTED'), 3)
const mixedPurchaseItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', mixedPurchase.id)
const invoiceCountBeforeExhaustedAttempt = seed.count('SaleInvoice', '1=1')
await assert.rejects(() => salesService.create({ userId, shiftId,
  lines: [item(variant('S1-EXHAUSTED-ATTEMPT', 1), 1)], payments: [], storeCreditCodes: [nCode, bCode],
  storeCreditAmount: 1, storeCreditIdempotencyKey: 's1-checkout-exhausted-1-rial' }), /مصرف|مانده|خرج‌شده/u)
assert.equal(seed.count('SaleInvoice', '1=1'), invoiceCountBeforeExhaustedAttempt,
  'the final 1-rial retry fails atomically before a sale is committed')
assert.equal(seed.count('CashMovement', '1=1'), 0, 'B/N redemptions remain non-cash')
const partialReturnPreview = await salesService.returnProvenancePreview({ invoiceId: mixedPurchase.id,
  lines: [{ saleItemId: mixedPurchaseItem.id, qty: 1 }] })
assert.deepEqual(partialReturnPreview.s1ResidualRestoration, { b: 211, n: 789 })
assert.equal(partialReturnPreview.cashRight, 0)
const returnCountBeforeS1Return = seed.count('SaleReturn', '1=1')
const s1ReturnRequest = { invoiceId: mixedPurchase.id,
  lines: [{ saleItemId: mixedPurchaseItem.id, qty: 1 }], refundMethod: 'NONE', refundAmount: 0,
  idempotencyKey: 's1-sale-return-idempotency-0001',
  userId, shiftId, note: 'S1 partial return restores the same B/N rights' }
const s1PartialReturn = await salesService.createReturn(s1ReturnRequest, { goodsReceiptRequired: false })
const s1PartialReturnReplay = await salesService.createReturn(s1ReturnRequest, { goodsReceiptRequired: false })
assert.equal(s1PartialReturnReplay.id, s1PartialReturn.id,
  'retrying the same S1 B/N return request replays its original return')
assert.equal(seed.count('SaleReturn', '1=1'), returnCountBeforeS1Return + 1,
  'same-key S1 return retry cannot create a second return')
assert.equal(s1PartialReturn.total, 1_000)
assert.equal(s1PartialReturn.refundAmount, 0)
assert.equal(s1PartialReturn.invoiceOverpaid, 0, 'restored S1 rights are non-cash and do not create OVERPAY')
assert.equal(seed.count('SaleReturn', '1=1'), returnCountBeforeS1Return + 1)
assert.equal(seed.count('CreditReturnAllocation', 'invoiceId=?', mixedPurchase.id), 0,
  'S1 restoration does not issue a generic B/E successor')
assert.equal(seed.count('CashMovement', '1=1'), 0, 'S1 restoration does not make a cash movement')
const bAfterS1Return = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))
const nAfterS1Return = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
assert.deepEqual({ b: bAfterS1Return.available, n: nAfterS1Return.available }, { b: 211, n: 789 })
assert.equal(seed.count('ExchangeResidualRightEvent', 'eventKind=? AND relatedReturnId=?', 'RESTORED', s1PartialReturn.id), 2)
const voidUnusedS1Return = await salesService.returnDelete({ id: s1PartialReturn.id, userId,
  reason: 'S1 restored B/N rights not spent yet', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(voidUnusedS1Return.voided, true,
  'an S1 sales return can be voided before its restored same-code rights are used')
assert.equal(seed.count('ExchangeResidualRightEvent', 'eventKind=? AND relatedReturnId=?',
  'RESTORATION_REVERSED', s1PartialReturn.id), 2)
assert.deepEqual({
  b: (await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))).available,
  n: (await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))).available
}, { b: 0, n: 0 }, 'void before spend closes the restored B/N allowance again')
const s1PartialReturnAfterVoid = await salesService.createReturn({ invoiceId: mixedPurchase.id,
  lines: [{ saleItemId: mixedPurchaseItem.id, qty: 1 }], refundMethod: 'NONE', refundAmount: 0,
  userId, shiftId, note: 'S1 re-record same-code return after safe void' }, { goodsReceiptRequired: false })
assert.equal(s1PartialReturnAfterVoid.total, 1_000)
const bAfterReopenedReturn = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))
const nAfterReopenedReturn = await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))
assert.deepEqual({ b: bAfterReopenedReturn.available, n: nAfterReopenedReturn.available }, { b: 211, n: 789 })
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', deliveredB.creditId).usedAmount, 122_443)
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', deliveredN.creditId).usedAmount, 856_557)
const postReturnPurchase = await salesService.create({ userId, shiftId,
  lines: [item(variant('S1-POST-RETURN-1K', 1_000), 1_000)], payments: [],
  storeCreditCodes: [nCode, bCode], storeCreditAmount: 1_000,
  storeCreditIdempotencyKey: 's1-checkout-after-return-1k-0001' })
assert.equal(postReturnPurchase.storeCreditApplied, 1_000,
  'the same B/N codes can spend the restored 789 N + 211 B')
assert.deepEqual({ n: (await db.$transaction((tx) => getExchangeResidualRightBalance(tx, nRight))).available,
  b: (await db.$transaction((tx) => getExchangeResidualRightBalance(tx, bRight))).available }, { n: 0, b: 0 })
await assert.rejects(() => salesService.returnDelete({ id: s1PartialReturnAfterVoid.id, userId,
  reason: 'return rights already spent after restore', panelPassword: DEFAULT_MANAGER_PASSWORD }), /مصرف یا رزرو شده/u,
  'a return cannot be voided after its restored S1 right was consumed again')
assert.equal(seed.count('ExchangeResidualRightEvent', 'relatedReturnId=? AND eventKind=?',
  s1PartialReturnAfterVoid.id, 'RESTORATION_REVERSED'), 0)
// Exchange-child return: item-level cumulative allocation releases carry back to
// the exact parent shares, and its void is allowed only while that carry remains.
const childReturnGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 child-return mixed-source fixture', userId
}))
const childSourceVariant = variant('S1-CHILD-RETURN-SOURCE', 15_980_000)
const childReplacementVariant = variant('S1-CHILD-RETURN-REPLACEMENT', 1_000)
sql.prepare('UPDATE "ProductVariant" SET stock=20000 WHERE id=?').run(childReplacementVariant)
const childSourceSale = await salesService.create({
  userId, shiftId, lines: [item(childSourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: childReturnGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-child-return-gift-redemption-0001'
})
const childSourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', childSourceSale.id)
const childReplacementItem = { variantId: childReplacementVariant, qty: 15_000,
  unitPrice: 1_000, discount: 0, tax: 0 }
const childExchange = await salesService.createExchange({
  invoiceId: childSourceSale.id, lines: [{ saleItemId: childSourceItem.id, qty: 1 }],
  replacements: [childReplacementItem], userId, shiftId,
  refundMode: 'S1_RESIDUAL_RIGHTS', goodsReceiptRequired: false,
  idempotencyKey: 's1-child-return-exchange-0001'
})
assert.equal(childExchange.exchangeTotal, 15_000_000)
const childItem = seed.one('SELECT id, qty FROM "SaleInvoiceItem" WHERE invoiceId=?', childExchange.exchangeInvoiceId)
assert.equal(childItem.qty, 15_000)
const childReturnPreview = await salesService.returnProvenancePreview({
  invoiceId: childExchange.exchangeInvoiceId, lines: [{ saleItemId: childItem.id, qty: 1_000 }]
})
assert.equal(childReturnPreview.returnTotal, 1_000_000)
assert.equal(childReturnPreview.settlementReady, true)
assert.equal(childReturnPreview.exchangeCarryRestoration, true)
assert.equal(childReturnPreview.settlementState, 'S1_CARRY_RELEASE_ONLY')
assert.deepEqual(childReturnPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 125_156 },
  { sourceKind: 'SOURCE_CASH', amount: 874_844 }
])
const childReturnCountBefore = seed.count('SaleReturn', '1=1')
const childCarryReturnRequest = {
  invoiceId: childExchange.exchangeInvoiceId,
  lines: [{ saleItemId: childItem.id, qty: 1_000 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  idempotencyKey: 's1-child-carry-return-000001',
  note: 'S1 child return releases exact carry only'
}
const childCarryReturn = await salesService.createReturn(childCarryReturnRequest, { goodsReceiptRequired: false })
const childCarryReturnReplay = await salesService.createReturn(childCarryReturnRequest, { goodsReceiptRequired: false })
assert.equal(childCarryReturnReplay.id, childCarryReturn.id,
  'retrying S1 child carry return replays the original return without duplicate transfer events')
assert.equal(seed.count('SaleReturn', '1=1'), childReturnCountBefore + 1)
assert.equal(childCarryReturn.total, 1_000_000)
assert.equal(childCarryReturn.refundAmount, 0)
assert.equal(childCarryReturn.invoiceOverpaid, 0, 'non-cash child carry release must not create OVERPAY')
const childInvoiceAfterOneReturn = await invoiceRemaining(db, childExchange.exchangeInvoiceId, 15_000_000, 15_000_000)
assert.equal(childInvoiceAfterOneReturn.refundFromReceived, 1_000_000)
assert.equal(childInvoiceAfterOneReturn.overpaid, 0)
const childReturnReportRows = await salesService.returnList({ includeExchanges: true, take: 500 })
const childReturnReportRow = childReturnReportRows.find((row) => row.id === childCarryReturn.id)
assert.ok(childReturnReportRow, 'S1 child return is visible in the commercial returns report')
assert.equal(childReturnReportRow.refundMethod, 'NONE')
assert.equal(childReturnReportRow.refundAmount, 0)
assert.equal(childReturnReportRow.cashRefundAmount, 0)
assert.equal(childReturnReportRow.fundingAttribution.settlementReady, false,
  'report labels source attribution without misrepresenting it as a cash entitlement')
assert.deepEqual(childReturnReportRow.fundingAttribution.sources.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_CASH', amount: 874_844 },
  { sourceKind: 'SOURCE_GIFT', amount: 125_156 }
])
assert.equal(seed.count('SaleReturn', '1=1'), childReturnCountBefore + 1)
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryReturn.id, 'RETURN_TRANSFER_OUT'), 2)
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryReturn.id, 'RETURN_TRANSFER_IN'), 2)
assert.equal(seed.count('CashMovement', '1=1'), 0, 'child carry release never emits cash movements')
assert.equal(seed.count('StoreCredit', 'returnId=?', childCarryReturn.id), 0,
  'child carry release does not issue public credit')
assert.equal(seed.count('CreditReturnAllocation', 'returnId=?', childCarryReturn.id), 0)
let sourceAfterOneChildReturn = await invoiceRemaining(db, childSourceSale.id, 15_980_000, 15_980_000)
assert.equal(sourceAfterOneChildReturn.refundFromReceived, 1_000_000,
  'non-cash carry release offsets parent net-received by the same amount')
assert.equal(sourceAfterOneChildReturn.overpaid, 0,
  'a child carry return must not create source-invoice OVERPAY')
let releasedParentFunding = await getCurrentSaleFundingSources(db, childSourceSale.id)
assert.equal(releasedParentFunding.unresolved.length, 0)
assert.deepEqual(releasedParentFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 1_732_190 },
  { sourceKind: 'SOURCE_GIFT', available: 247_810 }
])
let reducedChildFunding = await getCurrentExchangeFundingSources(db, childExchange.exchangeInvoiceId,
  { allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true })
assert.equal(reducedChildFunding.unresolved.length, 0)
assert.deepEqual(reducedChildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 1_752_190 },
  { sourceKind: 'SOURCE_CASH', available: 12_247_810 }
])
const remainderPreview = await salesService.returnProvenancePreview({
  invoiceId: childExchange.exchangeInvoiceId, lines: [{ saleItemId: childItem.id, qty: 14_000 }]
})
assert.equal(remainderPreview.returnTotal, 14_000_000)
assert.deepEqual(remainderPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 1_752_190 },
  { sourceKind: 'SOURCE_CASH', amount: 12_247_810 }
], 'the cumulative 1M + 14M split is exact and complementary')
const childCarryRemainderReturn = await salesService.createReturn({
  invoiceId: childExchange.exchangeInvoiceId, lines: [{ saleItemId: childItem.id, qty: 14_000 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  note: 'S1 exact remaining carry return'
}, { goodsReceiptRequired: false })
assert.equal(childCarryRemainderReturn.total, 14_000_000)
assert.equal(childCarryRemainderReturn.invoiceOverpaid, 0)
const childInvoiceAfterFullReturn = await invoiceRemaining(db, childExchange.exchangeInvoiceId, 15_000_000, 15_000_000)
assert.equal(childInvoiceAfterFullReturn.refundFromReceived, 15_000_000)
assert.equal(childInvoiceAfterFullReturn.overpaid, 0)
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryRemainderReturn.id, 'RETURN_TRANSFER_OUT'), 2)
releasedParentFunding = await getCurrentSaleFundingSources(db, childSourceSale.id)
assert.deepEqual(releasedParentFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_980_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
], '1M + 14M restores all 15M of carry to original root shares')
const sourceAfterFullChildReturn = await invoiceRemaining(db, childSourceSale.id, 15_980_000, 15_980_000)
assert.equal(sourceAfterFullChildReturn.refundFromReceived, 15_000_000)
assert.equal(sourceAfterFullChildReturn.overpaid, 0,
  'full child carry release leaves the residual 980K covered by the original source')
reducedChildFunding = await getCurrentExchangeFundingSources(db, childExchange.exchangeInvoiceId,
  { allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true })
assert.equal(reducedChildFunding.unresolved.length, 0)
assert.deepEqual(reducedChildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 0 },
  { sourceKind: 'SOURCE_CASH', available: 0 }
])
const remainderVoid = await salesService.returnDelete({ id: childCarryRemainderReturn.id, userId,
  reason: 'S1 remainder carry void before use', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(remainderVoid.voided, true,
  'full-item return reversal is safe even though the child share has reached zero')
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryRemainderReturn.id, 'VOID_RETURN_TRANSFER_OUT'), 2)
releasedParentFunding = await getCurrentSaleFundingSources(db, childSourceSale.id)
assert.deepEqual(releasedParentFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 1_732_190 },
  { sourceKind: 'SOURCE_GIFT', available: 247_810 }
])
const childCarryVoid = await salesService.returnDelete({ id: childCarryReturn.id, userId,
  reason: 'S1 child carry returned before use', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(childCarryVoid.voided, true)
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryReturn.id, 'VOID_RETURN_TRANSFER_OUT'), 2)
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryReturn.id, 'VOID_RETURN_TRANSFER_IN'), 2)
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnId=? AND eventKind=?',
  childCarryReturn.id, 'REVERSAL'), 2)
releasedParentFunding = await getCurrentSaleFundingSources(db, childSourceSale.id)
assert.deepEqual(releasedParentFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 857_346 },
  { sourceKind: 'SOURCE_GIFT', available: 122_654 }
])
reducedChildFunding = await getCurrentExchangeFundingSources(db, childExchange.exchangeInvoiceId)
assert.equal(reducedChildFunding.unresolved.length, 0)
assert.deepEqual(reducedChildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 1_877_346 },
  { sourceKind: 'SOURCE_CASH', available: 13_122_654 }
])
const childInvoiceAfterReturnVoids = await invoiceRemaining(db, childExchange.exchangeInvoiceId, 15_000_000, 15_000_000)
assert.equal(childInvoiceAfterReturnVoids.refundFromReceived, 0)
assert.equal(childInvoiceAfterReturnVoids.overpaid, 0)
const sourceAfterChildReturnVoids = await invoiceRemaining(db, childSourceSale.id, 15_980_000, 15_980_000)
assert.equal(sourceAfterChildReturnVoids.refundFromReceived, 0)
assert.equal(sourceAfterChildReturnVoids.overpaid, 0,
  'voiding the child returns reverses parent debt adjustments together with carry events')

const consumedGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 child-return consumed-void fixture', userId
}))
const consumedSourceVariant = variant('S1-CHILD-CONSUMED-SOURCE', 15_980_000)
const consumedReplacementVariant = variant('S1-CHILD-CONSUMED-REPLACEMENT', 1_000)
sql.prepare('UPDATE "ProductVariant" SET stock=20000 WHERE id=?').run(consumedReplacementVariant)
const consumedSourceSale = await salesService.create({
  userId, shiftId, lines: [item(consumedSourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: consumedGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-child-consumed-gift-redemption-0001'
})
const consumedSourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', consumedSourceSale.id)
const consumedExchange = await salesService.createExchange({
  invoiceId: consumedSourceSale.id, lines: [{ saleItemId: consumedSourceItem.id, qty: 1 }],
  replacements: [{ variantId: consumedReplacementVariant, qty: 15_000,
    unitPrice: 1_000, discount: 0, tax: 0 }], userId, shiftId,
  refundMode: 'S1_RESIDUAL_RIGHTS', goodsReceiptRequired: false,
  idempotencyKey: 's1-child-consumed-exchange-0001'
})
const consumedChildItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', consumedExchange.exchangeInvoiceId)
const childCarryReturnForConsumedVoid = await salesService.createReturn({
  invoiceId: consumedExchange.exchangeInvoiceId,
  lines: [{ saleItemId: consumedChildItem.id, qty: 1_000 }],
  refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
  note: 'S1 child return carry-consumption void gate'
}, { goodsReceiptRequired: false })
const consumedParentFunding = await getCurrentSaleFundingSources(db, consumedSourceSale.id)
const parentCashRoot = consumedParentFunding.sources.find((source) => source.sourceKind === 'SOURCE_CASH').event
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `s1-child-return-consume:${childCarryReturnForConsumedVoid.id}`,
  sourceEventId: Number(parentCashRoot.id), sourceShareId: String(parentCashRoot.shareId),
  rootShareId: String(parentCashRoot.rootShareId), destinationShareId: `consumed-child-carry:${consumedExchange.exchangeInvoiceId}`,
  sourceInvoiceId: consumedSourceSale.id, childInvoiceId: consumedExchange.exchangeInvoiceId,
  returnId: consumedExchange.returnId, amount: 900_000, actorUserId: userId,
  evidenceRef: `S1 test downstream consumption after return ${childCarryReturnForConsumedVoid.id}`
}))
const transferOutCountBeforeConsumedVoid = seed.count('ExchangeFundingEvent',
  'relatedReturnId=? AND kind=?', childCarryReturnForConsumedVoid.id, 'VOID_RETURN_TRANSFER_OUT')
await assert.rejects(() => salesService.returnDelete({ id: childCarryReturnForConsumedVoid.id, userId,
  reason: 'S1 carry already consumed after child return', panelPassword: DEFAULT_MANAGER_PASSWORD }),
  /carry برگشتی پس از برگشت مصرف/u,
  'a child return must not be voided after returned carry was consumed downstream')
assert.equal(seed.count('SaleReturn', 'id=? AND voidedAt IS NULL', childCarryReturnForConsumedVoid.id), 1,
  'failed consumed-carry void rolls back the return status')
assert.equal(seed.count('ExchangeFundingEvent', 'relatedReturnId=? AND kind=?',
  childCarryReturnForConsumedVoid.id, 'VOID_RETURN_TRANSFER_OUT'), transferOutCountBeforeConsumedVoid,
  'failed consumed-carry void appends no partial reversal pair')
assert.equal(seed.count('CashMovement', '1=1'), 0)
console.log('✓ S1/S6 production integration: exact gift/cash carry and B/N; expired B rejected; N witnessed and consumed after root expiry; same-code return, safe void-before-use/re-return and reject-after-spend; child carry 1M+14M release and LIFO void; no cash, public credit or OVERPAY')
