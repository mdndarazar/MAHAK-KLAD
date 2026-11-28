/**
 * دفتر آزمون ۴-۱۰۸ — متن‌های بستن صندوق، ادغام و کارت‌به‌کارت: رقم فارسی، جداکنندهٔ هزارگان و خط تازهٔ
 * واقعی؛ معنای پیام‌ها و هر عدد همان. پایگاه موقت و جدا.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-tl4108-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { cardTransferService, createCardTransferRequest } = await import('../../src/main/services/CardTransferService.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, sessionLabelOf } = await import('@shared/receipt')
const { toJalaliDate, faDigits, money } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const errOf = async (fn) => {
  try {
    await fn()
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

// پیام «بستن دوباره» را آزمون طلایی (سطر ۱۲۳ پروندهٔ پایه) کلمه‌به‌کلمه می‌سنجد؛ مالک (۲۰۲۶-۱۱-۲۸) اجازه داد
// فقط رقم‌های تاریخ همین پیام فارسی شود و همان یک سطر پایه عوض شود (TL-D5).
await test('repeat cash close: the earlier close date is in Persian digits', async () => {
  const user = seed.user('کارمند ۴-۱۰۸')
  const product = seed.product('کالای ۴-۱۰۸', seed.category('پوشاک'))
  const variantId = seed.variant(product, 'سایز')
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = 1000 WHERE id = ?').run(variantId)
  const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
  const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now(), userId: user })
  await salesService.create({ userId: user, shiftId, lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }], payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }] })
  await cashboxService.close({ shiftId, explicitShift: true, userId: user, openingFloat: 500, closeShift: false })
  const m = await errOf(() => cashboxService.close({ shiftId, explicitShift: true, userId: user, openingFloat: 500, closeShift: false }))
  assert.ok(m && m.includes(`این نشست قبلاً در ${faDigits(today)} بسته/تجمیع شده است.`), m)
  assert.ok(!/[0-9]/.test(m), 'no Latin digit')
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM "CashSession"').get().n, 1, 'still rejected, nothing written')
})

await test('card transfer: amounts with thousand separators in the pay and correction messages', async () => {
  const userId = seed.user('مدیر ۴-۱۰۸')
  const mkReq = async (amount, paidAmount) => {
    const inv = seed.invoice({ grandTotal: 1_000_000 })
    const invId = typeof inv === 'object' ? inv.id : inv
    const retId = seed.insert('SaleReturn', { invoiceId: invId, total: amount, returnedAt: Date.now(), returnedAtJalali: today, kind: 'RETURN' })
    const req = await createCardTransferRequest(db, { returnId: retId, amount, userId })
    if (paidAmount != null) await cardTransferService.pay({ id: req.id, userId, paidAmount, managerPassword: PW })
    return req
  }
  const over = await mkReq(400_000, null)
  const m1 = await errOf(() => cardTransferService.pay({ id: over.id, userId, paidAmount: 500_000, managerPassword: PW }))
  assert.ok(m1?.startsWith('مبلغ پرداخت‌شده (۵۰۰٬۰۰۰ ریال) بیشتر از مبلغ درخواست (۴۰۰٬۰۰۰ ریال) است و ثبت نمی‌شود.'), m1)
  assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id = ?', over.id)?.status, 'PENDING', 'still not paid')

  const paid = await mkReq(500_000, 500_000)
  const m2 = await errOf(() => cardTransferService.adjust({ id: paid.id, amount: -600_000, reason: 'آزمون', userId, managerPassword: PW }))
  assert.ok(m2?.includes('تا الان ۵۰۰٬۰۰۰ ریال است؛ اصلاح ۶۰۰٬۰۰۰- ریالی آن را به ۱۰۰٬۰۰۰- ریال (منفی) می‌رساند.'), m2)
  assert.ok(m2.includes('بیشترین مبلغ قابل پس‌گرفتن ۵۰۰٬۰۰۰ ریال است'), m2)

  const part = await mkReq(400_000, 300_000)
  const m3 = await errOf(() => cardTransferService.adjust({ id: part.id, amount: 200_000, reason: 'آزمون', userId, managerPassword: PW }))
  assert.ok(m3?.includes('تا الان ۳۰۰٬۰۰۰ ریال است؛ اصلاح +۲۰۰٬۰۰۰ ریالی آن را به ۵۰۰٬۰۰۰ ریال می‌رساند که از مبلغ درخواست (۴۰۰٬۰۰۰ ریال) بیشتر است.'), m3)
  assert.ok(m3.includes('بیشترین مبلغ قابل افزودن ۱۰۰٬۰۰۰ ریال است'), m3)
  for (const m of [m1, m2, m3]) assert.ok(!/[0-9]/.test(m), m)
})

await test('session label after the shift-name list: Persian digits in the name too', () => {
  assert.equal(sessionLabelOf('شیفت 12', 1), 'شیفت ۱۲ — نشست ۱')
  assert.equal(sessionLabelOf('شیفت صبح', 2), 'شیفت صبح — نشست ۲')
  assert.equal(sessionLabelOf('', 3), 'شیفت — نشست ۳')
})

await test('merge refusal: real new lines and Persian digits', () => {
  const src = readFileSync(new URL('../../src/main/services/MergeService.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function assertMergeCreditSafe'), src.indexOf('export async function mergeBackup'))
  const bitsSrc = [...fn.matchAll(/bits\.push\((`[^`]*`)\)/g)].map((m) => m[1])
  assert.equal(bitsSrc.length, 2)
  const credits = 1
  const scPays = 1200
  const bits = bitsSrc.map((t) => new Function('money', 'credits', 'scPays', `return ${t}`)(money, credits, scPays))
  const at = fn.indexOf('throw new BusinessError(')
  const expr = fn.slice(at + 'throw new BusinessError('.length, fn.lastIndexOf(')', fn.lastIndexOf('}')))
  const message = new Function('bits', `return (${expr})`)(bits)
  assert.equal(
    message,
    'ادغام این بکاپ انجام نشد چون سند اعتبار خرید دارد و ورود ناقص‌شان عدد مالی را خراب می‌کند:\n' +
      '• ۱ اعتبار خرید (جدول اعتبار در ادغام منتقل نمی‌شود)\n• ۱٬۲۰۰ پرداخت گره خورده به اعتبار\n' +
      'تا تکمیل ادغام اعتبار، از «جایگزینی کامل» استفاده کنید. داده‌ی فعلی دست‌نخورده ماند.'
  )
  assert.ok(!message.includes('\\n'), 'no raw backslash-n')
})
