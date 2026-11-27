/**
 * دفتر آزمون ۴-۱۲۱ — متن‌های دیدنی بخش‌های باقی‌مانده: راهنمای قفل‌ها بی ستاره، بی شماره و بی واژهٔ انگلیسی؛
 * عنوان تاریخچهٔ تغییر قیمت با رقم فارسی؛ پیام بارکد/کد تکراری با نام کالای صاحبش؛ واژه‌های انگلیسی گزارش
 * مدیریت، موجودی سایت، اعتبار خرید، سطل آشغال و ربات به فارسی. فقط متن؛ پایگاه موقت و جدا.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { visibleTexts } from './_visible-texts.mjs'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl4121-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { productService } = await import('../../src/main/services/ProductService.ts')
const { LOCKED_PANELS, PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { describeRule } = await import('../../src/shared/priceAdjust.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const visible = (p) => visibleTexts(read(p)).map((t) => t.text)
const errOf = async (fn) => {
  try {
    await fn()
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

await test('lock hints in Settings ← passwords: no **, no internal numbers, no English code words', () => {
  const allowed = ['SMS', 'PIN', 'POS', 'API', 'USB', 'Excel', 'WooCommerce', 'sms.ir']
  const bad = []
  for (const p of LOCKED_PANELS) {
    const t = `${p.title} — ${p.hint ?? ''}`
    const lat = (t.match(/[A-Za-z][A-Za-z:_.-]{2,}/g) || []).map((w) => w.replace(/[.:]+$/, '')).filter((w) => !allowed.includes(w))
    if (/\*/.test(t) || /(بند|جلسه|نشست|مورد)\s*[۰-۹0-9]/.test(t) || lat.length) bad.push(p.key)
  }
  // «Master Override صندوق» عنوان کاتالوگ قفل‌هاست (gateCatalog.ts) و با ورودی‌های کاتالوگ در دستهٔ ۳ عوض می‌شود.
  assert.deepEqual(bad, [PANEL_KEYS.actMasterOverride])
  const card = LOCKED_PANELS.find((p) => p.key === PANEL_KEYS.cardTransfers)
  assert.match(card.hint, /⚠️ بازگرداندن کالای برگشتی به موجودی قابل‌فروش هم با همین قفل انجام می‌شود؛/)
  assert.match(card.hint, /این قفل هم در صفحه و هم در خود برنامه سنجیده می‌شود\.$/)
  assert.match(LOCKED_PANELS.find((p) => p.key === PANEL_KEYS.wooSync).hint, /^اتصال WooCommerce فقط برای تعداد موجودی\./)
  assert.equal(LOCKED_PANELS.find((p) => p.key === PANEL_KEYS.priceAdjust).title, 'تغییر قیمت گروهی (تخفیف، افزایش و کاهش قیمت)')
  assert.match(LOCKED_PANELS.find((p) => p.key === PANEL_KEYS.posDiscount).hint, /^قفل ریز: .*«تغییر قیمت گروهی \(تخفیف، افزایش و کاهش قیمت\)»/)
})

await test('price-change history titles: Persian digits and thousand separators', () => {
  assert.equal(describeRule({ kind: 'DISCOUNT', mode: 'PERCENT', value: 20 }).startsWith('۲۰٪ '), true)
  assert.equal(describeRule({ kind: 'INCREASE', mode: 'PERCENT', value: 10 }).startsWith('۱۰٪ '), true)
  assert.equal(describeRule({ kind: 'DISCOUNT', mode: 'AMOUNT', value: 500000 }).startsWith('۵۰۰٬۰۰۰ ریال '), true)
})

