import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-ledger-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { appendExchangeFundingEvent, recordSaleFundingSnapshot, getCurrentSaleFundingSources, exchangeFundingBalance,
  getCurrentExchangeFundingSources, recordExchangeFundingLineAllocations,
  recordExchangeFundingReturnLineAllocation, reverseExchangeFundingReturnLineAllocationsForReturn,
  transferExchangeFundingShare, reverseExchangeFundingTransferPair,
  reverseExchangeFundingTransfersForReturn } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'LEDGER-CASH', label: 'Ledger cash', kind: 'CASH', isActive: 1
})
const giftMethodId = seed.insert('PaymentMethod', {
  key: 'LEDGER-CREDIT', label: 'Ledger credit', kind: 'STORE_CREDIT', isActive: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'LEDGER-CARD', label: 'Ledger card', kind: 'CARD', isActive: 1
})
const exchangeCreditMethodId = seed.insert('PaymentMethod', {
  key: 'EXCHANGE_CREDIT', label: 'Exchange value', kind: 'EXCHANGE_CREDIT', isActive: 1
})
const ledgerCategoryId = seed.category('ledger allocation category')
const ledgerProductId = seed.product('ledger allocation item', ledgerCategoryId)
const ledgerLineVariants = [
  seed.variant(ledgerProductId, 'allocation line one'),
  seed.variant(ledgerProductId, 'allocation line two')
]

const base = {
  eventKey: 'sale:71:payment:301', kind: 'SOURCE_CASH', amount: 13_980_000,
  shareId: 'payment:301', rootShareId: 'payment:301', sourceInvoiceId: 71,
  sourcePaymentId: 301, sourceMethodKind: 'CASH', sourceDestination: 'CASH',
  evidenceKind: 'PAYMENT_ROW', evidenceRef: 'Payment:301'
}
const first = await db.$transaction((tx) => appendExchangeFundingEvent(tx, base))
assert.equal(first.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:301'), 13_980_000)

const replay = await db.$transaction((tx) => appendExchangeFundingEvent(tx, { ...base }))
assert.equal(replay.replayed, true, 'exact same event key and payload is an idempotent replay')
assert.equal(replay.event.id, first.event.id)
assert.equal(await exchangeFundingBalance(db, 'payment:301'), 13_980_000)

await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, amount: 13_000_000
})), /کلید عملیات قبلی/,
'event-key collision with a changed amount fails closed')
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'bad:unknown:source', amount: 0
})), /رویداد منشأ مالی معتبر نیست/)
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'bad:unsafe:source', amount: Number.MAX_SAFE_INTEGER + 1
})), /رویداد منشأ مالی معتبر نیست/)

const voidEventInput = {
  ...base, eventKey: `${base.eventKey}:void:r2`, kind: 'VOID_SOURCE_CASH', amount: -13_980_000,
  evidenceKind: 'PAYMENT_SNAPSHOT_REVISION', evidenceRef: 'snapshot:71:r2', reversesEventId: first.event.id
}
const voidEvent = await db.$transaction((tx) => appendExchangeFundingEvent(tx, voidEventInput))
assert.equal(voidEvent.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:301'), 0)
const voidReplay = await db.$transaction((tx) => appendExchangeFundingEvent(tx, voidEventInput))
assert.equal(voidReplay.replayed, true)
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...voidEventInput, eventKey: `${base.eventKey}:void:r3`
})), /UNIQUE constraint failed|رویداد منشأ مالی معتبر نیست/,
'a source event cannot be reversed twice')
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...voidEventInput, eventKey: `${base.eventKey}:void:r3`, amount: -1
})), /رویداد منشأ مالی معتبر نیست/)

async function cashSource(amount) {
  const invoice = seed.invoice({ grandTotal: amount, status: 'FINAL' })
  const paymentId = seed.insert('Payment', {
    invoiceId: invoice.id, methodId: cashMethodId, amount, kind: 'CASH', destination: 'CASH'
  })
  const snapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, invoice.id))
  const sourceEvent = snapshot.events.find((event) => event.kind === 'SOURCE_CASH' &&
    Number(event.sourcePaymentId) === paymentId)
  assert.ok(sourceEvent, 'source must come from a persisted Payment snapshot')
  return { invoiceId: invoice.id, paymentId, sourceEvent }
}

async function giftSource(amount, code, expiresAt, expiryCaptured = true, creditAmount = amount) {
  const invoice = seed.invoice({ grandTotal: amount, status: 'FINAL' })
  const creditId = seed.insert('StoreCredit', {
    code, amount: creditAmount, usedAmount: amount, usedCount: 1,
    status: expiresAt && expiresAt.getTime() <= Date.now() ? 'EXPIRED' :
      creditAmount > amount ? 'PARTIALLY_USED' : 'USED', expiresAt
  })
  const paymentId = seed.insert('Payment', {
    invoiceId: invoice.id, methodId: giftMethodId, amount, kind: 'CASH',
    storeCreditId: creditId
  })
  const redemptionId = seed.insert('StoreCreditRedemption', {
    creditId, code, amount, remainderAfter: 0, invoiceId: invoice.id, paymentId,
    idempotencyKey: `ledger-redemption-${code}`, expiryCaptured, expiryAtRedeem: expiresAt
  })
  const snapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, invoice.id))
  const sourceEvent = snapshot.events.find((event) => event.kind === 'SOURCE_GIFT' &&
    Number(event.sourceRedemptionId) === redemptionId)
  assert.ok(sourceEvent, 'gift source must be linked to one persisted redemption')
  return { invoiceId: invoice.id, paymentId, creditId, redemptionId, sourceEvent }
}

async function mixedSource(giftAmount, realAmount, code, expiresAt = null) {
  const total = giftAmount + realAmount
  const invoice = seed.invoice({ grandTotal: total, status: 'FINAL' })
  const creditId = seed.insert('StoreCredit', {
    code, amount: giftAmount, usedAmount: giftAmount, usedCount: 1,
    status: expiresAt && expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'USED', expiresAt
  })
  const giftPaymentId = seed.insert('Payment', {
    invoiceId: invoice.id, methodId: giftMethodId, amount: giftAmount,
    kind: 'CASH', seq: 1, storeCreditId: creditId
  })
  const cashPaymentId = seed.insert('Payment', {
    invoiceId: invoice.id, methodId: cashMethodId, amount: realAmount,
    kind: 'CASH', seq: 2, destination: 'CASH'
  })
  const redemptionId = seed.insert('StoreCreditRedemption', {
    creditId, code, amount: giftAmount, remainderAfter: 0, invoiceId: invoice.id, paymentId: giftPaymentId,
    idempotencyKey: `ledger-redemption-${code}`, expiryCaptured: true, expiryAtRedeem: expiresAt
  })
  const snapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, invoice.id))
  const giftEvent = snapshot.events.find((event) => event.kind === 'SOURCE_GIFT' &&
    Number(event.sourceRedemptionId) === redemptionId)
  const cashEvent = snapshot.events.find((event) => event.kind === 'SOURCE_CASH' &&
    Number(event.sourcePaymentId) === cashPaymentId)
  assert.ok(giftEvent && cashEvent, 'mixed source roots must come from the ordinary sale Payment and redemption rows')
  return { invoiceId: invoice.id, creditId, giftPaymentId, cashPaymentId, redemptionId, giftEvent, cashEvent }
}

function exchangeGraph(sourceInvoiceId, total, lineValues = [total]) {
  if (lineValues.reduce((sum, amount) => sum + amount, 0) !== total)
    throw new Error('exchangeGraph line values must reconcile to its invoice total')
  const child = seed.invoice({ grandTotal: total, status: 'SETTLED' })
  seed.insert('Payment', {
    invoiceId: child.id, methodId: exchangeCreditMethodId, amount: total,
    kind: 'CASH', seq: 1
  })
  sql.prepare('UPDATE "SaleInvoice" SET paidTotal=? WHERE id=?').run(total, child.id)
  lineValues.forEach((amount, index) => seed.invoiceItem(child.id, {
    variantId: ledgerLineVariants[index % ledgerLineVariants.length],
    qty: 1, lineTotal: amount, variantName: `exchange line ${index + 1}`
  }))
  const returnId = seed.insert('SaleReturn', {
    invoiceId: sourceInvoiceId, total,
    returnedAtJalali: '1405/07/27', kind: 'EXCHANGE'
  })
  sql.prepare(`UPDATE "SaleInvoice" SET orderType='EXCHANGE', sourceInvoiceId=?, exchangeReturnId=? WHERE id=?`)
    .run(sourceInvoiceId, returnId, child.id)
  sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=?, exchangeTotal=? WHERE id=?')
    .run(child.id, total, returnId)
  return { childInvoiceId: child.id, returnId }
}

const source = await cashSource(2_000)
const beforeUnreconciledRevision = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', source.invoiceId).n
await assert.rejects(() => db.$transaction((tx) => recordSaleFundingSnapshot(tx, source.invoiceId, 2)),
  /نسخهٔ قبلی snapshot هنوز به‌طور کامل ابطال نشده/,
'a new snapshot revision cannot duplicate still-live source shares')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', source.invoiceId).n,
  beforeUnreconciledRevision, 'a rejected revision attempt writes no snapshot events')

const firstGraph = exchangeGraph(source.invoiceId, 1_250)
const transferInput = {
  eventKey: `exchange:${source.invoiceId}:return:${firstGraph.returnId}:payment:${source.paymentId}`,
  sourceEventId: source.sourceEvent.id,
  sourceShareId: `payment:${source.paymentId}`,
  destinationShareId: `exchange:${firstGraph.childInvoiceId}:return:${firstGraph.returnId}:payment:${source.paymentId}`,
  rootShareId: `payment:${source.paymentId}`,
  amount: 1_250,
  sourceInvoiceId: source.invoiceId,
  childInvoiceId: firstGraph.childInvoiceId,
  returnId: firstGraph.returnId,
  evidenceRef: `SaleReturn:${firstGraph.returnId}`
}
const transferCountBeforeWrongInvoice = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput, eventKey: 'exchange:wrong-source-invoice', sourceInvoiceId: 999
})), /ماندهٔ سهم اثبات‌شده/,
'a caller cannot relabel a proven source share as belonging to a different invoice')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, transferCountBeforeWrongInvoice,
  'wrong source invoice is rejected before either transfer side is written')

const transfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, transferInput))
assert.equal(transfer.replayed, false)
assert.equal(await exchangeFundingBalance(db, `payment:${source.paymentId}`), 750)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 1_250)
const transferRetry = await db.$transaction((tx) => transferExchangeFundingShare(tx, transferInput))
assert.equal(transferRetry.replayed, true, 'same transfer retry is idempotent after source balance was reduced')
assert.equal(await exchangeFundingBalance(db, `payment:${source.paymentId}`), 750)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 1_250)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput, amount: 1_251
})), /کلید عملیات قبلی/,
  'a changed amount cannot reuse the previous transfer key')

const multiTenderInvoice = seed.invoice({ grandTotal: 1_000, status: 'FINAL' })
const multiTenderCashPayment = seed.insert('Payment', {
  invoiceId: multiTenderInvoice.id, methodId: cashMethodId, amount: 500, kind: 'CASH', destination: 'CASH'
})
const multiTenderCardPayment = seed.insert('Payment', {
  invoiceId: multiTenderInvoice.id, methodId: cardMethodId, amount: 500, kind: 'CASH', destination: 'CARD'
})
const multiTenderSnapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, multiTenderInvoice.id))
const multiTenderCashSource = multiTenderSnapshot.events.find((event) =>
  event.kind === 'SOURCE_CASH' && Number(event.sourcePaymentId) === multiTenderCashPayment)
