/**
 * New batch 131-140: targeted discount/exchange/credit-lifecycle probes.
 * Each invocation is one full scenario in its own temporary SQLite DB.
 * Test-only: calls existing service APIs; does not edit production behavior.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT10_ID)
assert.ok(Number.isInteger(id) && id >= 131 && id <= 140, 'MAHAK_NEXT10_ID must be 131..140')
const dir = mkdtempSync(join(tmpdir(), `mahak-next10-${id}-`))
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
const userId = seed.user(`new scenario ${id} cashier`)
const shiftId = seed.insert('Shift', { name: `new scenario ${id}`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `N10-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `N10-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`new-scenario-${id}`)
let variantSeq = 0
const variants = []
const credits = []
const events = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
function variant(name, price, stock = 10) {
  const product = seed.product(`N10-${id}-${++variantSeq}-${name}`, category)
  const variantId = seed.variant(product, `N10-${id}-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }
  variants.push(v)
  return v
}
function line(v, qty = 1, discount = 0) { return { variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 } }
async function issueCredit(amount, { multiUse = false, maxUses = 1, restrictScope = 'ALL', restrictVariantIds } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse, maxUses, carryRemainder: true, days: 30,
    restrictScope, ...(restrictVariantIds ? { restrictVariantIds } : {}), userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
  const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', issued.id)
  const c = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse, label: `credit-${credits.length + 1}` }
  credits.push(c)
  events.push({ operation: 'issue-credit', ...c, status: row.status, scope: row.restrictScope, expiresAt: row.expiresAt == null ? null : n(row.expiresAt) })
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
  assert.deepEqual(actual, expected, `${label}: report totals must match independently expected flows`)
  assert.deepEqual(rawPhysical(), actual, `${label}: raw payments/refunds must match report`)
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  const expectedBlue = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, expectedBlue, `${label}: blue/custody movement`)
  const stock = variants.map(v => {
    const actualStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) total FROM "StockMovement" WHERE variantId=?', v.id).total)
    assert.equal(actualStock, v.expected, `${label}: ${v.name} on-hand stock`)
    assert.equal(actualStock, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { id: v.id, name: v.name, expected: v.expected, actual: actualStock, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,discountTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const inv of invoices) {
    assert.equal(n(inv.paidTotal), n(inv.grandTotal), `${label}: invoice ${inv.id} fully paid`)
    assert.ok(inv.settledAt != null, `${label}: invoice ${inv.id} settled`)
  }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no check payments`)
  const event = { label, expected: { ...expected, blue: expectedBlue }, actual, raw: rawPhysical(), blue, stock,
    invoices: invoices.map(i => ({ id: n(i.id), total: n(i.grandTotal), paid: n(i.paidTotal), discount: n(i.discountTotal), status: i.status, settled: !!i.settledAt, parent: i.sourceInvoiceId == null ? null : n(i.sourceInvoiceId) })),
    returnCount: seed.count('SaleReturn', 'shiftId=?', shiftId), creditStates: credits.map(c => {
      const r = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?', c.id)
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status,
        expiresAt: r.expiresAt == null ? null : n(r.expiresAt), scope: r.restrictScope }
    }), checkPayments: checks }
  events.push(event)
  return event
}
async function sale(lines, { invoiceDiscount = 0, tender = 'CASH', creditCode = null, idempotencyKey = `n10-${id}-sale-${events.length}` } = {}) {
  let payments = []
  let storeCredits
  const gross = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0)
  const lineDiscount = lines.reduce((s, l) => s + l.discount, 0)
  const net = gross - lineDiscount - invoiceDiscount
  if (creditCode) {
    storeCredits = [{ code: creditCode }]
    const c = seed.one('SELECT amount,usedAmount FROM "StoreCredit" WHERE code=?', creditCode)
    const avail = n(c.amount) - n(c.usedAmount)
    assert.ok(avail <= net)
    const rest = net - avail
    if (tender === 'CASH' && rest) payments = [{ methodId: cashMethod, amount: rest, destination: 'CASH' }]
    if (tender === 'CARD' && rest) payments = [{ methodId: cardMethod, amount: rest, destination: 'CARD' }]
    if (tender === 'SPLIT' && rest) payments = [{ methodId: cashMethod, amount: Math.floor(rest / 2), destination: 'CASH' }, { methodId: cardMethod, amount: rest - Math.floor(rest / 2), destination: 'CARD' }]
  } else if (tender === 'CASH') payments = [{ methodId: cashMethod, amount: net, destination: 'CASH' }]
  else if (tender === 'CARD') payments = [{ methodId: cardMethod, amount: net, destination: 'CARD' }]
  else if (tender === 'SPLIT') payments = [{ methodId: cashMethod, amount: Math.floor(net / 2), destination: 'CASH' }, { methodId: cardMethod, amount: net - Math.floor(net / 2), destination: 'CARD' }]
  const result = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines, payments,
    ...(invoiceDiscount ? { invoiceDiscount } : {}), ...(storeCredits ? { storeCredits } : {}), saleRequestIdempotencyKey: idempotencyKey })
  const inv = seed.one('SELECT id,grandTotal,paidTotal,discountTotal,settledAt FROM "SaleInvoice" WHERE id=?', result.id)
  assert.equal(n(inv.grandTotal), net, 'sale net after line/invoice discount')
  assert.equal(n(inv.paidTotal), net, 'sale fully funded')
  assert.ok(inv.settledAt != null)
  for (const p of payments) p.methodId === cashMethod ? expected.cash += p.amount : expected.card += p.amount
  for (const l of lines) variants.find(v => v.id === l.variantId).expected -= l.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', result.id)
  events.push({ operation: 'sale', invoiceId: n(inv.id), gross, lineDiscount, invoiceDiscount, net, tender, creditCode,
    items: items.map(i => ({ id: n(i.id), variantId: n(i.variantId), qty: n(i.qty), unitPrice: n(i.unitPrice), discount: n(i.discount), lineTotal: n(i.lineTotal) })) })
  await checkpoint(`sale invoice ${n(inv.id)}: gross=${gross}; discounts=${lineDiscount + invoiceDiscount}; net=${net}`)
  return { id: n(inv.id), net, items, storeCreditApplied: n(result.storeCreditApplied) }
}
function signature() {
  return {
    invoiceCount: seed.count('SaleInvoice', 'shiftId=?', shiftId),
    returnCount: seed.count('SaleReturn', 'shiftId=?', shiftId),
    paymentCount: seed.count('Payment', 'createdShiftId=?', shiftId),
    cashMovementCount: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptionCount: seed.count('StoreCreditRedemption', 'invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', shiftId),
    credits: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id)),
    stock: variants.map(v => seed.one('SELECT id,stock FROM "ProductVariant" WHERE id=?', v.id))
  }
}
async function exchange({ invoiceId, sourceItems, replacements, mode = 'CASH', creditCode = null, label }) {
  const lines = sourceItems.map(i => ({ saleItemId: n(i.id), qty: n(i.qty ?? 1) }))
  const input = { userId, shiftId, invoiceId, lines, replacements,
    ...(mode === 'CASH' ? { methodId: cashMethod } : {}),
    ...(mode === 'CARD' ? { methodId: cardMethod } : {}),
    ...(mode === 'STORE_CREDIT' ? { refundMode: 'STORE_CREDIT' } : {}),
    ...(mode === 'C2C' ? { refundMode: 'CARD_TO_CARD' } : {}),
    ...(creditCode ? { exchangeCreditCode: creditCode } : {}),
    idempotencyKey: `n10-${id}-${label}-${events.length}` }
  if (mode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `new batch ${id} isolated card exchange`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements,
    invoiceDiscount: input.invoiceDiscount, invoiceTax: input.invoiceTax, serviceCharge: input.serviceCharge })
  assert.equal(preview.ok, true, `${label}: preview should be available: ${preview.error ?? ''}`)
  input.expectedSettlementDiff = n(preview.effectiveDiff)
  if (n(preview.effectiveDiff) < 0) {
    if (mode === 'CASH') input.refundMode = 'CASH'
    if (mode === 'CARD') {
      input.refundMode = 'CARD'
      input.cardPosOverride = { acknowledgedNoReverse: true, reason: `new batch ${id} isolated card refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    }
  }
  let operation, error = null
  try { operation = await salesService.createExchange(input) } catch (e) { error = String(e?.message ?? e) }
  if (error) {
    events.push({ operation: `exchange rejected ${label}`, expectedSettlementDiff: n(preview.effectiveDiff), error })
    return { ok: false, error, preview }
  }
  const diff = n(operation.diff)
  assert.equal(diff, n(preview.effectiveDiff), `${label}: committed diff equals preview`)
  for (const item of sourceItems) variants.find(v => v.id === n(item.variantId)).expected += n(item.qty ?? 1)
  for (const r of replacements) variants.find(v => v.id === n(r.variantId)).expected -= n(r.qty)
  if (diff > 0) {
    const cashIn = n(operation.cashReceived), cardIn = n(operation.cardReceived), creditIn = n(operation.exchangeCreditApplied)
    if (!creditCode && mode === 'CASH') assert.equal(cashIn, diff, `${label}: cash positive difference exactly once`)
    if (!creditCode && mode === 'CARD') assert.equal(cardIn, diff, `${label}: POS positive difference exactly once`)
    expected.cash += cashIn; expected.card += cardIn
    events.push({ operation: `exchange positive ${label}`, returnId: n(operation.returnId), exchangeInvoiceId: n(operation.exchangeInvoiceId),
      nominalDiff: n(preview.nominalDiff), effectiveDiff: diff, cashIn, cardIn, creditIn, preview })
  } else if (diff < 0) {
    const refundCash = n(operation.cashRefunded), refundCard = n(operation.cardRefunded)
    if (mode === 'STORE_CREDIT') assert.equal(refundCash + refundCard, 0, `${label}: STORE_CREDIT is nonphysical`)
    expected.refundCash += refundCash; expected.refundCard += refundCard
    events.push({ operation: `exchange negative ${label}`, returnId: n(operation.returnId), exchangeInvoiceId: n(operation.exchangeInvoiceId),
      nominalDiff: n(preview.nominalDiff), effectiveDiff: diff, refundCash, refundCard, refundStoreCreditAmount: n(operation.refundStoreCreditAmount), preview })
  } else events.push({ operation: `exchange zero ${label}`, returnId: n(operation.returnId), exchangeInvoiceId: n(operation.exchangeInvoiceId), nominalDiff: n(preview.nominalDiff), effectiveDiff: 0, preview })
  await checkpoint(`after ${label}; diff=${diff}`)
  return { ok: true, operation, preview }
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, findings: [], assertions: [] }
function finding(key, expectedValue, actualValue, detail) { result.findings.push({ key, expected: expectedValue, actual: actualValue, detail }) }
try {
  if (id === 131 || id === 132 || id === 133 || id === 134) {
    const a = variant('discounted-source', 100_000), r = variant('replacement', id === 133 ? 120_000 : id === 134 ? 80_000 : 100_000)
    const root = await sale([line(a)], { invoiceDiscount: 10_000 })
    const replacementDiscount = id === 131 ? 0 : 10_000
    const ex = await exchange({ invoiceId: root.id, sourceItems: root.items, replacements: [line(r, 1, replacementDiscount)],
      mode: id === 134 ? 'CASH' : 'CASH', label: 'discounted single-item source to replacement' })
    assert.equal(ex.ok, true, 'official exchange must complete')
    const expectedCarryDiff = id === 131 ? 0 : id === 132 ? 0 : id === 133 ? 20_000 : -20_000
    if (n(ex.operation.diff) !== expectedCarryDiff) finding('discount-carry-exchange-diff', expectedCarryDiff, n(ex.operation.diff),
      'Owner oracle requires source discount share to remain with the replacement/transaction exactly once; a positive or negative shift caused solely by dropping/duplicating that share is a policy mismatch.')
    result.assertions.push({ key: 'nominal-and-effective-diff-match-service-preview', pass: n(ex.operation.diff) === n(ex.preview.effectiveDiff), preview: ex.preview, actualDiff: n(ex.operation.diff) })
  } else if (id === 135) {
    const a = variant('source-A', 100_000), b = variant('source-B', 100_000), a1 = variant('replacement-A1', 100_000)
    const root = await sale([line(a), line(b)], { invoiceDiscount: 20_000 })
    const sourceA = root.items.find(x => n(x.variantId) === a.id), sourceB = root.items.find(x => n(x.variantId) === b.id)
    const ex = await exchange({ invoiceId: root.id, sourceItems: [sourceA], replacements: [line(a1, 1, 10_000)], label: 'one-of-two discounted items replaced' })
    assert.equal(ex.ok, true)
    assert.equal(n(ex.operation.diff), 0, 'same gross and carried equal discount share must settle to zero')
    const returned = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(sourceB.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 90_000 })
    expected.refundCash += n(returned.refundAmount)
    variants.find(v => v.id === b.id).expected += 1
    await checkpoint('return remaining original discounted item separately')
    const childItem = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', ex.operation.exchangeInvoiceId)[0]
    const childReturn = await salesService.createReturn({ userId, shiftId, invoiceId: n(ex.operation.exchangeInvoiceId), full: true,
      lines: [{ saleItemId: n(childItem.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 90_000 })
    expected.refundCash += n(childReturn.refundAmount)
    variants.find(v => v.id === a1.id).expected += 1
    await checkpoint('return replacement item at its child-invoice net')
    result.assertions.push({ key: 'original-and-replacement-return-total', pass: n(returned.total) === 90_000 && n(childReturn.total) === 90_000,
      sourceReturn: n(returned.total), replacementReturn: n(childReturn.total) })
  } else if (id === 136) {
    const a = variant('line-plus-invoice-source-A', 100_000), b = variant('line-plus-invoice-source-B', 100_000), a1 = variant('replacement-A1', 100_000)
    const root = await sale([line(a, 1, 5_000), line(b, 1, 5_000)], { invoiceDiscount: 10_000 })
    const sourceA = root.items.find(x => n(x.variantId) === a.id), sourceB = root.items.find(x => n(x.variantId) === b.id)
    const ex = await exchange({ invoiceId: root.id, sourceItems: [sourceA], replacements: [line(a1, 1, 10_000)], label: 'two discount layers retained once' })
    assert.equal(ex.ok, true)
    assert.equal(n(ex.operation.diff), 0, 'line + invoice share on source matches one replacement discount')
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false,
      lines: [{ saleItemId: n(sourceB.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 90_000 })
    expected.refundCash += n(ret.refundAmount); variants.find(v => v.id === b.id).expected += 1
    await checkpoint('return second source item after two-layer discount')
    result.assertions.push({ key: 'no-double-deduction-of-line-and-invoice-discount', pass: n(ret.total) === 90_000, returnNet: n(ret.total) })
  } else if (id === 137) {
    const a = variant('source-A', 100_000), b = variant('source-B', 100_000), c = variant('source-C', 100_000)
    const x = variant('replacement-X', 110_000), y = variant('replacement-Y', 90_000)
    const root = await sale([line(a), line(b), line(c)], { invoiceDiscount: 30_000 })
    const source = [a,b].map(v => root.items.find(i => n(i.variantId) === v.id))
    const ex = await exchange({ invoiceId: root.id, sourceItems: source,
      replacements: [line(x, 1, 10_000), line(y, 1, 10_000)], label: 'two-item exchange with positive/negative SKU mix' })
    assert.equal(ex.ok, true)
    assert.equal(n(ex.operation.diff), 0, 'two source net values 180k equal two replacement net values 180k')
    result.assertions.push({ key: 'two-item-discount-shares-conserve-net', pass: n(ex.operation.returnTotal) === 180_000 && n(ex.operation.exchangeTotal) === 180_000,
      returnTotal: n(ex.operation.returnTotal), exchangeTotal: n(ex.operation.exchangeTotal), diff: n(ex.operation.diff) })
  } else if (id === 138) {
    const originals = Array.from({ length: 10 }, (_,i) => variant(`original-${i+1}`, (i + 1) * 100_000))
    const replacements = [variant('replacement-first', 100_000), variant('replacement-last', 1_000_000)]
    const root = await sale(originals.map(v => line(v)), { invoiceDiscount: 550_000 })
    const source = [originals[0], originals[9]].map(v => root.items.find(i => n(i.variantId) === v.id))
    const ex = await exchange({ invoiceId: root.id, sourceItems: source,
      replacements: [line(replacements[0], 1, 10_000), line(replacements[1], 1, 100_000)], label: 'ten-item discount allocation, first and last exchanged' })
    assert.equal(ex.ok, true)
    assert.equal(n(ex.operation.returnTotal), 990_000, 'source net first+last = 90k+900k')
    assert.equal(n(ex.operation.exchangeTotal), 990_000, 'replacement net first+last = 90k+900k')
    assert.equal(n(ex.operation.diff), 0)
    result.assertions.push({ key: '10-line-discount-conservation-no-rounding-drift', pass: true, returnTotal: n(ex.operation.returnTotal), exchangeTotal: n(ex.operation.exchangeTotal), diff: n(ex.operation.diff) })
  } else if (id === 139) {
    const a = variant('two-qty-credit-funded-item', 100_000)
    const c = await issueCredit(100_000, { multiUse: true, maxUses: 5 })
    const root = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: [line(a, 2)],
      payments: [{ methodId: cashMethod, amount: 150_000, destination: 'CASH' }],
      storeCredits: [{ code: c.code, requestedAmount: 50_000 }], saleRequestIdempotencyKey: `n10-${id}-partial-redemption` })
    expected.cash += 150_000
    variants.find(v => v.id === a.id).expected -= 2
    const sourceItem = seed.one('SELECT id,variantId,qty FROM "SaleInvoiceItem" WHERE invoiceId=?', root.id)
    assert.equal(n(root.storeCreditApplied), 50_000)
    assert.equal(n(root.grandTotal), 200_000)
    events.push({ operation: 'sale-partial-multiuse-credit-redemption', invoiceId: n(root.id), itemQty: 2, unitPrice: 100_000,
      gross: 200_000, barcodeValue: 100_000, barcodeApplied: n(root.storeCreditApplied), cash: 150_000, requestedFromBarcode: 50_000 })
    await checkpoint('two-unit sale uses part of the multi-use barcode; cash/POS/blue and stock reconcile')
    const before = seed.one('SELECT amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id)
    assert.equal(n(before.usedAmount), 50_000)
    assert.equal(before.status, 'PARTIALLY_USED')
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: n(root.id), full: false,
      lines: [{ saleItemId: n(sourceItem.id), qty: 1 }], refundMethod: 'CASH', refundAmount: 50_000 })
    assert.equal(n(ret.total), 100_000, 'one returned unit has official value 100k')
    assert.equal(n(ret.returnCreditAmount), 50_000, 'the returned share of redeemed credit restores to source')
    assert.equal(n(ret.sourceCreditRestoredAmount), 50_000)
    events.push({ operation: 'partial-return-restoration', returnId: n(ret.id), returnedQty: 1, itemValue: n(ret.total), refundMethod: ret.refundMethod,
      cashRefund: n(ret.refundAmount), returnedCreditShare: n(ret.returnCreditAmount), restoredToSource: n(ret.sourceCreditRestoredAmount),
      successors: (ret.sourceCreditSuccessors ?? []).length })
    expected.refundCash += n(ret.refundAmount); variants.find(v => v.id === a.id).expected += 1
    await checkpoint('return one unit at the officially accepted 50k cash share; restore source credit')
    const after = seed.one('SELECT amount,usedAmount,usedCount,status,code FROM "StoreCredit" WHERE id=?', c.id)
    assert.equal(after.status, 'ACTIVE')
    assert.equal(n(after.usedAmount), 0, 'the returned share is restored to the same still-live multi-use source')
    assert.equal(seed.count('StoreCredit', 'returnId=?', ret.id), 0, 'live multi-use source gets same-ID restoration, no successor')
    const resale = await sale([line(a)], { creditCode: c.code, idempotencyKey: `n10-${id}-reuse-live-code` })
    assert.equal(n(resale.storeCreditApplied), 100_000, 'original unused balance plus restored 50k can be spent again')
    await checkpoint('reuse restored same code on another unit')
    result.assertions.push({ key: 'same-live-multiuse-code-restored-and-reused-no-successor', pass: after.code === c.code && n(after.usedAmount) === 0,
      code: c.code, beforeUsed: n(before.usedAmount), afterReturnUsed: n(after.usedAmount), successorCount: 0, laterApplied: n(resale.storeCreditApplied) })
  } else if (id === 140) {
    const spent = await issueCredit(20_000)
    const spentSku = variant('credit-redemption-item', 20_000)
    const burnSale = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: [line(spentSku)], payments: [], storeCreditCode: spent.code,
      storeCreditIdempotencyKey: `n10-${id}-burn-code` })
    variants.find(v => v.id === spentSku.id).expected -= 1
    assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', spent.id).status, 'USED')
    const a = variant('exchange-source', 100_000), b = variant('exchange-target', 120_000)
    const root = await sale([line(a)])
    const sourceItem = root.items[0]
    const before = signature()
    const attempted = await exchange({ invoiceId: root.id, sourceItems: [sourceItem], replacements: [line(b)], mode: 'BARCODE', creditCode: spent.code, label: 'attempt burned barcode as positive-difference tender' })
    const rejected = attempted.ok === false
    const rejection = attempted.error ?? ''
    const after = signature()
    assert.equal(rejected, true, 'fully-used barcode must not settle exchange difference')
    assert.deepEqual(after, before, 'rejected burned barcode tender attempt must be mutation-free')
    events.push({ operation: 'burned-code-positive-diff-rejected', rejection, mutationFree: true, barcodeStatus: seed.one('SELECT status FROM "StoreCredit" WHERE id=?', spent.id).status })
    const accepted = await exchange({ invoiceId: root.id, sourceItems: [sourceItem], replacements: [line(b)], mode: 'CASH', label: 'cash retry after burned barcode rejection' })
    assert.equal(accepted.ok, true)
    assert.equal(n(accepted.operation.diff), 20_000)
    result.assertions.push({ key: 'burned-barcode-rejected-then-cash-succeeds', pass: true, rejectedCodeStatus: 'USED', mutationFree: true, cashDifference: n(accepted.operation.cashReceived) })
  }
  await checkpoint(`final N${id} reconciliation`)
  result.status = result.findings.length ? 'POLICY_FINDING' : 'PASS'
} catch (e) {
  result.status = 'FAIL'
  result.failure = { message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
} finally {
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, actual: rawPhysical(),
    blue: n(await physicalMovementForCustodyShift(shiftId)),
    stock: variants.map(v => ({ name: v.name, expected: v.expected, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
      ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    credits: seed.count('StoreCredit'), checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-131-140')
  mkdirSync(out, { recursive: true })
  const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی جدید N${id}`, '', `**وضعیت:** ${result.status}`, `**پایگاه داده:** SQLite موقت ایزوله (${process.env.HARNESS_DB})`,
    '', '## مراحل و تطبیق‌ها', ...events.map(e => `- ${e.operation}: ${JSON.stringify(e)}`),
    '', '## ارزیابی نهایی', `- نتیجهٔ مورد انتظار: ${JSON.stringify(result.final.expected)}`,
    `- نتیجهٔ واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- یافته‌ها: ${JSON.stringify(result.findings)}`, `- شکست/رد: ${JSON.stringify(result.failure ?? null)}`,
    '', 'فقط مسیر service-layer و دیتابیس موقت تستی استفاده شد. منطق production، دیتابیس واقعی، staging و چاپ فیزیکی دست‌نخورده‌اند.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
