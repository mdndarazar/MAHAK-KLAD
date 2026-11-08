import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-021-multibarcode-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { posMultiCreditPlan } = await import('../../src/shared/posMultiCreditPlan.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const { tehranEndOfDayAfter, tehranDateKey } = await import('../../src/shared/tehranTime.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('E100-021 multi-barcode POS verification cashier')
const n = value => Number(value ?? 0)
let variantSeq = 0
function makeVariant(categoryId, label, price) {
  const product = seed.product(`E021-MC-${++variantSeq}-${label}`, categoryId)
  const id = seed.variant(product, `E021-MC-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const cases = []

async function runCase({ key, label, itemPrices }) {
  const shiftId = seed.insert('Shift', {
    name: `E100-021 multi-credit ${key}`,
    number: key === 'one-item' ? 9211 : 9212,
    dayJalali: toJalaliDate(new Date()),
    openedAt: Date.now(), userId
  })
  const category = seed.category(`E100-021-multi-credit-${key}`)
  const items = itemPrices.map((price, index) => makeVariant(category, `${key}-item-${index + 1}`, price))
  const total = items.reduce((sum, item) => sum + item.price, 0)
  assert.equal(total, 180_000, `${key}: total invoice must be 180,000`)
  const saleLines = items.map(item => ({ variantId: item.id, qty: 1, unitPrice: item.price, discount: 0, tax: 0 }))
  const issued = []
  for (const [amount, days, purpose] of [
    [25_000, 1, 'source-expiry-tomorrow'],
    [25_000, 2, 'source-expiry-in-two-days'],
    [150_000, 0, 'money-backed-no-expiry']
  ]) {
    const code = await storeCreditService.issueManual({
      amount, multiUse: false, maxUses: 1, carryRemainder: true, days,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `E100-021 ${key} ${purpose}`
    })
    const raw = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,source,restrictScope FROM "StoreCredit" WHERE id=?', code.id)
    issued.push({
      id: n(raw.id), code: raw.code, amount: n(raw.amount), days, purpose,
      expiresAt: raw.expiresAt == null ? null : n(raw.expiresAt),
      expiresAtJalali: raw.expiresAtJalali, source: raw.source, scope: raw.restrictScope
    })
  }
  assert.equal(issued[0].amount, 25_000)
  assert.equal(issued[1].amount, 25_000)
  assert.equal(issued[2].amount, 150_000)
  const issuedAt = new Date()
  assert.equal(tehranDateKey(issued[0].expiresAt), tehranDateKey(tehranEndOfDayAfter(issuedAt, 1)), `${key}: first 25k credit expires tomorrow in Tehran calendar`)
  assert.equal(tehranDateKey(issued[1].expiresAt), tehranDateKey(tehranEndOfDayAfter(issuedAt, 2)), `${key}: second 25k credit expires in two days in Tehran calendar`)
  assert.equal(issued[2].expiresAt, null, `${key}: 150k credit has no expiry`)
  assert.ok(issued[0].expiresAt < issued[1].expiresAt)
  assert.equal(issued.every(code => code.scope === 'ALL'), true, `${key}: test normal invoice-wide credits, not item-restricted credits`)

  const previewLines = saleLines.map(line => ({ variantId: line.variantId, qty: line.qty, lineTotal: line.unitPrice * line.qty - line.discount + line.tax }))
  const previewRows = []
  for (const code of issued) {
    const preview = await storeCreditService.preview({
      code: code.code, applicable: total, invoiceTotal: total, requested: null,
      lines: previewLines, userId
    })
    previewRows.push({
      id: String(code.id), code: code.code, expiresAt: code.expiresAtJalali,
      restrictScope: code.scope, preview
    })
  }
  const plan = posMultiCreditPlan({
    payable: total,
    rows: previewRows,
    lines: previewLines.map(line => ({ variantId: line.variantId, lineTotal: line.lineTotal })),
    requestedInput: null
  })
  const planned = issued.map(code => ({
    id: code.id, amount: code.amount, expiresAtJalali: code.expiresAtJalali,
    plannedAmount: n(plan.appliedById[String(code.id)]), requestedAmount: plan.requestedById[String(code.id)]
  }))
  assert.equal(plan.applied, 180_000, `${key}: POS planner covers the full invoice`)
  assert.deepEqual(planned.map(row => row.plannedAmount), [25_000, 25_000, 130_000], `${key}: FEFO plan is 25k + 25k + 130k`)
  assert.ok(planned.every(row => row.requestedAmount == null), `${key}: normal auto mode leaves amount selection to server`)

  const before = {
    stocks: items.map(item => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', item.id).stock)),
    cashCard: seed.one(`SELECT COALESCE(SUM(CASE WHEN UPPER(m.kind) IN ('CASH','CARD') THEN p.amount ELSE 0 END),0) amount
      FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId).amount,
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId)
  }
  const sale = await salesService.create({
    userId, shiftId, lines: saleLines,
    storeCredits: issued.map((code, index) => ({
      code: code.code,
      // Match POS: in auto mode it sends no fixed amount; backend applies the remaining cap.
      requestedAmount: plan.requestedById[String(code.id)] ?? null
    })),
    payments: [], saleRequestIdempotencyKey: `e021-multi-credit-${key}`
  })
  assert.equal(n(sale.grandTotal), 180_000)
  assert.equal(n(sale.storeCreditApplied), 180_000)
  assert.equal(n(sale.paidTotal), 180_000)
  const persistedInvoice = seed.one('SELECT status,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  assert.equal(n(persistedInvoice.paidTotal), 180_000)
  assert.equal(persistedInvoice.settledAt != null, true)
  const redemptions = seed.rows('SELECT creditId,amount,remainderAfter FROM "StoreCreditRedemption" WHERE invoiceId=? ORDER BY id', sale.id)
    .map(row => ({ creditId: n(row.creditId), amount: n(row.amount), remainderAfter: n(row.remainderAfter) }))
  const afterCredits = issued.map(code => {
    const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,source,restrictScope FROM "StoreCredit" WHERE id=?', code.id)
    return {
      id: n(row.id), code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount),
      remaining: n(row.amount) - n(row.usedAmount), usedCount: n(row.usedCount), status: row.status,
      expiresAt: row.expiresAt == null ? null : n(row.expiresAt), expiresAtJalali: row.expiresAtJalali,
      source: row.source, scope: row.restrictScope
    }
  })
  const after = {
    stocks: items.map(item => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', item.id).stock)),
    cashCard: n(seed.one(`SELECT COALESCE(SUM(CASE WHEN UPPER(m.kind) IN ('CASH','CARD') THEN p.amount ELSE 0 END),0) amount
      FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId).amount),
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId)
  }
  const checks = {
    totalExactly180k: n(sale.grandTotal) === 180_000,
    threeRealCodesApplied: n(sale.storeCreditApplied) === 180_000 && redemptions.length === 3,
    paidAndSettled: n(persistedInvoice.paidTotal) === 180_000 && persistedInvoice.settledAt != null,
    actualRedemptionAmountsMatchPlan: redemptions.map(r => r.amount).join(',') === '25000,25000,130000',
    remaining20kOnNoExpiryCode: afterCredits[2].remaining === 20_000 && afterCredits[2].expiresAt == null && afterCredits[2].status === 'PARTIALLY_USED',
    firstTwoCodesFullyUsed: afterCredits[0].status === 'USED' && afterCredits[1].status === 'USED',
    noCashOrCardTender: after.cashCard === before.cashCard,
    stockReducedForEverySoldItem: after.stocks.every((stock, index) => stock === before.stocks[index] - 1),
    invoiceCountIncreasedByOne: after.invoices === before.invoices + 1
  }
  assert.ok(Object.values(checks).every(Boolean), `${key}: ${JSON.stringify(checks)}`)
  const result = {
    id: key, label, total, items: items.map(item => ({ name: item.label, price: item.price, variantId: item.id })),
    issuedCredits: issued, previewAndPlan: planned,
    invoice: { id: n(sale.id), total: n(sale.grandTotal), storeCreditApplied: n(sale.storeCreditApplied), paidTotal: n(persistedInvoice.paidTotal), settled: persistedInvoice.settledAt != null, status: persistedInvoice.status },
    redemptions, creditsAfter: afterCredits, stockBefore: before.stocks, stockAfter: after.stocks,
    checks, verdict: 'PASS'
  }
  cases.push(result)
}

await runCase({ key: 'one-item', label: 'یک قلم ۱۸۰٬۰۰۰تومانی', itemPrices: [180_000] })
await runCase({ key: 'multiple-items', label: 'دو قلم ۱۰۰٬۰۰۰ + ۸۰٬۰۰۰تومان', itemPrices: [100_000, 80_000] })

const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  title: 'POS multi-barcode FEFO allocation for one-item and multi-item 180,000 invoices',
  barcodes: [
    { amount: 25_000, expires: 'Tomorrow in Tehran calendar', scope: 'ALL' },
    { amount: 25_000, expires: 'Two days from issue in Tehran calendar', scope: 'ALL' },
    { amount: 150_000, expires: null, scope: 'ALL' }
  ],
  expectedPlan: [25_000, 25_000, 130_000],
  expectedRemainder: { amount: 20_000, barcode: '150k non-expiring credit' },
  cases, verdict: cases.length === 2 && cases.every(c => c.verdict === 'PASS') ? 'PASS' : 'MISMATCH',
  safety: { isolatedSQLiteOnly: true, productionCodeChanged: false, physicalTender: 0, unpaidInvoices: 0, checksOrDebt: false }
}
const out = resolve(process.cwd(), 'reports')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-scenario3-multi-credit-one-vs-many-items.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = value => Number(value ?? 0).toLocaleString('fa-IR')
const md = [
  '# آزمون دوبارهٔ سه بارکد اعتباری: یک کالا در برابر چند کالا', '',
  `**نتیجه:** ${summary.verdict}؛ ${cases.filter(c => c.verdict === 'PASS').length}/${cases.length} حالت PASS.`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,
  '**هر حالت مستقل بود:** سه کد مدیریتی تازه صادر شد و هرکدام فقط در همان حالت مصرف شدند. هر دو فاکتور جمعاً ۱۸۰٬۰۰۰ بودند و هر سه کد عادی `ALL` داشتند؛ کالاها بین اعتبارها سهم‌بندی نشدند.',
  '',
  '| حالت سبد | اقلام | قیمت کل | سهم کد فردا | سهم کد دو روز بعد | سهم کد بی‌انقضا | ماندهٔ کد بی‌انقضا | پرداخت نهایی | نتیجه |',
  '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ...cases.map(c => `| ${c.label} | ${c.items.map(x => `${fa(x.price)}`).join(' + ')} | ${fa(c.invoice.total)} | ${fa(c.redemptions[0].amount)} | ${fa(c.redemptions[1].amount)} | ${fa(c.redemptions[2].amount)} | ${fa(c.creditsAfter[2].remaining)} | ${fa(c.invoice.paidTotal)}؛ تسویه کامل | ${c.verdict} |`),
  '',
  '## پاسخ کوتاه',
  'در هر دو حالت، planner خودکار POS کدهای تاریخ‌دار را زودتر مصرف کرد: ۲۵٬۰۰۰ + ۲۵٬۰۰۰. از ۱۸۰٬۰۰۰ فقط ۱۳۰٬۰۰۰ باقی بود؛ بنابراین از کد ۱۵۰٬۰۰۰ بی‌انقضا همان ۱۳۰٬۰۰۰ مصرف شد و **۲۰٬۰۰۰ روی همان کد باقی ماند**. نتیجه برای یک قلم و دو قلم یکسان بود.',
  '',
  '## جزئیات هر حالت',
  ...cases.flatMap(c => [
    `### ${c.label}`,
    `- اقلام: ${c.items.map(x => `${x.name}=${fa(x.price)}`).join('، ')}؛ جمع=${fa(c.total)}.`,
    `- انقضای واقعی کدها (تقویم تهران): ${c.issuedCredits.map(x => `${fa(x.amount)} → ${x.expiresAtJalali ?? 'بی‌انقضا'}`).join('؛ ')}.`,
    `- planner پیش از ثبت: ${c.previewAndPlan.map(x => `${fa(x.amount)}→مصرف ${fa(x.plannedAmount)}`).join('؛ ')}.`,
    `- ثبت واقعی در service-layer: کل=${fa(c.invoice.total)}؛ اعتبار=${fa(c.invoice.storeCreditApplied)}؛ پرداخت‌شده=${fa(c.invoice.paidTotal)}؛ ماندهٔ کد ۱۵۰هزارتومانی=${fa(c.creditsAfter[2].remaining)}.`,
    `- موجودی قلم‌ها: قبل ${c.stockBefore.join('/')}؛ بعد ${c.stockAfter.join('/')}.`,
    `- تطبیق‌ها: ${Object.entries(c.checks).map(([k,v]) => `${k}=${v ? 'PASS' : 'FAIL'}`).join('؛ ')}.`
  ]),
  '',
  '## ارتباط با تلاش مقدماتی قبلی',
  'در تلاش قبلی، runner مستقیماً به service-layer برای کد ۱۵۰٬۰۰۰ درخواستِ دقیقِ ۱۵۰٬۰۰۰ فرستاده بود. بعد از دو کد ۲۵هزارتومانی، فقط ۱۳۰٬۰۰۰ از فاکتور مانده بود؛ سرویس درخواست دقیق ۱۵۰٬۰۰۰ را رد می‌کرد. این ورودی runner، رفتار planner صفحهٔ POS نبود. آزمون حاضر از همان `posMultiCreditPlan` استفاده کرد که صفحهٔ POS صدا می‌زند؛ برای payload واقعی POS، درخواست کد سوم ۱۳۰٬۰۰۰ است و سه کد با هم کامل مصرف می‌شوند.',
  '',
  '## ایمنی و محدوده',
  '- فقط service-layer و POS planner مشترک با renderer روی SQLite موقت ایزوله اجرا شدند؛ پنجرهٔ واقعی Electron و اسکنر فیزیکی اجرا نشدند.',
  '- هیچ چک، نسیه، فاکتور پرداخت‌نشده، DB واقعی، stage، reset یا تغییر production code استفاده نشد.',
  '- هیچ نقد یا کارت/POS واقعی نیاز نبود؛ پرداخت کامل فقط از سه کد ثبت شد.'
]
writeFileSync(join(out, 'deep-e2e-scenario3-multi-credit-one-vs-many-items.md'), md.join('\n') + '\n')
console.log(`Scenario3 multi-credit single/multi item: ${summary.verdict}; cases=${cases.length}; applied=25k+25k+130k; final remainder=20k; unpaid=0`)
await db.$disconnect?.()
if (summary.verdict !== 'PASS') process.exitCode = 1
