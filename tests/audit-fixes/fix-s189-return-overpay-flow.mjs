/**
 * نشست ۱۸۹ · اولویت ۱-۴ — اضافه‌دریافت بعد از برگشت جزئی بی‌صدا ثبت نمی‌شود.
 * نشست ۱۹۴ · M-1 — سقف بازپرداخت نقد = پول دریافتی − کالای مانده؛ نسیه+نقد ⇒ NONE.
 *
 * مثال کلاد: فاکتور ۱٬۰۰۰٬۰۰۰ (دو قلم ۵۰۰٬۰۰۰)، پرداخت ۹۰۰٬۰۰۰،
 * برگشت یک قلم بدون بازپرداخت ⇒ ۴۰۰٬۰۰۰ اضافه. باید هشدار «بله ثبت کن»
 * بیاید؛ با تأیید، ردیف پول اضافه یا کد اعتبار OVERPAY.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s189-return-overpay-flow.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s189-ret-overpay-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { RefundMethod } = await import('@shared/enums')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const { remainingOf } = await import('../../src/shared/settlement.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const PW = DEFAULT_MANAGER_PASSWORD

let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label} = ${JSON.stringify(want)}`) }
  else { bad++; console.log(`  ✗ ${label} — انتظار ${JSON.stringify(want)}، دریافت ${JSON.stringify(got)}`) }
}
const truthy = (label, cond) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label}`) }
}
const throwsWith = async (label, fn, needle) => {
  try { await fn(); bad++; console.log(`  ✗ ${label} — هیچ خطایی پرتاب نشد`) }
  catch (e) {
    const m = String(e?.message ?? e)
    if (needle && !m.includes(needle)) { bad++; console.log(`  ✗ ${label} — پیام نامنتظره: ${m.split('\n')[0]}`) }
    else { ok++; console.log(`  ✓ ${label}`) }
  }
}
const safe = async (label, fn) => {
  try { return await fn() } catch (e) {
    bad++; console.log(`  ✗ ${label} — ${String(e?.message ?? e).split('\n')[0]}`)
    return null
  }
}

const userId = seed.user('مدیر تست برگشت-اضافه')
const cat = seed.category('پوشاک')
const product = seed.product('کت', cat)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const today = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3600_000, userId })
let vseq = 0
const variant = (price) => {
  const id = seed.variant(product, `سایز ${++vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const itemsOf = (invoiceId) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', invoiceId)

const saleTwo = async (label) => {
  const a = variant(500_000)
  const b = variant(500_000)
  return safe(label, () => salesService.create({
    userId, shiftId,
    lines: [
      { variantId: a, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 },
      { variantId: b, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 }
    ],
    payments: [{ methodId: cash, amount: 900_000, destination: 'CASH' }],
    confirmOverpay: false
  }))
}

console.log('\n۰) فرمول: ۹۰۰k روی کالای مانده ۵۰۰k = ۴۰۰k اضافه')
{
  const d = remainingOf({ grandTotal: 1_000_000, received: 900_000, returnedValue: 500_000, refundFromReceived: 0 })
  eq('overpaid', d.overpaid, 400_000)
}

console.log('\n۱) برگشت بدون بازپرداخت، بدون تأیید ⇒ رد')
{
  const sale = await saleTwo('فروش الف ۹۰۰k از ۱M')
  if (sale) {
    await throwsWith(
      'برگشت یک قلم NONE بدون confirmOverpay',
      () => salesService.createReturn({
        invoiceId: sale.id, full: false,
        lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
        refundMethod: RefundMethod.NONE, userId, shiftId
      }),
      'بله ثبت کن'
    )
    const n = seed.one('SELECT COUNT(*) AS c FROM "SaleReturn" WHERE invoiceId = ?', sale.id)
    eq('هیچ برگشتی ثبت نشد', Number(n?.c ?? 0), 0)
  }
}

console.log('\n۲) با تأیید و روش NONE، اعتبارِ پشتوانه‌دار ۴۰۰k خودکار صادر می‌شود')
{
  const sale = await saleTwo('فروش ب ۹۰۰k از ۱M')
  if (sale) {
    const ret = await safe('برگشت NONE با confirmOverpay', () => salesService.createReturn({
      invoiceId: sale.id, full: false,
      lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.NONE, confirmOverpay: true, userId, shiftId
    }))
    eq('overpayAmount برگشت', Number(ret?.overpayAmount ?? 0), 400_000)
    eq('invoiceOverpaid', Number(ret?.invoiceOverpaid ?? 0), 400_000)
    eq('اعتبار خودکار فقط به‌اندازهٔ اضافه‌دریافت واقعی صادر شد', Number(ret?.overpayCredit?.amount ?? 0), 400_000)
    eq('اعتبار خودکار بدون انقضاست', ret?.overpayCredit?.expiresAtJalali ?? null, null)
    eq('اعتبار به سند برگشت لینک شد', Number(seed.one('SELECT COUNT(*) c FROM "StoreCredit" WHERE returnId=?', ret?.id)?.c ?? 0), 1)
  }
}

console.log('\n۳) با تأیید + overpayAsCredit ⇒ کد OVERPAY')
{
  const sale = await saleTwo('فروش ج ۹۰۰k از ۱M')
  if (sale) {
    const ret = await safe('برگشت با صدور اعتبار اضافه', () => salesService.createReturn({
      invoiceId: sale.id, full: false,
      lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.NONE, confirmOverpay: true, overpayAsCredit: true,
      userId, shiftId, overpayManagerPassword: PW
    }))
    truthy('اعتبار با مرجع امن صادر شد', !!ret?.overpayCredit?.id && /^اعتبار #\d+$/.test(String(ret?.overpayCredit?.publicReference ?? '')) && !Object.hasOwn(ret?.overpayCredit ?? {}, 'code'))
    eq('مبلغ اعتبار', Number(ret?.overpayCredit?.amount ?? 0), 400_000)
  }
}

console.log('\n۴) بازپرداخت نقدی: درخواست ۵۰۰k برای ارزش رسمی ۴۰۰k رد؛ مبلغ مجاز پذیرفته می‌شود')
{
  const sale = await saleTwo('فروش د ۹۰۰k از ۱M')
  if (sale) {
    await throwsWith('درخواست نقد ۵۰۰k بالاتر از ارزش رسمی ۴۰۰k', () => salesService.createReturn({
      invoiceId: sale.id, full: false,
      lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.CASH, refundAmount: 500_000, userId, shiftId
    }), 'ارزش رسمی اقلام انتخاب‌شده')
    eq('درخواست بالاتر از ارزش رسمی هیچ برگشتی ثبت نکرد', seed.count('SaleReturn', 'invoiceId = ?', sale.id), 0)
    const ret = await safe('برگشت نقد مجاز ۴۰۰k', () => salesService.createReturn({
      invoiceId: sale.id, full: false,
      lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.CASH, refundAmount: 400_000, userId, shiftId
    }))
    eq('بدون اضافه‌دریافت تازه', Number(ret?.overpayAmount ?? 0), 0)
    const row = seed.one('SELECT refundAmount, refundMethod FROM "SaleReturn" WHERE id = ?', ret?.id)
    eq('بازپرداخت نقد برابر ارزش رسمی', Number(row?.refundAmount ?? 0), 400_000)
    eq('روش نقد ماند', String(row?.refundMethod ?? ''), RefundMethod.CASH)
  }
}

console.log('\n۴ب) درخواست بالاتر از ارزش خودِ کالای برگشتی رد می‌شود؛ مبلغ پایین‌تر برقرار است')
{
  const tooHigh = await saleTwo('فروش د۲ برای سقف رسمی برگشت')
  if (tooHigh) {
    await throwsWith(
      'درخواست نقد ۵۰۰٬۰۰۱ برای کالای برگشتی ۵۰۰٬۰۰۰',
      () => salesService.createReturn({
        invoiceId: tooHigh.id, full: false,
        lines: [{ saleItemId: itemsOf(tooHigh.id)[0].id, qty: 1 }],
        refundMethod: RefundMethod.CASH, refundAmount: 500_001, userId, shiftId
      }),
      'ارزش رسمی اقلام انتخاب‌شده'
    )
    eq('درخواست بالاتر هیچ برگشتی ثبت نکرد', seed.count('SaleReturn', 'invoiceId = ?', tooHigh.id), 0)
  }

  const lower = await saleTwo('فروش د۳ برای مبلغ پایین‌تر')
  if (lower) {
    const returnInput = {
      invoiceId: lower.id, full: false,
      lines: [{ saleItemId: itemsOf(lower.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.CASH, refundDecision: 'METHOD',
      refundAmount: 200_000, confirmOverpay: true, userId, shiftId
    }
    await throwsWith(
      'بازپرداخت پایین‌تر بدون علت رد می‌شود',
      () => salesService.createReturn(returnInput),
      'علت کاهش مبلغ'
    )
    eq('رد بدون علت هیچ برگشتی ثبت نکرد', seed.count('SaleReturn', 'invoiceId = ?', lower.id), 0)
    const reason = 'مشتری خواست بخشی از مبلغ فعلاً نزد فروشگاه بماند'
    const ret = await safe('بازپرداخت پایین‌ترِ ۲۰۰k با علت ثبت‌شده', () => salesService.createReturn({
      ...returnInput, refundNote: reason
    }))
    const row = seed.one('SELECT refundAmount, refundNote FROM "SaleReturn" WHERE id = ?', ret?.id)
    eq('مبلغ پایین‌تر ثبت شد', Number(row?.refundAmount ?? 0), 200_000)
    eq('علت روی سابقهٔ برگشت ذخیره شد', row?.refundNote, reason)
    const report = await salesService.returnList({ fromJalali: today, toJalali: today })
    const reportRows = Array.isArray(report) ? report : report.rows
    const managerRow = reportRows.find((r) => r.id === ret?.id)
    eq('علت برای گزارش مدیر در DTO برگشت قابل خواندن است', managerRow?.refundNote, reason)
  }
}

console.log('\n۵) بند ۴-۴: نسیهٔ هنوز بدهکار + نقد ⇒ خودکار کاهش بدهی')
{
  const a = variant(500_000)
  const b = variant(500_000)
  const sale = await safe('فروش ه ۳۰۰k از ۱M', () => salesService.create({
    userId, shiftId,
    lines: [
      { variantId: a, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 },
      { variantId: b, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 }
    ],
    payments: [{ methodId: cash, amount: 300_000, destination: 'CASH' }]
  }))
  if (sale) {
    const ret = await safe('برگشت نقد روی نسیه', () => salesService.createReturn({
      invoiceId: sale.id, full: false,
      lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
      refundMethod: RefundMethod.CASH, refundAmount: 200_000, userId, shiftId
    }))
    const row = seed.one('SELECT refundAmount, refundMethod FROM "SaleReturn" WHERE id = ?', ret?.id)
    eq('خروج نقد صفر', Number(row?.refundAmount ?? -1), 0)
    eq('روش NONE شد', String(row?.refundMethod ?? ''), RefundMethod.NONE)
    eq('بدهی فاکتور بعد از برگشت', Number(ret?.invoiceRemaining ?? -1), 200_000)
  }
}

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad) process.exit(1)
