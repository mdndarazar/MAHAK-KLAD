/** S4 characterization: actual 5M gift + 20M cash sale across 3 lines.
 * The source snapshot is proven and the exact line matrix is calculable, but
 * createExchange must currently remain gated until mixed-source settlement and
 * rights are integrated. Assert that the gate has no side effects.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s4-three-line-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s4-three-line-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { getCurrentSaleFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { allocateExchangeFundingByLine } = await import('../../src/shared/exchangeFundingAllocation.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S4 exact integration')
const categoryId = seed.category('S4 exact category')
const productId = seed.product('S4 exact item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S4 exact shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let variantNo = 0
const variant = (price) => {
  const id = seed.variant(productId, `S4-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=30, salePrice=? WHERE id=?').run(price, id)
  return id
}
const item = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })

const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 5_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'S4 mixed-source fixture', userId
}))
const sourcePrices = [10_000_000, 10_000_000, 5_000_000]
const sourceVariants = sourcePrices.map((price) => variant(price))
const replacementVariants = sourcePrices.map((price) => variant(price))
const sourceSale = await salesService.create({
  userId,
  shiftId,
  lines: sourceVariants.map((variantId, index) => item(variantId, sourcePrices[index])),
  payments: [{ methodId: cashMethodId, amount: 20_000_000, destination: 'CASH' }],
  storeCreditCode: gift.code,
  storeCreditAmount: 5_000_000,
  storeCreditIdempotencyKey: 's4-exact-mixed-source-sale'
})
assert.equal(sourceSale.grandTotal, 25_000_000)
assert.equal(sourceSale.storeCreditApplied, 5_000_000)
const sourceView = await getCurrentSaleFundingSources(db, sourceSale.id)
assert.deepEqual(sourceView.unresolved, [])
assert.deepEqual(sourceView.sources.map(({ sourceKind, available }) => ({ sourceKind, available })), [
  { sourceKind: 'SOURCE_CASH', available: 20_000_000 },
  { sourceKind: 'SOURCE_GIFT', available: 5_000_000 }
], 'the ordinary-sale reader proves both real tender roots before the exchange attempt')

// Compute the candidate S4 item matrix from the real persisted source events,
// but do not persist or treat this planner output as authorization.
const candidateLineIds = [1001, 1002, 1003]
const candidateMatrix = allocateExchangeFundingByLine(
  sourcePrices.map((amount, index) => ({ saleItemId: candidateLineIds[index], amount })),
  sourceView.sources.map(({ event, sourceKind, available }) => ({
    sourceEventId: Number(event.id), sourceKind, amount: available
  }))
)
const candidateByLineAndKind = candidateMatrix
  .map(({ saleItemId, sourceKind, amount }) => ({
    saleItemId, sourceKind, amount,
    lineIndex: candidateLineIds.indexOf(saleItemId)
  }))
  .sort((a, b) => a.lineIndex - b.lineIndex || a.sourceKind.localeCompare(b.sourceKind))
  .map(({ saleItemId, sourceKind, amount }) => ({ saleItemId, sourceKind, amount }))
assert.deepEqual(candidateByLineAndKind, [
  { saleItemId: 1001, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: 1001, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: 1002, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { saleItemId: 1002, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { saleItemId: 1003, sourceKind: 'SOURCE_CASH', amount: 4_000_000 },
  { saleItemId: 1003, sourceKind: 'SOURCE_GIFT', amount: 1_000_000 }
], 'candidate matrix reconciles each of the three replacement lines exactly')

const sourceItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sourceSale.id)
const before = {
  returns: seed.count('SaleReturn', '1=1'),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  sourcePayments: seed.count('Payment', 'invoiceId=?', sourceSale.id),
  redemptions: seed.count('StoreCreditRedemption', 'invoiceId=?', sourceSale.id),
  allCredits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  sourceEvents: seed.count('ExchangeFundingEvent', 'sourceInvoiceId=?', sourceSale.id),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id', ...sourceVariants, ...replacementVariants)
}
await assert.rejects(() => salesService.createExchange({
  invoiceId: sourceSale.id,
  lines: sourceItems.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  replacements: replacementVariants.map((variantId, index) => item(variantId, sourcePrices[index])),
  refundMode: 'STORE_CREDIT', userId, shiftId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  overrideReason: 'S4 characterization'
}), /تعویضِ این فاکتور/,
'mixed funding with an active but fully proven gift redemption remains gated until settlement integration')
assert.deepEqual({
  returns: seed.count('SaleReturn', '1=1'),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=?', sourceSale.id),
  sourcePayments: seed.count('Payment', 'invoiceId=?', sourceSale.id),
  redemptions: seed.count('StoreCreditRedemption', 'invoiceId=?', sourceSale.id),
  allCredits: seed.count('StoreCredit', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  sourceEvents: seed.count('ExchangeFundingEvent', 'sourceInvoiceId=?', sourceSale.id),
  stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id', ...sourceVariants, ...replacementVariants)
}, before, 'the blocked mixed-source exchange changes no return, credit, payment, ledger, cash, or inventory state')

console.log('✓ S4 characterization: real mixed source and exact candidate matrix; createExchange remains safely gated with zero side effects')
