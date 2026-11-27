/**
 * دفتر آزمون ۴-۱۴۱ — پیام «💰 پرداخت» برای چک: «… · چک»، نه «روش ثبت‌نشده». بقیهٔ پیام همان.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }
const payment = (after) => ({ id: 41, at: Date.UTC(2026, 10, 27, 9, 0), userId: null, action: 'SALE_PAYMENT_ADD', entity: 'Payment', entityId: 7, after: JSON.stringify(after), note: null })

await test('a cheque payment says «چک»', () => {
  const [ev] = auditPageToEvents([payment({ receiptNo: 12, amount: 300_000, kind: 'CHEQUE', dueDateJalali: '1405/10/06', remaining: 100_000 })], ctx, { closeShiftIds: [] })
  assert.match(ev.title, /^💰 پرداخت · فاکتور ۱۲ · /)
  assert.deepEqual(ev.lines, ['مبلغ: ۳۰۰٬۰۰۰ ریال · چک', 'سررسید: ۱۴۰۵/۱۰/۰۶', 'مانده فاکتور: ۱۰۰٬۰۰۰ ریال', 'کاربر: نامشخص'])
})

await test('an unknown kind still says «روش ثبت‌نشده»', () => {
  const [ev] = auditPageToEvents([payment({ receiptNo: 12, amount: 5_000, kind: 'SOMETHING' })], ctx, { closeShiftIds: [] })
  assert.equal(ev.lines[0], 'مبلغ: ۵٬۰۰۰ ریال · روش ثبت‌نشده')
})
