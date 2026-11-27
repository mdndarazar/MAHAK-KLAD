/**
 * دفتر آزمون ۴-۶۲ — ستون‌های فارسی سه تب «دفتر رویداد»، «اعتبار خرید» و «بازبینی ضدتقلب» روی صفحه،
 * برابر چاپ A4 و اکسل. پایگاه موقت و جدا برای «دفتر رویداد» (یک فروش کارتی ⇐ «اثر نقدی ۰» با توضیح).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl462-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesLedger } = await import('../../src/main/services/SalesLedger.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { LEDGER_COLUMNS, STORE_CREDIT_COLUMNS, FRAUD_COLUMNS, creditOutstandingOf } = await import('../../src/shared/reportExtraOutput.ts')

const page = readFileSync(new URL('../../src/renderer/src/pages/SalesReports.tsx', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../src/renderer/src/components/ReportExtraTables.tsx', import.meta.url), 'utf8')
const arrayAfter = (marker) => {
  const at = page.indexOf(marker)
  assert.ok(at >= 0, marker)
  const open = page.indexOf('[', at)
  return JSON.parse(page.slice(open, page.indexOf(']', open) + 1).replace(/'/g, '"'))
}

await test('page columns equal the A4/Excel headers of the same tab', () => {
  const ledgerPrint = arrayAfter("title: 'دفتر رویداد فروش',\n          meta: output.meta,\n          headers:")
  assert.deepEqual(LEDGER_COLUMNS.map((c) => c.label), ledgerPrint)
  assert.deepEqual(STORE_CREDIT_COLUMNS.map((c) => c.label), arrayAfter('const STORE_CREDIT_OUTPUT_HEADERS ='))
  const fraudPrint = arrayAfter("title: 'گزارش بازبینی ضدتقلب',\n          meta: output.meta,\n          headers:")
  assert.deepEqual(FRAUD_COLUMNS.map((c) => c.label), fraudPrint.slice(2), 'group and severity are the table title and colour')
  for (const c of [...LEDGER_COLUMNS, ...STORE_CREDIT_COLUMNS, ...FRAUD_COLUMNS]) assert.ok(!/[A-Za-z]/.test(c.label), c.label)
  assert.equal((tables.match(/columns=\{STORE_CREDIT_COLUMNS\}/g) ?? []).length, 5)
  assert.match(tables, /rows=\{rows\} columns=\{LEDGER_COLUMNS\}/)
  assert.match(tables, /columns=\{FRAUD_COLUMNS\}/)
  assert.match(tables, /const active = outstandingCreditRows\(rows\)/, 'line measured by audit-a94-01 stays')
})

await test('ledger: a card sale shows cash effect 0 with its reason; Persian event text', async () => {
  const db = harnessClient()
  const seed = makeSeeder(db)
  const now = Date.now()
  const today = toJalaliDate(new Date())
  const U = seed.user('فروشنده')
  const S = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: now - 3_600_000, userId: U })
  const inv = seed.insert('SaleInvoice', { grandTotal: 100_000, goodsTotal: 100_000, paidTotal: 100_000, status: 'SETTLED', receiptNo: 6201, shiftId: S, userId: U, issuedAt: now - 1_800_000, issuedAtJalali: today })
  seed.insert('Payment', { invoiceId: inv, amount: 100_000, kind: 'CARD', destination: 'CARD_READER', paidAt: now - 1_700_000, paidAtJalali: today, createdByUserId: U, createdShiftId: S })
  const res = await salesLedger.ledger({ fromJalali: today, toJalali: today })
  const sale = (res.rows ?? []).find((r) => r.receiptNo === 6201 && r.eventType === 'SALE')
  assert.ok(sale, 'sale row')
  const text = Object.fromEntries(LEDGER_COLUMNS.map((c) => [c.label, c.text(sale)]))
  assert.equal(text['اثر نقدی'], '۰')
  assert.match(text['توضیح'], /کارت‌خوان/)
  assert.ok(!/[A-Za-z]/.test(text['رویداد']), text['رویداد'])
  assert.equal(text['شماره فیش'], '۶۲۰۱')
})

await test('store credit and fraud rows: Persian values, outstanding from the shared rule', () => {
  const credit = { id: 7, publicReference: 'اعتبار ۷-ABC', sourceReceiptNo: 12, issuedAtJalali: '1405/09/06', expiresAtJalali: null, status: 'PARTIALLY_USED', statusLabel: 'مصرف بخشی', amount: 500_000, usedAmount: 200_000, remaining: 300_000, sourceLabel: 'تعویض کالا' }
  const t = Object.fromEntries(STORE_CREDIT_COLUMNS.map((c) => [c.label, c.text(credit)]))
  assert.equal(t['وضعیت'], 'مصرف بخشی')
  assert.equal(t['مانده‌ی قابل مصرف'], new Intl.NumberFormat('en-US').format(creditOutstandingOf(credit)).replace(/,/g, '٬').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]))
  assert.equal(t['تاریخ انقضا'], '—')
  const fraudRow = { kind: 'RETURN', dateJalali: '1405/09/06', time: '10:00', receiptNo: 33, userName: 'سارا', amount: 90_000, label: 'برگشت پس از بستن', note: 'بی رسید' }
  const f = Object.fromEntries(FRAUD_COLUMNS.map((c) => [c.label, c.text(fraudRow)]))
  assert.equal(f['توضیح'], 'برگشت پس از بستن · بی رسید')
  assert.ok(!Object.values(f).some((v) => /RETURN/.test(v)), 'raw kind is not shown')
})
