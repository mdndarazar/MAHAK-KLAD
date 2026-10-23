/** S3 integration: mixed-source root -> child exchange -> grandchild exchange.
 * Verifies current-balance-only transfer, root lineage, no duplicate tender/credit,
 * fail-closed reuse, and safe reverse-order void of the chain.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s3-chained-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s3-chain-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const {
  exchangeFundingBalance, getCurrentSaleFundingSources, getCurrentExchangeFundingSources
} = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S3 chained exchange integration')
const categoryId = seed.category('S3 chained exchange category')
const productId = seed.product('S3 chained exchange item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S3 chain shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantNo = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S3-${label}-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=30, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const stockOf = (variantId) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const assertStock = (variantIds, expected, message) => assert.deepEqual(
  variantIds.map(stockOf), expected, message
)
const assertNoSideEffectDelta = (before, message) => {
  assert.deepEqual({
    invoices: seed.count('SaleInvoice', '1=1'),
    returns: seed.count('SaleReturn', '1=1'),
    payments: seed.count('Payment', '1=1'),
    credits: seed.count('StoreCredit', '1=1'),
    events: seed.count('ExchangeFundingEvent', '1=1'),
    cashMovements: seed.count('CashMovement', '1=1'),
    stock: seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id')
  }, before, message)
}
const sideEffects = () => ({
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  credits: seed.count('StoreCredit', '1=1'),
  events: seed.count('ExchangeFundingEvent', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id')
})

const rootGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 60, note: 'S3 root gift funding', userId
}))
const rootPrices = [7_500_000, 7_500_000]
const rootVariants = rootPrices.map((price, i) => variant(`root-${i}`, price))
const firstChildVariants = rootPrices.map((price, i) => variant(`child-${i}`, price))
const grandchildVariants = rootPrices.map((price, i) => variant(`grandchild-${i}`, price))
const overValueNestedVariant = variant('over-value', 15_000_001)
const underValueNestedVariant = variant('under-value', 14_999_999)
const blueBeforeRootSale = await physicalMovementForCustodyShift(shiftId)
const rootSale = await salesService.create({
  userId, shiftId,
  lines: rootVariants.map((variantId, i) => line(variantId, rootPrices[i])),
  payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: rootGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's3-root-mixed-funding-0001'
})
assert.equal(rootSale.grandTotal, 15_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeRootSale, 13_000_000,
  'only the actual 13M cash tender from the root sale moves the physical/blue reference')
assertStock(rootVariants, [29, 29], 'the root sale removes one of each original item from stock')
const rootFunding = await getCurrentSaleFundingSources(db, rootSale.id)
assert.deepEqual(rootFunding.unresolved, [])
assert.deepEqual(rootFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const rootItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootSale.id)

const firstRequest = {
  invoiceId: rootSale.id,
  lines: rootItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  replacements: firstChildVariants.map((variantId, i) => line(variantId, rootPrices[i])),
  refundMode: 'STORE_CREDIT', userId, shiftId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'S3 root to child equal-value exchange',
  idempotencyKey: 'exchange-request:s3-root-to-child-0001'
}
const first = await salesService.createExchange(firstRequest, { goodsReceiptRequired: false })
assert.equal(first.diff, 0)
assert.equal(first.returnTotal, 15_000_000)
assert.equal(first.exchangeTotal, 15_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeRootSale, 13_000_000,
  'the equal-value root-to-child exchange does not change the blue reference')
assertStock(rootVariants, [30, 30], 'the returned original units restore root stock immediately')
assertStock(firstChildVariants, [29, 29], 'the replacement child units are immediately deducted')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootFunding.sources.find((s) => s.sourceKind === 'SOURCE_GIFT').event.sourceCreditId).status, 'USED')
assert.equal(seed.count('StoreCredit', '1=1'), 1, 'S3 chain creates no replacement public credit/barcode')
const firstChildFunding = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId)
assert.deepEqual(firstChildFunding.unresolved, [])
assert.equal(firstChildFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(firstChildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const firstChildItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', first.exchangeInvoiceId)
const firstRoots = new Map(firstChildFunding.sources.map((source) => [source.sourceKind, {
  shareId: String(source.event.shareId), rootShareId: String(source.event.rootShareId), eventId: Number(source.event.id)
}]))

const beforeSecond = sideEffects()
const secondRequest = {
  invoiceId: first.exchangeInvoiceId,
  lines: firstChildItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  replacements: grandchildVariants.map((variantId, i) => line(variantId, rootPrices[i])),
  refundMode: 'STORE_CREDIT', userId, shiftId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'S3 child to grandchild equal-value exchange',
  idempotencyKey: 'exchange-request:s3-child-to-grandchild-0001'
}
for (const [mismatchVariant, amount, key] of [
  [overValueNestedVariant, 15_000_001, 'exchange-request:s3-overvalue-mismatch-001'],
  [underValueNestedVariant, 14_999_999, 'exchange-request:s3-undervalue-mismatch-001']
]) {
  await assert.rejects(() => salesService.createExchange({
    ...secondRequest, replacements: [line(mismatchVariant, amount)], idempotencyKey: key
  }, { goodsReceiptRequired: false }), /تعویض زنجیره‌ای فقط وقتی مجاز است/u,
  'a nested price difference is not silently converted to an unproven tender or S1 residual right')
  assertNoSideEffectDelta(beforeSecond,
    'unsupported nested exchange difference rolls back return, replacement, stock, payment and ledger effects')
}
const second = await salesService.createExchange(secondRequest, { goodsReceiptRequired: false })
assert.equal(second.diff, 0)
assert.equal(second.returnTotal, 15_000_000)
assert.equal(second.exchangeTotal, 15_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeRootSale, 13_000_000,
  'the equal-value child-to-grandchild exchange does not change the blue reference')
assertStock(firstChildVariants, [30, 30], 'the child units are returned as the next exchange begins')
assertStock(grandchildVariants, [29, 29], 'the grandchild replacement units are deducted')
assert.equal(Number(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?', second.exchangeInvoiceId).sourceInvoiceId),
  first.exchangeInvoiceId, 'the grandchild records its immediate child parent, not the original sale')
const afterSecond = sideEffects()
assert.equal(afterSecond.invoices, beforeSecond.invoices + 1)
assert.equal(afterSecond.returns, beforeSecond.returns + 1)
assert.equal(afterSecond.payments, beforeSecond.payments + 1)
assert.equal(afterSecond.credits, beforeSecond.credits)
assert.equal(afterSecond.cashMovements, beforeSecond.cashMovements)

const secondReplay = await salesService.createExchange(secondRequest, { goodsReceiptRequired: false })
assert.equal(secondReplay.replayed, true)
assert.equal(secondReplay.returnId, second.returnId)
assert.equal(secondReplay.exchangeInvoiceId, second.exchangeInvoiceId)
assertNoSideEffectDelta(afterSecond, 'same-key nested exchange retry cannot duplicate child, share transfer, tender, stock, or credit')
await assert.rejects(() => salesService.createExchange({
  ...secondRequest, note: 'different S3 economic request'
}, { goodsReceiptRequired: false }), /کلید.*درخواست متفاوت|payload متفاوت|fingerprint/iu,
'same-key nested exchange with a different request fingerprint is rejected')
assertNoSideEffectDelta(afterSecond, 'mismatched nested exchange retry is write-free')

const nestedTransferRows = seed.rows(`SELECT id, kind, amount, parentEventId, rootShareId, sourceInvoiceId, childInvoiceId, returnId
  FROM "ExchangeFundingEvent" WHERE returnId=? AND kind IN ('TRANSFER_OUT','TRANSFER_IN') ORDER BY id`, second.returnId)
assert.equal(nestedTransferRows.filter(({ kind }) => kind === 'TRANSFER_OUT').length, 2)
assert.equal(nestedTransferRows.filter(({ kind }) => kind === 'TRANSFER_IN').length, 2)
assert.equal(nestedTransferRows.filter(({ kind }) => kind === 'TRANSFER_OUT').reduce((sum, row) => sum + Number(row.amount), 0), -15_000_000)
assert.equal(nestedTransferRows.filter(({ kind }) => kind === 'TRANSFER_IN').reduce((sum, row) => sum + Number(row.amount), 0), 15_000_000)
for (const transferIn of nestedTransferRows.filter(({ kind }) => kind === 'TRANSFER_IN')) {
  const priorGeneration = [...firstRoots.values()].find((entry) => entry.eventId === Number(transferIn.parentEventId))
  assert.ok(priorGeneration, 'every new branch resolves to an incoming event in the immediate parent')
  assert.equal(Number(transferIn.parentEventId), priorGeneration.eventId,
    'grandchild transfer points to the exact still-live incoming event of its immediate parent')
  assert.equal(String(transferIn.rootShareId), priorGeneration.rootShareId,
    'grandchild keeps the original root share id, not a new per-generation root')
  assert.equal(Number(transferIn.sourceInvoiceId), first.exchangeInvoiceId)
  assert.equal(Number(transferIn.childInvoiceId), second.exchangeInvoiceId)
}
const grandchildFunding = await getCurrentExchangeFundingSources(db, second.exchangeInvoiceId)
assert.deepEqual(grandchildFunding.unresolved, [])
assert.equal(grandchildFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(grandchildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
assert.equal(grandchildFunding.sources.reduce((sum, source) => sum + source.available, 0), 15_000_000)
assert.equal(await exchangeFundingBalance(db, firstRoots.get('SOURCE_CASH').shareId), 0,
  'the middle generation cannot spend the cash share again after forwarding it')
assert.equal(await exchangeFundingBalance(db, firstRoots.get('SOURCE_GIFT').shareId), 0,
  'the middle generation cannot spend the gift share again after forwarding it')
for (const source of rootFunding.sources)
  assert.equal(await exchangeFundingBalance(db, String(source.event.shareId)), 0,
    'the original generation remains exhausted while the grandchild holds the full carry')
assert.equal(seed.count('StoreCredit', '1=1'), 1)
assert.equal(seed.count('CashMovement', '1=1'), 0)

const secondReport = await salesService.exchangeList({ returnId: second.returnId, take: 1 })
assert.equal(secondReport.rows.length, 1)
assert.equal(secondReport.rows[0].returnTotal, 15_000_000)
assert.equal(secondReport.rows[0].exchangeTotal, 15_000_000)
assert.equal(secondReport.rows[0].diff, 0)
assert.equal(secondReport.rows[0].cashReceived, 0)
assert.equal(secondReport.rows[0].cardReceived, 0)
const secondDetails = await salesService.exchangeGet({ id: second.returnId })
assert.equal(secondDetails.returnTotal, 15_000_000)
assert.equal(secondDetails.exchangeTotal, 15_000_000)
assert.equal(secondDetails.diff, 0)

// The middle invoice has been fully exchanged and its carry was forwarded.
// It cannot be offered as another source; doing so would double-spend generation 2.
const beforeThirdAttempt = sideEffects()
await assert.rejects(() => salesService.createExchange({
  ...secondRequest,
  idempotencyKey: 'exchange-request:s3-forbidden-third-use-0001',
  note: 'attempt to reuse fully forwarded child'
}, { goodsReceiptRequired: false }), /تعداد|برگشت|سهم|منشأ|مصرف|مانده/iu)
assertNoSideEffectDelta(beforeThirdAttempt, 'a fully returned/forwarded generation cannot be reused as a new source')

// The first exchange cannot be voided while its child has an active grandchild.
const beforeUnsafeAncestorVoid = sideEffects()
await assert.rejects(() => salesService.returnDelete({
  id: first.returnId, userId, reason: 'S3 cannot void an ancestor while a grandchild is live',
  panelPassword: DEFAULT_MANAGER_PASSWORD
}), /ابطال تعویض ممکن نیست|برگشت از فروش ثبت شده است|اول آن برگشت/iu)
assertNoSideEffectDelta(beforeUnsafeAncestorVoid, 'ancestor void is rejected atomically while the next generation remains active')

// Void in reverse generation order: grandchild restores only the middle child;
// then its parent can safely restore the original ordinary-sale root.
const voidSecond = await salesService.returnDelete({
  id: second.returnId, userId, reason: 'S3 reverse grandchild exchange before use',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(voidSecond.exchangeVoided, true)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeRootSale, 13_000_000,
  'voiding the grandchild exchange has no cash/blue effect')
assertStock(firstChildVariants, [29, 29], 'voiding the grandchild restores the state after the first exchange')
assertStock(grandchildVariants, [30, 30], 'voiding the grandchild restores its replacement stock')
const middleRestored = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId)
assert.deepEqual(middleRestored.unresolved, [])
assert.deepEqual(middleRestored.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const voidFirst = await salesService.returnDelete({
  id: first.returnId, userId, reason: 'S3 reverse child exchange after grandchild void',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(voidFirst.exchangeVoided, true)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeRootSale, 13_000_000,
  'voiding the complete exchange chain leaves only the root sale cash in the blue reference')
assertStock(rootVariants, [29, 29], 'voiding both exchanges returns to the still-active root-sale stock state')
assertStock(firstChildVariants, [30, 30], 'voiding both exchanges restores child replacement stock')
assertStock(grandchildVariants, [30, 30], 'voiding both exchanges restores grandchild replacement stock')
const rootRestored = await getCurrentSaleFundingSources(db, rootSale.id)
assert.deepEqual(rootRestored.unresolved, [])
assert.deepEqual(rootRestored.activeReturnIds, [])
assert.deepEqual(rootRestored.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootFunding.sources.find((s) => s.sourceKind === 'SOURCE_GIFT').event.sourceCreditId).status, 'USED',
  'voiding the chain restores provenance but never reactivates or duplicates the original gift credit')
assert.equal(seed.count('StoreCredit', '1=1'), 1)
assert.equal(seed.count('CashMovement', '1=1'), 0)

console.log('✓ S3 actual chain: mixed root → exchange child → grandchild; exact remaining balances, original root lineage, no duplicate credit/cash, idempotent replay, no third spend, ancestor void guard, LIFO rollback')
