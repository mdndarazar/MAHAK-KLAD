/**
 * دفتر آزمون ۴-۳۶ — جزئیات پنل فروش در پیام تلگرام و بله:
 *  - تخفیف هر قلم با مبلغ و درصد؛ جمع تخفیف فاکتور با درصدش از جمع کالاها (همان `invoiceDiscountPercent` گزارش)؛
 *  - تخفیف بیشتر از «آستانهٔ تخفیف غیرعادی» سیاست حسابداری ⇐ همان لحظه خط «تخفیف غیرعادی (بیش از …٪)» و پیام مهم
 *    (نشان ⚠️؛ به گیرندهٔ «فقط موارد مهم» هم می‌رسد)؛ همان قاعدهٔ گزارش «تخفیف‌های غیرعادی» (بیشتر از آستانه؛ صفر = خاموش)؛
 *  - پرداخت به تفکیک: نقد، کارت، حساب مدیر، چک (با سررسید)، نسیه (با مانده) و اعتبار خرید (بی کد)؛
 *  - تنها کار پنل فروش که پیام نداشت (عوارض یا حق سرویس دستی فاکتور عمده) پیام دارد.
  * جزئیات گوشی (فهرست خام فاکتورها) در این اجرا ⏭️ است (DECISIONS TL-D6). پایگاه موقت.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-36-discount-details.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-36-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { auditPageToEvents, collectAuditIds, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { eventForMode } = await import('../../src/main/services/cloud/messenger/messengerTypes.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, SETTING_KEYS } = await import('@shared/receipt')
const { faDigits, money, toJalaliDate } = await import('@shared/jalali')

const R = (n) => `${money(n)} ریال`
const AT = Date.UTC(2026, 10, 28, 9, 0)
const saleRow = (id, after = {}) => ({ id, at: AT, userId: null, action: 'SALE_CREATE', entity: 'SaleInvoice', entityId: id, after: JSON.stringify({ receiptNo: id, grandTotal: 1, lines: 1, ...after }), note: null })
const eventOf = (row, data) => auditPageToEvents([row], { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })[0]
const doc = (over = {}) => ({
  goodsTotal: 3_600_000, discountTotal: 1_100_000, taxTotal: 0, serviceCharge: 0, deliveryFee: 0, grandTotal: 2_500_000,
  lines: [{ name: 'پیراهن سایز L - آبی', qty: 2, unitPrice: 1_800_000, discount: 1_000_000, lineTotal: 2_600_000 }],
  payments: [{ label: 'نقدی', amount: 2_500_000 }], ...over
})
const withDoc = (d, threshold) => { const data = emptyLookups(); data.saleDocs.set(1, d); data.abnormalDiscountPercent = threshold; return data }

await test('line discount with its percent; invoice discount with its percent of the goods total', () => {
  const ev = eventOf(saleRow(1), withDoc(doc(), 0))
  assert.ok(ev.lines.includes(`• ۲ عدد پیراهن سایز L - آبی · هر عدد ${R(1_800_000)} · تخفیف ${R(1_000_000)} (۲۷.۸٪) · جمع ${R(2_600_000)}`))
  assert.ok(ev.lines.includes(`تخفیف: ${R(1_100_000)} (۳۰.۶٪ از جمع کالاها)`))
  assert.equal(ev.important, false, 'threshold 0 = off')
  assert.equal(ev.lines.some((l) => l.startsWith('تخفیف غیرعادی')), false)
})

await test('above the abnormal-discount threshold: the line at once and an important message', () => {
  const ev = eventOf(saleRow(1), withDoc(doc(), 30))
  assert.ok(ev.lines.includes('تخفیف غیرعادی (بیش از ۳۰٪)'))
  assert.equal(ev.important, true)
  assert.equal(ev.sale, true)
  assert.equal(eventForMode(ev, 'important'), true, 'reaches «important only» recipients')
  assert.equal(eventForMode(ev, 'handover'), false)
  // دقیقاً برابر آستانه غیرعادی نیست (همان قاعدهٔ گزارش: بیشتر از آستانه)
  const exact = eventOf(saleRow(1), withDoc(doc({ discountTotal: 1_080_000, lines: [{ name: 'پیراهن', qty: 2, unitPrice: 1_800_000, discount: 1_080_000, lineTotal: 2_520_000 }], grandTotal: 2_520_000 }), 30))
  assert.ok(exact.lines.includes(`تخفیف: ${R(1_080_000)} (۳۰.۰٪ از جمع کالاها)`))
  assert.equal(exact.important, false)
  // فروش بی تخفیف هیچ خط تخفیفی ندارد
  const none = eventOf(saleRow(1), withDoc(doc({ discountTotal: 0, grandTotal: 3_600_000, lines: [{ name: 'پیراهن', qty: 2, unitPrice: 1_800_000, discount: 0, lineTotal: 3_600_000 }] }), 30))
  assert.equal(none.lines.some((l) => l.startsWith('تخفیف')), false)
  assert.equal(none.important, false)
})

await test('payments by method with the remainder; no read document ⇒ the older lines', () => {
  const ev = eventOf(saleRow(1), withDoc(doc({ grandTotal: 5_000_000, payments: [{ label: 'نقدی', amount: 1_000_000 }, { label: 'حساب مدیر', amount: 500_000 }, { label: 'اعتبار خرید', amount: 700_000 }, { label: 'نقدی', amount: 300_000 }, { label: 'چک (سررسید ۱۴۰۵/۱۰/۰۱)', amount: 1_000_000 }] }), 0))
  assert.ok(ev.lines.includes(`پرداخت: نقدی ${R(1_300_000)} · حساب مدیر ${R(500_000)} · اعتبار خرید ${R(700_000)} · چک (سررسید ۱۴۰۵/۱۰/۰۱) ${R(1_000_000)}`))
  assert.ok(ev.lines.includes(`مانده (نسیه): ${R(1_500_000)}`))
  const old = eventOf(saleRow(1, { grandTotal: 5_000, paidTotal: 2_000, discountTotal: 300 }), emptyLookups())
  assert.deepEqual(old.lines.slice(0, 3), [`جمع: ${R(5_000)} · ۱ قلم`, `تخفیف: ${R(300)}`, `پرداخت هنگام ثبت: ${R(2_000)} از ${R(5_000)} (بقیه با اعتبار خرید یا نسیه)`])
})

await test('the wholesale manual tax or service charge has its own message', () => {
  const data = emptyLookups()
  data.invoices.set(7, { receiptNo: 12, customerId: null })
  const ev = eventOf({ id: 9, at: AT, userId: null, action: 'SALE_CHARGE_OVERRIDE', entity: 'SaleInvoice', entityId: 7, after: JSON.stringify({ tax: 90_000, service: 0, note: 'x' }), note: 'متن آزاد 09120000000' }, data)
  assert.match(ev.title, /^✍️ عوارض یا حق سرویس دستی · فاکتور ۱۲ · /)
  assert.deepEqual(ev.lines, [`عوارض و مالیات: ${R(90_000)}`, `حق سرویس: ${R(0)}`, 'کاربر: نامشخص'])
  assert.equal(ev.important, true)
})

// ---------------------------------------------------------------- پایگاه موقت با سرویس‌های واقعی
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const seller = seed.user('فروشندهٔ ۴-۳۶')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('پوشاک')
const vShirt = seed.variant(seed.product('پیراهن', cat), 'L')
sql.prepare('UPDATE "ProductVariant" SET stock = 1000, salePrice = 1800000, color = ? WHERE id = ?').run('آبی', vShirt)
const today = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const debtor = { firstName: 'مشتری', lastName: 'آزمون', phone: '09120000036' }
const L = (qty, discount = 0) => ({ variantId: vShirt, qty, unitPrice: 1_800_000, discount, tax: 0 })
const mdb = createMessengerDb()
async function messagesOf(invoiceIds) {
  const rows = (await mdb.auditPage(0, 1000)).filter((r) => r.action === 'SALE_CREATE' && invoiceIds.includes(r.entityId))
  const data = await mdb.fetchLookups(collectAuditIds(rows, false))
  return new Map(auditPageToEvents(rows, { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] }).map((e, i) => [rows[i].entityId, e]))
}

seed.setting(SETTING_KEYS.accountingPolicy, { abnormalDiscountPercent: 25 })
const big = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(2, 900_000)], invoiceDiscount: 100_000,
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }, { methodId: card, amount: 600_000, destination: 'CARD' }, { methodId: card, amount: 400_000, destination: 'MANAGER' }] })
const small = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(1, 180_000)], payments: [{ methodId: cash, amount: 1_620_000, destination: 'CASH' }] })
await storeCreditService.issueManual({ amount: 500_000, multiUse: false, maxUses: 1, days: 30, userId: seller, managerPassword: PW })
const credit = seed.one('SELECT id, code FROM "StoreCredit" ORDER BY id DESC LIMIT 1')
const withCredit = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(1)], payments: [{ methodId: cash, amount: 300_000, destination: 'CASH' }], storeCreditCode: credit.code })
const chequeSale = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(1)], payments: [] })
const chequeAudit = seed.one(`SELECT at FROM "AuditLog" WHERE action = 'SALE_CREATE' AND entityId = ?`, chequeSale.id)
seed.insert('Payment', { invoiceId: chequeSale.id, methodId: cash, amount: 800_000, kind: 'CHEQUE', seq: 1, dueDateJalali: '1405/10/01', chequeStatus: 'PENDING', createdAt: Number(chequeAudit.at) - 1000, paidAt: Number(chequeAudit.at) - 1000 })

await test('real sale: line and invoice discount, the abnormal mark from the policy, payments by method and the remainder', async () => {
  const ev = (await messagesOf([big.id])).get(big.id)
  const inv = seed.one('SELECT grandTotal, goodsTotal, discountTotal FROM "SaleInvoice" WHERE id = ?', big.id)
  assert.equal(Number(inv.discountTotal), 1_000_000)
  assert.ok(ev.lines.includes(`• ۲ عدد پیراهن سایز L - آبی · هر عدد ${R(1_800_000)} · تخفیف ${R(900_000)} (۲۵.۰٪) · جمع ${R(2_700_000)}`))
  assert.ok(ev.lines.includes(`تخفیف: ${R(1_000_000)} (۲۷.۸٪ از جمع کالاها)`))
  assert.ok(ev.lines.includes('تخفیف غیرعادی (بیش از ۲۵٪)'))
  assert.equal(ev.important, true)
  assert.ok(ev.lines.includes(`پرداخت: نقدی ${R(1_000_000)} · کارت ${R(600_000)} · حساب مدیر ${R(400_000)}`))
  assert.ok(ev.lines.includes(`مانده (نسیه): ${R(Number(inv.grandTotal) - 2_000_000)}`))
})

await test('the abnormal mark flags the same invoices as the «abnormal discounts» report', async () => {
  const report = await staffReportService.abnormalDiscounts({ fromJalali: today, toJalali: today })
  assert.equal(report.threshold, 25)
  const flagged = [...(await messagesOf([big.id, small.id])).entries()].filter(([, e]) => e.important).map(([id]) => id)
  assert.deepEqual(flagged, report.rows.map((r) => r.id))
  const smallEv = (await messagesOf([small.id])).get(small.id)
  assert.ok(smallEv.lines.includes(`تخفیف: ${R(180_000)} (۱۰.۰٪ از جمع کالاها)`))
  assert.equal(smallEv.lines.some((l) => l.startsWith('مانده')), false, 'fully paid ⇒ no remainder')
})

await test('store credit is named without its code; a cheque with its due date', async () => {
  const messages = await messagesOf([withCredit.id, chequeSale.id])
  const c = messages.get(withCredit.id)
  assert.ok(c.lines.includes(`پرداخت: نقدی ${R(300_000)} · اعتبار خرید ${R(500_000)}`), c.lines.join('\n'))
  assert.ok(c.lines.includes(`مانده (نسیه): ${R(1_000_000)}`), 'the remainder counts the store credit as paid')
  assert.equal(c.lines.join('\n').includes(credit.code), false, 'never the credit code')
  const q = messages.get(chequeSale.id)
  assert.ok(q.lines.includes(`پرداخت: چک (سررسید ${faDigits('1405/10/01')}) ${R(800_000)}`))
  assert.ok(q.lines.includes(`مانده (نسیه): ${R(1_000_000)}`))
})

await test('a payment added after the sale is not shown as paid at the sale', async () => {
  const later = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(1)], payments: [] })
  const row = seed.one(`SELECT at FROM "AuditLog" WHERE action = 'SALE_CREATE' AND entityId = ?`, later.id)
  seed.insert('Payment', { invoiceId: later.id, methodId: cash, amount: 200_000, kind: 'CASH', seq: 1, destination: 'CASH', createdAt: Number(row.at) + 60_000, paidAt: Number(row.at) + 60_000 })
  const ev = (await messagesOf([later.id])).get(later.id)
  assert.equal(ev.lines.some((l) => l.startsWith('پرداخت:')), false)
  assert.ok(ev.lines.includes(`مانده (نسیه): ${R(1_800_000)}`))
})

await db.$disconnect?.()
