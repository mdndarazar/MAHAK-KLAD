/**
 * دفتر آزمون ۴-۱۴۴ — پیام «💰 پرداخت» برای پول دریافت‌شدهٔ نسیه فقط جای پول را می‌نویسد:
 * «کارت (کارتخوان فروشگاه)»، «نقدی (صندوق فروشگاه)» یا «حساب مدیر»؛ بی جای پول «نقد». چک همان ۴-۱۴۱.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }
const first = (after) =>
  auditPageToEvents([{ id: 44, at: Date.UTC(2026, 10, 27, 9, 0), userId: null, action: 'SALE_PAYMENT_ADD', entity: 'Payment', entityId: 9, after: JSON.stringify(after), note: null }], ctx, { closeShiftIds: [] })[0].lines[0]

await test('received money names only its place', () => {
  assert.equal(first({ receiptNo: 3, amount: 60_000, kind: 'CASH', destination: 'CARD' }), 'مبلغ: ۶۰٬۰۰۰ ریال · کارت (کارتخوان فروشگاه)')
  assert.equal(first({ receiptNo: 3, amount: 40_000, kind: 'CASH', destination: 'CASH' }), 'مبلغ: ۴۰٬۰۰۰ ریال · نقدی (صندوق فروشگاه)')
  assert.equal(first({ receiptNo: 3, amount: 10_000, kind: 'CASH', destination: 'MANAGER' }), 'مبلغ: ۱۰٬۰۰۰ ریال · حساب مدیر')
})

await test('no place recorded ⇒ «نقد»; cheque ⇒ «چک»', () => {
  assert.equal(first({ receiptNo: 3, amount: 5_000, kind: 'CASH' }), 'مبلغ: ۵٬۰۰۰ ریال · نقد')
  assert.equal(first({ receiptNo: 3, amount: 300_000, kind: 'CHEQUE' }), 'مبلغ: ۳۰۰٬۰۰۰ ریال · چک')
})
