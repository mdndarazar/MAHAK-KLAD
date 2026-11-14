/**
 * نشست ۲۲۳ · مورد ۷ — بدهی نسیه بدون نام/نام خانوادگی/تلفن ساخته نمی‌شود؛
 * snapshot روی همان فاکتور می‌ماند و Customer سراسری ساخته نمی‌شود.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item7-debtor-snapshot.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item7-'))
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

const userId = seed.user('تست مورد ۷')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۷')
const productId = seed.product('کالای مورد ۷', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const baseInput = (v, key, extra = {}) => ({
  userId,
  shiftId,
  lines: [{ variantId: v, qty: 1, unitPrice: 1000000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 400000, destination: 'CASH' }],
  allowPartial: true,
  saleRequestIdempotencyKey: key,
  ...extra
})
const state = () => ({
  invoices: n(seed.count('SaleInvoice')),
  items: n(seed.count('SaleInvoiceItem')),
  payments: n(seed.count('Payment')),
  customers: n(seed.count('Customer')),
  stockMovements: n(seed.count('StockMovement')),
  audits: n(seed.count('AuditLog', "entity = 'SaleInvoice'"))
})

console.log('\n۱) بدهی بدون هویت بدهکار ساخته نمی‌شود')
{
  const v = variant(1000000)
  const before = state()
  let error = null
  try {
    await salesService.create(baseInput(v, 's223-item7-no-debtor'))
  } catch (e) {
    error = String(e?.message ?? e)
  }
  check('فروش نسیه بدون مشخصات رد شد', () => {
    assert.ok(error, `باید رد شود؛ پیام: ${error}`)
    assert.match(error, /نام، نام خانوادگی و شماره تلفن بدهکار/)
  })
  check('هیچ فاکتور/پرداخت/مشتری/حرکتی ثبت نشد', () => assert.deepEqual(state(), before))
}

console.log('\n۲) نام یا تلفن ناقص هم کافی نیست')
{
  const v = variant(1000000)
  const before = state()
  let error = null
  try {
    await salesService.create(baseInput(v, 's223-item7-partial-debtor', {
      debtor: { firstName: 'علی', lastName: '', phone: '09120000000' }
    }))
  } catch (e) {
    error = String(e?.message ?? e)
  }
  check('نام خانوادگی خالی رد شد', () => assert.ok(error))
  check('mutation رخ نداد', () => assert.deepEqual(state(), before))
}

console.log('\n۳) snapshot روی همان فاکتور و بدون Customer سراسری')
{
  const v = variant(1000000)
  const customersBefore = n(seed.count('Customer'))
  const sale = await salesService.create(baseInput(v, 's223-item7-ok', {
    debtor: { firstName: 'سارا', lastName: 'محمدی', phone: '۰۹۱۲۳۴۵۶۷۸۹' }
  }))
  const row = seed.one(
    'SELECT debtorFirstName, debtorLastName, debtorPhone, debtorNationalId, customerId, paidTotal, grandTotal FROM "SaleInvoice" WHERE id = ?',
    sale.id
  )
  check('نام و نام خانوادگی روی فاکتور ذخیره شد', () => {
    assert.equal(row.debtorFirstName, 'سارا')
    assert.equal(row.debtorLastName, 'محمدی')
  })
  check('تلفن فارسی به ارقام لاتین نرمال شد', () => assert.equal(row.debtorPhone, '09123456789'))
  check('کد ملی خالی null ماند', () => assert.equal(row.debtorNationalId, null))
  check('بدهی ۶۰۰٬۰۰۰ روی همان فاکتور است', () => {
    assert.equal(n(row.grandTotal), 1000000)
    assert.equal(n(row.paidTotal), 400000)
  })
  check('Customer سراسری ساخته نشد', () => {
    assert.equal(n(seed.count('Customer')), customersBefore)
    assert.equal(row.customerId, null)
  })

  const detail = await salesService.get(n(sale.id))
  check('DTO فاکتور همان snapshot را برمی‌گرداند', () => {
    assert.equal(detail.debtorFirstName, 'سارا')
    assert.equal(detail.debtorPhone, '09123456789')
  })
}

console.log('\n۴) کد ملی اختیاری است و اگر بیاید ذخیره می‌شود')
{
  const v = variant(1000000)
  const sale = await salesService.create(baseInput(v, 's223-item7-national-id', {
    debtor: { firstName: 'رضا', lastName: 'کریمی', phone: '09121112233', nationalId: '0012345678' }
  }))
  const row = seed.one('SELECT debtorNationalId, debtorFirstName FROM "SaleInvoice" WHERE id = ?', sale.id)
  check('کد ملی ذخیره شد', () => assert.equal(row.debtorNationalId, '0012345678'))
}

console.log('\n۵) فاکتور بدون بدهی مشخصات بدهکار را ذخیره نمی‌کند (S223-D4)')
{
  const v = variant(1000000)
  const before = state()
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 1000000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1000000, destination: 'CASH' }],
    saleRequestIdempotencyKey: 's223-item7-non-debt',
    debtor: { firstName: 'سارا', lastName: 'محمدی', phone: '09123456789' }
  })
  const row = seed.one('SELECT debtorFirstName, debtorPhone, settledAt FROM "SaleInvoice" WHERE id = ?', sale.id)
  check('فروش نقدی کامل با مشخصات بدهکار ثبت می‌شود', () => {
    assert.ok(sale.id > 0)
    assert.ok(row.settledAt != null, 'فاکتور باید تسویه‌شده باشد')
  })
  check('snapshot بدهکار روی فاکتور نقدی نوشته نشد', () => {
    assert.equal(row.debtorFirstName, null)
    assert.equal(row.debtorPhone, null)
  })
  check('فقط فاکتور/سهام همان فروش اضافه شد، بدون Customer', () => {
    const after = state()
    assert.equal(after.customers, before.customers)
    assert.equal(after.invoices, before.invoices + 1)
  })
}

console.log('\n۶) تب نسیه همان هویت بدهکار را نشان می‌دهد و با نامش پیدا می‌شود')
{
  const today = toJalaliDate(new Date())
  const report = await salesService.creditList({ fromJalali: today, toJalali: today })
  const debtRow = report.rows.find((r) => r.debtorPhone === '09123456789')
  check('ردیف نسیه نام و تلفن بدهکار را دارد', () => {
    assert.ok(debtRow, 'ردیف نسیه پیدا نشد')
    assert.equal(debtRow.debtorName, 'سارا محمدی')
    assert.equal(debtRow.debtorPhone, '09123456789')
  })
  const byName = await salesService.creditList({ fromJalali: today, toJalali: today, customerSearch: 'محمدی' })
  check('جستجوی نام بدهکار فاکتور را پیدا می‌کند', () => {
    assert.ok(byName.rows.some((r) => r.debtorPhone === '09123456789'), 'با نام بدهکار پیدا نشد')
  })
  const byPhone = await salesService.creditList({ fromJalali: today, toJalali: today, customerSearch: '09123456789' })
  check('جستجوی تلفن بدهکار هم کار می‌کند', () => {
    assert.ok(byPhone.rows.some((r) => r.debtorPhone === '09123456789'), 'با تلفن بدهکار پیدا نشد')
  })
  const miss = await salesService.creditList({ fromJalali: today, toJalali: today, customerSearch: 'ZZZناموجود' })
  check('جستجوی بی‌ربط چیزی برنمی‌گرداند', () => assert.equal(miss.rows.length, 0))
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
