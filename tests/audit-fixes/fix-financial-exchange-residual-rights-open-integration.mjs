/** Service integration only: use a real persisted mixed-sale funding snapshot,
 * add a test exchange/return link and validated transfer pairs, then open exactly
 * the B/N remainders. This intentionally does NOT exercise SalesService.createExchange,
 * which remains fail-closed for mixed nonzero-diff exchanges in this stage.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-s1-residual-open-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { transferExchangeFundingShare, recordExchangeFundingLineAllocations } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { openS1ExchangeResidualRights, getExchangeResidualRightBalance } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { allocateExchangeFundingProportionalFloor } = await import('../../src/shared/exchangeFundingAllocation.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S1 residual opener')
const categoryId = seed.category('S1 exact source')
const variant = (name, price) => {
  const id = seed.variant(seed.product(name, categoryId))
  sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=? WHERE id=?').run(price, id)
  return id
}
const sourceVariantId = variant('mixed-source-item', 15_980_000)
const childVariantId = variant('replacement-item', 15_000_000)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const creditMethodId = seed.insert('PaymentMethod', { key: 'STORE_CREDIT', label: 'Store credit', kind: 'STORE_CREDIT', isActive: 1 })
const exchangeMethodId = seed.insert('PaymentMethod', { key: 'EXCHANGE_CREDIT', label: 'Exchange credit', kind: 'EXCHANGE_CREDIT', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'S1 shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'S1 gift root fixture', userId
}))
const sale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: sourceVariantId, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 2_000_000, storeCreditIdempotencyKey: 's1-open-mixed-sale'
})
assert.equal(sale.grandTotal, 15_980_000)

const actorUserId = userId
const graph = await db.$transaction(async (tx) => {
  const returnId = seed.insert('SaleReturn', {
    invoiceId: sale.id, kind: 'EXCHANGE', total: 15_980_000, isFull: true,
    returnedAtJalali: toJalaliDate(new Date()), exchangeTotal: 15_000_000,
    exchangeDiff: -980_000, exchangeSettlement: 'CREDIT'
  })
  const childInvoiceId = seed.insert('SaleInvoice', {
    receiptNo: 998001, issuedAtJalali: toJalaliDate(new Date()), orderType: 'EXCHANGE',
    sourceInvoiceId: sale.id, exchangeReturnId: returnId,
    goodsTotal: 15_000_000, grandTotal: 15_000_000, paidTotal: 15_000_000,
    settledAt: new Date(), settledAtJalali: toJalaliDate(new Date())
  })
  sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=?, exchangeReceiptNo=? WHERE id=?')
    .run(childInvoiceId, 998001, returnId)
  const childItemId = seed.insert('SaleInvoiceItem', {
    invoiceId: childInvoiceId, variantId: childVariantId, variantName: 'replacement',
    qty: 1, unitPrice: 15_000_000, discount: 0, tax: 0, lineTotal: 15_000_000
  })
  seed.insert('Payment', { invoiceId: childInvoiceId, methodId: exchangeMethodId,
    amount: 15_000_000, kind: 'CASH', destination: null })

  const funding = await (await import('../../src/main/services/ExchangeFundingLedgerService.ts'))
    .getCurrentSaleFundingSources(tx, sale.id)
  assert.equal(funding.unresolved.length, 0)
  const plan = allocateExchangeFundingProportionalFloor({
    replacementTotal: 15_000_000,
    sources: funding.sources.map((row) => ({ sourceEventId: Number(row.event.id),
      sourceKind: row.sourceKind, available: row.available }))
  })
  for (const allocation of plan.allocations.filter((row) => row.carry > 0)) {
    const source = funding.sources.find((row) => Number(row.event.id) === allocation.sourceEventId)
    assert.ok(source)
    await transferExchangeFundingShare(tx, {
      eventKey: `test-s1-open:source:${allocation.sourceEventId}`,
      sourceEventId: allocation.sourceEventId,
      sourceShareId: String(source.event.shareId),
      destinationShareId: `test-s1-open:child:${childInvoiceId}:source:${allocation.sourceEventId}`,
      rootShareId: String(source.event.rootShareId), amount: allocation.carry,
      sourceInvoiceId: sale.id, childInvoiceId, returnId, actorUserId,
      evidenceRef: `test fixture SaleReturn:${returnId}:SaleInvoice:${childInvoiceId}`
    })
  }
  await recordExchangeFundingLineAllocations(tx, childInvoiceId)
  const opened = await openS1ExchangeResidualRights(tx, {
    sourceInvoiceId: sale.id, childInvoiceId, returnId, actorUserId
  })
  assert.equal(opened.giftCarry, 1_877_346)
  assert.equal(opened.cashCarry, 13_122_654)
  assert.deepEqual(opened.rights.map(({ rightKind, amount }) => ({ rightKind, amount })), [
    { rightKind: 'B', amount: 122_654 }, { rightKind: 'N', amount: 857_346 }
  ])
  const replay = await openS1ExchangeResidualRights(tx, {
    sourceInvoiceId: sale.id, childInvoiceId, returnId, actorUserId
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.rights.length, 2)
  return { returnId, childInvoiceId, childItemId, opened }
})

const rows = seed.rows('SELECT rightKind, amount, rootShareId, expiresAt FROM "ExchangeResidualRightEvent" WHERE eventKind=? ORDER BY rightKind', 'OPENED')
assert.deepEqual(rows.map(({ rightKind, amount }) => ({ rightKind, amount })), [
  { rightKind: 'B', amount: 122_654 }, { rightKind: 'N', amount: 857_346 }
])
assert.ok(rows.find((row) => row.rightKind === 'B').expiresAt, 'B freezes the gift root expiry')
assert.equal(rows.find((row) => row.rightKind === 'N').expiresAt, null, 'N has no expiry')
const balances = await db.$transaction(async (tx) => Promise.all(graph.opened.rights.map((right) =>
  getExchangeResidualRightBalance(tx, right.rightKey))))
assert.deepEqual(balances.map(({ rightKind, available, reserved, spent }) => ({ rightKind, available, reserved, spent })), [
  { rightKind: 'B', available: 122_654, reserved: 0, spent: 0 },
  { rightKind: 'N', available: 857_346, reserved: 0, spent: 0 }
])
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
assert.equal(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n, 0)
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n, 3,
  'opening issues one draft code per B/N right without reactivating the old gift code')
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit" WHERE exchangeResidualRightKey IS NOT NULL AND status=?', 'DRAFT').n, 2)
assert.equal(seed.one('SELECT COUNT(*) n FROM "CreditDelivery" WHERE sourceKind IN (?,?) AND status=?',
  'S1_EXCHANGE_B', 'S1_EXCHANGE_N', 'PENDING_DELIVERY').n, 2)
console.log('✓ residual-right open integration: existing proven gift/cash roots → exact child transfers → B/N append-only claims, expiry, replay, no cash or gift-code side effects')
