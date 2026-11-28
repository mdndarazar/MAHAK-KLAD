/**
 * دفتر آزمون ۴-۶۰ — تب «چک‌ها» در «گزارشات فروش»: ستون‌های فارسی به ترتیب دفتر، و نام بدهکار
 * (اگر روی فاکتور ثبت شده) به‌جای «مشتری عمومی» در فهرست چک‌ها و پنجرهٔ پرداختی‌ها.
 * پایگاه موقت و جدا (HARNESS_DIR)؛ جمع‌ها و هر عدد همان امروز.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl460-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { CHEQUE_COLUMNS, chequeDaysText, chequeIsLate } = await import('../../src/shared/reportExtraOutput.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const now = Date.now()
const DAY = 86_400_000
const today = toJalaliDate(new Date())
const U = seed.user('فروشنده')
const S = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: now - 3_600_000, userId: U })
const inv1 = seed.insert('SaleInvoice', { grandTotal: 1_000_000, paidTotal: 0, status: 'FINAL', receiptNo: 4601, shiftId: S, userId: U, issuedAt: now - 1_800_000, issuedAtJalali: today, debtorFirstName: 'رضا', debtorLastName: 'کریمی' })
const inv2 = seed.insert('SaleInvoice', { grandTotal: 700_000, paidTotal: 0, status: 'FINAL', receiptNo: 4602, shiftId: S, userId: U, issuedAt: now - 1_700_000, issuedAtJalali: today, debtorFirstName: 'مینا', debtorLastName: 'احمدی' })
const inv3 = seed.insert('SaleInvoice', { grandTotal: 300_000, paidTotal: 0, status: 'FINAL', receiptNo: 4603, shiftId: S, userId: U, issuedAt: now - 1_600_000, issuedAtJalali: today })
const cheque = (invoiceId, amount, no, dueDate) => seed.insert('Payment', {
  invoiceId, amount, kind: 'CHEQUE', chequeNo: no, bankName: 'ملت', chequeStatus: 'PENDING', destination: 'MANAGER_ACCOUNT',
  paidAt: now - 1_000_000, paidAtJalali: today, dueDate, createdByUserId: U, createdShiftId: S
})
cheque(inv1, 1_000_000, 'CH-1', now + 10 * DAY)
cheque(inv2, 700_000, 'CH-2', now - 3 * DAY)
cheque(inv3, 300_000, 'CH-3', now + 2 * DAY)

const list = await salesService.chequeList({ fromJalali: today, toJalali: today, dateMode: 'paid' })
const rows = Array.isArray(list) ? list : list.rows

await test('each cheque row carries its own invoice number and debtor name (buyer when no debtor)', () => {
  const by = Object.fromEntries(rows.map((r) => [r.chequeNo, r]))
  assert.equal(by['CH-1'].receiptNo, 4601)
  assert.equal(by['CH-1'].debtorName, 'رضا کریمی')
  assert.equal(by['CH-2'].receiptNo, 4602)
  assert.equal(by['CH-2'].debtorName, 'مینا احمدی')
  assert.equal(by['CH-3'].debtorName, null)
  assert.equal(by['CH-3'].customerName, 'مشتری عمومی', 'customerName unchanged')
  const debtorCol = CHEQUE_COLUMNS.find((c) => c.key === 'debtorName')
  assert.equal(debtorCol.text(by['CH-1']), 'رضا کریمی')
  assert.equal(debtorCol.text(by['CH-3']), 'مشتری عمومی')
})

await test('payments window: buyer box gets the debtor name', async () => {
  const view = await salesService.payments({ invoiceId: inv1 })
  assert.equal(view.debtorName, 'رضا کریمی')
  assert.equal(view.customerName, 'مشتری عمومی')
  const modal = readFileSync(new URL('../../src/renderer/src/components/InvoicePaymentsModal.tsx', import.meta.url), 'utf8')
  assert.match(modal, /\{view\.debtorName \|\| view\.customerName\}/)
})

await test('Persian columns in the asked order; no English header; sums unchanged', () => {
  assert.deepEqual(CHEQUE_COLUMNS.map((c) => c.label), [
    'شماره فاکتور', 'نام بدهکار (یا خریدار)', 'مبلغ', 'شماره چک', 'بانک', 'سررسید', 'وضعیت چک', 'تاریخ ثبت', 'تاریخ پاس‌شدن', 'روز تأخیر یا روز مانده'
  ])
  for (const c of CHEQUE_COLUMNS) assert.ok(!/[A-Za-z]/.test(c.label), c.label)
  assert.equal(rows.reduce((a, r) => a + Number(r.amount), 0), 2_000_000)
  const late = rows.filter(chequeIsLate)
  assert.deepEqual(late.map((r) => r.chequeNo), ['CH-2'], 'overdue pending cheque goes to the overdue table')
  const by = Object.fromEntries(rows.map((r) => [r.chequeNo, r]))
  assert.equal(chequeDaysText(by['CH-2']), '۳ روز تأخیر')
  assert.equal(chequeDaysText(by['CH-1']), '۱۰ روز مانده')
  assert.equal(chequeDaysText({ chequeStatus: 'CLEARED', dueInDays: -4 }), '—')
  assert.equal(CHEQUE_COLUMNS.find((c) => c.key === 'amount').text(by['CH-1']), '۱٬۰۰۰٬۰۰۰')
  const tables = readFileSync(new URL('../../src/renderer/src/components/ReportExtraTables.tsx', import.meta.url), 'utf8')
  assert.equal((tables.match(/columns=\{CHEQUE_COLUMNS\}/g) ?? []).length, 5, 'all five cheque tables use the fixed columns')
})
