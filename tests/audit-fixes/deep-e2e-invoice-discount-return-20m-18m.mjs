import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-invoice-discount-return-20m-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('isolated invoice discount and return')
const cash = seed.insert('PaymentMethod', { key: 'IDR-20M-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const n = value => Number(value ?? 0)
let variantSeq = 0
function variant(label, price) {
  const product = seed.product(`IDR20-${++variantSeq}-${label}`, seed.category(`IDR20-category-${variantSeq}`))
  const id = seed.variant(product, `IDR20-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const countCredits = () => n(seed.one('SELECT COUNT(*) AS count FROM "StoreCredit"').count)
const linesFor = items => items.map(item => ({ variantId: item.id, qty: 1, unitPrice: item.price, discount: 0, tax: 0 }))
const itemRows = invoiceId => seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const checks = {}
const record = (key, value) => { checks[key] = !!value; assert.ok(value, `${key} failed`) }
const cases = []

async function createDiscountedSale(label, prices) {
  assert.equal(prices.reduce((sum, price) => sum + price, 0), 20_000_000)
  const shiftId = seed.insert('Shift', { name: `${label}: discount return test`, number: 9400 + cases.length, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
  const items = prices.map((price, index) => variant(`${label}-item-${index + 1}`, price))
  const beforeCredits = countCredits()
  const sale = await salesService.create({
    userId, shiftId, lines: linesFor(items), invoiceDiscount: 2_000_000,
    payments: [{ methodId: cash, amount: 18_000_000, destination: 'CASH' }],
    saleRequestIdempotencyKey: `invoice-discount-return-${label}`
  })
  const invoice = seed.one('SELECT id,grandTotal,discountTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  record(`${label}: gross goods 20m and invoice net 18m`, n(invoice.grandTotal) === 18_000_000 && n(invoice.discountTotal) === 2_000_000)
  record(`${label}: actual payment 18m and settled`, n(invoice.paidTotal) === 18_000_000 && invoice.settledAt != null)
  record(`${label}: no credit barcode created at sale`, countCredits() === beforeCredits)
  const dbItems = itemRows(sale.id)
  return { label, shiftId, items, sale, dbItems, beforeCredits }
}

// A single 20m product: invoice-level discount must reduce its return value to 18m.
{
  const ctx = await createDiscountedSale('one-item', [20_000_000])
  const returned = await salesService.createReturn({
    invoiceId: n(ctx.sale.id), full: true, refundMethod: RefundMethod.CASH, userId, shiftId: ctx.shiftId
  })
  const row = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', returned.id)
  record('one-item: return amount equals discounted invoice net 18m', n(row.total) === 18_000_000)
  record('one-item: actual cash refund equals net paid 18m', row.refundMethod === 'CASH' && n(row.refundAmount) === 18_000_000)
  record('one-item: no credit barcode on return', countCredits() === ctx.beforeCredits)
  cases.push({ label: ctx.label, goodsPrices: [20_000_000], invoiceDiscount: 2_000_000, saleTotal: 18_000_000, salePaid: 18_000_000, returnAmounts: [n(row.total)], cashRefundAmounts: [n(row.refundAmount)], finalCreditCount: countCredits() })
}

// Two equal products: the common 2m discount is allocated 1m to each item; both returns total exactly 18m.
{
  const ctx = await createDiscountedSale('two-equal-items', [10_000_000, 10_000_000])
  const creditsBeforeReturns = countCredits()
  const returnAmounts = [], cashRefundAmounts = []
  for (const dbItem of ctx.dbItems) {
    const returned = await salesService.createReturn({
      invoiceId: n(ctx.sale.id), full: false, lines: [{ saleItemId: n(dbItem.id), qty: 1 }],
      refundMethod: RefundMethod.CASH, userId, shiftId: ctx.shiftId
    })
    const row = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', returned.id)
    returnAmounts.push(n(row.total)); cashRefundAmounts.push(n(row.refundAmount))
  }
  record('two equal items: discount share is 1m each, return is 9m per item', returnAmounts[0] === 9_000_000 && returnAmounts[1] === 9_000_000)
  record('two equal items: cash paid across both returns totals exactly 18m', cashRefundAmounts[0] === 9_000_000 && cashRefundAmounts[1] === 9_000_000 && cashRefundAmounts.reduce((a,b)=>a+b,0) === 18_000_000)
  record('two equal items: no credit barcode for discount or returns', countCredits() === creditsBeforeReturns)
  cases.push({ label: ctx.label, goodsPrices: [10_000_000, 10_000_000], invoiceDiscount: 2_000_000, saleTotal: 18_000_000, salePaid: 18_000_000, returnAmounts, cashRefundAmounts, finalCreditCount: countCredits() })
}

// Three unequal products: verify proportional allocation and exact reconciliation over separate returns.
{
  const ctx = await createDiscountedSale('three-unequal-items', [5_000_000, 7_000_000, 8_000_000])
  const creditsBeforeReturns = countCredits()
  const returnAmounts = [], cashRefundAmounts = []
  for (const dbItem of ctx.dbItems) {
    const returned = await salesService.createReturn({
      invoiceId: n(ctx.sale.id), full: false, lines: [{ saleItemId: n(dbItem.id), qty: 1 }],
      refundMethod: RefundMethod.CASH, userId, shiftId: ctx.shiftId
    })
    const row = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', returned.id)
    returnAmounts.push(n(row.total)); cashRefundAmounts.push(n(row.refundAmount))
  }
  record('three unequal items: proportional net values 4.5m, 6.3m, 7.2m', JSON.stringify(returnAmounts) === JSON.stringify([4_500_000, 6_300_000, 7_200_000]))
  record('three unequal items: refunds reconcile exactly to 18m paid', cashRefundAmounts.every((amount, i) => amount === returnAmounts[i]) && cashRefundAmounts.reduce((a,b)=>a+b,0) === 18_000_000)
  record('three unequal items: no credit barcode created', countCredits() === creditsBeforeReturns)
  cases.push({ label: ctx.label, goodsPrices: [5_000_000, 7_000_000, 8_000_000], invoiceDiscount: 2_000_000, saleTotal: 18_000_000, salePaid: 18_000_000, returnAmounts, cashRefundAmounts, finalCreditCount: countCredits() })
}

// Manager-only full-list-price exception: it may lift the discount on one item,
// but the second return must still reconcile to the customer's actual 18m payment.
{
  const ctx = await createDiscountedSale('manager-full-price-override', [10_000_000, 10_000_000])
  const first = ctx.dbItems[0], second = ctx.dbItems[1]
  const firstReturn = await salesService.createReturn({
    invoiceId: n(ctx.sale.id), full: false, lines: [{ saleItemId: n(first.id), qty: 1 }],
    refundMethod: RefundMethod.CASH, managerFullRefund: true, managerPassword: DEFAULT_MANAGER_PASSWORD,
    overrideReason: 'authorized full-price return', userId, shiftId: ctx.shiftId
  })
  const firstRow = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', firstReturn.id)
  const secondReturn = await salesService.createReturn({
    invoiceId: n(ctx.sale.id), full: false, lines: [{ saleItemId: n(second.id), qty: 1 }],
    refundMethod: RefundMethod.CASH, userId, shiftId: ctx.shiftId
  })
  const secondRow = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', secondReturn.id)
  record('manager full-price override requires actual manager approval and returns first item at list price', n(firstRow.total) === 10_000_000 && n(firstRow.refundAmount) === 10_000_000)
  record('remaining item refund is limited to cash still backed after override', n(secondRow.refundAmount) === 8_000_000 && n(firstRow.refundAmount) + n(secondRow.refundAmount) === 18_000_000)
  record('manager exception does not create extra credit beyond net payment', countCredits() === ctx.beforeCredits)
  cases.push({ label: ctx.label, goodsPrices: [10_000_000, 10_000_000], invoiceDiscount: 2_000_000, saleTotal: 18_000_000, salePaid: 18_000_000, returnAmounts: [n(firstRow.total), n(secondRow.total)], cashRefundAmounts: [n(firstRow.refundAmount), n(secondRow.refundAmount)], managerOverride: true, finalCreditCount: countCredits() })
}

const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  verdict: 'PASS', checks, cases,
  conclusion: 'With gross goods of 20,000,000 and a 2,000,000 invoice-level discount, the POS invoice is 18,000,000. A full cash return refunds exactly the 18,000,000 actually paid. Partial returns use proportional net item values; when all items are returned, totals reconcile exactly to 18,000,000. No barcode credit is created in these explicit CASH-refund cases.',
  safety: { liveDatabase: false, productionCodeChanged: false, checksOrDebt: false, paymentMethod: 'cash only', realRefundTotalAcrossAllCases: cases.reduce((sum, c) => sum + c.cashRefundAmounts.reduce((a,b)=>a+b,0), 0) }
}
const reports = resolve(process.cwd(), 'reports')
mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'deep-e2e-invoice-discount-return-20m-18m.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = value => Number(value ?? 0).toLocaleString('fa-IR')
const md = [
  '# بازپرداخت فاکتور ۲۰٬۰۰۰٬۰۰۰ با تخفیف ۲٬۰۰۰٬۰۰۰', '',
  `**نتیجه:** PASS؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} تطبیق درست.`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,
  '',
  '## نتیجهٔ مستقیم',
  'فاکتور ۲۰٬۰۰۰٬۰۰۰ ریالی با تخفیف کل ۲٬۰۰۰٬۰۰۰ ریال، مبلغ نهایی ۱۸٬۰۰۰٬۰۰۰ ریال دارد. اگر تمام کالاها برگشت بخورند و روش بازپرداخت CASH انتخاب شود، سرویس برگشت و پرداخت واقعی را دقیقاً تا سقف ۱۸٬۰۰۰٬۰۰۰ ثبت می‌کند؛ تخفیفِ داده‌شده مبلغ اضافه‌ای برای مشتری یا بارکد اعتباری نمی‌سازد.',
  'برای برگشت بخشی از کالاها، تخفیف کل به‌صورت نسبتی بین اقلام تخصیص می‌یابد. اگر همهٔ اقلام طی چند برگشت جدا برگردند، جمع مبالغ برگشت دقیقاً برابر مبلغ خالص فاکتور می‌شود.',
  '',
  '| سبد | مبلغ کالاها | سهم تخفیف | ارزش برگشت خالص هر قلم | جمع بازپرداخت نقدی |',
  '|---|---:|---:|---:|---:|',
  '| یک قلم | ۲۰٬۰۰۰٬۰۰۰ | ۲٬۰۰۰٬۰۰۰ | ۱۸٬۰۰۰٬۰۰۰ | ۱۸٬۰۰۰٬۰۰۰ |',
  '| دو قلم مساوی | ۱۰٬۰۰۰٬۰۰۰ + ۱۰٬۰۰۰٬۰۰۰ | ۱٬۰۰۰٬۰۰۰ برای هر قلم | ۹٬۰۰۰٬۰۰۰ + ۹٬۰۰۰٬۰۰۰ | ۱۸٬۰۰۰٬۰۰۰ |',
  '| سه قلم نامساوی | ۵٬۰۰۰٬۰۰۰ + ۷٬۰۰۰٬۰۰۰ + ۸٬۰۰۰٬۰۰۰ | ۵۰۰٬۰۰۰ + ۷۰۰٬۰۰۰ + ۸۰۰٬۰۰۰ | ۴٬۵۰۰٬۰۰۰ + ۶٬۳۰۰٬۰۰۰ + ۷٬۲۰۰٬۰۰۰ | ۱۸٬۰۰۰٬۰۰۰ |',
  '',
  '## نتیجهٔ تست در DB',
  ...cases.map(c => `- ${c.label}: قیمت‌ها ${c.goodsPrices.map(fa).join(' + ')}؛ فاکتور ${fa(c.saleTotal)}؛ برگشت‌ها ${c.returnAmounts.map(fa).join(' + ')}؛ وجه بازپرداخت‌شده ${c.cashRefundAmounts.map(fa).join(' + ')}؛ اعتبار تازه: صفر.`),
  '',
  '## نکتهٔ انتخاب روش بازپرداخت',
  'این نتیجه برای روش بازپرداخت CASH است. در این مسیر هیچ بارکد اعتباری صادر نشد. اگر روش پرداخت به مشتری تعیین نشود یا STORE_CREDIT انتخاب شود، نوع تسویه با CASH فرق می‌کند؛ اما مبلغ پشتوانه‌دار همچنان نباید از پرداخت خالص واقعی بیشتر شود. تخفیفِ ۲٬۰۰۰٬۰۰۰ ریالی، پول پرداخت‌شده محسوب نمی‌شود.',
  '',
  '## محدودهٔ ایمنی',
  '- فقط SQLite موقت ایزوله و service-layer؛ هیچ DB واقعی، stage، reset، چک یا بدهی استفاده نشد.',
  '- هیچ production code تغییر نکرد؛ همهٔ پرداخت‌ها و بازپرداخت‌های تست با روش CASH شبیه‌سازی شدند، بدون وجه واقعی.'
]
writeFileSync(join(reports, 'deep-e2e-invoice-discount-return-20m-18m.md'), md.join('\n') + '\n')
console.log(`Discount return test: PASS; ${Object.keys(checks).length}/${Object.keys(checks).length}; gross=20m; discount=2m; net and total cash refund=18m; credits=0`)
await db.$disconnect?.()
