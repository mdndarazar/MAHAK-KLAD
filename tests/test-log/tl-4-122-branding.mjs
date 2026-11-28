/**
 * دفتر آزمون ۴-۱۲۲ (به‌روز با بند ۱۶ ب) — تنها کار: عنوان دو برگهٔ آزمایشی چاپگر «— محک» ⇐ «— ArkaPOS».
 * بارکد «MAHAK-TEST»، برگهٔ تشخیص («MAHAK-DIAGNOSE»)، صفحه و پیام‌های «موجودی سایت» و افزونه همان می‌مانند.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// پروندهٔ چاپ از راه زنجیرهٔ import به پایگاه می‌رسد؛ پایگاه موقت و جدا (چیزی در آن نوشته نمی‌شود)
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl4122-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { buildTestPageHtml } = await import('../../src/main/print/testPage.ts')
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const spec = { deviceName: 'چاپگر آزمون', widthMm: 50, heightMm: 30, contentWidthMm: 48, columns: 1, gapXMm: 2, presetLabel: 'لیبل ۵۰×۳۰' }

await test('the two printer test pages say ArkaPOS', () => {
  const label = buildTestPageHtml('LABEL', spec)
  const receipt = buildTestPageHtml('RECEIPT', { ...spec, widthMm: 80, heightMm: 'AUTO', contentWidthMm: 72 })
  assert.ok(label.includes('برگهٔ آزمایشی لیبل — ArkaPOS'))
  assert.ok(receipt.includes('برگهٔ آزمایشی فاکتور — ArkaPOS'))
  for (const html of [label, receipt]) assert.ok(!html.includes('— محک'))
})

await test('internal names, barcodes, the site-stock page and the plugin stay as they are', () => {
  assert.ok(read('src/main/print/testPage.ts').includes("barcodePng('MAHAK-TEST'"))
  const diag = read('src/main/print/diagnose.ts')
  assert.ok(diag.includes('MAHAK-DIAGNOSE') && diag.includes('برگه‌ی تشخیص چاپ — محک'))
  assert.ok(read('src/renderer/src/pages/WooSync.tsx').includes('MAHAK'))
  assert.ok(read('resources/woocommerce/mahak-stock-sync.php').includes('MAHAK Stock Sync'))
})
