/**
 * Regression for the still-closed exchange-child return policy. Neither a
 * credit-funded/debt source nor an ordinary cash source may turn attribution
 * into a payout until child entitlement and reversal invariants are complete.
 * Preview may show attribution only, but must issue no cash/credit/debt right.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s197-exchange-nasiyeh-cash-refund.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s197-ex-nasiyeh-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { RefundMethod } = await import('@shared/enums')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

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
const safe = async (label, fn) => {
  try { return await fn() } catch (e) {
    bad++; console.log(`  ✗ ${label} — ${String(e?.message ?? e).split('\n')[0]}`)
    return null
  }
}
const expectChildClosed = async (label, fn) => {
  try {
    await fn()
    bad++; console.log(`  ✗ ${label} — child settlement unexpectedly opened`)
  } catch (e) {
    const message = String(e?.message ?? e)
    if (/تخصیص منشأ|تعویض|entitlement|reversal/iu.test(message)) {
      ok++; console.log(`  ✓ ${label} — fail-closed`)
    } else {
      bad++; console.log(`  ✗ ${label} — unexpected error: ${message.split('\n')[0]}`)
    }
  }
}

const userId = seed.user('مدیر تست ۱۹۷ تعویض-نسیه')
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
const refundSum = (type) => Number(seed.one('SELECT COALESCE(SUM(amount), 0) AS t FROM "CashMovement" WHERE type = ?', type)?.t ?? 0)

console.log('\n۰) مرجع پول نقد درست است، اما attribution به‌تنهایی مجوز تسویهٔ فرزند نیست')
{
  const SALES = readFileSync(resolve('src/main/services/SalesService.ts'), 'utf8')
  truthy('cashLikeRefundableOf همچنان تعریف شده', /async function cashLikeRefundableOf/.test(SALES))
  truthy('منبع پول واقعی cashLikeRefundableOf است', /receivedOnInvoice = await cashLikeRefundableOf/.test(SALES))
  truthy('گیت تعویضِ فرزند پیش از مسیر بازپرداخت فعال است', /opts\.applyRefund && isExchangeChildInvoice/.test(SALES))
}

const exchangeThenAttemptChildRefund = async (label, paid) => {
  const srcVar = variant(1_000_000)
  const sale = await safe(`${label}: فروش ${paid ? 'نقد' : 'نسیه'} ۱M`, () => salesService.create({
    userId, shiftId,
    lines: [{ variantId: srcVar, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    payments: paid ? [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] : []
  }))
  if (!sale) return null
  const ex = await safe(`${label}: تعویض به ۶۰۰k`, () => salesService.createExchange({
    invoiceId: sale.id,
    lines: [{ saleItemId: itemsOf(sale.id)[0].id, qty: 1 }],
    replacements: [{ variantId: variant(600_000), qty: 1, unitPrice: 600_000, discount: 0, tax: 0 }],
    refundMode: paid ? 'STORE_CREDIT' : undefined,
    userId, shiftId
  }))
  if (!ex) return null
  eq(`${label}: سند تعویض ساخته شد`, typeof ex.exchangeInvoiceId, 'number')

  const childItemId = itemsOf(ex.exchangeInvoiceId)[0].id
  const effects = () => ({
    childReturns: Number(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', ex.exchangeInvoiceId).n),
    childReturnItems: Number(seed.one(`SELECT COUNT(*) n FROM "SaleReturnItem" ri
      JOIN "SaleReturn" r ON r.id=ri.returnId WHERE r.invoiceId=?`, ex.exchangeInvoiceId).n),
    returnRefundCash: refundSum('RETURN_REFUND'),
    cashMovements: Number(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n),
    credits: Number(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n),
    fundingEvents: Number(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n)
  })
  const before = effects()
  let preview = null
  let previewBlocked = false
  try {
    preview = await salesService.returnProvenancePreview({
      invoiceId: ex.exchangeInvoiceId, lines: [{ saleItemId: childItemId, qty: 1 }]
    })
  } catch (error) {
    previewBlocked = /تخصیص منشأ|تعویض|entitlement|reversal/iu.test(String(error?.message ?? error))
  }
  const previewClosed = previewBlocked || (preview?.attributionOnly === true && preview.settlementReady === false &&
    Number(preview.cashRight) === 0 && Number(preview.giftOpportunity) === 0 && Number(preview.debtReduced) === 0)
  truthy(`${label}: preview بسته است یا فقط attribution بدون حق مالی می‌دهد`, previewClosed)
  if (preview) {
    eq(`${label}: preview حق نقد نمی‌سازد`, Number(preview.cashRight), 0)
    eq(`${label}: preview حق اعتبار نمی‌سازد`, Number(preview.giftOpportunity), 0)
    eq(`${label}: preview بدهی مادر را تغییر نمی‌دهد`, Number(preview.debtReduced), 0)
  }

  await expectChildClosed(`${label}: برگشت CASH روی فرزند تعویض fail-closed است`, () => salesService.createReturn({
    invoiceId: ex.exchangeInvoiceId, full: false,
    lines: [{ saleItemId: childItemId, qty: 1 }],
    refundMethod: RefundMethod.CASH, refundAmount: 600_000, userId, shiftId
  }))
  const after = effects()
  eq(`${label}: تلاش فرزند اثر جانبی ندارد`, JSON.stringify(after), JSON.stringify(before))
  return { sale, ex }
}

console.log('\n۱) نسیه ۱M → تعویض ۶۰۰k → تلاش برگشت فرزند هیچ حق تسویه نمی‌سازد')
{
  const result = await exchangeThenAttemptChildRefund('نسیه', 0)
  if (result) eq('ماندهٔ مادر پس از رد برگشت فرزند همچنان ۶۰۰k',
    Number((await salesService.payments({ invoiceId: result.sale.id })).remaining), 600_000)
}

console.log('\n۲) نقد ۱M → تعویض ۶۰۰k → حتی lineage نقدی فعلاً مجوز payout نیست')
await exchangeThenAttemptChildRefund('نقد', 1_000_000)

console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad) process.exit(1)
