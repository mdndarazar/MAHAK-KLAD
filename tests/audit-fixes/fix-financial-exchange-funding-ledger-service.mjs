import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-ledger-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { appendExchangeFundingEvent, exchangeFundingBalance, transferExchangeFundingShare,
  reverseExchangeFundingTransferPair } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const db = harnessClient()
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

const transferSource = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: 'sale:72:payment:302', kind: 'SOURCE_CASH', amount: 2_000,
  shareId: 'payment:302', rootShareId: 'payment:302', sourceInvoiceId: 72,
  sourcePaymentId: 302, sourceMethodKind: 'CASH', sourceDestination: 'CASH',
  evidenceKind: 'PAYMENT_ROW', evidenceRef: 'Payment:302'
}))
const transferInput = {
  eventKey: 'exchange:72:return:91:share:302', sourceEventId: transferSource.event.id,
  sourceShareId: 'payment:302', destinationShareId: 'exchange:73:return:91:share:302',
  rootShareId: 'payment:302', amount: 1_250, sourceInvoiceId: 72,
  childInvoiceId: 73, returnId: 91, evidenceRef: 'SaleReturn:91'
}
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput, eventKey: 'exchange:wrong-source-invoice', sourceInvoiceId: 999
})), /ماندهٔ سهم اثبات‌شده/,
'a caller cannot relabel a proven source share as belonging to a different invoice')
const transfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, transferInput))
assert.equal(transfer.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:302'), 750)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 1_250)
const transferRetry = await db.$transaction((tx) => transferExchangeFundingShare(tx, transferInput))
assert.equal(transferRetry.replayed, true, 'same transfer retry is idempotent after source balance was reduced')
assert.equal(await exchangeFundingBalance(db, 'payment:302'), 750)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 1_250)
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput, amount: 1_251
})), /کلید عملیات قبلی/,
'a changed amount cannot reuse the previous transfer key')
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  ...transferInput, eventKey: 'exchange:72:return:92:share:302', amount: 751, returnId: 92
})), /ماندهٔ سهم اثبات‌شده/,
'available source balance is enforced before any new transfer')
const unknown = await db.$transaction((tx) => appendExchangeFundingEvent(tx, {
  eventKey: 'sale:74:unknown:303', kind: 'SOURCE_UNKNOWN', amount: 500,
  shareId: 'unknown:303', rootShareId: 'unknown:303', sourceInvoiceId: 74,
  evidenceKind: 'UNRESOLVED_LEGACY'
}))
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: 'exchange:74:return:93:unknown', sourceEventId: unknown.event.id,
  sourceShareId: 'unknown:303', destinationShareId: 'child:unknown:303',
  rootShareId: 'unknown:303', amount: 100, sourceInvoiceId: 74, childInvoiceId: 75, returnId: 93
})), /ماندهٔ سهم اثبات‌شده/,
'UNKNOWN is quarantined and never becomes transferable merely because it has an amount')
const reverseInput = {
  eventKey: 'void:exchange:73:91', outEventId: transfer.outEvent.id, inEventId: transfer.inEvent.id,
  evidenceRef: 'SALE_INVOICE:73'
}
const reversed = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, reverseInput))
assert.equal(reversed.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:302'), 2_000)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 0)
const reversedAgain = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, reverseInput))
assert.equal(reversedAgain.replayed, true)
assert.equal(await exchangeFundingBalance(db, 'payment:302'), 2_000)
assert.equal(await exchangeFundingBalance(db, transferInput.destinationShareId), 0)

const chainedTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: 'exchange:72:return:94:share:302', sourceEventId: transferSource.event.id,
  sourceShareId: 'payment:302', destinationShareId: 'exchange:76:return:94:share:302',
  rootShareId: 'payment:302', amount: 500, sourceInvoiceId: 72,
  childInvoiceId: 76, returnId: 94
}))
const downstreamTransfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: 'exchange:76:return:95:share:302', sourceEventId: chainedTransfer.inEvent.id,
  sourceShareId: 'exchange:76:return:94:share:302', destinationShareId: 'exchange:77:return:95:share:302',
  rootShareId: 'payment:302', amount: 200, sourceInvoiceId: 76,
  childInvoiceId: 77, returnId: 95
}))
await assert.rejects(() => db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: 'void:exchange:76:94', outEventId: chainedTransfer.outEvent.id, inEventId: chainedTransfer.inEvent.id
})), /سهم منتقل‌شده در سند فرزند/,
'parent exchange transfer cannot be reversed while value is carried into a live descendant')
assert.equal(await exchangeFundingBalance(db, 'exchange:76:return:94:share:302'), 300)
const downstreamVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: 'void:exchange:77:95', outEventId: downstreamTransfer.outEvent.id,
  inEventId: downstreamTransfer.inEvent.id
}))
assert.equal(downstreamVoid.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'exchange:76:return:94:share:302'), 500)
const parentVoid = await db.$transaction((tx) => reverseExchangeFundingTransferPair(tx, {
  eventKey: 'void:exchange:76:94', outEventId: chainedTransfer.outEvent.id,
  inEventId: chainedTransfer.inEvent.id
}))
assert.equal(parentVoid.replayed, false)
assert.equal(await exchangeFundingBalance(db, 'payment:302'), 2_000)
assert.equal(await exchangeFundingBalance(db, 'exchange:76:return:94:share:302'), 0)

console.log('✓ exchange funding journal: exact replay, source quarantine, paired transfer/reversal, downstream void guard, balance restoration and idempotency')
