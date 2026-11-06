/**
 * New batch N161-N170. One isolated SQLite database per scenario process.
 * Fully settled service-layer scenarios only; no production behavior changed.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT10_FOLLOWUP_ID)
assert.ok(Number.isInteger(id) && id >= 161 && id <= 170, 'MAHAK_NEXT10_FOLLOWUP_ID must be 161..170')
const dir = mkdtempSync(join(tmpdir(), `mahak-followup-${id}-`))
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
const n = x => Number(x ?? 0)
const userId = seed.user(`N${id} isolated cashier`)
const shiftId = seed.insert('Shift', { name: `N${id} isolated test shift`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `NF3-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `NF3-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`N${id}-category`)
const variants = [], credits = [], events = [], assertions = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let variantSeq = 0
function variant(name, price, stock = 10) {
  const productId = seed.product(`N${id}-${++variantSeq}-${name}`, category)
  const variantId = seed.variant(productId, `NF3-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }
  variants.push(v)
  return v
}
const line = (v, qty = 1, discount = 0) => ({ variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 })
async function issueCredit(amount, { multiUse = false, maxUses = 1 } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse, maxUses, carryRemainder: true, days: 30,
    restrictScope: 'ALL', userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `N${id} isolated fixture` })
  const row = seed.one('SELECT id,code,amount,status FROM "StoreCredit" WHERE id=?', issued.id)
  const credit = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse }
  credits.push(credit)
  events.push({ operation: 'issue-test-credit', id: credit.id, amount: credit.amount, status: row.status, multiUse })
  return credit
}
function rawPhysical() {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) card
    FROM "Payment" pay JOIN "PaymentMethod" m ON m.id=pay.methodId WHERE pay.createdShiftId=?`, shiftId)
  const cf = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const cr = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(cf.amount), refundCard: n(cr.amount) }
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const actual = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(actual, expected, `${label}: report equals expected cash/POS flows`)
  const raw = rawPhysical()
  assert.deepEqual(raw, actual, `${label}: raw documents equal service report`)
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, blueExpected, `${label}: blue/custody movement`)
  const stock = variants.map(v => {
    const actualStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actualStock, v.expected, `${label}: ${v.name} stock`)
    assert.equal(actualStock, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { name: v.name, expected: v.expected, actual: actualStock, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const invoice of invoices) {
    assert.equal(n(invoice.paidTotal), n(invoice.grandTotal), `${label}: invoice ${invoice.id} must be fully settled`)
    assert.ok(invoice.settledAt != null, `${label}: invoice ${invoice.id} settledAt`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no cheque tender`)
  const event = { label, expected: { ...expected, blue: blueExpected }, actual, raw, blue, stock,
    invoices: invoices.map(x => ({ id: n(x.id), total: n(x.grandTotal), paid: n(x.paidTotal), status: x.status,
      settled: !!x.settledAt, parent: x.sourceInvoiceId == null ? null : n(x.sourceInvoiceId) })),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId), checks,
    creditStates: credits.map(c => {
      const x = seed.one('SELECT id,code,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id)
      return { id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), usedCount: n(x.usedCount), status: x.status }
    }) }
  events.push(event)
  return event
}
function stateSnapshot() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptions: seed.count('StoreCreditRedemption', 'shiftId=?', shiftId),
    allocations: seed.count('CreditReturnAllocation', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    stock: variants.map(v => ({ id: v.id, onHand: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    creditStates: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)),
    blue: null
  }
}
async function snapshot() { const s = stateSnapshot(); s.blue = n(await physicalMovementForCustodyShift(shiftId)); return s }
async function createSale(lines, { cash = 0, card = 0, storeCredits = [], key = `nf3-${id}-sale-${events.length}` } = {}) {
  const payments = [
    ...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []),
    ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])
  ]
  const sale = await salesService.create({ userId, shiftId, lines, payments, storeCredits, saleRequestIdempotencyKey: key })
  const row = seed.one('SELECT id,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  const gross = lines.reduce((sum, item) => sum + item.unitPrice * item.qty, 0)
  const discounts = lines.reduce((sum, item) => sum + item.discount, 0)
  assert.equal(n(row.grandTotal), gross - discounts)
  assert.equal(n(row.paidTotal), n(row.grandTotal), 'fixture sale must be fully settled')
  assert.ok(row.settledAt != null)
  expected.cash += cash; expected.card += card
  for (const item of lines) variants.find(v => v.id === item.variantId).expected -= item.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
  const out = { id: n(row.id), total: n(row.grandTotal), creditApplied: n(sale.storeCreditApplied), items }
  events.push({ operation: 'fully-settled-sale', invoiceId: out.id, total: out.total, cash, card, creditApplied: out.creditApplied,
    items: items.map(i => ({ id: n(i.id), variantId: n(i.variantId), qty: n(i.qty), unitPrice: n(i.unitPrice), lineTotal: n(i.lineTotal) })) })
  await checkpoint(`sale ${out.id}`)
  return out
}
async function createReturn({ invoiceId, item, qty = 1, method = 'CASH', amount, cardPassword }) {
  const input = { userId, shiftId, invoiceId, full: false, lines: [{ saleItemId: n(item.id), qty }], refundMethod: method }
  if (amount != null) input.refundAmount = amount
  if (method === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} isolated POS refund`, managerPassword: cardPassword ?? DEFAULT_MANAGER_PASSWORD }
  const ret = await salesService.createReturn(input)
  if (method === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (method === 'CARD') expected.refundCard += n(ret.refundAmount)
  const v = variants.find(x => x.id === n(item.variantId)); if (v) v.expected += qty
  events.push({ operation: 'return', id: n(ret.id), invoiceId, itemId: n(item.id), qty, total: n(ret.total),
    method: ret.refundMethod, refundAmount: n(ret.refundAmount), returnCreditAmount: n(ret.returnCreditAmount) })
  await checkpoint(`return ${ret.id}`)
  return ret
}
async function createExchange({ invoiceId, items, replacements, label, mode = 'CASH', creditCode = null, requestedAmount = null }) {
  const lines = items.map(x => ({ saleItemId: n(x.id), qty: n(x.qty ?? 1) }))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements })
  assert.equal(preview.ok, true, `${label}: preview must be available: ${preview.error ?? ''}`)
  const input = { userId, shiftId, invoiceId, lines, replacements, expectedSettlementDiff: n(preview.effectiveDiff),
    idempotencyKey: `nf3-${id}-${label}-${events.length}` }
  if (creditCode) input.exchangeCreditCode = creditCode
  if (mode === 'CASH') { input.methodId = cashMethod; if (n(preview.effectiveDiff) < 0) input.refundMode = 'CASH' }
  if (mode === 'CARD') {
    if (n(preview.effectiveDiff) > 0) input.methodId = cardMethod
    else {
      input.refundMode = 'CARD'; input.refundAmount = requestedAmount
      input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} POS exchange refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    }
  }
  if (mode === 'STORE_CREDIT') input.refundMode = 'STORE_CREDIT'
  const op = await salesService.createExchange(input)
  assert.equal(n(op.diff), n(preview.effectiveDiff), `${label}: preview and commit difference`)
  for (const item of items) variants.find(v => v.id === n(item.variantId)).expected += n(item.qty ?? 1)
  for (const replacement of replacements) variants.find(v => v.id === replacement.variantId).expected -= replacement.qty
  expected.cash += n(op.cashReceived); expected.card += n(op.cardReceived)
  expected.refundCash += n(op.cashRefunded); expected.refundCard += n(op.cardRefunded)
  events.push({ operation: 'exchange', label, sourceInvoiceId: invoiceId, returnId: n(op.returnId), exchangeInvoiceId: n(op.exchangeInvoiceId),
    returnTotal: n(op.returnTotal), exchangeTotal: n(op.exchangeTotal), diff: n(op.diff), cashReceived: n(op.cashReceived),
    cardReceived: n(op.cardReceived), cashRefunded: n(op.cashRefunded), cardRefunded: n(op.cardRefunded),
    exchangeCreditApplied: n(op.exchangeCreditApplied), barcodeCreditApplied: n(op.barcodeCreditApplied), newStoreCreditAmount: n(op.newStoreCreditAmount), preview })
  await checkpoint(`exchange ${label}`)
  return op
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, assertions }
try {
  if (id === 161) {
    const a = variant('same-key-original-item', 100_000), b = variant('same-key-alternate-item', 100_000)
    const key = `nf3-${id}-payload-bound-key`
    const first = await createSale([line(a)], { cash: 100_000, key })
    const before = await snapshot()
    let error = ''
    try { await salesService.create({ userId, shiftId, lines: [line(b)], payments: [{ methodId: cashMethod, amount: 100_000, destination: 'CASH' }], saleRequestIdempotencyKey: key }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'same idempotency key with a changed business payload must be rejected')
    assert.deepEqual(after, before, 'conflicting idempotency retry must not create a second sale or charge')
    events.push({ operation: 'changed-payload-sale-retry-rejected', originalInvoiceId: first.id, key, error, mutationFree: true })
    assertions.push({ key: 'sale-idempotency-key-bound-to-original-payload', pass: true, invoiceCount: after.invoices, mutationFree: true })
  } else if (id === 162) {
    const a = variant('return-source-invoice-A', 50_000), b = variant('other-invoice-item-B', 60_000)
    const first = await createSale([line(a)], { cash: 50_000 })
    const second = await createSale([line(b)], { cash: 60_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: first.id, full: false,
      lines: [{ saleItemId: n(second.items[0].id), qty: 1 }], refundMethod: 'CASH', refundAmount: 60_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'a sale item from another invoice must not be returned against this invoice')
    assert.deepEqual(after, before, 'cross-invoice return rejection must be mutation-free')
    events.push({ operation: 'cross-invoice-return-rejected', invoiceId: first.id, submittedSaleItemId: n(second.items[0].id), error, mutationFree: true })
    const ret = await createReturn({ invoiceId: first.id, item: first.items[0], amount: 50_000 })
    assertions.push({ key: 'return-invoice-ownership-validated-then-correct-return-works', pass: true, rejectedForeignItem: true, correctReturn: n(ret.total) })
  } else if (id === 163) {
    const a = variant('card-funded-exchange-source', 120_000), b = variant('card-refund-exchange-target', 100_000)
    const root = await createSale([line(a)], { card: 120_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'negative-difference-refunded-to-card', mode: 'CARD' })
    assert.equal(n(op.diff), -20_000); assert.equal(n(op.cardRefunded), 20_000); assert.equal(n(op.cashRefunded), 0)
    assertions.push({ key: 'negative-exchange-difference-card-refund-classified-as-POS', pass: true, diff: n(op.diff), cardRefund: n(op.cardRefunded), cashRefund: n(op.cashRefunded) })
  } else if (id === 164) {
    const a = variant('partial-source-credit-item', 100_000), b = variant('positive-difference-replacement', 130_000), cItem = variant('later-small-purchase', 40_000)
    const c = await issueCredit(100_000, { multiUse: true, maxUses: 6 })
    const root = await createSale([line(a)], { cash: 50_000, storeCredits: [{ code: c.code, requestedAmount: 50_000 }] })
    assert.equal(root.creditApplied, 50_000)
    const beforeExchange = seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', c.id)
    assert.equal(n(beforeExchange.usedAmount), 50_000)
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'source-barcode-pays-part-of-positive-difference',
      mode: 'CASH', creditCode: c.code })
    assert.equal(n(op.diff), 30_000); assert.equal(n(op.barcodeCreditApplied), 30_000); assert.equal(n(op.cashReceived), 0)
    const afterExchange = seed.one('SELECT amount,usedAmount,status FROM "StoreCredit" WHERE id=?', c.id)
    assert.equal(n(afterExchange.usedAmount), 80_000); assert.equal(afterExchange.status, 'PARTIALLY_USED')
    const later = await createSale([line(cItem)], { cash: 20_000, storeCredits: [{ code: c.code, requestedAmount: 20_000 }] })
    assert.equal(later.creditApplied, 20_000)
    const finalCredit = seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', c.id)
    assert.equal(n(finalCredit.usedAmount), 100_000); assert.equal(finalCredit.status, 'USED')
    assertions.push({ key: 'multi-use-code-spent-partially-in-sale-exchange-and-later-settled-sale', pass: true,
      sequence: [50_000, 30_000, 20_000], totalSpent: n(finalCredit.usedAmount), laterApplied: later.creditApplied })
  } else if (id === 165) {
    const a = variant('unused-return-credit-item', 80_000)
    const root = await createSale([line(a)], { cash: 80_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const issued = seed.one('SELECT id,code,amount,status,usedAmount FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(issued); assert.equal(n(issued.amount), 80_000); assert.equal(n(issued.usedAmount), 0)
    const voidResult = await salesService.returnDelete({ id: n(ret.id), userId, reason: 'N165 ابطال اعتبار برگشتی مصرف‌نشده', panelPassword: DEFAULT_MANAGER_PASSWORD })
    const voided = seed.one('SELECT voidedAt,voidReason FROM "SaleReturn" WHERE id=?', ret.id)
    const canceled = seed.one('SELECT status,usedAmount FROM "StoreCredit" WHERE id=?', issued.id)
    a.expected -= 1
    assert.ok(voidResult.voided); assert.ok(voided.voidedAt); assert.equal(canceled.status, 'CANCELED'); assert.equal(n(canceled.usedAmount), 0)
    events.push({ operation: 'void-unused-store-credit-return', returnId: n(ret.id), voided: !!voidResult.voided,
      creditId: n(issued.id), creditStatusAfter: canceled.status, reason: voided.voidReason })
    await checkpoint('void unused voucher return; source sale remains paid, credit canceled, stock reversal reconciles')
    assertions.push({ key: 'void-unused-return-credit-cancels-voucher-and-reverses-restock', pass: true,
      returnVoided: !!voided.voidedAt, creditCanceled: canceled.status === 'CANCELED', stockRestoredToPreReturn: a.expected === 9 })
  } else if (id === 166) {
    const a = variant('three-item-source-A', 50_000), b = variant('three-item-source-B', 60_000), c = variant('three-item-source-C', 90_000), replacement = variant('one-item-replacement', 200_000)
    const root = await createSale([line(a), line(b), line(c)], { cash: 200_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(replacement)], label: 'three-source-lines-to-one-equal-value-replacement' })
    assert.equal(n(op.returnTotal), 200_000); assert.equal(n(op.exchangeTotal), 200_000); assert.equal(n(op.diff), 0)
    assertions.push({ key: 'three-to-one-multi-line-equal-value-exchange', pass: true, sourceLines: 3, sourceValue: n(op.returnTotal), replacementLines: 1, replacementValue: n(op.exchangeTotal), diff: n(op.diff) })
  } else if (id === 167) {
    const a = variant('fractional-return-quantity-item', 40_000)
    const root = await createSale([line(a, 2)], { cash: 80_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1.5 }], refundMethod: 'CASH', refundAmount: 60_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'fractional units must not be returned')
    assert.deepEqual(after, before, 'fractional return validation must be mutation-free')
    events.push({ operation: 'fractional-quantity-return-rejected', attemptedQty: 1.5, error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], qty: 1, amount: 40_000 })
    assert.equal(n(ret.total), 40_000)
    assertions.push({ key: 'fractional-return-rejected-then-integer-unit-return-succeeds', pass: true, rejectedQty: 1.5, acceptedQty: 1 })
  } else if (id === 168) {
    const a = variant('stale-preview-source', 100_000), b = variant('stale-preview-target', 120_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createExchange({ userId, shiftId, invoiceId: root.id,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], replacements: [line(b)], methodId: cashMethod,
      expectedSettlementDiff: 19_999, idempotencyKey: `nf3-${id}-stale-preview` }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'stale client preview amount must be rejected')
    assert.deepEqual(after, before, 'stale-diff rejection must roll back return, replacement, payment, stock, and custody')
    events.push({ operation: 'stale-exchange-preview-rejected', expectedDiff: 19_999, actualPreviewDiff: 20_000, error, mutationFree: true })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'fresh-preview-cash-retry' })
    assert.equal(n(op.diff), 20_000)
    assertions.push({ key: 'stale-preview-rolled-back-then-fresh-preview-succeeds', pass: true, rejectedMutationFree: true, committedDiff: n(op.diff) })
  } else if (id === 169) {
    const a = variant('refund-over-request-item', 80_000)
    const root = await createSale([line(a)], { cash: 80_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CASH', refundAmount: 100_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'requested cash refund above official selected-item value must be rejected')
    assert.deepEqual(after, before, 'over-cap request must not write return, refund, or stock movement')
    events.push({ operation: 'refund-above-return-value-rejected', officialItemValue: 80_000, requested: 100_000, error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], amount: 80_000 })
    assert.equal(n(ret.refundAmount), 80_000)
    assertions.push({ key: 'over-cap-refund-rejected-then-official-amount-succeeds', pass: true, rejectedRequest: 100_000, acceptedRefund: n(ret.refundAmount) })
  } else if (id === 170) {
    const a = variant('return-credit-source-item', 50_000), b = variant('return-credit-redemption-item', 50_000)
    const root = await createSale([line(a)], { cash: 50_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const issued = seed.one('SELECT id,code,amount,status FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(issued); assert.equal(n(issued.amount), 50_000)
    const redemption = await createSale([line(b)], { storeCredits: [{ code: issued.code, requestedAmount: 50_000 }] })
    assert.equal(redemption.creditApplied, 50_000)
    const beforeVoid = await snapshot()
    let error = ''
    try { await salesService.returnDelete({ id: n(ret.id), userId, reason: 'N170 ابطال اعتبار مصرف‌شده', panelPassword: DEFAULT_MANAGER_PASSWORD }) }
    catch (e) { error = String(e?.message ?? e) }
    const afterVoid = await snapshot()
    assert.ok(error, 'a return whose issued credit was spent must not be voided')
    assert.deepEqual(afterVoid, beforeVoid, 'rejected void must preserve the spent credit, return, stock, and settlement')
    const creditAfter = seed.one('SELECT usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', issued.id)
    assert.equal(creditAfter.status, 'USED'); assert.equal(n(creditAfter.usedAmount), 50_000)
    events.push({ operation: 'void-spent-return-credit-rejected', returnId: n(ret.id), creditId: n(issued.id), error, mutationFree: true })
    assertions.push({ key: 'void-of-return-with-spent-credit-rejected-without-mutation', pass: true, creditStatus: creditAfter.status, mutationFree: true })
  }
  await checkpoint(`final N${id} reconciliation`)
  result.status = 'PASS'
} catch (e) {
  result.status = 'FAIL'
  result.failure = { message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
} finally {
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard },
    actual: rawPhysical(), blue: n(await physicalMovementForCustodyShift(shiftId)),
    stock: variants.map(v => ({ name: v.name, expected: v.expected, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'),
    checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-161-170')
  mkdirSync(out, { recursive: true })
  const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی جدید N${id}`, '', `**وضعیت:** ${result.status}`, `**SQLite ایزوله:** ${process.env.HARNESS_DB}`, '',
    '## Trace', ...events.map(e => `- ${e.operation ?? e.label}: ${JSON.stringify(e)}`),
    ...assertions.map(a => `- ${a.key}: ${a.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(a)}`), '', '## تطبیق نهایی',
    `- موردانتظار: ${JSON.stringify(result.final.expected)}`, `- واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر انبار: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- شکست: ${JSON.stringify(result.failure ?? null)}`, '', 'فقط service-layer و SQLite موقت استفاده شد؛ دیتابیس واقعی و staging درگیر نشدند.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
