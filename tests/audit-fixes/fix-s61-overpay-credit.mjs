/**
 * نشست ۶۱ (قدیمی) — «صدور کد اعتبار از اضافه‌دریافت».
 *
 * ⚠️ منسوخ‌شده با تصمیم موخرِ مورد ۴ «طرح نهایی رفع ابهام» (نشست ۲۲۴): اضافه‌دریافت
 * در هیچ مسیری مجاز نیست، پس اعتباری هم از آن صادر نمی‌شود. اسناد قدیمی حذف نمی‌شوند.
 * آزمون کامل: `fix-s224-no-overpay-anywhere.mjs`.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s61-overpay-credit.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s61-superseded-'))
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
  try { fn(); ok++; console.log(`  ✓ ${label}`) }
  catch (e) { bad++; console.log(`  ✗ ${label} — ${String(e?.message ?? e).split('\n')[0]}`) }
}

const userId = seed.user('تست منسوخ‌شدهٔ نشست ۶۱')
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId })
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ نشست ۶۱')
const productId = seed.product('کالای نشست ۶۱', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const creditCount = () => n(seed.count('StoreCredit'))
const overpayRows = () => n(seed.one('SELECT COUNT(*) AS c FROM "Payment" WHERE overpayAmount > 0').c)

let msg = ''
try {
  await salesService.create({
    debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
    userId, shiftId,
    lines: [{ variantId: variant(1000), qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1300 }],
    confirmOverpay: true, overpayAsCredit: true
  })
} catch (e) { msg = String(e?.message ?? e) }
check('«صدور اعتبار از اضافه‌دریافت» در فروش دیگر ممکن نیست', () => {
  if (!msg.includes('بیشتر است')) throw new Error(msg || 'ACCEPTED')
})
check('هیچ اعتبار OVERPAYای صادر نشد', () => { if (creditCount() !== 0) throw new Error(`credits=${creditCount()}`) })
check('هیچ ردیف اضافه‌دریافتی ثبت نشد', () => { if (overpayRows() !== 0) throw new Error(`overpayRows=${overpayRows()}`) })

const inv = await salesService.create({
  debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
  userId, shiftId,
  lines: [{ variantId: variant(1000), qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1000 }]
})
let msg2 = ''
try {
  await salesService.addPayment({ invoiceId: n(inv.id), amount: 500, methodId: cash, destination: 'CASH', userId, confirmOverpay: true, overpayAsCredit: true })
} catch (e) { msg2 = String(e?.message ?? e) }
check('در وصول بدهی هم اعتبار از اضافه‌دریافت صادر نمی‌شود', () => {
  if (!msg2.includes('بیشتر است')) throw new Error(msg2 || 'ACCEPTED')
})
check('همچنان هیچ اعتبار اضافه‌دریافتی در دیتابیس نیست', () => { if (creditCount() !== 0) throw new Error(`credits=${creditCount()}`) })

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
