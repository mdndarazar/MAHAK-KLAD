/**
 * نشست ۲۲۳ · مورد ۴ + یافتهٔ ۱ — مبلغ بازپرداخت دقیقاً برابر حق امن؛
 * روش خالی هیچ اعتبار خودکاری نمی‌سازد.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item4-exact-refund-and-no-auto-credit.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item4-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
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

const userId = seed.user('تست مورد ۴')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۴')
const productId = seed.product('کالای مورد ۴', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const snapshot = () => ({
  returns: n(seed.count('SaleReturn')),
  payments: n(seed.count('Payment')),
  cashMovements: n(seed.count('CashMovement')),
  credits: n(seed.count('StoreCredit')),
  stockMovements: n(seed.count('StockMovement')),
  redemptions: n(seed.count('StoreCreditRedemption'))
})

console.log('\n۱) فاکتور ۱۰۰٬۰۰۰ نقدی')
const v1 = variant(100000)
const sale1 = await salesService.create({
  userId, shiftId, lines: [line(v1, 100000)],
  payments: [{ methodId: cash, amount: 100000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 's223-item4-sale-1'
})
const item1 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale1.id)
const base = { userId, shiftId, invoiceId: n(sale1.id), full: true, lines: [{ saleItemId: n(item1.id), qty: 1 }] }

const tryRefund = async (refundAmount) => {
  try {
    const res = await salesService.createReturn({ ...base, refundDecision: 'METHOD', refundMethod: 'CASH', refundAmount })
    return { ok: true, res }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) }
  }
}

console.log('\n۲) E−1 و E+1 رد می‌شوند و هیچ mutation نمی‌سازند')
{
  const before = snapshot()
  const low = await tryRefund(99999)
  check('کمتر از حق امن رد شد', () => assert.equal(low.ok, false))
  check('پیام، کسری ۱ ریال را با عدد دقیق می‌گوید', () => {
    assert.match(low.message, /کم‌تر/)
    assert.ok(low.message.includes('اختلاف ۱ ریال'), low.message)
    assert.ok(low.message.includes('۱۰۰٬۰۰۰'), low.message)
  })
  const high = await tryRefund(100001)
  check('بیشتر از حق امن رد شد', () => assert.equal(high.ok, false))
  check('پیام، مبلغ بیش از حق را با عدد دقیق می‌گوید', () => {
    assert.ok(high.message.includes('۱۰۰٬۰۰۱'), high.message)
    assert.ok(high.message.includes('۱۰۰٬۰۰۰'), high.message)
  })
  check('هیچ برگشت/پرداخت/حرکت/اعتباری ثبت نشد', () => assert.deepEqual(snapshot(), before))
  check('موجودی کالا دست‌نخورده ماند (۹ = فقط کسر فروش)', () =>
    assert.equal(n(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v1).stock), 9))
}

console.log('\n۳) E دقیقاً پذیرفته می‌شود')
{
  const exact = await tryRefund(100000)
  check('برگشت با مبلغ دقیق ثبت شد', () => assert.equal(exact.ok, true))
  check('نقد برگشتی ۱۰۰٬۰۰۰ است', () => {
    assert.equal(n(exact.res?.refundAmount), 100000)
    assert.equal(exact.res?.refundMethod, 'CASH')
  })
  check('کالا به انبار برگشت', () =>
    assert.equal(n(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v1).stock), 10))
}

console.log('\n۴) فراخوانِ قدیمی بدون تصمیم: هیچ اعتبار خودکاری ساخته نمی‌شود')
{
  const v2 = variant(100000)
  const sale2 = await salesService.create({
    userId, shiftId, lines: [line(v2, 100000)],
    payments: [{ methodId: cash, amount: 100000, destination: 'CASH' }],
    saleRequestIdempotencyKey: 's223-item4-sale-2'
  })
  const item2 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale2.id)
  const creditsBefore = n(seed.count('StoreCredit'))
  const stateBefore = snapshot()
  let legacyError = null
  try {
    await salesService.createReturn({
      userId, shiftId, invoiceId: n(sale2.id), full: true, lines: [{ saleItemId: n(item2.id), qty: 1 }]
    })
  } catch (error) {
    legacyError = String(error?.message ?? error)
  }
  check('برگشت بدون تصمیم/روش، بی‌صدا اضافه‌دریافت نمی‌سازد و ثبت نمی‌شود', () => {
    assert.ok(legacyError, 'باید رد شود و منتظر تصمیم صریح فروشنده بماند')
    assert.match(legacyError, /اضافه‌دریافت/)
  })
  check('هیچ اعتبار خودکاری ساخته نشد', () =>
    assert.equal(n(seed.count('StoreCredit')), creditsBefore))
  check('هیچ mutation مالی/انباری رخ نداد', () => assert.deepEqual(snapshot(), stateBefore))
  check('paidTotal فاکتور دست‌نخورده است', () => {
    const inv = seed.one('SELECT paidTotal, grandTotal FROM "SaleInvoice" WHERE id = ?', sale2.id)
    assert.equal(n(inv.paidTotal), 100000)
    assert.equal(n(inv.grandTotal), 100000)
  })
}

console.log('\n۵) انتخاب صریح overpayAsCredit همچنان کار می‌کند')
{
  const v3 = variant(100000)
  const sale3 = await salesService.create({
    userId, shiftId, lines: [line(v3, 100000)],
    payments: [{ methodId: cash, amount: 100000, destination: 'CASH' }],
    saleRequestIdempotencyKey: 's223-item4-sale-3'
  })
  const item3 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale3.id)
  const creditsBefore = n(seed.count('StoreCredit'))
  const explicit = await salesService.createReturn({
    userId, shiftId, invoiceId: n(sale3.id), full: true,
    lines: [{ saleItemId: n(item3.id), qty: 1 }],
    refundDecision: 'DECLINED',
    refundMethod: 'NONE',
    refundNote: 'مشتری وجه نمی‌خواهد؛ اعتبار بدهید',
    confirmOverpay: true,
    overpayAsCredit: true,
    overpayManagerPassword: DEFAULT_MANAGER_PASSWORD
  })
  check('اعتبار صریح صادر شد', () => assert.ok(explicit.overpayCredit))
  check('فقط یک اعتبار اضافه شد', () =>
    assert.equal(n(seed.count('StoreCredit')), creditsBefore + 1))
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
