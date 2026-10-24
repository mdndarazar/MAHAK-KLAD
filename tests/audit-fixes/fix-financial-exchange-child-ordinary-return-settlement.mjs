/** Ordinary-return settlement for mixed-source exchange children.
 * Proves root gift/cash splits, new non-cash gift barcode, immediate cash /
 * manager C2C / cash-to-credit routing, entitlement ceilings, and idempotency.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-child-ordinary-return-settlement.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-child-return-settlement-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentExchangeFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { viewReturnEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('child ordinary return settlement')
const categoryId = seed.category('child ordinary return settlement')
const productId = seed.product('child ordinary return settlement', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', {
  name: 'child return settlement shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label) => {
  const id = seed.variant(productId, `CRS-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=1_000_000 WHERE id=?').run(id)
  return id
}
const line = (variantId, qty = 2) => ({ variantId, qty, unitPrice: 1_000_000, discount: 0, tax: 0 })

async function createMixedChild(label) {
  const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount: 1_000_000, multiUse: false, maxUses: 1,
    carryRemainder: false, days: 90, note: `CRS gift ${label}`, userId
  }))
  const sourceVariant = variant(`${label}-source`)
  const childVariant = variant(`${label}-child`)
  const grandchildVariant = variant(`${label}-grandchild`)
  const sale = await salesService.create({
    userId, shiftId, lines: [line(sourceVariant)],
    payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }],
    storeCreditCode: gift.code, storeCreditAmount: 1_000_000,
    storeCreditIdempotencyKey: `crs-${label}-gift-redeem-0001`
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  const firstExchange = await salesService.createExchange({
    invoiceId: sale.id, lines: [{ saleItemId: Number(sourceItem.id), qty: 2 }],
    replacements: [line(childVariant)], userId, shiftId,
    idempotencyKey: `crs-${label}-exchange-0001`
  }, { goodsReceiptRequired: false })
  const firstChildItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', firstExchange.exchangeInvoiceId)
  const exchange = await salesService.createExchange({
    invoiceId: firstExchange.exchangeInvoiceId,
    lines: [{ saleItemId: Number(firstChildItem.id), qty: 2 }],
    replacements: [line(grandchildVariant)], userId, shiftId,
    idempotencyKey: `crs-${label}-nested-exchange-0001`
  }, { goodsReceiptRequired: false })
  const childItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', exchange.exchangeInvoiceId)
  const funding = await getCurrentExchangeFundingSources(db, exchange.exchangeInvoiceId)
  assert.deepEqual(funding.unresolved, [])
  assert.deepEqual(funding.sources.map(({ sourceKind, available }) => ({ sourceKind, available }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)), [
    { sourceKind: 'SOURCE_CASH', available: 1_000_000 },
    { sourceKind: 'SOURCE_GIFT', available: 1_000_000 }
  ].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)))
  return { sale, exchange, childItem, gift }
}

async function submit(label, method, extra = {}) {
  const { exchange, childItem, gift } = await createMixedChild(label)
  const preview = await salesService.returnProvenancePreview({
    invoiceId: exchange.exchangeInvoiceId, lines: [{ saleItemId: Number(childItem.id), qty: 2 }]
  })
  assert.equal(preview.settlementReady, true)
  assert.equal(preview.exchangeChildReturn, true)
  assert.equal(preview.returnTotal, 2_000_000)
  assert.equal(preview.giftOpportunity, 1_000_000)
  assert.equal(preview.cashRight, 1_000_000)
  const cashMovementsBefore = seed.count('CashMovement', '1=1')
  const creditsBefore = seed.count('StoreCredit', '1=1')
  const returned = await salesService.createReturn({
    invoiceId: exchange.exchangeInvoiceId, full: true,
    lines: [{ saleItemId: Number(childItem.id), qty: 2 }],
    refundMethod: method,
    refundAmount: extra.refundAmount ?? (method === 'NONE' ? 0 : 1_000_000),
    refundStoreCreditAmount: extra.refundStoreCreditAmount,
    userId, shiftId, idempotencyKey: `crs-${label}-return-${method.toLowerCase()}-0001`
  }, { goodsReceiptRequired: false })
  assert.equal(returned.total, 2_000_000)
  assert.equal(returned.creditOpportunity.restored, 1_000_000,
    'the source barcode share is never treated as refund cash')
  assert.equal(returned.creditOpportunity.pendingDelivery.length, 1,
    'the gift share produces one separately deliverable child barcode')
  const giftSuccessor = returned.creditOpportunity.pendingDelivery[0]
  assert.equal(Number(giftSuccessor.amount), 1_000_000)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED',
    'the consumed root barcode is never reactivated or paid out a second time')
  const realCreditCount = method === 'STORE_CREDIT' || (method === 'CASH' && Number(extra.refundStoreCreditAmount ?? 0) > 0) ? 1 : 0
  assert.equal(seed.count('StoreCredit', '1=1'), creditsBefore + 1 + realCreditCount,
    'only the automatic non-cash gift successor and any seller-selected real-money credit are issued')
  const claim = await viewReturnEntitlement(returned.id)
  assert.equal(claim.cashRight, 1_000_000)
  assert.equal(claim.giftOpportunity, 1_000_000)
  if (method === 'CASH') {
    const paidAmount = Number(extra.refundAmount ?? 1_000_000)
    const convertedAmount = Number(extra.refundStoreCreditAmount ?? 0)
    assert.equal(returned.refundAmount, paidAmount)
    assert.equal(claim.cashPaid, paidAmount)
    assert.equal(claim.cashReserved, 0)
    assert.equal(claim.cashConverted, convertedAmount)
    assert.equal(returned.refundStoreCreditAmount ?? 0, convertedAmount)
    assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore + (paidAmount > 0 ? 1 : 0))
  } else if (method === 'CARD_TO_CARD') {
    assert.equal(returned.refundAmount, 1_000_000)
    assert.equal(returned.cardTransfer.amount, 1_000_000)
    assert.equal(claim.cashPaid, 0)
    assert.equal(claim.cashReserved, 1_000_000)
    assert.equal(claim.requestId, returned.cardTransfer.id)
    assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore)
    const managerDeclared = await cardTransferService.pay({
      id: returned.cardTransfer.id, paidAmount: 1_000_000,
      managerPassword: DEFAULT_MANAGER_PASSWORD, userId
    })
    assert.equal(managerDeclared.bankEvidenceState, 'UNKNOWN_BANK',
      'manager declaration is not treated as independent proof of a bank transfer')
    const stillReserved = await viewReturnEntitlement(returned.id)
    assert.equal(stillReserved.cashPaid, 0)
    assert.equal(stillReserved.cashReserved, 1_000_000)
    assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore)
  } else if (method === 'STORE_CREDIT') {
    assert.equal(returned.refundAmount, 1_000_000)
    assert.equal(claim.cashPaid, 0)
    assert.equal(claim.cashReserved, 0)
    assert.equal(claim.cashConverted, 1_000_000)
    assert.ok(returned.storeCredit?.id)
    assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore)
  } else {
    assert.equal(returned.refundAmount, 0)
    assert.equal(claim.cashPaid, 0)
    assert.equal(claim.cashReserved, 0)
    assert.equal(claim.cashConverted, 0)
    assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore)
  }
  assert.deepEqual(returned.s8ChildReturnRights.map((right) => right.kind).sort(), ['B', 'CASH_RIGHT'])
  const replay = await salesService.createReturn({
    invoiceId: exchange.exchangeInvoiceId, full: true,
    lines: [{ saleItemId: Number(childItem.id), qty: 2 }],
    refundMethod: method,
    refundAmount: extra.refundAmount ?? (method === 'NONE' ? 0 : 1_000_000),
    refundStoreCreditAmount: extra.refundStoreCreditAmount,
    userId, shiftId, idempotencyKey: `crs-${label}-return-${method.toLowerCase()}-0001`
  }, { goodsReceiptRequired: false })
  assert.equal(replay.replayed, true)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore +
    (method === 'CASH' && Number(extra.refundAmount ?? 1_000_000) > 0 ? 1 : 0),
    'idempotent replay never repeats cash movement')
  assert.equal(seed.count('StoreCredit', '1=1'), creditsBefore + 1 + realCreditCount,
    'idempotent replay never reissues gift or real-money credit')
  return { returned, claim }
}

await submit('cash', 'CASH')
await submit('cash-split', 'CASH', { refundAmount: 600_000, refundStoreCreditAmount: 400_000 })
await submit('c2c', 'CARD_TO_CARD')
await submit('credit', 'STORE_CREDIT')
await submit('hold', 'NONE')
console.log('✓ child ordinary returns: root-derived gift/cash split; new non-cash gift right; cash, manager C2C, credit, and held-right routes; replay has no duplicate settlement')
