/**
 * Discount Policy 80 / Scenario 02: one item with direct line discount, full sale, official return.
 * Each refund-mode invocation gets a fresh isolated SQLite database.
 * Test-only: no production source, real DB, staging or reset is touched.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.env.MAHK_DISCOUNT80_S02_MODE ?? 'CASH'
const tender = process.env.MAHK_DISCOUNT80_S02_TENDER ?? 'CASH'
const tenders = ['CASH', 'POS', 'SPLIT']
assert.ok(tenders.includes(tender), `MAHK_DISCOUNT80_S02_TENDER must be one of ${tenders.join(', ')}`)
const modes = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE', 'MANAGER_FULL_PRICE']
assert.ok(modes.includes(mode), `MAHK_DISCOUNT80_S02_MODE must be one of ${modes.join(', ')}`)
const dir = mkdtempSync(join(tmpdir(), 'mahak-discount80-s02-'))
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
const userId = seed.user(`Discount80 S02 ${mode}`)
const shiftId = seed.insert('Shift', { name: `Discount80 S02 ${mode}`, number: 80201 + tenders.indexOf(tender) * 10 + modes.indexOf(mode), dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: `D80-S02-${mode}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: `D80-S02-${mode}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`discount80-s02-${mode}`)
const product = seed.product(`Discount80 S02 single item ${mode}`, category)
const variantId = seed.variant(product, `D80S02-${mode}`)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=100000 WHERE id=?').run(variantId)
const n = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const checkpoints = []
const financial = () => {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.amount), refundCard: n(r.amount) }
}
const stocks = () => ({
  actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock),
  ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) delta FROM "StockMovement" WHERE variantId=?', variantId).delta)
})
async function checkpoint(label, expectedStock) {
  const report = await salesService.reportRows({ shiftId })
  const actualService = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  const actualRaw = financial()
  assert.deepEqual(actualService, expected, `${label}: service totals match expected money ledger`)
  assert.deepEqual(actualRaw, expected, `${label}: raw money ledger matches expected`)
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  const expectedBlue = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, expectedBlue, `${label}: blue reconciliation`)
  const stock = stocks()
  assert.equal(stock.actual, expectedStock, `${label}: actual stock`)
  assert.equal(stock.actual, 10 + stock.ledger, `${label}: stock matches movement ledger`)
  const event = { label, expected: { ...expected, blue: expectedBlue }, actualService, actualRaw, blue, stock,
    counts: { invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'), checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) } }
  checkpoints.push(event)
  return event
}

const result = { generatedAt: new Date().toISOString(), plan: 'طرح ۱۳ موردی / ممیزی تخفیف ۸۰ سناریویی', scenario: 'D80-S02', tender, mode,
  isolatedDatabase: process.env.HARNESS_DB, status: 'RUNNING', policyExpected: { gross: 100000, invoiceDiscount: 0, lineDiscount: 10000, netSaleAndReturnRight: 90000, allocatedDiscountShare: 10000 },
  sale: null, return: null, managerTransfer: null, credits: [], allocations: [], checkpoints, findings: [] }
let failure = null
try {
  await checkpoint('initial isolated shift', 10)
  const salePayments = tender === 'CASH' ? [{ methodId: cash, amount: 90000, destination: 'CASH' }] :
    tender === 'POS' ? [{ methodId: card, amount: 90000, destination: 'CARD' }] :
    [{ methodId: cash, amount: 45000, destination: 'CASH' }, { methodId: card, amount: 45000, destination: 'CARD' }]
  const sale = await salesService.create({ userId, shiftId,
    lines: [{ variantId, qty: 1, unitPrice: 100000, discount: 10000, tax: 0 }], invoiceDiscount: 0,
    payments: salePayments,
    saleRequestIdempotencyKey: `discount80-s02-${tender}-${mode}-sale` })
  const invoice = seed.one('SELECT id,grandTotal,discountTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  const saleItem = seed.one('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  assert.equal(n(invoice.grandTotal), 90000)
  assert.equal(n(invoice.discountTotal), 10000)
  assert.equal(n(invoice.paidTotal), 90000)
  assert.ok(invoice.settledAt != null)
  assert.equal(n(saleItem.unitPrice), 100000)
  assert.equal(n(saleItem.discount), 10000)
  assert.equal(n(saleItem.lineTotal), 90000)
  expected.cash += salePayments.filter(p => p.destination === 'CASH').reduce((sum, p) => sum + p.amount, 0)
  expected.card += salePayments.filter(p => p.destination === 'CARD').reduce((sum, p) => sum + p.amount, 0)
  result.tender = tender
  result.sale = { id: n(invoice.id), gross: 100000, invoiceDiscount: 0, lineDiscount: n(saleItem.discount), totalDiscount: n(invoice.discountTotal), net: n(invoice.grandTotal), paid: n(invoice.paidTotal), settled: invoice.settledAt != null,
    item: { id: n(saleItem.id), unitPrice: n(saleItem.unitPrice), lineDiscount: n(saleItem.discount), lineTotal: n(saleItem.lineTotal) } }
  await checkpoint(`sale: gross=100,000, line discount=10,000, net=90,000, tender=${tender}`, 9)

  const input = { userId, shiftId, invoiceId: n(invoice.id), full: true, lines: [{ saleItemId: n(saleItem.id), qty: 1 }] }
  if (mode === 'CASH') Object.assign(input, { refundMethod: 'CASH', refundAmount: 90000 })
  if (mode === 'CARD') Object.assign(input, { refundMethod: 'CARD', refundAmount: 90000,
    cardPosOverride: { acknowledgedNoReverse: true, reason: 'discount policy audit S02 card refund', managerPassword: DEFAULT_MANAGER_PASSWORD } })
  if (mode === 'CARD_TO_CARD') Object.assign(input, { refundMethod: 'CARD_TO_CARD', refundAmount: 90000 })
  if (mode === 'STORE_CREDIT') Object.assign(input, { refundMethod: 'STORE_CREDIT', refundAmount: 90000, creditDays: 30 })
  if (mode === 'NONE') Object.assign(input, { refundMethod: 'NONE', confirmOverpay: true, overpayAsCredit: true, overpayManagerPassword: DEFAULT_MANAGER_PASSWORD })
  if (mode === 'MANAGER_FULL_PRICE') Object.assign(input, { refundMethod: 'CASH', managerFullRefund: true,
    managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'audit requested full-price return branch' })

  let returned = null
  try { returned = await salesService.createReturn(input) }
  catch (e) { failure = String(e?.message ?? e) }
  if (failure) {
    const post = { invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId), credits: seed.count('StoreCredit') }
    assert.deepEqual(post, { invoices: 1, returns: 0, payments: salePayments.length, cashMovements: 0, credits: 0 }, 'rejected return must not mutate sale, money or credit records')
    await checkpoint(`return ${mode} blocked mutation-free: ${failure}`, 9)
    result.return = { error: failure, mutationFree: true }
    if (mode === 'MANAGER_FULL_PRICE' && failure.includes('پول واقعاً دریافت')) {
      result.status = 'PASS'
      result.operationOutcome = 'BLOCKED_AS_EXPECTED_TO_PROTECT_DISCOUNT_SHARE'
      result.policyAssessment = { expectedNetReturnRight: 90000, actualCustomerValue: 0, extraDiscountRefunded: 0, deviations: [], note: 'Manager full-price override was refused because only the discounted 90,000 was actually received.' }
    } else {
      result.status = 'BLOCKED'
    }
  } else {
    const row = seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeSettlement,voidedAt FROM "SaleReturn" WHERE id=?', returned.id)
    const returnItems = seed.rows('SELECT * FROM "SaleReturnItem" WHERE returnId=? ORDER BY id', returned.id)
    const creditRows = seed.rows('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id', returned.id)
    const sourceCredits = seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,returnId,exchangeInvoiceId FROM "StoreCredit" ORDER BY id')
    result.return = { id: n(row.id), total: n(row.total), refundMethod: row.refundMethod, refundAmount: n(row.refundAmount),
      refundStoreCreditAmount: n(row.refundStoreCreditAmount), exchangeSettlement: row.exchangeSettlement, returnedItems: returnItems,
      createdCredits: creditRows.map(c => {
        const delivery = seed.one('SELECT id,status,handoffType,createdAt,deliveredAt,userId,note,policyVersion FROM "StoreCreditDelivery" WHERE creditId=?', c.id)
        return { id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt == null ? null : n(c.expiresAt), returnId: c.returnId == null ? null : n(c.returnId), delivery: delivery ? { ...delivery, id: n(delivery.id) } : null }
      }),
      sourceCredits: sourceCredits.map(c => ({ ...c, id: n(c.id), amount: n(c.amount), usedAmount: n(c.usedAmount), usedCount: n(c.usedCount), expiresAt: c.expiresAt == null ? null : n(c.expiresAt) })) }
    result.allocations = seed.rows('SELECT * FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', returned.id)

    if (mode === 'CARD_TO_CARD') {
      const request = seed.one('SELECT id,kind,status,operationKind,returnId,sourceInvoiceId,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE returnId=?', returned.id)
      assert.ok(request, 'manager C2C return must create linked request')
      assert.equal(request.status, 'PENDING')
      assert.equal(n(request.amount), 90000, 'C2C right excludes the 10,000 discount share')
      await checkpoint('return C2C pending: 90,000 request, no physical payout, stock held', 9)
      await cardTransferService.pay({ id: n(request.id), paidAmount: 90000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `D80-S02-${mode}` })
      const paid = seed.one('SELECT id,kind,status,amount,paidAmount,paidMethod,trackingNo,paidByUserId FROM "CardTransferRequest" WHERE id=?', request.id)
      assert.equal(paid.status, 'PAID')
      assert.equal(n(paid.paidAmount), 90000)
      assert.equal(paid.paidMethod, 'MANAGER_CARD_TO_CARD')
      result.managerTransfer = { id: n(paid.id), status: paid.status, amount: n(paid.amount), paidAmount: n(paid.paidAmount), method: paid.paidMethod, trackingNo: paid.trackingNo }
      await checkpoint('manager paid C2C=90,000; physical cash/POS ledger unchanged', 10)
    } else {
      assert.equal(n(row.total), mode === 'MANAGER_FULL_PRICE' ? 100000 : 90000, 'return value is recorded for policy comparison')
      const realRefund = n(row.refundAmount)
      if (mode === 'CASH') expected.refundCash += realRefund
      if (mode === 'CARD') expected.refundCard += realRefund
      await checkpoint(`return ${mode}: gross/discount/net and actual settlement recorded`, 10)
    }

    const returnedGrossOrNet = n(row.total)
    const actualCustomerValue = mode === 'CARD_TO_CARD' ? n(result.managerTransfer?.paidAmount) :
      mode === 'CASH' || mode === 'CARD' ? n(row.refundAmount) :
      mode === 'STORE_CREDIT' || mode === 'NONE' ? creditRows.reduce((sum, c) => sum + n(c.amount), 0) : n(row.refundAmount)
    const policyExpected = 90000
    const deviations = []
    if (returnedGrossOrNet !== policyExpected) deviations.push(`SaleReturn.total=${returnedGrossOrNet}, expected net item share=${policyExpected}`)
    if (actualCustomerValue > policyExpected) deviations.push(`customer payout/credit=${actualCustomerValue} exceeds net paid share=${policyExpected}`)
    if (mode === 'STORE_CREDIT' || mode === 'NONE') {
      const creditValue = creditRows.reduce((sum, c) => sum + n(c.amount), 0)
      if (creditValue !== policyExpected) deviations.push(`created credit=${creditValue}, expected=${policyExpected}`)
    }
    if ((mode === 'CASH' || mode === 'CARD' || mode === 'CARD_TO_CARD') && n(row.refundAmount) !== policyExpected)
      deviations.push(`requested real refund=${n(row.refundAmount)}, expected=${policyExpected}`)
    result.policyAssessment = { expectedNetReturnRight: policyExpected, recordedReturnValue: returnedGrossOrNet, actualCustomerValue, deviations }
    result.findings.push(...deviations)
    result.status = deviations.length ? 'POLICY_MISMATCH' : 'PASS'
  }
} catch (e) {
  result.status = 'FAIL'
  result.unexpectedError = String(e?.stack ?? e)
  throw e
} finally {
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, actual: financial(),
    blue: n(await physicalMovementForCustodyShift(shiftId)), stock: stocks(), invoices: seed.count('SaleInvoice','shiftId=?',shiftId),
    returns: seed.count('SaleReturn','shiftId=?',shiftId), payments: seed.count('Payment','createdShiftId=?',shiftId),
    cashMovements: seed.count('CashMovement','shiftId=?',shiftId), credits: seed.count('StoreCredit'), checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports')
  mkdirSync(out, { recursive: true })
  const suffix = tender === 'CASH' ? mode.toLowerCase().replaceAll('_','-') : `${tender.toLowerCase()}-${mode.toLowerCase().replaceAll('_','-')}`
  writeFileSync(join(out, `deep-e2e-discount-policy-80-s02-${suffix}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# طرح ۱۳ موردی — سناریوی تخفیف D80-S02 / ${tender} tender / ${mode}`, '', `**وضعیت اجرا:** ${result.status}; DB SQLite موقت و ایزوله.`, '',
    `فاکتور تک‌قلمی: قیمت ناخالص ۱۰۰٬۰۰۰؛ تخفیف ردیف ۱۰٬۰۰۰؛ خالص ۹۰٬۰۰۰؛ tender=${tender}. انتظار policy: مبلغ برگشت/تسویه/اعتبار نباید سهم تخفیف ۱۰٬۰۰۰ را به مشتری برگرداند.`, '',
    `**برگشت ثبت‌شده:** ${JSON.stringify(result.return ?? null)}`, `**ارزیابی policy:** ${JSON.stringify(result.policyAssessment ?? null)}`, `**انحراف‌ها:** ${JSON.stringify(result.findings)}`, '',
    `**دفتر نهایی:** expected=${JSON.stringify(result.final.expected)}; actual=${JSON.stringify(result.final.actual)}; blue=${result.final.blue}; stock=${JSON.stringify(result.final.stock)}; invoices=${result.final.invoices}; returns=${result.final.returns}; payments=${result.final.payments}; cashMovements=${result.final.cashMovements}; credits=${result.final.credits}; checks=${result.final.checks}.`, '',
    'برای CARD_TO_CARD، پاسخ manager-paid در هارنس تست ثبت می‌شود؛ انتقال بانکی واقعی انجام نمی‌شود. برای NONE/STORE_CREDIT، شناسه، مبلغ، وضعیت و انقضاهای credit در JSON نگهداری می‌شوند.',
    'فقط تست؛ هیچ production source، DB واقعی، stage یا reset تغییر نکرده.']
  writeFileSync(join(out, `deep-e2e-discount-policy-80-s02-${suffix}.md`), md.join('\n') + '\n')
}
