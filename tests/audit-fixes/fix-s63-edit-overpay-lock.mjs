/**
 * نشست ۶۳ (قدیمی) — «ویرایش فاکتور و اضافه‌دریافت».
 *
 * ⚠️ منسوخ‌شده با «تصمیم موخرِ مورد ۴ طرح رفع ابهام» (نشست ۲۲۴): ویرایشی که
 * جمع دریافتی را از جمع تازهٔ فاکتور بیشتر کند، حتی با `confirmOverpay` هم رد
 * می‌شود و کل ویرایش rollback است. آزمون کامل: `fix-s224-no-overpay-anywhere.mjs`.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s63-edit-overpay-lock.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s63-superseded-'))
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

const userId = seed.user('تست منسوخ‌شدهٔ نشست ۶۳')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ نشست ۶۳')
const productId = seed.product('کالای نشست ۶۳', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const invoice = await salesService.create({
  debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
  userId, shiftId,
  lines: [{ variantId: variant(1000), qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1000 }]
})
const invId = n(invoice.id)
const totals = () => ({
  grand: n(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id = ?', invId).grandTotal),
  credits: n(seed.count('StoreCredit')),
  lines: n(seed.one('SELECT COUNT(*) AS c FROM "SaleInvoiceItem" WHERE invoiceId = ?', invId).c)
})
const before = totals()

let msg = ''
try {
  await salesService.update({
    id: invId, userId,
    lines: [{ variantId: variant(700), qty: 1, unitPrice: 700, discount: 0, tax: 0 }],
    confirmOverpay: true
  })
} catch (e) { msg = String(e?.message ?? e) }
check('ویرایش به ۷۰۰ با ۱٬۰۰۰ دریافتی، حتی با تأیید، رد می‌شود', () => {
  if (!msg.includes('بیشتر')) throw new Error(msg || 'ACCEPTED')
})
check('اختلاف دقیق ۳۰۰ ریال در پیام آمده است', () => {
  if (!msg.includes('۳۰۰')) throw new Error(msg)
})
check('کل ویرایش rollback شد (جمع کل و اقلام دست‌نخورده)', () => {
  const after = totals()
  if (after.grand !== before.grand || after.lines !== before.lines) throw new Error(JSON.stringify({ before, after }))
})
check('هیچ اعتبار OVERPAYای از ویرایش صادر نشد', () => {
  if (totals().credits !== before.credits) throw new Error(`credits=${totals().credits}`)
})
let msg2 = ''
try {
  await salesService.update({
    id: invId, userId,
    lines: [{ variantId: variant(600), qty: 1, unitPrice: 600, discount: 0, tax: 0 }],
    confirmOverpay: true, overpayAsCredit: true
  })
} catch (e) { msg2 = String(e?.message ?? e) }
check('پرچم اعتبار از اضافه‌دریافت در ویرایش هم راه فرار نیست', () => {
  if (!msg2.includes('بیشتر')) throw new Error(msg2 || 'ACCEPTED')
})

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
await db.$disconnect?.()
process.exit(bad === 0 ? 0 : 1)
