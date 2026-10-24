/**
 * Scenario 4 audit probe. A 50M multi-use barcode funds a 10M sale over two
 * items. The customer returns those two items for four 1M items (6M surplus
 * should top up the live barcode); then the intended next step would exchange
 * invoice 2's four 1M items for four items totaling 60M.
 *
 * The current code rejects the first exchange at its provenance guard. This
 * probe captures that rejection and verifies it left the temporary DB untouched;
 * it does not claim the rejection is correct or incorrect—that is for review.
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
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
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
const originalVariants = [variant('original-6m', 6_000_000), variant('original-4m', 4_000_000)]
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
const replacements = [1, 2, 3, 4].map((n) => variant(`replacement-1m-${n}`, 1_000_000))

const before = {
  returns: seed.count('SaleReturn', 'invoiceId=?', originalSale.id),
  childInvoices: seed.count('SaleInvoice', 'sourceInvoiceId=?', originalSale.id),
  credits: seed.count('StoreCredit', '1=1'),
  payments: seed.count('Payment', '1=1'),
  cashMovements: seed.count('CashMovement', '1=1'),
  originalStock: originalVariants.map(stock),
  replacementStock: replacements.map(stock),
  root: seed.one('SELECT amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
}
let observedError = null
try {
  await salesService.createExchange({
    userId,
    shiftId,
    invoiceId: originalSale.id,
    lines: originalItems.map((item) => ({ saleItemId: Number(item.id), qty: 1 })),
    replacements: replacements.map((id) => line(id, 1_000_000)),
    refundMode: 'STORE_CREDIT'
  })
} catch (error) {
  observedError = String(error?.message ?? error)
}

assert.ok(observedError, 'the current provenance guard rejected this exchange request')
assert.match(observedError, /تطبیق کامل منشأ|منشأ پرداخت نامعلوم|lineage/iu)
assert.equal(seed.count('SaleReturn', 'invoiceId=?', originalSale.id), before.returns, 'rejection made no return')
assert.equal(seed.count('SaleInvoice', 'sourceInvoiceId=?', originalSale.id), before.childInvoices, 'rejection made no invoice 2')
assert.equal(seed.count('StoreCredit', '1=1'), before.credits, 'rejection made no new credit')
assert.equal(seed.count('Payment', '1=1'), before.payments, 'rejection made no payment')
assert.equal(seed.count('CashMovement', '1=1'), before.cashMovements, 'rejection made no cash movement')
assert.deepEqual(originalVariants.map(stock), before.originalStock, 'rejection left original stock unchanged')
assert.deepEqual(replacements.map(stock), before.replacementStock, 'rejection left all four replacement stocks unchanged')
const rootAfter = seed.one('SELECT amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
assert.deepEqual(rootAfter, before.root, 'rejection left barcode amount/use/status/deadline unchanged')

console.log('AUDIT OBSERVATION: exchange 1 was rejected before any mutation.')
console.log('  Request: return two sold lines totaling 10M; replace with four 1M lines; return the 6M surplus to the existing multi-use barcode.')
console.log(`  Error: ${observedError.split('\n')[0]}`)
console.log('  Rollback check: no return, child invoice, extra credit, payment, cash movement, barcode change, or stock change.')
console.log('  Therefore invoice 2 was not created and the planned invoice-2 → invoice-3 (four lines totaling 60M) step could not be reached.')
console.log('  This is a reproducible rejection candidate for independent review, not a judgment that the guard is necessarily wrong.')
