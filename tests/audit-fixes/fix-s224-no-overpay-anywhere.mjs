/**
 * نشست ۲۲۴ — مورد ۴ (تصمیم موخرِ «طرح نهایی رفع ابهام»): منع سراسری اضافه‌پرداخت.
 *
 * قاعده: هیچ اضافه‌دریافتی در فروش، ویرایش فاکتور و وصول بدهی مجاز نیست.
 * رمز مدیر، دلیل، `confirmOverpay` و `overpayAsCredit` هیچ‌کدام مبلغ بیش‌ازحد را
 * مجاز نمی‌کنند؛ اختلاف دقیق در پیام می‌آید و دیتابیس دست‌نخورده می‌ماند.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s224-no-overpay-anywhere.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s224-overpay-'))
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

const userId = seed.user('تست منع اضافه‌پرداخت')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category('دستهٔ منع اضافه‌پرداخت')
const productId = seed.product('کالای منع اضافه‌پرداخت', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const counts = () => ({
  invoices: n(seed.count('SaleInvoice')),
  payments: n(seed.count('Payment')),
  credits: n(seed.count('StoreCredit')),
  returns: n(seed.count('SaleReturn'))
})
const make = (paid, extra = {}) => {
  const v = variant(100000)
  return salesService.create({
    debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
    userId, shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 100000, discount: 0, tax: 0 }],
    payments: paid > 0 ? [{ methodId: cash, amount: paid }] : [],
    ...extra
  })
}
let lastMessage = ''
const rejects = async (fn, needle) => {
  try {
    await fn()
    return 'ACCEPTED'
  } catch (e) {
    const m = String(e?.message ?? e)
    lastMessage = m
    return m.includes(needle) ? 'rejected' : 'other:' + m.split('\n')[0]
  }
}

// ۱) فروش: پرداخت بیشتر از جمع کل — هیچ پرچمی آن را مجاز نمی‌کند
{
  const before = counts()
  const r1 = await rejects(() => make(120000), 'بیشتر است')
  const m1 = lastMessage
  check('فروش بدون تأیید → رد', () => { if (r1 !== 'rejected') throw new Error(r1) })
  const r2 = await rejects(() => make(120000, { confirmOverpay: true }), 'بیشتر است')
  check('فروش با confirmOverpay → باز هم رد', () => { if (r2 !== 'rejected') throw new Error(r2) })
  const r3 = await rejects(() => make(120000, { confirmOverpay: true, overpayAsCredit: true }), 'بیشتر است')
  check('فروش با confirmOverpay + overpayAsCredit → باز هم رد', () => { if (r3 !== 'rejected') throw new Error(r3) })
  const r4 = await rejects(() => make(120000, { managerPassword: 'x', overrideReason: 'تأیید مدیر' }), 'بیشتر است')
  check('فروش با رمز/دلیل مدیر → باز هم رد', () => { if (r4 !== 'rejected') throw new Error(r4) })
  check('هیچ فاکتور/پرداخت/اعتباری از درخواست‌های ردشده ساخته نشد', () => {
    const after = counts()
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(JSON.stringify({ before, after }))
  })
  check('اختلاف دقیق ۲۰٬۰۰۰ ریال در پیام آمده است', () => {
    if (!m1.includes('۲۰٬۰۰۰') && !m1.includes('20000')) throw new Error(m1)
  })
}

// ۲) پرداخت دقیق مثل قبل بی‌هشدار ثبت می‌شود
let exact = null
try { exact = await make(100000) } catch (e) { check('پرداخت دقیق ۱۰۰٬۰۰۰ مثل قبل ثبت می‌شود', () => { throw e }) }
check('پرداخت دقیق: بدون اضافه‌دریافت', () => {
  if (!exact) throw new Error('فاکتور دقیق ثبت نشد')
  const rows = seed.rows('SELECT amount, overpayAmount FROM "Payment" WHERE invoiceId = ?', n(exact.id))
  if (rows.some((r) => n(r.overpayAmount) !== 0)) throw new Error('overpayAmount غیرصفر')
})

// ۳) وصول بدهی: پرداخت بیشتر از باقی‌مانده رد می‌شود
{
  const partial = await make(60000) // بدهی ۴۰٬۰۰۰
  const before = counts()
  const pay = (amount, extra = {}) =>
    salesService.addPayment({ invoiceId: n(partial.id), amount, methodId: cash, destination: 'CASH', userId, ...extra })
  const a = await rejects(() => pay(50000), 'بیشتر است')
  check('وصول بدهی ۵۰٬۰۰۰ روی باقی‌ماندهٔ ۴۰٬۰۰۰ بدون تأیید → رد', () => { if (a !== 'rejected') throw new Error(a) })
  const b = await rejects(() => pay(50000, { confirmOverpay: true }), 'بیشتر است')
  check('وصول بدهی با confirmOverpay → باز هم رد', () => { if (b !== 'rejected') throw new Error(b) })
  const c = await rejects(() => pay(50000, { confirmOverpay: true, overpayAsCredit: true }), 'بیشتر است')
  check('وصول بدهی با confirmOverpay + overpayAsCredit → باز هم رد', () => { if (c !== 'rejected') throw new Error(c) })
  check('وصول بدهی ردشده هیچ پرداخت/اعتباری نساخت', () => {
    const after = counts()
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(JSON.stringify({ before, after }))
  })
  const d = await rejects(() => pay(40000 + 1), 'بیشتر است')
  check('حتی یک ریال اضافه (۴۰٬۰۰۱) هم رد می‌شود', () => { if (d !== 'rejected') throw new Error(d) })
  const okPay = await rejects(() => pay(40000), 'بیشتر است')
  check('پرداخت دقیقاً برابر باقی‌مانده (۴۰٬۰۰۰) پذیرفته می‌شود', () => { if (okPay !== 'ACCEPTED') throw new Error(okPay) })
}

// ۴) ویرایش فاکتور: ویرایشی که اضافه‌دریافت بسازد رد می‌شود
{
  const inv = await make(60000)
  const v2 = variant(50000)
  const edit = (extra = {}) =>
    salesService.update({
      id: n(inv.id), userId,
      lines: [{ variantId: v2, qty: 1, unitPrice: 50000, discount: 0, tax: 0 }],
      ...extra
    })
  const e1 = await rejects(() => edit({ confirmOverpay: true }), 'بیشتر')
  check('ویرایش فاکتور به ۵۰٬۰۰۰ با ۶۰٬۰۰۰ دریافتی → رد (حتی با تأیید)', () => { if (e1 !== 'rejected') throw new Error(e1) })
}

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