await test('duplicate barcode or code in the product form names the owner product', async () => {
  const cat = seed.category('شلوار')
  const first = await productService.upsert({
    name: 'شلوار جین', categoryId: cat, unit: 'عدد', note: null,
    variants: [{ code: 'J-32', barcode: '6260001000321', size: '۳۲', color: 'آبی', salePrice: 1_200_000, purchasePrice: 800_000, stock: 0 }]
  })
  assert.ok(first)
  const newProduct = (variant) => productService.upsert({ name: 'کالای تازه', categoryId: cat, unit: 'عدد', note: null, variants: [variant] })
  const m1 = await errOf(() => newProduct({ code: 'NEW-1', barcode: '6260001000321', size: null, color: null, salePrice: 100_000, purchasePrice: 50_000, stock: 0 }))
  assert.equal(m1, 'این بارکد مال «شلوار جین ۳۲ آبی» (کد J-32) است؛ یک بارکد دیگر وارد کنید.')
  const m2 = await errOf(() => newProduct({ code: 'J-32', barcode: '6260009999999', size: null, color: null, salePrice: 100_000, purchasePrice: 50_000, stock: 0 }))
  assert.equal(m2, 'این کد کالا مال «شلوار جین ۳۲ آبی» است؛ یک کد دیگر وارد کنید.')
  assert.equal(seed.one('SELECT COUNT(*) AS n FROM "Product"').n, 1, 'still refused: nothing written')
  // ویرایش همان کالا با همان بارکد و کد خودش رد نمی‌شود
  const v = seed.one('SELECT id, productId FROM "ProductVariant" WHERE code = ?', 'J-32')
  const again = await errOf(() => productService.upsert({
    id: v.productId, name: 'شلوار جین', categoryId: cat, unit: 'عدد', note: 'ویرایش',
    variants: [{ id: v.id, code: 'J-32', barcode: '6260001000321', size: '۳۲', color: 'آبی', salePrice: 1_200_000, purchasePrice: 800_000 }]
  }))
  assert.equal(again, null)
  // کالای سطل آشغال هم شمرده می‌شود (قید یکتای پایگاه هم همین است) و پیام می‌گوید
  db.$harness.db.prepare('UPDATE "ProductVariant" SET deletedAt = ?, isActive = 0 WHERE id = ?').run(Date.now(), v.id)
  const m3 = await errOf(() => newProduct({ code: 'NEW-2', barcode: '6260001000321', size: null, color: null, salePrice: 100_000, purchasePrice: 50_000, stock: 0 }))
  assert.equal(m3, 'این بارکد مال «شلوار جین ۳۲ آبی — در سطل آشغال» (کد J-32) است؛ یک بارکد دیگر وارد کنید.')
})

await test('English words and stars of the listed sections are gone from the visible texts', () => {
  const none = (file, re) => {
    const hits = visible(file).filter((t) => re.test(t))
    assert.deepEqual(hits, [], file)
  }
  none('src/renderer/src/pages/ManagementReports.tsx', /\bABC\b|FIFO|[A-C] (فروش|سود)/)
  none('src/renderer/src/pages/WooSync.tsx', /\bSKU\b|manage_stock|Reconcile|\bWoo\b/)
  none('src/shared/creditUi.ts', /\*\*|Soft Delete|Backend|بند ۴-۲۲/)
  none('src/shared/pendingRestock.ts', /\*\*/)
  none('src/main/services/VariantPurgeService.ts', /append-only/)
  none('src/main/services/management/StockInsightService.ts', /\bABC\b|FIFO|STORE\/|A\/B\/C/)
  none('src/main/services/management/ProfitService.ts', /\bABC\b|FIFO|STORE\//)
  none('src/main/services/cloud/messenger/messengerBot.ts', /webhook یا/)
  none('src/main/services/cloud/messenger/messengerEngine.ts', /webhook یا/)
  none('src/main/services/PriceAdjustService.ts', /BigInt/)
  none('src/renderer/src/pages/Settings.tsx', /تخفیف و افزایش\/کاهش|برای تایید/)
  const mgmt = read('src/renderer/src/pages/ManagementReports.tsx')
  assert.match(mgmt, /\{ id: 'abc', label: 'ردهٔ کالاها \(الف، ب، ج\)' \}/)
  assert.match(mgmt, /const CLASS_FA: Record<string, string> = \{ A: 'الف', B: 'ب', C: 'ج' \}/)
  assert.match(read('src/main/services/SalesService.ts'), /قبلاً بدون دفتر «مبدأ کسر» ثبت شده است/)
  assert.match(read('src/main/services/PriceAdjustService.ts'), /از سقف ثبت در سابقه \(\$\{money\(PRICE_ADJUST_MAX\)\} ریال\) ` \+\n\s+'بیشتر است؛ هیچ قیمتی تغییر نکرد\. '/)
})

await test('Persian digits in management notes, trash and stocktake reminder; plain range message', () => {
  const profit = read('src/main/services/management/ProfitService.ts')
  for (const v of ['outsideCount', 'zeroCostCount', 'warehouseShareCount', 'nonRestockedReturns', 'ambiguousReturns', 'ambiguousReturnQty'])
    assert.ok(profit.includes(`\${${v}.toLocaleString('fa-IR')}`), v)
  const stock = read('src/main/services/management/StockInsightService.ts')
  assert.ok(stock.includes("${ambiguousProfitReturns.toLocaleString('fa-IR')} برگشت (${ambiguousProfitReturnQty.toLocaleString('fa-IR')} عدد) منشأ (فروشگاه یا انبار مرکزی)"))
  assert.ok(read('src/main/services/VariantPurgeService.ts').includes('`حذف همیشگی انجام نشد: ${faDigits(tooRecent.length)} کالا هنوز'))
  const rem = read('src/main/services/StocktakeReminderService.ts')
  assert.ok(rem.includes('`امروز (${faDigits(d)}) تاریخ تعیین') && rem.includes('انبارگردانی (${faDigits(d)}) گذشته'))
  assert.match(read('src/main/services/CustodyService.ts'), /'تاریخ پایان گزارش مغایرت نمی‌تواند پیش از تاریخ شروع باشد\.'/)
})
