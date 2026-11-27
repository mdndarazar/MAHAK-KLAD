/**
 * دفتر آزمون ۴-۱۱۹ — یادداشت بی‌ربط «نمایش ۱ از ۵ ردیف …» زیر نمودارهای «روند» و «ترکیب» گزارش مدیریت نمی‌آید؛
 * «گزارشات فروش» فقط نسخهٔ فارسی خودش را نشان می‌دهد. هیچ عددی عوض نمی‌شود. پایگاه موقت و جدا.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl4119-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { trendService } = await import('../../src/main/services/management/TrendService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { isRowsPagingWarning } = await import('../../src/shared/reportExtraOutput.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const now = Date.now()
const today = toJalaliDate(new Date())
const U = seed.user('فروشنده')
const S = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: now - 3_600_000, userId: U })
for (const [i, total] of [100_000, 250_000, 400_000].entries()) {
  const id = seed.insert('SaleInvoice', { grandTotal: total, goodsTotal: total, paidTotal: total, status: 'SETTLED', receiptNo: 11901 + i, shiftId: S, userId: U, issuedAt: now - 1_800_000 + i, issuedAtJalali: today })
  seed.insert('Payment', { invoiceId: id, amount: total, kind: 'CASH', destination: 'DRAWER', paidAt: now - 1_700_000 + i, paidAtJalali: today, createdByUserId: U, createdShiftId: S })
}

await test('the server still sends its paging warning (unchanged); the predicate knows it', async () => {
  const rep = await salesService.reportRows({ fromJalali: today, toJalali: today, take: 1, skip: 0 })
  const paging = (rep.warnings ?? []).filter(isRowsPagingWarning)
  assert.equal(paging.length, 1)
  assert.equal(paging[0], 'نمایش 1 از 3 ردیف — جمع‌های پایین صفحه روی کل 3 ردیف بازه حساب شده‌اند، نه فقط ردیف‌های دیده‌شده.')
  for (const other of ['ابزار مشغول است؛ دوباره تلاش کنید.', 'پل تطبیق بسته نیست.', 'نمایش ۵ از ۱۰ پرداختی'])
    assert.equal(isRowsPagingWarning(other), false, other)
})

await test('management trend and category: no paging note, same numbers', async () => {
  const trend = await trendService.trend({ fromJalali: today, toJalali: today })
  assert.ok(!(trend.warnings ?? []).some(isRowsPagingWarning), 'trend warnings')
  assert.ok(!(trend.whole?.warnings ?? []).some(isRowsPagingWarning), 'whole warnings')
  for (const p of trend.points) assert.ok(!(p.warnings ?? []).some(isRowsPagingWarning), `point ${p.label}`)
  const full = await salesService.reportRows({ fromJalali: today, toJalali: today })
  assert.equal(trend.whole.invoiceCount, 3)
  assert.equal(trend.whole.accounting.invoice.netAccrualSales, full.accounting.invoice.netAccrualSales)
  assert.equal(trend.points.reduce((s, p) => s + p.invoiceCount, 0), 3)
  const cat = await trendService.category({ fromJalali: today, toJalali: today })
  assert.ok(!(cat.warnings ?? []).some(isRowsPagingWarning), 'category warnings')
  assert.equal(cat.invoiceCount, 3)
})

await test('sales reports page: the server copy is hidden in both places, the Persian line stays', () => {
  const page = readFileSync(new URL('../../src/renderer/src/pages/SalesReports.tsx', import.meta.url), 'utf8')
  assert.equal((page.match(/\(report\.warnings \?\? \[\]\)\.filter\(\(w\) => !isRowsPagingWarning\(w\)\)/g) ?? []).length, 3)
  assert.match(page, /warnings=\{\(report\.warnings \?\? \[\]\)\.filter\(\(w\) => !isRowsPagingWarning\(w\)\)\}/, 'AccountingBlocks')
  assert.match(page, /⚠ نمایش \{faDigits\(report\.rows\.length\)\} از \{faDigits\(report\.page!\.totalCount\)\} ردیف — جمع‌های پایین صفحه روی/)
})
