/**
 * نشست ۲۲۳ · مورد ۵ — «صفرِ اثبات‌شده» با scope از «منشأ نامعلوم» جدا می‌شود:
 * A→A1 که هیچ سهمی از اعتبارهای محدود B/C مصرف نکرده، عملیات بعدی را متوقف
 * نمی‌کند؛ ولی سابقهٔ واقعاً مبهم همچنان fail-closed رد می‌شود.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item5-proven-zero-scope.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item5-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (v) => Number(v ?? 0)
let ok = 0
let bad = 0
const check = (label, fn) => {
  try {
    fn()
    ok++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    bad++
    console.log(`  ✗ ${label} — ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
const userId = seed.user('تست مورد ۵')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۵')
const productId = seed.product('کالای مورد ۵', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = ? WHERE id = ?').run(price, id)
  return { id, price }
}
const line = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const issueScoped = async (amount, variantId) => {
  const issued = await storeCreditService.issueManual({
    amount, multiUse: false, carryRemainder: true, days: 30, userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    restrictScope: 'VARIANTS',
    restrictVariantIds: [variantId]
  })
  const row = seed.one('SELECT id, code, restrictScope FROM "StoreCredit" WHERE id = ?', n(issued.id))
  return { id: n(row.id), code: row.code, scope: row.restrictScope }
}

console.log('\n۱) فاکتور ۹۰۰٬۰۰۰ = A ۳۰۰٬۰۰۰ نقد + B/C محدود + D نقد')
const A = variant(300000)
const B = variant(200000)
const C = variant(200000)
const D = variant(200000)
const creditB = await issueScoped(200000, B.id)
const creditC = await issueScoped(200000, C.id)
const sale = await salesService.create({
  userId, shiftId,
  lines: [line(A), line(B), line(C), line(D)],
  payments: [{ methodId: cash, amount: 500000, destination: 'CASH' }],
  storeCredits: [{ code: creditB.code }, { code: creditC.code }],
  saleRequestIdempotencyKey: 's223-item5-sale'
})
check('فاکتور ۹۰۰٬۰۰۰ با ۴۰۰٬۰۰۰ اعتبار محدود و ۵۰۰٬۰۰۰ نقد', () => {
  assert.equal(n(sale.grandTotal), 900000)
  assert.equal(n(sale.storeCreditApplied), 400000)
})
const items = seed.rows('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id)
const itemOf = (v) => items.find((row) => n(row.variantId) === v.id)

console.log('\n۲) A→A1 خارج از scope اعتبارهای B/C؛ سپس برگشت B نباید کاذب رد شود')
const A1 = variant(300000)
const ex1 = await salesService.createExchange({
  userId, shiftId, invoiceId: n(sale.id),
  lines: [{ saleItemId: n(itemOf(A).id), qty: 1 }],
  replacements: [line(A1)],
  idempotencyKey: 's223-item5-ex1'
})
check('تعویض A→A1 (بدون سهم اعتبار) پذیرفته شد', () => {
  assert.ok(ex1.exchangeInvoiceId)
  assert.equal(n(ex1.diff), 0)
  assert.equal(n(ex1.sourceCreditRestoredAmount), 0)
})
let secondError = null
let second = null
try {
  second = await salesService.createReturn({
    userId, shiftId, invoiceId: n(sale.id), full: false,
    lines: [{ saleItemId: n(itemOf(B).id), qty: 1 }],
    refundDecision: 'METHOD', refundMethod: 'STORE_CREDIT', refundAmount: 200000, creditDays: 30
  })
} catch (error) {
  secondError = String(error?.message ?? error)
}
check('برگشت B پس از A→A1 پذیرفته شد (صفرِ اثبات‌شده)', () => {
  assert.equal(secondError, null, secondError ?? '')
  assert.ok(second)
})
check('سهم اعتبار B برگشت (اعتبار کاملاً مصرف‌شده جانشین گرفت) و پول واقعی صفر ماند', () => {
  assert.equal(n(second.sourceCreditRestoredAmount), 200000)
  assert.equal(n(second.refundAmount), 0)
  const source = seed.one('SELECT amount, usedAmount, status FROM "StoreCredit" WHERE code = ?', creditB.code)
  assert.equal(n(source.usedAmount), 200000)
  assert.equal(source.status, 'USED')
  const restored = seed.rows('SELECT amount, status, lineageId FROM "StoreCredit" WHERE returnId = ?', second.id)
  assert.equal(restored.length, 1)
  assert.equal(n(restored[0].amount), 200000)
  assert.equal(restored[0].status, 'ACTIVE')
})

console.log('\n۳) کنترل: سابقهٔ واقعاً مبهم (ALL بدون allocation) همچنان رد می‌شود')
{
  const X = variant(300000)
  const Y = variant(200000)
  const allCredit = await storeCreditService.issueManual({
    amount: 200000, multiUse: false, carryRemainder: true, days: 30, userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  const allCode = seed.one('SELECT code FROM "StoreCredit" WHERE id = ?', n(allCredit.id)).code
  const inv = await salesService.create({
    userId, shiftId,
    lines: [line(X), line(Y)],
    payments: [{ methodId: cash, amount: 300000, destination: 'CASH' }],
    storeCredits: [{ code: allCode }],
    saleRequestIdempotencyKey: 's223-item5-ambiguous-sale'
  })
  const invItems = seed.rows('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId = ?', inv.id)
  const xItem = invItems.find((row) => n(row.variantId) === X.id)
  const yItem = invItems.find((row) => n(row.variantId) === Y.id)
  // شبیه‌سازی سابقهٔ قدیمی: برگشتی که هیچ allocation اعتباری ندارد ولی مصرف
  // اعتبار روی فاکتور هنوز فعال است (دقیقاً همان حالتی که باید fail-closed بماند).
  const today = toJalaliDate(new Date())
  const legacyReturnId = n(sql.prepare(
    'INSERT INTO "SaleReturn" (invoiceId, isFull, total, returnedAtJalali, kind, userId, shiftId, refundMethod, refundAmount) VALUES (?, 0, ?, ?, ?, ?, ?, ?, 0)'
  ).run(n(inv.id), 200000, today, 'RETURN', userId, shiftId, 'NONE').lastInsertRowid)
  sql.prepare(
    'INSERT INTO "SaleReturnItem" (returnId, saleItemId, variantId, qty, unitPrice, lineTotal) VALUES (?, ?, ?, 1, ?, ?)'
  ).run(legacyReturnId, n(yItem.id), Y.id, 200000, 200000)
  const X1 = variant(300000)
  let ambiguousError = null
  try {
    await salesService.createExchange({
      userId, shiftId, invoiceId: n(inv.id),
      lines: [{ saleItemId: n(xItem.id), qty: 1 }],
      replacements: [line(X1)],
      idempotencyKey: 's223-item5-ambiguous-ex'
    })
  } catch (error) {
    ambiguousError = String(error?.message ?? error)
  }
  check('منشأ نامعلوم همچنان fail-closed است', () => {
    assert.ok(ambiguousError, `باید رد شود؛ نتیجه: ${ambiguousError}`)
    assert.match(ambiguousError, /تخصیص منشأ اعتبار ندارد|منشأ/)
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