const multiTenderCardSource = multiTenderSnapshot.events.find((event) =>
  event.kind === 'SOURCE_CARD' && Number(event.sourcePaymentId) === multiTenderCardPayment)
assert.ok(multiTenderCashSource && multiTenderCardSource)
const multiTenderGraph = exchangeGraph(multiTenderInvoice.id, 800)
const multiTenderCashTransferInput = {
  eventKey: `exchange:${multiTenderInvoice.id}:return:${multiTenderGraph.returnId}:cash`,
  sourceEventId: multiTenderCashSource.id, sourceShareId: `payment:${multiTenderCashPayment}`,
  destinationShareId: `exchange:${multiTenderGraph.childInvoiceId}:cash`,
  rootShareId: `payment:${multiTenderCashPayment}`, amount: 500,
  sourceInvoiceId: multiTenderInvoice.id, childInvoiceId: multiTenderGraph.childInvoiceId,
  returnId: multiTenderGraph.returnId
}
const multiTenderCashTransfer = await db.$transaction((tx) =>
  transferExchangeFundingShare(tx, multiTenderCashTransferInput))
const beforeReturnCapReject = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${multiTenderInvoice.id}:return:${multiTenderGraph.returnId}:card-over-cap`,
  sourceEventId: multiTenderCardSource.id, sourceShareId: `payment:${multiTenderCardPayment}`,
  destinationShareId: `exchange:${multiTenderGraph.childInvoiceId}:card-over-cap`,
  rootShareId: `payment:${multiTenderCardPayment}`, amount: 301,
  sourceInvoiceId: multiTenderInvoice.id, childInvoiceId: multiTenderGraph.childInvoiceId,
  returnId: multiTenderGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'the combined cash and card source shares cannot exceed the returned item value')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeReturnCapReject)
assert.equal(await exchangeFundingBalance(db, `payment:${multiTenderCardPayment}`), 500)

const multiTenderCardTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${multiTenderInvoice.id}:return:${multiTenderGraph.returnId}:card`,
  sourceEventId: multiTenderCardSource.id, sourceShareId: `payment:${multiTenderCardPayment}`,
  destinationShareId: `exchange:${multiTenderGraph.childInvoiceId}:card`,
  rootShareId: `payment:${multiTenderCardPayment}`, amount: 300,
  sourceInvoiceId: multiTenderInvoice.id, childInvoiceId: multiTenderGraph.childInvoiceId,
  returnId: multiTenderGraph.returnId
}))
assert.equal(await exchangeFundingBalance(db, multiTenderCashTransfer.inEvent.shareId), 500)
assert.equal(await exchangeFundingBalance(db, multiTenderCardTransfer.inEvent.shareId), 300)
const multiTenderCardVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: `void:exchange:${multiTenderGraph.childInvoiceId}:${multiTenderGraph.returnId}:card`,
  outEventId: multiTenderCardTransfer.outEvent.id, inEventId: multiTenderCardTransfer.inEvent.id
}))
assert.equal(multiTenderCardVoid.replayed, false)
assert.equal(await exchangeFundingBalance(db, multiTenderCardTransfer.inEvent.shareId), 0)
const multiTenderCardReallocated = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${multiTenderInvoice.id}:return:${multiTenderGraph.returnId}:card-reallocated`,
  sourceEventId: multiTenderCardSource.id, sourceShareId: `payment:${multiTenderCardPayment}`,
  destinationShareId: `exchange:${multiTenderGraph.childInvoiceId}:card-reallocated`,
  rootShareId: `payment:${multiTenderCardPayment}`, amount: 300,
  sourceInvoiceId: multiTenderInvoice.id, childInvoiceId: multiTenderGraph.childInvoiceId,
  returnId: multiTenderGraph.returnId
}))
assert.equal(await exchangeFundingBalance(db, multiTenderCardReallocated.inEvent.shareId), 300)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${multiTenderInvoice.id}:return:${multiTenderGraph.returnId}:card-over-cap-retry`,
  sourceEventId: multiTenderCardSource.id, sourceShareId: `payment:${multiTenderCardPayment}`,
  destinationShareId: `exchange:${multiTenderGraph.childInvoiceId}:card-over-cap-retry`,
  rootShareId: `payment:${multiTenderCardPayment}`, amount: 1,
  sourceInvoiceId: multiTenderInvoice.id, childInvoiceId: multiTenderGraph.childInvoiceId,
  returnId: multiTenderGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'the transfer value cap remains enforced once a return has consumed its full value')
const multiTenderDownstreamGraph = exchangeGraph(multiTenderGraph.childInvoiceId, 100)
const multiTenderDownstream = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${multiTenderGraph.childInvoiceId}:return:${multiTenderDownstreamGraph.returnId}:from-card`,
  sourceEventId: multiTenderCardReallocated.inEvent.id,
  sourceShareId: multiTenderCardReallocated.inEvent.shareId,
  destinationShareId: `exchange:${multiTenderDownstreamGraph.childInvoiceId}:from-card`,
  rootShareId: `payment:${multiTenderCardPayment}`, amount: 100,
  sourceInvoiceId: multiTenderGraph.childInvoiceId,
  childInvoiceId: multiTenderDownstreamGraph.childInvoiceId,
  returnId: multiTenderDownstreamGraph.returnId
}))
const bulkVoidEventsBeforeDescendantCheck = seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  multiTenderGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN')
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: multiTenderGraph.returnId
})), /سهم منتقل‌شده در سند فرزند/,
'bulk parent reversal must fail when a later transfer pair still has value in a descendant')
assert.equal(seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  multiTenderGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN'), bulkVoidEventsBeforeDescendantCheck,
'a rejected multi-pair reversal rolls back earlier pair inverses instead of partially restoring the source')
assert.equal(await exchangeFundingBalance(db, multiTenderCashTransfer.inEvent.shareId), 500)
const downstreamTransferVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: `void:exchange:${multiTenderDownstreamGraph.childInvoiceId}:${multiTenderDownstreamGraph.returnId}`,
  outEventId: multiTenderDownstream.outEvent.id, inEventId: multiTenderDownstream.inEvent.id
}))
assert.equal(downstreamTransferVoid.replayed, false)
const multiPairVoid = await db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: multiTenderGraph.returnId
}))
assert.deepEqual(multiPairVoid, { reversed: 2, pairs: 3 },
  'bulk reversal reverses both live pairs and counts the already-reversed card pair exactly once')
assert.equal(await exchangeFundingBalance(db, multiTenderCashTransfer.inEvent.shareId), 0)
assert.equal(await exchangeFundingBalance(db, multiTenderCardReallocated.inEvent.shareId), 0)
const multiPairVoidRows = seed.rows(`SELECT reversesEventId FROM "ExchangeFundingEvent"
  WHERE returnId=? AND kind IN ('VOID_TRANSFER_OUT','VOID_TRANSFER_IN') ORDER BY id`, multiTenderGraph.returnId)
assert.equal(multiPairVoidRows.length, 6, 'three transfer pairs have exactly one inverse per side')
assert.equal(new Set(multiPairVoidRows.map((row) => Number(row.reversesEventId))).size, 6,
  'bulk reversal never reuses a source event id or duplicates an inverse')
const multiPairVoidCount = multiPairVoidRows.length
const multiPairVoidReplay = await db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: multiTenderGraph.returnId
}))
assert.deepEqual(multiPairVoidReplay, { reversed: 0, pairs: 3 },
  'replaying bulk reversal never restores a transfer twice')
assert.equal(seed.rows(`SELECT reversesEventId FROM "ExchangeFundingEvent"
  WHERE returnId=? AND kind IN ('VOID_TRANSFER_OUT','VOID_TRANSFER_IN')`, multiTenderGraph.returnId).length,
  multiPairVoidCount, 'bulk reversal replay creates no additional void events')

const overpayInvoice = seed.invoice({ grandTotal: 400, status: 'FINAL' })
const overpayPaymentId = seed.insert('Payment', {
  invoiceId: overpayInvoice.id, methodId: cashMethodId, amount: 500, kind: 'CASH', destination: 'CASH'
})
const overpaySnapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, overpayInvoice.id))
const overpaySource = overpaySnapshot.events.find((event) =>
  event.kind === 'SOURCE_CASH' && Number(event.sourcePaymentId) === overpayPaymentId)
assert.equal(Number(overpaySource.amount), 400)
assert.equal(await exchangeFundingBalance(db, `overpay:${overpayPaymentId}`), 100)
const overpayGraph = exchangeGraph(overpayInvoice.id, 400)
const overpayTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${overpayInvoice.id}:return:${overpayGraph.returnId}:funded-only`,
  sourceEventId: overpaySource.id, sourceShareId: `payment:${overpayPaymentId}`,
  destinationShareId: `exchange:${overpayGraph.childInvoiceId}:funded-only`,
  rootShareId: `payment:${overpayPaymentId}`, amount: 400,
  sourceInvoiceId: overpayInvoice.id, childInvoiceId: overpayGraph.childInvoiceId,
  returnId: overpayGraph.returnId
}))
assert.equal(await exchangeFundingBalance(db, overpayTransfer.inEvent.shareId), 400)
assert.equal(await exchangeFundingBalance(db, `overpay:${overpayPaymentId}`), 100,
  'cash overpayment remains quarantined and is not copied into the returned-goods share')

const overdrawGraph = exchangeGraph(source.invoiceId, 751)
const countBeforeOverdraw = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput,
  eventKey: `exchange:${source.invoiceId}:return:${overdrawGraph.returnId}:payment:${source.paymentId}`,
  destinationShareId: `exchange:${overdrawGraph.childInvoiceId}:return:${overdrawGraph.returnId}:payment:${source.paymentId}`,
  amount: 751, childInvoiceId: overdrawGraph.childInvoiceId, returnId: overdrawGraph.returnId,
  evidenceRef: `SaleReturn:${overdrawGraph.returnId}`
})), /ماندهٔ سهم اثبات‌شده/,
'available source balance is enforced before any new transfer')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, countBeforeOverdraw,
  'an overdraw attempt leaves both shares unchanged')

