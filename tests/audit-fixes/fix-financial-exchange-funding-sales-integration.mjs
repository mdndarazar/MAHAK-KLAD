/** End-to-end funding journal integration for real SalesService mutations.
 * Exercises persisted sale/payment/cheque rows, automatic snapshot revisions,
 * append-only reversals and the conservative post-return hold. The exchange
 * credit gate is intentionally not changed by this test.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-funding-sales-integration.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-sales-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { planCreditReturn } = await import('../../src/main/services/CreditReturnService.ts')
const { allocateExchangeFundingLineReturn } = await import('../../src/shared/exchangeFundingLineReturn.ts')
const {
  getCurrentExchangeFundingSources,
  getCurrentSaleFundingSources,
  recordExchangeFundingLineAllocations,
  recordExchangeFundingReturnLineAllocation,
  reverseExchangeFundingReturnLineAllocationsForReturn,
  reverseExchangeFundingTransfersForReturn,
  transferExchangeFundingShare
} = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { RefundMethod } = await import('@shared/enums')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('exchange funding integration')
const categoryId = seed.category('funding integration category')
const productId = seed.product('funding integration item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'funding integration shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantSequence = 0
const variant = (price) => {
  const id = seed.variant(productId, `F${++variantSequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const rowsFor = (invoiceId) => seed.rows(
  'SELECT eventKey, kind, amount, shareId, sourcePaymentId FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? ORDER BY id',
  invoiceId
)
const balance = (shareId) => Number(seed.one(
  'SELECT COALESCE(SUM(amount),0) AS amount FROM "ExchangeFundingEvent" WHERE shareId=?', shareId
).amount)
const GATE = { managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'funding ledger integration test' }

// Ordinary sale creation snapshots the actual saved Payment row in its transaction.
const salesVariant = variant(1_000)
const sale = await salesService.create({
  userId, shiftId, lines: [line(salesVariant, 1_000)],
  payments: [{ methodId: cashMethodId, amount: 300, destination: 'CASH' }]
})
const firstPayment = seed.one('SELECT id, amount FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', sale.id)
assert.equal(firstPayment.amount, 300)
assert.deepEqual(rowsFor(sale.id).filter((row) => !String(row.kind).startsWith('VOID_')).map(({ kind, amount }) => ({ kind, amount })), [
  { kind: 'SOURCE_CASH', amount: 300 },
  { kind: 'DEBT_OPEN', amount: 700 }
])
assert.equal(balance(`payment:${firstPayment.id}`), 300)
assert.equal(balance(`debt:${sale.id}`), 700)
const firstSourceView = await getCurrentSaleFundingSources(db, sale.id)
assert.equal(firstSourceView.sources[0].available, 300)
assert.equal(firstSourceView.debt, 700)
assert.deepEqual(firstSourceView.unresolved, [])

// addPayment creates r2; prior evidence is voided, not edited/deleted.
const added = await salesService.addPayment({
  userId, invoiceId: sale.id, methodId: cashMethodId, amount: 200, destination: 'CASH'
})
const secondPaymentId = added.payment.id
let rows = rowsFor(sale.id)
assert.ok(rows.some((row) => row.eventKey === `sale:${sale.id}:r1:payment:${firstPayment.id}:funded` && row.kind === 'SOURCE_CASH'))
assert.ok(rows.some((row) => row.eventKey === `sale:${sale.id}:r1:payment:${firstPayment.id}:funded:void:r2` &&
  row.kind === 'VOID_SOURCE_CASH' && row.amount === -300))
assert.deepEqual(rows.filter((row) => String(row.eventKey).startsWith(`sale:${sale.id}:r2:`) && !row.kind.startsWith('VOID_'))
  .map(({ kind, amount }) => ({ kind, amount })), [
  { kind: 'SOURCE_CASH', amount: 300 },
  { kind: 'SOURCE_CASH', amount: 200 },
  { kind: 'DEBT_OPEN', amount: 500 }
])
assert.deepEqual([balance(`payment:${firstPayment.id}`), balance(`payment:${secondPaymentId}`), balance(`debt:${sale.id}`)],
  [300, 200, 500])

// updatePayment creates r3 and changes only the current source balance.
await salesService.updatePayment({ id: secondPaymentId, amount: 250, userId, ...GATE })
rows = rowsFor(sale.id)
assert.ok(rows.some((row) => row.eventKey === `sale:${sale.id}:r2:payment:${secondPaymentId}:funded:void:r3` &&
  row.kind === 'VOID_SOURCE_CASH' && row.amount === -200))
assert.ok(rows.some((row) => row.eventKey === `sale:${sale.id}:r3:payment:${secondPaymentId}:funded` &&
  row.kind === 'SOURCE_CASH' && row.amount === 250))
assert.deepEqual([balance(`payment:${firstPayment.id}`), balance(`payment:${secondPaymentId}`), balance(`debt:${sale.id}`)],
  [300, 250, 450])

// deletePayment creates r4, reverses the source share, and re-opens exact debt.
await salesService.deletePayment({
  id: secondPaymentId, userId, reason: 'test payment correction', ...GATE
})
rows = rowsFor(sale.id)
assert.ok(rows.some((row) => row.eventKey === `sale:${sale.id}:r3:payment:${secondPaymentId}:funded:void:r4` &&
  row.kind === 'VOID_SOURCE_CASH' && row.amount === -250))
assert.deepEqual([balance(`payment:${firstPayment.id}`), balance(`payment:${secondPaymentId}`), balance(`debt:${sale.id}`)],
  [300, 0, 700])
assert.equal(seed.one('SELECT voidedAt IS NOT NULL AS voided FROM "Payment" WHERE id=?', secondPaymentId).voided, 1)

// Editing invoice value also revises its debt-side funding snapshot; live payments
// are retained and their source classification is not changed.
await salesService.update({
  id: sale.id, userId, shiftId, keepPayments: true, payments: [],
  lines: [{ ...line(salesVariant, 1_200), code: 'FUND-SALE', barcode: 'FUND-SALE', name: 'funding integration item' }]
})
rows = rowsFor(sale.id)
assert.ok(rows.some((row) => row.kind === 'VOID_DEBT_OPEN' && row.amount === -700 &&
  row.eventKey === `sale:${sale.id}:r4:debt:void:r5`))
assert.ok(rows.some((row) => row.kind === 'DEBT_OPEN' && row.amount === 900 &&
  row.eventKey === `sale:${sale.id}:r5:debt`))
assert.deepEqual([balance(`payment:${firstPayment.id}`), balance(`debt:${sale.id}`)], [300, 900])
assert.equal(Number(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?', sale.id).grandTotal), 1_200)

// Cheque state changes each write a new revision: PENDING is not funded, CLEARED
// becomes SOURCE_CHEQUE, and BOUNCED remains a separate non-funded obligation.
const chequeVariant = variant(1_000)
const chequeSale = await salesService.create({
  userId, shiftId, lines: [line(chequeVariant, 1_000)], payments: []
})
const chequeAdded = await salesService.addPayment({
  userId, invoiceId: chequeSale.id, kind: 'CHEQUE', amount: 500,
  dueDateJalali: toJalaliDate(new Date()), chequeNo: 'FUND-1'
})
const chequeId = chequeAdded.payment.id
rows = rowsFor(chequeSale.id)
assert.ok(rows.some((row) => row.kind === 'PENDING_CHEQUE' && row.amount === 500 &&
  row.eventKey === `sale:${chequeSale.id}:r2:payment:${chequeId}:pending-cheque`))
assert.deepEqual([balance(`payment:${chequeId}`), balance(`pending-cheque:${chequeId}`), balance(`debt:${chequeSale.id}`)],
  [0, 500, 1_000])

await salesService.setChequeStatus({
  id: chequeId, userId, status: 'CLEARED', destination: 'MANAGER', managerPassword: DEFAULT_MANAGER_PASSWORD
})
rows = rowsFor(chequeSale.id)
assert.ok(rows.some((row) => row.kind === 'VOID_PENDING_CHEQUE' && row.amount === -500))
assert.ok(rows.some((row) => row.kind === 'SOURCE_CHEQUE' && row.amount === 500 &&
  row.eventKey === `sale:${chequeSale.id}:r3:payment:${chequeId}:funded`))
assert.deepEqual([balance(`payment:${chequeId}`), balance(`pending-cheque:${chequeId}`), balance(`debt:${chequeSale.id}`)],
  [500, 0, 500])

await salesService.setChequeStatus({
  id: chequeId, userId, status: 'BOUNCED', managerPassword: DEFAULT_MANAGER_PASSWORD
})
rows = rowsFor(chequeSale.id)
assert.ok(rows.some((row) => row.kind === 'VOID_SOURCE_CHEQUE' && row.amount === -500))
assert.ok(rows.some((row) => row.kind === 'BOUNCED_CHEQUE' && row.amount === 500 &&
  row.eventKey === `sale:${chequeSale.id}:r4:payment:${chequeId}:bounced-cheque`))
assert.deepEqual([balance(`payment:${chequeId}`), balance(`pending-cheque:${chequeId}`),
  balance(`bounced-cheque:${chequeId}`), balance(`debt:${chequeSale.id}`)], [0, 0, 500, 1_000])

// A post-return payment remains a supported sales workflow, but its old snapshot
// is not silently reclassified. The zero-value stale marker blocks later share
// transfer until a separate witnessed correction exists.
const returnedVariant = variant(600)
const retainedVariant = variant(400)
const returnedSale = await salesService.create({
  userId, shiftId,
  lines: [line(returnedVariant, 600), line(retainedVariant, 400)],
  payments: [{ methodId: cashMethodId, amount: 300, destination: 'CASH' }]
})
const returnItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?',
  returnedSale.id, returnedVariant).id
await salesService.createReturn({
  invoiceId: returnedSale.id, full: false, lines: [{ saleItemId: returnItemId, qty: 1 }],
  refundMethod: RefundMethod.NONE, userId, shiftId
})
const returnedOriginalPayment = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', returnedSale.id)
const afterReturnBeforePayment = rowsFor(returnedSale.id).length
const postReturnPayment = await salesService.addPayment({
  userId, invoiceId: returnedSale.id, methodId: cashMethodId, amount: 100, destination: 'CASH'
})
assert.ok(postReturnPayment.payment?.id > 0, 'the standard post-return payment still commits')
const returnedRows = rowsFor(returnedSale.id)
assert.equal(returnedRows.length, afterReturnBeforePayment + 1, 'only the zero-value stale-state marker is appended')
assert.ok(returnedRows.some((row) => row.kind === 'SNAPSHOT_STALE' && row.amount === 0))
const staleFundingView = await getCurrentSaleFundingSources(db, returnedSale.id)
assert.equal(staleFundingView.stale, true)
assert.equal(staleFundingView.sources.length, 0, 'stale source amounts are not exposed as transferable shares')
assert.ok(!returnedRows.some((row) => row.eventKey.startsWith(`sale:${returnedSale.id}:r2:`)),
  'a post-return mutation does not invent a new fungible funding snapshot')
assert.deepEqual([balance(`payment:${returnedOriginalPayment.id}`),
  balance(`payment:${postReturnPayment.payment.id}`), balance(`debt:${returnedSale.id}`)], [300, 0, 700],
'a stale marker does not mutate old Rial balances or claim the new payment as exchange-eligible')
const returnedSourceEvent = seed.one(`SELECT id FROM "ExchangeFundingEvent"
  WHERE eventKey=? AND kind='SOURCE_CASH'`,
  `sale:${returnedSale.id}:r1:payment:${returnedOriginalPayment.id}:funded`)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: 'exchange:post-return-stale:attempt', sourceEventId: returnedSourceEvent.id,
  sourceShareId: `payment:${returnedOriginalPayment.id}`, destinationShareId: 'exchange:post-return-stale:carry',
  rootShareId: `payment:${returnedOriginalPayment.id}`, amount: 1, sourceInvoiceId: returnedSale.id,
  childInvoiceId: 1012, returnId: 1013
})), /منسوخ است/)

// The return policy can auto-void a pending cheque; it marks the snapshot stale.
// Voiding that return restores the same cheque row and safely reconciles r3.
const autoVoidVariant = variant(1_000)
const autoVoidSale = await salesService.create({
  userId, shiftId, lines: [line(autoVoidVariant, 1_000)], payments: []
})
const autoVoidItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', autoVoidSale.id).id
const autoVoidCheque = await salesService.addPayment({
  userId, invoiceId: autoVoidSale.id, kind: 'CHEQUE', amount: 1_000,
  dueDateJalali: toJalaliDate(new Date()), chequeNo: 'FUND-AUTO-VOID'
})
const autoVoidChequeId = autoVoidCheque.payment.id
const fullReturn = await salesService.createReturn({
  invoiceId: autoVoidSale.id, full: false, lines: [{ saleItemId: autoVoidItemId, qty: 1 }],
  refundMethod: RefundMethod.NONE, userId, shiftId
})
assert.ok(seed.one('SELECT voidedAt FROM "Payment" WHERE id=?', autoVoidChequeId).voidedAt,
  'full return auto-voids the pending cheque')
assert.ok(rowsFor(autoVoidSale.id).some((row) => row.kind === 'SNAPSHOT_STALE' && row.amount === 0),
  'auto-void during a live return invalidates, but does not rewrite, the old snapshot')
await salesService.returnDelete({ id: fullReturn.id, userId, reason: 'undo auto-void test return', ...GATE })
assert.equal(seed.one('SELECT voidedAt FROM "Payment" WHERE id=?', autoVoidChequeId).voidedAt, null,
  'voiding the return restores the cheque row')
assert.deepEqual(seed.one(`SELECT kind, amount FROM "ExchangeFundingEvent"
  WHERE sourceInvoiceId=? AND kind IN ('SNAPSHOT_STALE','SNAPSHOT_RECONCILED') ORDER BY id DESC LIMIT 1`, autoVoidSale.id),
  { kind: 'SNAPSHOT_RECONCILED', amount: 0 })
assert.deepEqual([balance(`pending-cheque:${autoVoidChequeId}`), balance(`payment:${autoVoidChequeId}`),
  balance(`debt:${autoVoidSale.id}`)], [1_000, 0, 1_000])

// A real, exact-value exchange with a homogeneous cash source transfers the
// source share to its child inside createExchange's SQLite transaction. Voiding
// that exchange appends a matched pair of reversals and restores the source.
const exactSourceVariant = variant(1_000)
const exactReplacementVariant = variant(1_000)
const exactSale = await salesService.create({
  userId, shiftId, lines: [line(exactSourceVariant, 1_000)],
  payments: [{ methodId: cashMethodId, amount: 1_000, destination: 'CASH' }]
})
const exactSourcePayment = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', exactSale.id)
const exactItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', exactSale.id).id
const exactFundingBefore = await getCurrentSaleFundingSources(db, exactSale.id)
assert.equal(exactFundingBefore.snapshotExists, true)
assert.equal(exactFundingBefore.debt, 0)
assert.equal(exactFundingBefore.sources[0].available, 1_000)
assert.deepEqual(exactFundingBefore.unresolved, [])

const exactExchange = await salesService.createExchange({
  invoiceId: exactSale.id,
  lines: [{ saleItemId: exactItemId, qty: 1 }],
  replacements: [{ variantId: exactReplacementVariant, qty: 1 }],
  refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(exactExchange.returnTotal, 1_000)
assert.equal(exactExchange.exchangeTotal, 1_000)
assert.equal(exactExchange.diff, 0)
const transferRows = seed.rows(`SELECT kind, amount, shareId FROM "ExchangeFundingEvent"
  WHERE returnId=? AND kind IN ('TRANSFER_OUT','TRANSFER_IN') ORDER BY id`, exactExchange.returnId)
assert.deepEqual(transferRows.map(({ kind, amount }) => ({ kind, amount })), [
  { kind: 'TRANSFER_OUT', amount: -1_000 },
  { kind: 'TRANSFER_IN', amount: 1_000 }
])
const childShareId = transferRows.find((row) => row.kind === 'TRANSFER_IN').shareId
assert.equal(balance(`payment:${exactSourcePayment.id}`), 0)
assert.equal(balance(childShareId), 1_000)
const eventCountBeforeLinePreview = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
const lineAllocationCountBeforeRead = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingLineAllocation"').n
const childFundingView = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventCountBeforeLinePreview,
  'reading persisted line attribution does not append funding events')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingLineAllocation"').n, lineAllocationCountBeforeRead,
  'reading persisted line attribution does not append rows')
assert.equal(childFundingView.snapshotExists, true)
assert.equal(childFundingView.sources.length, 1)
assert.equal(childFundingView.sources[0].event.kind, 'TRANSFER_IN')
assert.equal(childFundingView.sources[0].sourceKind, 'SOURCE_CASH')
assert.equal(childFundingView.sources[0].sourceMethodKind, 'CASH')
assert.equal(childFundingView.sources[0].available, 1_000)
assert.deepEqual(childFundingView.unresolved, [], 'EXCHANGE_CREDIT is reconciled to the proven parent transfer, not treated as money')
const exactChildItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).id
assert.equal(childFundingView.lineAllocationStatus, 'PERSISTED_RECONCILED')
const exactLineAllocation = {
  sourceInvoiceId: exactSale.id,
  childInvoiceId: exactExchange.exchangeInvoiceId,
  returnId: exactExchange.returnId,
  sourceEventId: childFundingView.sources[0].event.id,
  saleItemId: exactChildItemId,
  saleItemQty: 1,
  saleItemValue: 1_000,
  sourceKind: 'SOURCE_CASH',
  amount: 1_000
}
assert.deepEqual(childFundingView.lineAllocations, [{
  sourceEventId: exactLineAllocation.sourceEventId,
  saleItemId: exactChildItemId, sourceKind: 'SOURCE_CASH', amount: 1_000
}], 'an untouched exact child can read the persisted item attribution')
assert.deepEqual(seed.rows(`SELECT sourceInvoiceId, childInvoiceId, returnId, sourceEventId,
  saleItemId, saleItemQty, saleItemValue, sourceKind, amount
  FROM "ExchangeFundingLineAllocation" WHERE childInvoiceId=?`,
  exactExchange.exchangeInvoiceId), [exactLineAllocation],
  'the exact exchange persists its source-to-item matrix in the same transaction')
const exactLineAllocationRowId = seed.one('SELECT id FROM "ExchangeFundingLineAllocation" WHERE childInvoiceId=?',
  exactExchange.exchangeInvoiceId).id
assert.throws(() => sql.prepare('UPDATE "ExchangeFundingLineAllocation" SET amount=amount+1 WHERE id=?')
  .run(exactLineAllocationRowId), /append-only/, 'persisted line allocations cannot be edited')
assert.throws(() => sql.prepare('DELETE FROM "ExchangeFundingLineAllocation" WHERE id=?')
  .run(exactLineAllocationRowId), /append-only/, 'persisted line allocations cannot be deleted')
const childReturnBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).n,
  activePayments: seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', exactExchange.exchangeInvoiceId).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  creditAllocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}
const exactChildPreview = await salesService.returnProvenancePreview({
  invoiceId: exactExchange.exchangeInvoiceId, lines: [{ saleItemId: exactChildItemId, qty: 1 }]
})
assert.equal(exactChildPreview.returnTotal, 1_000)
assert.deepEqual(exactChildPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_CASH', amount: 1_000 }
])
assert.equal(exactChildPreview.settlementReady, false)
assert.equal(exactChildPreview.cashRight, 0,
  'proven cash-origin attribution is not exposed as a payout entitlement')
assert.deepEqual(exactChildPreview.remainingAttributionBySource.map(({ remainingAttribution, ledgerBalance }) =>
  ({ remainingAttribution, ledgerBalance })), [{ remainingAttribution: 1_000, ledgerBalance: 1_000 }],
  'remaining attribution is separate from the selected prospective return and unchanged ledger balance')
await assert.rejects(() => salesService.createReturn({
  invoiceId: exactExchange.exchangeInvoiceId,
  lines: [{ saleItemId: exactChildItemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 1_000, userId, shiftId
}), /تخصیص منشأ به قلم/,
'ordinary return must not bypass exchange-line source allocation and issue a cash refund')
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).n,
  activePayments: seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', exactExchange.exchangeInvoiceId).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  creditAllocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}, childReturnBefore, 'exchange-child return hold has no settlement, right, or ledger side effects')

// A disposable, manually assembled mixed-source child proves why the generic
// return planner cannot be used for an EXCHANGE invoice. The real SQLite
// source sale has 400 gift + 600 cash; the replacement is 2 units / 1,000 and
// the persisted line matrix assigns those same origins to its one item.
const mixedGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 400, multiUse: false, maxUses: 1, carryRemainder: false,
  days: 30, note: 'isolated mixed-source return fixture', userId
}))
const mixedSourceVariant = variant(1_000)
const mixedSourceSale = await salesService.create({
  userId, shiftId, lines: [line(mixedSourceVariant, 1_000)],
  payments: [{ methodId: cashMethodId, amount: 600, destination: 'CASH' }],
  storeCreditCode: mixedGift.code, storeCreditAmount: 400,
  storeCreditIdempotencyKey: 'mixed-exchange-child-return-fixture'
})
assert.equal(mixedSourceSale.grandTotal, 1_000)
assert.equal(mixedSourceSale.storeCreditApplied, 400)
const mixedSourceFunding = await getCurrentSaleFundingSources(db, mixedSourceSale.id)
assert.deepEqual(mixedSourceFunding.unresolved, [])
assert.equal(mixedSourceFunding.sources.find((source) => source.event.kind === 'SOURCE_GIFT')?.available, 400)
assert.equal(mixedSourceFunding.sources.find((source) => source.event.kind === 'SOURCE_CASH')?.available, 600)
const mixedSourceItem = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', mixedSourceSale.id)
const mixedExchangeReturnId = seed.insert('SaleReturn', {
  invoiceId: mixedSourceSale.id, total: 1_000, returnedAt: new Date(),
  returnedAtJalali: toJalaliDate(new Date()), returnedAtTime: '12:00:00',
  kind: 'EXCHANGE', exchangeTotal: 1_000, exchangeDiff: 0, userId, shiftId
})
const mixedChildReceiptNo = 880_001
const mixedChildInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: mixedChildReceiptNo, issuedAt: new Date(), issuedAtJalali: toJalaliDate(new Date()),
  status: 'SETTLED', orderType: 'EXCHANGE', goodsTotal: 1_000, grandTotal: 1_000,
  paidTotal: 1_000, sourceInvoiceId: mixedSourceSale.id, exchangeReturnId: mixedExchangeReturnId
})
sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=?, exchangeReceiptNo=? WHERE id=?')
  .run(mixedChildInvoiceId, mixedChildReceiptNo, mixedExchangeReturnId)
seed.insert('SaleReturnItem', {
  returnId: mixedExchangeReturnId, saleItemId: mixedSourceItem.id, variantId: mixedSourceItem.variantId,
  qty: 1, unitPrice: 1_000, lineTotal: 1_000
})
const mixedReplacementVariant = variant(500)
const mixedChildItemId = seed.insert('SaleInvoiceItem', {
  invoiceId: mixedChildInvoiceId, variantId: mixedReplacementVariant, qty: 2,
  unitPrice: 500, discount: 0, tax: 0, lineTotal: 1_000, variantName: 'mixed-source replacement'
})
const exchangeCreditMethodId = seed.one('SELECT id FROM "PaymentMethod" WHERE key=?', 'EXCHANGE_CREDIT').id
seed.insert('Payment', {
  invoiceId: mixedChildInvoiceId, methodId: exchangeCreditMethodId, amount: 1_000,
  kind: 'CASH', seq: 1, destination: null
})
await db.$transaction(async (tx) => {
  for (const source of mixedSourceFunding.sources) {
    await transferExchangeFundingShare(tx, {
      eventKey: `test:mixed-return:${mixedExchangeReturnId}:source:${source.event.id}`,
      sourceEventId: source.event.id, sourceShareId: source.event.shareId,
      destinationShareId: `test:mixed-child:${mixedChildInvoiceId}:source:${source.event.id}`,
      rootShareId: source.event.rootShareId, amount: source.available,
      sourceInvoiceId: mixedSourceSale.id, childInvoiceId: mixedChildInvoiceId,
      returnId: mixedExchangeReturnId, actorUserId: userId, evidenceRef: `SaleReturn:${mixedExchangeReturnId}`
    })
  }
  await recordExchangeFundingLineAllocations(tx, mixedChildInvoiceId)
})
const mixedChildFunding = await getCurrentExchangeFundingSources(db, mixedChildInvoiceId)
assert.deepEqual(mixedChildFunding.unresolved, [])
assert.equal(mixedChildFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(mixedChildFunding.lineAllocations.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', amount: 600 }, { sourceKind: 'SOURCE_GIFT', amount: 400 }
])
const mixedPartialAttribution = allocateExchangeFundingLineReturn({
  saleItemId: mixedChildItemId, saleItemQty: 2, saleItemValue: 1_000,
  previouslyReturnedQty: 0, returningQty: 1,
  sources: mixedChildFunding.lineAllocations.map(({ sourceEventId, sourceKind, amount }) =>
    ({ sourceEventId, sourceKind, amount }))
})
assert.equal(mixedPartialAttribution.returnValue, 500)
assert.equal(mixedPartialAttribution.shares.find((share) => share.sourceKind === 'SOURCE_GIFT')?.amount, 200)
assert.equal(mixedPartialAttribution.shares.find((share) => share.sourceKind === 'SOURCE_CASH')?.amount, 300)
assert.equal('cashRight' in mixedPartialAttribution, false,
  'item allocation records source only; the result schema cannot grant a cash or credit entitlement')
const genericMixedReturnPlan = await planCreditReturn(db, {
  invoiceId: mixedChildInvoiceId, grandTotal: 1_000, paidTotal: 1_000, returnedValue: 500,
  debtBefore: { remaining: 0, refundFromReceived: 0 }, activeReturns: []
})
assert.deepEqual([genericMixedReturnPlan.credit, genericMixedReturnPlan.cash], [0, 500],
  'the old generic planner sees EXCHANGE_CREDIT but not the child item matrix, so it calls all 500 cash')
assert.ok(genericMixedReturnPlan.cash > mixedPartialAttribution.shares
  .find((share) => share.sourceKind === 'SOURCE_CASH').amount,
'generic settlement candidate exceeds the real-cash provenance attributable to this half-item return')
assert.equal(mixedSourceFunding.sources.find((source) => source.event.kind === 'SOURCE_CASH')?.available, 600,
  'the old sourceInvoiceId-chain cash cap would cover the 500 candidate despite 200 gift value in the returned item')
const mixedChildReturnBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', mixedChildInvoiceId).n,
  payments: seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=?', mixedChildInvoiceId).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  creditAllocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
  lineAllocations: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingLineAllocation" WHERE childInvoiceId=?', mixedChildInvoiceId).n
}
const mixedChildPreview = await salesService.returnProvenancePreview({
  invoiceId: mixedChildInvoiceId, lines: [{ saleItemId: mixedChildItemId, qty: 1 }]
})
assert.equal(mixedChildPreview.returnTotal, 500)
assert.deepEqual(mixedChildPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', amount: 300 }, { sourceKind: 'SOURCE_GIFT', amount: 200 }
])
assert.equal(mixedChildPreview.cashRight, 0)
assert.equal(mixedChildPreview.giftOpportunity, 0,
  'gift provenance is not a new credit entitlement')
assert.equal(mixedChildPreview.settlementReady, false)
assert.deepEqual(mixedChildPreview.remainingAttributionBySource.map(({ sourceKind, attributedAmount,
  alreadyReturnedAttribution, remainingAttribution, ledgerBalance }) => ({ sourceKind, attributedAmount,
  alreadyReturnedAttribution, remainingAttribution, ledgerBalance }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', attributedAmount: 600, alreadyReturnedAttribution: 0,
    remainingAttribution: 600, ledgerBalance: 600 },
  { sourceKind: 'SOURCE_GIFT', attributedAmount: 400, alreadyReturnedAttribution: 0,
    remainingAttribution: 400, ledgerBalance: 400 }
])
await assert.rejects(() => salesService.createReturn({
  invoiceId: mixedChildInvoiceId, lines: [{ saleItemId: mixedChildItemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 500, userId, shiftId
}), /تخصیص منشأ به قلم/)
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', mixedChildInvoiceId).n,
  payments: seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=?', mixedChildInvoiceId).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  creditAllocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
  lineAllocations: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingLineAllocation" WHERE childInvoiceId=?', mixedChildInvoiceId).n
}, mixedChildReturnBefore,
'mixed exchange-child return is held before cash, credit, return-row, or ledger side effects')

// The accounting writer can persist source attribution for a mixed child line,
// but this remains descriptive only: gift value never becomes refund money.
// Two one-unit chunks prove cumulative history; reversal is strictly LIFO.
const makeMixedChildReturn = () => seed.insert('SaleReturn', {
  invoiceId: mixedChildInvoiceId, total: 500, returnedAt: new Date(),
  returnedAtJalali: toJalaliDate(new Date()), returnedAtTime: '12:30:00',
  kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0, userId, shiftId
})
const mixedChildReturn1 = makeMixedChildReturn()
const mixedChildReturnItem1 = seed.insert('SaleReturnItem', {
  returnId: mixedChildReturn1, saleItemId: mixedChildItemId, variantId: mixedReplacementVariant,
  qty: 1, unitPrice: 500, lineTotal: 500
})
await assert.rejects(() => salesService.returnProvenancePreview({
  invoiceId: mixedChildInvoiceId, lines: [{ saleItemId: mixedChildItemId, qty: 1 }]
}), /تخصیص منشأ به قلم/,
'preview fails closed while an active return lacks its persisted source-attribution snapshot')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation" WHERE childInvoiceId=?',
  mixedChildInvoiceId).n, 0, 'a read-only preview never repairs or writes missing attribution')
const mixedChildAllocation1 = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: mixedChildReturn1, returnItemId: mixedChildReturnItem1
}))
assert.deepEqual(mixedChildAllocation1.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', amount: 300 }, { sourceKind: 'SOURCE_GIFT', amount: 200 }
])
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE returnId=?', mixedChildReturn1).n, 0,
  'accounting attribution alone creates no settlement or cash-right event')
const mixedAfterOneActiveReturnPreview = await salesService.returnProvenancePreview({
  invoiceId: mixedChildInvoiceId, lines: [{ saleItemId: mixedChildItemId, qty: 1 }]
})
assert.deepEqual(mixedAfterOneActiveReturnPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', amount: 300 }, { sourceKind: 'SOURCE_GIFT', amount: 200 }
])
assert.deepEqual(mixedAfterOneActiveReturnPreview.remainingAttributionBySource.map(({ sourceKind,
  alreadyReturnedAttribution, remainingAttribution }) => ({ sourceKind, alreadyReturnedAttribution,
  remainingAttribution })).sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', alreadyReturnedAttribution: 300, remainingAttribution: 300 },
  { sourceKind: 'SOURCE_GIFT', alreadyReturnedAttribution: 200, remainingAttribution: 200 }
])
assert.equal(mixedAfterOneActiveReturnPreview.settlementReady, false)
assert.equal(mixedAfterOneActiveReturnPreview.cashRight, 0)
const mixedChildReturn2 = makeMixedChildReturn()
const mixedChildReturnItem2 = seed.insert('SaleReturnItem', {
  returnId: mixedChildReturn2, saleItemId: mixedChildItemId, variantId: mixedReplacementVariant,
  qty: 1, unitPrice: 500, lineTotal: 500
})
const mixedChildAllocation2 = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: mixedChildReturn2, returnItemId: mixedChildReturnItem2
}))
assert.deepEqual(mixedChildAllocation2.shares.map(({ prior, amount, cumulative }) => ({ prior, amount, cumulative }))
  .sort((a, b) => a.prior - b.prior), [
  { prior: 200, amount: 200, cumulative: 400 }, { prior: 300, amount: 300, cumulative: 600 }
])
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnItemId=? AND eventKind=?', mixedChildReturnItem1, 'ALLOCATION'), 2)
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: mixedChildReturn1 })), /LIFO/)
const secondAllocationReversal = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: mixedChildReturn2 }))
assert.deepEqual(secondAllocationReversal, { reversed: 2, items: 1, replayed: false })
sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'test reverse newest mixed child allocation', mixedChildReturn2)
const secondAllocationReplay = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: mixedChildReturn2 }))
assert.deepEqual(secondAllocationReplay, { reversed: 2, items: 1, replayed: true })
const firstAllocationReversal = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: mixedChildReturn1 }))
assert.deepEqual(firstAllocationReversal, { reversed: 2, items: 1, replayed: false })
sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'test reverse oldest mixed child allocation', mixedChildReturn1)
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE childInvoiceId=? AND eventKind='REVERSAL'`, mixedChildInvoiceId).n, 4)
await assert.rejects(() => salesService.returnProvenancePreview({
  invoiceId: mixedChildInvoiceId, full: true
}), /تخصیص منشأ به قلم/,
'preview stays fail-closed when historical void/reversal rows exist until their full lifecycle is validated')
assert.equal(seed.one('SELECT status FROM "SaleInvoice" WHERE id=?', mixedChildInvoiceId).status, 'SETTLED')
const childInvoiceTotal = seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?', exactExchange.exchangeInvoiceId).grandTotal
sql.prepare('UPDATE "SaleInvoice" SET paidTotal=? WHERE id=?').run(childInvoiceTotal - 1, exactExchange.exchangeInvoiceId)
const debtfulChildFunding = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.equal(debtfulChildFunding.debt, 1)
assert.ok(debtfulChildFunding.unresolved.some((row) => row.kind === 'UNRESOLVED_EXCHANGE_CHILD_DEBT'))
assert.equal(debtfulChildFunding.lineAllocations.length, 0,
  'line attribution is withheld while child settlement is in debt')
sql.prepare('UPDATE "SaleInvoice" SET paidTotal=? WHERE id=?').run(childInvoiceTotal, exactExchange.exchangeInvoiceId)
const newTenderId = seed.insert('Payment', {
  invoiceId: exactExchange.exchangeInvoiceId, methodId: cashMethodId, amount: 1,
  kind: 'CASH', seq: 2, destination: 'CASH'
})
const childWithNewTender = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.ok(childWithNewTender.unresolved.some((row) => row.kind === 'UNJOURNALED_CHILD_PAYMENT'))
sql.prepare('DELETE FROM "Payment" WHERE id=?').run(newTenderId)
const exchangeCreditPayment = seed.one('SELECT methodId FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', exactExchange.exchangeInvoiceId)
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('CASH', exchangeCreditPayment.methodId)
const malformedChildFunding = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.ok(malformedChildFunding.unresolved.some((row) => row.kind === 'MALFORMED_EXCHANGE_CREDIT_PAYMENT'))
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('EXCHANGE_CREDIT', exchangeCreditPayment.methodId)
sql.prepare('UPDATE "Payment" SET destination=? WHERE invoiceId=? AND voidedAt IS NULL').run('CASH', exactExchange.exchangeInvoiceId)
const destinationSpoofedChildFunding = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.ok(destinationSpoofedChildFunding.unresolved.some((row) => row.kind === 'MALFORMED_EXCHANGE_CREDIT_PAYMENT'),
  'a cash-looking destination cannot turn EXCHANGE_CREDIT into payment evidence')
sql.prepare('UPDATE "Payment" SET destination=NULL WHERE invoiceId=? AND voidedAt IS NULL').run(exactExchange.exchangeInvoiceId)
const childGateBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).n,
  children: seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', exactExchange.exchangeInvoiceId).n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', exactSourceVariant, exactReplacementVariant)
}
await assert.rejects(() => salesService.createExchange({
  invoiceId: exactExchange.exchangeInvoiceId,
  lines: [{ saleItemId: exactChildItemId, qty: 1 }],
  replacements: [{ variantId: exactSourceVariant, qty: 1 }],
  refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
}), /تعویضِ این فاکتور/,
'proved child lineage is readable, but nested exchange stays closed until per-line allocation and rights are integrated')
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).n, childGateBefore.returns)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', exactExchange.exchangeInvoiceId).n, childGateBefore.children)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, childGateBefore.fundingEvents)
assert.deepEqual(seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', exactSourceVariant, exactReplacementVariant), childGateBefore.stock)
await assert.rejects(() => salesService.returnReconcileVoid({
  id: exactExchange.returnId, userId, reason: 'unsupported funding correction test',
  panelPassword: DEFAULT_MANAGER_PASSWORD, cashRecovered: 0, cardRecovered: 0,
  cashPaidOut: 0, cardPaidOut: 0, creditOutcome: 'NONE'
}), /دفتر انتقال منشأ مالی/,
'correction route cannot leave an active funding transfer behind')
assert.equal(balance(`payment:${exactSourcePayment.id}`), 0)
assert.equal(balance(childShareId), 1_000)

const exchangeVoid = await salesService.returnDelete({
  id: exactExchange.returnId, userId, reason: 'reverse exact-value ledger test', ...GATE
})
assert.equal(exchangeVoid.exchangeVoided, true)
assert.equal(balance(`payment:${exactSourcePayment.id}`), 1_000)
assert.equal(balance(childShareId), 0)
assert.equal(seed.one('SELECT voidedAt IS NOT NULL AS voided FROM "SaleReturn" WHERE id=?', exactExchange.returnId).voided, 1)
assert.equal(seed.one('SELECT voidedAt IS NOT NULL AS voided FROM "SaleInvoice" WHERE id=?', exactExchange.exchangeInvoiceId).voided, 1)
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingEvent"
  WHERE returnId=? AND kind IN ('VOID_TRANSFER_OUT','VOID_TRANSFER_IN')`, exactExchange.returnId).n, 2)
const transferVoidReplay = await db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: exactExchange.returnId, actorUserId: userId
}))
assert.deepEqual(transferVoidReplay, { reversed: 0, pairs: 1 }, 'a reversed transfer pair cannot restore the same source twice')
const exactFundingAfterVoid = await getCurrentSaleFundingSources(db, exactSale.id)
assert.deepEqual(exactFundingAfterVoid.activeReturnIds, [])
assert.equal(exactFundingAfterVoid.sources[0].available, 1_000)

// A caller-held return key is replay-safe and bound to the complete business
// payload; same-key concurrent retries produce one physical/financial effect.
const idempotentReturnVariant = variant(500)
const idempotentReturnSale = await salesService.create({
  userId, shiftId, lines: [{ ...line(idempotentReturnVariant, 500), qty: 2 }], payments: []
})
const idempotentReturnItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?',
  idempotentReturnSale.id).id
const returnRequest = {
  invoiceId: idempotentReturnSale.id, full: false,
  lines: [{ saleItemId: idempotentReturnItemId, qty: 1 }],
  refundMethod: RefundMethod.NONE, note: 'idempotency integration', userId, shiftId,
  idempotencyKey: 'return-request:integration-race-0001'
}
const stockBeforeReturnRequest = Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',
  idempotentReturnVariant).stock)
const startReturnRaceWorker = () => {
  const child = spawn(process.execPath, [
    '--import', './test/harness/register.mjs',
    'tests/audit-fixes/helpers/return-idempotency-worker.mjs',
    String(idempotentReturnSale.id), String(idempotentReturnItemId), String(userId), String(shiftId),
    returnRequest.idempotencyKey
  ], { cwd: process.cwd(), env: {
    ...process.env, HARNESS_DIR: dir, HARNESS_DB: process.env.HARNESS_DB, HARNESS_DB_EXISTING: '1'
  }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', sawReady = false, sawResult = false
  let resolveReady, rejectReady, resolveResult, rejectResult, resolveClose, rejectClose
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const closed = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.ready) { sawReady = true; resolveReady() }
      else if (typeof message.ok === 'boolean') {
        sawResult = true
        if (!message.ok && !sawReady) rejectReady(new Error(`return race worker failed before ready: ${JSON.stringify(message)}`))
        resolveResult(message)
      }
    } catch { /* ignore non-JSON diagnostics */ }
  })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', (error) => {
    rejectReady(error); rejectResult(error); rejectClose(error)
  })
  child.on('close', (code) => {
    if (code === 0) {
      if (!sawReady) rejectReady(new Error(`return race worker exited before ready: ${stderr}`))
      if (!sawResult) rejectResult(new Error(`return race worker exited before result: ${stderr}`))
      resolveClose()
    } else {
      const error = new Error(`return race worker exited ${code}: ${stderr}`)
      rejectReady(error); rejectResult(error); rejectClose(error)
    }
  })
  return { child, ready, result, closed }
}
const returnRaceWorkers = [startReturnRaceWorker(), startReturnRaceWorker()]
await Promise.all(returnRaceWorkers.map((worker) => worker.ready))
for (const worker of returnRaceWorkers) worker.child.stdin.end('go')
const concurrentReturnResults = await Promise.all(returnRaceWorkers.map((worker) => worker.result))
await Promise.all(returnRaceWorkers.map((worker) => worker.closed))
assert.ok(concurrentReturnResults.every((result) => result.ok), JSON.stringify(concurrentReturnResults))
assert.equal(concurrentReturnResults[0].returnId, concurrentReturnResults[1].returnId)
assert.deepEqual(concurrentReturnResults.map((result) => result.replayed).sort(), [false, true])
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE idempotencyKey=?',
  returnRequest.idempotencyKey).n, 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturnItem" WHERE returnId=?',
  concurrentReturnResults[0].returnId).n, 1)
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', idempotentReturnVariant).stock),
  stockBeforeReturnRequest, 'goods-receipt-required return retries do not mutate stock before physical intake')
