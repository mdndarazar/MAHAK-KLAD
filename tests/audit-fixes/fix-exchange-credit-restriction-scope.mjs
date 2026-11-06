/**
 * Exchange barcode-tender scope regression. A manager-restricted barcode may
 * pay a positive exchange delta only when the replacement invoice contains an
 * eligible variant/category; another product must be rejected atomically.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-credit-restriction-scope.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-credit-scope-'))
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
const userId = seed.user('exchange-credit-restriction')
const shiftId = seed.insert('Shift', {
  name: 'exchange-credit-restriction', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'EXCHANGE-SCOPE-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryA = seed.category('exchange-credit-scope-A')
const categoryB = seed.category('exchange-credit-scope-B')
const productA = seed.product('exchange-credit-scope-product-A', categoryA)
const productB = seed.product('exchange-credit-scope-product-B', categoryB)
let seq = 0
const variant = (productId, price) => {
  const id = seed.variant(productId, `ECS-${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const makeRestricted = async (variantId, note) => {
  const row = await storeCreditService.issueManual({
    amount: 1_000_000, multiUse: false, carryRemainder: false,
    restrictScope: 'VARIANTS', restrictVariantIds: [variantId],
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note
  })
  return { id: row.id, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', row.id).code }
}
const makeSourceSale = async (sourceVariant, key) => {
  const sale = await salesService.create({
    userId, shiftId, lines: [line(sourceVariant, 1_000_000)],
    payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }]
  })
  const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  return { sale, item }
}

// The same restricted voucher is accepted for its specifically authorized A item.
const allowedVariant = variant(productA, 2_000_000)
const allowedCredit = await makeRestricted(allowedVariant, 'Only product A is allowed')
const allowedSourceVariant = variant(productB, 1_000_000)
const allowedSource = await makeSourceSale(allowedSourceVariant, 'allowed')
const allowedExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: allowedSource.sale.id,
  lines: [{ saleItemId: Number(allowedSource.item.id), qty: 1 }],
  replacements: [line(allowedVariant, 2_000_000)],
  exchangeCreditCode: allowedCredit.code, idempotencyKey: 'scope-allowed-A-0001'
})
assert.equal(allowedExchange.diff, 1_000_000)
assert.equal(allowedExchange.barcodeCreditApplied, 1_000_000)
assert.equal(allowedExchange.cashDue, 0)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', allowedCredit.id).usedAmount), 1_000_000)

// The same A-only rule cannot be bypassed by applying a similar barcode to B.
const otherVariant = variant(productB, 2_000_000)
const rejectedCredit = await makeRestricted(allowedVariant, 'Only product A is allowed; B must reject')
const rejectedSourceVariant = variant(productA, 1_000_000)
const rejectedSource = await makeSourceSale(rejectedSourceVariant, 'rejected')
const before = {
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', rejectedSourceVariant).stock),
  otherStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', otherVariant).stock)
}
await assert.rejects(() => salesService.createExchange({
  userId, shiftId, invoiceId: rejectedSource.sale.id,
  lines: [{ saleItemId: Number(rejectedSource.item.id), qty: 1 }],
  replacements: [line(otherVariant, 2_000_000)],
  exchangeCreditCode: rejectedCredit.code, idempotencyKey: 'scope-reject-B-0001'
}), /محدود|مجاز|کالا|اعتبار/u)
assert.deepEqual({
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', rejectedSourceVariant).stock),
  otherStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', otherVariant).stock)
}, before, 'out-of-scope redemption must rollback the whole exchange')
assert.deepEqual(seed.one('SELECT status,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', rejectedCredit.id), {
  status: 'ACTIVE', usedAmount: 0, usedCount: 0
}, 'rejected out-of-scope barcode remains spendable and unchanged')

// CATEGORY restrictions obey the same replacement-line eligibility, including
// the category of the actual replacement variant rather than the old invoice.
const makeCategoryCredit = async (note) => {
  const row = await storeCreditService.issueManual({
    amount: 1_000_000, multiUse: false, carryRemainder: false,
    restrictScope: 'CATEGORY', restrictCategoryIds: [categoryA],
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note
  })
  return { id: row.id, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', row.id).code }
}
const categoryCredit = await makeCategoryCredit('Only category A is allowed')
const categorySource = await makeSourceSale(allowedSourceVariant, 'category-allowed')
const categoryExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: categorySource.sale.id,
  lines: [{ saleItemId: Number(categorySource.item.id), qty: 1 }],
  replacements: [line(allowedVariant, 2_000_000)],
  exchangeCreditCode: categoryCredit.code, idempotencyKey: 'category-scope-allowed-A-0001'
})
assert.equal(categoryExchange.barcodeCreditApplied, 1_000_000)
assert.equal(categoryExchange.cashDue, 0)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', categoryCredit.id).usedAmount), 1_000_000)

const rejectedCategoryCredit = await makeCategoryCredit('Category A only; category B must reject')
const categorySourceA = variant(productA, 1_000_000)
const rejectedCategorySource = await makeSourceSale(categorySourceA, 'category-rejected')
const categoryCountsBefore = {
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', categorySourceA).stock),
  otherStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', otherVariant).stock)
}
await assert.rejects(() => salesService.createExchange({
  userId, shiftId, invoiceId: rejectedCategorySource.sale.id,
  lines: [{ saleItemId: Number(rejectedCategorySource.item.id), qty: 1 }],
  replacements: [line(otherVariant, 2_000_000)],
  exchangeCreditCode: rejectedCategoryCredit.code, idempotencyKey: 'category-scope-reject-B-0001'
}), /محدود|مجاز|کالا|اعتبار/u)
assert.deepEqual({
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', categorySourceA).stock),
  otherStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', otherVariant).stock)
}, categoryCountsBefore, 'category mismatch also rolls back the whole exchange')
assert.deepEqual(seed.one('SELECT status,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', rejectedCategoryCredit.id), {
  status: 'ACTIVE', usedAmount: 0, usedCount: 0
})

// A B-only multi-use code can settle only B's positive difference. The unused
// 30k stays on the same barcode; it is never reissued or broadened to A.
const partialReplacement = variant(productB, 1_020_000)
const partialCode = await storeCreditService.issueManual({
  amount: 50_000, multiUse: true, carryRemainder: true,
  restrictScope: 'VARIANTS', restrictVariantIds: [partialReplacement],
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'B-only partial exchange tender'
})
const partialCodeText = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', partialCode.id).code
const partialSource = await makeSourceSale(allowedSourceVariant, 'partial-B-tender')
const partialExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: partialSource.sale.id,
  lines: [{ saleItemId: Number(partialSource.item.id), qty: 1 }],
  replacements: [line(partialReplacement, 1_020_000)],
  exchangeCreditCode: partialCodeText, idempotencyKey: 'B-only-partial-exchange-tender-0001'
})
assert.equal(partialExchange.diff, 20_000)
assert.equal(partialExchange.barcodeCreditApplied, 20_000)
assert.equal(partialExchange.cashDue, 0)
const partialCreditState = seed.one('SELECT code,status,amount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', partialCode.id)
assert.equal(partialCreditState.code, partialCodeText)
assert.equal(partialCreditState.status, 'PARTIALLY_USED')
assert.equal(Number(partialCreditState.amount) - Number(partialCreditState.usedAmount), 30_000)
assert.equal(Number(partialCreditState.usedCount), 1)

console.log('✓ manager VARIANTS and CATEGORY credits: eligible replacement accepts up to the difference; unused multi-use balance stays on the same barcode; out-of-scope products reject atomically')
