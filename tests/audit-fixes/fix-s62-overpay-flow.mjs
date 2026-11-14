/**
 * نشست ۶۲ (قدیمی) — «فلوی چهارمرحله‌ای اضافه‌دریافت».
 *
 * ⚠️ منسوخ‌شده با «تصمیم موخرِ مورد ۴ طرح رفع ابهام» (نشست ۲۲۴):
 * هیچ اضافه‌دریافتی مجاز نیست؛ رمز مدیر، دلیل، `confirmOverpay` و
 * `overpayAsCredit` هم آن را مجاز نمی‌کنند. اسناد و اعتبارهای ساخته‌شده با آن
 * فلوی قدیمی «تاریخچه»اند و حذف نمی‌شوند، ولی دیگر تولید نمی‌شوند.
 *
 * این فایل همان مسیر قدیمی را می‌سنجد تا اگر روزی کسی فلوی اضافه‌دریافت را
 * برگرداند، تست قرمز شود. آزمون کاملِ منع سراسری: `fix-s224-no-overpay-anywhere.mjs`.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s62-overpay-flow.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s62-superseded-'))
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

const userId = seed.user('تست منسوخ‌شدهٔ نشست ۶۲')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ نشست ۶۲')
const productId = seed.product('کالای نشست ۶۲', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const sale = (paid, extra = {}) =>
  salesService.create({
    debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
    userId, shiftId,
    lines: [{ variantId: variant(1000), qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: paid > 0 ? [{ methodId: cash, amount: paid }] : [],
    ...extra
  })
const invoiceCount = () => n(seed.one('SELECT COUNT(*) AS c FROM "SaleInvoice"').c)
const creditCount = () => n(seed.one('SELECT COUNT(*) AS c FROM "StoreCredit"').c)

let msg = ''
try { await sale(1300, { confirmOverpay: true }) } catch (e) { msg = String(e?.message ?? e) }
check('فلوی قدیمی «بله ثبت کن» دیگر اضافه‌دریافت را نمی‌پذیرد', () => {
  if (!msg.includes('بیشتر است')) throw new Error(msg || 'ACCEPTED')
})
check('اختلاف دقیق ۳۰۰ ریال در پیام آمده است', () => {
  if (!msg.includes('۳۰۰')) throw new Error(msg)
})
check('هیچ فاکتوری از درخواست ردشده ثبت نشد', () => {
  if (invoiceCount() !== 0) throw new Error(`invoices=${invoiceCount()}`)
})
let msg2 = ''
try { await sale(1300, { confirmOverpay: true, overpayAsCredit: true }) } catch (e) { msg2 = String(e?.message ?? e) }
check('پرچم اعتبار از اضافه‌دریافت هم راه فرار نیست', () => {
  if (!msg2.includes('بیشتر است')) throw new Error(msg2 || 'ACCEPTED')
})
check('هیچ اعتبار OVERPAYای صادر نشد', () => {
  if (creditCount() !== 0) throw new Error(`credits=${creditCount()}`)
})
let exact = null
try { exact = await sale(1000) } catch (e) { check('پرداخت دقیق ثبت می‌شود', () => { throw e }) }
check('پرداخت دقیق مثل قبل بدون هشدار ثبت می‌شود', () => {
  if (!exact) throw new Error('ثبت نشد')
})

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
