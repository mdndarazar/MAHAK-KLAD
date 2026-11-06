/* First scenario only from fix-exchange-credit-tender-reversal-and-cheque.mjs.
 * Runs on one fresh isolated SQLite DB; deliberately stops before scenario 2.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-credit-first-only-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const userId = seed.user('first-only barcode exchange test')
const shiftId = seed.insert('Shift', { name: 'first-only isolated shift', number: 1, dayJalali: today, openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'FIRST-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const categoryId = seed.category('first-only category')
const productId = seed.product('first-only exchange goods', categoryId)
let variantIndex = 0
const variant = (price) => {
  const id = seed.variant(productId, `first-only-${++variantIndex}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100,salePrice=? WHERE id=?').run(price, id)
  return id
}
const a = variant(1_000), b = variant(1_000), c = variant(1_500)
const code = 'EXCHCREDIT1'
const creditId = seed.insert('StoreCredit', {
  code, amount: 700, source: 'MANUAL', usedAmount: 0, usedCount: 0,
  maxUses: 1, multiUse: 0, carryRemainder: 1, status: 'ACTIVE',
  issuedAt: Date.now() - 60_000, issuedAtJalali: today,
  expiresAt: new Date(Date.now() + 10 * 86_400_000)
})
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const expectedCash = 2_000
let outcome = { status: 'RUNNING', scenario: 'first numbered example only', isolatedDatabase: process.env.HARNESS_DB }
try {
  // Original two-unit sale: both units funded in full by cash.
  const original = await salesService.create({
    userId, shiftId, lines: [line(a, 1_000), line(b, 1_000)],
    payments: [{ methodId: cash, amount: 2_000, destination: 'CASH' }]
  })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', original.id)
  assert.equal(items.length, 2)
  const before = seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', creditId)
  assert.equal(Number(before.amount), 700)
  assert.equal(before.status, 'ACTIVE')

  // This is only section 1 of the parent suite: exchange A(1,000) for C(1,500).
  const exchange = await salesService.createExchange({
    userId, shiftId, invoiceId: original.id,
    lines: [{ saleItemId: Number(items.find(x => Number(x.variantId) === a).id), qty: 1 }],
    replacements: [line(c, 1_500)], exchangeCreditCode: code,
    idempotencyKey: 'exchange-credit-first-1', methodId: cash
  })
  const creditAfter = seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', creditId)
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  const payments = seed.rows('SELECT id,invoiceId,amount,kind,methodId,storeCreditId,voidedAt FROM "Payment" WHERE createdShiftId=? ORDER BY id', shiftId)
  const cashRaw = Number(seed.one(`SELECT COALESCE(SUM(p.amount),0) amount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? AND p.kind='CASH' AND m.kind='CASH' AND p.voidedAt IS NULL`, shiftId).amount)
  const cardRaw = Number(seed.one(`SELECT COALESCE(SUM(p.amount),0) amount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? AND p.kind='CASH' AND m.kind='CARD' AND p.voidedAt IS NULL`, shiftId).amount)
  const checks = seed.count('Payment', `createdShiftId=? AND (UPPER(kind) IN ('CHECK','CHEQUE') OR methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE')))`, shiftId)
  const report = await salesService.reportRows({ shiftId })
  const blue = Number(await physicalMovementForCustodyShift(shiftId))
  const stocks = [a, b, c].map((id, index) => {
    const row = seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)
    const ledger = Number(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', id).d)
    return { name: ['A source', 'B kept item', 'C replacement'][index], expected: [100, 99, 99][index], actual: Number(row.stock), ledger }
  })

  assert.equal(Number(exchange.diff), 500)
  assert.equal(Number(exchange.barcodeCreditApplied), 500)
  assert.equal(Number(exchange.cashDue), 0)
  assert.equal(Number(exchange.cashReceived), 0)
  assert.equal(Number(creditAfter.usedAmount), 500)
  assert.equal(Number(creditAfter.usedCount), 1)
  assert.equal(creditAfter.status, 'PARTIALLY_USED')
  assert.equal(payments.filter(p => Number(p.storeCreditId) === creditId).length, 1)
  assert.equal(cashRaw, expectedCash)
  assert.equal(cardRaw, 0)
  assert.equal(checks, 0)
  assert.equal(blue, expectedCash)
  assert.equal(invoices.length, 2)
  for (const invoice of invoices) {
    assert.equal(Number(invoice.grandTotal), Number(invoice.paidTotal), `invoice ${invoice.id} fully paid`)
    assert.ok(invoice.settledAt != null, `invoice ${invoice.id} has settledAt`)
  }
  for (const stock of stocks) {
    assert.equal(stock.actual, stock.expected, `${stock.name} on-hand`)
    assert.equal(stock.actual, 100 + stock.ledger, `${stock.name} stock ledger`)
  }

  outcome = {
    status: 'PASS', scenario: 'first numbered example only', isolatedDatabase: process.env.HARNESS_DB,
    setup: { originalSaleTotal: 2_000, cashPaid: 2_000, barcodeCreditIssued: 700,
      sourceItemReturned: 1_000, replacementItem: 1_500 },
    exchange: { nominalDifference: Number(exchange.diff), barcodeCreditApplied: Number(exchange.barcodeCreditApplied),
      additionalCashDue: Number(exchange.cashDue), cashReceived: Number(exchange.cashReceived) },
    creditAfter: { amount: Number(creditAfter.amount), usedAmount: Number(creditAfter.usedAmount),
      usedCount: Number(creditAfter.usedCount), status: creditAfter.status },
    reconciliation: { expectedCash: expectedCash, actualCash: cashRaw, card: cardRaw, blue,
      reportTotals: report.totals, invoices: invoices.map(x => ({ id: Number(x.id), total: Number(x.grandTotal), paid: Number(x.paidTotal), settled: !!x.settledAt })),
      stocks, chequePayments: checks },
    note: 'Only scenario 1 was run. Scenario 2 and later were not executed.'
  }
} catch (error) {
  outcome.status = 'FAIL'
  outcome.failure = { message: String(error?.message ?? error), stack: String(error?.stack ?? '') }
} finally {
  const outputDir = resolve(process.cwd(), 'reports', 'deep-e2e-exchange-credit-tender-first-only')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'first.json'), JSON.stringify(outcome, null, 2) + '\n')
  const md = [
    '# اجرای مورد اول — اعتبار بارکدی در اختلاف مثبت تعویض', '',
    `**نتیجه:** ${outcome.status}`, `**SQLite ایزوله:** ${outcome.isolatedDatabase}`, '',
    '## مثال عددی',
    '- فروش اولیه: دو کالا × ۱٬۰۰۰ = ۲٬۰۰۰ ریال؛ کاملاً نقدی و تسویه‌شده.',
    '- اعتبار خرید موجود: ۷۰۰ ریال.',
    '- تعویض کالای A به ارزش ۱٬۰۰۰ با کالای C به ارزش ۱٬۵۰۰؛ اختلاف مثبت ۵۰۰ ریال.',
    '- از اختلاف ۵۰۰ ریالی، ۵۰۰ با اعتبار خرید پرداخت شد؛ وجه نقد اضافه = صفر. ماندهٔ اعتبار = ۲۰۰ ریال.', '',
    '## تطبیق و دامنه',
    `- نتیجهٔ نهایی: ${JSON.stringify(outcome.reconciliation ?? outcome.failure ?? null)}`,
    '- فقط مورد شمارهٔ ۱ اجرا شد؛ مورد ۲ و بقیهٔ فایل مادر اجرا نشدند.',
    '- پایگاه تست SQLite موقت و ایزوله بود؛ هیچ منطق production، دیتابیس واقعی/staging یا پول واقعی استفاده نشد.'
  ]
  writeFileSync(join(outputDir, 'first.md'), md.join('\n') + '\n')
  if (outcome.status !== 'PASS') process.exitCode = 1
  await db.$disconnect?.()
}
