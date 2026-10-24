/** Four full child exchanges with non-zero price deltas and rooted gift-first carry.
 * A(15M = 13M cash + 2M one-use gift) -> B(15M) -> C(14M) -> D(16M) -> E(1M) -> F(1M).
 * Checks source lineage, actual cash, barcode delivery/use, idempotency, stock and return-code lookup.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-chained-price-deltas.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-chain-deltas-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources, exchangeFundingBalance } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { confirmCreditDelivery, viewReturnEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('Chained price delta integration')
const categoryId = seed.category('Chained price delta category')
const productId = seed.product('Chained price delta product', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'Chained price delta shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantSeq = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `CHAIN-DELTA-${label}-${++variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=40, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const stock = (variantId) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const assertStock = (ids, expected, message) => assert.deepEqual(ids.map(stock), expected, message)
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })
const blue0 = await physicalMovementForCustodyShift(shiftId)

const rootGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'single-use rooted gift for chained exchange', userId
}))
const [aVariant, bVariant, cVariant, dVariant, eVariant, fVariant, partial400Variant, partial600Variant] = [
  ['A', 15_000_000], ['B', 15_000_000], ['C', 14_000_000], ['D', 16_000_000],
  ['E', 1_000_000], ['F', 1_000_000], ['partial-400', 400_000], ['partial-600', 600_000]
].map(([name, price]) => variant(name, Number(price)))

const a = await salesService.create({
  userId, shiftId, lines: [line(aVariant, 15_000_000)],
  payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: rootGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 'chain-delta-root-gift-sale-0001'
})
assert.equal(a.grandTotal, 15_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 13_000_000,
  'only the actual cash part of the root sale enters the blue reference')
const aFunding = await getCurrentSaleFundingSources(db, a.id)
assert.deepEqual(aFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const aItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', a.id)
const creditCountBeforeExchanges = seed.count('StoreCredit', '1=1')

// 1) A -> B, equal value: preserve both proven sources; do not mint a barcode.
const b = await exchange({
  invoiceId: a.id, lines: [{ saleItemId: aItem.id, qty: 1 }],
  replacements: [line(bVariant, 15_000_000)], userId, shiftId,
  idempotencyKey: 'chain-delta-A-to-B-equal-0001'
})
assert.deepEqual([b.returnTotal, b.exchangeTotal, b.diff], [15_000_000, 15_000_000, 0])
assert.equal(seed.count('StoreCredit', '1=1'), creditCountBeforeExchanges)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootGift.id).status, 'USED')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 13_000_000)
assertStock([aVariant, bVariant], [40, 39], 'A returns immediately and B is immediately deducted')
const bFunding = await getCurrentExchangeFundingSources(db, b.exchangeInvoiceId)
assert.deepEqual(bFunding.unresolved, [])
assert.equal(bFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(bFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const bItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', b.exchangeInvoiceId)

// 2) B -> C, cheaper by 1M: carry the 2M rooted credit first, refund exactly 1M real cash.
const c = await exchange({
  invoiceId: b.exchangeInvoiceId, lines: [{ saleItemId: bItem.id, qty: 1 }],
  replacements: [line(cVariant, 14_000_000)], refundMode: 'CASH', userId, shiftId,
  idempotencyKey: 'chain-delta-B-to-C-cheaper-cash-0001'
})
assert.deepEqual([c.returnTotal, c.exchangeTotal, c.diff, c.cashRefunded],
  [15_000_000, 14_000_000, -1_000_000, 1_000_000])
assert.equal(c.settlement, 'CASH_REFUND')
assert.equal(seed.count('StoreCredit', '1=1'), creditCountBeforeExchanges,
  'the gift share is fully used in C; no duplicate gift code is created')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 12_000_000,
  'only the 1M real-money remainder leaves the drawer')
assertStock([bVariant, cVariant], [40, 39], 'B returns immediately and C is immediately deducted')
const cFunding = await getCurrentExchangeFundingSources(db, c.exchangeInvoiceId)
assert.deepEqual(cFunding.unresolved, [])
assert.equal(cFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(cFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 12_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const cItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', c.exchangeInvoiceId)

// 3) C -> D, more expensive by 2M: carry all old provenance and receive only the real delta.
const d = await exchange({
  invoiceId: c.exchangeInvoiceId, lines: [{ saleItemId: cItem.id, qty: 1 }],
  replacements: [line(dVariant, 16_000_000)],
  payments: [{ methodId: cashMethodId, amount: 2_000_000, destination: 'CASH' }],
  userId, shiftId, idempotencyKey: 'chain-delta-C-to-D-pricier-cash-0001'
})
assert.deepEqual([d.returnTotal, d.exchangeTotal, d.diff, d.cashReceived],
  [14_000_000, 16_000_000, 2_000_000, 2_000_000])
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 14_000_000,
  'the additional 2M cash tender enters blue; carried credit does not')
assertStock([cVariant, dVariant], [40, 39], 'C returns immediately and D is immediately deducted')
const dFunding = await getCurrentExchangeFundingSources(db, d.exchangeInvoiceId)
assert.deepEqual(dFunding.unresolved, [])
assert.equal(dFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(dFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 12_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 },
  { sourceKind: 'SOURCE_CASH', available: 2_000_000 }
], 'old cash carry and the new real tender remain as separate, proven source shares')
const dItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', d.exchangeInvoiceId)

// 4) D -> E, cheaper by 15M: gift residual 1M and real residual 14M stay separate.
const eRequest = {
  invoiceId: d.exchangeInvoiceId, lines: [{ saleItemId: dItem.id, qty: 1 }],
  replacements: [line(eVariant, 1_000_000)], refundMode: 'STORE_CREDIT',
  userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'customer selects non-cash credit for the proven real remainder',
  idempotencyKey: 'chain-delta-D-to-E-cheaper-split-credit-0001'
}
const e = await exchange(eRequest)
assert.deepEqual([e.returnTotal, e.exchangeTotal, e.diff], [16_000_000, 1_000_000, -15_000_000])
assert.equal(e.settlement, 'CREDIT')
assert.equal(e.creditHandoffRequired, true)
assert.equal(e.storeCredits.reduce((sum, row) => sum + Number(row.amount), 0), 15_000_000,
  'the exact remainder is represented by 1M rooted credit plus 14M real-money credit')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 14_000_000,
  'returning the real remainder as non-cash credit creates no drawer movement')
assertStock([dVariant, eVariant], [40, 39], 'D returns immediately and E is immediately deducted')
const eReplay = await exchange(eRequest)
assert.equal(eReplay.replayed, true)
assert.equal(eReplay.returnId, e.returnId)
assert.equal(seed.count('StoreCredit', '1=1'), creditCountBeforeExchanges + 2,
  'one rooted successor and one separate real-money credit are created; retry creates neither again')
const giftSuccessor = seed.one(`SELECT sc.* FROM "StoreCredit" sc JOIN "CreditReturnAllocation" a
  ON a.successorCreditId=sc.id WHERE a.returnId=?`, e.returnId)
const realCredit = seed.one(`SELECT * FROM "StoreCredit" WHERE returnId=? AND id<>? ORDER BY id DESC LIMIT 1`,
  e.returnId, giftSuccessor.id)
assert.equal(Number(giftSuccessor.amount), 1_000_000)
assert.equal(giftSuccessor.status, 'DRAFT')
assert.equal(giftSuccessor.multiUse, 1, 'a returned balance is reusable until exhausted, even if the root code was one-use')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootGift.id).status, 'USED',
  'the original consumed barcode never becomes reusable')
assert.deepEqual(seed.rows('SELECT sourceKind, status FROM "CreditDelivery" WHERE creditId IN (?,?) ORDER BY sourceKind',
  giftSuccessor.id, realCredit.id), [
  { sourceKind: 'CHAIN_GIFT_RESIDUAL', status: 'PENDING_DELIVERY' },
  { sourceKind: 'CHAIN_REAL_REFUND', status: 'PENDING_DELIVERY' }
])
assert.equal(Number(realCredit.amount), 14_000_000)
assert.equal(realCredit.status, 'DRAFT')
assert.equal(Number(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', e.returnId).creditRestored), 1_000_000)
assert.equal(Number(seed.one('SELECT realMoneyRefundAmount FROM "SaleReturn" WHERE id=?', e.returnId).realMoneyRefundAmount), 14_000_000)
assert.equal(Number(seed.one('SELECT refundAmount FROM "SaleReturn" WHERE id=?', e.returnId).refundAmount), 14_000_000)
assert.equal(seed.one('SELECT refundMethod FROM "SaleReturn" WHERE id=?', e.returnId).refundMethod, 'STORE_CREDIT')
const eFunding = await getCurrentExchangeFundingSources(db, e.exchangeInvoiceId)
assert.deepEqual(eFunding.unresolved, [])
assert.deepEqual(eFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 1_000_000 }
])
const dRemaining = await getCurrentExchangeFundingSources(db, d.exchangeInvoiceId, { allowReturnBalanceChanges: true })
assert.deepEqual(dRemaining.unresolved, [])
assert.equal(dRemaining.sources.find((row) => row.sourceKind === 'SOURCE_GIFT').available, 0,
  'the unused gift part is debited into one rooted successor, never left spendable on D')
assert.equal(dRemaining.sources.filter((row) => row.sourceKind === 'SOURCE_CASH')
  .reduce((sum, row) => sum + row.available, 0), 14_000_000,
  'the real-money remainder is separate and equals the selected 14M credit return')
assert.equal(await exchangeFundingBalance(db,
  String(dFunding.sources.find((row) => row.sourceKind === 'SOURCE_GIFT').event.shareId)), 0)

// D's successor codes are not usable until individually printed and handed over with a witness.
const prematurePurchase = {
  userId, shiftId, lines: [line(partial400Variant, 400_000)],
  storeCreditCode: giftSuccessor.code, storeCreditAmount: 400_000,
  storeCreditIdempotencyKey: 'chain-gift-successor-before-delivery-0001'
}
await assert.rejects(() => salesService.create(prematurePurchase), /پیش‌نویس|تحویل|فعال|قابل استفاده/u)
await assert.rejects(() => confirmCreditDelivery({ creditId: Number(giftSuccessor.id),
  witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'barcode handed to customer',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId }), /ابتدا بارکد را چاپ/u)
await storeCreditService.markPrinted({ id: Number(giftSuccessor.id), userId, channel: 'PRINT' })
await storeCreditService.markPrinted({ id: Number(realCredit.id), userId, channel: 'PRINT' })
assert.equal((await confirmCreditDelivery({ creditId: Number(giftSuccessor.id),
  witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'printed rooted barcode handed to customer',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })).status, 'DELIVERED')
assert.equal((await confirmCreditDelivery({ creditId: Number(realCredit.id),
  witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'printed real-money barcode handed to customer',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })).status, 'DELIVERED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftSuccessor.id).status, 'ACTIVE')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', realCredit.id).status, 'ACTIVE')

// The fourth exchange can be looked up by E's own receipt code, never by A's retained historical code.
const eLookup = await salesService.findByReturnCode(e.exchangeReturnCode)
assert.equal(eLookup.invoiceId, e.exchangeInvoiceId)
const eItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', eLookup.invoiceId)
const f = await exchange({
  invoiceId: eLookup.invoiceId, lines: [{ saleItemId: eItem.id, qty: 1 }],
  replacements: [line(fVariant, 1_000_000)], userId, shiftId,
  idempotencyKey: 'chain-delta-E-to-F-fourth-exchange-0001'
})
assert.deepEqual([f.returnTotal, f.exchangeTotal, f.diff], [1_000_000, 1_000_000, 0])
assert.equal(Number(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?', f.exchangeInvoiceId).sourceInvoiceId),
  e.exchangeInvoiceId, 'the fourth exchange records E as its immediate source')
assertStock([eVariant, fVariant], [40, 39], 'E returns immediately and the fourth replacement F is immediately deducted')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftSuccessor.id).status, 'ACTIVE',
  'the handed-off 1M successor remains separate while its source share travels E→F')
const fFunding = await getCurrentExchangeFundingSources(db, f.exchangeInvoiceId)
assert.deepEqual(fFunding.unresolved, [])
assert.deepEqual(fFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_GIFT', available: 1_000_000 }
])
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 14_000_000,
  'the equal fourth exchange adds no cash movement')

// The one-use root is spent; its returned successor is multi-use until its balance is exhausted.
const partial400 = await salesService.create({
  userId, shiftId, lines: [line(partial400Variant, 400_000)],
  storeCreditCode: giftSuccessor.code, storeCreditAmount: 400_000,
  storeCreditIdempotencyKey: 'chain-gift-successor-use-400k-0001'
})
assert.equal(partial400.grandTotal, 400_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftSuccessor.id).status, 'PARTIALLY_USED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', giftSuccessor.id).usedAmount), 400_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 14_000_000,
  'redeeming a barcode is non-cash and does not change blue')
const partial600 = await salesService.create({
  userId, shiftId, lines: [line(partial600Variant, 600_000)],
  storeCreditCode: giftSuccessor.code, storeCreditAmount: 600_000,
  storeCreditIdempotencyKey: 'chain-gift-successor-use-600k-0001'
})
assert.equal(partial600.grandTotal, 600_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftSuccessor.id).status, 'USED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', giftSuccessor.id).usedAmount), 1_000_000)
await assert.rejects(() => salesService.create({
  userId, shiftId, lines: [line(partial400Variant, 100_000)],
  storeCreditCode: giftSuccessor.code, storeCreditAmount: 100_000,
  storeCreditIdempotencyKey: 'chain-gift-successor-extra-use-0001'
}), /مانده|مصرف|استفاده|قابل/u)
await assert.rejects(() => salesService.create({
  userId, shiftId, lines: [line(partial400Variant, 100_000)],
  storeCreditCode: rootGift.code, storeCreditAmount: 100_000,
  storeCreditIdempotencyKey: 'chain-original-gift-reuse-0001'
}), /مانده|مصرف|استفاده|قابل/u)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blue0, 14_000_000)

// C2C on a full child return is a pending manager obligation: neither request nor payment changes blue.
const c2cGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'C2C chain rooted gift', userId
}))
const [c2cA, c2cB, c2cC] = [
  ['c2c-A', 15_000_000], ['c2c-B', 15_000_000], ['c2c-C', 14_000_000]
].map(([name, price]) => variant(name, Number(price)))
const c2cBlueStart = await physicalMovementForCustodyShift(shiftId)
const c2cRoot = await salesService.create({
  userId, shiftId, lines: [line(c2cA, 15_000_000)],
  payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: c2cGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 'chain-c2c-root-sale-0001'
})
const c2cRootItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', c2cRoot.id)
const c2cBInvoice = await exchange({
  invoiceId: c2cRoot.id, lines: [{ saleItemId: c2cRootItem.id, qty: 1 }],
  replacements: [line(c2cB, 15_000_000)], userId, shiftId,
  idempotencyKey: 'chain-c2c-A-to-B-equal-0001'
})
const c2cBItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', c2cBInvoice.exchangeInvoiceId)
const c2cChild = await exchange({
  invoiceId: c2cBInvoice.exchangeInvoiceId, lines: [{ saleItemId: c2cBItem.id, qty: 1 }],
  replacements: [line(c2cC, 14_000_000)], refundMode: 'CARD_TO_CARD', userId, shiftId,
  idempotencyKey: 'chain-c2c-B-to-C-cheaper-0001'
})
assert.equal(c2cChild.cardToCard, 1_000_000)
assert.equal(c2cChild.cardTransfer.status, 'PENDING')
assert.equal(c2cChild.restockPending, true)
assert.equal(c2cChild.pendingRestockQty, 1)
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', c2cChild.cardTransfer.id).status, 'PENDING')
assert.equal((await viewReturnEntitlement(c2cChild.returnId)).cashReserved, 1_000_000)
assert.equal(stock(c2cB), 39, 'the returned C2C item stays unavailable while the manager payment is pending')
assert.equal(stock(c2cC), 39, 'the replacement is deducted immediately')
assert.equal(await physicalMovementForCustodyShift(shiftId) - c2cBlueStart, 13_000_000,
  'the root cash enters blue, but requesting the manager transfer does not move it')
const managerPayment = await cardTransferService.pay({ id: c2cChild.cardTransfer.id,
  paidAmount: 1_000_000, managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
assert.equal(managerPayment.releasedQty, 1)
assert.equal(managerPayment.stockStillPending, false)
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', c2cChild.cardTransfer.id).status, 'PAID')
assert.equal(stock(c2cB), 40, 'only manager confirmation releases the returned C2C item')
assert.equal(stock(c2cC), 39, 'manager payment never restores the replacement item')
assert.equal(await physicalMovementForCustodyShift(shiftId) - c2cBlueStart, 13_000_000,
  'manager C2C confirmation and stock release do not change blue')
assert.equal(seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', c2cChild.returnId), 0,
  'C2C request/payment creates no cash drawer movement')

// The difference between gift and real-money residuals must stay split: gift gets a rooted successor barcode,
// while only the real 1M remainder becomes the manager's C2C request.
const splitGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 14_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'mixed residual C2C gift root', userId
}))
const [splitA, splitB, splitC] = [
  ['split-c2c-A', 15_000_000], ['split-c2c-B', 15_000_000], ['split-c2c-C', 12_000_000]
].map(([name, price]) => variant(name, Number(price)))
const splitBlueStart = await physicalMovementForCustodyShift(shiftId)
const splitRoot = await salesService.create({
  userId, shiftId, lines: [line(splitA, 15_000_000)],
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
  storeCreditCode: splitGift.code, storeCreditAmount: 14_000_000,
  storeCreditIdempotencyKey: 'chain-split-c2c-root-sale-0001'
})
const splitRootItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', splitRoot.id)
const splitBInvoice = await exchange({
  invoiceId: splitRoot.id, lines: [{ saleItemId: splitRootItem.id, qty: 1 }],
  replacements: [line(splitB, 15_000_000)], userId, shiftId,
  idempotencyKey: 'chain-split-c2c-A-to-B-equal-0001'
})
const splitBItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', splitBInvoice.exchangeInvoiceId)
const splitChild = await exchange({
  invoiceId: splitBInvoice.exchangeInvoiceId, lines: [{ saleItemId: splitBItem.id, qty: 1 }],
  replacements: [line(splitC, 12_000_000)], refundMode: 'CARD_TO_CARD', userId, shiftId,
  idempotencyKey: 'chain-split-c2c-B-to-C-cheaper-0001'
})
assert.equal(splitChild.cardToCard, 1_000_000, 'only the real-money remainder is payable by manager')
const splitReturnRow = seed.one('SELECT refundAmount, creditRestored FROM "SaleReturn" WHERE id=?', splitChild.returnId)
assert.equal(splitReturnRow.refundAmount, 1_000_000)
assert.equal(splitReturnRow.creditRestored, 2_000_000, 'the rooted gift remainder stays a separate non-cash right')
assert.equal(seed.one('SELECT amount FROM "CardTransferRequest" WHERE id=?', splitChild.cardTransfer.id).amount, 1_000_000)
assert.equal((await viewReturnEntitlement(splitChild.returnId)).cashReserved, 1_000_000)
const successorGift = splitChild.storeCredits.find((row) => row.id !== splitGift.id && row.amount === 2_000_000)
assert.ok(successorGift, 'gift residual is represented by a separate 2M successor barcode')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', successorGift.id).status, 'DRAFT')
assert.equal(stock(splitB), 39)
assert.equal(stock(splitC), 39)
assert.equal(await physicalMovementForCustodyShift(shiftId) - splitBlueStart, 1_000_000,
  'only the original 1M cash tender enters blue; C2C request adds nothing')
const splitManagerPayment = await cardTransferService.pay({ id: splitChild.cardTransfer.id,
  paidAmount: 1_000_000, managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
assert.equal(splitManagerPayment.releasedQty, 1)
assert.equal(stock(splitB), 40)
assert.equal(stock(splitC), 39)
assert.equal(await physicalMovementForCustodyShift(shiftId) - splitBlueStart, 1_000_000,
  'manager payment does not change blue while the 2M successor remains non-cash')
assert.equal(seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', splitChild.returnId), 0)
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', splitGift.id).usedAmount, 14_000_000,
  'the consumed root barcode remains consumed; the successor has a new identity')
console.log('✓ four chained exchanges: rooted gift-first carry, -1M cash payout, +2M cash tender, -15M split non-cash return, printed/witnessed successor barcodes, DRAFT/ACTIVE/SPENT states, fourth exchange from E, exact stock and blue invariants')
console.log('✓ full child C2C: real 1M entitlement reserved; stock pending until manager payment; neither request nor payment changes blue or CashMovement')
console.log('✓ mixed gift/real C2C: 2M rooted gift remains a DRAFT successor barcode; only 1M real remainder is manager payable; exact stock/blue')