const unknownInvoice = seed.invoice({ grandTotal: 500, status: 'FINAL' })
const unknown = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: `sale:${unknownInvoice.id}:unknown:303`, kind: 'SOURCE_UNKNOWN', amount: 500,
  shareId: 'unknown:303', rootShareId: 'unknown:303', sourceInvoiceId: unknownInvoice.id,
  evidenceKind: 'UNRESOLVED_LEGACY'
}))
const unknownGraph = exchangeGraph(unknownInvoice.id, 100)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${unknownInvoice.id}:return:${unknownGraph.returnId}:unknown`, sourceEventId: unknown.event.id,
  sourceShareId: 'unknown:303', destinationShareId: `child:unknown:${unknownGraph.returnId}`,
  rootShareId: 'unknown:303', amount: 100, sourceInvoiceId: unknownInvoice.id,
  childInvoiceId: unknownGraph.childInvoiceId, returnId: unknownGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'UNKNOWN is quarantined and never becomes transferable merely because it has an amount')

const labeledCash = await cashSource(150)
for (const legacyKind of ['SOURCE_B', 'SOURCE_N']) {
  const legacyLabel = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
    eventKey: `sale:${labeledCash.invoiceId}:legacy:${legacyKind}:${labeledCash.paymentId}`,
    kind: legacyKind, amount: 150, shareId: `legacy:${legacyKind}:${labeledCash.paymentId}`,
    rootShareId: `payment:${labeledCash.paymentId}`, sourceInvoiceId: labeledCash.invoiceId,
    sourcePaymentId: labeledCash.paymentId, sourceMethodKind: 'CASH', sourceDestination: 'CASH',
    evidenceKind: 'PAYMENT_ROW', evidenceRef: `Payment:${labeledCash.paymentId}`
  }))
  const legacyGraph = exchangeGraph(labeledCash.invoiceId, 100)
  await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
    eventKey: `exchange:${labeledCash.invoiceId}:return:${legacyGraph.returnId}:${legacyKind}`,
    sourceEventId: legacyLabel.event.id, sourceShareId: `legacy:${legacyKind}:${labeledCash.paymentId}`,
    destinationShareId: `exchange:${legacyGraph.childInvoiceId}:${legacyKind}`,
    rootShareId: `payment:${labeledCash.paymentId}`, amount: 100,
    sourceInvoiceId: labeledCash.invoiceId, childInvoiceId: legacyGraph.childInvoiceId,
    returnId: legacyGraph.returnId
  })), /ماندهٔ سهم اثبات‌شده/,
  `${legacyKind} stays quarantined even when a Payment row exists`)
}

const superseded = await cashSource(180)
await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: `sale:${superseded.invoiceId}:r2:revision-marker`, kind: 'SOURCE_UNKNOWN', amount: 1,
  shareId: `revision-marker:${superseded.invoiceId}`, rootShareId: `revision-marker:${superseded.invoiceId}`,
  sourceInvoiceId: superseded.invoiceId, evidenceKind: 'UNRESOLVED_LEGACY'
}))
const supersededGraph = exchangeGraph(superseded.invoiceId, 100)
const eventsBeforeSupersededTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${superseded.invoiceId}:return:${supersededGraph.returnId}:old-revision`,
  sourceEventId: superseded.sourceEvent.id, sourceShareId: `payment:${superseded.paymentId}`,
  destinationShareId: `exchange:${supersededGraph.childInvoiceId}:old-revision`,
  rootShareId: `payment:${superseded.paymentId}`, amount: 100,
  sourceInvoiceId: superseded.invoiceId, childInvoiceId: supersededGraph.childInvoiceId,
  returnId: supersededGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'transfer cannot select a valid-looking source from a superseded snapshot revision')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventsBeforeSupersededTransfer)

const fabricatedInvoice = seed.invoice({ grandTotal: 100, status: 'FINAL' })
const fabricated = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: `sale:${fabricatedInvoice.id}:r1:payment:999999:funded`, kind: 'SOURCE_CASH', amount: 100,
  shareId: 'payment:999999', rootShareId: 'payment:999999', sourceInvoiceId: fabricatedInvoice.id,
  sourcePaymentId: 999_999, sourceMethodKind: 'CASH', sourceDestination: 'CASH',
  evidenceKind: 'PAYMENT_ROW', evidenceRef: 'Payment:999999'
}))
const fabricatedGraph = exchangeGraph(fabricatedInvoice.id, 100)
const beforeFabricatedTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${fabricatedInvoice.id}:return:${fabricatedGraph.returnId}:fake-payment`,
  sourceEventId: fabricated.event.id, sourceShareId: 'payment:999999',
  destinationShareId: `exchange:${fabricatedGraph.childInvoiceId}:fake-payment`,
  rootShareId: 'payment:999999', amount: 100, sourceInvoiceId: fabricatedInvoice.id,
  childInvoiceId: fabricatedGraph.childInvoiceId, returnId: fabricatedGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a syntactically valid SOURCE_CASH event is not proof without the matching live Payment row')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeFabricatedTransfer)

const tampered = await cashSource(500)
sql.prepare('UPDATE "Payment" SET amount=400 WHERE id=?').run(tampered.paymentId)
const tamperedGraph = exchangeGraph(tampered.invoiceId, 100)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${tampered.invoiceId}:return:${tamperedGraph.returnId}:stale-payment`,
  sourceEventId: tampered.sourceEvent.id, sourceShareId: `payment:${tampered.paymentId}`,
  destinationShareId: `exchange:${tamperedGraph.childInvoiceId}:stale-payment`,
  rootShareId: `payment:${tampered.paymentId}`, amount: 100,
  sourceInvoiceId: tampered.invoiceId, childInvoiceId: tamperedGraph.childInvoiceId,
  returnId: tamperedGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a source snapshot must still reconcile to the currently persisted Payment amount')

const methodTampered = await cashSource(250)
sql.prepare('UPDATE "Payment" SET methodId=? WHERE id=?').run(giftMethodId, methodTampered.paymentId)
const methodGraph = exchangeGraph(methodTampered.invoiceId, 100)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${methodTampered.invoiceId}:return:${methodGraph.returnId}:stale-method`,
  sourceEventId: methodTampered.sourceEvent.id,
  sourceShareId: `payment:${methodTampered.paymentId}`,
  destinationShareId: `exchange:${methodGraph.childInvoiceId}:stale-method`,
  rootShareId: `payment:${methodTampered.paymentId}`, amount: 100,
  sourceInvoiceId: methodTampered.invoiceId, childInvoiceId: methodGraph.childInvoiceId,
  returnId: methodGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'the source snapshot must still match the persisted Payment method')

const liveGift = await giftSource(500, 'LEDGER-GIFT-LIVE', null, true, 1_000)
const giftGraph = exchangeGraph(liveGift.invoiceId, 500)
const giftTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${liveGift.invoiceId}:return:${giftGraph.returnId}:redemption:${liveGift.redemptionId}`,
  sourceEventId: liveGift.sourceEvent.id,
  sourceShareId: `redemption:${liveGift.redemptionId}`,
  destinationShareId: `exchange:${giftGraph.childInvoiceId}:redemption:${liveGift.redemptionId}`,
  rootShareId: `credit:${liveGift.creditId}`, amount: 500,
  sourceInvoiceId: liveGift.invoiceId, childInvoiceId: giftGraph.childInvoiceId, returnId: giftGraph.returnId
}))
assert.equal(giftTransfer.replayed, false)
assert.equal(await exchangeFundingBalance(db, `redemption:${liveGift.redemptionId}`), 0)
assert.equal(await exchangeFundingBalance(db, `exchange:${giftGraph.childInvoiceId}:redemption:${liveGift.redemptionId}`), 500)
const giftChildFunding = await getCurrentExchangeFundingSources(db, giftGraph.childInvoiceId)
assert.equal(giftChildFunding.unresolved.length, 0)
assert.equal(giftChildFunding.sources.length, 1)
assert.equal(giftChildFunding.sources[0].event.kind, 'TRANSFER_IN')
assert.equal(giftChildFunding.sources[0].sourceKind, 'SOURCE_GIFT')
assert.equal(giftChildFunding.sources[0].event.rootShareId, `credit:${liveGift.creditId}`)
assert.equal(giftChildFunding.sources[0].available, 500)
assert.equal(giftChildFunding.lineAllocations.length, 1)
assert.equal(giftChildFunding.lineAllocations[0].amount, 500)

const mixedSale = await mixedSource(300, 700, 'LEDGER-GIFT-CASH-LINES')
const mixedGraph = exchangeGraph(mixedSale.invoiceId, 1_000, [700, 300])
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${mixedSale.invoiceId}:return:${mixedGraph.returnId}:source:${mixedSale.giftEvent.id}`,
  sourceEventId: mixedSale.giftEvent.id, sourceShareId: `redemption:${mixedSale.redemptionId}`,
  destinationShareId: `exchange:${mixedGraph.childInvoiceId}:return:${mixedGraph.returnId}:source:${mixedSale.giftEvent.id}`,
  rootShareId: `credit:${mixedSale.creditId}`, amount: 300,
  sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId, returnId: mixedGraph.returnId
}))
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${mixedSale.invoiceId}:return:${mixedGraph.returnId}:source:${mixedSale.cashEvent.id}`,
  sourceEventId: mixedSale.cashEvent.id, sourceShareId: `payment:${mixedSale.cashPaymentId}`,
  destinationShareId: `exchange:${mixedGraph.childInvoiceId}:return:${mixedGraph.returnId}:source:${mixedSale.cashEvent.id}`,
  rootShareId: `payment:${mixedSale.cashPaymentId}`, amount: 700,
  sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId, returnId: mixedGraph.returnId
}))
const mixedChildFunding = await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)
const mixedChildLines = seed.rows('SELECT id, qty, lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', mixedGraph.childInvoiceId)
assert.deepEqual(mixedChildFunding.unresolved, [])
assert.equal(mixedChildFunding.sources.length, 2)
const mixedGiftIncomingEventId = mixedChildFunding.sources.find((source) => source.sourceKind === 'SOURCE_GIFT').event.id
const mixedCashIncomingEventId = mixedChildFunding.sources.find((source) => source.sourceKind === 'SOURCE_CASH').event.id
assert.deepEqual(mixedChildFunding.lineAllocations, [
  { sourceEventId: mixedGiftIncomingEventId, saleItemId: mixedChildLines[0].id,
    sourceKind: 'SOURCE_GIFT', amount: 210 },
  { sourceEventId: mixedGiftIncomingEventId, saleItemId: mixedChildLines[1].id,
    sourceKind: 'SOURCE_GIFT', amount: 90 },
  { sourceEventId: mixedCashIncomingEventId, saleItemId: mixedChildLines[0].id,
    sourceKind: 'SOURCE_CASH', amount: 490 },
  { sourceEventId: mixedCashIncomingEventId, saleItemId: mixedChildLines[1].id,
    sourceKind: 'SOURCE_CASH', amount: 210 }
], 'the child view exposes a reconciled per-item split of the original gift and cash carries')
assert.equal(mixedChildFunding.lineAllocationStatus, 'READ_ONLY_RECONCILED')
const persistedLineResult = await db.$transaction((tx) =>
  recordExchangeFundingLineAllocations(tx, mixedGraph.childInvoiceId))
assert.deepEqual(persistedLineResult, { invoiceId: mixedGraph.childInvoiceId, allocationCount: 4, replayed: false })
const persistedMixedLines = seed.rows(`SELECT sourceInvoiceId, childInvoiceId, returnId, sourceEventId,
  saleItemId, saleItemQty, saleItemValue, sourceKind, amount FROM "ExchangeFundingLineAllocation"
  WHERE childInvoiceId=? ORDER BY sourceEventId, saleItemId`, mixedGraph.childInvoiceId)
