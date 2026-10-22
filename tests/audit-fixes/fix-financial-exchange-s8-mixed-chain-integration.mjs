/** Accepted S8 integration: a child line funded by 13M cash + 2M barcode
 * carries 5M of its cash share into a 6M replacement; the remaining source is
 * exactly 8M cash + 2M barcode. No proportional split or quarantine path.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s8-mixed-chain-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s8-cash-first-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S8 cash-first integration')
const categoryId = seed.category('S8 accepted category')
const productId = seed.product('S8 accepted product', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S8 accepted shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
const variant = (label, price) => {
  const id = seed.variant(productId, `S8-${label}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const item = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S8 barcode source', userId
}))
const pVariant = variant('P', 1_000_000)
const cVariant = variant('C', 1_000_000)
const gVariant = variant('G', 1_000_000)
const pSale = await salesService.create({
  userId, shiftId, lines: [item(pVariant, 15, 1_000_000)],
  payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's8-accepted-P-sale-0001'
})
assert.equal(pSale.grandTotal, 15_000_000)
const pFunding = await getCurrentSaleFundingSources(db, pSale.id)
assert.deepEqual(pFunding.unresolved, [])
assert.deepEqual(pFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const pItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', pSale.id)
const cExchange = await exchange({
  invoiceId: pSale.id, lines: [{ saleItemId: pItem.id, qty: 15 }],
  replacements: [item(cVariant, 15, 1_000_000)], userId, shiftId,
  idempotencyKey: 's8-accepted-P-to-C-0001'
})
assert.equal(cExchange.returnTotal, 15_000_000)
assert.equal(cExchange.exchangeTotal, 15_000_000)
const cFunding = await getCurrentExchangeFundingSources(db, cExchange.exchangeInvoiceId)
assert.deepEqual(cFunding.unresolved, [])
assert.deepEqual(cFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const cItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', cExchange.exchangeInvoiceId)
const gExchange = await exchange({
  invoiceId: cExchange.exchangeInvoiceId, lines: [{ saleItemId: cItem.id, qty: 5 }],
  replacements: [item(gVariant, 6, 1_000_000)],
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
  userId, shiftId, idempotencyKey: 's8-accepted-C-to-G-cash-carry-0001'
})
assert.deepEqual([gExchange.returnTotal, gExchange.exchangeTotal, gExchange.diff], [5_000_000, 6_000_000, 1_000_000])
const gFunding = await getCurrentExchangeFundingSources(db, gExchange.exchangeInvoiceId)
assert.deepEqual(gFunding.unresolved, [])
assert.equal(gFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.equal(gFunding.sources.filter((row) => row.sourceKind === 'SOURCE_CASH')
  .reduce((sum, row) => sum + row.available, 0), 6_000_000,
  'the G invoice receives exactly 5M cash carry plus 1M newly received cash')
const cRemaining = await getCurrentExchangeFundingSources(db, cExchange.exchangeInvoiceId, {
  allowReturnBalanceChanges: true
})
assert.deepEqual(cRemaining.unresolved, [])
assert.deepEqual(cRemaining.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 8_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
], 'the C line retains 8M real cash and the full 2M non-cash barcode share')
const s8Allocations = seed.rows('SELECT sourceKind, amountDelta, allocationVersion FROM "ExchangeFundingReturnLineAllocation" WHERE returnId=? AND eventKind=? ORDER BY sourceKind',
  gExchange.returnId, 'ALLOCATION')
assert.deepEqual(s8Allocations.map(({ sourceKind, amountDelta, allocationVersion }) =>
  [sourceKind, amountDelta, allocationVersion]), [['SOURCE_CASH', 5_000_000, 3], ['SOURCE_GIFT', 0, 3]])
const cashCount = seed.count('CashMovement', '1=1')
const retry = await exchange({
  invoiceId: cExchange.exchangeInvoiceId, lines: [{ saleItemId: cItem.id, qty: 5 }],
  replacements: [item(gVariant, 6, 1_000_000)],
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
  userId, shiftId, idempotencyKey: 's8-accepted-C-to-G-cash-carry-0001'
})
assert.equal(retry.replayed, true)
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', `returnId=${gExchange.returnId} AND eventKind='ALLOCATION'`), 2)
assert.equal(seed.count('CashMovement', '1=1'), cashCount,
  'the retry creates no duplicate cash movement for the real 1M delta')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
  'the original barcode remains USED throughout the nested exchange')
console.log('✓ S8 integration: 5M cash-first carry from C to G; C retains 8M cash + 2M barcode; one version-3 attribution and no proportional carry split')
