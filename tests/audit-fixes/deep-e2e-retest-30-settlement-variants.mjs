/**
 * Supplemental return-settlement variant matrix for the 30 primary financial
 * flows documented in reports/deep-e2e-retest-30-summary.md.
 *
 * One invocation runs exactly one (scenario, return-method) cell in a fresh,
 * temporary SQLite harness. The already-recorded 30 primary runs are the
 * baseline; this runner adds five settlement-method probes per scenario.
 * It does not import or modify production files except calling existing service
 * APIs. Run via test/harness/register.mjs with MAHAK_RETEST30_CASE and
 * MAHAK_RETEST30_MODE set. See the companion report for the scope boundary.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cases = [
  [1, 'فروش نقدی دو قلم', 2, 'invoice'], [2, 'نقد و POS و برگشت جزئی', 2, 'line'],
  [3, 'فروش POS و برگشت POS', 1, 'none'], [4, 'تعویض کاهشی با اعتبار', 1, 'invoice'],
  [5, 'تعویض افزایشی با دریافت نقد', 1, 'line'], [6, 'تعویض کاهشی با بازپرداخت POS', 1, 'invoice'],
  [7, 'فروش فقط با اعتبار و ماندهٔ کد', 1, 'none'], [8, 'برگشت یک قلم و تعویض باقی‌مانده', 2, 'invoice'],
  [9, 'چهار اعتبار و برگشت چندمنبعی', 4, 'invoice'], [10, 'فروش مختلط و زنجیرهٔ برگشت/تعویض', 4, 'line'],
  [11, 'چهار اعتبار و نقد؛ برگشت/تأیید اضافه‌دریافت', 4, 'invoice'], [12, 'برگشت خرید چهاراعتباری', 2, 'line'],
  [13, 'تعویض با فاکتور دوم مشتری', 1, 'invoice'], [14, 'چندبارکدی با روش‌های تسویه', 3, 'invoice'],
  [15, 'صفر/یک/چهار کد و زنجیرهٔ نسل دوم', 2, 'line'], [16, 'برگشت از فاکتور دوم با چهار روش', 2, 'invoice'],
  [17, 'برگشت جزئی و سپس تعویض', 3, 'invoice'], [18, 'بازگشت سهم به کد زندهٔ نیمه‌مصرف', 2, 'line'],
  [19, 'کد USED و successor تازه', 2, 'invoice'], [20, 'تعویض مثبت و برگشت child invoice', 3, 'line'],
  [21, 'برگشت pooled چندمنبعی بدون انتساب حدسی', 4, 'invoice'], [22, 'یک redemption محدودشده بین دو قلم', 2, 'line'],
  [23, 'بدون روش؛ گیت‌های مستقل مدیر', 1, 'invoice'], [24, 'برگشت child فقط redemption مربوط', 2, 'line'],
  [25, 'زنجیرهٔ چندقلمی A، B، C+D و B2', 4, 'invoice'], [26, 'بدون روش و اعتبار پشتوانه‌دار', 1, 'line'],
  [27, 'بازگشت به اعتبار زنده بدون successor', 2, 'invoice'], [28, 'اعتبار USED و successor مستقل', 1, 'line'],
  [29, 'دو منبع USED و دو successor', 2, 'invoice'], [30, 'رد برگشت تکراری بدون تغییر', 1, 'none']
].map(([id, name, itemCount, discountKind]) => ({ id, name, itemCount, discountKind }))

const methods = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE']
const caseId = Number(process.env.MAHAK_RETEST30_CASE)
const mode = String(process.env.MAHAK_RETEST30_MODE ?? '').toUpperCase()
const scenario = cases.find(x => x.id === caseId)
assert.ok(scenario, `MAHAK_RETEST30_CASE must be 1..30; got ${caseId}`)
assert.ok(methods.includes(mode), `MAHAK_RETEST30_MODE must be ${methods.join('|')}; got ${mode}`)

const dir = mkdtempSync(join(tmpdir(), `mahak-retest30-${String(caseId).padStart(2, '0')}-${mode.toLowerCase()}-`))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const n = x => Number(x ?? 0)
const userId = seed.user(`RETEST30 ${caseId} ${mode}`)
const shiftId = seed.insert('Shift', { name: `RETEST30 ${caseId} ${mode}`, number: 30000 + caseId * 10 + methods.indexOf(mode), dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `R30-${caseId}-${mode}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `R30-${caseId}-${mode}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const categoryId = seed.category(`retest30-${caseId}-${mode}`)
const variants = []
const unitPrice = 100_000
for (let i = 0; i < scenario.itemCount; i++) {
  const productId = seed.product(`RETEST30 ${caseId} item ${i + 1}`, categoryId)
  const variantId = seed.variant(productId, `R30-${caseId}-${i + 1}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(unitPrice, variantId)
  variants.push({ id: variantId, baseline: 10, name: `item-${i + 1}` })
}

// Positive discounts appear in representative single- and multi-line cases.
// The invoice-level amount is evenly divisible across equal-priced items, so
// the test can independently assert the per-item net without rounding ambiguity.
const discountRateCases = new Set([1, 2, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
const hasDiscount = discountRateCases.has(caseId)
const gross = unitPrice * scenario.itemCount
let invoiceDiscount = 0
const saleLines = variants.map((v, i) => ({ variantId: v.id, qty: 1, unitPrice, discount: 0, tax: 0 }))
if (hasDiscount && scenario.discountKind === 'invoice') invoiceDiscount = gross / 10
if (hasDiscount && scenario.discountKind === 'line') saleLines[0].discount = unitPrice / 10
const grossAfterLineDiscount = gross - saleLines.reduce((sum, l) => sum + l.discount, 0)
const netInvoice = grossAfterLineDiscount - invoiceDiscount
assert.ok(Number.isSafeInteger(netInvoice) && netInvoice > 0)
const returnedCount = scenario.itemCount > 1 && caseId % 3 === 0 ? 2 : 1
const perItemInvoiceShare = scenario.itemCount ? invoiceDiscount / scenario.itemCount : 0
const returnedNet = saleLines.slice(0, returnedCount).reduce(
  (sum, line) => sum + line.qty * line.unitPrice - line.discount - perItemInvoiceShare, 0
)
assert.ok(Number.isSafeInteger(returnedNet) && returnedNet > 0)

const saleTender = caseId % 3
const paymentRows = saleTender === 0
  ? [{ methodId: cashMethod, amount: netInvoice, destination: 'CASH' }]
  : saleTender === 1
    ? [{ methodId: cardMethod, amount: netInvoice, destination: 'CARD' }]
    : [{ methodId: cashMethod, amount: Math.floor(netInvoice / 2), destination: 'CASH' },
       { methodId: cardMethod, amount: netInvoice - Math.floor(netInvoice / 2), destination: 'CARD' }]
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const stockExpected = new Map(variants.map(v => [v.id, v.baseline]))
const snapshots = []
const rawPhysical = () => {
  const payments = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const refunds = seed.one(`SELECT COALESCE(SUM(amount),0) cash FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const cardRefund = seed.one(`SELECT COALESCE(SUM(refundAmount),0) card FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(payments.cash), card: n(payments.card), refundCash: n(refunds.cash), refundCard: n(cardRefund.card) }
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(reported, expected, `${label}: reported tender/refund totals`)
  assert.deepEqual(rawPhysical(), reported, `${label}: raw payment/refund ledgers`)
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  const expectedBlue = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, expectedBlue, `${label}: blue/custody movement`)
  const stock = variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, stockExpected.get(v.id), `${label}: ${v.name} expected stock`)
    assert.equal(actual, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { variantId: v.id, expected: stockExpected.get(v.id), actual, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const invoice of invoices) {
    assert.equal(n(invoice.grandTotal), n(invoice.paidTotal), `${label}: no unpaid invoice`)
    assert.ok(invoice.settledAt != null, `${label}: invoice settled`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no check/debt instrument`)
  const event = { label, expected: { ...expected, blue: expectedBlue }, reported, raw: rawPhysical(), blue, stock,
    invoices: invoices.map(i => ({ id: n(i.id), grossPaid: n(i.grandTotal), paid: n(i.paidTotal), discount: n(i.discountTotal), settled: !!i.settledAt })),
    counts: { returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'), transfers: seed.count('CardTransferRequest', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId), checks } }
  snapshots.push(event)
  return event
}

const result = { generatedAt: new Date().toISOString(), scenarioId: caseId, scenario: scenario.name, mode,
  matrixRole: 'one of five return-settlement variants; baseline is recorded in deep-e2e-retest-30-summary',
  isolatedDatabase: process.env.HARNESS_DB,
  sourceShape: { itemCount: scenario.itemCount, unitPrice, saleTender: ['CASH','CARD','SPLIT'][saleTender],
    lineDiscount: saleLines.reduce((sum, l) => sum + l.discount, 0), invoiceDiscount, gross, netInvoice, returnedCount, returnedNet },
  status: 'RUNNING', expectedFinancial: expected, checkpoints: snapshots, return: null, managerTransfer: null, findings: [] }
try {
  await checkpoint('isolated empty shift')
  const sale = await salesService.create({ userId, shiftId, lines: saleLines, payments: paymentRows,
    ...(invoiceDiscount ? { invoiceDiscount } : {}), saleRequestIdempotencyKey: `retest30-${caseId}-${mode}-sale` })
  const invoice = seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  assert.equal(n(invoice.grandTotal), netInvoice, 'sale net matches discount oracle')
  assert.equal(n(invoice.discountTotal), invoiceDiscount + saleLines.reduce((sum, l) => sum + l.discount, 0), 'recorded discount matches input')
  assert.equal(n(invoice.paidTotal), netInvoice, 'sale is fully settled')
  assert.ok(invoice.settledAt != null)
  for (const p of paymentRows) {
    if (p.methodId === cashMethod) expected.cash += p.amount
    else expected.card += p.amount
  }
  for (const v of variants) stockExpected.set(v.id, stockExpected.get(v.id) - 1)
  const saleItems = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
  assert.equal(saleItems.length, scenario.itemCount)
  await checkpoint(`sale settled; gross=${gross}; discount=${invoiceDiscount + saleLines.reduce((sum,l)=>sum+l.discount,0)}; net=${netInvoice}`)

  const input = { userId, shiftId, invoiceId: n(invoice.id), full: returnedCount === scenario.itemCount,
    lines: saleItems.slice(0, returnedCount).map(i => ({ saleItemId: n(i.id), qty: 1 })) }
  if (mode === 'CASH') Object.assign(input, { refundMethod: 'CASH', refundAmount: returnedNet })
  if (mode === 'CARD') Object.assign(input, { refundMethod: 'CARD', refundAmount: returnedNet,
    cardPosOverride: { acknowledgedNoReverse: true, reason: `RETEST30 scenario ${caseId} discounted-return check`, managerPassword: DEFAULT_MANAGER_PASSWORD } })
  if (mode === 'CARD_TO_CARD') Object.assign(input, { refundMethod: 'CARD_TO_CARD', refundAmount: returnedNet })
  if (mode === 'STORE_CREDIT') Object.assign(input, { refundMethod: 'STORE_CREDIT', refundAmount: returnedNet, creditDays: 30 })
  if (mode === 'NONE') Object.assign(input, { refundMethod: 'NONE', confirmOverpay: true, overpayAsCredit: true,
    overpayManagerPassword: DEFAULT_MANAGER_PASSWORD })

  const returned = await salesService.createReturn(input)
  const ret = seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE id=?', returned.id)
  assert.equal(n(ret.total), returnedNet, 'return amount is the returned line net of its share of discount')
  if (mode !== 'CARD_TO_CARD') {
    for (const v of variants.slice(0, returnedCount)) stockExpected.set(v.id, stockExpected.get(v.id) + 1)
  }
  const createdCredits = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id', returned.id)
  if (mode === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (mode === 'CARD') expected.refundCard += n(ret.refundAmount)
  if (mode === 'CARD_TO_CARD') {
    const req = seed.one('SELECT id,status,amount,paidAmount FROM "CardTransferRequest" WHERE returnId=?', returned.id)
    assert.ok(req, 'C2C creates a linked manager-transfer request')
    assert.equal(req.status, 'PENDING', 'C2C remains pending until manager payment')
    assert.equal(n(req.amount), returnedNet, 'C2C amount excludes discount share')
    await checkpoint('C2C request pending: no cash/POS movement')
    await cardTransferService.pay({ id: n(req.id), paidAmount: returnedNet, userId,
      managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `RETEST30-${caseId}-${mode}` })
    const paid = seed.one('SELECT status,paidAmount,paidMethod FROM "CardTransferRequest" WHERE id=?', req.id)
    assert.equal(paid.status, 'PAID')
    assert.equal(n(paid.paidAmount), returnedNet)
    assert.equal(paid.paidMethod, 'MANAGER_CARD_TO_CARD')
    for (const v of variants.slice(0, returnedCount)) stockExpected.set(v.id, stockExpected.get(v.id) + 1)
    result.managerTransfer = { status: paid.status, amount: n(paid.paidAmount), paidMethod: paid.paidMethod }
  } else {
    if (mode === 'STORE_CREDIT' || mode === 'NONE') {
      assert.equal(createdCredits.reduce((sum, c) => sum + n(c.amount), 0), returnedNet,
        `${mode}: credit amount equals net returned item; discount is not credited`)
    }
  }
  await checkpoint(`return completed via ${mode}; return net=${returnedNet}`)
  result.return = { id: n(ret.id), total: n(ret.total), refundMethod: ret.refundMethod,
    refundAmount: n(ret.refundAmount), refundStoreCreditAmount: n(ret.refundStoreCreditAmount),
    exchangeSettlement: ret.exchangeSettlement, exchangeInvoiceId: ret.exchangeInvoiceId == null ? null : n(ret.exchangeInvoiceId),
    credits: createdCredits.map(c => ({ id: n(c.id), amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status,
      expiresAt: c.expiresAt == null ? null : n(c.expiresAt), delivery: seed.one('SELECT status,handoffType,deliveredAt FROM "StoreCreditDelivery" WHERE creditId=?', c.id) ?? null })) }
  result.status = 'PASS'
} catch (error) {
  result.status = 'FAIL'
  result.failure = { message: String(error?.message ?? error), stack: String(error?.stack ?? '') }
} finally {
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard },
    actual: rawPhysical(), blue: n(await physicalMovementForCustodyShift(shiftId)),
    stock: variants.map(v => ({ id: v.id, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'),
    transfers: seed.count('CardTransferRequest', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    checkPayments: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-retest-30-five-mode-variants')
  mkdirSync(out, { recursive: true })
  const stem = `case${String(caseId).padStart(2, '0')}-${mode.toLowerCase().replaceAll('_', '-')}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# بازآزمون ۳۰ جریان — حالت برگشت ${mode}`, '', `- جریان مرجع: ${String(caseId).padStart(2, '0')} — ${scenario.name}`,
    `- وضعیت: **${result.status}**`, `- پایگاه داده: SQLite موقت ایزوله (${process.env.HARNESS_DB})`,
    `- فاکتور نمونه: ${gross} ناخالص، ${invoiceDiscount + saleLines.reduce((sum,l)=>sum+l.discount,0)} تخفیف، ${netInvoice} خالص.`,
    `- قلم/اقلام برگشتی خالص: ${returnedNet}.`, `- نتیجهٔ مالی نهایی: ${JSON.stringify(result.final.expected)} (expected); ${JSON.stringify(result.final.actual)} (actual); blue=${result.final.blue}.`,
    `- نتیجهٔ برگشت: ${JSON.stringify(result.return ?? result.failure ?? null)}`, '',
    'این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.',
    'این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.',
    'فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status !== 'PASS') process.exitCode = 1
}