assert.deepEqual(persistedMixedLines, [
  { sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, sourceEventId: mixedGiftIncomingEventId,
    saleItemId: mixedChildLines[0].id, saleItemQty: 1, saleItemValue: mixedChildLines[0].lineTotal,
    sourceKind: 'SOURCE_GIFT', amount: 210 },
  { sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, sourceEventId: mixedGiftIncomingEventId,
    saleItemId: mixedChildLines[1].id, saleItemQty: 1, saleItemValue: mixedChildLines[1].lineTotal,
    sourceKind: 'SOURCE_GIFT', amount: 90 },
  { sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, sourceEventId: mixedCashIncomingEventId,
    saleItemId: mixedChildLines[0].id, saleItemQty: 1, saleItemValue: mixedChildLines[0].lineTotal,
    sourceKind: 'SOURCE_CASH', amount: 490 },
  { sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, sourceEventId: mixedCashIncomingEventId,
    saleItemId: mixedChildLines[1].id, saleItemQty: 1, saleItemValue: mixedChildLines[1].lineTotal,
    sourceKind: 'SOURCE_CASH', amount: 210 }
])
const persistedFundingView = await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)
assert.equal(persistedFundingView.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(persistedFundingView.lineAllocations, mixedChildFunding.lineAllocations)
const lineAllocationCountBeforeReplay = seed.count('ExchangeFundingLineAllocation', 'childInvoiceId=?', mixedGraph.childInvoiceId)
assert.deepEqual(await db.$transaction((tx) =>
  recordExchangeFundingLineAllocations(tx, mixedGraph.childInvoiceId)),
{ invoiceId: mixedGraph.childInvoiceId, allocationCount: 4, replayed: true },
'persisting an identical matrix is idempotent')
assert.equal(seed.count('ExchangeFundingLineAllocation', 'childInvoiceId=?', mixedGraph.childInvoiceId),
  lineAllocationCountBeforeReplay)

// A tiny gift share can round to a zero delta on an early partial return. The
// zero row must retain SOURCE_GIFT identity and receive its own reversal.
const zeroDeltaSource = await mixedSource(1, 999, 'LEDGER-ZERO-DELTA-GIFT')
const zeroDeltaGraph = exchangeGraph(zeroDeltaSource.invoiceId, 1000)
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${zeroDeltaSource.invoiceId}:return:${zeroDeltaGraph.returnId}:gift-zero-delta`,
  sourceEventId: zeroDeltaSource.giftEvent.id,
  sourceShareId: `redemption:${zeroDeltaSource.redemptionId}`,
  destinationShareId: `exchange:${zeroDeltaGraph.childInvoiceId}:gift-zero-delta`,
  rootShareId: `credit:${zeroDeltaSource.creditId}`, amount: 1,
  sourceInvoiceId: zeroDeltaSource.invoiceId, childInvoiceId: zeroDeltaGraph.childInvoiceId,
  returnId: zeroDeltaGraph.returnId
}))
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${zeroDeltaSource.invoiceId}:return:${zeroDeltaGraph.returnId}:cash-zero-delta`,
  sourceEventId: zeroDeltaSource.cashEvent.id,
  sourceShareId: `payment:${zeroDeltaSource.cashPaymentId}`,
  destinationShareId: `exchange:${zeroDeltaGraph.childInvoiceId}:cash-zero-delta`,
  rootShareId: `payment:${zeroDeltaSource.cashPaymentId}`, amount: 999,
  sourceInvoiceId: zeroDeltaSource.invoiceId, childInvoiceId: zeroDeltaGraph.childInvoiceId,
  returnId: zeroDeltaGraph.returnId
}))
const zeroDeltaSaleItem = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?',
  zeroDeltaGraph.childInvoiceId)
sql.prepare('UPDATE "SaleInvoiceItem" SET qty=100, unitPrice=10 WHERE id=?').run(zeroDeltaSaleItem.id)
await db.$transaction((tx) => recordExchangeFundingLineAllocations(tx, zeroDeltaGraph.childInvoiceId))
const zeroDeltaReturnId = seed.insert('SaleReturn', {
  invoiceId: zeroDeltaGraph.childInvoiceId, isFull: false, total: 10,
  returnedAt: new Date(), returnedAtJalali: '1405/07/27', returnedAtTime: '12:00:00',
  kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
})
const zeroDeltaReturnItemId = seed.insert('SaleReturnItem', {
  returnId: zeroDeltaReturnId, saleItemId: Number(zeroDeltaSaleItem.id),
  variantId: Number(zeroDeltaSaleItem.variantId), qty: 1, unitPrice: 10,
  lineTotal: 10, restockedQty: 0
})
await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: zeroDeltaReturnId, returnItemId: zeroDeltaReturnItemId
}))
const zeroDeltaRows = seed.rows(`SELECT sourceKind, amountDelta, cumulativeAmount FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='ALLOCATION' ORDER BY sourceEventId`, zeroDeltaReturnItemId)
assert.deepEqual(zeroDeltaRows, [
  { sourceKind: 'SOURCE_GIFT', amountDelta: 0, cumulativeAmount: 0 },
  { sourceKind: 'SOURCE_CASH', amountDelta: 10, cumulativeAmount: 10 }
], 'a zero gift delta remains an explicit gift row; it is never reclassified as cash')
const zeroDeltaAllocationCount = seed.count('ExchangeFundingReturnLineAllocation', 'returnId=?', zeroDeltaReturnId)
const zeroDeltaReplay = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: zeroDeltaReturnId, returnItemId: zeroDeltaReturnItemId
}))
assert.equal(zeroDeltaReplay.replayed, true,
  'an exact replay of a zero-delta attribution returns the existing append-only rows')
assert.equal(zeroDeltaReplay.allocationCount, 2)
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnId=?', zeroDeltaReturnId),
  zeroDeltaAllocationCount, 'exact zero-delta replay appends no duplicate rows')
const zeroGiftAllocationId = Number(seed.one(`SELECT id FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='ALLOCATION' AND sourceKind='SOURCE_GIFT'`, zeroDeltaReturnItemId).id)
assert.throws(() => sql.prepare(`UPDATE "ExchangeFundingReturnLineAllocation" SET amountDelta=1 WHERE id=?`)
  .run(zeroGiftAllocationId), /append-only/,
'a zero-valued gift attribution cannot be rewritten into cash')
assert.throws(() => sql.prepare('DELETE FROM "ExchangeFundingReturnLineAllocation" WHERE id=?')
  .run(zeroGiftAllocationId), /append-only/,
'a zero-valued gift attribution cannot be deleted to hide its source')
const zeroDeltaReversal = await db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: zeroDeltaReturnId }))
assert.deepEqual(zeroDeltaReversal, { reversed: 2, items: 1, replayed: false })
const zeroGiftReversal = seed.one(`SELECT sourceKind, amountDelta FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnItemId=? AND eventKind='REVERSAL' AND sourceKind='SOURCE_GIFT'`, zeroDeltaReturnItemId)
assert.deepEqual(zeroGiftReversal, { sourceKind: 'SOURCE_GIFT', amountDelta: 0 },
  'the explicit zero gift allocation must have an explicit zero reversal')
sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
  .run(Date.now(), 'zero-delta fixture reversed', zeroDeltaReturnId)
const raceReturnId = seed.insert('SaleReturn', {
  invoiceId: zeroDeltaGraph.childInvoiceId, isFull: false, total: 10,
  returnedAt: new Date(), returnedAtJalali: '1405/07/27', returnedAtTime: '12:01:00',
  kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
})
const raceReturnItemId = seed.insert('SaleReturnItem', {
  returnId: raceReturnId, saleItemId: Number(zeroDeltaSaleItem.id),
  variantId: Number(zeroDeltaSaleItem.variantId), qty: 1, unitPrice: 10,
  lineTotal: 10, restockedQty: 0
})
const allocationWorkerSource = `
  import { createInterface } from 'node:readline'
  const { harnessClient } = await import('file://' + process.cwd() + '/test/harness/stubs/prismaClient.mjs')
  const { recordExchangeFundingReturnLineAllocation } = await import('file://' + process.cwd() + '/src/main/services/ExchangeFundingLedgerService.ts')
  const db = harnessClient()
  const input = createInterface({ input: process.stdin })
  console.log(JSON.stringify({ ready: true }))
  await new Promise((resolve) => input.once('line', resolve))
  input.close()
  try {
    const result = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
      returnId: Number(process.env.RACE_RETURN_ID),
      returnItemId: Number(process.env.RACE_RETURN_ITEM_ID)
    }))
    console.log(JSON.stringify({ ok: true, replayed: result.replayed, allocationCount: result.allocationCount }))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  }
  await db.$disconnect()
`
const startAllocationWorker = () => {
  let resolveReady; let rejectReady; let resolveResult; let rejectResult; let resolveClosed; let rejectClosed
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  let stderr = ''
  const child = spawn(process.execPath, [
    '--import', './test/harness/register.mjs', '--input-type=module', '-e', allocationWorkerSource
  ], { cwd: process.cwd(), env: { ...process.env, HARNESS_DB_EXISTING: '1',
    RACE_RETURN_ID: String(raceReturnId), RACE_RETURN_ITEM_ID: String(raceReturnItemId) } })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.ready) resolveReady()
      else if (typeof message.ok === 'boolean') resolveResult(message)
    } catch { /* ignore diagnostics not emitted as JSON */ }
  })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', (error) => { rejectReady(error); rejectResult(error); rejectClosed(error) })
  child.on('close', (code) => {
    if (code === 0) resolveClosed()
    else {
      const error = new Error(`allocation race worker exited ${code}: ${stderr}`)
      rejectReady(error); rejectResult(error); rejectClosed(error)
    }
  })
  return { child, ready, result, closed }
}
const allocationRaceWorkers = [startAllocationWorker(), startAllocationWorker()]
await Promise.all(allocationRaceWorkers.map((worker) => worker.ready))
for (const worker of allocationRaceWorkers) worker.child.stdin.end('go\n')
const allocationRaceResults = await Promise.all(allocationRaceWorkers.map((worker) => worker.result))
await Promise.all(allocationRaceWorkers.map((worker) => worker.closed))
assert.ok(allocationRaceResults.some((worker) => worker.ok), JSON.stringify(allocationRaceResults))
assert.ok(allocationRaceResults.every((worker) => worker.ok || /busy|locked|unique/i.test(worker.error)),
  JSON.stringify(allocationRaceResults))
assert.equal(allocationRaceResults.filter((worker) => worker.ok && !worker.replayed).length, 1,
  `exactly one independent writer creates the allocation set: ${JSON.stringify(allocationRaceResults)}`)
assert.ok(allocationRaceResults.filter((worker) => worker.ok)
  .every((worker) => worker.allocationCount === 2), JSON.stringify(allocationRaceResults))
const allocationAfterRace = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
  returnId: raceReturnId, returnItemId: raceReturnItemId
}))
assert.equal(allocationAfterRace.replayed, true,
  'a fresh retry after independent-connection contention resolves to the persisted allocation')
assert.equal(seed.count('ExchangeFundingReturnLineAllocation', 'returnItemId=? AND eventKind=?',
  raceReturnItemId, 'ALLOCATION'), 2,
'concurrent independent writers persist exactly one complete two-source allocation set')

const createReturnChunk = async (qty, value, time) => {
  const chunkReturnId = seed.insert('SaleReturn', {
    invoiceId: zeroDeltaGraph.childInvoiceId, isFull: false, total: value,
    returnedAt: new Date(), returnedAtJalali: '1405/07/27', returnedAtTime: time,
    kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
  })
  const chunkItemId = seed.insert('SaleReturnItem', {
    returnId: chunkReturnId, saleItemId: Number(zeroDeltaSaleItem.id),
    variantId: Number(zeroDeltaSaleItem.variantId), qty, unitPrice: 10,
    lineTotal: value, restockedQty: 0
  })
  const allocation = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
    returnId: chunkReturnId, returnItemId: chunkItemId
  }))
  assert.equal(allocation.shares.reduce((sum, share) => sum + share.amount, 0), value,
    'each persisted return chunk must reconcile exactly to its physical line amount')
  assert.ok(allocation.shares.every((share) => share.cumulative >= share.prior && share.amount >= 0),
    'source shares cannot decline or become negative between return chunks')
  return { returnId: chunkReturnId, itemId: chunkItemId, allocation }
}
const secondReturnChunk = await createReturnChunk(50, 500, '12:02:00')
const finalReturnChunk = await createReturnChunk(49, 490, '12:03:00')
const allActiveChunks = [raceReturnId, secondReturnChunk.returnId, finalReturnChunk.returnId]
const chunkReportRows = await salesService.returnList({
  fromJalali: '1405/07/27', toJalali: '1405/07/27', take: 500
})
const expectedChunkSources = [
  { returnId: raceReturnId, total: 10, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 10 }, { sourceKind: 'SOURCE_GIFT', amount: 0 }
  ] },
  { returnId: secondReturnChunk.returnId, total: 500, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 499 }, { sourceKind: 'SOURCE_GIFT', amount: 1 }
  ] },
  { returnId: finalReturnChunk.returnId, total: 490, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 490 }, { sourceKind: 'SOURCE_GIFT', amount: 0 }
  ] }
]
for (const expected of expectedChunkSources) {
  const row = chunkReportRows.find((candidate) => candidate.id === expected.returnId)
  assert.ok(row, `return report includes physical chunk ${expected.returnId}`)
  assert.equal(row.fundingAttribution.status, 'ATTRIBUTION_ONLY')
  assert.equal(row.fundingAttribution.settlementReady, false)
  assert.deepEqual(row.fundingAttribution.sources, expected.sources)
  assert.equal(row.fundingAttribution.sources.reduce((sum, source) => sum + source.amount, 0), expected.total)
  assert.equal(row.refundAmount, 0)
  assert.equal(row.cashRefundAmount, 0)
}
const allActiveChunksReportTotal = expectedChunkSources.reduce((sum, chunk) => sum + chunk.total, 0)
assert.equal(allActiveChunksReportTotal, 1_000,
  'reports reconcile 1/50/49 physical chunks cumulatively without turning attribution into payout')

