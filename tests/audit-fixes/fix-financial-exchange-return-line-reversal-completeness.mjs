/**
 * An exchange-child return's provenance reversal is atomic across every return
 * item: partial attribution cannot be mistaken for a complete reversal. Replays
 * must remain exact and LIFO-safe.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-return-line-reversal-completeness.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-return-line-reversal-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const {
  recordExchangeFundingReturnLineAllocation,
  reverseExchangeFundingReturnLineAllocationsForReturn
} = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('return line reversal completeness')
const categoryId = seed.category('return line reversal completeness')
const productId = seed.product('return line reversal completeness', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const now = new Date()
const shiftId = seed.insert('Shift', {
  name: 'return line reversal shift', number: 1, userId,
  dayJalali: toJalaliDate(now), openedAt: now.getTime() - 10_000
})
const variant = (label) => {
  const id = seed.variant(productId, label)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=1000 WHERE id=?').run(id)
  return id
}
const sourceVariant = variant('source')
const replacementA = variant('replacement A')
const replacementB = variant('replacement B')
const sale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: sourceVariant, qty: 2, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 2000, destination: 'CASH' }]
})
const sourceItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id)
const exchange = await salesService.createExchange({
  invoiceId: sale.id,
  lines: [{ saleItemId: sourceItemId, qty: 2 }],
  replacements: [{ variantId: replacementA, qty: 1 }, { variantId: replacementB, qty: 1 }],
  refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const childId = exchange.exchangeInvoiceId
const childItems = seed.rows('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', childId)
assert.equal(childItems.length, 2)

const returnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: true, total: 2000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const returnItemIds = childItems.map((item) => seed.insert('SaleReturnItem', {
  returnId, saleItemId: Number(item.id), variantId: Number(item.variantId),
  qty: 1, unitPrice: 1000, lineTotal: 1000, restockedQty: 0
}))

await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId, returnItemId: returnItemIds[0]
}))
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='ALLOCATION'`, returnId).n, 1)

await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId })),
/همهٔ اقلام|تخصیص.*کامل|ناقص|allocation/iu,
'a return with one of two child-item allocations cannot be partially reversed')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, returnId).n, 0,
'failed completeness validation must not append an inverse for only one item')

await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId, returnItemId: returnItemIds[1]
}))
const completeReversal = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId }))
assert.deepEqual(completeReversal, { reversed: 2, items: 2, replayed: false })
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, returnId).n, 2)

sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'test complete child return allocation reversal', returnId)
const replay = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId }))
assert.deepEqual(replay, { reversed: 2, items: 2, replayed: true })
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, returnId).n, 2)

const originalAllocation = seed.one(`SELECT * FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='ALLOCATION'`, returnItemIds[0])
const orphanReversalId = seed.insert('ExchangeFundingReturnLineAllocation', {
  eventKey: `test-orphan-reversal:${returnItemIds[0]}:source:999999`,
  eventKind: 'REVERSAL', returnId, returnItemId: returnItemIds[0],
  sourceInvoiceId: originalAllocation.sourceInvoiceId, childInvoiceId: childId,
  saleItemId: originalAllocation.saleItemId, sourceEventId: 999999, sourceKind: 'SOURCE_CASH',
  saleItemQty: 1, saleItemValue: 1000, sourceItemAmount: 1000,
  returnedQtyBefore: 0, returningQty: 1, returnedQtyAfter: 1,
  priorReturnValue: 0, returnValue: 1000, cumulativeReturnValue: 1000,
  priorAmount: 0, amountDelta: 0, cumulativeAmount: 0,
  allocationVersion: 1, reversesAllocationId: 999999
})
const rowsBeforeOrphanReplay = seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=?`, returnId).n
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId })),
/orphan|reverse|reversal|تخصیص|تطبیق/iu,
'an orphan reversal row for this return must invalidate the ledger replay')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=?`, returnId).n, rowsBeforeOrphanReplay)
assert.ok(orphanReversalId > 0)

console.log('✓ exchange-child return allocation reversal requires every return item, rejects orphan reversals, and replays exactly')
