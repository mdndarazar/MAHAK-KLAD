import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-right-service-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const {
  getExchangeResidualRightBalance,
  reserveS1ExchangeResidualRight,
  commitS1ExchangeResidualRight,
  cancelS1ExchangeResidualRightReservation
} = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const actorUserId = seed.user('S1 residual-right operator')
const invoice = seed.insert('SaleInvoice', { receiptNo: 989001, issuedAtJalali: '1405/07/29', grandTotal: 1_000_000 })
const methodId = seed.insert('PaymentMethod', { key: 'STORE_CREDIT', label: 'Store credit', kind: 'STORE_CREDIT', isActive: 1 })
const nCreditId = seed.insert('StoreCredit', { code: 'S1-N-TEST', amount: 857_346, usedAmount: 400_000,
  usedCount: 1, status: 'PARTIALLY_USED', source: 'EXCHANGE', multiUse: true, maxUses: 5,
  exchangeResidualRightKey: 's1-right-n-1' })
const payment = seed.insert('Payment', { invoiceId: invoice, methodId, amount: 400_000,
  storeCreditId: nCreditId, kind: 'STORE_CREDIT' })
seed.insert('StoreCreditRedemption', { creditId: nCreditId, code: 'S1-N-TEST', amount: 400_000,
  remainderAfter: 457_346, invoiceId: invoice, paymentId: payment,
  idempotencyKey: 's1-n-test-redemption', expiryCaptured: false, expiryAtRedeem: null })
const bExpiry = new Date('2026-11-20T00:00:00.000Z')
const openRight = (rightKey, rightKind, amount, expiresAt, sourceEventId) => seed.insert('ExchangeResidualRightEvent', {
  eventKey: `open:${rightKey}`, rightKey, rightKind, eventKind: 'OPENED', amount,
  availableDelta: amount, reservedDelta: 0, spentDelta: 0,
  sourceInvoiceId: 11, childInvoiceId: 12, returnId: 13, sourceEventId,
  rootShareId: rightKind === 'B' ? 'credit:gift-root' : 'payment:cash-root', expiresAt
})
openRight('s1-right-n-1', 'N', 857_346, null, 21)
openRight('s1-right-b-1', 'B', 122_654, bExpiry, 22)

const firstReserve = await db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-sale-one-n-400k', amount: 400_000,
  relatedInvoiceId: invoice, at: new Date('2026-10-21T12:00:00Z'), actorUserId
}))
assert.equal(firstReserve.available, 457_346)
assert.equal(firstReserve.reserved, 400_000)
const reserveReplay = await db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-sale-one-n-400k', amount: 400_000,
  relatedInvoiceId: invoice, at: new Date('2026-10-21T12:01:00Z'), actorUserId
}))
assert.equal(reserveReplay.replayed, true)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent" WHERE eventKind=?').get('RESERVED').n, 1)

const committed = await db.$transaction((tx) => commitS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-sale-one-n-400k', amount: 400_000,
  relatedInvoiceId: invoice, relatedPaymentId: payment, actorUserId
}))
assert.equal(committed.replayed, false)
const commitReplay = await db.$transaction((tx) => commitS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-sale-one-n-400k', amount: 400_000,
  relatedInvoiceId: invoice, relatedPaymentId: payment, actorUserId
}))
assert.equal(commitReplay.replayed, true)
assert.deepEqual(await db.$transaction((tx) => getExchangeResidualRightBalance(tx, 's1-right-n-1')),
  { rightKey: 's1-right-n-1', rightKind: 'N', amount: 857_346, available: 457_346,
    reserved: 0, spent: 400_000, expiresAt: null, expired: false, voided: false,
    sourceInvoiceId: 11, childInvoiceId: 12, returnId: 13, sourceEventId: 21, rootShareId: 'payment:cash-root' })

const secondInvoice = seed.insert('SaleInvoice', { receiptNo: 989002, issuedAtJalali: '1405/07/29', grandTotal: 457_346 })
const secondPayment = seed.insert('Payment', { invoiceId: secondInvoice, methodId, amount: 457_346, storeCreditId: null, kind: 'CASH' })
await db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-cancel-control', amount: 457_346,
  relatedInvoiceId: secondInvoice, at: new Date('2026-10-21T12:00:00Z'), actorUserId
}))
const cancelled = await db.$transaction((tx) => cancelS1ExchangeResidualRightReservation(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-cancel-control', amount: 457_346,
  relatedInvoiceId: secondInvoice, actorUserId
}))
assert.equal(cancelled.replayed, false)
assert.equal((await db.$transaction((tx) => cancelS1ExchangeResidualRightReservation(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-cancel-control', amount: 457_346,
  relatedInvoiceId: secondInvoice, actorUserId
}))).replayed, true)
assert.deepEqual(await db.$transaction((tx) => getExchangeResidualRightBalance(tx, 's1-right-n-1')),
  { rightKey: 's1-right-n-1', rightKind: 'N', amount: 857_346, available: 457_346,
    reserved: 0, spent: 400_000, expiresAt: null, expired: false, voided: false,
    sourceInvoiceId: 11, childInvoiceId: 12, returnId: 13, sourceEventId: 21, rootShareId: 'payment:cash-root' })

await assert.rejects(db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-insufficient', amount: 457_347,
  relatedInvoiceId: secondInvoice, at: new Date('2026-10-21T12:00:00Z'), actorUserId
})), /کافی نیست/u)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent" WHERE eventKind=?').get('RESERVED').n, 2)

await assert.rejects(db.$transaction((tx) => reserveS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-b-1', operationKey: 's1-expired-b', amount: 1,
  relatedInvoiceId: invoice, at: bExpiry, actorUserId
})), /کافی نیست/u)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ExchangeResidualRightEvent" WHERE eventKind=?').get('RESERVED').n, 2)

await assert.rejects(db.$transaction((tx) => commitS1ExchangeResidualRight(tx, {
  rightKey: 's1-right-n-1', operationKey: 's1-sale-one-n-400k', amount: 400_000,
  relatedInvoiceId: invoice, relatedPaymentId: secondPayment, actorUserId
})), /ناسازگار|پیدا نشد/u)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "CashMovement"').get().n, 0,
  'reserve/commit of N is not a physical cash movement')
console.log('✓ S1 residual-right ledger service: N reserve/commit, replay, cancellation, expiry hold, insufficient balance, and no CashMovement')
