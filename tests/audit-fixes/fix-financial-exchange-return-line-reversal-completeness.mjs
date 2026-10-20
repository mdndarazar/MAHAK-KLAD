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
const { allocateExchangeFundingLineReturn } = await import('@shared/exchangeFundingLineReturn')
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
  lines: [{ variantId: sourceVariant, qty: 3, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 3000, destination: 'CASH' }]
})
const sourceItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id)
const exchange = await salesService.createExchange({
  invoiceId: sale.id,
  lines: [{ saleItemId: sourceItemId, qty: 3 }],
  replacements: [{ variantId: replacementA, qty: 2 }, { variantId: replacementB, qty: 1 }],
  refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const childId = exchange.exchangeInvoiceId
const childItems = seed.rows('SELECT id, variantId, qty FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', childId)
assert.equal(childItems.length, 2)

const returnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: false, total: 2000, returnedAt: now,
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

const scopedReturnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const scopedReturnItemId = seed.insert('SaleReturnItem', {
  returnId: scopedReturnId, saleItemId: Number(childItems[0].id),
  variantId: Number(childItems[0].variantId), qty: 1, unitPrice: 1000,
  lineTotal: 1000, restockedQty: 0
})
await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: scopedReturnId, returnItemId: scopedReturnItemId
}))
const scopedAllocation = seed.one(`SELECT * FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='ALLOCATION'`, scopedReturnItemId)
assert.ok(scopedAllocation)
const mismatchedSourceInvoiceId = 999999
const unknownSourceEventId = 999999
assert.notEqual(mismatchedSourceInvoiceId, childId)
seed.insert('ExchangeFundingReturnLineAllocation', {
  eventKey: `exchange-return-item:${scopedReturnItemId}:source:${unknownSourceEventId}:allocation:v1`,
  eventKind: 'ALLOCATION', returnId: scopedReturnId, returnItemId: scopedReturnItemId,
  sourceInvoiceId: mismatchedSourceInvoiceId, childInvoiceId: childId,
  saleItemId: Number(childItems[0].id), sourceEventId: unknownSourceEventId,
  sourceKind: 'SOURCE_CASH', saleItemQty: Number(scopedAllocation.saleItemQty),
  saleItemValue: Number(scopedAllocation.saleItemValue),
  sourceItemAmount: Number(scopedAllocation.sourceItemAmount),
  returnedQtyBefore: 0, returningQty: 1, returnedQtyAfter: 1,
  priorReturnValue: 0, returnValue: 1000, cumulativeReturnValue: 1000,
  priorAmount: 0, amountDelta: 0, cumulativeAmount: 0,
  allocationVersion: 1, reversesAllocationId: null
})
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: scopedReturnId })),
/snapshot|scope|lineage|تخصیص|source|تاریخچه|سازگار/iu,
'a child-return allocation must be tied to the immutable source line for that exact child item')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, scopedReturnId).n, 0,
'a source-scope mismatch must not append any reversals')

const crossLinkedReturnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const crossLinkedItemId = seed.insert('SaleReturnItem', {
  returnId: crossLinkedReturnId, saleItemId: Number(childItems[1].id),
  variantId: Number(childItems[1].variantId), qty: 1, unitPrice: 1000,
  lineTotal: 1000, restockedQty: 0
})
await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: crossLinkedReturnId, returnItemId: crossLinkedItemId
}))
const crossLinkedAllocation = seed.one(`SELECT * FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='ALLOCATION'`, crossLinkedItemId)
assert.ok(crossLinkedAllocation)
const foreignReturnId = 999997
const foreignSourceEventId = 999998
assert.notEqual(foreignReturnId, crossLinkedReturnId)
assert.notEqual(foreignSourceEventId, Number(crossLinkedAllocation.id))
seed.insert('ExchangeFundingReturnLineAllocation', {
  eventKey: `exchange-return-item:${crossLinkedItemId}:source:${foreignSourceEventId}:reversal:v1`,
  eventKind: 'REVERSAL', returnId: foreignReturnId, returnItemId: crossLinkedItemId,
  sourceInvoiceId: Number(crossLinkedAllocation.sourceInvoiceId), childInvoiceId: childId,
  saleItemId: Number(crossLinkedAllocation.saleItemId), sourceEventId: foreignSourceEventId,
  sourceKind: String(crossLinkedAllocation.sourceKind),
  saleItemQty: Number(crossLinkedAllocation.saleItemQty),
  saleItemValue: Number(crossLinkedAllocation.saleItemValue),
  sourceItemAmount: Number(crossLinkedAllocation.sourceItemAmount),
  returnedQtyBefore: Number(crossLinkedAllocation.returnedQtyBefore),
  returningQty: Number(crossLinkedAllocation.returningQty),
  returnedQtyAfter: Number(crossLinkedAllocation.returnedQtyAfter),
  priorReturnValue: Number(crossLinkedAllocation.priorReturnValue),
  returnValue: Number(crossLinkedAllocation.returnValue),
  cumulativeReturnValue: Number(crossLinkedAllocation.cumulativeReturnValue),
  priorAmount: Number(crossLinkedAllocation.cumulativeAmount),
  amountDelta: -Number(crossLinkedAllocation.amountDelta),
  cumulativeAmount: Number(crossLinkedAllocation.priorAmount),
  allocationVersion: 1, reversesAllocationId: foreignSourceEventId
})
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: crossLinkedReturnId })),
/orphan|scope|reversal|تخصیص|پیوند/iu,
'a reversal row linked to this return item cannot be hidden under another return id')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, crossLinkedReturnId).n, 0,
'a cross-return orphan must not cause a partial or duplicate reversal')

sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'release quantity for duplicate-item test', scopedReturnId)
const duplicateItemReturnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: true, total: 2000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const duplicateReturnItemIds = [1, 2].map(() => seed.insert('SaleReturnItem', {
  returnId: duplicateItemReturnId, saleItemId: Number(childItems[0].id),
  variantId: Number(childItems[0].variantId), qty: 1, unitPrice: 1000,
  lineTotal: 1000, restockedQty: 0
}))
await assert.rejects(() => db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: duplicateItemReturnId, returnItemId: duplicateReturnItemIds[0]
})),
/duplicate|same item|تکراری|یک قلم/iu,
'a return with duplicate physical item rows must not get ambiguous cumulative attribution')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=?`, duplicateItemReturnId).n, 0,
'duplicate-item rejection must not persist a partial allocation')
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: duplicateItemReturnId })),
/duplicate|same item|تکراری|یک قلم/iu,
'a duplicate-item return must be rejected explicitly before reversal')

sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'release quantity for forged-history test', duplicateItemReturnId)
const forgedHistoryReturnId = seed.insert('SaleReturn', {
  invoiceId: childId, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const forgedHistoryItemId = seed.insert('SaleReturnItem', {
  returnId: forgedHistoryReturnId, saleItemId: Number(childItems[0].id),
  variantId: Number(childItems[0].variantId), qty: 1, unitPrice: 1000,
  lineTotal: 1000, restockedQty: 0
})
const forgedSourceRows = seed.rows(`SELECT * FROM "ExchangeFundingLineAllocation"
  WHERE childInvoiceId=? AND saleItemId=? ORDER BY sourceEventId`, childId, Number(childItems[0].id))
assert.ok(forgedSourceRows.length > 0)
const forgedSources = forgedSourceRows.map((source) => ({
  sourceEventId: Number(source.sourceEventId), sourceKind: String(source.sourceKind),
  amount: Number(source.amount)
}))
const forgedSaleItemValue = Number(forgedSourceRows[0].saleItemValue)
const firstForgedChunk = allocateExchangeFundingLineReturn({
  saleItemId: Number(childItems[0].id), saleItemQty: Number(childItems[0].qty),
  saleItemValue: forgedSaleItemValue, previouslyReturnedQty: 0,
  returningQty: 1, sources: forgedSources
})
const secondForgedChunk = allocateExchangeFundingLineReturn({
  saleItemId: Number(childItems[0].id), saleItemQty: Number(childItems[0].qty),
  saleItemValue: forgedSaleItemValue, previouslyReturnedQty: 1,
  returningQty: 1, sources: forgedSources,
  priorAllocations: firstForgedChunk.shares.map(({ sourceEventId, cumulative }) => ({
    sourceEventId, amount: cumulative
  }))
})
for (const share of secondForgedChunk.shares) {
  const source = forgedSourceRows.find((row) => Number(row.sourceEventId) === share.sourceEventId)
  seed.insert('ExchangeFundingReturnLineAllocation', {
    eventKey: `exchange-return-item:${forgedHistoryItemId}:source:${share.sourceEventId}:allocation:v1`,
    eventKind: 'ALLOCATION', returnId: forgedHistoryReturnId, returnItemId: forgedHistoryItemId,
    sourceInvoiceId: Number(source.sourceInvoiceId), childInvoiceId: childId,
    saleItemId: Number(childItems[0].id), sourceEventId: share.sourceEventId,
    sourceKind: String(source.sourceKind), saleItemQty: Number(childItems[0].qty),
    saleItemValue: forgedSaleItemValue, sourceItemAmount: Number(source.amount),
    returnedQtyBefore: 1, returningQty: 1, returnedQtyAfter: 2,
    priorReturnValue: secondForgedChunk.cumulativeReturnValue - secondForgedChunk.returnValue,
    returnValue: secondForgedChunk.returnValue,
    cumulativeReturnValue: secondForgedChunk.cumulativeReturnValue,
    priorAmount: share.prior, amountDelta: share.amount, cumulativeAmount: share.cumulative,
    allocationVersion: 1, reversesAllocationId: null
  })
}
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: forgedHistoryReturnId })),
/history|prior|earlier|تاریخچه|قبلی|تجمعی/iu,
'a reversal must not trust a fabricated prior returned quantity/share with no earlier active return')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, forgedHistoryReturnId).n, 0,
'forged cumulative history must fail before any inverse row is appended')
sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'simulate void without atomic ledger reversal', forgedHistoryReturnId)
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: forgedHistoryReturnId })),
/reversal.*کامل|ابطال‌شده|inverse/iu,
'a voided return without a complete preexisting reversal must not append missing inverse rows')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId=? AND eventKind='REVERSAL'`, forgedHistoryReturnId).n, 0,
'a voided return with missing reversals must remain write-free')

console.log('✓ exchange-child return line reversals revalidate cumulative history, require complete replay, and reject orphan/cross-linked rows')
