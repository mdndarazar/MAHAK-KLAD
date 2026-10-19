import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-ledger-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { appendExchangeFundingEvent, recordSaleFundingSnapshot, exchangeFundingBalance,
  getCurrentExchangeFundingSources, transferExchangeFundingShare, reverseExchangeFundingTransferPair } =
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

const voidEvent = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'void:71:payment:301', kind: 'VOID_SOURCE', amount: -13_980_000,
  evidenceKind: 'SALE_INVOICE_VOID', reversesEventId: first.event.id
}))
assert.equal(voidEvent.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:301'), 0)
const voidReplay = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'void:71:payment:301', kind: 'VOID_SOURCE', amount: -13_980_000,
  evidenceKind: 'SALE_INVOICE_VOID', reversesEventId: first.event.id
}))
assert.equal(voidReplay.replayed, true)
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'void:71:payment:301:again', kind: 'VOID_SOURCE', amount: -13_980_000,
  evidenceKind: 'SALE_INVOICE_VOID', reversesEventId: first.event.id
})), /UNIQUE constraint failed|رویداد منشأ مالی معتبر نیست/,
'a source event cannot be reversed twice')
await assert.rejects(() => db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  ...base, eventKey: 'void:wrong:sign', kind: 'VOID_SOURCE', amount: -1,
  evidenceKind: 'SALE_INVOICE_VOID', reversesEventId: first.event.id
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

function exchangeGraph(sourceInvoiceId, total) {
  const child = seed.invoice({ grandTotal: total, status: 'SETTLED' })
  seed.insert('Payment', {
    invoiceId: child.id, methodId: exchangeCreditMethodId, amount: total,
    kind: 'CASH', seq: 1
  })
  sql.prepare('UPDATE "SaleInvoice" SET paidTotal=? WHERE id=?').run(total, child.id)
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
  eventKey: `void:source:${voidedSource.invoiceId}:${voidedSource.paymentId}`,
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

console.log('✓ exchange funding journal: persisted-source proof, expiry, exact transfer pairs, gift/cash child lineage, downstream balance, reversal, cap, stale/orphan guards and idempotency')
