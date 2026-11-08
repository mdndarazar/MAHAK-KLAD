/**
 * Follow-up deep E2E campaign (10 new scenarios). Scenario 1 is the four-code,
 * mixed cash/credit return→exchange probe. Temporary SQLite only.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-followup-10-scenarios.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-e2e-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('follow-up complex E2E cashier')
const cashMethod = seed.insert('PaymentMethod', { key: 'F10-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: 'F10-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const categoryId = seed.category('follow-up-10')
const shiftId = seed.insert('Shift', { name: 'follow-up scenario 01', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const variants = []
const v = (label, price) => {
  const product = seed.product(`Followup ${label}`, categoryId)
  const id = seed.variant(product, `FOLLOWUP-${label}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const row = { id, label, price, baseline: 10 }
  variants.push(row)
  return row
}
const line = (x) => ({ variantId: x.id, qty: 1, unitPrice: x.price, discount: 0, tax: 0 })
const asNum = (x) => Number(x ?? 0)
const credits = []
const events = []
const invIds = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const raw = () => {
  const p = seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) value FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) value FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: asNum(p.cash), card: asNum(p.card), refundCash: asNum(c.value), refundCard: asNum(r.value) }
}
async function check(label, expectedDelta = {}, extra = {}) {
  for (const k of Object.keys(expected)) expected[k] += expectedDelta[k] ?? 0
  const report = await salesService.reportRows({ shiftId })
  const actual = { cash: asNum(report.totals.cashTotal), card: asNum(report.totals.cardTotal),
    refundCash: asNum(report.totals.refundCashTotal), refundCard: asNum(report.totals.refundCardTotal) }
  const independent = raw()
  assert.deepEqual(actual, expected, `${label}: expected vs report physical subtotals`)
  assert.deepEqual(independent, actual, `${label}: raw-document independently calculated subtotals`)
  const blueActual = asNum(await physicalMovementForCustodyShift(shiftId))
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blueRaw = independent.cash + independent.card - independent.refundCash - independent.refundCard
  assert.equal(blueActual, blueExpected, `${label}: actual blue custody movement`)
  assert.equal(blueRaw, blueActual, `${label}: independent raw blue`)
  const stocks = variants.map(x => {
    const actualStock = asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', x.id).stock)
    const delta = asNum(seed.one('SELECT COALESCE(SUM(delta),0) value FROM "StockMovement" WHERE variantId=?', x.id).value)
    return { variant: x.label, baseline: x.baseline, expected: x.baseline + delta, actual: actualStock, ledgerDelta: delta }
  })
  for (const x of stocks) assert.equal(x.actual, x.expected, `${label}: stock and raw movement ledger for ${x.variant}`)
  const creditRows = credits.map(x => {
    const c = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', x.id)
    return { label: x.label, amount: asNum(c.amount), usedAmount: asNum(c.usedAmount), usedCount: asNum(c.usedCount), status: c.status, expiresAt: c.expiresAt }
  })
  const invoices = invIds.map(id => {
    const i = seed.one('SELECT id,receiptNo,status,grandTotal,paidTotal,orderType FROM "SaleInvoice" WHERE id=?', id)
    const payments = seed.rows(`SELECT m.key,m.kind,COALESCE(SUM(p.amount),0) amount FROM "Payment" p
      JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? AND p.voidedAt IS NULL GROUP BY m.key,m.kind`, id)
      .map(x => ({ method: x.key, kind: x.kind, amount: asNum(x.amount) }))
    return { id: Number(i.id), receiptNo: i.receiptNo, status: i.status, type: i.orderType,
      grandTotal: asNum(i.grandTotal), paidTotal: asNum(i.paidTotal), payments }
  })
  const returns = seed.rows(`SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,voidedAt
    FROM "SaleReturn" WHERE shiftId=? ORDER BY id`, shiftId).map(x => ({
      id: Number(x.id), invoiceId: Number(x.invoiceId), kind: x.kind, total: asNum(x.total), refundMethod: x.refundMethod,
      refundAmount: asNum(x.refundAmount), refundStoreCreditAmount: asNum(x.refundStoreCreditAmount),
      exchangeInvoiceId: x.exchangeInvoiceId == null ? null : Number(x.exchangeInvoiceId), exchangeTotal: asNum(x.exchangeTotal),
      exchangeDiff: asNum(x.exchangeDiff), exchangeSettlement: x.exchangeSettlement, voided: !!x.voidedAt
    }))
  events.push({ label, expectedPhysical: { ...expected }, actualPhysical: actual, rawIndependent: independent,
    blueActual, blueExpected, blueRaw, stocks, credits: creditRows, invoices, returns, ...extra })
}

// Previous failed test stays a regression-memory item, not overwritten:
// reports/deep-e2e-10-financial-flows.json records full-credit four-barcode
// sale→partial return→exchange failure (expected real 500k, traced real 0).
await check('BASELINE')
const original = v('01-original-500k', 500_000)
const remaining = v('01-remaining-500k', 500_000)
const replacement = v('01-replacement-450k', 450_000)
const issued = []
for (let i = 0; i < 4; i++) {
  const x = await storeCreditService.issueManual({ amount: 100_000, multiUse: false, carryRemainder: true,
    days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
  const row = seed.one('SELECT id,code,amount,usedAmount,status,expiresAt FROM "StoreCredit" WHERE id=?', x.id)
  const credit = { id: Number(row.id), code: row.code, label: `new-code-${i + 1}` }
  credits.push(credit); issued.push(credit)
  await check(`credit issue ${i + 1}/4`)
}
const sale = await salesService.create({ userId, shiftId, lines: [line(original), line(remaining)],
  payments: [{ methodId: cashMethod, amount: 600_000, destination: 'CASH' }],
  storeCredits: issued.map(c => ({ code: c.code })), saleRequestIdempotencyKey: 'followup-s01-four-code-mixed-sale' })
invIds.push(Number(sale.id))
assert.equal(Number(sale.grandTotal), 1_000_000)
assert.equal(Number(sale.storeCreditApplied), 400_000)
await check('sale: 600k cash + four 100k barcodes', { cash: 600_000 }, { invoice: { id: sale.id, total: 1_000_000, cash: 600_000, storeCredit: 400_000 } })
const items = seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
const returnedItemId = Number(items.find(x => Number(x.variantId) === original.id).id)
let overpayGateError = ''
try {
  await salesService.createReturn({ userId, shiftId, invoiceId: sale.id, full: false,
    lines: [{ saleItemId: returnedItemId, qty: 1 }], refundMethod: 'NONE' })
} catch (e) { overpayGateError = String(e?.message ?? e) }
assert.match(overpayGateError, /اضافه.?دریافت|اضافه‌دریافت/,
  '600,000 physical receipts exceed the returned 500,000 line by 100,000; the unconfirmed overpayment must be rejected')
assert.equal(seed.count('SaleReturn', 'invoiceId=?', sale.id), 0, 'rejected overpayment attempt leaves no return document')
assert.equal(asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', original.id).stock), 9,
  'rejected return attempt does not restock the item')
await check('unconfirmed 100k overpayment return rejected; no document or stock effect')
const ret = await salesService.createReturn({ userId, shiftId, invoiceId: sale.id, full: false,
  lines: [{ saleItemId: returnedItemId, qty: 1 }], refundMethod: 'NONE',
  confirmOverpay: true, overpayAsCredit: true, managerPassword: DEFAULT_MANAGER_PASSWORD })
const returnCredits = seed.rows('SELECT id,code FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
  .map((x, i) => ({ id: Number(x.id), code: x.code, label: `return-credit-${i + 1}` }))
if (ret.overpayCredit?.id && !returnCredits.some(x => x.id === Number(ret.overpayCredit.id))) {
  const x = seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?', ret.overpayCredit.id)
  if (x) returnCredits.push({ id: Number(x.id), code: x.code, label: 'overpayment-credit' })
}
credits.push(...returnCredits)
assert.equal(asNum(ret.overpayAmount), 100_000,
  'the explicitly confirmed extra receipt is reported as 100,000 overpayment')
assert.equal(asNum(ret.refundAmount), 0, 'the NONE return performs no physical cash/POS refund')
await check('confirmed return; restore noncash source, no physical payout', {}, { returnResult: {
  id: ret.id, value: asNum(ret.total), refundMethod: ret.refundMethod, refundAmount: asNum(ret.refundAmount),
  returnCreditAmount: asNum(ret.returnCreditAmount), sourceCreditRestoredAmount: asNum(ret.sourceCreditRestoredAmount),
  overpayAmount: asNum(ret.overpayAmount), invoiceOverpaid: asNum(ret.invoiceOverpaid),
  overpayCreditAmount: asNum(ret.overpayCredit?.amount ?? 0), successorCount: (ret.sourceCreditSuccessors ?? []).length
} })
assert.equal(asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', original.id).stock), 10)
assert.equal(asNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', remaining.id).stock), 9)
const beforeFailedExchange = {
  returnRows: seed.count('SaleReturn', 'shiftId=?', shiftId), invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId),
  paymentRows: seed.count('Payment', 'createdShiftId=?', shiftId)
}
let exchangeFailure = null
try {
  const ex = await salesService.createExchange({ userId, shiftId, invoiceId: sale.id,
    lines: [{ saleItemId: Number(items.find(x => Number(x.variantId) === remaining.id).id), qty: 1 }],
    replacements: [line(replacement)], refundMode: 'STORE_CREDIT' })
  invIds.push(Number(ex.exchangeInvoiceId))
  await check('exchange 500k remaining line→450k replacement', {}, { exchange: ex })
} catch (e) {
  exchangeFailure = { message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
  await check('post rejected exchange: rollback and unchanged balances')
}
const after = {
  returnRows: seed.count('SaleReturn', 'shiftId=?', shiftId), invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId),
  paymentRows: seed.count('Payment', 'createdShiftId=?', shiftId)
}
if (exchangeFailure) assert.deepEqual(after, beforeFailedExchange, 'rejected exchange creates no invoice/return/payment document')
const output = { generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  scenarioNumber: 1, priorFailureMemory: 'Four fully credit-funded 1,000,000 sale; partial return followed by exchange rejected: physical settlement expected 500,000 but traceable physical source 0.',
  scenario: 'Four 100,000 barcode credits + 600,000 cash fund two 500,000 goods; return first line without physical refund; exchange remaining 500,000 item to 450,000.',
  conclusion: exchangeFailure ? 'FAIL: sale/return accounting checkpoints passed; exchange rejected. A credit-funded source share must not be treated as cash. Confirm whether a mixed-funding return/exchange is intended under the store policy; no policy assumption or source-code edit made.' : 'PASS: all stated financial, stock, and barcode checks passed; assess against noncash-credit policy.',
  status: exchangeFailure ? 'FAIL' : 'PASS', exchangeFailure, beforeFailedExchange, after, events }
const dirOut = resolve(process.cwd(), 'reports'); mkdirSync(dirOut, { recursive: true })
writeFileSync(join(dirOut, 'deep-e2e-followup-10-scenario01.json'), JSON.stringify(output, null, 2) + '\n')
const md = [`# Follow-up E2E scenario 1 of 10`, '', `Date: ${output.generatedAt}`, '',
  `**Status: ${output.status}.** ${output.conclusion}`, '',
  `## مبلغ‌های سناریو`,
  `- چهار بارکد × 100,000 = 400,000 ریال + نقد 600,000 = فاکتور 1,000,000 ریالی (دو قلم 500,000).`,
  `- برگشت قلم اول: 500,000 ریال، روش NONE؛ وجه فیزیکیِ پرداخت‌شده در مرحلهٔ برگشت صفر.`,
  `- تعویض قلم دوم: 500,000 به 450,000، اختلاف 50,000 اعتبار خرید (در صورت پذیرش).`, '',
  `## جمع‌بندی نسبت به سیاست اعلام‌شده`,
  `مرجع آبی فقط نقد و POS واقعی است؛ چهار بارکد اعتبار پول فیزیکی نیستند. ${exchangeFailure ? 'فروش و مرجوعی از نظر مرجع آبی منطبق بودند: blue برابر 600,000 باقی ماند و 400,000 اعتبار منبع به 4 بارکد جانشین برگشت؛ پرداخت نقدی/POS از برگشت صفر بود. اما تعویض رد شد: سیستم سهم واقعی موردنیاز 500,000 و وجه واقعی قابل‌ردیابی 100,000 گزارش کرد. رد پرداختن اعتبار به‌جای پول نقد با سیاست پایه سازگار است، ولی اختلاف ردیابی 400,000 باعث می‌شود کل زنجیره را مطابق سیاست تأیید نکنم؛ مورد برای بررسی سیاست pooled / منطق زنجیره باز می‌ماند. به هیچ کالایی اعتبار pooled تخصیص ندادیم.' : 'تمام اعداد و مانده‌ها با فرمول و دفتر خام تطبیق داشتند.'}`,'',
  `## تطبیق`, ...events.map(e => `- **${e.label}:** blue مورد انتظار ${e.blueExpected}؛ سرویس ${e.blueActual}؛ محاسبه مستقل ${e.blueRaw}. نقد/POS/برگشت: ${JSON.stringify(e.actualPhysical)}. موجودی: ${JSON.stringify(e.stocks)}. اعتبارها: ${JSON.stringify(e.credits)}. اسناد برگشت: ${JSON.stringify(e.returns)}.`),
  ...(exchangeFailure ? [``, `## خطای ثبت‌شده`, `- ${exchangeFailure.message}`, `- شمار اسناد قبل/بعد: ${JSON.stringify({ before: beforeFailedExchange, after })}; بررسی rollback: ${JSON.stringify(beforeFailedExchange) === JSON.stringify(after) ? 'بدون سند جزئی تأیید شد' : 'تغییر مشاهده شد'}.`, `- Stack: ${exchangeFailure.stack.replaceAll('\n',' · ')}`] : []),
  '', 'دیتابیس فقط SQLite موقت ساخته‌شده از migrationهای پروژه بود؛ دیتابیس واقعی تغییر نکرد.']
writeFileSync(join(dirOut, 'deep-e2e-followup-10-scenario01.md'), md.join('\n') + '\n')
console.log(`Scenario 1 ${output.status}; report=${join(dirOut, 'deep-e2e-followup-10-scenario01.md')}; isolatedDB=${process.env.HARNESS_DB}`)
await db.$disconnect?.()
if (exchangeFailure) process.exitCode = 1
