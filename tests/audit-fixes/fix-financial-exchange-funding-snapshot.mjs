import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-funding-snapshot-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { recordSaleFundingSnapshot, reviseSaleFundingSnapshot, reviseLatestSaleFundingSnapshot,
  exchangeFundingBalance, transferExchangeFundingShare } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const sqlUpdatePaymentAmount = (client, id, amount) => client.$harness.db.prepare('UPDATE "Payment" SET amount=? WHERE id=?').run(amount, id)
const sqlUpdateChequeStatus = (client, id, status) => client.$harness.db.prepare('UPDATE "Payment" SET chequeStatus=? WHERE id=?').run(status, id)
const invoice = (receiptNo, grandTotal, orderType = 'INTERNAL') => seed.insert('SaleInvoice', {
  receiptNo, issuedAtJalali: '1405/07/27', grandTotal, orderType
})
const method = (key, kind) => seed.insert('PaymentMethod', { key, label: key, kind, isActive: 1 })
const cashMethod = method('CASH', 'CASH')
const cardMethod = method('CARD', 'CARD')
const giftMethod = method('STORE_CREDIT', 'STORE_CREDIT')
const customMethod = method('CUSTOM', 'CUSTOM')
const pay = (invoiceId, methodId, amount, extra = {}) => seed.insert('Payment', {
  invoiceId, methodId, amount, destination: 'CASH', ...extra
})

const exact = invoice(1001, 1_000)
pay(exact, cashMethod, 600, { seq: 1, destination: 'CASH' })
pay(exact, cardMethod, 200, { seq: 2, destination: 'CARD' })
const giftPayment = pay(exact, giftMethod, 200, { seq: 3, storeCreditId: 70 })
seed.insert('StoreCreditRedemption', {
  creditId: 70, code: 'GIFT-70', amount: 200, remainderAfter: 0,
  invoiceId: exact, paymentId: giftPayment, idempotencyKey: 'funding-snapshot-gift-70'
})
const exactResult = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, exact))
assert.deepEqual([exactResult.funded, exactResult.gift, exactResult.real, exactResult.unknown, exactResult.debt, exactResult.overpay],
  [1_000, 200, 800, 0, 0, 0])
assert.deepEqual(seed.rows('SELECT kind, amount FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? ORDER BY id', exact), [
  { kind: 'SOURCE_CASH', amount: 600 },
  { kind: 'SOURCE_CARD', amount: 200 },
  { kind: 'SOURCE_GIFT', amount: 200 }
])
assert.equal(seed.one('SELECT sourceCreditId FROM "ExchangeFundingEvent" WHERE sourcePaymentId=?', giftPayment).sourceCreditId, 70)
const countAfterExact = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', exact).n
await db.$transaction((tx) => recordSaleFundingSnapshot(tx, exact))
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', exact).n, countAfterExact,
  'snapshot retry does not duplicate source or debt events')
assert.equal(await exchangeFundingBalance(db, 'payment:1'), 600)

const partial = invoice(1002, 1_000)
const partialFirstPayment = pay(partial, cashMethod, 400, { destination: 'CASH', seq: 1 })
const partialResult = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, partial))
assert.deepEqual([partialResult.real, partialResult.unknown, partialResult.debt], [400, 0, 600])
assert.equal(seed.one('SELECT kind, amount FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?', partial, 'DEBT_OPEN').amount, 600)
const followupPayment = pay(partial, cashMethod, 300, { destination: 'CASH', seq: 2 })
const revisionTwo = await db.$transaction((tx) => reviseSaleFundingSnapshot(tx, partial, 2))
assert.deepEqual([revisionTwo.real, revisionTwo.unknown, revisionTwo.debt], [700, 0, 300])
assert.equal(await exchangeFundingBalance(db, `payment:${partialFirstPayment}`), 400,
  'revision reverses then re-records the original payment without changing its funded balance')
assert.equal(await exchangeFundingBalance(db, `debt:${partial}`), 300,
  'follow-up receipt settles exactly 300 of the 600 open debt')
const revisionTwoCount = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n
const revisionTwoReplay = await db.$transaction((tx) => reviseSaleFundingSnapshot(tx, partial, 2))
assert.equal(revisionTwoReplay.replayed, true)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n, revisionTwoCount,
  'same revision retry is a no-op')
assert.equal(await exchangeFundingBalance(db, `payment:${followupPayment}`), 300)

sqlUpdatePaymentAmount(db, followupPayment, 250)
const revisionThree = await db.$transaction((tx) => reviseSaleFundingSnapshot(tx, partial, 3))
assert.deepEqual([revisionThree.real, revisionThree.unknown, revisionThree.debt], [650, 0, 350])
assert.equal(await exchangeFundingBalance(db, `payment:${followupPayment}`), 250)
assert.equal(await exchangeFundingBalance(db, `debt:${partial}`), 350,
  'editing payment revises debt and tender in a single append-only snapshot')