const storedReturnRequest = seed.one('SELECT idempotencyFingerprint, idempotencyResponseJson FROM "SaleReturn" WHERE id=?',
  concurrentReturnResults[0].returnId)
assert.match(storedReturnRequest.idempotencyFingerprint, /^[a-f0-9]{64}$/)
assert.equal(JSON.parse(storedReturnRequest.idempotencyResponseJson).id, concurrentReturnResults[0].returnId)
assert.equal(storedReturnRequest.idempotencyResponseJson.includes('managerPassword'), false,
  'the immutable replay snapshot excludes manager credentials')
const sequentialReturnReplay = await salesService.createReturn(returnRequest)
assert.equal(sequentialReturnReplay.id, concurrentReturnResults[0].returnId)
assert.equal(sequentialReturnReplay.replayed, true)
const returnCountBeforeMismatch = seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?',
  idempotentReturnSale.id).n
await assert.rejects(() => salesService.createReturn({ ...returnRequest, note: 'different payload' }),
  /کلید درخواست برگشت قبلاً برای payload متفاوت/)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?',
  idempotentReturnSale.id).n, returnCountBeforeMismatch,
'same key with a changed note is rejected without a second return')

const safeSnapshotVariant = variant(500)
const safeSnapshotSale = await salesService.create({
  userId, shiftId, lines: [{ ...line(safeSnapshotVariant, 500), qty: 2 }],
  payments: [{ methodId: cashMethodId, amount: 1_000, destination: 'CASH' }]
})
const safeSnapshotItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', safeSnapshotSale.id).id
const safeSnapshotRequest = {
  invoiceId: safeSnapshotSale.id, full: false,
  lines: [{ saleItemId: safeSnapshotItemId, qty: 1 }], refundMethod: RefundMethod.STORE_CREDIT,
  refundAmount: 500, userId, shiftId, idempotencyKey: 'return-request:safe-snapshot-0001'
}
const safeSnapshotResponse = await salesService.createReturn(safeSnapshotRequest)
const issuedCredit = seed.one('SELECT id, code FROM "StoreCredit" WHERE returnId=?', safeSnapshotResponse.id)
const safeSnapshotJson = seed.one('SELECT idempotencyResponseJson FROM "SaleReturn" WHERE id=?',
  safeSnapshotResponse.id).idempotencyResponseJson
assert.ok(issuedCredit?.code)
assert.equal(JSON.stringify(safeSnapshotResponse).includes(issuedCredit.code), false)
assert.equal(safeSnapshotJson.includes(issuedCredit.code), false, 'replay snapshots never persist redeemable credit codes')
assert.equal(safeSnapshotJson.includes('storeCreditCode'), false)
assert.equal(safeSnapshotJson.includes('managerPassword'), false)
const safeSnapshotReplay = await salesService.createReturn(safeSnapshotRequest)
assert.equal(safeSnapshotReplay.id, safeSnapshotResponse.id)
assert.equal(safeSnapshotReplay.storeCredit.id, issuedCredit.id)
assert.equal(safeSnapshotReplay.replayed, true)

console.log('✓ SalesService funding integration: snapshot revisions, child attribution preview, retry-safe returns, safe snapshots, exact-cash lineage and reversal holds')