// Reorder the same economic chunks to 1/49/50 on an equivalent source graph.
// The one gift rial moves to the 49-unit return, while the final source totals
// remain exactly one gift and 999 cash; report rows must preserve event order.
const reorderedSource = await mixedSource(1, 999, 'LEDGER-RETURN-CHUNK-ORDER-B')
const reorderedGraph = exchangeGraph(reorderedSource.invoiceId, 1_000)
const reorderedSourceView = await getCurrentSaleFundingSources(db, reorderedSource.invoiceId)
await db.$transaction(async (tx) => {
  for (const source of reorderedSourceView.sources) {
    await transferExchangeFundingShare(tx, {
      eventKey: `exchange:${reorderedSource.invoiceId}:return:${reorderedGraph.returnId}:order:${source.event.id}`,
      sourceEventId: source.event.id, sourceShareId: source.event.shareId,
      destinationShareId: `exchange:${reorderedGraph.childInvoiceId}:order:${source.event.id}`,
      rootShareId: source.event.rootShareId, amount: source.available,
      sourceInvoiceId: reorderedSource.invoiceId, childInvoiceId: reorderedGraph.childInvoiceId,
      returnId: reorderedGraph.returnId
    })
  }
})
const reorderedSaleItem = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?',
  reorderedGraph.childInvoiceId)
sql.prepare('UPDATE "SaleInvoiceItem" SET qty=100, unitPrice=10 WHERE id=?').run(reorderedSaleItem.id)
await db.$transaction((tx) => recordExchangeFundingLineAllocations(tx, reorderedGraph.childInvoiceId))
const reorderedReturns = []
for (const [qty, time] of [[1, '13:01:00'], [49, '13:02:00'], [50, '13:03:00']]) {
  const returnId = seed.insert('SaleReturn', {
    invoiceId: reorderedGraph.childInvoiceId, isFull: false, total: qty * 10,
    returnedAt: new Date(), returnedAtJalali: '1405/07/27', returnedAtTime: time,
    kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
  })
  const returnItemId = seed.insert('SaleReturnItem', {
    returnId, saleItemId: Number(reorderedSaleItem.id), variantId: Number(reorderedSaleItem.variantId),
    qty, unitPrice: 10, lineTotal: qty * 10, restockedQty: 0
  })
  await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, { returnId, returnItemId }))
  reorderedReturns.push({ returnId, total: qty * 10 })
}
const reorderedReportRows = await salesService.returnList({
  fromJalali: '1405/07/27', toJalali: '1405/07/27', take: 500
})
const expectedReorderedSources = [
  { returnId: reorderedReturns[0].returnId, total: 10, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 10 }, { sourceKind: 'SOURCE_GIFT', amount: 0 }
  ] },
  { returnId: reorderedReturns[1].returnId, total: 490, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 489 }, { sourceKind: 'SOURCE_GIFT', amount: 1 }
  ] },
  { returnId: reorderedReturns[2].returnId, total: 500, sources: [
    { sourceKind: 'SOURCE_CASH', amount: 500 }, { sourceKind: 'SOURCE_GIFT', amount: 0 }
  ] }
]
for (const expected of expectedReorderedSources) {
  const row = reorderedReportRows.find((candidate) => candidate.id === expected.returnId)
  assert.ok(row, `reordered report includes return ${expected.returnId}`)
  assert.equal(row.fundingAttribution.status, 'ATTRIBUTION_ONLY')
  assert.deepEqual(row.fundingAttribution.sources, expected.sources)
  assert.equal(row.fundingAttribution.sources.reduce((sum, source) => sum + source.amount, 0), expected.total)
  assert.equal(row.cashRefundAmount, 0)
}
assert.notDeepEqual(expectedReorderedSources[1].sources, expectedChunkSources[2].sources,
  'the 49-unit physical event receives a different gift/cash delta depending on return order, while each order reconciles')
assert.deepEqual(expectedReorderedSources.reduce((all, chunk) => {
  for (const source of chunk.sources) all[source.sourceKind] = (all[source.sourceKind] ?? 0) + source.amount
  return all
}, {}), { SOURCE_CASH: 999, SOURCE_GIFT: 1 },
'1/49/50 order preserves the exact original cumulative cash/gift totals')
const chunkedSourceTotals = seed.rows(`SELECT sourceKind, SUM(amountDelta) AS amount
  FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId IN (?, ?, ?) AND eventKind='ALLOCATION'
  GROUP BY sourceKind ORDER BY sourceKind`, ...allActiveChunks)
assert.deepEqual(chunkedSourceTotals, [
  { sourceKind: 'SOURCE_CASH', amount: 999 },
  { sourceKind: 'SOURCE_GIFT', amount: 1 }
], 'different return chunk sizes restore the exact original cash/gift source matrix')
assert.equal(seed.one(`SELECT SUM(returningQty) AS qty FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId IN (?, ?, ?) AND eventKind='ALLOCATION' AND sourceKind='SOURCE_CASH'`,
  ...allActiveChunks).qty, 100)
const reversalsBeforeLifoProbe = seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId IN (?, ?, ?) AND eventKind='REVERSAL'`, ...allActiveChunks).n
await assert.rejects(() => db.$transaction((tx) =>
  reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: raceReturnId })),
/LIFO|برگشت قدیمی‌تر|جدیدتر/iu,
'an older partial return cannot be reversed while later active returns still depend on its cumulative baseline')
assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId IN (?, ?, ?) AND eventKind='REVERSAL'`, ...allActiveChunks).n,
  reversalsBeforeLifoProbe, 'a rejected out-of-order reversal appends no partial inverse rows')
for (const chunk of [finalReturnChunk, secondReturnChunk, { returnId: raceReturnId }]) {
  const reversedChunk = await db.$transaction((tx) =>
    reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: chunk.returnId }))
  assert.deepEqual(reversedChunk, { reversed: 2, items: 1, replayed: false },
    'each newest active chunk reverses both source rows atomically')
  sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
    .run(Date.now(), 'test LIFO child allocation reversal', chunk.returnId)
}
const reversedChunkTotals = seed.rows(`SELECT sourceKind, SUM(amountDelta) AS amount
  FROM "ExchangeFundingReturnLineAllocation"
  WHERE returnId IN (?, ?, ?) AND eventKind='REVERSAL'
  GROUP BY sourceKind ORDER BY sourceKind`, ...allActiveChunks)
assert.deepEqual(reversedChunkTotals, [
  { sourceKind: 'SOURCE_CASH', amount: -999 },
  { sourceKind: 'SOURCE_GIFT', amount: -1 }
], 'LIFO reversals release the exact cash/gift lineage without converting the zero gift delta')

// Expiry changes transferability, not historical source attribution. Funding
// transferred before expiry can still be allocated to post-expiry physical
// returns, but this accounting-only path must never create a cash/credit right.
const sourceExpiry = new Date(Date.now() + 60_000)
const expiryReturnSource = await mixedSource(300, 700, 'LEDGER-RETURN-AFTER-EXPIRY', sourceExpiry)
const expiryReturnGraph = exchangeGraph(expiryReturnSource.invoiceId, 1_000)
const expiryGiftTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${expiryReturnSource.invoiceId}:return:${expiryReturnGraph.returnId}:gift-before-expiry`,
  sourceEventId: expiryReturnSource.giftEvent.id,
  sourceShareId: `redemption:${expiryReturnSource.redemptionId}`,
  destinationShareId: `exchange:${expiryReturnGraph.childInvoiceId}:gift-before-expiry`,
  rootShareId: `credit:${expiryReturnSource.creditId}`, amount: 300,
  sourceInvoiceId: expiryReturnSource.invoiceId, childInvoiceId: expiryReturnGraph.childInvoiceId,
  returnId: expiryReturnGraph.returnId
}))
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${expiryReturnSource.invoiceId}:return:${expiryReturnGraph.returnId}:cash-before-expiry`,
  sourceEventId: expiryReturnSource.cashEvent.id,
  sourceShareId: `payment:${expiryReturnSource.cashPaymentId}`,
  destinationShareId: `exchange:${expiryReturnGraph.childInvoiceId}:cash-before-expiry`,
  rootShareId: `payment:${expiryReturnSource.cashPaymentId}`, amount: 700,
  sourceInvoiceId: expiryReturnSource.invoiceId, childInvoiceId: expiryReturnGraph.childInvoiceId,
  returnId: expiryReturnGraph.returnId
}))
const expiryReturnLine = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?',
  expiryReturnGraph.childInvoiceId)
sql.prepare('UPDATE "SaleInvoiceItem" SET qty=100, unitPrice=10 WHERE id=?').run(expiryReturnLine.id)
await db.$transaction((tx) => recordExchangeFundingLineAllocations(tx, expiryReturnGraph.childInvoiceId))
const expiredNestedGraph = exchangeGraph(expiryReturnGraph.childInvoiceId, 100)
sql.prepare('UPDATE "StoreCredit" SET status=? WHERE id=?').run('EXPIRED', expiryReturnSource.creditId)
const expiryClockBefore = Date.now
const postExpiry = sourceExpiry.getTime() + 1
const expiryChunks = []
const settlementBeforeExpiredAttribution = {
  credits: seed.count('StoreCredit'),
  movements: seed.count('CashMovement'),
  entitlements: seed.count('ReturnEntitlement'),
  fundingEvents: seed.count('ExchangeFundingEvent')
}
Date.now = () => postExpiry
try {
  const eventsBeforeExpiredNestedTransfer = seed.count('ExchangeFundingEvent')
  await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
    eventKey: `exchange:${expiryReturnGraph.childInvoiceId}:return:${expiredNestedGraph.returnId}:expired-gift-descendant`,
    sourceEventId: expiryGiftTransfer.inEvent.id,
    sourceShareId: expiryGiftTransfer.inEvent.shareId,
    destinationShareId: `exchange:${expiredNestedGraph.childInvoiceId}:expired-gift-descendant`,
    rootShareId: `credit:${expiryReturnSource.creditId}`, amount: 100,
    sourceInvoiceId: expiryReturnGraph.childInvoiceId,
    childInvoiceId: expiredNestedGraph.childInvoiceId, returnId: expiredNestedGraph.returnId
  })), /ماندهٔ سهم اثبات‌شده/,
  'a post-expiry child cannot carry an expired gift root into another exchange')
  assert.equal(seed.count('ExchangeFundingEvent'), eventsBeforeExpiredNestedTransfer,
    'rejected post-expiry descendant transfer appends no funding events')
  assert.equal(await exchangeFundingBalance(db, expiryGiftTransfer.inEvent.shareId), 300,
    'the rejected descendant transfer leaves the child gift share untouched')

  const createExpiredChunk = async (qty, value, time) => {
    const returnId = seed.insert('SaleReturn', {
      invoiceId: expiryReturnGraph.childInvoiceId, isFull: false, total: value,
      returnedAt: new Date(postExpiry), returnedAtJalali: '1405/07/28', returnedAtTime: time,
      kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
    })
    const returnItemId = seed.insert('SaleReturnItem', {
      returnId, saleItemId: Number(expiryReturnLine.id), variantId: Number(expiryReturnLine.variantId),
      qty, unitPrice: 10, lineTotal: value, restockedQty: 0
    })
    const allocation = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
      returnId, returnItemId
    }))
    expiryChunks.push({ returnId, returnItemId, allocation })
  }
  await createExpiredChunk(40, 400, '12:04:00')
  await createExpiredChunk(60, 600, '12:05:00')
} finally {
  Date.now = expiryClockBefore
}
assert.deepEqual(expiryChunks.map((chunk) => chunk.allocation.shares.reduce((sum, share) => sum + share.amount, 0)),
  [400, 600], 'post-expiry accounting attribution still reconciles both physical return chunks')
