/**
 * Scenario 4 regression: a 50M multi-use barcode funds a 10M sale over two
 * items. Returning both and exchanging for four 1M items carries 4M to the
 * replacement invoice and restores the 6M surplus onto the same barcode.
 * Voiding the exchange reverses that restoration and both inventory effects.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-scenario4-multiuse-return-exchange-stock.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-scenario4-multiuse-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const dirDb = harnessClient()
const seed = makeSeeder(dirDb)
const sql = dirDb.$harness.db
const userId = seed.user('scenario4-financial-audit')
const shiftId = seed.insert('Shift', {
  name: 'scenario4', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const categoryId = seed.category('scenario4')
const productId = seed.product('scenario4-product', categoryId)
let variantNo = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S4-${label}-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const stock = (variantId) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const replacements = [1, 2, 3, 4].map((n) => variant(`replacement-1m-${n}`, 1_000_000))
const originalVariants = [variant('original-6m', 6_000_000), variant('original-4m', 4_000_000)]

const issued = await storeCreditService.issueManual({
  amount: 50_000_000,
  multiUse: true,
  maxUses: 10,
  carryRemainder: true,
  days: 30,
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
const root = seed.one('SELECT id,code,amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
const originalSale = await salesService.create({
  userId,
  shiftId,
  lines: [line(originalVariants[0], 6_000_000), line(originalVariants[1], 4_000_000)],
  payments: [],
  storeCreditCode: root.code,
  storeCreditIdempotencyKey: 'scenario4-root-redemption-10m'
})
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', root.id).usedAmount), 10_000_000)
assert.deepEqual(originalVariants.map(stock), [9, 9], 'both original sale items were deducted')
const originalItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', originalSale.id)
assert.equal(originalItems.length, 2)
const before = {
  returns: seed.count('SaleReturn', 'invoiceId=?', originalSale.id),
  childInvoices: seed.count('SaleInvoice', 'sourceInvoiceId=?', originalSale.id),
  credits: seed.count('StoreCredit', '1=1'),
  payments: seed.count('Payment', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  root: seed.one('SELECT amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
}

const exchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: originalSale.id,
  lines: originalItems.map((item) => ({ saleItemId: Number(item.id), qty: 1 })),
  replacements: replacements.map((id) => line(id, 1_000_000))
})
assert.equal(exchange.returnTotal, 10_000_000)
assert.equal(exchange.exchangeTotal, 4_000_000)
assert.equal(exchange.diff, -6_000_000)
assert.equal(exchange.settlement, 'SAME_BARCODE_RESTORED')
assert.equal(exchange.storeCredit, null, 'no successor/new barcode is issued')
assert.equal(exchange.storeCredits.length, 0)
assert.equal(seed.count('SaleReturn', 'invoiceId=?', originalSale.id), before.returns + 1)
assert.equal(seed.count('SaleInvoice', 'sourceInvoiceId=?', originalSale.id), before.childInvoices + 1)
assert.equal(seed.count('StoreCredit', '1=1'), before.credits, 'the original barcode is reused; no credit row is added')
assert.equal(seed.count('Payment', '1=1'), before.payments + 1, 'only the internal 4M EXCHANGE_CREDIT row is added')
assert.equal(seed.count('Payment', 'storeCreditId IS NOT NULL'), 1, 'no second credit tender is recorded')
assert.equal(seed.count('CashMovement', '1=1'), before.cashMovements, 'no cash is paid or received')

const rootAfter = seed.one('SELECT id,code,amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
assert.equal(Number(rootAfter.amount), 50_000_000)
assert.equal(Number(rootAfter.usedAmount), 4_000_000)
assert.equal(rootAfter.status, 'PARTIALLY_USED')
assert.equal(rootAfter.code, root.code)
const liveRoot = await findRedeemable(dirDb, root.code)
assert.equal(Number(liveRoot.id), root.id)
assert.equal(Number(liveRoot.amount) - Number(liveRoot.usedAmount), 46_000_000,
  'the same original barcode now has 46M available')
assert.deepEqual(originalVariants.map(stock), [10, 10], 'both returned goods immediately re-enter stock')
assert.deepEqual(replacements.map(stock), [9, 9, 9, 9], 'all four replacement goods immediately leave stock')
const restored = seed.one('SELECT creditId,returnId,redemptionId,amount,kind FROM "StoreCreditBalanceAdjustment" WHERE returnId=? AND kind=?',
  exchange.returnId, 'EXCHANGE_REMAINDER_RESTORED')
assert.equal(Number(restored.creditId), root.id)
assert.equal(Number(restored.amount), 6_000_000)
assert.equal(seed.one('SELECT amount FROM "ExchangeFundingEvent" WHERE returnId=? AND kind=?',
  exchange.returnId, 'TRANSFER_OUT').amount, -4_000_000)

const voided = await salesService.returnDelete({
  id: exchange.returnId,
  userId,
  reason: 'scenario4 exchange reversal',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(voided.voided, true)
const rootAfterVoid = seed.one('SELECT amount,usedAmount,status FROM "StoreCredit" WHERE id=?', root.id)
assert.equal(Number(rootAfterVoid.amount), 50_000_000)
assert.equal(Number(rootAfterVoid.usedAmount), 10_000_000, 'voiding the exchange revokes the 6M same-code restoration')
assert.deepEqual(originalVariants.map(stock), [9, 9], 'void reverses the return stock-in; original sale remains active')
assert.deepEqual(replacements.map(stock), [10, 10, 10, 10], 'void returns all replacement goods to stock')
const balanceEvents = seed.rows('SELECT kind,amount,reversesEventId FROM "StoreCreditBalanceAdjustment" WHERE returnId=? ORDER BY id',
  exchange.returnId)
assert.deepEqual(balanceEvents.map((row) => ({ kind: row.kind, amount: Number(row.amount), reversed: row.reversesEventId != null })), [
  { kind: 'EXCHANGE_REMAINDER_RESTORED', amount: 6_000_000, reversed: false },
  { kind: 'EXCHANGE_REMAINDER_RESTORATION_REVERSED', amount: 6_000_000, reversed: true }
])

console.log('PASS: 50M barcode → 10M sale → full return → 4M exchange: 6M returned to the same barcode (balance 40M → 46M), no cash/new barcode; void restores the pre-exchange credit and stock state.')