const revisionThreeCount = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n
await assert.rejects(() => db.$transaction((tx) => reviseSaleFundingSnapshot(tx, partial, 2)),
  /کلید عملیات قبلی/,
'replaying an old revision after the source payment changed is rejected')
seed.insert('SaleReturn', { invoiceId: partial, total: 50, returnedAtJalali: '1405/07/27', kind: 'RETURN' })
sqlUpdatePaymentAmount(db, followupPayment, 240)
await assert.rejects(() => db.$transaction((tx) => reviseSaleFundingSnapshot(tx, partial, 4)),
  /دارای برگشت ثبت‌شده/,
'once a return creates downstream rights, ordinary snapshot revisions require a witnessed correction path')
assert.equal(await exchangeFundingBalance(db, `payment:${followupPayment}`), 250)
assert.equal(await exchangeFundingBalance(db, `debt:${partial}`), 350)
const autoRevisionAfterReturn = await db.$transaction((tx) => reviseLatestSaleFundingSnapshot(tx, partial))
assert.deepEqual({
  skipped: autoRevisionAfterReturn.skipped,
  reason: autoRevisionAfterReturn.reason,
  invoiceId: autoRevisionAfterReturn.invoiceId,
  revision: autoRevisionAfterReturn.revision
}, {
  skipped: true, reason: 'ACTIVE_RETURN_REQUIRES_WITNESSED_CORRECTION', invoiceId: partial, revision: 3
}, 'normal payment maintenance can proceed without silently rewriting returned value')
assert.ok(Number.isSafeInteger(autoRevisionAfterReturn.stateEventId) && autoRevisionAfterReturn.stateEventId > 0)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n,
  revisionThreeCount + 1, 'the skipped revision appends one zero-value stale-state marker, not a monetary share')
assert.deepEqual(seed.one('SELECT kind, amount, shareId FROM "ExchangeFundingEvent" WHERE id=?',
  autoRevisionAfterReturn.stateEventId), {
  kind: 'SNAPSHOT_STALE', amount: 0, shareId: `snapshot:${partial}`
})
assert.equal(await exchangeFundingBalance(db, `snapshot:${partial}`), 0,
  'a state marker does not add any Rial balance')
const staleSourceEvent = seed.one(`SELECT id FROM "ExchangeFundingEvent"
  WHERE eventKey=? AND kind='SOURCE_CASH'`, `sale:${partial}:r3:payment:${partialFirstPayment}:funded`)
const staleEventsBeforeTransfer = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n
await assert.rejects(() => db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: 'exchange:stale-snapshot:attempt', sourceEventId: staleSourceEvent.id,
  sourceShareId: `payment:${partialFirstPayment}`, destinationShareId: 'exchange:stale-snapshot:carry',
  rootShareId: `payment:${partialFirstPayment}`, amount: 1, sourceInvoiceId: partial,
  childInvoiceId: 1009, returnId: 1010
})), /منسوخ است/,
'a returned invoice whose payment snapshot was not safely revised cannot transfer a formerly proven share')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', partial).n,
  staleEventsBeforeTransfer, 'stale-source transfer fails before writing either side')
// Once the return is voided, an ordinary new snapshot may safely reconcile the
// latest persisted payment rows and append a resolved state marker.
sql.prepare('UPDATE "SaleReturn" SET voidedAt=? WHERE invoiceId=?').run(Date.now(), partial)
const afterReturnVoid = await db.$transaction((tx) => reviseLatestSaleFundingSnapshot(tx, partial))
assert.deepEqual([afterReturnVoid.real, afterReturnVoid.unknown, afterReturnVoid.debt], [640, 0, 360])
assert.equal(afterReturnVoid.replayed, false)
assert.deepEqual(seed.one(`SELECT kind, amount FROM "ExchangeFundingEvent"
  WHERE sourceInvoiceId=? AND kind IN ('SNAPSHOT_STALE','SNAPSHOT_RECONCILED') ORDER BY id DESC LIMIT 1`, partial),
  { kind: 'SNAPSHOT_RECONCILED', amount: 0 })
assert.deepEqual([await exchangeFundingBalance(db, `payment:${partialFirstPayment}`),
  await exchangeFundingBalance(db, `payment:${followupPayment}`), await exchangeFundingBalance(db, `debt:${partial}`)],
  [400, 240, 360])

const carried = invoice(1007, 500)
const carriedPayment = pay(carried, cashMethod, 500, { destination: 'CASH' })
await db.$transaction((tx) => recordSaleFundingSnapshot(tx, carried))
const carriedSourceEvent = seed.one('SELECT id FROM "ExchangeFundingEvent" WHERE sourcePaymentId=? AND kind=?', carriedPayment, 'SOURCE_CASH')
const carriedChild = invoice(1008, 200)
const carriedReturnId = seed.insert('SaleReturn', {
  invoiceId: carried, total: 200, returnedAtJalali: '1405/07/27', kind: 'EXCHANGE',
  exchangeInvoiceId: carriedChild, exchangeTotal: 200
})
sql.prepare(`UPDATE "SaleInvoice" SET orderType='EXCHANGE', sourceInvoiceId=?, exchangeReturnId=? WHERE id=?`)
  .run(carried, carriedReturnId, carriedChild)
