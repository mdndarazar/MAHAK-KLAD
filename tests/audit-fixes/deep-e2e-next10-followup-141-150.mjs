/**
 * New batch N141-N150. Each process runs one isolated service-layer scenario
 * in a fresh temporary SQLite database; this file changes no production logic.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT10_FOLLOWUP_ID)
assert.ok(Number.isInteger(id) && id >= 141 && id <= 150, 'MAHAK_NEXT10_FOLLOWUP_ID must be 141..150')
const dir = mkdtempSync(join(tmpdir(), `mahak-followup-${id}-`))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const n = x => Number(x ?? 0)
const userId = seed.user(`N${id} isolated test cashier`)
const shiftId = seed.insert('Shift', { name: `N${id} isolated`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `NF-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `NF-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`N${id}-category`)
const variants = [], credits = [], events = [], assertions = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let variantSeq = 0
function variant(name, price, stock = 10) {
  const p = seed.product(`N${id}-${++variantSeq}-${name}`, category)
  const variantId = seed.variant(p, `NF-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }
  variants.push(v)
  return v
}
const line = (v, qty = 1, discount = 0) => ({ variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 })
async function issueCredit(amount, opts = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse: !!opts.multiUse, maxUses: opts.maxUses ?? 1,
    carryRemainder: true, days: opts.days ?? 30, restrictScope: opts.restrictScope ?? 'ALL',
    ...(opts.restrictVariantIds ? { restrictVariantIds: opts.restrictVariantIds } : {}),
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `N${id} isolated fixture` })
  const row = seed.one('SELECT id,code,amount,usedAmount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?', issued.id)
  const c = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse: !!opts.multiUse }
  credits.push(c)
  events.push({ operation: 'issue-test-credit', id: c.id, amount: c.amount, multiUse: c.multiUse, status: row.status, scope: row.restrictScope })
  return c
}
function rawPhysical() {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) card
    FROM "Payment" pay JOIN "PaymentMethod" m ON m.id=pay.methodId WHERE pay.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.amount), refundCard: n(r.amount) }
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const actual = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(actual, expected, `${label}: report vs independently expected financial totals`)
  const raw = rawPhysical()
  assert.deepEqual(raw, actual, `${label}: raw payments/refunds vs service report`)
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, blueExpected, `${label}: custody/blue total`)
  const stock = variants.map(v => {
    const onHand = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(onHand, v.expected, `${label}: ${v.name} on-hand stock`)
    assert.equal(onHand, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { name: v.name, expected: v.expected, actual: onHand, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const inv of invoices) {
    assert.equal(n(inv.grandTotal), n(inv.paidTotal), `${label}: invoice ${inv.id} settled value`)
    assert.ok(inv.settledAt != null, `${label}: invoice ${inv.id} settledAt`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no cheque tender`)
  const event = { label, expected: { ...expected, blue: blueExpected }, actual, raw, blue, stock,
    invoices: invoices.map(x => ({ id: n(x.id), total: n(x.grandTotal), paid: n(x.paidTotal), status: x.status,
      settled: !!x.settledAt, parent: x.sourceInvoiceId == null ? null : n(x.sourceInvoiceId) })),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: credits.map(c => {
      const x = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)
      return { id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), usedCount: n(x.usedCount), status: x.status,
        expiresAt: x.expiresAt == null ? null : n(x.expiresAt) }
    }), checks }
  events.push(event)
  return event
}
function mutationSnapshot() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptions: seed.count('StoreCreditRedemption', 'shiftId=?', shiftId),
    allocations: seed.count('CreditReturnAllocation', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    stock: variants.map(v => ({ id: v.id, onHand: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    credits: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id))
  }
}
async function snapshotForMutation() { return { ...mutationSnapshot(), blue: n(await physicalMovementForCustodyShift(shiftId)) } }
async function createSale(lines, { cash = 0, card = 0, storeCredits: creditsInput = [], key = `nf-${id}-sale-${events.length}` } = {}) {
  const payments = [
    ...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []),
    ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])
  ]
  const result = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines, payments, storeCredits: creditsInput, saleRequestIdempotencyKey: key })
  const row = seed.one('SELECT id,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', result.id)
  const gross = lines.reduce((s, x) => s + x.unitPrice * x.qty, 0)
  const discounts = lines.reduce((s, x) => s + x.discount, 0)
  assert.equal(n(row.grandTotal), gross - discounts, 'sale invoice gross and line discounts')
  assert.equal(n(row.paidTotal), n(row.grandTotal), 'sale fully settled; no debt sale')
  assert.ok(row.settledAt != null)
  expected.cash += cash; expected.card += card
  for (const l of lines) variants.find(v => v.id === l.variantId).expected -= l.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', result.id)
  const out = { id: n(result.id), total: n(row.grandTotal), creditApplied: n(result.storeCreditApplied), items }
  events.push({ operation: 'settled-sale', invoiceId: out.id, total: out.total, cash, card, creditApplied: out.creditApplied,
    items: items.map(i => ({ id: n(i.id), variantId: n(i.variantId), qty: n(i.qty), unitPrice: n(i.unitPrice), lineTotal: n(i.lineTotal) })) })
  await checkpoint(`sale ${out.id}`)
  return out
}
async function createReturn({ invoiceId, item, qty = 1, method = 'CASH', amount, cardOverride = false }) {
  const input = { userId, shiftId, invoiceId, full: false, lines: [{ saleItemId: n(item.id), qty }], refundMethod: method }
  if (amount != null) input.refundAmount = amount
  if (cardOverride) input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} isolated POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  const ret = await salesService.createReturn(input)
  if (method === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (method === 'CARD') expected.refundCard += n(ret.refundAmount)
  const v = variants.find(x => x.id === n(item.variantId))
  if (v) v.expected += qty
  events.push({ operation: 'return', returnId: n(ret.id), invoiceId, itemId: n(item.id), qty,
    returnTotal: n(ret.total), method: ret.refundMethod, refundAmount: n(ret.refundAmount), returnCreditAmount: n(ret.returnCreditAmount) })
  await checkpoint(`return ${ret.id}`)
  return ret
}
async function createExchange({ invoiceId, items, replacements, label }) {
  const lines = items.map(x => ({ saleItemId: n(x.id), qty: n(x.qty ?? 1) }))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements })
  assert.equal(preview.ok, true, `${label}: exchange preview should succeed: ${preview.error ?? ''}`)
  const operation = await salesService.createExchange({ userId, shiftId, invoiceId, lines, replacements,
    methodId: cashMethod, expectedSettlementDiff: n(preview.effectiveDiff), idempotencyKey: `nf-${id}-${label}-${events.length}` })
  assert.equal(n(operation.diff), n(preview.effectiveDiff), `${label}: committed settlement matches preview`)
  for (const item of items) variants.find(v => v.id === n(item.variantId)).expected += n(item.qty ?? 1)
  for (const r of replacements) variants.find(v => v.id === r.variantId).expected -= r.qty
  expected.cash += n(operation.cashReceived)
  expected.card += n(operation.cardReceived)
  expected.refundCash += n(operation.cashRefunded)
  expected.refundCard += n(operation.cardRefunded)
  events.push({ operation: 'exchange', label, sourceInvoiceId: invoiceId, returnId: n(operation.returnId),
    exchangeInvoiceId: n(operation.exchangeInvoiceId), sourceValue: n(operation.returnTotal), replacementValue: n(operation.exchangeTotal),
    diff: n(operation.diff), cashReceived: n(operation.cashReceived), cashRefunded: n(operation.cashRefunded),
    cardReceived: n(operation.cardReceived), cardRefunded: n(operation.cardRefunded), preview })
  await checkpoint(`exchange ${label}`)
  return operation
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, assertions }
try {
  if (id === 141) {
    const a = variant('three-unit-lot', 50_000)
    const root = await createSale([line(a, 3)], { cash: 150_000 })
    const item = root.items[0]
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 50_000 })
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 50_000 })
    const before = await snapshotForMutation()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(item.id), qty: 2 }], refundMethod: 'CASH', refundAmount: 100_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshotForMutation()
    assert.ok(error, 'returning two units when only one remains must be rejected')
    assert.deepEqual(after, before, 'rejected over-return must be mutation-free')
    events.push({ operation: 'oversized-third-return-rejected', requestedQty: 2, remainingQty: 1, error, mutationFree: true })
    assertions.push({ key: 'successive-partial-returns-and-over-return-block', pass: true, returnedQty: 2, remainingQty: 1, rejectedQty: 2 })
  } else if (id === 142) {
    const a = variant('POS-funded-two-unit-item', 100_000)
    const root = await createSale([line(a, 2)], { card: 200_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], qty: 1, method: 'CARD', amount: 100_000, cardOverride: true })
    assert.equal(n(ret.refundAmount), 100_000)
    assertions.push({ key: 'partial-POS-return-reconciles-card-and-blue', pass: true, cardSale: 200_000, cardRefund: 100_000, blue: expected.card - expected.refundCard })
  } else if (id === 143) {
    const a = variant('cash-source-for-credit-return', 100_000), b = variant('later-credit-redemption-item', 120_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const codeRow = seed.one('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(codeRow); assert.equal(n(codeRow.amount), 100_000); assert.equal(codeRow.expiresAt, null)
    const next = await createSale([line(b)], { cash: 20_000, storeCredits: [{ code: codeRow.code, requestedAmount: 100_000 }] })
    assert.equal(n(next.creditApplied), 100_000)
    assertions.push({ key: 'selected-return-credit-issued-and-redeemed', pass: true, returnedCredit: n(codeRow.amount), laterApplied: n(next.creditApplied), cashIn: expected.cash, refundsCash: expected.refundCash })
  } else if (id === 144) {
    const a = variant('single-return-only-item', 60_000)
    const root = await createSale([line(a)], { cash: 60_000 })
    const item = root.items[0]
    await createReturn({ invoiceId: root.id, item, method: 'CASH', amount: 60_000 })
    const before = await snapshotForMutation()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 60_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshotForMutation()
    assert.ok(error, 'fully returned item must not be returned twice')
    assert.deepEqual(after, before, 'duplicate full return must leave money, stock, and ledgers unchanged')
    events.push({ operation: 'duplicate-full-return-rejected', error, mutationFree: true })
    assertions.push({ key: 'full-return-is-one-time-and-duplicate-is-mutation-free', pass: true })
  } else if (id === 145) {
    const a = variant('chain-root-item', 100_000), b = variant('chain-child-one', 120_000), c = variant('chain-child-two', 130_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const first = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'root-to-child-1' })
    const childItems = seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
    const second = await createExchange({ invoiceId: n(first.exchangeInvoiceId), items: childItems, replacements: [line(c)], label: 'child-1-to-child-2' })
    const childRow = seed.one('SELECT sourceInvoiceId,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?', second.exchangeInvoiceId)
    assert.equal(n(childRow.sourceInvoiceId), n(first.exchangeInvoiceId))
    assert.equal(n(first.diff), 20_000); assert.equal(n(second.diff), 10_000)
    assertions.push({ key: 'two-generation-exchange-lineage-and-differences', pass: true, firstDiff: n(first.diff), secondDiff: n(second.diff), childParent: n(childRow.sourceInvoiceId), finalInvoice: n(second.exchangeInvoiceId) })
  } else if (id === 146) {
    const a = variant('two-original-units', 100_000), b = variant('one-bundle-replacement', 200_000)
    const root = await createSale([line(a, 2)], { cash: 200_000 })
    const ex = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'two-units-to-one-bundle' })
    assert.equal(n(ex.diff), 0)
    assertions.push({ key: 'quantity-conserving-two-for-one-equal-value-exchange', pass: true, returnedQty: 2, replacementQty: 1, returnedValue: n(ex.returnTotal), replacementValue: n(ex.exchangeTotal), diff: n(ex.diff) })
  } else if (id === 147) {
    const source = variant('expired-code-exchange-source', 100_000), replacement = variant('expired-code-exchange-target', 120_000)
    const c = await issueCredit(50_000)
    const root = await createSale([line(source)], { cash: 100_000 })
    const expiredAt = Date.now() - 86_400_000
    sql.prepare('UPDATE "StoreCredit" SET expiresAt=?,updatedAt=? WHERE id=?').run(expiredAt, Date.now(), c.id)
    const before = await snapshotForMutation()
    let outcome, error = ''
    try { outcome = await salesService.createExchange({ userId, shiftId, invoiceId: root.id,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], replacements: [line(replacement)],
      exchangeCreditCode: c.code, expectedSettlementDiff: 20_000, idempotencyKey: `nf-${id}-expired-exchange` }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshotForMutation()
    const rejected = !!error || outcome?.ok === false
    assert.equal(rejected, true, 'expired barcode must not settle an exchange difference')
    assert.deepEqual(after, before, 'expired-code exchange rejection must be mutation-free')
    events.push({ operation: 'expired-credit-exchange-tender-rejected', code: c.code, expiresAt: expiredAt, error: error || outcome?.error || null, mutationFree: true })
    const cashRetry = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(replacement)], label: 'cash-after-expired-code-rejection' })
    assert.equal(n(cashRetry.diff), 20_000)
    assertions.push({ key: 'expired-code-rejected-in-exchange-then-cash-succeeds', pass: true, mutationFree: true, cashDifference: n(cashRetry.cashReceived) })
  } else if (id === 148) {
    const eligible = variant('eligible-restricted-SKU', 100_000), source = variant('ineligible-restricted-exchange-source', 100_000), replacement = variant('restricted-exchange-target', 120_000)
    const c = await issueCredit(50_000, { restrictScope: 'VARIANTS', restrictVariantIds: [eligible.id] })
    const root = await createSale([line(source)], { cash: 100_000 })
    const before = await snapshotForMutation()
    let outcome, error = ''
    try { outcome = await salesService.createExchange({ userId, shiftId, invoiceId: root.id,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], replacements: [line(replacement)],
      exchangeCreditCode: c.code, expectedSettlementDiff: 20_000, idempotencyKey: `nf-${id}-wrong-scope-exchange` }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshotForMutation()
    const rejected = !!error || outcome?.ok === false
    assert.equal(rejected, true, 'variant-restricted barcode must not settle an exchange for an ineligible source')
    assert.deepEqual(after, before, 'restricted-code exchange rejection must be mutation-free')
    events.push({ operation: 'wrong-scope-credit-exchange-tender-rejected', code: c.code, eligibleVariant: eligible.id,
      attemptedSourceVariant: source.id, error: error || outcome?.error || null, mutationFree: true })
    const cashRetry = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(replacement)], label: 'cash-after-scope-rejection' })
    assert.equal(n(cashRetry.diff), 20_000)
    assertions.push({ key: 'wrong-scope-code-rejected-in-exchange-then-cash-succeeds', pass: true, mutationFree: true, cashDifference: n(cashRetry.cashReceived) })
  } else if (id === 149) {
    const a = variant('card-to-card-return-item', 100_000)
    const root = await createSale([line(a)], { card: 100_000 })
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 100_000 })
    const returnStock = seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', ret.id)
    const returnItemStock = seed.one('SELECT qty,restockedQty FROM "SaleReturnItem" WHERE returnId=?', ret.id)
    const transfer = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', ret.id)
    assert.ok(transfer); assert.equal(transfer.status, 'PENDING'); assert.equal(n(transfer.amount), 100_000)
    events.push({ operation: 'card-to-card-refund-request-pending', returnId: n(ret.id), requestId: n(transfer.id), status: transfer.status,
      amount: n(transfer.amount), blueBeforePayout: n(await physicalMovementForCustodyShift(shiftId)), restockPending: returnStock.restockPending,
      returnedQty: n(returnItemStock.qty), restockedQty: n(returnItemStock.restockedQty) })
    await checkpoint('C2C request recorded but not yet a physical POS/cash reversal')
    await cardTransferService.pay({ id: n(transfer.id), paidAmount: 100_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `NF-${id}-PAID` })
    const paid = seed.one('SELECT status,paidAmount,trackingNo FROM "CardTransferRequest" WHERE id=?', transfer.id)
    assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), 100_000)
    variants.find(v => v.id === a.id).expected += 1
    const stockAfterPayout = seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', ret.id)
    assert.equal(n(stockAfterPayout.restockedQty), 1, 'inventory restock is finalized after the C2C payout completes')
    await checkpoint('C2C paid; deferred return restock and settlement ledgers reconcile')
    assertions.push({ key: 'C2C-pending-to-paid-finalizes-deferred-restock', pass: true, pendingAmount: n(transfer.amount), paidAmount: n(paid.paidAmount),
      restockPendingBeforePayment: returnStock.restockPending, restockedQtyAfterPayment: n(stockAfterPayout.restockedQty), trackingNo: paid.trackingNo })
  } else if (id === 150) {
    const a = variant('already-exchanged-source', 100_000), b = variant('exchange-child-item', 100_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const ex = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'consume-source-before-return-attempt' })
    assert.equal(n(ex.diff), 0)
    const before = await snapshotForMutation()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CASH', refundAmount: 100_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshotForMutation()
    assert.ok(error, 'item consumed by an official exchange must not be returned again from its source invoice')
    assert.deepEqual(after, before, 'post-exchange duplicate return must be mutation-free')
    events.push({ operation: 'return-of-exchanged-source-rejected', exchangeReturnId: n(ex.returnId), sourceInvoiceId: root.id, error, mutationFree: true })
    assertions.push({ key: 'exchange-consumed-source-cannot-be-returned-again', pass: true, mutationFree: true })
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
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-141-150')
  mkdirSync(out, { recursive: true })
  const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی جدید N${id}`, '', `**وضعیت:** ${result.status}`, `**SQLite ایزوله:** ${process.env.HARNESS_DB}`, '',
    '## Trace و تطبیق‌ها', ...events.map(e => `- ${e.operation ?? e.label}: ${JSON.stringify(e)}`),
    ...assertions.map(a => `- assertion ${a.key}: ${a.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(a)}`), '', '## جمع‌بندی مالی و موجودی',
    `- موردانتظار: ${JSON.stringify(result.final.expected)}`, `- واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر انبار: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- خطا: ${JSON.stringify(result.failure ?? null)}`, '', 'مسیر service-layer و SQLite موقت؛ بدون اتصال به دیتابیس واقعی یا staging.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
