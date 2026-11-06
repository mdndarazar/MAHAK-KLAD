import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discounted-invoice-exchange-chain-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('isolated discounted exchange-chain cashier')
const cash = seed.insert('PaymentMethod', { key: 'DEC-CHAIN-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'discounted invoice exchange chain', number: 9411, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const n = value => Number(value ?? 0)
let variantSeq = 0
function variant(label, price) {
  const product = seed.product(`DEC-CHAIN-${++variantSeq}-${label}`, seed.category(`DEC-CHAIN-cat-${variantSeq}`))
  const id = seed.variant(product, `DEC-CHAIN-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const countCredits = () => n(seed.one('SELECT COUNT(*) count FROM "StoreCredit"').count)
const creditsBefore = countCredits()
const A = variant('original-A-10m', 10_000_000)
const B = variant('original-B-10m', 10_000_000)
const A1 = variant('replacement-A1-8.5m', 8_500_000)
const B1 = variant('replacement-B1-9.5m', 9_500_000)
const sale = await salesService.create({
  userId, shiftId,
  lines: [A, B].map(item => ({ variantId: item.id, qty: 1, unitPrice: item.price, discount: 0, tax: 0 })),
  invoiceDiscount: 2_000_000,
  payments: [{ methodId: cash, amount: 18_000_000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 'discounted-chain-root-sale'
})
const rootItems = seed.rows('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
const sourceItem = item => rootItems.find(row => n(row.variantId) === item.id)
const rootBefore = seed.one('SELECT grandTotal,discountTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
assert.equal(n(rootBefore.grandTotal), 18_000_000)
assert.equal(n(rootBefore.discountTotal), 2_000_000)
assert.equal(n(rootBefore.paidTotal), 18_000_000)

const exchangeA = await salesService.createExchange({
  userId, shiftId, invoiceId: n(sale.id),
  lines: [{ saleItemId: n(sourceItem(A).id), qty: 1 }],
  replacements: [{ variantId: A1.id, qty: 1, unitPrice: A1.price, discount: 0, tax: 0 }],
  refundMode: RefundMethod.CASH,
  idempotencyKey: 'discounted-chain-A-to-A1'
})
assert.equal(n(exchangeA.returnTotal), 9_000_000)
assert.equal(n(exchangeA.exchangeTotal), 8_500_000)
assert.equal(n(exchangeA.diff), -500_000)
assert.equal(n(exchangeA.cashRefunded), 500_000)

const exchangeB = await salesService.createExchange({
  userId, shiftId, invoiceId: n(sale.id),
  lines: [{ saleItemId: n(sourceItem(B).id), qty: 1 }],
  replacements: [{ variantId: B1.id, qty: 1, unitPrice: B1.price, discount: 0, tax: 0 }],
  methodId: cash,
  idempotencyKey: 'discounted-chain-B-to-B1'
})
assert.equal(n(exchangeB.returnTotal), 9_000_000)
assert.equal(n(exchangeB.exchangeTotal), 9_500_000)
assert.equal(n(exchangeB.diff), 500_000)
assert.equal(n(exchangeB.cashReceived), 500_000)

const childSnapshots = []
for (const [label, exchange] of [['A1', exchangeA], ['B1', exchangeB]]) {
  const childItem = seed.one('SELECT id,variantId,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', exchange.exchangeInvoiceId)
  const returned = await salesService.createReturn({
    userId, shiftId, invoiceId: n(exchange.exchangeInvoiceId), full: true,
    refundMethod: RefundMethod.CASH
  })
  const row = seed.one('SELECT total,refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', returned.id)
  childSnapshots.push({ label, exchangeInvoiceId: n(exchange.exchangeInvoiceId), childItemId: n(childItem.id), childInvoiceTotal: n(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?', exchange.exchangeInvoiceId).grandTotal), returnId: n(returned.id), returnTotal: n(row.total), refundMethod: row.refundMethod, cashRefunded: n(row.refundAmount) })
  assert.equal(n(row.total), n(childItem.lineTotal), `${label}: return the replacement invoice value, not original list price`)
  assert.equal(row.refundMethod, RefundMethod.CASH)
  assert.equal(n(row.refundAmount), n(childItem.lineTotal), `${label}: source cash lineage permits only actual source-backed money`)
}

const sourceReturns = seed.rows('SELECT total,kind,exchangeDiff FROM "SaleReturn" WHERE invoiceId=? ORDER BY id', sale.id)
const allReturns = seed.rows('SELECT invoiceId,total,kind,refundMethod,refundAmount FROM "SaleReturn" ORDER BY id')
const cashRefundTotal = allReturns.reduce((sum, row) => sum + (row.refundMethod === RefundMethod.CASH ? n(row.refundAmount) : 0), 0)
const cashReceivedOnExchange = n(exchangeB.cashReceived)
const checks = {
  firstInvoiceHas2mDiscountAnd18mNet: n(rootBefore.discountTotal) === 2_000_000 && n(rootBefore.grandTotal) === 18_000_000,
  discountedItemsEachReturnAt9m: n(exchangeA.returnTotal) === 9_000_000 && n(exchangeB.returnTotal) === 9_000_000,
  lowerExchangeRefundsOnly500k: n(exchangeA.diff) === -500_000 && n(exchangeA.cashRefunded) === 500_000,
  higherExchangeCollectsOnly500k: n(exchangeB.diff) === 500_000 && n(exchangeB.cashReceived) === 500_000,
  rootAllItemsReturnedAtNet18m: sourceReturns.reduce((sum,row)=>sum+n(row.total),0) === 18_000_000,
  childReturnsUseReplacementPrices: childSnapshots.length === 2 && childSnapshots[0].returnTotal === 8_500_000 && childSnapshots[1].returnTotal === 9_500_000,
  netCashRefundAfterExchangeTenderEqualsOriginalNetPayment: cashRefundTotal - cashReceivedOnExchange === 18_000_000,
  noStoreCreditBarcodeInCashSettlementChain: countCredits() === creditsBefore,
  rootNoDebtOrUnsettledPayment: n(rootBefore.paidTotal) === 18_000_000 && rootBefore.settledAt != null
}
assert.ok(Object.values(checks).every(Boolean), `discounted exchange-chain checks: ${JSON.stringify(checks)}; children=${JSON.stringify(childSnapshots)}; refunds=${JSON.stringify(allReturns.map(r=>({invoiceId:n(r.invoiceId),total:n(r.total),refundMethod:r.refundMethod,refundAmount:n(r.refundAmount)})))}`)
const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB, verdict: 'PASS', checks,
  assumptions: { originalInvoice: 'Two items at 10,000,000 each; invoice-wide discount 2,000,000; net invoice and cash paid 18,000,000.', settlement: 'CASH for both exchange differences below the original item net price; actual source lineages only.' },
  originalSale: { invoiceId: n(sale.id), grossGoods: 20_000_000, invoiceDiscount: 2_000_000, netInvoice: n(rootBefore.grandTotal), cashPaid: n(rootBefore.paidTotal), settled: rootBefore.settledAt != null },
  exchangeChain: [
    { returned: 'A', sourceGrossLine: 10_000_000, allocatedDiscount: 1_000_000, sourceNetReturn: n(exchangeA.returnTotal), replacement: 'A1', replacementPrice: n(exchangeA.exchangeTotal), diff: n(exchangeA.diff), cashRefunded: n(exchangeA.cashRefunded) },
    { returned: 'B', sourceGrossLine: 10_000_000, allocatedDiscount: 1_000_000, sourceNetReturn: n(exchangeB.returnTotal), replacement: 'B1', replacementPrice: n(exchangeB.exchangeTotal), diff: n(exchangeB.diff), cashReceived: n(exchangeB.cashReceived) }
  ],
  childReturns: childSnapshots,
  final: { originalNetValueReturned: sourceReturns.reduce((sum,row)=>sum+n(row.total),0), replacementValueReturned: childSnapshots.reduce((sum,row)=>sum+row.returnTotal,0), cashRefundedIncludingChildReturns: cashRefundTotal, additionalCashCollectedOnExchange: cashReceivedOnExchange, netCashRefundAfterCollections: cashRefundTotal - cashReceivedOnExchange, storeCreditBarcodeCount: countCredits() },
  safety: { liveDatabase: false, productionCodeChanged: false, checksOrDebt: false, realMoneyMoved: false }
}
const reports = resolve(process.cwd(), 'reports')
mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'deep-e2e-discounted-invoice-exchange-chain.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = value => Number(value ?? 0).toLocaleString('fa-IR')
const md = [
  '# زنجیرهٔ برگشت و تعویض روی فاکتور تخفیف‌خورده', '',
  `**نتیجه:** PASS؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} تطبیق درست.`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,
  '',
  '## سناریو و ارزش خالص',
  '- خرید اولیه: دو قلم ۱۰٬۰۰۰٬۰۰۰ + ۱۰٬۰۰۰٬۰۰۰ = ۲۰٬۰۰۰٬۰۰۰ ریال.',
  '- تخفیف کل فاکتور: ۲٬۰۰۰٬۰۰۰؛ فاکتور و وجه نقد پرداختی: **۱۸٬۰۰۰٬۰۰۰**.',
  '- سهم تخفیف به‌طور نسبتی بین دو قلم تقسیم شد: هر قلم ۱٬۰۰۰٬۰۰۰ تخفیف و **۹٬۰۰۰٬۰۰۰ ارزش برگشت خالص** داشت.',
  '',
  '## زنجیرهٔ تعویض',
  `1. قلم A با ارزش برگشت خالص ${fa(exchangeA.returnTotal)} با A1 به قیمت ${fa(exchangeA.exchangeTotal)} تعویض شد؛ اختلاف ${fa(-n(exchangeA.diff))} به نفع مشتری و همین مبلغ از منبع پولی واقعی نقداً برگشت خورد.`,
  `2. قلم B با ارزش برگشت خالص ${fa(exchangeB.returnTotal)} با B1 به قیمت ${fa(exchangeB.exchangeTotal)} تعویض شد؛ مشتری فقط ${fa(exchangeB.diff)} مابه‌التفاوت پرداخت کرد.`,
  `3. بعداً A1 و B1 هم برگشت خوردند؛ مبلغ هر برگشت برابر قیمت واقعی قلم جایگزین خودش بود: ${childSnapshots.map(x=>fa(x.returnTotal)).join(' و ')}.`,
  '',
  '## جمع‌بندی حساب',
  `- برگشت اقلام اصلی: ${fa(sourceReturns.reduce((sum,row)=>sum+n(row.total),0))} (دقیقاً مبلغ خالص فاکتور اصلی).`,
  `- برگشت دو کالای جایگزین: ${fa(childSnapshots.reduce((sum,row)=>sum+row.returnTotal,0))}.`,
  `- نقدِ خروجی ثبت‌شده در کل زنجیره: ${fa(cashRefundTotal)}؛ نقدِ دریافتی مابه‌التفاوت تعویض دوم: ${fa(cashReceivedOnExchange)}؛ خالص نقد پرداختی فروشگاه ${fa(cashRefundTotal - cashReceivedOnExchange)} بود.`, 
  `- بارکد اعتبار تازه: ${fa(countCredits())}.`,
  '- نتیجه: تخفیف اولیه برای A و B هنگام برگشت رعایت شد و قیمت کامل ۱۰میلیونی برای هر قلم برگشتی منظور نشد. تعویض‌های بعدی هم براساس ارزش واقعی سند جایگزین محاسبه شدند؛ بازپرداخت کل زنجیره از مبلغ واقعی پرداختی بیشتر نشد.',
  '',
  '## محدوده',
  '- برگشت/تعویض‌ها با مسیر رسمی service-layer اجرا شدند؛ فقط SQLite موقت ایزوله بود.',
  '- هیچ DB واقعی، چک، فروش/تسویهٔ بدهی، staging یا reset استفاده نشد؛ production code تغییر نکرد.',
  '- پنجرهٔ Electron و اسکنر فیزیکی در این آزمون اجرا نشدند.'
]
writeFileSync(join(reports, 'deep-e2e-discounted-invoice-exchange-chain.md'), md.join('\n') + '\n')
console.log(`Discounted return/exchange chain: PASS; ${Object.keys(checks).length}/${Object.keys(checks).length}; initial net=18m; return shares=9m each; exchange deltas=-0.5m,+0.5m; child returns=8.5m+9.5m; cash out=${cashRefundTotal}; extra collected=${cashReceivedOnExchange}; net payout=${cashRefundTotal - cashReceivedOnExchange}; credits=${countCredits()}`)
await db.$disconnect?.()
