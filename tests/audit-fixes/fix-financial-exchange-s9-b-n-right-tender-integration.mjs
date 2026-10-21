/** S9 production-service integration: both N and B tender the exact exchange
 * delta, only the consumed amount leaves the right, and partial returns restore
 * the same right while the cash-derived share becomes a CASH_RIGHT.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s9-b-n-right-tender-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s9-tender-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { getExchangeResidualRightBalance } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { confirmCreditDelivery, viewReturnEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S9 B/N delta tender')
const categoryId = seed.category('S9 category')
const productId = seed.product('S9 item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1, sortOrder: 2
})
const shiftId = seed.insert('Shift', {
  name: 'S9 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S9-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })

async function createSpendableRight(kind, label) {
  const sourceVariant = variant(`${label}-right-source`, 1_000_000)
  const replacementVariant = variant(`${label}-right-replacement`, 1_000_000)
  let sourceSale
  let giftRoot = null
  if (kind === 'N') {
    sourceSale = await salesService.create({
      userId, shiftId, lines: [line(sourceVariant, 2, 1_000_000)],
      payments: [
        { methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' },
        { methodId: cardMethodId, amount: 1_000_000, destination: 'CARD' }
      ]
    })
  } else {
    giftRoot = await db.$transaction((tx) => issueStoreCredit(tx, {
      source: 'MANUAL', amount: 1_000_000, multiUse: false, maxUses: 1,
      carryRemainder: false, days: 90, note: `S9 ${label} B root`, userId
    }))
    sourceSale = await salesService.create({
      userId, shiftId, lines: [line(sourceVariant, 2, 1_000_000)],
      payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
      storeCreditCode: giftRoot.code, storeCreditAmount: 1_000_000,
      storeCreditIdempotencyKey: `s9-${label}-root-gift-redemption-0001`
    })
  }
  const sourceFunding = await getCurrentSaleFundingSources(db, sourceSale.id)
  assert.deepEqual(sourceFunding.unresolved, [])
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sourceSale.id)
  const rightExchange = await exchange({
    invoiceId: sourceSale.id,
    lines: [{ saleItemId: sourceItem.id, qty: 2 }],
    replacements: [line(replacementVariant, 1, 1_000_000)],
    userId, shiftId, refundMode: 'S1_RESIDUAL_RIGHTS',
    idempotencyKey: `s9-${label}-right-generation-request-0001`
  })
  assert.equal(rightExchange.diff, -1_000_000)
  const right = rightExchange.residualRights.rights.find((candidate) => candidate.rightKind === kind)
  assert.ok(right, `S1 produced the required ${kind} residual right`)
  assert.equal(right.amount, 500_000, 'the right has 500K available for the 300K tender')
  const handoff = await confirmCreditDelivery({
    creditId: right.creditId, witnessKind: 'CUSTOMER_HANDOFF',
    witnessRef: `S9 ${kind} right delivered to customer`,
    managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
  })
  assert.equal(handoff.status, 'DELIVERED')
  const row = seed.one('SELECT code, expiresAt FROM "StoreCredit" WHERE id=?', right.creditId)
  const opening = seed.one('SELECT rootShareId, expiresAt FROM "ExchangeResidualRightEvent" WHERE rightKey=? AND eventKind=?',
    right.rightKey, 'OPENED')
  assert.ok(opening.rootShareId, 'residual right retains an immutable root-share identity')
  assert.equal(opening.expiresAt, row.expiresAt, 'the access code and right share one deadline')
  if (kind === 'B') {
    const root = seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', giftRoot.id)
    assert.equal(opening.expiresAt, root.expiresAt, 'B right deadline stays bound to the original root credit')
  }
  return { right, code: row.code, rootShareId: opening.rootShareId, expiresAt: opening.expiresAt }
}

async function runCase(kind) {
  const { right, code, rootShareId } = await createSpendableRight(kind, kind.toLowerCase())
  const parentVariant = variant(`${kind}-parent`, 400_000)
  const childVariant = variant(`${kind}-child`, 500_000)
  const parent = await salesService.create({
    userId, shiftId, lines: [line(parentVariant, 3, 400_000)],
    payments: [{ methodId: cashMethodId, amount: 1_200_000, destination: 'CASH' }]
  })
  assert.equal(parent.grandTotal, 1_200_000)
  const parentItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', parent.id)
  const cashMovementCountBeforeExchange = seed.count('CashMovement', '1=1')
  const request = {
    invoiceId: parent.id,
    lines: [{ saleItemId: parentItem.id, qty: 3 }],
    replacements: [line(childVariant, 3, 500_000)],
    deltaStoreCreditCode: code,
    deltaStoreCreditAmount: 300_000,
    payments: [],
    userId, shiftId,
    idempotencyKey: `s9-${kind.toLowerCase()}-300k-delta-exchange-request-0001`
  }
  const childExchange = await exchange(request)
  assert.equal(childExchange.returnTotal, 1_200_000)
  assert.equal(childExchange.exchangeTotal, 1_500_000)
  assert.equal(childExchange.diff, 300_000)
  assert.equal(childExchange.cashReceived, 0)
  assert.equal(childExchange.cardReceived, 0)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBeforeExchange,
    'residual-right tender creates no CashMovement')
  await assert.rejects(() => salesService.returnDelete({
    id: childExchange.returnId, userId, reason: 'S9 tender already committed',
    panelPassword: DEFAULT_MANAGER_PASSWORD
  }), /ابطال تعویض ممکن نیست/u,
  'a committed B/N tender is not silently reversed by voiding the exchange')
  assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', childExchange.returnId).voidedAt, null,
    'rejected void has no partial graph effects')
  assert.equal(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', childExchange.exchangeInvoiceId).voidedAt, null)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBeforeExchange)

  const credit = seed.one('SELECT usedAmount, status, exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', right.creditId)
  assert.equal(credit.usedAmount, 300_000)
  assert.equal(credit.exchangeResidualRightKey, right.rightKey, 'tender leaves the original code attached to the same right')
  const balanceAfterCommit = await getExchangeResidualRightBalance(db, right.rightKey)
  assert.equal(balanceAfterCommit.available, 200_000, 'only 300K was consumed from the original 500K')
  assert.equal(balanceAfterCommit.spent, 300_000)
  assert.equal(balanceAfterCommit.reserved, 0, 'atomic commit leaves no outstanding reservation')
  const operation = seed.rows(`SELECT eventKind, amount FROM "ExchangeResidualRightEvent"
    WHERE rightKey=? AND operationKey=? ORDER BY id`, right.rightKey,
    `s8-exchange:${childExchange.exchangeInvoiceId}:${right.creditId}:${seed.one(
      'SELECT id FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?', childExchange.exchangeInvoiceId, right.creditId).id}`)
  assert.deepEqual(operation.map((event) => [event.eventKind, event.amount]), [
    ['RESERVED', 300_000], ['COMMITTED', 300_000]
  ])

  const childFunding = await getCurrentExchangeFundingSources(db, childExchange.exchangeInvoiceId)
  assert.deepEqual(childFunding.unresolved, [])
  assert.equal(childFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
  const exchangeReport = await salesService.exchangeGet({ id: childExchange.returnId })
  assert.equal(exchangeReport.returnTotal, 1_200_000)
  assert.equal(exchangeReport.exchangeTotal, 1_500_000)
  assert.equal(exchangeReport.diff, 300_000)
  assert.equal(exchangeReport.cashReceived, 0)
  assert.equal(exchangeReport.cardReceived, 0)
  const paymentReport = await salesService.payments({ invoiceId: childExchange.exchangeInvoiceId })
  assert.equal(paymentReport.storeCreditTotal, 300_000)
  assert.equal(paymentReport.payments.find((payment) => payment.isStoreCredit)?.amount, 300_000)
  assert.equal(paymentReport.payments.find((payment) => payment.isStoreCredit)?.reference, null,
    'reporting records the non-cash right tender without leaking its access code')
  assert.equal(childFunding.sources.find((source) => source.sourceKind === `SOURCE_${kind}`).event.rootShareId, rootShareId,
    'the child carry retains the original N/B root lineage')
  assert.deepEqual(childFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CASH', available: 1_200_000 },
    { sourceKind: `SOURCE_${kind}`, available: 300_000 }
  ].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), 'child funding keeps parent cash carry distinct from its N/B tender')

  const replay = await exchange(request)
  assert.equal(replay.exchangeInvoiceId, childExchange.exchangeInvoiceId, 'same-key retry is idempotent')
  assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', right.creditId).usedAmount, 300_000,
    'idempotent replay does not reserve or redeem the right twice')

  const childItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', childExchange.exchangeInvoiceId)
  const preview = await salesService.returnProvenancePreview({
    invoiceId: childExchange.exchangeInvoiceId, lines: [{ saleItemId: childItem.id, qty: 2 }]
  })
  assert.equal(preview.settlementReady, true)
  assert.deepEqual(preview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CASH', amount: 800_000 },
    { sourceKind: `SOURCE_${kind}`, amount: 200_000 }
  ].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), '1M partial return uses cumulative proportional floors over 1.5M child funding')
  const cashMovementCountBeforeReturn = seed.count('CashMovement', '1=1')
  const creditCountBeforeReturn = seed.count('StoreCredit', '1=1')
  const returned = await salesService.createReturn({
    invoiceId: childExchange.exchangeInvoiceId, full: false,
    lines: [{ saleItemId: childItem.id, qty: 2 }],
    refundMethod: 'NONE', refundAmount: 0, userId, shiftId,
    idempotencyKey: `s9-${kind.toLowerCase()}-1m-partial-return-0001`
  }, { goodsReceiptRequired: false })
  assert.equal(returned.total, 1_000_000)
  assert.equal(returned.refundMethod, 'NONE')
  assert.deepEqual(returned.s8ChildReturnRights.map((claim) => [claim.kind, claim.cashRight]).sort(), [
    ['CASH_RIGHT', 800_000]
  ], 'cash carry opens a claim; returned N/B carry restores the original right, not a new right')
  const cashClaim = await viewReturnEntitlement(returned.id)
  assert.equal(cashClaim.cashRight, 800_000)
  assert.equal(cashClaim.cashPaid, 0)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBeforeReturn,
    'a cash-right claim is not a cash payout')
  assert.equal(seed.count('StoreCredit', '1=1'), creditCountBeforeReturn,
    'restoring a B/N right does not issue a replacement code')
  assert.equal(seed.one('SELECT code FROM "StoreCredit" WHERE id=?', right.creditId).code, code)
  assert.equal(seed.one('SELECT exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', right.creditId).exchangeResidualRightKey,
    right.rightKey)
  const rightAfterReturn = await getExchangeResidualRightBalance(db, right.rightKey)
  assert.equal(rightAfterReturn.available, 400_000, '200K is restored to the same original right')
  assert.equal(rightAfterReturn.spent, 100_000)
  assert.equal(rightAfterReturn.reserved, 0)
  const restoredCredit = seed.one('SELECT usedAmount, status, voidedAt, exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', right.creditId)
  assert.equal(restoredCredit.usedAmount, 100_000)
  assert.equal(restoredCredit.status, 'PARTIALLY_USED')
  assert.equal(restoredCredit.voidedAt, null)
  assert.equal(restoredCredit.exchangeResidualRightKey, right.rightKey)
  assert.equal(seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', right.creditId).status, 'DELIVERED',
    'restoration does not revoke or replace the active access code')
  const returnedPaymentReport = await salesService.payments({ invoiceId: childExchange.exchangeInvoiceId })
  assert.equal(returnedPaymentReport.remaining, 0)
  assert.equal(returnedPaymentReport.settlementState, 'SETTLED')
  assert.equal(returnedPaymentReport.overpayTotal, 0,
    'restored residual-right and returned carry are one non-cash settlement, not duplicate credit')
  const remaining = await getCurrentExchangeFundingSources(db, childExchange.exchangeInvoiceId, {
    allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
  })
  assert.deepEqual(remaining.unresolved, [])
  assert.equal(remaining.sources.reduce((sum, source) => sum + source.available, 0), 500_000,
    'the unreturned balance is 400K cash carry plus 100K net N/B carry')

  // Reuse the restored live right in a later exchange, then carry the spent
  // N/B share through another full, equal-value exchange generation.
  const nextParentVariant = variant(`${kind}-next-parent`, 400_000)
  const nextChildVariant = variant(`${kind}-next-child`, 500_000)
  const grandchildVariant = variant(`${kind}-grandchild`, 500_000)
  const nextParent = await salesService.create({
    userId, shiftId, lines: [line(nextParentVariant, 3, 400_000)],
    payments: [{ methodId: cashMethodId, amount: 1_200_000, destination: 'CASH' }]
  })
  const nextParentItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', nextParent.id)
  const nextChild = await exchange({
    invoiceId: nextParent.id, lines: [{ saleItemId: nextParentItem.id, qty: 3 }],
    replacements: [line(nextChildVariant, 3, 500_000)],
    deltaStoreCreditCode: code, deltaStoreCreditAmount: 300_000, payments: [],
    userId, shiftId, idempotencyKey: `s9-${kind.toLowerCase()}-later-generation-tender-0001`
  })
  assert.equal(nextChild.diff, 300_000)
  const nextChildItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', nextChild.exchangeInvoiceId)
  const grandchild = await exchange({
    invoiceId: nextChild.exchangeInvoiceId, lines: [{ saleItemId: nextChildItem.id, qty: 3 }],
    replacements: [line(grandchildVariant, 3, 500_000)],
    userId, shiftId, idempotencyKey: `s9-${kind.toLowerCase()}-carry-next-generation-0001`
  })
  assert.equal(grandchild.diff, 0)
  const grandchildFunding = await getCurrentExchangeFundingSources(db, grandchild.exchangeInvoiceId)
  assert.deepEqual(grandchildFunding.unresolved, [])
  assert.equal(grandchildFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
  assert.deepEqual(grandchildFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CASH', available: 1_200_000 },
    { sourceKind: `SOURCE_${kind}`, available: 300_000 }
  ].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)),
  'spent N/B carry remains eligible and identifiable in the next exchange generation')
  assert.equal(grandchildFunding.sources.find((source) => source.sourceKind === `SOURCE_${kind}`).event.rootShareId, rootShareId)
  const finalRight = await getExchangeResidualRightBalance(db, right.rightKey)
  assert.equal(finalRight.available, 100_000)
  assert.equal(finalRight.spent, 400_000)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBeforeReturn)
}

await runCase('N')
await runCase('B')
console.log('✓ S9 N and B: 500K right → atomic 300K reserve/commit; child keeps 1.2M CASH_CARRY + 300K SOURCE_N/SOURCE_B; 1M partial return allocates 800K CASH_RIGHT + 200K to the same live code; retry, balances, and no-CashMovement invariants passed')
