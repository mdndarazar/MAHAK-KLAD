/**
 * نشست ۲۲۳ · مورد ۱۱ — علتِ کاهش دستی موجودی، زیانِ طبقه‌بندی‌شده و «سود پس از زیان».
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item11-stock-loss-classification.mjs
 *
 * قواعد آزموده‌شده:
 *   • افزایش دستی موجودی از مسیر «اصلاح دستی» ممنوع است (مازاد فقط انبارگردانی).
 *   • کاهش دستی فقط با علت صریح (خرابی/کسری یا اصلاح اشتباه) و شرح ≥ ۳ نویسه.
 *   • فقط «خرابی/کسری» زیانِ ثبت‌شده است؛ «اصلاح اشتباه» زیان نمی‌سازد.
 *   • حرکات قدیمی/بی‌طبقه‌بندی «نامشخص» می‌مانند و در جمع زیان نمی‌آیند.
 *   • سود ناخالص دست‌نخورده می‌ماند و «سود پس از زیان» جدا گزارش می‌شود.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item11-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { productService } = await import('../../src/main/services/ProductService.ts')
const { profitService } = await import('../../src/main/services/management/ProfitService.ts')
const { costEngine } = await import('../../src/main/services/management/CostEngine.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (v) => Number(v ?? 0)
const today = toJalaliDate(new Date())
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
      console.log(`  ✓ ${label} (${message.split('\n')[0].slice(0, 80)}…)`)
    } else {
      bad++
      console.log(`  ✗ ${label} — پیام نامنتظره: ${message.split('\n')[0]}`)
    }
  }
}

const userId = seed.user('انباردار مورد ۱۱')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3600_000, userId, staffConfirmed: 1
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۱۱')
const productId = seed.product('کالای مورد ۱۱', category)
const variantId = seed.variant(productId, 'یک')
sql.prepare('UPDATE "ProductVariant" SET stock = 0, salePrice = 500_000, purchasePrice = 200_000 WHERE id = ?').run(variantId)

// لات واقعی خرید: ۴ عدد × ۲۰۰٬۰۰۰ ریال
const buy = seed.insert('PurchaseInvoice', {
  invoiceNo: 2231, issuedAtJalali: today, issuedAt: Date.now(),
  goodsTotal: 800_000, discountTotal: 0, grandTotal: 800_000, status: 'CONFIRMED'
})
seed.insert('PurchaseInvoiceItem', { invoiceId: buy, variantId, qty: 4, unitPrice: 200_000, lineTotal: 800_000 })
seed.insert('StockMovement', {
  variantId, delta: 4, reason: 'PURCHASE', refType: 'PurchaseInvoice', refId: buy, state: 'FINAL', createdAt: Date.now()
})
sql.prepare('UPDATE "ProductVariant" SET stock = 4 WHERE id = ?').run(variantId)
await costEngine.run()

const movementCount = () => n(seed.count('StockMovement'))
const adjust = (newQty, extra = {}) => productService.adjustStock({
  variantId,
  newQty,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  userId,
  ...extra
})

console.log('\n۱) افزایش دستی ممنوع و بدون هیچ حرکتی')
{
  const before = movementCount()
  await rejectsWith('افزایش ۴ ⇒ ۶ رد می‌شود', () => adjust(6, { kind: 'CORRECTION', note: 'اشتباه تایپی' }), /افزایش دستی/)
  check('هیچ حرکت انباری ساخته نشد', () => assert.equal(movementCount(), before))
  check('موجودی دست‌نخورده ۴ است', () => {
    assert.equal(n(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', variantId).stock), 4)
  })
}

console.log('\n۲) کاهش بدون علت/شرح ممنوع')
{
  const before = movementCount()
  await rejectsWith('بدون علت رد می‌شود', () => adjust(3, { note: 'خراب شد' }), /علت را صریح/)
  await rejectsWith('علت نامعتبر رد می‌شود', () => adjust(3, { kind: 'OTHER', note: 'خراب شد' }), /علت را صریح/)
  await rejectsWith('بدون شرح رد می‌شود', () => adjust(3, { kind: 'DAMAGE', note: '  ' }), /شرح/)
  await rejectsWith('شرح دوحرفی رد می‌شود', () => adjust(3, { kind: 'DAMAGE', note: 'خب' }), /شرح/)
  check('هیچ‌کدام حرکتی نساختند', () => assert.equal(movementCount(), before))
}

console.log('\n۳) خرابی/کسری = زیان · اصلاح اشتباه = بدون زیان')
{
  await adjust(3, { kind: 'DAMAGE', note: 'دو عدد پاره شد و دور ریخته شد' })
  const damageMove = seed.one('SELECT id, delta, lossKind, reason, note FROM "StockMovement" ORDER BY id DESC LIMIT 1')
  check('حرکت خرابی با lossKind=DAMAGE ثبت شد', () => {
    assert.equal(damageMove.lossKind, 'DAMAGE')
    assert.equal(n(damageMove.delta), -1)
    assert.equal(damageMove.reason, 'ADJUSTMENT')
    assert.match(String(damageMove.note), /پاره/)
  })

  // اصلاح اشتباه: موجودی ۳ ⇒ ۲ فقط برای درست‌کردن شمارش اشتباه قبلی
  await adjust(2, { kind: 'CORRECTION', note: 'شمارش قبلی اشتباه بود' })
  const correctionMove = seed.one('SELECT delta, lossKind FROM "StockMovement" ORDER BY id DESC LIMIT 1')
  check('حرکت اصلاح اشتباه با lossKind=CORRECTION ثبت شد', () => {
    assert.equal(correctionMove.lossKind, 'CORRECTION')
    assert.equal(n(correctionMove.delta), -1)
  })

  const auditRow = seed.one(
    "SELECT note FROM \"AuditLog\" WHERE action = 'STOCK_ADJUST' ORDER BY id DESC LIMIT 1"
  )
  check('Audit علت را فارسی ثبت می‌کند', () => assert.match(String(auditRow?.note), /علت: (خرابی\/کسری|اصلاح اشتباه)/))
}

console.log('\n۴) سود: زیانِ ثبت‌شده جدا از سود ناخالص و «سود پس از زیان»')
{
  // یک فروش ۱ عددی با بهای ۲۰۰٬۰۰۰ و قیمت ۵۰۰٬۰۰۰ ⇒ سود ناخالص ۳۰۰٬۰۰۰
  await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 500_000, destination: 'CASH' }],
    saleRequestIdempotencyKey: 's223-item11-sale'
  })
  await costEngine.run()
  const report = await profitService.profit({ fromJalali: today, toJalali: today })
  check('سود ناخالص ۳۰۰٬۰۰۰ (فروش منهای FIFO)', () => assert.equal(n(report.realProfit), 300_000))
  check('زیان طبقه‌بندی‌شده = ۲۰۰٬۰۰۰ (فقط یک عدد خرابی)', () => {
    assert.equal(n(report.losses?.damageCost), 200_000)
    assert.equal(n(report.losses?.damageQty), 1)
  })
  check('اصلاح اشتباه زیان نیست', () => {
    assert.equal(n(report.losses?.correctionCost), 200_000)
    assert.equal(n(report.losses?.correctionQty), 1)
  })
  check('سود پس از زیان = ۳۰۰٬۰۰۰ − ۲۰۰٬۰۰۰', () => assert.equal(n(report.profitAfterLoss), 100_000))
  check('جمع زیانِ ثبت‌شده از جمع خروج‌ها بیشتر نیست', () => {
    assert.ok(n(report.losses?.damageCost) <= n(report.losses?.cost))
  })
}

console.log('\n۵) حرکت قدیمیِ بی‌طبقه‌بندی «نامشخص» می‌ماند و زیان نمی‌سازد')
{
  // دادهٔ تاریخی: کاهش موجودی بدون lossKind (مثل رکوردهای قبل از این تغییر)
  seed.insert('StockMovement', {
    variantId, delta: -1, reason: 'ADJUSTMENT', state: 'FINAL', createdAt: Date.now(), note: null
  })
  sql.prepare('UPDATE "ProductVariant" SET stock = stock - 1 WHERE id = ?').run(variantId)
  await costEngine.run()
  const report = await profitService.profit({ fromJalali: today, toJalali: today })
  check('حرکت بی‌علت در سبد «نامشخص» می‌نشیند', () => {
    assert.ok(n(report.losses?.unknownQty) >= 1)
    assert.ok(n(report.losses?.unknownCost) >= 200_000)
  })
  check('زیانِ ثبت‌شده با دادهٔ نامشخص بالا نمی‌رود', () => assert.equal(n(report.losses?.damageCost), 200_000))
  check('سود پس از زیان همچنان فقط زیانِ طبقه‌بندی‌شده را کم می‌کند', () => {
    assert.equal(n(report.profitAfterLoss), n(report.realProfit) - 200_000)
  })
  const unknownRow = (report.losses?.rows ?? []).find((row) => String(row.reason).includes('ADJUSTMENT') && !String(row.reason).includes('|'))
  check('ردیف «علت نامشخص» در گزارش هست', () => assert.ok(unknownRow, JSON.stringify(report.losses?.rows)))
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
