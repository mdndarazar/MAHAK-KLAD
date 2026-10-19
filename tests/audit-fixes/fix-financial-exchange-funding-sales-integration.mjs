/** End-to-end funding journal integration for real SalesService mutations.
 * Exercises persisted sale/payment/cheque rows, automatic snapshot revisions,
 * append-only reversals and the conservative post-return hold. The exchange
 * credit gate is intentionally not changed by this test.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-funding-sales-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-sales-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const {
  getCurrentExchangeFundingSources,
  getCurrentSaleFundingSources,
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
const childFundingView = await getCurrentExchangeFundingSources(db, exactExchange.exchangeInvoiceId)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventCountBeforeLinePreview,
  'read-only line attribution does not append ledger events')
assert.equal(childFundingView.snapshotExists, true)
assert.equal(childFundingView.sources.length, 1)
assert.equal(childFundingView.sources[0].event.kind, 'TRANSFER_IN')
assert.equal(childFundingView.sources[0].sourceKind, 'SOURCE_CASH')
assert.equal(childFundingView.sources[0].sourceMethodKind, 'CASH')
assert.equal(childFundingView.sources[0].available, 1_000)
assert.deepEqual(childFundingView.unresolved, [], 'EXCHANGE_CREDIT is reconciled to the proven parent transfer, not treated as money')
const exactChildItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', exactExchange.exchangeInvoiceId).id
assert.equal(childFundingView.lineAllocationStatus, 'READ_ONLY_RECONCILED')
assert.deepEqual(childFundingView.lineAllocations, [{
  sourceEventId: childFundingView.sources[0].event.id,
  saleItemId: exactChildItemId, sourceKind: 'SOURCE_CASH', amount: 1_000
}], 'an untouched exact child can expose a read-only item attribution, not a persisted return right')
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

console.log('✓ SalesService funding integration: snapshot revisions, cheque transitions, exact cash exchange transfer and append-only reversal; stale shares remain blocked')
