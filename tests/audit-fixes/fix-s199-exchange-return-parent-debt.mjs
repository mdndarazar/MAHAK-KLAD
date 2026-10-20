/**
 * Legacy expectation that a replacement-child return directly reduces the
 * source invoice debt is intentionally retired. Until child entitlement and
 * reversal are complete, both preview and mutation must fail closed and leave
 * the parent debt, funding evidence, inventory and credits unchanged.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s199-exchange-return-parent-debt.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s199-ex-parent-debt-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService, saleWhere } = await import('../../src/main/services/SalesService.ts')
const { buildStatements } = await import('../../src/main/services/accountingReport.ts')
const { RefundMethod } = await import('@shared/enums')
const { toJalaliDate, jalaliStartOfDay, jalaliEndOfDay } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())

let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label} = ${JSON.stringify(want)}`) }
  else { bad++; console.log(`  ✗ ${label} — انتظار ${JSON.stringify(want)}، دریافت ${JSON.stringify(got)}`) }
}
const safe = async (label, fn) => {
  try { return await fn() } catch (e) {
    bad++; console.log(`  ✗ ${label} — ${String(e?.message ?? e).split('\n')[0]}`)
    return null
  }
}

const userId = seed.user('مدیر تست ۱۹۹ بدهی مادر')
const cat = seed.category('پوشاک')
const product = seed.product('کت', cat)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3600_000, userId })
let vseq = 0
const variant = (price) => {
  const id = seed.variant(product, `سایز ${++vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const itemsOf = (invoiceId) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', invoiceId)
const remainingOf = async (id) => Number((await salesService.payments({ invoiceId: id })).remaining ?? -1)

const a = variant(600)
const b = variant(400)
const sale = await safe('فروش نسیه ۱۰۰۰', () => salesService.create({
  userId, shiftId,
  lines: [
    { variantId: a, qty: 1, unitPrice: 600, discount: 0, tax: 0 },
    { variantId: b, qty: 1, unitPrice: 400, discount: 0, tax: 0 }
  ],
  payments: []
}))
eq('مانده اول ۱۰۰۰', sale ? await remainingOf(sale.id) : -1, 1000)

const ex = await safe('تعویض ۶۰۰ با ۲۰۰', () => salesService.createExchange({
  invoiceId: sale.id,
  lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
  replacements: [{ variantId: variant(200), qty: 1, unitPrice: 200, discount: 0, tax: 0 }],
  refundMode: 'STORE_CREDIT',
  userId, shiftId
}))
eq('بعد از تعویض مانده ۶۰۰', sale ? await remainingOf(sale.id) : -1, 600)

const childItemId = itemsOf(ex.exchangeInvoiceId)[0].id
const effectsBeforeChildAttempt = {
  childReturns: Number(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', ex.exchangeInvoiceId).n),
  returnItems: Number(seed.one(`SELECT COUNT(*) n FROM "SaleReturnItem" ri
    JOIN "SaleReturn" r ON r.id=ri.returnId WHERE r.invoiceId=?`, ex.exchangeInvoiceId).n),
  credits: Number(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n),
  cashMovements: Number(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n),
  fundingEvents: Number(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n)
}
const expectClosed = async (label, action) => {
  try {
    await action()
    bad++
    console.log(`  ✗ ${label} — مسیر تعویضِ بدون entitlement/reversal هنوز باید بسته بماند`)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/تخصیص منشأ|تعویض|entitlement|reversal/iu.test(message)) {
      ok++
      console.log(`  ✓ ${label} رد شد و مسیر fail-closed ماند`)
    } else {
      bad++
      console.log(`  ✗ ${label} — خطای نامنتظره: ${message.split('\\n')[0]}`)
    }
  }
}
await expectClosed('پیش‌نمایش برگشت کالای جایگزین entitlement صادر نمی‌کند', () =>
  salesService.returnProvenancePreview({ invoiceId: ex.exchangeInvoiceId, lines: [{ saleItemId: childItemId, qty: 1 }] }))
await expectClosed('ثبت برگشت STORE_CREDIT روی فرزند تعویض fail-closed است', () =>
  salesService.createReturn({
    invoiceId: ex.exchangeInvoiceId, full: false,
    lines: [{ saleItemId: childItemId, qty: 1 }],
    refundMethod: RefundMethod.STORE_CREDIT, refundAmount: 200, userId, shiftId
  }))
const effectsAfterChildAttempt = {
  childReturns: Number(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', ex.exchangeInvoiceId).n),
  returnItems: Number(seed.one(`SELECT COUNT(*) n FROM "SaleReturnItem" ri
    JOIN "SaleReturn" r ON r.id=ri.returnId WHERE r.invoiceId=?`, ex.exchangeInvoiceId).n),
  credits: Number(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n),
  cashMovements: Number(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n),
  fundingEvents: Number(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n)
}
if (JSON.stringify(effectsAfterChildAttempt) === JSON.stringify(effectsBeforeChildAttempt)) {
  ok++; console.log('  ✓ تلاش فرزند هیچ برگشت، قلم، اعتبار، حرکت صندوق یا رویداد تأمین مالی نساخت')
} else {
  bad++; console.log('  ✗ تلاش فرزند اثر جانبی داشت:', effectsAfterChildAttempt)
}
eq('مانده مادر با برگشت فرزند فرضی تغییر نمی‌کند', sale ? await remainingOf(sale.id) : -1, 600)

const credit = await safe('فهرست نسیه', () => salesService.creditList({ fromJalali: today, toJalali: today, includeSettled: true }))
const row = (credit?.rows ?? []).find((r) => r.id === sale?.id)
eq('creditList مانده پس از رد فرزند', Number(row?.remaining ?? -1), 600)

const filter = { fromJalali: today, toJalali: today }
const { statements } = await buildStatements({
  where: saleWhere(filter),
  from: jalaliStartOfDay(today),
  to: jalaliEndOfDay(today),
  period: { fromJalali: today, toJalali: today, source: 'explicit' },
  filter
})
eq('پل تطبیق بسته است', statements.bridge.unexplained, 0)

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad) process.exit(1)
