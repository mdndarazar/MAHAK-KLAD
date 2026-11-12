/**
 * نشست ۱۶۷ (قدیمی) — «برچسب اضافه‌دریافتِ وصول‌های دورهٔ قبل».
 *
 * ⚠️ منسوخ‌شده با تصمیم موخرِ مورد ۴ (نشست ۲۲۴): اضافه‌دریافت تازه ساخته نمی‌شود.
 * ردیف‌های تاریخی حذف/بازنویسی نمی‌شوند (سند مالی پاک نمی‌شود) ولی مسیر تولیدشان بسته است.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s167-prior-overpay-label.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s167-superseded-'))
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

const userId = seed.user('تست منسوخ‌شدهٔ نشست ۱۶۷')
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId })
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ نشست ۱۶۷')
const productId = seed.product('کالای نشست ۱۶۷', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const inv = await salesService.create({
  debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
  userId, shiftId,
  lines: [{ variantId: variant(1000), qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 400 }]
})
let msg = ''
try {
  await salesService.addPayment({ invoiceId: n(inv.id), amount: 700, methodId: cash, destination: 'CASH', userId, confirmOverpay: true })
} catch (e) { msg = String(e?.message ?? e) }
check('وصول ۷۰۰ روی بدهی ۶۰۰ (وصول دورهٔ قبل) رد می‌شود', () => {
  if (!msg.includes('بیشتر است')) throw new Error(msg || 'ACCEPTED')
})
check('اختلاف دقیق ۱۰۰ ریال در پیام است', () => { if (!msg.includes('۱۰۰')) throw new Error(msg) })
check('هیچ ردیف اضافه‌دریافت تازه‌ای ثبت نشد', () => {
  const rows = n(seed.one('SELECT COUNT(*) AS c FROM "Payment" WHERE overpayAmount > 0').c)
  if (rows !== 0) throw new Error(`overpayRows=${rows}`)
})
const exact = await salesService.addPayment({ invoiceId: n(inv.id), amount: 600, methodId: cash, destination: 'CASH', userId })
check('وصول دقیقاً برابر بدهی (۶۰۰) پذیرفته می‌شود', () => { if (!exact) throw new Error('ثبت نشد') })

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