const expiredReturnIds = expiryChunks.map((chunk) => chunk.returnId)
const expiredAttributionTotals = seed.rows(`SELECT sourceKind, SUM(amountDelta) AS amount
  FROM "ExchangeFundingReturnLineAllocation" WHERE returnId IN (?, ?) AND eventKind='ALLOCATION'
  GROUP BY sourceKind ORDER BY sourceKind`, ...expiredReturnIds)
assert.deepEqual(expiredAttributionTotals, [
  { sourceKind: 'SOURCE_CASH', amount: 700 },
  { sourceKind: 'SOURCE_GIFT', amount: 300 }
], 'expired gift provenance remains gift in historical return attribution')
const expiredReturnReport = await salesService.returnList({
  fromJalali: '1405/07/28', toJalali: '1405/07/28', take: 500
})
for (const chunk of expiryChunks) {
  const row = expiredReturnReport.find((candidate) => candidate.id === chunk.returnId)
  assert.ok(row, 'post-expiry physical child return remains visible in history')
  assert.equal(row.fundingAttribution.status, 'ATTRIBUTION_ONLY')
  assert.equal(row.fundingAttribution.settlementReady, false)
  assert.equal(row.fundingAttribution.sources.reduce((sum, source) => sum + source.amount, 0),
    chunk.allocation.shares.reduce((sum, share) => sum + share.amount, 0))
  assert.equal(row.refundAmount, 0)
}
const expiredReportTotals = Object.fromEntries(expiredReturnReport
  .filter((row) => expiredReturnIds.includes(row.id))
  .flatMap((row) => row.fundingAttribution.sources)
  .reduce((totals, source) => {
    totals.set(source.sourceKind, (totals.get(source.sourceKind) ?? 0) + source.amount)
    return totals
  }, new Map()))
assert.deepEqual(expiredReportTotals, { SOURCE_CASH: 700, SOURCE_GIFT: 300 },
  'post-expiry report preserves gift lineage as attribution only, never as cash right')
assert.deepEqual({
  credits: seed.count('StoreCredit'), movements: seed.count('CashMovement'),
  entitlements: seed.count('ReturnEntitlement'), fundingEvents: seed.count('ExchangeFundingEvent')
}, settlementBeforeExpiredAttribution,
'post-expiry accounting attribution creates no credit, cash movement, entitlement, or funding settlement event')
Date.now = () => postExpiry
try {
  await assert.rejects(() => db.$transaction((tx) =>
    reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: expiryChunks[0].returnId })),
  /LIFO|برگشت قدیمی‌تر|جدیدتر/iu,
  'post-expiry earlier return remains LIFO-locked while later return is active')
  const expiredLastReversal = await db.$transaction((tx) =>
    reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: expiryChunks[1].returnId }))
  assert.deepEqual(expiredLastReversal, { reversed: 2, items: 1, replayed: false })
  sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
    .run(postExpiry, 'post-expiry child return reversal test', expiryChunks[1].returnId)
  const expiredFirstReversal = await db.$transaction((tx) =>
    reverseExchangeFundingReturnLineAllocationsForReturn(tx, { returnId: expiryChunks[0].returnId }))
  assert.deepEqual(expiredFirstReversal, { reversed: 2, items: 1, replayed: false })
  sql.prepare('UPDATE "SaleReturn" SET voidedAt=?, voidReason=? WHERE id=?')
    .run(postExpiry, 'post-expiry child return reversal test', expiryChunks[0].returnId)
  const expiredReversalTotals = seed.rows(`SELECT sourceKind, SUM(amountDelta) AS amount
    FROM "ExchangeFundingReturnLineAllocation" WHERE returnId IN (?, ?) AND eventKind='REVERSAL'
    GROUP BY sourceKind ORDER BY sourceKind`, ...expiredReturnIds)
  assert.deepEqual(expiredReversalTotals, [
    { sourceKind: 'SOURCE_CASH', amount: -700 },
    { sourceKind: 'SOURCE_GIFT', amount: -300 }
  ], 'post-expiry LIFO reversal keeps expired gift historical and never converts it to cash')
} finally {
  Date.now = expiryClockBefore
}

const mixedGiftSource = mixedChildFunding.sources.find((source) => source.sourceKind === 'SOURCE_GIFT')
const mixedCashSource = mixedChildFunding.sources.find((source) => source.sourceKind === 'SOURCE_CASH')
const shiftedGiftBalance = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: 'test:line-balance:gift-plus', kind: 'TEST_BALANCE_SHIFT', amount: 10,
  shareId: mixedGiftSource.event.shareId, rootShareId: mixedGiftSource.event.rootShareId,
  sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
  returnId: mixedGraph.returnId, parentEventId: mixedGiftIncomingEventId, evidenceKind: 'TEST'
}))
const shiftedCashBalance = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: 'test:line-balance:cash-minus', kind: 'TEST_BALANCE_SHIFT', amount: -10,
  shareId: mixedCashSource.event.shareId, rootShareId: mixedCashSource.event.rootShareId,
  sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
  returnId: mixedGraph.returnId, parentEventId: mixedCashIncomingEventId, evidenceKind: 'TEST'
}))
const offsettingSourceBalances = await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)
assert.equal(offsettingSourceBalances.lineAllocationStatus, 'UNAVAILABLE')
assert.equal(offsettingSourceBalances.lineAllocations.length, 0)
assert.ok(offsettingSourceBalances.unresolved.some((row) => row.kind === 'EXCHANGE_LINE_SOURCE_BALANCE_MISMATCH'),
  'offsetting per-source balance errors cannot pass merely because their grand total reconciles')
await db.$transaction(async (tx) => {
  await appendExchangeFundingEvent(tx, {
    eventKey: `${shiftedGiftBalance.event.eventKey}:void:r2`, kind: 'VOID_TEST_BALANCE_SHIFT', amount: -10,
    shareId: mixedGiftSource.event.shareId, rootShareId: mixedGiftSource.event.rootShareId,
    sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, parentEventId: mixedGiftIncomingEventId,
    evidenceKind: 'PAYMENT_SNAPSHOT_REVISION', reversesEventId: shiftedGiftBalance.event.id
  })
  await appendExchangeFundingEvent(tx, {
    eventKey: `${shiftedCashBalance.event.eventKey}:void:r2`, kind: 'VOID_TEST_BALANCE_SHIFT', amount: 10,
    shareId: mixedCashSource.event.shareId, rootShareId: mixedCashSource.event.rootShareId,
    sourceInvoiceId: mixedSale.invoiceId, childInvoiceId: mixedGraph.childInvoiceId,
    returnId: mixedGraph.returnId, parentEventId: mixedCashIncomingEventId,
    evidenceKind: 'PAYMENT_SNAPSHOT_REVISION', reversesEventId: shiftedCashBalance.event.id
  })
})
assert.equal((await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)).lineAllocationStatus,
  'PERSISTED_RECONCILED', 'exact source balances restore the existing persisted matrix')

sql.prepare('UPDATE "SaleInvoiceItem" SET lineTotal=lineTotal+10 WHERE id=?').run(mixedChildLines[0].id)
const changedChildLineFunding = await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)
assert.equal(changedChildLineFunding.lineAllocationStatus, 'UNAVAILABLE')
assert.equal(changedChildLineFunding.lineAllocations.length, 0)
assert.ok(changedChildLineFunding.unresolved.some((row) => row.kind === 'PERSISTED_EXCHANGE_LINE_ALLOCATION_MISMATCH'),
  'changing an allocated invoice line cannot silently reuse its old source matrix')
await assert.rejects(() => db.$transaction((tx) =>
  recordExchangeFundingLineAllocations(tx, mixedGraph.childInvoiceId)), /تخصیص قلمی/)
sql.prepare('UPDATE "SaleInvoiceItem" SET lineTotal=lineTotal-10 WHERE id=?').run(mixedChildLines[0].id)
assert.equal((await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)).lineAllocationStatus,
  'PERSISTED_RECONCILED', 'restoring the immutable line value restores the exact matrix view')
sql.prepare('UPDATE "SaleInvoiceItem" SET qty=qty+1 WHERE id=?').run(mixedChildLines[0].id)
const changedChildQuantityFunding = await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)
assert.equal(changedChildQuantityFunding.lineAllocationStatus, 'UNAVAILABLE')
assert.ok(changedChildQuantityFunding.unresolved.some((row) => row.kind === 'PERSISTED_EXCHANGE_LINE_ALLOCATION_MISMATCH'),
  'a quantity-only edit cannot silently change the future partial-return denominator')
sql.prepare('UPDATE "SaleInvoiceItem" SET qty=qty-1 WHERE id=?').run(mixedChildLines[0].id)
assert.equal((await getCurrentExchangeFundingSources(db, mixedGraph.childInvoiceId)).lineAllocationStatus,
  'PERSISTED_RECONCILED', 'restoring the item quantity restores the frozen line scope')

const rollbackSource = await cashSource(500)
const rollbackGraph = exchangeGraph(rollbackSource.invoiceId, 500)
const rollbackEventsBefore = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction(async (tx) => {
  await transferExchangeFundingShare(tx, {
    eventKey: `exchange:${rollbackSource.invoiceId}:return:${rollbackGraph.returnId}:source:${rollbackSource.sourceEvent.id}`,
    sourceEventId: rollbackSource.sourceEvent.id, sourceShareId: `payment:${rollbackSource.paymentId}`,
    destinationShareId: `exchange:${rollbackGraph.childInvoiceId}:return:${rollbackGraph.returnId}:source:${rollbackSource.sourceEvent.id}`,
    rootShareId: `payment:${rollbackSource.paymentId}`, amount: 500,
    sourceInvoiceId: rollbackSource.invoiceId, childInvoiceId: rollbackGraph.childInvoiceId,
    returnId: rollbackGraph.returnId
  })
  await recordExchangeFundingLineAllocations(tx, rollbackGraph.childInvoiceId)
  throw new Error('injected failure after funding line allocation')
}), /injected failure after funding line allocation/)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, rollbackEventsBefore,
  'transfer events roll back with a later failure in the same exchange transaction')
assert.equal(seed.count('ExchangeFundingLineAllocation', 'childInvoiceId=?', rollbackGraph.childInvoiceId), 0,
  'the immutable line matrix rolls back atomically with its transfer pair')
assert.equal(await exchangeFundingBalance(db, `payment:${rollbackSource.paymentId}`), 500)

const beforeMismatchedReverse = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: 'void:exchange:mismatched-pair', outEventId: transfer.outEvent.id, inEventId: giftTransfer.inEvent.id
})), /رویداد منشأ مالی معتبر نیست/,
'the reversal API refuses to pair one transfer-out with another exchange transfer-in')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeMismatchedReverse)

