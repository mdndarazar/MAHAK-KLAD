/**
 * New batch N151-N160. One isolated temporary SQLite DB per scenario process.
 * Service-layer tests only; never use real/staging data or add production logic.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT10_FOLLOWUP_ID)
assert.ok(Number.isInteger(id) && id >= 151 && id <= 160, 'MAHAK_NEXT10_FOLLOWUP_ID must be 151..160')
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
const userId = seed.user(`N${id} isolated cashier`)
const shiftId = seed.insert('Shift', { name: `N${id} isolated test shift`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `NF2-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `NF2-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`N${id}-category`)
const variants = [], credits = [], events = [], assertions = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let variantSeq = 0
function variant(name, price, stock = 10) {
  const productId = seed.product(`N${id}-${++variantSeq}-${name}`, category)
  const variantId = seed.variant(productId, `NF2-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }
  variants.push(v)
  return v
}
const line = (v, qty = 1, discount = 0) => ({ variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 })
async function issueCredit(amount, { multiUse = false, maxUses = 1 } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse, maxUses, carryRemainder: true, days: 30,
    restrictScope: 'ALL', userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `N${id} test fixture` })
  const row = seed.one('SELECT id,code,amount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
  const credit = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse }
  credits.push(credit)
  events.push({ operation: 'issue-test-credit', id: credit.id, amount: credit.amount, multiUse, status: row.status })
  return credit
}
function rawPhysical() {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) card
    FROM "Payment" pay JOIN "PaymentMethod" m ON m.id=pay.methodId WHERE pay.createdShiftId=?`, shiftId)
  const cashRefund = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const cardRefund = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(cashRefund.amount), refundCard: n(cardRefund.amount) }
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const actual = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(actual, expected, `${label}: report equals expected tender and refund totals`)
  const raw = rawPhysical()
  assert.deepEqual(raw, actual, `${label}: raw money entries equal report`)
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, blueExpected, `${label}: blue/custody amount`)
  const stock = variants.map(v => {
    const actualStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actualStock, v.expected, `${label}: ${v.name} physical stock`)
    assert.equal(actualStock, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { name: v.name, expected: v.expected, actual: actualStock, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const inv of invoices) {
    assert.equal(n(inv.grandTotal), n(inv.paidTotal), `${label}: no underpaid invoice ${inv.id}`)
    assert.ok(inv.settledAt != null, `${label}: invoice ${inv.id} fully settled`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no cheque used`)
  const ev = { label, expected: { ...expected, blue: blueExpected }, actual, raw, blue, stock,
    invoices: invoices.map(i => ({ id: n(i.id), total: n(i.grandTotal), paid: n(i.paidTotal), status: i.status,
      settled: !!i.settledAt, parent: i.sourceInvoiceId == null ? null : n(i.sourceInvoiceId) })),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId), checks }
  events.push(ev)
  return ev
}
function stateSnapshot() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptions: seed.count('StoreCreditRedemption', 'shiftId=?', shiftId),
    returnAllocations: seed.count('CreditReturnAllocation', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    stock: variants.map(v => ({ id: v.id, onHand: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    credits: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)),
    blue: null
  }
}
async function snapshot() { const s = stateSnapshot(); s.blue = n(await physicalMovementForCustodyShift(shiftId)); return s }
async function createSale(lines, { cash = 0, card = 0, storeCredits = [], key = `nf2-${id}-sale-${events.length}` } = {}) {
  const payments = [
    ...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []),
    ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])
  ]
  const result = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines, payments, storeCredits, saleRequestIdempotencyKey: key })
  const invoice = seed.one('SELECT id,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', result.id)
  const gross = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0)
  const discount = lines.reduce((sum, l) => sum + l.discount, 0)
  assert.equal(n(invoice.grandTotal), gross - discount)
  assert.equal(n(invoice.paidTotal), n(invoice.grandTotal), 'all sale scenarios must settle fully; no debt sale')
  assert.ok(invoice.settledAt != null)
  expected.cash += cash; expected.card += card
  for (const item of lines) variants.find(v => v.id === item.variantId).expected -= item.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', result.id)
  const sale = { id: n(invoice.id), total: n(invoice.grandTotal), creditApplied: n(result.storeCreditApplied), items }
  events.push({ operation: 'fully-settled-sale', invoiceId: sale.id, total: sale.total, cash, card, creditApplied: sale.creditApplied,
    items: items.map(x => ({ id: n(x.id), variantId: n(x.variantId), qty: n(x.qty), unitPrice: n(x.unitPrice), lineTotal: n(x.lineTotal) })) })
  await checkpoint(`sale ${sale.id}`)
  return sale
}
async function createReturn({ invoiceId, item, qty = 1, method = 'CASH', amount, posPassword, posReason }) {
  const input = { userId, shiftId, invoiceId, full: false, lines: [{ saleItemId: n(item.id), qty }], refundMethod: method }
  if (amount != null) input.refundAmount = amount
  if (method === 'CARD' && posReason) input.cardPosOverride = { acknowledgedNoReverse: true, reason: posReason, managerPassword: posPassword }
  const ret = await salesService.createReturn(input)
  if (method === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (method === 'CARD') expected.refundCard += n(ret.refundAmount)
  const v = variants.find(x => x.id === n(item.variantId)); if (v) v.expected += qty
  events.push({ operation: 'return', id: n(ret.id), invoiceId, itemId: n(item.id), qty, total: n(ret.total), method: ret.refundMethod, refundAmount: n(ret.refundAmount) })
  await checkpoint(`return ${ret.id}`)
  return ret
}
async function createExchange({ invoiceId, items, replacements, label, mode = 'CASH', splitPayments = null, creditCode = null }) {
  const lines = items.map(x => ({ saleItemId: n(x.id), qty: n(x.qty ?? 1) }))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements })
  assert.equal(preview.ok, true, `${label}: preview failed: ${preview.error ?? ''}`)
  const input = { userId, shiftId, invoiceId, lines, replacements, expectedSettlementDiff: n(preview.effectiveDiff),
    idempotencyKey: `nf2-${id}-${label}-${events.length}` }
  if (mode === 'CASH') { input.methodId = cashMethod; if (n(preview.effectiveDiff) < 0) input.refundMode = 'CASH' }
  if (mode === 'CARD') {
    if (n(preview.effectiveDiff) > 0) input.methodId = cardMethod
    else {
      input.refundMode = 'CARD'
      input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} POS exchange refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    }
  }
  if (mode === 'STORE_CREDIT') input.refundMode = 'STORE_CREDIT'
  if (mode === 'SPLIT') { input.splitPayment = true; input.payments = splitPayments }
  if (creditCode) input.exchangeCreditCode = creditCode
  if (mode === 'CARD' && n(preview.effectiveDiff) < 0)
    input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} POS exchange refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  const op = await salesService.createExchange(input)
  assert.equal(n(op.diff), n(preview.effectiveDiff), `${label}: operation and preview differ`)
  for (const item of items) variants.find(v => v.id === n(item.variantId)).expected += n(item.qty ?? 1)
  for (const repl of replacements) variants.find(v => v.id === repl.variantId).expected -= repl.qty
  expected.cash += n(op.cashReceived); expected.card += n(op.cardReceived)
  expected.refundCash += n(op.cashRefunded); expected.refundCard += n(op.cardRefunded)
  events.push({ operation: 'exchange', label, sourceInvoiceId: invoiceId, returnId: n(op.returnId), exchangeInvoiceId: n(op.exchangeInvoiceId),
    returnTotal: n(op.returnTotal), exchangeTotal: n(op.exchangeTotal), diff: n(op.diff), cashReceived: n(op.cashReceived),
    cardReceived: n(op.cardReceived), cashRefunded: n(op.cashRefunded), cardRefunded: n(op.cardRefunded),
    newStoreCreditAmount: n(op.newStoreCreditAmount), preview })
  await checkpoint(`exchange ${label}`)
  return op
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, assertions }
try {
  if (id === 151) {
    const a = variant('multi-return-item-A', 60_000), b = variant('multi-return-item-B', 40_000)
    const root = await createSale([line(a), line(b)], { cash: 100_000 })
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: true,
      lines: root.items.map(item => ({ saleItemId: n(item.id), qty: n(item.qty) })), refundMethod: 'CASH', refundAmount: 100_000 })
    expected.refundCash += n(ret.refundAmount); a.expected += 1; b.expected += 1
    assert.equal(n(ret.total), 100_000); assert.equal(n(ret.refundAmount), 100_000)
    events.push({ operation: 'full-two-item-return', returnId: n(ret.id), itemValues: [60_000, 40_000], total: n(ret.total), cashRefund: n(ret.refundAmount) })
    await checkpoint('full multi-item cash return')
    assertions.push({ key: 'multi-item-return-total-conserved', pass: true, sourceTotal: 100_000, returnedTotal: n(ret.total), cashRefund: n(ret.refundAmount) })
  } else if (id === 152) {
    const a = variant('POS-exchange-source', 100_000), b = variant('POS-exchange-target', 130_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'positive-difference-paid-by-POS', mode: 'CARD' })
    assert.equal(n(op.diff), 30_000); assert.equal(n(op.cardReceived), 30_000); assert.equal(n(op.cashReceived), 0)
    assertions.push({ key: 'positive-exchange-difference-collected-on-POS', pass: true, diff: n(op.diff), cardReceived: n(op.cardReceived), cashReceived: n(op.cashReceived) })
  } else if (id === 153) {
    const a = variant('store-credit-exchange-source', 120_000), b = variant('store-credit-exchange-target', 100_000), cItem = variant('later-purchase-after-exchange-credit', 150_000)
    const root = await createSale([line(a)], { cash: 120_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'negative-difference-as-store-credit', mode: 'STORE_CREDIT' })
    assert.equal(n(op.diff), -20_000); assert.equal(n(op.newStoreCreditAmount), 20_000)
    const issued = seed.one('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', op.returnId)
    assert.ok(issued); assert.equal(n(issued.amount), 20_000)
    const next = await createSale([line(cItem)], { cash: 130_000, storeCredits: [{ code: issued.code, requestedAmount: 20_000 }] })
    assert.equal(n(next.creditApplied), 20_000)
    assertions.push({ key: 'negative-exchange-credit-issued-and-redeemed-on-settled-sale', pass: true,
      exchangeDifference: n(op.diff), creditIssued: n(issued.amount), creditApplied: n(next.creditApplied), cashInAfterCredit: 130_000 })
  } else if (id === 154) {
    const a = variant('idempotent-sale-item', 75_000)
    const key = `nf2-${id}-same-sale-key`
    const first = await createSale([line(a, 2)], { cash: 150_000, key })
    const before = await snapshot()
    const retry = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: [line(a, 2)],
      payments: [{ methodId: cashMethod, amount: 150_000, destination: 'CASH' }], saleRequestIdempotencyKey: key })
    const after = await snapshot()
    assert.equal(n(retry.id), first.id, 'same idempotency key replays original settled sale')
    assert.deepEqual(after, before, 'sale retry creates no second invoice, payment, stock movement, or custody movement')
    assertions.push({ key: 'sale-idempotency-replay-is-mutation-free', pass: true, invoiceId: first.id, retryInvoiceId: n(retry.id), invoices: after.invoices })
  } else if (id === 155) {
    const a = variant('three-generation-source', 100_000), b = variant('three-generation-child-1', 110_000), c = variant('three-generation-child-2', 120_000), d = variant('three-generation-child-3', 130_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const one = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'generation-1-to-2' })
    const rows2 = seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=?', one.exchangeInvoiceId)
    const two = await createExchange({ invoiceId: n(one.exchangeInvoiceId), items: rows2, replacements: [line(c)], label: 'generation-2-to-3' })
    const rows3 = seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=?', two.exchangeInvoiceId)
    const three = await createExchange({ invoiceId: n(two.exchangeInvoiceId), items: rows3, replacements: [line(d)], label: 'generation-3-to-4' })
    const final = seed.one('SELECT sourceInvoiceId,grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?', three.exchangeInvoiceId)
    assert.equal(n(one.diff), 10_000); assert.equal(n(two.diff), 10_000); assert.equal(n(three.diff), 10_000)
    assert.equal(n(final.sourceInvoiceId), n(two.exchangeInvoiceId))
    assertions.push({ key: 'three-step-exchange-chain-lineage-and-payments', pass: true, diffs: [n(one.diff), n(two.diff), n(three.diff)], finalParent: n(final.sourceInvoiceId), finalInvoice: n(three.exchangeInvoiceId) })
  } else if (id === 156) {
    const a = variant('cash-paid-return-line', 60_000), b = variant('POS-paid-return-line', 40_000)
    const root = await createSale([line(a), line(b)], { cash: 60_000, card: 40_000 })
    const itemA = root.items.find(x => n(x.variantId) === a.id), itemB = root.items.find(x => n(x.variantId) === b.id)
    const retA = await createReturn({ invoiceId: root.id, item: itemA, method: 'CASH', amount: 60_000 })
    const retB = await createReturn({ invoiceId: root.id, item: itemB, method: 'CARD', amount: 40_000,
      posPassword: DEFAULT_MANAGER_PASSWORD, posReason: 'N156 isolated POS refund test' })
    assert.equal(n(retA.refundAmount), 60_000); assert.equal(n(retB.refundAmount), 40_000)
    assertions.push({ key: 'split-tender-return-to-matching-cash-and-POS-methods', pass: true, cashRefund: n(retA.refundAmount), cardRefund: n(retB.refundAmount) })
  } else if (id === 157) {
    const a = variant('unselected-return-source', 50_000)
    const root = await createSale([line(a)], { cash: 50_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }] }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'return without a selected payout/no-payout method must be rejected')
    assert.deepEqual(after, before, 'unselected return must be mutation-free')
    events.push({ operation: 'unselected-return-rejected', error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 50_000 })
    assert.equal(n(ret.refundAmount), 50_000)
    assertions.push({ key: 'unselected-return-blocked-then-explicit-cash-succeeds', pass: true, blockedWithoutMutation: true, refund: n(ret.refundAmount) })
  } else if (id === 158) {
    const a = variant('POS-gate-source', 50_000)
    const root = await createSale([line(a)], { card: 50_000 })
    const before = await snapshot()
    let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CARD', refundAmount: 50_000,
      cardPosOverride: { acknowledgedNoReverse: true, reason: 'N158 wrong manager password', managerPassword: 'not-the-manager-password' } }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error, 'card-return acknowledgement cannot bypass the manager-password gate')
    assert.deepEqual(after, before, 'unauthorized POS refund must be mutation-free')
    events.push({ operation: 'POS-refund-manager-gate-rejected', error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CARD', amount: 50_000,
      posPassword: DEFAULT_MANAGER_PASSWORD, posReason: 'N158 authorized isolated POS refund' })
    assertions.push({ key: 'POS-refund-requires-manager-and-authorized-retry-succeeds', pass: true, blockedWithoutManager: true, authorizedRefund: n(ret.refundAmount) })
  } else if (id === 159) {
    const a = variant('split-exchange-source', 100_000), b = variant('split-exchange-target', 130_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const rows = [{ methodId: cashMethod, amount: 10_000, destination: 'CASH' }, { methodId: cardMethod, amount: 20_000, destination: 'CARD' }]
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'positive-difference-split-cash-and-card',
      mode: 'SPLIT', splitPayments: rows })
    assert.equal(n(op.diff), 30_000); assert.equal(n(op.cashReceived), 10_000); assert.equal(n(op.cardReceived), 20_000)
    assertions.push({ key: 'exchange-positive-difference-split-tender-reconciles', pass: true, diff: n(op.diff), cash: n(op.cashReceived), card: n(op.cardReceived) })
  } else if (id === 160) {
    const a = variant('C2C-return-to-void-source', 100_000)
    const root = await createSale([line(a)], { card: 100_000 })
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 100_000 })
    const pending = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', ret.id)
    assert.ok(pending); assert.equal(pending.status, 'PENDING')
    const beforeVoidStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', a.id).stock)
    const voidResult = await salesService.returnDelete({ id: n(ret.id), userId, reason: 'آزمون لغو درخواست پرداخت معلق', panelPassword: DEFAULT_MANAGER_PASSWORD })
    const afterReturn = seed.one('SELECT voidedAt,voidReason,restockPending FROM "SaleReturn" WHERE id=?', ret.id)
    const canceled = seed.one('SELECT status,paidAmount FROM "CardTransferRequest" WHERE id=?', pending.id)
    const afterVoidStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', a.id).stock)
    assert.ok(voidResult.voided); assert.ok(afterReturn.voidedAt); assert.equal(canceled.status, 'CANCELED')
    assert.equal(afterVoidStock, beforeVoidStock, 'pending C2C return was never restocked and void must not create stock')
    events.push({ operation: 'void-pending-C2C-return', returnId: n(ret.id), voided: !!voidResult.voided, reason: afterReturn.voidReason,
      requestBefore: pending.status, requestAfter: canceled.status, requestPaidAmount: n(canceled.paidAmount),
      stockBeforeVoid: beforeVoidStock, stockAfterVoid: afterVoidStock, refundMethod: ret.refundMethod, requestedAmount: n(ret.refundAmount) })
    await checkpoint('void pending C2C return; settled card payment remains and no refund/restock is fabricated')
    assertions.push({ key: 'void-pending-C2C-cancels-request-and-keeps-stock-and-money-consistent', pass: true,
      requestCanceled: canceled.status === 'CANCELED', returnVoided: !!afterReturn.voidedAt, noPayout: n(canceled.paidAmount) === 0 })
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
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-151-160')
  mkdirSync(out, { recursive: true })
  const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی جدید N${id}`, '', `**وضعیت:** ${result.status}`, `**SQLite ایزوله:** ${process.env.HARNESS_DB}`, '',
    '## Trace', ...events.map(e => `- ${e.operation ?? e.label}: ${JSON.stringify(e)}`),
    ...assertions.map(a => `- ${a.key}: ${a.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(a)}`), '', '## تطبیق نهایی',
    `- موردانتظار: ${JSON.stringify(result.final.expected)}`, `- واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر انبار: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- شکست: ${JSON.stringify(result.failure ?? null)}`, '', 'فقط service-layer و SQLite موقت استفاده شد؛ دیتابیس واقعی و staging استفاده نشدند.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
