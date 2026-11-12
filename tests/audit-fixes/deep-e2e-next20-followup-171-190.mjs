/**
 * New batch N171-N190. A fresh isolated SQLite database is used per scenario.
 * All intended sales are fully settled; test-only service-layer probes, no production edits.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT20_FOLLOWUP_ID)
assert.ok(Number.isInteger(id) && id >= 171 && id <= 190, 'MAHAK_NEXT20_FOLLOWUP_ID must be 171..190')
const dir = mkdtempSync(join(tmpdir(), `mahak-next20-${id}-`))
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
const shiftId = seed.insert('Shift', { name: `N${id} isolated shift`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `NF20-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `NF20-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`N${id}-category`)
const variants = [], credits = [], events = [], assertions = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let variantSeq = 0
function variant(name, price, stock = 10) {
  const productId = seed.product(`N${id}-${++variantSeq}-${name}`, category)
  const variantId = seed.variant(productId, `NF20-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }
  variants.push(v)
  return v
}
const line = (v, qty = 1, discount = 0) => ({ variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 })
async function issueCredit(amount, { multiUse = false, maxUses = 1 } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse, maxUses, carryRemainder: true, days: 30,
    restrictScope: 'ALL', userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `N${id} isolated fixture` })
  const row = seed.one('SELECT id,code,amount,status,usedAmount FROM "StoreCredit" WHERE id=?', issued.id)
  const c = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse }
  credits.push(c)
  events.push({ operation: 'issue-test-credit', id: c.id, amount: c.amount, status: row.status, multiUse })
  return c
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
  assert.deepEqual(actual, expected, `${label}: report vs expected money flows`)
  const raw = rawPhysical(); assert.deepEqual(raw, actual, `${label}: raw money entries vs report`)
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blue = n(await physicalMovementForCustodyShift(shiftId)); assert.equal(blue, blueExpected, `${label}: blue/custody amount`)
  const stock = variants.map(v => {
    const actualStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actualStock, v.expected, `${label}: ${v.name} physical stock`)
    assert.equal(actualStock, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { name: v.name, expected: v.expected, actual: actualStock, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const invoice of invoices) {
    assert.equal(n(invoice.grandTotal), n(invoice.paidTotal), `${label}: invoice ${invoice.id} fully settled`)
    assert.ok(invoice.settledAt != null, `${label}: invoice ${invoice.id} settledAt`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no cheque tender`)
  const ev = { label, expected: { ...expected, blue: blueExpected }, actual, raw, blue, stock,
    invoices: invoices.map(i => ({ id: n(i.id), total: n(i.grandTotal), paid: n(i.paidTotal), status: i.status,
      settled: !!i.settledAt, parent: i.sourceInvoiceId == null ? null : n(i.sourceInvoiceId) })),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId), checks,
    creditStates: credits.map(c => {
      const x = seed.one('SELECT id,code,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id)
      return { id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), usedCount: n(x.usedCount), status: x.status }
    }) }
  events.push(ev); return ev
}
function stateSnapshot() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptions: seed.count('StoreCreditRedemption', 'shiftId=?', shiftId),
    allocations: seed.count('CreditReturnAllocation', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    stock: variants.map(v => ({ id: v.id, onHand: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    creditStates: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)), blue: null
  }
}
async function snapshot() { const s = stateSnapshot(); s.blue = n(await physicalMovementForCustodyShift(shiftId)); return s }
async function createSale(lines, { cash = 0, card = 0, storeCredits = [], key = `nf20-${id}-sale-${events.length}` } = {}) {
  const payments = [
    ...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []),
    ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])
  ]
  const sale = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines, payments, storeCredits, saleRequestIdempotencyKey: key })
  const row = seed.one('SELECT id,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  const gross = lines.reduce((sum, item) => sum + item.unitPrice * item.qty, 0)
  const discount = lines.reduce((sum, item) => sum + item.discount, 0)
  assert.equal(n(row.grandTotal), gross - discount)
  assert.equal(n(row.paidTotal), n(row.grandTotal), 'sales fixtures must not create debt')
  assert.ok(row.settledAt != null)
  expected.cash += cash; expected.card += card
  for (const item of lines) variants.find(v => v.id === item.variantId).expected -= item.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
  const out = { id: n(row.id), total: n(row.grandTotal), creditApplied: n(sale.storeCreditApplied), items }
  events.push({ operation: 'fully-settled-sale', invoiceId: out.id, total: out.total, cash, card, creditApplied: out.creditApplied,
    items: items.map(i => ({ id: n(i.id), variantId: n(i.variantId), qty: n(i.qty), unitPrice: n(i.unitPrice), lineTotal: n(i.lineTotal) })) })
  await checkpoint(`sale ${out.id}`); return out
}
async function createReturn({ invoiceId, item, qty = 1, method = 'CASH', amount, cardPassword = DEFAULT_MANAGER_PASSWORD, note = null }) {
  const input = { userId, shiftId, invoiceId, full: false, lines: [{ saleItemId: n(item.id), qty }], refundMethod: method }
  if (amount != null) input.refundAmount = amount
  if (note) input.refundNote = note
  if (method === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} isolated POS return`, managerPassword: cardPassword }
  const ret = await salesService.createReturn(input)
  if (method === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (method === 'CARD') expected.refundCard += n(ret.refundAmount)
  const v = variants.find(x => x.id === n(item.variantId)); if (v) v.expected += qty
  events.push({ operation: 'return', id: n(ret.id), invoiceId, itemId: n(item.id), qty,
    total: n(ret.total), method: ret.refundMethod, refundAmount: n(ret.refundAmount), returnCreditAmount: n(ret.returnCreditAmount) })
  await checkpoint(`return ${ret.id}`); return ret
}
async function createExchange({ invoiceId, items, replacements, label, mode = 'CASH', creditCode = null, refundAmount = null }) {
  const lines = items.map(i => ({ saleItemId: n(i.id), qty: n(i.qty ?? 1) }))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements })
  assert.equal(preview.ok, true, `${label}: preview failed: ${preview.error ?? ''}`)
  const input = { userId, shiftId, invoiceId, lines, replacements, expectedSettlementDiff: n(preview.effectiveDiff),
    idempotencyKey: `nf20-${id}-${label}-${events.length}` }
  if (mode === 'CASH') { input.methodId = cashMethod; if (n(preview.effectiveDiff) < 0) input.refundMode = 'CASH' }
  if (mode === 'CARD') {
    if (n(preview.effectiveDiff) > 0) input.methodId = cardMethod
    else { input.refundMode = 'CARD'; input.refundAmount = refundAmount; input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} POS exchange return`, managerPassword: DEFAULT_MANAGER_PASSWORD } }
  }
  if (mode === 'STORE_CREDIT') { input.refundMode = 'STORE_CREDIT'; if (refundAmount != null) input.refundAmount = refundAmount }
  if (mode === 'C2C') input.refundMode = 'CARD_TO_CARD'
  if (creditCode) input.exchangeCreditCode = creditCode
  if (refundAmount != null && (mode === 'CASH' || mode === 'STORE_CREDIT')) input.refundAmount = refundAmount
  const op = await salesService.createExchange(input)
  assert.equal(n(op.diff), n(preview.effectiveDiff), `${label}: committed diff differs from preview`)
  if (mode !== 'C2C') for (const item of items) variants.find(v => v.id === n(item.variantId)).expected += n(item.qty ?? 1)
  for (const r of replacements) variants.find(v => v.id === r.variantId).expected -= r.qty
  expected.cash += n(op.cashReceived); expected.card += n(op.cardReceived)
  expected.refundCash += n(op.cashRefunded); expected.refundCard += n(op.cardRefunded)
  events.push({ operation: 'exchange', label, sourceInvoiceId: invoiceId, returnId: n(op.returnId), exchangeInvoiceId: n(op.exchangeInvoiceId),
    returnTotal: n(op.returnTotal), exchangeTotal: n(op.exchangeTotal), diff: n(op.diff), cashReceived: n(op.cashReceived),
    cardReceived: n(op.cardReceived), cashRefunded: n(op.cashRefunded), cardRefunded: n(op.cardRefunded),
    barcodeCreditApplied: n(op.barcodeCreditApplied), newStoreCreditAmount: n(op.newStoreCreditAmount), cardToCard: n(op.cardToCard), preview })
  await checkpoint(`exchange ${label}`); return op
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, assertions }
try {
  if (id === 171) {
    const a = variant('four-unit-source', 25_000), root = await createSale([line(a, 4)], { cash: 100_000 }), item = root.items[0]
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 25_000 })
    await createReturn({ invoiceId: root.id, item, qty: 2, amount: 50_000 })
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 25_000 })
    assertions.push({ key: 'four-unit-lot-returns-in-1-2-1-quantity-sequence', pass: true, soldQty: 4, returnedQty: 4, cashRefund: expected.refundCash })
  } else if (id === 172) {
    const a = variant('POS-sale-cash-refund-item', 80_000), root = await createSale([line(a)], { card: 80_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 80_000 })
    assert.equal(n(ret.refundAmount), 80_000)
    assertions.push({ key: 'card-funded-sale-cash-refund-tracked-as-cash-outflow', pass: true, cardIn: expected.card, cashRefund: expected.refundCash, blue: expected.card - expected.refundCash })
  } else if (id === 173) {
    const a = variant('two-source-units', 90_000), b = variant('three-replacement-units', 60_000)
    const root = await createSale([line(a, 2)], { cash: 180_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b, 3)], label: 'two-units-to-three-equal-value' })
    assert.equal(n(op.returnTotal), 180_000); assert.equal(n(op.exchangeTotal), 180_000); assert.equal(n(op.diff), 0)
    assertions.push({ key: 'two-to-three-quantity-conversion-conserves-value', pass: true, sourceQty: 2, replacementQty: 3, diff: 0 })
  } else if (id === 174) {
    const a = variant('partial-barcode-exchange-source', 100_000), b = variant('partial-barcode-exchange-target', 130_000)
    const root = await createSale([line(a)], { cash: 100_000 }), c = await issueCredit(20_000)
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'barcode-plus-cash-positive-difference', creditCode: c.code })
    assert.equal(n(op.diff), 30_000); assert.equal(n(op.barcodeCreditApplied), 20_000); assert.equal(n(op.cashReceived), 10_000)
    assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', c.id).status, 'USED')
    assertions.push({ key: 'positive-difference-settled-with-barcode-and-cash-residual', pass: true, diff: 30_000, credit: 20_000, cash: 10_000 })
  } else if (id === 175) {
    const a = variant('partial-cash-credit-refund-source', 120_000), b = variant('partial-cash-credit-refund-target', 80_000), cItem = variant('redeem-remainder-item', 30_000)
    const root = await createSale([line(a)], { cash: 120_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'partial-cash-payout-credit-remainder', mode: 'CASH', refundAmount: 25_000 })
    assert.equal(n(op.diff), -40_000); assert.equal(n(op.cashRefunded), 25_000); assert.equal(n(op.newStoreCreditAmount), 15_000)
    const issued = seed.one('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', op.returnId)
    assert.ok(issued); assert.equal(n(issued.amount), 15_000)
    const next = await createSale([line(cItem)], { cash: 15_000, storeCredits: [{ code: issued.code, requestedAmount: 15_000 }] })
    assert.equal(next.creditApplied, 15_000)
    assertions.push({ key: 'negative-difference-split-cash-and-credit-remainder', pass: true, difference: -40_000, cashRefund: 25_000, creditIssued: 15_000, laterApplied: next.creditApplied })
  } else if (id === 176) {
    const a = variant('C2C-exchange-source', 100_000), b = variant('C2C-exchange-replacement', 80_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'C2C-negative-exchange-pending-payout', mode: 'C2C' })
    assert.equal(n(op.diff), -20_000); assert.equal(n(op.cardToCard), 20_000); assert.equal(op.restockPending, true)
    const req = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', op.returnId)
    assert.ok(req); assert.equal(req.status, 'PENDING'); assert.equal(n(req.amount), 20_000)
    const returned = seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', op.returnId)
    await checkpoint('exchange C2C payout pending; returned stock remains deferred')
    await cardTransferService.pay({ id: n(req.id), paidAmount: 20_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `N${id}-C2C-EX` })
    const after = seed.one('SELECT status,paidAmount FROM "CardTransferRequest" WHERE id=?', req.id)
    const restock = seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', op.returnId)
    assert.equal(after.status, 'PAID'); assert.equal(n(after.paidAmount), 20_000); assert.equal(n(restock.restockedQty), 1)
    a.expected += 1
    await checkpoint('exchange C2C payout paid; deferred source unit restocked')
    assertions.push({ key: 'C2C-exchange-pending-paid-and-restock-finalized', pass: true, pending: req.status, paid: after.status, restockPendingBefore: returned.restockPending, restockedQty: n(restock.restockedQty) })
  } else if (id === 177) {
    const a = variant('child-return-root-source', 100_000), b = variant('child-return-replacement', 120_000)
    const root = await createSale([line(a)], { cash: 100_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'cash-positive-exchange-before-child-return' })
    assert.equal(n(op.diff), 20_000)
    const childItem = seed.rows('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=?', op.exchangeInvoiceId)[0]
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: n(op.exchangeInvoiceId), full: false,
      lines: [{ saleItemId: n(childItem.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 20_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error.includes('اضافه‌دریافت'), 'selecting CASH alone must not bypass the child-return overpay confirmation gate')
    assert.deepEqual(after, before, 'blocked child return must not refund money or change stock')
    events.push({ operation: 'child-return-overpay-confirmation-required', attemptedCashRefund: 20_000, error, mutationFree: true })
    assertions.push({ key: 'child-return-method-selection-does-not-bypass-overpay-confirmation', pass: true, blockedWithoutConfirmation: true, mutationFree: true })
  } else if (id === 178) {
    const a = variant('voucher-funded-return-item', 50_000), c = await issueCredit(50_000)
    const root = await createSale([line(a)], { storeCredits: [{ code: c.code, requestedAmount: 50_000 }] })
    assert.equal(root.creditApplied, 50_000); assert.equal(expected.cash, 0)
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 50_000 })
    assert.equal(n(ret.refundAmount), 0, 'cash cannot be paid from an invoice funded only by store credit')
    assert.equal(expected.refundCash, 0)
    assertions.push({ key: 'voucher-funded-return-does-not-create-cash-outflow', pass: true,
      saleCreditApplied: root.creditApplied, cashRefund: n(ret.refundAmount), restoredSourceCredit: n(ret.sourceCreditRestoredAmount), successors: (ret.sourceCreditSuccessors ?? []).length })
  } else if (id === 179) {
    const a = variant('two-credit-funded-item', 100_000)
    const c1 = await issueCredit(100_000, { multiUse: true, maxUses: 5 }), c2 = await issueCredit(100_000, { multiUse: true, maxUses: 5 })
    const root = await createSale([line(a)], { cash: 50_000, storeCredits: [
      { code: c1.code, requestedAmount: 30_000 }, { code: c2.code, requestedAmount: 20_000 }
    ] })
    assert.equal(root.creditApplied, 50_000)
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    assert.equal(n(ret.sourceCreditRestoredAmount), 50_000)
    const allocs = seed.rows('SELECT sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', ret.id)
    assert.equal(allocs.reduce((s, x) => s + n(x.amount), 0), 50_000)
    assert.ok(allocs.some(x => n(x.sourceCreditId) === c1.id && n(x.amount) === 30_000))
    assert.ok(allocs.some(x => n(x.sourceCreditId) === c2.id && n(x.amount) === 20_000))
    const balances = [c1,c2].map(c => seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', c.id))
    assert.ok(balances.every(x => n(x.usedAmount) === 0 && x.status === 'ACTIVE'))
    const moneyCredit = seed.one('SELECT amount,expiresAt FROM "StoreCredit" WHERE returnId=? AND id NOT IN (?,?) ORDER BY id LIMIT 1', ret.id, c1.id, c2.id)
    assert.ok(moneyCredit); assert.equal(n(moneyCredit.amount), 50_000); assert.equal(moneyCredit.expiresAt, null)
    assertions.push({ key: 'two-source-barcodes-restored-exactly-and-cash-share-issued-as-credit', pass: true,
      sourceShares: allocs.map(x => ({ creditId: n(x.sourceCreditId), amount: n(x.amount) })), sourceRestored: n(ret.sourceCreditRestoredAmount), cashShareVoucher: n(moneyCredit.amount) })
  } else if (id === 180) {
    const a = variant('same-SKU-return-resell-item', 70_000)
    const first = await createSale([line(a)], { cash: 70_000 })
    const ret = await createReturn({ invoiceId: first.id, item: first.items[0], amount: 70_000 })
    assert.equal(n(ret.refundAmount), 70_000)
    const second = await createSale([line(a)], { cash: 70_000 })
    assertions.push({ key: 'returned-SKU-resold-once-stock-and-cash-reconcile', pass: true, firstRefund: n(ret.refundAmount), secondInvoice: second.id, finalStock: a.expected })
  } else if (id === 181) {
    const a = variant('POS-to-store-credit-return-source', 100_000), b = variant('post-credit-return-purchase', 120_000)
    const root = await createSale([line(a)], { card: 100_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const code = seed.one('SELECT code,amount FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(code); assert.equal(n(code.amount), 100_000)
    const next = await createSale([line(b)], { cash: 20_000, storeCredits: [{ code: code.code, requestedAmount: 100_000 }] })
    assert.equal(next.creditApplied, 100_000)
    assertions.push({ key: 'POS-refund-converted-to-voucher-and-redeemed-with-cash-residual', pass: true,
      cardIn: 100_000, issued: n(code.amount), laterApplied: next.creditApplied, residualCash: 20_000 })
  } else if (id === 182) {
    const a = variant('three-source-A', 50_000), b = variant('three-source-B', 60_000), c = variant('three-source-C', 90_000)
    const x = variant('two-target-X', 100_000), y = variant('two-target-Y', 120_000)
    const root = await createSale([line(a), line(b), line(c)], { cash: 200_000 })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(x), line(y)], label: 'three-source-lines-to-two-target-lines-positive-difference' })
    assert.equal(n(op.returnTotal), 200_000); assert.equal(n(op.exchangeTotal), 220_000); assert.equal(n(op.diff), 20_000)
    assertions.push({ key: 'three-to-two-multi-line-exchange-positive-difference', pass: true, sourceLines: 3, targetLines: 2, diff: n(op.diff), cashReceived: n(op.cashReceived) })
  } else if (id === 183) {
    const a = variant('cross-return-owner-A', 45_000), b = variant('cross-return-owner-B', 55_000)
    const first = await createSale([line(a)], { cash: 45_000 }), second = await createSale([line(b)], { cash: 55_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: first.id, full: false,
      lines: [{ saleItemId: n(second.items[0].id), qty: 1 }], refundMethod: 'CASH', refundAmount: 55_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot()
    assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'foreign-invoice-item-return-blocked', error, mutationFree: true })
    const ret = await createReturn({ invoiceId: first.id, item: first.items[0], amount: 45_000 })
    assertions.push({ key: 'foreign-invoice-item-blocked-correct-invoice-item-accepted', pass: true, returnAmount: n(ret.refundAmount), mutationFreeOnReject: true })
  } else if (id === 184) {
    const a = variant('method-unselected-return-item', 35_000), root = await createSale([line(a)], { cash: 35_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: n(root.items[0].id), qty: 1 }] }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'unselected-refund-method-blocked', error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 35_000 })
    assertions.push({ key: 'method-choice-required-then-cash-return-succeeds', pass: true, blockedWithoutMutation: true, amount: n(ret.refundAmount) })
  } else if (id === 185) {
    const a = variant('POS-manager-gate-item', 45_000), root = await createSale([line(a)], { card: 45_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CARD', refundAmount: 45_000,
      cardPosOverride: { acknowledgedNoReverse: true, reason: 'N185 wrong password', managerPassword: 'bad-password' } }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'POS-refund-with-invalid-manager-auth-rejected', error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CARD', amount: 45_000 })
    assertions.push({ key: 'POS-refund-password-gate-enforced-and-authorized-retry-succeeds', pass: true, refund: n(ret.refundAmount) })
  } else if (id === 186) {
    const a = variant('fresh-preview-source', 100_000), b = variant('fresh-preview-target', 125_000), root = await createSale([line(a)], { cash: 100_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createExchange({ userId, shiftId, invoiceId: root.id,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], replacements: [line(b)], methodId: cashMethod,
      expectedSettlementDiff: 24_000, idempotencyKey: `nf20-${id}-stale-preview` }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'stale-diff-preview-rejected', quoted: 24_000, actual: 25_000, error, mutationFree: true })
    const op = await createExchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'fresh-preview-retry' })
    assertions.push({ key: 'stale-exchange-preview-rolled-back-fresh-retry-succeeds', pass: true, diff: n(op.diff), staleMutationFree: true })
  } else if (id === 187) {
    const a = variant('sale-key-original', 65_000), b = variant('sale-key-altered', 65_000), key = `nf20-${id}-fingerprint-key`
    const first = await createSale([line(a)], { cash: 65_000, key }), before = await snapshot(); let error = ''
    try { await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: [line(b)], payments: [{ methodId: cashMethod, amount: 65_000, destination: 'CASH' }], saleRequestIdempotencyKey: key }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'sale-idempotency-payload-mismatch-rejected', originalInvoiceId: first.id, error, mutationFree: true })
    assertions.push({ key: 'same-sale-idempotency-key-cannot-be-reused-for-different-SKU', pass: true, invoiceCount: after.invoices })
  } else if (id === 188) {
    const a = variant('return-above-cap-item', 72_000), root = await createSale([line(a)], { cash: 72_000 }), before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CASH', refundAmount: 75_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'refund-request-over-selected-item-cap-rejected', cap: 72_000, request: 75_000, error, mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], amount: 72_000 })
    assertions.push({ key: 'above-cap-refund-rejected-then-exact-cap-accepted', pass: true, correctRefund: n(ret.refundAmount) })
  } else if (id === 189) {
    const a = variant('already-returned-exchange-source', 90_000), b = variant('exchange-after-return-target', 100_000)
    const root = await createSale([line(a)], { cash: 90_000 })
    await createReturn({ invoiceId: root.id, item: root.items[0], amount: 90_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createExchange({ userId, shiftId, invoiceId: root.id,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], replacements: [line(b)], methodId: cashMethod,
      expectedSettlementDiff: 10_000, idempotencyKey: `nf20-${id}-already-returned-source` }) }
    catch (e) { error = String(e?.message ?? e) }
    const after = await snapshot(); assert.ok(error); assert.deepEqual(after, before)
    events.push({ operation: 'exchange-of-fully-returned-source-rejected', error, mutationFree: true })
    assertions.push({ key: 'fully-returned-item-cannot-be-exchanged-again', pass: true, mutationFree: true })
  } else if (id === 190) {
    const a = variant('C2C-void-and-retry-item', 100_000), root = await createSale([line(a)], { card: 100_000 })
    const first = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(root.items[0].id), qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 100_000 })
    const req = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', first.id)
    assert.ok(req); assert.equal(req.status, 'PENDING')
    await salesService.returnDelete({ id: n(first.id), userId, reason: 'N190 لغو درخواست معلق پیش از retry', panelPassword: DEFAULT_MANAGER_PASSWORD })
    const canceled = seed.one('SELECT status,paidAmount FROM "CardTransferRequest" WHERE id=?', req.id)
    const voided = seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', first.id)
    assert.equal(canceled.status, 'CANCELED'); assert.equal(n(canceled.paidAmount), 0); assert.ok(voided.voidedAt)
    const second = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CARD', amount: 100_000 })
    assert.equal(n(second.refundAmount), 100_000)
    assertions.push({ key: 'voided-pending-C2C-allows-new-authorized-card-return', pass: true,
      firstRequestCanceled: canceled.status === 'CANCELED', secondRefund: n(second.refundAmount), cardRefundTotal: expected.refundCard })
  }
  await checkpoint(`final N${id} reconciliation`)
  result.status = 'PASS'
} catch (e) {
  result.status = 'FAIL'
  result.failure = { message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
} finally {
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, actual: rawPhysical(),
    blue: n(await physicalMovementForCustodyShift(shiftId)),
    stock: variants.map(v => ({ name: v.name, expected: v.expected, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'),
    checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-171-190')
  mkdirSync(out, { recursive: true })
  const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی تازه N${id}`, '', `**وضعیت:** ${result.status}`, `**SQLite ایزوله:** ${process.env.HARNESS_DB}`, '',
    '## Trace', ...events.map(e => `- ${e.operation ?? e.label}: ${JSON.stringify(e)}`),
    ...assertions.map(a => `- ${a.key}: ${a.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(a)}`), '', '## تطبیق نهایی',
    `- موردانتظار: ${JSON.stringify(result.final.expected)}`, `- واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر انبار: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- خطا: ${JSON.stringify(result.failure ?? null)}`, '', 'فقط service-layer و SQLite موقت استفاده شد؛ دیتابیس واقعی و staging درگیر نشدند.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