const expiredGift = await giftSource(200, 'LEDGER-GIFT-EXPIRED', new Date(Date.now() - 1_000))
const expiredGraph = exchangeGraph(expiredGift.invoiceId, 200)
const beforeExpiredGiftTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${expiredGift.invoiceId}:return:${expiredGraph.returnId}:redemption:${expiredGift.redemptionId}`,
  sourceEventId: expiredGift.sourceEvent.id,
  sourceShareId: `redemption:${expiredGift.redemptionId}`,
  destinationShareId: `exchange:${expiredGraph.childInvoiceId}:redemption:${expiredGift.redemptionId}`,
  rootShareId: `credit:${expiredGift.creditId}`, amount: 200,
  sourceInvoiceId: expiredGift.invoiceId, childInvoiceId: expiredGraph.childInvoiceId,
  returnId: expiredGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'expired gift provenance is not reopened as a usable exchange share')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeExpiredGiftTransfer)

const uncapturedExpiry = await giftSource(100, 'LEDGER-GIFT-UNCAPTURED-EXPIRY', null, false)
const uncapturedExpiryGraph = exchangeGraph(uncapturedExpiry.invoiceId, 100)
const beforeUncapturedExpiryTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${uncapturedExpiry.invoiceId}:return:${uncapturedExpiryGraph.returnId}:uncaptured-expiry`,
  sourceEventId: uncapturedExpiry.sourceEvent.id,
  sourceShareId: `redemption:${uncapturedExpiry.redemptionId}`,
  destinationShareId: `exchange:${uncapturedExpiryGraph.childInvoiceId}:uncaptured-expiry`,
  rootShareId: `credit:${uncapturedExpiry.creditId}`, amount: 100,
  sourceInvoiceId: uncapturedExpiry.invoiceId, childInvoiceId: uncapturedExpiryGraph.childInvoiceId,
  returnId: uncapturedExpiryGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a gift redemption without a captured expiry decision cannot fund an exchange')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeUncapturedExpiryTransfer)

const expiryDrift = await giftSource(150, 'LEDGER-GIFT-EXPIRY-DRIFT', null)
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?')
  .run(new Date(Date.now() + 86_400_000).toISOString(), expiryDrift.creditId)
const expiryDriftGraph = exchangeGraph(expiryDrift.invoiceId, 100)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${expiryDrift.invoiceId}:return:${expiryDriftGraph.returnId}:expiry-drift`,
  sourceEventId: expiryDrift.sourceEvent.id,
  sourceShareId: `redemption:${expiryDrift.redemptionId}`,
  destinationShareId: `exchange:${expiryDriftGraph.childInvoiceId}:expiry-drift`,
  rootShareId: `credit:${expiryDrift.creditId}`, amount: 100,
  sourceInvoiceId: expiryDrift.invoiceId, childInvoiceId: expiryDriftGraph.childInvoiceId,
  returnId: expiryDriftGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'credit expiry metadata cannot drift after the redemption snapshot')

const cancelledLinkSource = await cashSource(90)
const cancelledLinkGraph = exchangeGraph(cancelledLinkSource.invoiceId, 50)
sql.prepare('UPDATE "SaleReturn" SET voidedAt=? WHERE id=?')
  .run(new Date().toISOString(), cancelledLinkGraph.returnId)
const beforeCancelledLinkTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${cancelledLinkSource.invoiceId}:return:${cancelledLinkGraph.returnId}:voided-link`,
  sourceEventId: cancelledLinkSource.sourceEvent.id,
  sourceShareId: `payment:${cancelledLinkSource.paymentId}`,
  destinationShareId: `exchange:${cancelledLinkGraph.childInvoiceId}:voided-link`,
  rootShareId: `payment:${cancelledLinkSource.paymentId}`, amount: 50,
  sourceInvoiceId: cancelledLinkSource.invoiceId, childInvoiceId: cancelledLinkGraph.childInvoiceId,
  returnId: cancelledLinkGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a voided exchange return is no longer an active transfer link')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeCancelledLinkTransfer)

const mismatchedLinkSource = await cashSource(120)
const mismatchedLinkGraph = exchangeGraph(mismatchedLinkSource.invoiceId, 50)
sql.prepare('UPDATE "SaleReturn" SET exchangeTotal=exchangeTotal+1 WHERE id=?')
  .run(mismatchedLinkGraph.returnId)
const beforeMismatchedLinkTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${mismatchedLinkSource.invoiceId}:return:${mismatchedLinkGraph.returnId}:mismatched-link`,
  sourceEventId: mismatchedLinkSource.sourceEvent.id,
  sourceShareId: `payment:${mismatchedLinkSource.paymentId}`,
  destinationShareId: `exchange:${mismatchedLinkGraph.childInvoiceId}:mismatched-link`,
  rootShareId: `payment:${mismatchedLinkSource.paymentId}`, amount: 50,
  sourceInvoiceId: mismatchedLinkSource.invoiceId, childInvoiceId: mismatchedLinkGraph.childInvoiceId,
  returnId: mismatchedLinkGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a mismatched exchange-total link is not treated as an active exchange')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, beforeMismatchedLinkTransfer)

const voidedSource = await cashSource(300)
await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: `${voidedSource.sourceEvent.eventKey}:void:r2`,
  kind: 'VOID_SOURCE_CASH', amount: -300, shareId: `payment:${voidedSource.paymentId}`,
  rootShareId: `payment:${voidedSource.paymentId}`, sourceInvoiceId: voidedSource.invoiceId,
  sourcePaymentId: voidedSource.paymentId, sourceMethodKind: 'CASH', sourceDestination: 'CASH',
  evidenceKind: 'PAYMENT_SNAPSHOT_REVISION', reversesEventId: voidedSource.sourceEvent.id
}))
const voidedGraph = exchangeGraph(voidedSource.invoiceId, 100)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${voidedSource.invoiceId}:return:${voidedGraph.returnId}:voided-source`,
  sourceEventId: voidedSource.sourceEvent.id,
  sourceShareId: `payment:${voidedSource.paymentId}`,
  destinationShareId: `exchange:${voidedGraph.childInvoiceId}:voided-source`,
  rootShareId: `payment:${voidedSource.paymentId}`, amount: 100,
  sourceInvoiceId: voidedSource.invoiceId, childInvoiceId: voidedGraph.childInvoiceId,
  returnId: voidedGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a source event that has been reversed is not a live provenance root')

const reverseInput = {
  eventKey: `void:exchange:${firstGraph.childInvoiceId}:${firstGraph.returnId}`,
  outEventId: transfer.outEvent.id, inEventId: transfer.inEvent.id,
  evidenceRef: `SALE_INVOICE:${firstGraph.childInvoiceId}`
}
const reversed = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, reverseInput))
assert.equal(reversed.replayed, false)
assert.equal(await exchangeFundingBalance(db, `payment:${source.paymentId}`), 2_000)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 0)
const reversedChildFunding = await getCurrentExchangeFundingSources(db, firstGraph.childInvoiceId)
assert.equal(reversedChildFunding.sources.length, 0)
assert.ok(reversedChildFunding.unresolved.some((row) => row.kind === 'REVERSED_EXCHANGE_TRANSFER'))
const reversedAgain = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, reverseInput))
assert.equal(reversedAgain.replayed, true)
assert.equal(await exchangeFundingBalance(db, `payment:${source.paymentId}`), 2_000)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 0)
const eventsBeforeWrongReverseReplay = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  ...reverseInput, eventKey: 'void:exchange:wrong-replay-key'
})), /کلید عملیات قبلی/,
'a transfer pair cannot be reversed a second time under a different operation key')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventsBeforeWrongReverseReplay)

const nextGraph = exchangeGraph(firstGraph.childInvoiceId, 100)
const eventsBeforeReversedLineage = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${firstGraph.childInvoiceId}:return:${nextGraph.returnId}:reversed-parent`,
  sourceEventId: transfer.inEvent.id, sourceShareId: transferInput.destinationShareId,
  destinationShareId: `exchange:${nextGraph.childInvoiceId}:reversed-parent`,
  rootShareId: `payment:${source.paymentId}`, amount: 100,
  sourceInvoiceId: firstGraph.childInvoiceId, childInvoiceId: nextGraph.childInvoiceId,
  returnId: nextGraph.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a reversed transfer-in cannot be recycled as a live downstream source')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventsBeforeReversedLineage)

const orphanGraph = exchangeGraph(source.invoiceId, 100)
const orphanIn = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: `exchange:orphan:${orphanGraph.returnId}:in`, kind: 'TRANSFER_IN', amount: 100,
  shareId: `exchange:${orphanGraph.childInvoiceId}:orphan`, rootShareId: `payment:${source.paymentId}`,
  sourceInvoiceId: source.invoiceId, childInvoiceId: orphanGraph.childInvoiceId,
  returnId: orphanGraph.returnId, parentEventId: source.sourceEvent.id,
  evidenceKind: 'EXCHANGE_TRANSFER', evidenceRef: `SaleReturn:${orphanGraph.returnId}`
}))
const orphanChildFunding = await getCurrentExchangeFundingSources(db, orphanGraph.childInvoiceId)
assert.equal(orphanChildFunding.sources.length, 0)
assert.ok(orphanChildFunding.unresolved.some((row) => row.kind === 'INVALID_EXCHANGE_TRANSFER_LINK'))
const orphanReturnVoidCountBefore = seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  orphanGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN')
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: orphanGraph.returnId
})), /رویداد منشأ مالی معتبر نیست/,
'a return with only an orphan transfer-in cannot report a successful bulk reversal')
assert.equal(seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  orphanGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN'), orphanReturnVoidCountBefore,
'orphan pair reversal fails without writing either inverse side')
const orphanDownstream = exchangeGraph(orphanGraph.childInvoiceId, 50)
const eventsBeforeOrphanLineage = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${orphanGraph.childInvoiceId}:return:${orphanDownstream.returnId}:orphan`,
  sourceEventId: orphanIn.event.id, sourceShareId: orphanIn.shareId,
  destinationShareId: `exchange:${orphanDownstream.childInvoiceId}:orphan`,
  rootShareId: `payment:${source.paymentId}`, amount: 50,
  sourceInvoiceId: orphanGraph.childInvoiceId, childInvoiceId: orphanDownstream.childInvoiceId,
  returnId: orphanDownstream.returnId
})), /ماندهٔ سهم اثبات‌شده/,
'a lone positive TRANSFER_IN without its matching TRANSFER_OUT is not provenance')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n, eventsBeforeOrphanLineage)

const chainedGraph = exchangeGraph(source.invoiceId, 500)
const chainedTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${source.invoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`,
  sourceEventId: source.sourceEvent.id, sourceShareId: `payment:${source.paymentId}`,
  destinationShareId: `exchange:${chainedGraph.childInvoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`,
  rootShareId: `payment:${source.paymentId}`, amount: 500,
  sourceInvoiceId: source.invoiceId, childInvoiceId: chainedGraph.childInvoiceId, returnId: chainedGraph.returnId
}))
const chainedChildFunding = await getCurrentExchangeFundingSources(db, chainedGraph.childInvoiceId)
assert.equal(chainedChildFunding.unresolved.length, 0)
assert.equal(chainedChildFunding.sources[0].sourceKind, 'SOURCE_CASH')
assert.equal(chainedChildFunding.sources[0].available, 500)
const downstreamGraph = exchangeGraph(chainedGraph.childInvoiceId, 200)
const downstreamTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${chainedGraph.childInvoiceId}:return:${downstreamGraph.returnId}:share:${source.paymentId}`,
  sourceEventId: chainedTransfer.inEvent.id,
  sourceShareId: `exchange:${chainedGraph.childInvoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`,
  destinationShareId: `exchange:${downstreamGraph.childInvoiceId}:return:${downstreamGraph.returnId}:share:${source.paymentId}`,
  rootShareId: `payment:${source.paymentId}`, amount: 200,
  sourceInvoiceId: chainedGraph.childInvoiceId,
  childInvoiceId: downstreamGraph.childInvoiceId, returnId: downstreamGraph.returnId
}))
const partiallyCarriedChildFunding = await getCurrentExchangeFundingSources(db, chainedGraph.childInvoiceId)
assert.equal(partiallyCarriedChildFunding.sources[0].available, 300,
  'downstream transfer reduces only the child share, while lineage still resolves to the root payment')
