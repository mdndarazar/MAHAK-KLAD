/**
 * نشست ۲۲۳ · مورد ۳ — پیش‌نمایش read-only تسویهٔ تعویض:
 * پیش از commit، سرور باید دقیقاً بگوید چه مقدار وجه واقعی خارج می‌شود و چه مقدار
 * از همان سهم به بارکد اعتبار خرید تبدیل می‌شود؛ عددِ همان plan، نه یک حدس UI.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item3-settlement-split-preview.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item3-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
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

const userId = seed.user('تست مورد ۳')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۳')
const productId = seed.product('کالای مورد ۳', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}

/** فاکتور منبع: یک قلم ۱۰۰۰ ریالی که کامل نقد پرداخت شده است. */
const sourceVariant = variant(1000)
const source = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: sourceVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 's223-item3-source-sale'
})
const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', source.id)
const cheap = variant(600)

console.log('\n۱) پیش‌نمایش، سهم وجه واقعی را از همان plan سرور می‌دهد')
const base = await salesService.previewExchangeFunding({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }]
})
check('پیش‌نمایش موفق است', () => assert.equal(base.ok, true, base.error))
check('سهم وجه واقعی = ۴۰۰ (۱۰۰۰ برگشتی − ۶۰۰ جایگزین)', () => {
  assert.equal(n(base.settlementSplit?.moneySurplus), 400)
})
check('بدون مبلغ درخواستی، کل سهم پرداخت می‌شود و اعتبار صفر است', () => {
  assert.equal(n(base.settlementSplit?.payoutAmount), 400)
  assert.equal(n(base.settlementSplit?.remainderAsCredit), 0)
  assert.equal(base.settlementSplit?.requestedPayout, null)
  assert.equal(base.settlementSplit?.overRequested, false)
})

console.log('\n۲) مبلغ جزئی: تفکیک «پرداخت واقعی» و «تبدیل به اعتبار» پیش از ثبت')
const partial = await salesService.previewExchangeFunding({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
  refundAmount: 150
})
check('پرداخت واقعی = ۱۵۰', () => assert.equal(n(partial.settlementSplit?.payoutAmount), 150))
check('ماندهٔ تبدیل‌شده به اعتبار = ۲۵۰', () => assert.equal(n(partial.settlementSplit?.remainderAsCredit), 250))
check('مبلغ درخواستی همان‌طور گزارش می‌شود', () => assert.equal(partial.settlementSplit?.requestedPayout, 150))

const zero = await salesService.previewExchangeFunding({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
  refundAmount: 0
})
check('مبلغ صفر: هیچ پولی خارج نمی‌شود و کل ۴۰۰ اعتبار می‌شود', () => {
  assert.equal(n(zero.settlementSplit?.payoutAmount), 0)
  assert.equal(n(zero.settlementSplit?.remainderAsCredit), 400)
})

console.log('\n۳) مبلغ بیشتر از سهم و مبلغ نامعتبر، پیش از ثبت علامت می‌خورند')
const over = await salesService.previewExchangeFunding({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
  refundAmount: 500
})
check('بیشتر از سهم ⇒ overRequested', () => assert.equal(over.settlementSplit?.overRequested, true))
check('پرداخت پیش‌نمایش از سهم بیشتر نمی‌شود', () => assert.equal(n(over.settlementSplit?.payoutAmount), 400))

const invalid = await salesService.previewExchangeFunding({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
  refundAmount: 12.5
})
check('مبلغ اعشاری ⇒ invalidReason', () => {
  assert.ok(invalid.ok, 'پیش‌نمایش نباید بترکد')
  assert.match(String(invalid.settlementSplit?.invalidReason ?? ''), /عدد صحیح/)
})

console.log('\n۴) ثبت نهایی همان تفکیک را می‌سازد (۱۵۰ نقد + ۲۵۰ بارکد اعتبار)')
const before = {
  credits: n(seed.count('StoreCredit')),
  cash: n(seed.count('CashMovement', "type = 'EXCHANGE_REFUND'"))
}
const created = await salesService.createExchange({
  invoiceId: n(source.id),
  lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
  replacements: [{ variantId: cheap, qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
  refundMode: 'CASH',
  exchangeSettlementDecision: 'METHOD',
  refundAmount: 150,
  userId,
  shiftId,
  requestIdempotencyKey: 's223-item3-exchange-commit'
})
check('تعویض ثبت شد', () => assert.ok(created?.exchangeInvoiceId > 0))
check('نتیجهٔ ثبت، همان تفکیک پیش‌نمایش را گزارش می‌کند', () => {
  assert.equal(n(created.newStoreCreditAmount), 250)
  assert.equal(n(created.cashRefunded), 150)
  assert.equal(n(created.realMoneyRefundAmount), 400)
  assert.equal(n(created.payoutAmount), 150)
})
check('بارکد اعتبار ۲۵۰ ریالی صادر شد (همان ماندهٔ پیش‌نمایش)', () => {
  assert.equal(n(seed.count('StoreCredit')), before.credits + 1)
  const credit = seed.one('SELECT amount, expiresAt FROM "StoreCredit" ORDER BY id DESC LIMIT 1')
  assert.equal(n(credit.amount), 250)
  assert.equal(credit.expiresAt, null, 'اعتبار سهم پولی تعویض بی‌انقضاست')
})
check('خروج نقد ۱۵۰ ریالی (نه ۴۰۰)', () => {
  assert.equal(n(seed.count('CashMovement', "type = 'EXCHANGE_REFUND'")), before.cash + 1)
  const movement = seed.one('SELECT amount FROM "CashMovement" WHERE type = \'EXCHANGE_REFUND\' ORDER BY id DESC LIMIT 1')
  assert.equal(n(movement.amount), 150)
})

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
