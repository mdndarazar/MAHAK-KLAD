/**
 * دفتر آزمون ۴-۶۱ — «سرجمع فروش»: ستون «وضعیت» از پرداخت واقعی (صفحه، چاپ A4، اکسل و تفکیک شیفت).
 * پایگاه موقت و جدا: سه فاکتور (کامل، بخشی، بی دریافت) و یک برگشت جزئی ⇐ چهار متن درست؛
 * عددهای ردیف و `statusLabel` سرور همان امروز.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl461-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { salePaymentStatusLabel, saleStatusLabel } = await import('../../src/shared/enums.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const now = Date.now()
const today = toJalaliDate(new Date())
const U = seed.user('فروشنده')
const S = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: now - 3_600_000, userId: U })
const invoice = (receiptNo, paid) => {
  const id = seed.insert('SaleInvoice', { grandTotal: 100_000, goodsTotal: 100_000, paidTotal: paid, status: 'SETTLED', receiptNo, shiftId: S, userId: U, issuedAt: now - 1_800_000, issuedAtJalali: today })
  if (paid > 0) seed.insert('Payment', { invoiceId: id, amount: paid, kind: 'CASH', destination: 'DRAWER', paidAt: now - 1_700_000, paidAtJalali: today, createdByUserId: U, createdShiftId: S })
  return id
}
invoice(6101, 100_000)
invoice(6102, 30_000)
invoice(6103, 0)

await test('status text from the real payment: settled, partial, unpaid (server numbers unchanged)', async () => {
  const rep = await salesService.reportRows({ fromJalali: today, toJalali: today })
  const rows = rep.rows ?? rep
  const by = Object.fromEntries(rows.map((r) => [r.receiptNo, r]))
  assert.equal(salePaymentStatusLabel(by[6101]), 'تسویه‌شده')
  assert.equal(salePaymentStatusLabel(by[6102]), 'نسیه، مانده ۷۰٬۰۰۰ ریال')
  assert.equal(salePaymentStatusLabel(by[6103]), 'پرداخت‌نشده، مانده ۱۰۰٬۰۰۰ ریال')
  for (const n of [6101, 6102, 6103]) assert.equal(by[n].statusLabel, 'تسویه شده', 'server label unchanged')
  assert.deepEqual([by[6101].remaining, by[6102].remaining, by[6103].remaining], [0, 70_000, 100_000])
})

await test('returns and consolidation stay beside the payment text', () => {
  assert.equal(salePaymentStatusLabel({ status: 'PARTIALLY_RETURNED', paidTotal: 30_000, remaining: 40_000, settled: false }), 'برگشت جزئی · نسیه، مانده ۴۰٬۰۰۰ ریال')
  assert.equal(salePaymentStatusLabel({ status: 'RETURNED', paidTotal: 0, remaining: 0, settled: true }), 'برگشت کامل · تسویه‌شده')
  assert.equal(salePaymentStatusLabel({ status: 'SETTLED', consolidated: true, paidTotal: 100_000, remaining: 0, settled: true }), 'انتقال یافته · تسویه‌شده')
  assert.equal(salePaymentStatusLabel({ status: 'CANCELED', remaining: 0 }), saleStatusLabel('CANCELED'))
})

await test('page row, A4 print, Excel and shift breakdown all use the same function', () => {
  const page = readFileSync(new URL('../../src/renderer/src/pages/SalesReports.tsx', import.meta.url), 'utf8')
  assert.match(page, /r\.customerName,\n  salePaymentStatusLabel\(r\),\n  r\.orderTypeLabel,/, 'summaryRowValues (print and Excel)')
  assert.match(page, /\{salePaymentStatusLabel\(r\)\}<\/td>/, 'SummaryRow (page and shift breakdown)')
  assert.ok(!/\{r\.statusLabel\}<\/td>/.test(page))
})
