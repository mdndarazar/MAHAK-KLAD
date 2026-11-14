/**
 * نشست ۱۷۰ (قدیمی) — «راهنمای ماندهٔ اضافه‌دریافت».
 *
 * ⚠️ منسوخ‌شده با تصمیم موخرِ مورد ۴ (نشست ۲۲۴): به‌جای راهنمای تبدیل مانده به اعتبار،
 * خودِ مبلغ بیش‌ازحد با اختلاف دقیق رد می‌شود؛ «مانده»ای ساخته نمی‌شود.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s170b-overpay-remainder-hint.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s170b-superseded-'))
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

const userId = seed.user('تست منسوخ‌شدهٔ نشست ۱۷۰')
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId })
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ نشست ۱۷۰')
const productId = seed.product('کالای نشست ۱۷۰', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
let msg = ''
try {
  await salesService.create({
    debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
    userId, shiftId,
    lines: [{ variantId: variant(1000000), qty: 1, unitPrice: 1000000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1300000 }],
    confirmOverpay: true, overpayAsCredit: true
  })
} catch (e) { msg = String(e?.message ?? e) }
check('دریافت ۱٬۳۰۰٬۰۰۰ روی فاکتور ۱٬۰۰۰٬۰۰۰ رد می‌شود', () => {
  if (!msg.includes('بیشتر است')) throw new Error(msg || 'ACCEPTED')
})
check('اختلاف دقیق ۳۰۰٬۰۰۰ ریال گفته می‌شود', () => { if (!msg.includes('۳۰۰٬۰۰۰')) throw new Error(msg) })
check('هیچ «ماندهٔ اضافه‌دریافت» یا اعتباری ساخته نشد', () => {
  const credits = n(seed.count('StoreCredit'))
  const over = n(seed.one('SELECT COUNT(*) AS c FROM "Payment" WHERE overpayAmount > 0').c)
  if (credits !== 0 || over !== 0) throw new Error(JSON.stringify({ credits, over }))
})

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
