/** S8 production-path integration: mixed roots -> partial child exchange ->
 * N + card delta -> cumulative source split on a later partial return.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s8-mixed-chain-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s8-chain-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources, getCurrentExchangeFundingSources, exchangeFundingBalance } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { getExchangeResidualRightBalance } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { confirmCreditDelivery, viewReturnEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { setS7NResidualRightSourceDisposition } = await import('../../src/main/services/ExchangeResidualRightsService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S8 mixed chain')
const categoryId = seed.category('S8 category')
const productId = seed.product('S8 item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1, sortOrder: 2
})
const shiftId = seed.insert('Shift', {
  name: 'S8 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label) => {
  const id = seed.variant(productId, `S8-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=1000000 WHERE id=?').run(id)
  return id
}
const items = (variantId, qty) => ({ variantId, qty, unitPrice: 1_000_000, discount: 0, tax: 0 })
const exchange = async (input) => salesService.createExchange(input, { goodsReceiptRequired: false })

// Produce a genuine 600K card-rooted N (plus an independent cash-rooted N)
// from another mixed sale using the established S1 path, not a hand-authored row.
const nRootVariant = variant('n-root')
const nReplacementVariant = variant('n-replacement')
const nRoot = await salesService.create({
  userId, shiftId, lines: [items(nRootVariant, 15)],
  payments: [
    { methodId: cashMethodId, amount: 6_000_000, destination: 'CASH' },
    { methodId: cardMethodId, amount: 9_000_000, destination: 'CARD' }
  ]
})
const nRootFunding = await getCurrentSaleFundingSources(db, nRoot.id)
const nRootItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', nRoot.id)
const nRightExchange = await exchange({
  invoiceId: nRoot.id, lines: [{ saleItemId: nRootItem.id, qty: 15 }],
  replacements: [items(nReplacementVariant, 14)], userId, shiftId,
  refundMode: 'S1_RESIDUAL_RIGHTS', idempotencyKey: 's8-n-right-generation-request-0001'
})
const nSourceKindByEvent = new Map(nRootFunding.sources.map((source) => [Number(source.event.id), source.sourceKind]))
const nRight = nRightExchange.residualRights.rights.find((right) => right.rightKind === 'N' &&
  nSourceKindByEvent.get(Number(String(right.rightKey).match(/:source:(\d+):N$/)?.[1])) === 'SOURCE_CARD')
assert.ok(nRight, 'the independent mixed root yielded a card-rooted N right')
assert.equal(nRight.amount, 600_000)
const nHandoff = await confirmCreditDelivery({
  creditId: nRight.creditId, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'S8 witnessed N delivery from independent root',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(nHandoff.status, 'DELIVERED')
const nCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', nRight.creditId).code
const nRightRootShareId = seed.one('SELECT rootShareId FROM "ExchangeResidualRightEvent" WHERE rightKey=? AND eventKind=?',
  nRight.rightKey, 'OPENED').rootShareId

// P=15M, exactly 2M gift + 13M cash; exchange all 15M into C.
const pGift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 90, note: 'S8 P gift source', userId
}))
const pVariant = variant('P')
const cVariant = variant('C')
const gVariant = variant('G')
const pSale = await salesService.create({
  userId, shiftId, lines: [items(pVariant, 15)],
  payments: [{ methodId: cashMethodId, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: pGift.code, storeCreditAmount: 2_000_000,
  storeCreditIdempotencyKey: 's8-P-mixed-sale-0001'
})
assert.equal(pSale.grandTotal, 15_000_000)
const pFunding = await getCurrentSaleFundingSources(db, pSale.id)
assert.deepEqual(pFunding.unresolved, [])
assert.deepEqual(pFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 13_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
])
const pItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', pSale.id)
const cExchange = await exchange({
  invoiceId: pSale.id, lines: [{ saleItemId: pItem.id, qty: 15 }],
  replacements: [items(cVariant, 15)], userId, shiftId,
  refundMode: 'STORE_CREDIT', idempotencyKey: 's8-P-to-C-exchange-request-0001'
})
assert.equal(cExchange.returnTotal, 15_000_000)
assert.equal(cExchange.exchangeTotal, 15_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', pGift.id).status, 'USED')
await assert.rejects(() => salesService.create({
  userId, shiftId, lines: [items(variant('replay-old-gift'), 1)], payments: [],
  storeCreditCode: pGift.code, storeCreditAmount: 1,
  storeCreditIdempotencyKey: 's8-old-gift-reuse-0001'
}), /مصرف|استفاده|اعتبار/u, 'the consumed public gift code cannot be spent a second time')

// Carry 5M from C to G, with 600K of valid N plus 400K card for the 1M delta.
const cItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', cExchange.exchangeInvoiceId)
const cashMovementCountBefore = seed.count('CashMovement', '1=1')
const gExchange = await exchange({
  invoiceId: cExchange.exchangeInvoiceId, lines: [{ saleItemId: cItem.id, qty: 5 }],
  replacements: [items(gVariant, 6)], userId, shiftId,
  deltaStoreCreditCode: nCode, deltaStoreCreditAmount: 600_000,
  payments: [{ methodId: cardMethodId, amount: 400_000, destination: 'CARD' }],
  idempotencyKey: 's8-C-to-G-N-card-exchange-request-0001'
})
assert.equal(gExchange.returnTotal, 5_000_000)
assert.equal(gExchange.exchangeTotal, 6_000_000)
const gFunding = await getCurrentExchangeFundingSources(db, gExchange.exchangeInvoiceId)
assert.deepEqual(gFunding.unresolved, [], 'the carry and two real tender proofs reconcile')
assert.equal(gFunding.lineAllocationStatus, 'PERSISTED_RECONCILED')
assert.deepEqual(gFunding.sources.map(({ sourceKind, available }) => ({ sourceKind, available }))
  .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CARD', available: 400_000 },
  { sourceKind: 'SOURCE_CASH', available: 4_333_334 },
  { sourceKind: 'SOURCE_GIFT', available: 666_666 },
  { sourceKind: 'SOURCE_N', available: 600_000 }
])
assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBefore,
  'N is not a cash movement; card tender also does not affect the drawer')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', nRight.creditId).status, 'USED')
assert.equal(seed.one('SELECT exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', nRight.creditId).exchangeResidualRightKey,
  nRight.rightKey, 'the same N code remains connected to the same right')
const liveN = await getExchangeResidualRightBalance(db, nRight.rightKey)
assert.equal(liveN.available, 0)
assert.equal(liveN.spent, 600_000)
assert.equal(seed.one('SELECT rootShareId FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=? AND sourceCreditId=?',
  gExchange.exchangeInvoiceId, 'SOURCE_N', nRight.creditId).rootShareId, nRightRootShareId)

// C's next 1M return is x=5M -> x=6M on the original P allocation.
const cPreview = await salesService.returnProvenancePreview({
  invoiceId: cExchange.exchangeInvoiceId, lines: [{ saleItemId: cItem.id, qty: 1 }]
})
assert.equal(cPreview.settlementReady, true)
assert.deepEqual(cPreview.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })).sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
  { sourceKind: 'SOURCE_CASH', amount: 866_666 },
  { sourceKind: 'SOURCE_GIFT', amount: 133_334 }
])
const cReturn = await salesService.createReturn({
  invoiceId: cExchange.exchangeInvoiceId, full: false,
  lines: [{ saleItemId: cItem.id, qty: 1 }], refundMethod: 'NONE', refundAmount: 0,
  userId, shiftId, idempotencyKey: 's8-C-cumulative-return-1M-request-0001'
}, { goodsReceiptRequired: false })
assert.equal(cReturn.total, 1_000_000)
assert.equal(cReturn.refundMethod, 'NONE')
assert.deepEqual(cReturn.s8ChildReturnRights.map((right) => right.kind).sort(), ['B', 'CASH_RIGHT'])
const bBranch = cReturn.s8ChildReturnRights.find((right) => right.kind === 'B')
assert.equal(bBranch.amount, 133_334)
assert.equal(bBranch.status, 'DRAFT')
assert.equal(bBranch.deliveryStatus, 'PENDING_DELIVERY')
const cashRight = await viewReturnEntitlement(cReturn.id)
assert.equal(cashRight.cashRight, 866_666)
assert.equal(cashRight.cashPaid, 0)
assert.equal(cashRight.cashReserved, 0)
assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBefore,
  'opening a cash right is not a payout or drawer movement')
const cRemaining = await getCurrentExchangeFundingSources(db, cExchange.exchangeInvoiceId, {
  allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
})
assert.deepEqual(cRemaining.unresolved, [])
assert.equal(cRemaining.sources.reduce((sum, source) => sum + source.available, 0), 9_000_000)
const gStill = await getCurrentExchangeFundingSources(db, gExchange.exchangeInvoiceId)
assert.deepEqual(gStill.unresolved, [])
assert.equal(gStill.sources.reduce((sum, source) => sum + source.available, 0), 6_000_000)

// Quarantine the N source after its downstream use. Returning G must still
// release its known carry and card share, while the N restoration stays on the
// same quarantined right and never becomes a cash claim.
const nQuarantine = await setS7NResidualRightSourceDisposition({
  rightKey: nRight.rightKey, operationKey: 's8-N-source-unknown-before-G-return-0001',
  action: 'QUARANTINE', evidenceKind: 'CARD_UNKNOWN', evidenceRef: 'S8 card statement not matched',
  reason: 'The N source is unproven; quarantine only this source lineage',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
})
assert.equal(nQuarantine.quarantined, true)
assert.equal((await getExchangeResidualRightBalance(db, nRight.rightKey)).available, 0)

// A later full return of G reverses its P carry, opens a separate cash claim
// for the card tender, and records N restoration on its same quarantined right.
const gItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', gExchange.exchangeInvoiceId)
const gReturnPreview = await salesService.returnProvenancePreview({
  invoiceId: gExchange.exchangeInvoiceId, lines: [{ saleItemId: gItem.id, qty: 6 }]
})
assert.equal(gReturnPreview.settlementReady, true)
assert.equal(gReturnPreview.shares.reduce((sum, share) => sum + share.amount, 0), 6_000_000)
const gReturn = await salesService.createReturn({
  invoiceId: gExchange.exchangeInvoiceId, full: false,
  lines: [{ saleItemId: gItem.id, qty: 6 }], refundMethod: 'NONE', refundAmount: 0,
  userId, shiftId, idempotencyKey: 's8-G-full-return-N-restore-request-0001'
}, { goodsReceiptRequired: false })
assert.equal(gReturn.total, 6_000_000)
assert.equal(seed.one('SELECT code FROM "StoreCredit" WHERE id=?', nRight.creditId).code, nCode)
assert.equal(seed.one('SELECT exchangeResidualRightKey FROM "StoreCredit" WHERE id=?', nRight.creditId).exchangeResidualRightKey,
  nRight.rightKey, 'restoration keeps the original access code and right identity')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', nRight.creditId).status, 'ACTIVE')
const restoredN = await getExchangeResidualRightBalance(db, nRight.rightKey)
assert.equal(restoredN.available, 0, 'quarantine remains attached to the N share after its dependent return')
assert.equal(restoredN.grossAvailable, 600_000, 'the N amount is restored to its original right, not moved into cash')
assert.equal(restoredN.sourceQuarantined, true)
assert.equal(restoredN.spent, 0)
const gCashRight = await viewReturnEntitlement(gReturn.id)
assert.equal(gCashRight.cashRight, 400_000)
assert.equal(gCashRight.cashPaid, 0)
assert.equal(seed.count('CashMovement', '1=1'), cashMovementCountBefore)
const returnedGFunding = await getCurrentExchangeFundingSources(db, gExchange.exchangeInvoiceId, {
  allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
})
assert.deepEqual(returnedGFunding.unresolved, [])
assert.equal(returnedGFunding.sources.reduce((sum, source) => sum + source.available, 0), 0)

console.log('✓ S8 actual chain: 15M P → C; 5M carry plus N=600K/card=400K → G; exact carry/return floors; C return opens B DRAFT + CASH_RIGHT; after N quarantine, G return restores only its same N right without converting it to cash')
