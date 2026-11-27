/**
 * دفتر آزمون ۴-۵۰ — متن پیش‌فرض مهلت برگشت در «تنظیمات ← فروش و کد فاکتور» با پیش‌فرض واقعی
 * (۱ و ۷ روز) یکی شد؛ خانهٔ عمدهٔ راه دور اگر خالی شود ۷ می‌گذارد. هیچ عدد ذخیره‌شده و منطق مهلت عوض نمی‌شود.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_SALE_DEFAULTS } from '../../src/shared/receipt.ts'

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

await test('texts match the real defaults; empty remote wholesale box falls back to 7', () => {
  assert.equal(DEFAULT_SALE_DEFAULTS.returnCodeDays, 1)
  assert.equal(DEFAULT_SALE_DEFAULTS.returnCodeDaysRemote, 7)
  assert.equal(DEFAULT_SALE_DEFAULTS.wholesaleReturnCodeDays, 1)
  assert.equal(DEFAULT_SALE_DEFAULTS.wholesaleReturnCodeDaysRemote, 7)
  const settings = read('src/renderer/src/pages/Settings.tsx')
  assert.match(settings, /پیش‌فرض ۱ روز است \(تا پایان روزِ بعد از خرید\)\./)
  assert.match(settings, /«مشتری راه دور» یک مهلت مستقل و بلندتر است \(پیش‌فرض ۷ روز\):/)
  assert.match(settings, /wholesaleReturnCodeDaysRemote: Math\.min\(365, Math\.max\(1, \+e\.target\.value \|\| 7\)\)/)
  assert.match(settings, /returnCodeDaysRemote: Math\.min\(365, Math\.max\(1, \+e\.target\.value \|\| 7\)\)/)
  assert.ok(!settings.includes('پیش‌فرض ۱۴ روز') && !/\+e\.target\.value \|\| 14\)/.test(settings))
  const receipt = read('src/shared/receipt.ts')
  assert.ok(!receipt.includes('پیش‌فرض ۱۴ روز'), 'code comment fixed too')
})
