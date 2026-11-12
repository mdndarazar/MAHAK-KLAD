/**
 * نشست ۲۲۳ · مورد ۶/ب (S223-D9) — مابه‌التفاوت تعویض با چک.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item6b-exchange-d-by-cheque.mjs
 *
 * قبلاً هر پرداختِ مابه‌التفاوت با `kind: CASH` ساخته می‌شد، حتی با روش «چک»:
 * صندوق آخر شب اضافیِ الکی نشان می‌داد، چک در فهرست چک‌ها/یادآوری نبود و حساب
 * مشتری «تسویه‌شده» دیده می‌شد. حالا چکِ واقعی با شماره/بانک/سررسید و وضعیت
 * «در جریان» ثبت می‌شود و هیچ پولی به کشو نمی‌آید.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item6b-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')
process.env.HARNESS_BIGINT = '1'

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
const rejectsWith = async (label, fn, pattern) => {
  try {
    await fn()
    bad++
    console.log(`  ✗ ${label} — هیچ خطایی پرتاب نشد`)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (pattern.test(message)) {
      ok++
      console.log(`  ✓ ${label}`)
    } else {
      bad++
      console.log(`  ✗ ${label} — پیام نامنتظره: ${message.split('\n')[0].slice(0, 100)}`)
    }
  }
}

const today = toJalaliDate(new Date())
const userId = seed.user('تست مورد ۶ب')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3600_000, userId, staffConfirmed: 1
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const chequeMethod = seed.insert('PaymentMethod', {
  key: 'CHEQUE', label: 'چک', kind: 'CUSTOM', isActive: 1, sortOrder: 5
})
const category = seed.category('دستهٔ مورد ۶ب')
const productId = seed.product('کالای مورد ۶ب', category)
let sizeSeq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++sizeSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const cashMovementSum = () =>
  n(
    sql
      .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM \"CashMovement\" WHERE type LIKE '%EXCHANGE%'")
      .get().s
  )

console.log('\n۱) تعویض گران‌تر با پرداخت نقد: مثل قبل کار می‌کند (پول به کشو می‌آید)')
let cashExchangeId = null
{
  const cheap = variant(1_000_000)
  const expensive = variant(1_500_000)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: cheap, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', Number(sale.id))
  const before = cashMovementSum()
  const exchange = await salesService.createExchange({
    invoiceId: Number(sale.id),
    lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
    replacements: [{ variantId: expensive, qty: 1, unitPrice: 1_500_000, discount: 0, tax: 0 }],
    methodId: cash,
    destination: 'CASH',
    userId,
    shiftId,
    requestIdempotencyKey: 's223-item6b-cash-d'
  })
  cashExchangeId = Number(exchange.exchangeInvoiceId)
  check('مابه‌التفاوت ۵۰۰٬۰۰۰ نقد ثبت شد', () => {
    const row = seed.one(
      "SELECT amount, kind, destination FROM \"Payment\" WHERE invoiceId = ? AND voidedAt IS NULL ORDER BY id DESC LIMIT 1",
      cashExchangeId
    )
    assert.equal(n(row.amount), 500_000)
    assert.equal(row.kind, 'CASH')
    assert.equal(row.destination, 'CASH')
  })
  check('و مقصدش کشوی نقد است (پول واقعی)', () => assert.equal(cashMovementSum() >= before, true))
}

console.log('\n۲) تعویض گران‌تر با چک: چکِ واقعی، بدون اثر روی کشو')
let chequeExchangeId = null
{
  const cheap = variant(1_000_000)
  const expensive = variant(1_500_000)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: cheap, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', Number(sale.id))
  const before = cashMovementSum()
  const exchange = await salesService.createExchange({
    invoiceId: Number(sale.id),
    lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
    replacements: [{ variantId: expensive, qty: 1, unitPrice: 1_500_000, discount: 0, tax: 0 }],
    methodId: chequeMethod,
    chequeNo: '123456',
    bankName: 'ملت',
    dueDateJalali: '1405/09/01',
    userId,
    shiftId,
    requestIdempotencyKey: 's223-item6b-cheque-d'
  })
  chequeExchangeId = Number(exchange.exchangeInvoiceId)
  const row = seed.one(
    'SELECT amount, kind, destination, chequeNo, bankName, dueDateJalali, chequeStatus FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL ORDER BY id DESC LIMIT 1',
    chequeExchangeId
  )
  check('پرداخت با نوع CHEQUE و مبلغ ۵۰۰٬۰۰۰ ثبت شد', () => {
    assert.equal(row.kind, 'CHEQUE')
    assert.equal(n(row.amount), 500_000)
  })
  check('شماره/بانک/سررسید چک ذخیره شد', () => {
    assert.equal(row.chequeNo, '123456')
    assert.equal(row.bankName, 'ملت')
    assert.equal(row.dueDateJalali, '1405/09/01')
  })
  check('وضعیت چک «در جریان» است، نه تسویه', () => assert.equal(row.chequeStatus, 'PENDING'))
  check('مقصد پول خالی است (پول به کشو/کارت‌خوان نرسیده)', () => assert.equal(row.destination, null))
  check('هیچ حرکتی در صندوق ثبت نشد', () => assert.equal(cashMovementSum(), before))
  check('در فهرست چک‌ها (مرتب‌شده با سررسید) دیده می‌شود', () => {
    // فهرست چک‌ها با dueDate مرتب می‌شود؛ اگر این ستون خالی بماند ردیف در فهرست گم می‌شد.
    const due = seed.one(
      'SELECT dueDate, chequeNo FROM "Payment" WHERE invoiceId = ? AND chequeStatus IS NOT NULL ORDER BY id DESC LIMIT 1',
      chequeExchangeId
    )
    assert.equal(due.chequeNo, '123456')
    assert.ok(due.dueDate != null)
  })
  check('سند تعویض تا وصول چک «تسویه‌نشده» می‌ماند (مثل فروش چکی)', () => {
    const inv = seed.one('SELECT settledAt, grandTotal FROM "SaleInvoice" WHERE id = ?', chequeExchangeId)
    assert.equal(inv.settledAt, null)
    // سند تعویض = ارزش کامل جنس جدید (۱٬۵۰۰٬۰۰۰) که ۱٬۰۰۰٬۰۰۰ آن از اعتبار برگشت و
    // ۵۰۰٬۰۰۰ آن با این چکِ در جریان پوشش داده شده است.
    assert.equal(n(inv.grandTotal), 1_500_000)
    const pays = seed.rows('SELECT amount FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL', chequeExchangeId)
    assert.equal(pays.reduce((sum, row) => sum + n(row.amount), 0), 1_500_000)
  })
}

console.log('\n۳) چک بدون شماره/سررسید رد می‌شود و هیچ چیزی ثبت نمی‌شود')
{
  const cheap = variant(1_000_000)
  const expensive = variant(1_500_000)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: cheap, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', Number(sale.id))
  const paymentsBefore = n(seed.count('Payment'))
  const invoicesBefore = n(seed.count('SaleInvoice'))
  await rejectsWith(
    'بدون شمارهٔ چک رد می‌شود',
    () =>
      salesService.createExchange({
        invoiceId: Number(sale.id),
        lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
        replacements: [{ variantId: expensive, qty: 1, unitPrice: 1_500_000, discount: 0, tax: 0 }],
        methodId: chequeMethod,
        chequeNo: '',
        dueDateJalali: '1405/09/01',
        userId,
        shiftId,
        requestIdempotencyKey: 's223-item6b-bad-1'
      }),
    /شمارهٔ چک/
  )
  await rejectsWith(
    'بدون سررسید معتبر رد می‌شود',
    () =>
      salesService.createExchange({
        invoiceId: Number(sale.id),
        lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
        replacements: [{ variantId: expensive, qty: 1, unitPrice: 1_500_000, discount: 0, tax: 0 }],
        methodId: chequeMethod,
        chequeNo: '999888',
        dueDateJalali: 'نامعتبر',
        userId,
        shiftId,
        requestIdempotencyKey: 's223-item6b-bad-2'
      }),
    /سررسید/
  )
  check('هیچ پرداخت/سند تعویضی ساخته نشد (rollback کامل)', () => {
    assert.equal(n(seed.count('Payment')), paymentsBefore)
    assert.equal(n(seed.count('SaleInvoice')), invoicesBefore)
  })
  check('پرداخت نقدیِ فاکتور مبدأ دست‌نخورده ماند (بدون ابطال/دوباره‌شماری)', () => {
    const pays = seed.rows(
      'SELECT amount, voidedAt FROM "Payment" WHERE invoiceId = ? ORDER BY id ASC',
      Number(sale.id)
    )
    assert.equal(pays.length, 1)
    assert.equal(n(pays[0].amount), 1_000_000)
    assert.equal(pays[0].voidedAt, null)
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
