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
const { transferExchangeFundingShare } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
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

console.log('✓ SalesService integration: create/payment/invoice edits revise r1–r5; cheque PENDING→CLEARED→BOUNCED and return auto-void/restore; stale shares stay blocked until safe reconciliation')