await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${carried}:return:${carriedReturnId}:payment`, sourceEventId: carriedSourceEvent.id,
  sourceShareId: `payment:${carriedPayment}`, destinationShareId: `exchange-carry:${carriedReturnId}:payment`,
  rootShareId: `payment:${carriedPayment}`, amount: 200, sourceInvoiceId: carried,
  childInvoiceId: carriedChild, returnId: carriedReturnId
}))
sqlUpdatePaymentAmount(db, carriedPayment, 400)
const carriedEventsBeforeEditAttempt = seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', carried).n
await assert.rejects(() => db.$transaction((tx) => reviseSaleFundingSnapshot(tx, carried, 2)),
  /دارای برگشت ثبت‌شده|قبلاً به سند تعویض منتقل شده/,
'once a returned share is carried downstream, ordinary payment revision fails closed')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', carried).n,
  carriedEventsBeforeEditAttempt, 'blocked revision leaves source and child balances untouched')
assert.equal(await exchangeFundingBalance(db, `payment:${carriedPayment}`), 300)
assert.equal(await exchangeFundingBalance(db, `exchange-carry:${carriedReturnId}:payment`), 200)

const pendingCheque = invoice(1003, 500)
const pendingChequePayment = pay(pendingCheque, customMethod, 500, { kind: 'CHEQUE', chequeStatus: 'PENDING' })
const chequeResult = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, pendingCheque))
assert.deepEqual([chequeResult.real, chequeResult.unknown, chequeResult.debt], [0, 0, 500],
  'a pending cheque is a documented pending obligation, not cleared funding')
assert.equal(await exchangeFundingBalance(db, `payment:${pendingChequePayment}`), 0)
assert.equal(await exchangeFundingBalance(db, `pending-cheque:${pendingChequePayment}`), 500)
sqlUpdateChequeStatus(db, pendingChequePayment, 'CLEARED')
const clearedChequeResult = await db.$transaction((tx) => reviseSaleFundingSnapshot(tx, pendingCheque, 2))
assert.deepEqual([clearedChequeResult.real, clearedChequeResult.unknown, clearedChequeResult.debt], [500, 0, 0],
  'a cleared cheque is reclassified as funded only after its persisted status changes')
assert.equal(await exchangeFundingBalance(db, `payment:${pendingChequePayment}`), 500)
assert.equal(await exchangeFundingBalance(db, `pending-cheque:${pendingChequePayment}`), 0)
sqlUpdateChequeStatus(db, pendingChequePayment, 'BOUNCED')
const bouncedChequeResult = await db.$transaction((tx) => reviseSaleFundingSnapshot(tx, pendingCheque, 3))
assert.deepEqual([bouncedChequeResult.real, bouncedChequeResult.unknown, bouncedChequeResult.debt], [0, 0, 500],
  'a bounced cheque is a distinct quarantined obligation, not pending or received cash')
assert.equal(await exchangeFundingBalance(db, `payment:${pendingChequePayment}`), 0)
assert.equal(await exchangeFundingBalance(db, `pending-cheque:${pendingChequePayment}`), 0)
assert.equal(await exchangeFundingBalance(db, `bounced-cheque:${pendingChequePayment}`), 500)
assert.equal(seed.one('SELECT kind FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND sourcePaymentId=? AND kind=?',
  pendingCheque, pendingChequePayment, 'BOUNCED_CHEQUE')?.kind, 'BOUNCED_CHEQUE')

const excess = invoice(1004, 1_000)
const excessPaymentId = pay(excess, cashMethod, 1_200, { destination: 'CASH' })
const excessResult = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, excess))
assert.deepEqual([excessResult.real, excessResult.unknown, excessResult.debt, excessResult.overpay], [1_000, 0, 0, 200])
assert.equal(seed.one('SELECT kind, amount FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?', excess, 'SOURCE_OVERPAY').amount, 200)
assert.equal(await exchangeFundingBalance(db, `overpay:${excessPaymentId}`), 200)

const mismatch = invoice(1005, 300)
const mismatchPayment = pay(mismatch, giftMethod, 300, { storeCreditId: 71 })
seed.insert('StoreCreditRedemption', {
  creditId: 72, code: 'GIFT-72', amount: 300, remainderAfter: 0,
  invoiceId: mismatch, paymentId: mismatchPayment, idempotencyKey: 'funding-snapshot-gift-72'
})
const mismatchResult = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, mismatch))
assert.deepEqual([mismatchResult.gift, mismatchResult.real, mismatchResult.unknown], [0, 0, 300],
  'mismatched credit/payment lineage is quarantined rather than interpreted as cash or gift')

const exchangeInvoice = invoice(1006, 300, 'EXCHANGE')
await assert.rejects(() => db.$transaction((tx) => recordSaleFundingSnapshot(tx, exchangeInvoice)),
  /تخصیص مستقل ارزش برگشتی/)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', exchangeInvoice).n, 0)

console.log('✓ sale funding snapshots: persisted cash/card/gift, debt-first remainder, pending-cheque quarantine, overpay separation, malformed provenance and exchange guard')
