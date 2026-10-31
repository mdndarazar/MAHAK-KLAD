/** Exact server-side barcode-credit + cash/card settlement matrix for positive
 * exchanges. Store credit is isolated from cash/card receipts and failed amount
 * assertions roll back both redemption and inventory.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-credit-tender-exact-remainder.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-credit-tender-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
process.env.HARNESS_BIGINT = '1'
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { salesLedger } = await import('../../src/main/services/SalesLedger.ts')
const { issueStoreCredit, storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('exchange credit tender matrix')
const categoryId = seed.category('exchange credit tender')
const blockedCategoryId = seed.category('restricted elsewhere')
const product = seed.product('exchange tender goods', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const cardMethodId = seed.insert('PaymentMethod', { key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1 })
const creditMethodId = seed.insert('PaymentMethod', { key: 'STORE_CREDIT', label: 'Store credit', kind: 'STORE_CREDIT', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'exchange shift', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 60_000, userId, staffConfirmed: 1 })
const variant = (label, price) => {
  const id = seed.variant(product, label)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(10, price, id)
  return id
}
const sourceVariant = variant('source', 100_000)
const replacementVariant = variant('replacement', 180_000)
const cashReplacementVariant = variant('cash replacement', 180_000)
const cardSourceVariant = variant('card source', 100_000)
const cardReplacementVariant = variant('card replacement', 180_000)
const splitSourceVariant = variant('split source', 100_000)
const splitReplacementVariant = variant('split replacement', 180_000)
const fullSourceVariant = variant('fully covered source', 100_000)
const fullReplacementVariant = variant('fully covered replacement', 180_000)
const failSourceVariant = variant('fail source', 100_000)
const failReplacementVariant = variant('fail replacement', 180_000)
const line = (variantId, amount) => ({ variantId, qty: 1, unitPrice: amount, discount: 0, tax: 0 })
const openSource = async (v) => {
  const sale = await salesService.create({ userId, shiftId, lines: [line(v, 100_000)],
    payments: [{ methodId: cashMethodId, amount: 100_000, destination: 'CASH' }] })
  return { sale, saleItemId: Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', Number(sale.id)).id) }
}
const issue = async (amount, key) => db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount, multiUse: false, maxUses: 1, carryRemainder: false,
  days: 30, userId, note: key
}))
const forgedCategoryCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 25_000, multiUse: false, maxUses: 1, carryRemainder: false,
  days: 30, restrictScope: 'CATEGORY', restrictCategoryIds: [blockedCategoryId], userId,
  note: 'preview uses database category, not forged renderer category'
}))
const forgedPreview = await storeCreditService.preview({ code: forgedCategoryCredit.code,
  applicable: 50_000, invoiceTotal: 180_000,
  lines: [{ variantId: sourceVariant, categoryId: blockedCategoryId,
    categoryPath: [blockedCategoryId], qty: 1, lineTotal: 50_000 }] })
assert.equal(forgedPreview.applied, 0, 'preview ignores a renderer-forged allowed category')
assert.equal(forgedPreview.ok, false)
const beforeRows = (invoiceId) => seed.rows(`SELECT p.amount, p.destination, p.storeCreditId, m.kind, m.key
  FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId
  WHERE p.invoiceId=? AND p.voidedAt IS NULL ORDER BY p.id`, Number(invoiceId))
const attempt = async ({ source, replacementId, credit, rows, legacyAmount }) => salesService.createExchange({
  invoiceId: Number(source.sale.id), lines: [{ saleItemId: source.saleItemId, qty: 1 }],
  replacements: [line(replacementId, 180_000)], deltaStoreCreditCode: credit.code,
  ...(legacyAmount == null ? {} : { deltaStoreCreditAmount: legacyAmount }),
  payments: rows, methodId: null, userId, shiftId
})
const tender = (methodId, amount, destination) => ({ methodId, amount, destination })

// CASH: a 30,000-rial credit is less than an 80,000-rial difference; 50,000 cash is required.
const cashSource = await openSource(sourceVariant)
const cashCredit = await issue(30_000, 'cash credit')
const cashExchange = await attempt({ source: cashSource, replacementId: cashReplacementVariant, credit: cashCredit,
  rows: [tender(cashMethodId, 50_000, 'CASH')] })
assert.equal(cashExchange.settlement, 'CREDIT_TENDER')
assert.equal(Number(cashExchange.storeCreditApplied), 30_000)
assert.equal(Number(cashExchange.cashReceived), 50_000)
assert.equal(Number(cashExchange.cardReceived), 0)
const cashRows = beforeRows(cashExchange.exchangeInvoiceId)
assert.deepEqual(cashRows.map((row) => [row.kind, Number(row.amount), row.destination]), [
  ['EXCHANGE_CREDIT', 100_000, null], ['STORE_CREDIT', 30_000, null], ['CASH', 50_000, 'CASH']
])
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CardTransferRequest" WHERE returnId=?', Number(cashExchange.returnId)).n, 0)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(sourceVariant).stock), 10)
assert.equal(Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(cashReplacementVariant).stock), 9)
const today = toJalaliDate(new Date())
const report = await salesLedger.ledger({ fromJalali: today, toJalali: today, fullRange: true })
const cashExchangeReport = report.rows.find((row) => row.key === `EXP-${Number(cashExchange.returnId)}`)
assert.equal(cashExchangeReport.cashEffect, 50_000, 'blue/ledger cash effect includes only actual cash tender')
assert.match(cashExchangeReport.cashNote, /۳۰٬۰۰۰ ریال اعتبار بارکدی غیرنقدی/u)
assert.match(cashExchangeReport.cashNote, /۵۰٬۰۰۰ ریال دریافت واقعی/u)
assert.match(cashExchangeReport.cashNote, /جمع دقیق ۸۰٬۰۰۰ ریال/u)

// CARD: the actual remaining 60,000 is recorded only as a card receipt.
const cardSource = await openSource(cardSourceVariant)
const cardCredit = await issue(20_000, 'card credit')
const cardExchange = await attempt({ source: cardSource, replacementId: cardReplacementVariant, credit: cardCredit,
  rows: [tender(cardMethodId, 60_000, 'CARD')] })
assert.equal(cardExchange.settlement, 'CREDIT_TENDER')
assert.equal(Number(cardExchange.storeCreditApplied), 20_000)
assert.equal(Number(cardExchange.cashReceived), 0)
assert.equal(Number(cardExchange.cardReceived), 60_000)
assert.deepEqual(beforeRows(cardExchange.exchangeInvoiceId).map((row) => [row.kind, Number(row.amount), row.destination]), [
  ['EXCHANGE_CREDIT', 100_000, null], ['STORE_CREDIT', 20_000, null], ['CARD', 60_000, 'CARD']
])
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CardTransferRequest" WHERE returnId=?', Number(cardExchange.returnId)).n, 0)
const cardLedger = await salesLedger.ledger({ fromJalali: today, toJalali: today, fullRange: true })
const cardExchangeReport = cardLedger.rows.find((row) => row.key === `EXP-${Number(cardExchange.returnId)}`)
assert.equal(cardExchangeReport.cashEffect, 0, 'card tender does not inflate the blue drawer-cash number')
assert.match(cardExchangeReport.cashNote, /۲۰٬۰۰۰ ریال اعتبار بارکدی غیرنقدی/u)
assert.match(cardExchangeReport.cashNote, /۶۰٬۰۰۰ ریال دریافت واقعی/u)

// MIXED: an 80,000-rial difference less 10,000 credit is exactly 20,000 cash + 50,000 card.
const splitSource = await openSource(splitSourceVariant)
const splitCredit = await issue(10_000, 'split credit')
const splitExchange = await attempt({ source: splitSource, replacementId: splitReplacementVariant, credit: splitCredit,
  rows: [tender(cashMethodId, 20_000, 'CASH'), tender(cardMethodId, 50_000, 'CARD')] })
assert.equal(splitExchange.settlement, 'CREDIT_TENDER')
assert.equal(Number(splitExchange.storeCreditApplied), 10_000)
assert.equal(Number(splitExchange.cashReceived), 20_000)
assert.equal(Number(splitExchange.cardReceived), 50_000)
assert.deepEqual(beforeRows(splitExchange.exchangeInvoiceId).map((row) => [row.kind, Number(row.amount), row.destination]), [
  ['EXCHANGE_CREDIT', 100_000, null], ['STORE_CREDIT', 10_000, null],
  ['CASH', 20_000, 'CASH'], ['CARD', 50_000, 'CARD']
])
const splitLedger = await salesLedger.ledger({ fromJalali: today, toJalali: today, fullRange: true })
const splitExchangeReport = splitLedger.rows.find((row) => row.key === `EXP-${Number(splitExchange.returnId)}`)
assert.equal(splitExchangeReport.cashEffect, 20_000, 'mixed tender contributes only its cash share to blue cash')
assert.match(splitExchangeReport.cashNote, /۱۰٬۰۰۰ ریال اعتبار بارکدی غیرنقدی/u)
assert.match(splitExchangeReport.cashNote, /دریافت واقعی/u)

// Full coverage: no dummy cash/card row is created when the barcode covers the entire delta.
const fullyCoveredSource = await openSource(fullSourceVariant)
const fullCredit = await issue(80_000, 'fully covering credit')
const fullExchange = await attempt({ source: fullyCoveredSource, replacementId: fullReplacementVariant,
  credit: fullCredit, rows: [] })
assert.equal(fullExchange.settlement, 'CREDIT_TENDER')
assert.equal(Number(fullExchange.storeCreditApplied), 80_000)
assert.equal(Number(fullExchange.cashReceived), 0)
assert.equal(Number(fullExchange.cardReceived), 0)
assert.deepEqual(beforeRows(fullExchange.exchangeInvoiceId).map((row) => [row.kind, Number(row.amount), row.destination]), [
  ['EXCHANGE_CREDIT', 100_000, null], ['STORE_CREDIT', 80_000, null]
])
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CardTransferRequest" WHERE returnId=?', Number(fullExchange.returnId)).n, 0)

// Under/over tender and a forged former credit amount are rejected atomically.
const failedSource = await openSource(failSourceVariant)
const failedCredit = await issue(15_000, 'failed exactness credit')
const snapshot = (credit = failedCredit) => ({
  used: Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', Number(credit.id)).usedAmount),
  count: Number(seed.one('SELECT usedCount FROM "StoreCredit" WHERE id=?', Number(credit.id)).usedCount),
  returns: Number(seed.one('SELECT COUNT(*) AS n FROM "SaleReturn" WHERE invoiceId=?', Number(failedSource.sale.id)).n),
  exchanges: Number(seed.one('SELECT COUNT(*) AS n FROM "SaleInvoice" WHERE sourceInvoiceId=?', Number(failedSource.sale.id)).n),
  stock: Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(failReplacementVariant).stock)
})
const before = snapshot()
const beforeForged = snapshot(forgedCategoryCredit)
await assert.rejects(attempt({ source: failedSource, replacementId: failReplacementVariant, credit: forgedCategoryCredit,
  rows: [tender(cashMethodId, 80_000, 'CASH')] }), /هیچ‌کدام|قابل استفاده نیست/u)
assert.deepEqual(snapshot(forgedCategoryCredit), beforeForged,
  'server derives actual category ancestry instead of trusting a forged preview/category payload')
await assert.rejects(attempt({ source: failedSource, replacementId: failReplacementVariant, credit: failedCredit,
  rows: [tender(cashMethodId, 64_999, 'CASH')] }), /ماندهٔ محاسبه‌شده/u)
assert.deepEqual(snapshot(), before, 'underpayment leaves redemption, return, exchange, and inventory untouched')
await assert.rejects(attempt({ source: failedSource, replacementId: failReplacementVariant, credit: failedCredit,
  rows: [tender(cashMethodId, 65_001, 'CASH')] }), /ماندهٔ محاسبه‌شده/u)
assert.deepEqual(snapshot(), before, 'overpayment leaves all records unchanged')
await assert.rejects(attempt({ source: failedSource, replacementId: failReplacementVariant, credit: failedCredit,
  rows: [tender(cashMethodId, 65_000, 'CASH')], legacyAmount: 14_999 }), /مبلغ درخواستی/u)
assert.deepEqual(snapshot(), before, 'a legacy explicit credit value is only an equality assertion')
console.log('✓ exchange credit tender: cash/card/mixed exact settlement; credit segregated; under/over/stale amount fail atomically')
