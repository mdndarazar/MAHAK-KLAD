import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-p-factorial-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const [
  { harnessClient }, { makeSeeder }, { salesService }, { storeCreditService },
  { DEFAULT_MANAGER_PASSWORD }, { toJalaliDate }
] = await Promise.all([
  import('../../test/harness/stubs/prismaClient.mjs'),
  import('../../test/harness/seed.mjs'),
  import('../../src/main/services/SalesService.ts'),
  import('../../src/main/services/StoreCreditService.ts'),
  import('../../src/shared/receipt.ts'),
  import('../../src/shared/jalali.ts')
])

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('P factorial active-credit test')
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'P-FACTORIAL-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'P-FACTORIAL-CARD', label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2
})
const categoryId = seed.category('P-FACTORIAL-ALL')
const n = (value) => Number(value ?? 0)
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
let sequence = 0

function makeVariant(name, price) {
  const productId = seed.product(`P-${++sequence}-${name}`, categoryId)
  const variantId = seed.variant(productId, `P-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = ? WHERE id = ?').run(price, variantId)
  return { id: variantId, name, price }
}

function snapshot(variantIds) {
  const count = (table) => n(seed.one(`SELECT COUNT(*) AS count FROM "${table}"`).count)
  const sum = (table, column) => n(seed.one(`SELECT COALESCE(SUM("${column}"), 0) AS total FROM "${table}"`).total)
  return {
    invoices: count('SaleInvoice'), invoiceItems: count('SaleInvoiceItem'), returns: count('SaleReturn'),
    payments: count('Payment'), paymentTotal: sum('Payment', 'amount'),
    credits: count('StoreCredit'), redemptions: count('StoreCreditRedemption'), allocations: count('CreditReturnAllocation'),
    cashMovements: count('CashMovement'), stockMovements: count('StockMovement'),
    stock: variantIds.map((id) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', id).stock))
  }
}

const cases = []
for (const creditTotal of [200000, 250000, 600000]) {
  const suffix = String(creditTotal)
  const shiftId = seed.insert('Shift', {
    name: `P factorial ${suffix}`, number: 900 + cases.length,
    dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
  })
  const A = makeVariant('A-200k', 200000)
  const B = makeVariant('B-200k', 200000)
  const C = makeVariant('C-300k', 300000)
  const D = makeVariant('D-300k', 300000)
  const B1 = makeVariant('B1-220k', 220000)
  const C1 = makeVariant('C1-290k', 290000)
  const D1 = makeVariant('D1-290k', 290000)
  const variants = [A, B, C, D, B1, C1, D1]
  const test = { creditTotal, verdict: 'HARNESS_ERROR', steps: [] }
  cases.push(test)
  try {
    const credit = await storeCreditService.issueManual({
      amount: creditTotal, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `P factorial ALL source ${suffix}`
    })
    const physicalTender = 1000000 - creditTotal
    const cash = Math.floor(physicalTender / 2)
    const card = physicalTender - cash
    const creditCode = seed.one('SELECT code FROM "StoreCredit" WHERE id = ?', credit.id).code
    const root = await salesService.create({
      userId, shiftId,
      lines: [A, B, C, D].map((variant) => line(variant.id, variant.price)),
      storeCredits: [{ code: creditCode, requestedAmount: creditTotal }],
      payments: [
        { methodId: cashMethodId, amount: cash, destination: 'CASH' },
        { methodId: cardMethodId, amount: card, destination: 'CARD' }
      ],
      saleRequestIdempotencyKey: `p-factorial-${suffix}-root`
    })
    if (n(root.grandTotal) !== 1000000 || n(root.storeCreditApplied) !== creditTotal || n(root.paidTotal) !== 1000000)
      throw new Error(`Root sale totals did not reconcile for credit=${creditTotal}: ${JSON.stringify({ grandTotal: root.grandTotal, storeCreditApplied: root.storeCreditApplied, paidTotal: root.paidTotal })}`)
    const saleItems = seed.rows('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId = ?', root.id)
    const itemFor = (variant) => {
      const row = saleItems.find((candidate) => n(candidate.variantId) === variant.id)
      if (!row) throw new Error(`Missing root item ${variant.name}`)
      return n(row.id)
    }
    test.setup = { invoiceId: n(root.id), creditTotal, cash, card, tenderTotal: 1000000, scope: 'ALL' }

    const returnA = await salesService.createReturn({
      userId, invoiceId: n(root.id), full: false,
      lines: [{ saleItemId: itemFor(A), qty: 1 }], refundMethod: 'NONE', confirmOverpay: true
    })
    test.afterA = {
      returnId: n(returnA.id), creditReturned: n(returnA.returnCreditAmount),
      redemptionCreditLeftOnRoot: Math.max(0, creditTotal - n(returnA.returnCreditAmount))
    }
    const afterA = await salesService.createExchange({
      userId, invoiceId: n(root.id),
      lines: [{ saleItemId: itemFor(B), qty: 1 }],
      replacements: [line(B1.id, B1.price)], methodId: cardMethodId,
      idempotencyKey: `p-factorial-${suffix}-positive-B`
    })
    const bAllocations = seed.rows(
      'SELECT amount, creditRestored, settlementAdjusted, restrictScope, saleItemId FROM "CreditReturnAllocation" WHERE returnId = ? ORDER BY id', afterA.returnId
    )
    const bAllocation = bAllocations.reduce((total, row) => total + n(row.amount), 0)
    const bReturnRow = seed.one('SELECT exchangeInvoiceId, exchangeTotal, exchangeDiff FROM "SaleReturn" WHERE id = ?', afterA.returnId)
    const bPayments = seed.rows(
      'SELECT p.amount, pm.key AS methodKey FROM "Payment" p JOIN "PaymentMethod" pm ON pm.id = p.methodId WHERE p.invoiceId = ?',
      bReturnRow.exchangeInvoiceId
    )
    const bCardReceived = bPayments.filter((payment) => payment.methodKey === 'P-FACTORIAL-CARD').reduce((total, payment) => total + n(payment.amount), 0)
    const bSyntheticCredit = bPayments.filter((payment) => payment.methodKey === 'EXCHANGE_CREDIT').reduce((total, payment) => total + n(payment.amount), 0)
    const remainingAfterA = Math.max(0, creditTotal - 200000)
    const expectedConsumedInB = Math.min(200000, remainingAfterA)
    if (n(afterA.diff) !== 20000 || n(bReturnRow.exchangeTotal) !== 220000 || n(bReturnRow.exchangeDiff) !== 20000)
      throw new Error(`Positive B exchange amounts did not reconcile for credit=${creditTotal}`)
    if (bCardReceived !== 20000 || bSyntheticCredit !== 200000)
      throw new Error(`Positive B exchange tenders did not reconcile for credit=${creditTotal}: ${JSON.stringify(bPayments)}`)
    test.afterB = {
      returnId: n(afterA.returnId), exchangeInvoiceId: n(bReturnRow.exchangeInvoiceId), diff: n(afterA.diff),
      cardReceived: bCardReceived, exchangeCreditApplied: bSyntheticCredit,
      allocations: bAllocations.map((row) => ({ amount: n(row.amount), creditRestored: !!row.creditRestored,
        settlementAdjusted: !!row.settlementAdjusted, scope: row.restrictScope, saleItemId: row.saleItemId == null ? null : n(row.saleItemId) })),
      recordedConsumedCredit: bAllocation, expectedConsumedCredit: expectedConsumedInB
    }

    const beforeTarget = snapshot(variants.map((variant) => variant.id))
    let target = null
    let error = ''
    try {
      target = await salesService.createExchange({
        userId, invoiceId: n(root.id),
        lines: [{ saleItemId: itemFor(C), qty: 1 }, { saleItemId: itemFor(D), qty: 1 }],
        replacements: [line(C1.id, C1.price), line(D1.id, D1.price)],
        refundMode: 'STORE_CREDIT', idempotencyKey: `p-factorial-${suffix}-negative-CD`
      })
    } catch (e) { error = String(e?.message ?? e) }
    const afterTarget = snapshot(variants.map((variant) => variant.id))
    test.target = target
      ? { accepted: true, returnId: n(target.returnId), diff: n(target.diff), mutationFree: false }
      : { accepted: false, mutationFree: JSON.stringify(beforeTarget) === JSON.stringify(afterTarget), error }

    const isBaseline = process.env.EXPECT_BASELINE === '1'
    const expectedAccepted = isBaseline ? creditTotal === 200000 : true
    if (!!target !== expectedAccepted)
      throw new Error(`Unexpected target result for credit=${creditTotal}: expected accepted=${expectedAccepted}; ${error}`)
    if (!target && JSON.stringify(beforeTarget) !== JSON.stringify(afterTarget))
      throw new Error(`Rejected target mutated the DB for credit=${creditTotal}`)
    const expectedAllocation = process.env.EXPECT_BASELINE === '1' ? 0 : expectedConsumedInB
    if (bAllocation !== expectedAllocation)
      throw new Error(`B provenance mismatch for credit=${creditTotal}: expected ${expectedAllocation}, got ${bAllocation}`)
    if (!isBaseline && expectedConsumedInB > 0 && bAllocations.some((row) =>
      !!row.creditRestored || !!row.settlementAdjusted || String(row.restrictScope).toUpperCase() !== 'ALL' || row.saleItemId != null))
      throw new Error(`B consumed-credit provenance flags/scope are invalid for credit=${creditTotal}`)
    if (target) {
      const targetReturn = seed.one(
        'SELECT total, exchangeTotal, exchangeDiff, exchangeSettlement, exchangeInvoiceId FROM "SaleReturn" WHERE id = ?', target.returnId
      )
      const targetInvoicePayment = n(seed.one(
        'SELECT COALESCE(SUM(p.amount), 0) AS amount FROM "Payment" p WHERE p.invoiceId = ?', targetReturn.exchangeInvoiceId
      ).amount)
      const issuedCredit = n(seed.one(
        'SELECT COALESCE(SUM(amount), 0) AS amount FROM "StoreCredit" WHERE returnId = ?', target.returnId
      ).amount)
      const restoredSourceCredit = n(seed.one(
        'SELECT COALESCE(SUM(amount), 0) AS amount FROM "CreditReturnAllocation" WHERE returnId = ? AND creditRestored = 1', target.returnId
      ).amount)
      const expectedRestoredSourceCredit = creditTotal === 600000 ? 20000 : 0
      const expectedStockDelta = [0, 0, 1, 1, 0, -1, -1]
      const actualStockDelta = afterTarget.stock.map((stock, index) => stock - beforeTarget.stock[index])
      if (n(target.diff) !== -20000 || n(targetReturn.total) !== 600000 || n(targetReturn.exchangeTotal) !== 580000 ||
          n(targetReturn.exchangeDiff) !== -20000 || String(targetReturn.exchangeSettlement) !== 'CREDIT')
        throw new Error(`Negative C+D exchange values/settlement did not reconcile for credit=${creditTotal}`)
      if (targetInvoicePayment !== 580000 || issuedCredit !== 20000 || restoredSourceCredit !== expectedRestoredSourceCredit)
        throw new Error(`Negative exchange financial/credit postings did not reconcile for credit=${creditTotal}: ${JSON.stringify({ targetInvoicePayment, issuedCredit, restoredSourceCredit, expectedRestoredSourceCredit })}`)
      if (JSON.stringify(actualStockDelta) !== JSON.stringify(expectedStockDelta))
        throw new Error(`Negative exchange stock did not reconcile for credit=${creditTotal}: ${JSON.stringify(actualStockDelta)}`)
      test.target = { ...test.target, exchangeInvoiceId: n(targetReturn.exchangeInvoiceId), returnTotal: n(targetReturn.total),
        replacementTotal: n(targetReturn.exchangeTotal), issuedCredit, restoredSourceCredit, targetInvoicePayment,
        stockDelta: actualStockDelta }
    }
    test.verdict = expectedAccepted ? 'EXPECTED_ACCEPT' : 'EXPECTED_BLOCK'
  } catch (error) {
    test.error = String(error?.message ?? error)
    test.stack = String(error?.stack ?? '')
    test.verdict = 'HARNESS_ERROR'
  }
}

const summary = {
  isolatedDatabase: process.env.HARNESS_DB,
  suite: 'P-family factorial: redeemed ALL credit minus returned source credit at 0, 50k and 400k, with item values/exchange amounts fixed and no debt/cheques.',
  cases,
  totals: {
    cases: cases.length,
    harnessErrors: cases.filter((test) => test.verdict === 'HARNESS_ERROR').length,
    accepted: cases.filter((test) => test.target?.accepted).length,
    blockedMutationFree: cases.filter((test) => test.target && !test.target.accepted && test.target.mutationFree).length
  }
}
console.log(JSON.stringify(summary, null, 2))
await db.$disconnect?.()
if (summary.totals.harnessErrors) process.exitCode = 1
