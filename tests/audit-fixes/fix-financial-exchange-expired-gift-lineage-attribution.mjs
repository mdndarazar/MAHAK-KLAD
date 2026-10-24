/**
 * A gift spent before its root deadline may remain provenance inside a live
 * child item. A later child return after that deadline may attribute the gift
 * share for accounting, but this attribution must not create/reissue a usable
 * credit or a cash entitlement.
 *
 * This is a ledger-reader test only. It does NOT open child-return mutation or
 * exchange-funding gates.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-expired-gift-lineage-attribution.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-expired-gift-lineage-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { recordSaleFundingSnapshot, transferExchangeFundingShare,
  recordExchangeFundingLineAllocations, recordExchangeFundingReturnLineAllocation,
  getCurrentExchangeFundingSources } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const giftMethodId = seed.insert('PaymentMethod', {
  key: 'EXPIRED-LINE-GIFT', label: 'Expired-line gift', kind: 'STORE_CREDIT', isActive: 1
})
const exchangeMethodId = seed.insert('PaymentMethod', {
  key: 'EXCHANGE_CREDIT', label: 'Exchange value', kind: 'EXCHANGE_CREDIT', isActive: 1
})
const categoryId = seed.category('expired gift attribution')
const productId = seed.product('expired gift attribution', categoryId)
const variantId = seed.variant(productId, 'replacement item')
const now = Date.now()
const expiresAt = new Date(now + 60 * 60 * 1000)

const source = seed.invoice({ grandTotal: 200, status: 'FINAL' })
const creditId = seed.insert('StoreCredit', {
  code: 'EXPIRED-LINE-ROOT', amount: 200, usedAmount: 200, usedCount: 1,
  status: 'USED', expiresAt
})
const sourcePaymentId = seed.insert('Payment', {
  invoiceId: source.id, methodId: giftMethodId, amount: 200, kind: 'CASH', storeCreditId: creditId
})
const redemptionId = seed.insert('StoreCreditRedemption', {
  creditId, code: 'EXPIRED-LINE-ROOT', amount: 200, remainderAfter: 0,
  invoiceId: source.id, paymentId: sourcePaymentId,
  idempotencyKey: 'expired-line-root-redemption', expiryCaptured: true, expiryAtRedeem: expiresAt
})
const snapshot = await db.$transaction((tx) => recordSaleFundingSnapshot(tx, source.id))
const rootEvent = snapshot.events.find((event) => event.kind === 'SOURCE_GIFT' &&
  Number(event.sourceRedemptionId) === redemptionId)
assert.ok(rootEvent, 'the root gift must be linked to a persisted redemption')

const child = seed.invoice({ grandTotal: 200, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET orderType=?, sourceInvoiceId=?, exchangeReturnId=NULL WHERE id=?')
  .run('EXCHANGE', source.id, child.id)
sql.prepare('UPDATE "SaleInvoice" SET paidTotal=? WHERE id=?').run(200, child.id)
const exchangeReturnId = seed.insert('SaleReturn', {
  invoiceId: source.id, total: 200, returnedAtJalali: '1405/07/27', kind: 'EXCHANGE',
  exchangeInvoiceId: child.id, exchangeTotal: 200
})
sql.prepare('UPDATE "SaleInvoice" SET exchangeReturnId=? WHERE id=?').run(exchangeReturnId, child.id)
const childPaymentId = seed.insert('Payment', {
  invoiceId: child.id, methodId: exchangeMethodId, amount: 200, kind: 'CASH', seq: 1
})
const childItemId = seed.insert('SaleInvoiceItem', {
  invoiceId: child.id, variantId, qty: 2, unitPrice: 100, lineTotal: 200,
  discount: 0, tax: 0, variantName: 'replacement item'
})
assert.ok(childPaymentId > 0 && childItemId > 0)
const transfer = await db.$transaction((tx) => transferExchangeFundingShare(tx, {
  eventKey: `exchange:${source.id}:return:${exchangeReturnId}:gift:${rootEvent.id}`,
  sourceEventId: rootEvent.id, sourceShareId: `redemption:${redemptionId}`,
  destinationShareId: `exchange:${child.id}:return:${exchangeReturnId}:gift:${rootEvent.id}`,
  rootShareId: `credit:${creditId}`, amount: 200,
  sourceInvoiceId: source.id, childInvoiceId: child.id, returnId: exchangeReturnId
}))
assert.ok(transfer.inEvent.id > 0)
await db.$transaction((tx) => recordExchangeFundingLineAllocations(tx, child.id))
const reconciledBeforeExpiry = await getCurrentExchangeFundingSources(db, child.id)
assert.equal(reconciledBeforeExpiry.unresolved.length, 0)
assert.equal(reconciledBeforeExpiry.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.equal(reconciledBeforeExpiry.lineAllocations[0].sourceKind, 'SOURCE_GIFT')
assert.equal(reconciledBeforeExpiry.lineAllocations[0].amount, 200)

// Simulate the clock crossing the already-captured expiry. No expiry metadata
// is rewritten; the source credit becomes EXPIRED as the normal expiry process
// would have marked it. The child's physical provenance remains the same.
const realNow = Date.now
Date.now = () => expiresAt.getTime() + 1
try {
  sql.prepare('UPDATE "StoreCredit" SET status=? WHERE id=?').run('EXPIRED', creditId)
  const childReturnId = seed.insert('SaleReturn', {
    invoiceId: child.id, isFull: false, total: 100, returnedAtJalali: '1405/07/28',
    kind: 'RETURN', refundMethod: 'NONE', refundAmount: 0
  })
  const childReturnItemId = seed.insert('SaleReturnItem', {
    returnId: childReturnId, saleItemId: childItemId, variantId,
    qty: 1, unitPrice: 100, lineTotal: 100, restockedQty: 0
  })
  const result = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
    returnId: childReturnId, returnItemId: childReturnItemId
  }))
  assert.equal(result.replayed, false)
  assert.equal(result.shares.length, 1)
  assert.deepEqual({ sourceKind: result.shares[0].sourceKind, amount: result.shares[0].amount },
    { sourceKind: 'SOURCE_GIFT', amount: 100 },
    'a pre-expiry gift transfer remains attributable inside its child item after expiry')
  const allocationRowsAfterFirstWrite = seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
    WHERE returnId=? AND eventKind='ALLOCATION'`, childReturnId).n
  assert.equal(allocationRowsAfterFirstWrite, 1)
  const replay = await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
    returnId: childReturnId, returnItemId: childReturnItemId
  }))
  assert.equal(replay.replayed, true, 'the same expired-gift attribution retries idempotently')
  assert.equal(seed.one(`SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation"
    WHERE returnId=? AND eventKind='ALLOCATION'`, childReturnId).n, allocationRowsAfterFirstWrite)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', creditId).status, 'EXPIRED')
  assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n, 1,
    'descriptive lineage attribution does not issue a fresh child gift')
  assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement" WHERE returnId=?', childReturnId).n, 0,
    'source attribution alone does not open a financial entitlement')
  assert.equal(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId=?', childReturnId).n, 0,
    'source attribution alone does not issue a return-credit allocation')
  assert.equal(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n, 0,
    'descriptive gift attribution does not fabricate a cash refund')
  console.log('✓ expired root gift remains attributable through a pre-expiry child transfer; no credit or cash entitlement is issued')
} finally {
  Date.now = realNow
}
