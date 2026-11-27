/**
 * دفتر آزمون ۴-۶۳ — دیده شدن چک برگشتی: ردیف هر چک در «بازبینی ضدتقلب» (شمارهٔ فاکتور، بدهکار یا خریدار،
 * شمارهٔ چک، بانک، مبلغ، تاریخ ثبت؛ کلیک روی فاکتور) و ستون «چک برگشتی» در تب «نسیه» (صفحه، چاپ، اکسل).
 * پایگاه موقت و جدا؛ هیچ عدد و حساب پولی عوض نمی‌شود.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl463-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { fraudService } = await import('../../src/main/services/FraudService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { fraudOutputRows } = await import('../../src/shared/reportExtraOutput.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const now = Date.now()
const today = toJalaliDate(new Date())
const U = seed.user('فروشنده')
const S = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: now - 3_600_000, userId: U })
const inv = seed.insert('SaleInvoice', { grandTotal: 100_000, goodsTotal: 100_000, paidTotal: 0, status: 'SETTLED', receiptNo: 6301, shiftId: S, userId: U, issuedAt: now - 1_800_000, issuedAtJalali: today, debtorFirstName: 'علی', debtorLastName: 'رضایی' })
const pay = seed.insert('Payment', { invoiceId: inv, amount: 100_000, kind: 'CHEQUE', chequeNo: 'CH-63', bankName: 'ملت', chequeStatus: 'BOUNCED', paidAt: now - 1_700_000, paidAtJalali: today, createdByUserId: U, createdShiftId: S })

await test('fraud review: one row per bounced cheque, same amount and count, new text', async () => {
  const review = await fraudService.review({ fromJalali: today, toJalali: today, allSources: true })
  const flag = (review?.flags ?? []).find((f) => f.key === 'bouncedCheques')
  assert.ok(flag)
  assert.deepEqual([flag.amount, flag.count, flag.sources.length, flag.sourcesTotal], [100_000, 1, 1, 1])
  assert.equal(flag.detail, 'چک برگشت خورده؛ بدهی مشتری سر جایش است. پیگیری کنید.')
  const [src] = flag.sources
  assert.deepEqual([src.id, src.receiptNo, src.invoiceId, src.amount, src.dateJalali], [pay, 6301, inv, 100_000, today])
  assert.equal(src.label, 'شماره چک CH-63 · بانک ملت · بدهکار: علی رضایی')
  const out = fraudOutputRows([flag], (g) => g.title)
  assert.equal(out.length, 1, 'print/Excel: the real row, not the old summary row')
  assert.match(out[0].note, /CH-63/)
})

await test('credit tab: bounced column beside pending cheques; the debt stays in place', async () => {
  const res = await salesService.creditList({ fromJalali: today, toJalali: today })
  const row = res.rows.find((r) => r.receiptNo === 6301)
  assert.ok(row, 'still a debtor')
  assert.deepEqual([row.bouncedChequeTotal, row.pendingChequeTotal, row.paidTotal, row.remaining], [100_000, 0, 0, 100_000])
  assert.equal(res.totals.bouncedChequeTotal, 100_000)
  assert.deepEqual([res.totals.paidTotal, res.totals.remainingTotal, res.totals.pendingChequeTotal], [0, 100_000, 0])
})

await test('page, A4 print and Excel carry the same new column', () => {
  const page = readFileSync(new URL('../../src/renderer/src/pages/SalesReports.tsx', import.meta.url), 'utf8')
  const hdr = page.slice(page.indexOf('const CREDIT_HEADERS = ['), page.indexOf(']', page.indexOf('const CREDIT_HEADERS = [')))
  const headers = [...hdr.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.equal(headers[headers.indexOf('چک در جریان') + 1], 'چک برگشتی')
  assert.match(page, /r\.pendingChequeTotal,\n    r\.bouncedChequeTotal \?\? 0,\n    r\.paymentCount,/)
  for (const title of ["title: 'گزارش نسیه (فهرست بدهکاران)'", "title: `گزارش نسیه (فهرست بدهکاران) — ${meta}`"]) {
    const at = page.indexOf(title)
    const open = page.indexOf('totals: [', at)
    const body = page.slice(open + 'totals: ['.length, page.indexOf('\n          ]', open))
    const cells = body.split('\n').map((l) => l.trim()).filter(Boolean)
    assert.equal(cells.length, headers.length, `${title}: totals align with headers`)
    assert.match(cells[headers.indexOf('چک برگشتی')], /bouncedChequeTotal/)
  }
})
