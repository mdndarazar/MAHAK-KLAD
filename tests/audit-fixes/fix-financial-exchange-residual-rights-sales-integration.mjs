/** Accepted S1 production flow: cash-first carry, one non-cash successor barcode,
 * exact root expiry, idempotent retry, delivery/spend, and original USED barcode stays USED.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-residual-rights-sales-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s1-cash-first-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources, exchangeFundingBalance } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S1 cash-first operator')
const categoryId = seed.category('S1 cash-first category')
const productId = seed.product('S1 cash-first product', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'S1 cash-first shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const variant = (code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=? WHERE id=?').run(price, id)
  return id
}
const sourceVariant = variant('S1-CASH-FIRST-SOURCE', 15_980_000)
const replacementVariant = variant('S1-CASH-FIRST-REPLACEMENT', 15_000_000)
const redemptionVariant = variant('S1-CASH-FIRST-REDEEM', 980_000)
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 original gift root', userId
}))
const sale = await salesService.create({
  userId, shiftId, lines: [item(sourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-cash-first-original-redemption-0001'
})
assert.equal(sale.grandTotal, 15_980_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
const rootExpiry = seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', gift.id).expiresAt
const before = await getCurrentSaleFundingSources(db, sale.id)
assert.deepEqual(before.unresolved, [])
assert.deepEqual(before.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_980_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
const request = {
  invoiceId: sale.id, lines: [{ saleItemId: sourceItem.id, qty: 1 }],
  replacements: [item(replacementVariant, 15_000_000)], refundMode: 'S1_RESIDUAL_RIGHTS',
  userId, shiftId, goodsReceiptRequired: false, idempotencyKey: 's1-cash-first-single-credit-0001'
}
await assert.rejects(() => salesService.createExchange({ ...request, refundMode: 'CASH',
  idempotencyKey: 's1-cash-first-must-not-downgrade-0001' }), /واجد S1/u,
  'a qualifying S1 down-exchange cannot silently become an ordinary cash refund')
assert.equal(seed.count('SaleReturn', 'invoiceId=?', sale.id), 0,
  'the rejected settlement choice has no side effects')

const exchange = await salesService.createExchange(request)
assert.deepEqual([exchange.returnTotal, exchange.exchangeTotal, exchange.diff, exchange.settlement],
  [15_980_000, 15_000_000, -980_000, 'S1_RESIDUAL_RIGHTS'])
assert.equal(exchange.storeCredit.amount, 980_000)
assert.equal(exchange.storeCredit.source, 'EXCHANGE')
assert.equal(exchange.storeCredit.status, 'DRAFT')
assert.equal(exchange.storeCredit.expiresAtJalali, seed.one('SELECT expiresAtJalali FROM "StoreCredit" WHERE id=?', gift.id).expiresAtJalali)
assert.equal(exchange.residualRights, null, 'S1 creates no B/N split')
assert.equal(seed.count('ExchangeResidualRightEvent', `returnId=${exchange.returnId} AND eventKind='OPENED'`), 0)
assert.equal(seed.one('SELECT code, amount, status, exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', exchange.storeCredit.id).amount,
  980_000)
assert.equal(seed.one('SELECT exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', exchange.storeCredit.id).exchangeResidualRightKey, null,
  'the successor is an ordinary non-cash barcode, not a B/N right credential')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'the fully consumed original barcode is never reactivated')
const returnAllocation = seed.one('SELECT parentCreditId, rootCreditId, amount, originalExpiresAt, successorCreditId FROM "CreditReturnAllocation" WHERE successorCreditId=?',
  exchange.storeCredit.id)
assert.deepEqual([returnAllocation.parentCreditId, returnAllocation.rootCreditId,
  returnAllocation.amount, returnAllocation.successorCreditId], [gift.id, gift.id, 980_000, exchange.storeCredit.id])
assert.equal(new Date(returnAllocation.originalExpiresAt).getTime(), new Date(rootExpiry).getTime())
const reissue = seed.one('SELECT kind, amount, sourceCreditId, evidenceKind, evidenceRef FROM "ExchangeFundingEvent" WHERE returnId=? AND kind=?',
  exchange.returnId, 'CREDIT_REISSUE_OUT')
assert.deepEqual([reissue.kind, reissue.amount, reissue.sourceCreditId, reissue.evidenceKind,
  reissue.evidenceRef], ['CREDIT_REISSUE_OUT', -980_000, gift.id, 'CREDIT_BARCODE_ISSUED',
    `StoreCredit:${exchange.storeCredit.id}`])
assert.equal(await exchangeFundingBalance(db, String(before.sources.find((source) => source.sourceKind === 'SOURCE_GIFT').event.shareId)), 0)
const child = await getCurrentExchangeFundingSources(db, exchange.exchangeInvoiceId)
assert.deepEqual(child.unresolved, [])
assert.deepEqual(child.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_980_000 },
  { sourceKind: 'SOURCE_GIFT', available: 1_020_000 }
])
assert.equal(seed.count('CashMovement', '1=1'), 0, 'the non-cash successor creates no cash movement')

const counts = {
  returns: seed.count('SaleReturn', 'invoiceId=?', sale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sale.id),
  reissues: seed.count('ExchangeFundingEvent', `returnId=${exchange.returnId} AND kind='CREDIT_REISSUE_OUT'`),
  allocations: seed.count('CreditReturnAllocation', `returnId=${exchange.returnId}`),
  credits: seed.count('StoreCredit', '1=1')
}
const replay = await salesService.createExchange(request)
assert.equal(replay.replayed, true)
assert.deepEqual({
  returns: seed.count('SaleReturn', 'invoiceId=?', sale.id),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sale.id),
  reissues: seed.count('ExchangeFundingEvent', `returnId=${exchange.returnId} AND kind='CREDIT_REISSUE_OUT'`),
  allocations: seed.count('CreditReturnAllocation', `returnId=${exchange.returnId}`),
  credits: seed.count('StoreCredit', '1=1')
}, counts, 'retry replays exactly one return, child, successor barcode and funding debit')

const handoff = await confirmCreditDelivery({ creditId: exchange.storeCredit.id,
  witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'S1 successor barcode handed to customer',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
assert.equal(handoff.status, 'DELIVERED')
const purchase = await salesService.create({ userId, shiftId, lines: [item(redemptionVariant, 980_000)],
  payments: [], storeCreditCode: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', exchange.storeCredit.id).code,
  storeCreditAmount: 980_000, storeCreditIdempotencyKey: 's1-successor-barcode-redemption-0001' })
assert.equal(purchase.storeCreditApplied, 980_000)
assert.equal(seed.one('SELECT status, usedAmount FROM "StoreCredit" WHERE id=?', exchange.storeCredit.id).status, 'USED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'consuming the successor never changes the original fully used barcode')

const unrelated = await salesService.create({ userId, shiftId,
  lines: [item(variant('S1-UNRELATED-PURCHASE', 100_000), 100_000)],
  payments: [{ methodId: cashMethodId, amount: 100_000, destination: 'CASH' }] })
assert.equal(unrelated.grandTotal, 100_000,
  'the separate ordinary purchase path remains available')

// A second, still-undelivered successor is safely canceled with an exact
// funding-journal inverse. The original consumed barcode remains USED.
const voidGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S1 void root gift', userId
}))
const voidSourceVariant = variant('S1-VOID-SOURCE', 15_980_000)
const voidReplacementVariant = variant('S1-VOID-REPLACEMENT', 15_000_000)
const voidSale = await salesService.create({ userId, shiftId, lines: [item(voidSourceVariant, 15_980_000)],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: voidGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's1-void-root-redemption-0001' })
const voidSaleItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', voidSale.id)
const voidExchange = await salesService.createExchange({ invoiceId: voidSale.id,
  lines: [{ saleItemId: voidSaleItem.id, qty: 1 }],
  replacements: [item(voidReplacementVariant, 15_000_000)], refundMode: 'S1_RESIDUAL_RIGHTS',
  userId, shiftId, goodsReceiptRequired: false, idempotencyKey: 's1-void-residual-credit-0001' })
const voidResult = await salesService.returnDelete({ id: voidExchange.returnId, userId,
  reason: 'S1 unused successor barcode cancellation', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(voidResult.voided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', voidExchange.storeCredit.id).status, 'CANCELED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', voidGift.id).status, 'USED')
assert.equal(seed.one('SELECT kind, amount FROM "ExchangeFundingEvent" WHERE returnId=? AND kind=?',
  voidExchange.returnId, 'VOID_CREDIT_REISSUE_OUT').amount, 980_000)
assert.equal(seed.count('ExchangeFundingEvent', `returnId=${voidExchange.returnId} AND reversesEventId IS NOT NULL`), 5,
  'the residual issue and both carry-transfer sides are reversed exactly once')
const restored = await getCurrentSaleFundingSources(db, voidSale.id)
assert.deepEqual(restored.unresolved, [])
assert.equal(restored.sources.reduce((sum, source) => sum + source.available, 0), 15_980_000,
  'the original source funding is restored atomically after voiding the exchange')

console.log('✓ S1 integration: 13.98M real money + 2M gift → 13.98M cash carry + 1.02M gift carry + one 980K non-cash successor; exact expiry, retry, delivery/spend, original USED status, and unused-credit reversal verified')
