/**
 * دفتر آزمون ۴-۱۲۳ — پله‌های رُند «تغییر قیمت گروهی» تا ۵۰٬۰۰۰ تومان، با برچسب تومانی (ریال در پرانتز).
 * رُند همان «به نزدیک‌ترین»؛ پیش‌نمایش، اعمال و بازگردانی روی پایگاه موقت و جدا.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl4123-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { priceAdjustService } = await import('../../src/main/services/PriceAdjustService.ts')
const { PRICE_ROUND_STEPS, PRICE_ROUND_LABELS, roundToStep } = await import('../../src/shared/priceAdjust.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { jalaliToday } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)

await test('three new steps and Toman labels with Rial in parentheses; old steps kept', () => {
  assert.deepEqual([...PRICE_ROUND_STEPS], [1, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000])
  assert.equal(PRICE_ROUND_LABELS[10000], 'نزدیک‌ترین ۱٬۰۰۰ تومان (۱۰٬۰۰۰ ریال)')
  assert.equal(PRICE_ROUND_LABELS[500000], 'نزدیک‌ترین ۵۰٬۰۰۰ تومان (۵۰۰٬۰۰۰ ریال)')
  for (const s of PRICE_ROUND_STEPS) {
    assert.ok(PRICE_ROUND_LABELS[s], `label for ${s}`)
    if (s > 1) assert.match(PRICE_ROUND_LABELS[s], /^نزدیک‌ترین [۰-۹٬]+ تومان \([۰-۹٬]+ ریال\)$/)
  }
  // «کاپشن» ۱۲٬۳۴۵٬۶۷۰ ریال + ۷٪ با پلهٔ ۱۰٬۰۰۰ تومان ⇐ ۱۳٬۲۰۰٬۰۰۰ ریال (همان «به نزدیک‌ترین»)
  assert.equal(roundToStep(12_345_670 * 1.07, 100000), 13_200_000)
  const page = readFileSync(new URL('../../src/renderer/src/pages/PriceAdjust.tsx', import.meta.url), 'utf8')
  assert.match(page, /\{PRICE_ROUND_STEPS\.map\(\(s\) => \(\n\s+<option key=\{s\} value=\{s\}>\n\s+\{PRICE_ROUND_LABELS\[s\] \?\? faDigits\(s\)\}/)
})

await test('preview, apply and revert with the 100,000-rial step', async () => {
  const actor = seed.user('مدیر ۴-۱۲۳')
  seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: jalaliToday(), openedAt: Date.now() - 3600_000, userId: actor })
  const pid = seed.product('کاپشن')
  const vid = seed.insert('ProductVariant', { productId: pid, code: 'K-123', barcode: 'B-4123', salePrice: 12_345_670, stock: 1 })
  const priceOf = () => Number(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id = ?', vid)?.salePrice)
  const rule = { kind: 'INCREASE', mode: 'PERCENT', value: 7, scope: 'VARIANTS', variantIds: [vid], round: 100000, userId: actor }
  const pre = await priceAdjustService.preview(rule)
  const line = (pre.lines ?? pre.rows ?? []).find((l) => Number(l.variantId) === vid)
  assert.ok(line, 'preview line')
  assert.equal(Number(line.newPrice ?? line.after), 13_200_000)
  assert.equal(priceOf(), 12_345_670, 'preview writes nothing')
  const res = await priceAdjustService.apply({ ...rule, password: PW })
  assert.equal(priceOf(), 13_200_000)
  const batchId = Number(res.batchId ?? res.batch?.id ?? res.id)
  assert.ok(batchId > 0, 'batch id')
  await priceAdjustService.revert({ batchId, userId: actor, password: PW })
  assert.equal(priceOf(), 12_345_670, 'revert restores the recorded old price')
})