assert.deepEqual(partiallyCarriedChildFunding.activeReturnIds, [downstreamGraph.returnId])
assert.equal(partiallyCarriedChildFunding.lineAllocationStatus, 'UNAVAILABLE')
assert.equal(partiallyCarriedChildFunding.lineAllocations.length, 0,
  'a child with a live downstream return cannot reuse an untouched-invoice line split')
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: `void:exchange:${chainedGraph.childInvoiceId}:${chainedGraph.returnId}`,
  outEventId: chainedTransfer.outEvent.id, inEventId: chainedTransfer.inEvent.id
})), /سهم منتقل‌شده در سند فرزند/,
'parent exchange transfer cannot be reversed while value is carried into a live descendant')
assert.equal(await exchangeFundingBalance(db, `exchange:${chainedGraph.childInvoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`), 300)
const downstreamVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: `void:exchange:${downstreamGraph.childInvoiceId}:${downstreamGraph.returnId}`,
  outEventId: downstreamTransfer.outEvent.id, inEventId: downstreamTransfer.inEvent.id
}))
assert.equal(downstreamVoid.replayed, false)
assert.equal(await exchangeFundingBalance(db,
  `exchange:${chainedGraph.childInvoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`), 500)
const parentVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: `void:exchange:${chainedGraph.childInvoiceId}:${chainedGraph.returnId}`,
  outEventId: chainedTransfer.outEvent.id, inEventId: chainedTransfer.inEvent.id
}))
assert.equal(parentVoid.replayed, false)
assert.equal(await exchangeFundingBalance(db, `payment:${source.paymentId}`), 2_000)
assert.equal(await exchangeFundingBalance(db,
  `exchange:${chainedGraph.childInvoiceId}:return:${chainedGraph.returnId}:share:${source.paymentId}`), 0)

// A nested child must name the transfer-in on its direct source invoice as its
// parent. A valid root payment and matching transfer pair are not enough when
// the pair skips that direct source invoice in parentEventId.
const wrongParentGraph = exchangeGraph(chainedGraph.childInvoiceId, 100)
const wrongParentShareId = `exchange:wrong-parent:${wrongParentGraph.childInvoiceId}`
await db.$transaction(async (tx) => {
  const common = {
    sourceInvoiceId: chainedGraph.childInvoiceId,
    childInvoiceId: wrongParentGraph.childInvoiceId,
    returnId: wrongParentGraph.returnId,
    parentEventId: source.sourceEvent.id,
    evidenceKind: 'EXCHANGE_TRANSFER',
    evidenceRef: `SaleReturn:${wrongParentGraph.returnId}`
  }
  await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `test:wrong-parent:${wrongParentGraph.returnId}:out`,
    kind: 'TRANSFER_OUT', amount: -100, shareId: `payment:${source.paymentId}`,
    rootShareId: `payment:${source.paymentId}`
  })
  await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `test:wrong-parent:${wrongParentGraph.returnId}:in`,
    kind: 'TRANSFER_IN', amount: 100, shareId: wrongParentShareId,
    rootShareId: `payment:${source.paymentId}`
  })
})
const wrongParentFunding = await getCurrentExchangeFundingSources(db, wrongParentGraph.childInvoiceId)
assert.equal(wrongParentFunding.sources.length, 0,
  'a valid root payment cannot bypass the direct source-invoice transfer parent')
assert.ok(wrongParentFunding.unresolved.some((row) => row.kind === 'INVALID_EXCHANGE_TRANSFER_LINK'))

// A transfer parent must be on the direct source invoice, not merely another
// valid transfer-in with the same root and a usable share balance.
const siblingGraph = exchangeGraph(source.invoiceId, 100)
const siblingTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `test:sibling-parent:${siblingGraph.returnId}`,
  sourceEventId: source.sourceEvent.id, sourceShareId: `payment:${source.paymentId}`,
  destinationShareId: `exchange:sibling-parent:${siblingGraph.childInvoiceId}`,
  rootShareId: `payment:${source.paymentId}`, amount: 100,
  sourceInvoiceId: source.invoiceId, childInvoiceId: siblingGraph.childInvoiceId,
  returnId: siblingGraph.returnId
}))
const validSiblingFunding = await getCurrentExchangeFundingSources(db, siblingGraph.childInvoiceId)
assert.equal(validSiblingFunding.unresolved.length, 0)
assert.equal(validSiblingFunding.sources[0].available, 100)
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', siblingGraph.returnId)
const linkedExchangeWithCorruptKind = await getCurrentExchangeFundingSources(db, siblingGraph.childInvoiceId)
assert.equal(linkedExchangeWithCorruptKind.unresolved.length, 0,
  'reciprocal child/parent exchange links preserve funding lineage when the return kind is corrupted')
assert.equal(linkedExchangeWithCorruptKind.sources[0]?.available, 100,
  'a corrupted kind must not hide a valid 100-rial exchange funding share')
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('EXCHANGE', siblingGraph.returnId)

const corruptKindReversalGraph = exchangeGraph(source.invoiceId, 50)
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `test:corrupt-kind-reversal:${corruptKindReversalGraph.returnId}`,
  sourceEventId: source.sourceEvent.id, sourceShareId: `payment:${source.paymentId}`,
  destinationShareId: `exchange:corrupt-kind-reversal:${corruptKindReversalGraph.childInvoiceId}`,
  rootShareId: `payment:${source.paymentId}`, amount: 50,
  sourceInvoiceId: source.invoiceId, childInvoiceId: corruptKindReversalGraph.childInvoiceId,
  returnId: corruptKindReversalGraph.returnId
}))
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', corruptKindReversalGraph.returnId)
const corruptKindReversal = await db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: corruptKindReversalGraph.returnId
}))
assert.deepEqual(corruptKindReversal, { reversed: 1, pairs: 1 },
  'reversal must follow reciprocal exchange links and must not depend on a corrupted kind discriminator')
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('EXCHANGE', corruptKindReversalGraph.returnId)

const wrongTransferParentGraph = exchangeGraph(chainedGraph.childInvoiceId, 100)
await db.$transaction(async (tx) => {
  const common = {
    sourceInvoiceId: chainedGraph.childInvoiceId,
    childInvoiceId: wrongTransferParentGraph.childInvoiceId,
    returnId: wrongTransferParentGraph.returnId,
    parentEventId: siblingTransfer.inEvent.id,
    evidenceKind: 'EXCHANGE_TRANSFER',
    evidenceRef: `SaleReturn:${wrongTransferParentGraph.returnId}`
  }
  await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `test:wrong-transfer-parent:${wrongTransferParentGraph.returnId}:out`,
    kind: 'TRANSFER_OUT', amount: -100, shareId: siblingTransfer.inEvent.shareId,
    rootShareId: `payment:${source.paymentId}`
  })
  await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `test:wrong-transfer-parent:${wrongTransferParentGraph.returnId}:in`,
    kind: 'TRANSFER_IN', amount: 100, shareId: `exchange:wrong-transfer-parent:${wrongTransferParentGraph.childInvoiceId}`,
    rootShareId: `payment:${source.paymentId}`
  })
})
const wrongTransferParentFunding = await getCurrentExchangeFundingSources(db, wrongTransferParentGraph.childInvoiceId)
assert.equal(wrongTransferParentFunding.sources.length, 0,
  'a valid transfer from a sibling invoice cannot stand in for the direct source invoice parent')
assert.ok(wrongTransferParentFunding.unresolved.some((row) => row.kind === 'INVALID_EXCHANGE_TRANSFER_LINK'))

const markerlessSource = seed.invoice({ grandTotal: 1000, status: 'FINAL' })
const markerlessChild = seed.invoice({ grandTotal: 1000, status: 'FINAL' })
const markerlessExchangeReturn = seed.insert('SaleReturn', {
  invoiceId: markerlessSource.id, total: 1000, returnedAtJalali: '1405/07/27', kind: 'EXCHANGE'
})
sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
  .run(markerlessChild.id, markerlessExchangeReturn)
sql.prepare('UPDATE "SaleInvoice" SET orderType=?, sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?')
  .run('INTERNAL', markerlessChild.id)
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', markerlessExchangeReturn)
const markerlessFundingEventsBefore = seed.count('ExchangeFundingEvent')
await assert.rejects(() => getCurrentSaleFundingSources(db, markerlessChild.id),
  /تعویض|فرزند|lineage|منشأ مالی/iu,
'a sale funding reader must not treat a markerless exchange child as an ordinary source invoice')
await assert.rejects(() => db.$transaction((tx) => recordSaleFundingSnapshot(tx, markerlessChild.id)),
  /تعویض|فرزند|lineage|snapshot فروش عادی/iu,
'a sale snapshot writer must reject a markerless child proven by the parent exchangeInvoiceId link')
assert.equal(seed.count('ExchangeFundingEvent'), markerlessFundingEventsBefore,
  'markerless child rejection writes no ordinary funding events')

const mismatchedReturnSource = await cashSource(1000)
const mismatchedReturnGraph = exchangeGraph(mismatchedReturnSource.invoiceId, 100)
const otherChildGraph = exchangeGraph(mismatchedReturnSource.invoiceId, 100)
const mismatchedReturnTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${mismatchedReturnSource.invoiceId}:return:${mismatchedReturnGraph.returnId}:scoped`,
  sourceEventId: mismatchedReturnSource.sourceEvent.id,
  sourceShareId: `payment:${mismatchedReturnSource.paymentId}`,
  destinationShareId: `exchange:${mismatchedReturnGraph.childInvoiceId}:scoped`,
  rootShareId: `payment:${mismatchedReturnSource.paymentId}`, amount: 100,
  sourceInvoiceId: mismatchedReturnSource.invoiceId,
  childInvoiceId: mismatchedReturnGraph.childInvoiceId,
  returnId: mismatchedReturnGraph.returnId
}))
sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
  .run(otherChildGraph.childInvoiceId, mismatchedReturnGraph.returnId)
const mismatchedReturnVoidsBefore = seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  mismatchedReturnGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN')
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: mismatchedReturnGraph.returnId
})), /رویداد منشأ مالی معتبر نیست/,
'bulk reversal must bind transfer pairs to the SaleReturn invoice/child link, not just its numeric return id')
assert.equal(seed.count('ExchangeFundingEvent', 'returnId=? AND kind IN (?, ?)',
  mismatchedReturnGraph.returnId, 'VOID_TRANSFER_OUT', 'VOID_TRANSFER_IN'), mismatchedReturnVoidsBefore,
'mismatched parent-return linkage writes no partial inverse')
sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
  .run(mismatchedReturnGraph.childInvoiceId, mismatchedReturnGraph.returnId)
const scopedReturnVoid = await db.$transaction((tx) => reverseExchangeFundingTransfersForReturn(tx, {
  returnId: mismatchedReturnGraph.returnId
}))
assert.deepEqual(scopedReturnVoid, { reversed: 1, pairs: 1 })
assert.ok(mismatchedReturnTransfer.outEvent.id > 0)

console.log('✓ exchange funding journal: persisted-source proof, expiry, exact transfer pairs, immutable gift/cash per-item allocation, scoped parent lineage, downstream balance, reversal, cap, stale/orphan guards and idempotency')
