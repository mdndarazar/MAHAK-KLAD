/* Batch N191-N210: isolated service-layer financial/inventory paths, one DB per run. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const id = Number(process.env.MAHAK_NEXT20_FOLLOWUP_ID)
assert.ok(Number.isInteger(id) && id >= 191 && id <= 210, 'MAHAK_NEXT20_FOLLOWUP_ID must be 191..210')
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

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db, n = x => Number(x ?? 0)
const userId = seed.user(`N${id} isolated cashier`)
const shiftId = seed.insert('Shift', { name: `N${id} isolated shift`, number: id, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: `NF21-${id}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardMethod = seed.insert('PaymentMethod', { key: `NF21-${id}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`N${id}-category`), otherCategory = seed.category(`N${id}-other-category`)
const variants = [], credits = [], events = [], modes = [], assertions = [], expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let variantSeq = 0
function mode(key, details = {}) { modes.push({ key, ...details }) }
function variant(name, price, stock = 10, categoryId = category) {
  const p = seed.product(`N${id}-${++variantSeq}-${name}`, categoryId), variantId = seed.variant(p, `NF21-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, variantId)
  const v = { id: variantId, name, price, baseline: stock, expected: stock }; variants.push(v); return v
}
const line = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
async function issueCredit(amount, opts = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse: !!opts.multiUse, maxUses: opts.maxUses ?? 1,
    carryRemainder: true, days: 30, restrictScope: opts.restrictScope ?? 'ALL',
    ...(opts.restrictCategoryIds ? { restrictCategoryIds: opts.restrictCategoryIds } : {}),
    ...(opts.restrictVariantIds ? { restrictVariantIds: opts.restrictVariantIds } : {}),
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `N${id} isolated test fixture` })
  const row = seed.one('SELECT id,code,amount,status,usedAmount,restrictScope FROM "StoreCredit" WHERE id=?', issued.id)
  const c = { id: n(row.id), code: row.code, amount: n(row.amount), multiUse: !!opts.multiUse }
  credits.push(c); events.push({ operation: 'issue-credit', id: c.id, amount: c.amount, status: row.status, scope: row.restrictScope }); return c
}
function rawPhysical() {
  const p = seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND pay.kind='CASH' AND pay.voidedAt IS NULL THEN pay.amount ELSE 0 END),0) card
    FROM "Payment" pay JOIN "PaymentMethod" m ON m.id=pay.methodId WHERE pay.createdShiftId=?`, shiftId)
  const cf = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const cr = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(cf.amount), refundCard: n(cr.amount) }
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const actual = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(actual, expected, `${label}: service report vs expected`)
  const raw = rawPhysical(); assert.deepEqual(raw, actual, `${label}: raw documents vs report`)
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  const blue = n(await physicalMovementForCustodyShift(shiftId)); assert.equal(blue, blueExpected, `${label}: blue/custody amount`)
  const stock = variants.map(v => {
    const actualStock = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const ledger = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actualStock, v.expected, `${label}: ${v.name} on-hand`)
    assert.equal(actualStock, v.baseline + ledger, `${label}: ${v.name} stock ledger`)
    return { name: v.name, expected: v.expected, actual: actualStock, ledger }
  })
  const invoices = seed.rows('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
  for (const x of invoices) { assert.equal(n(x.grandTotal), n(x.paidTotal), `${label}: invoice ${x.id} fully settled`); assert.ok(x.settledAt != null) }
  const checks = seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId)
  assert.equal(checks, 0, `${label}: no cheque`)
  const ev = { label, expected: { ...expected, blue: blueExpected }, actual, raw, blue, stock,
    invoices: invoices.map(x => ({ id: n(x.id), total: n(x.grandTotal), paid: n(x.paidTotal), status: x.status,
      settled: !!x.settledAt, parent: x.sourceInvoiceId == null ? null : n(x.sourceInvoiceId) })),
    returnCount: seed.count('SaleReturn', 'shiftId=?', shiftId), checks,
    creditStates: credits.map(c => { const x = seed.one('SELECT id,code,amount,usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', c.id);
      return { id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), usedCount: n(x.usedCount), status: x.status } }) }
  events.push(ev); return ev
}
async function snapshot() {
  return { invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    redemptions: seed.count('StoreCreditRedemption', 'shiftId=?', shiftId), allocations: seed.count('CreditReturnAllocation', 'returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId),
    stock: variants.map(v => ({ id: v.id, onHand: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    credits: credits.map(c => seed.one('SELECT id,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)),
    transfers: seed.rows('SELECT id,status,amount,paidAmount FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) ORDER BY id', shiftId),
    blue: n(await physicalMovementForCustodyShift(shiftId)) }
}
async function createSale(lines, { cash = 0, card = 0, storeCredits = [], key = `nf21-${id}-sale-${events.length}` } = {}) {
  const payments = [...(cash ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : []), ...(card ? [{ methodId: cardMethod, amount: card, destination: 'CARD' }] : [])]
  const sale = await salesService.create({ userId, shiftId, lines, payments, storeCredits, saleRequestIdempotencyKey: key })
  const row = seed.one('SELECT id,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  const gross = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0)
  assert.equal(n(row.grandTotal), gross); assert.equal(n(row.paidTotal), gross, 'no debt sales'); assert.ok(row.settledAt != null)
  expected.cash += cash; expected.card += card
  for (const l of lines) variants.find(v => v.id === l.variantId).expected -= l.qty
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
  const out = { id: n(row.id), total: n(row.grandTotal), creditApplied: n(sale.storeCreditApplied), items }
  events.push({ operation: 'settled-sale', invoiceId: out.id, total: out.total, cash, card, creditApplied: out.creditApplied,
    items: items.map(x => ({ id: n(x.id), variantId: n(x.variantId), qty: n(x.qty), unitPrice: n(x.unitPrice), lineTotal: n(x.lineTotal) })) })
  await checkpoint(`sale ${out.id}`); return out
}
async function createReturn({ invoiceId, item, qty = 1, method = 'CASH', amount, password = DEFAULT_MANAGER_PASSWORD, note = null }) {
  const input = { userId, shiftId, invoiceId, full: false, lines: [{ saleItemId: n(item.id), qty }], refundMethod: method }
  if (amount != null) input.refundAmount = amount
  if (method === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} isolated POS refund`, managerPassword: password }
  if (note) input.refundNote = note
  const ret = await salesService.createReturn(input)
  if (method === 'CASH') expected.refundCash += n(ret.refundAmount)
  if (method === 'CARD') expected.refundCard += n(ret.refundAmount)
  const v = variants.find(x => x.id === n(item.variantId)); if (v) v.expected += qty
  events.push({ operation: 'return', id: n(ret.id), invoiceId, itemId: n(item.id), qty, total: n(ret.total), method: ret.refundMethod,
    refundAmount: n(ret.refundAmount), returnCreditAmount: n(ret.returnCreditAmount) })
  await checkpoint(`return ${ret.id}`); return ret
}
async function exchange({ invoiceId, items, replacements, label, mode = 'CASH', code = null }) {
  const lines = items.map(i => ({ saleItemId: n(i.id), qty: n(i.qty ?? 1) }))
  const preview = await salesService.previewExchangeFunding({ invoiceId, lines, replacements })
  assert.equal(preview.ok, true, `${label}: preview ${preview.error ?? ''}`)
  const input = { userId, shiftId, invoiceId, lines, replacements, expectedSettlementDiff: n(preview.effectiveDiff), idempotencyKey: `nf21-${id}-${label}-${events.length}` }
  if (mode === 'CASH') { input.methodId = cashMethod; if (n(preview.effectiveDiff) < 0) input.refundMode = 'CASH' }
  if (mode === 'CARD') {
    if (n(preview.effectiveDiff) > 0) input.methodId = cardMethod
    else { input.refundMode = 'CARD'; input.cardPosOverride = { acknowledgedNoReverse: true, reason: `N${id} exchange card refund`, managerPassword: DEFAULT_MANAGER_PASSWORD } }
  }
  if (mode === 'STORE_CREDIT') input.refundMode = 'STORE_CREDIT'
  if (mode === 'C2C') input.refundMode = 'CARD_TO_CARD'
  if (code) input.exchangeCreditCode = code
  const op = await salesService.createExchange(input)
  assert.equal(n(op.diff), n(preview.effectiveDiff), `${label}: preview vs commit`)
  if (mode !== 'C2C') for (const i of items) variants.find(v => v.id === n(i.variantId)).expected += n(i.qty ?? 1)
  for (const r of replacements) variants.find(v => v.id === r.variantId).expected -= r.qty
  expected.cash += n(op.cashReceived); expected.card += n(op.cardReceived); expected.refundCash += n(op.cashRefunded); expected.refundCard += n(op.cardRefunded)
  events.push({ operation: 'exchange', label, returnId: n(op.returnId), exchangeInvoiceId: n(op.exchangeInvoiceId), diff: n(op.diff),
    cashReceived: n(op.cashReceived), cardReceived: n(op.cardReceived), cashRefunded: n(op.cashRefunded), cardRefunded: n(op.cardRefunded),
    barcodeCreditApplied: n(op.barcodeCreditApplied), newStoreCreditAmount: n(op.newStoreCreditAmount), cardToCard: n(op.cardToCard), preview })
  await checkpoint(`exchange ${label}`); return op
}

const result = { generatedAt: new Date().toISOString(), id, scenario: `N${id}`, isolatedDatabase: process.env.HARNESS_DB,
  codeTarget: 'current local working tree at execution time', status: 'RUNNING', events, modes }
try {
  if (id === 191) {
    const a = variant('sale-replay-item', 90_000), key = `nf21-${id}-exact-replay-key`
    const first = await createSale([line(a)], { cash: 90_000, key }); mode('first sale fully settled', { invoice: first.id })
    const before = await snapshot()
    const retry = await salesService.create({ userId, shiftId, lines: [line(a)], payments: [{ methodId: cashMethod, amount: 90_000, destination: 'CASH' }], saleRequestIdempotencyKey: key })
    mode('exact retry returns original invoice', { first: first.id, retry: n(retry.id) })
    const after = await snapshot(); assert.equal(n(retry.id), first.id); assert.deepEqual(after, before)
    mode('retry adds no payment, stock movement, or custody movement', { mutationFree: true })
  } else if (id === 192) {
    const a = variant('payload-original', 70_000), b = variant('payload-changed', 70_000), key = `nf21-${id}-payload-bound`
    const first = await createSale([line(a)], { cash: 70_000, key }); mode('original keyed sale fully settled', { invoice: first.id })
    const before = await snapshot(); let error = ''
    try { await salesService.create({ userId, shiftId, lines: [line(b)], payments: [{ methodId: cashMethod, amount: 70_000, destination: 'CASH' }], saleRequestIdempotencyKey: key }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); const after = await snapshot(); assert.deepEqual(after, before)
    mode('changed payload under same key rejected', { mutationFree: true, error })
    mode('existing invoice and payment remain single', { invoices: after.invoices, payments: after.payments })
  } else if (id === 193) {
    const a = variant('pos-refund-gate-item', 50_000), root = await createSale([line(a)], { card: 50_000 }), item = root.items[0]
    const before = await snapshot(); let missingError = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: item.id, qty: 1 }], refundMethod: 'CARD', refundAmount: 50_000 }) }
    catch (e) { missingError = String(e?.message ?? e) }
    assert.ok(missingError); assert.deepEqual(await snapshot(), before); mode('POS acknowledgement omitted: blocked', { mutationFree: true })
    let badPasswordError = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: item.id, qty: 1 }], refundMethod: 'CARD', refundAmount: 50_000,
      cardPosOverride: { acknowledgedNoReverse: true, reason: 'N193 test', managerPassword: 'invalid' } }) }
    catch (e) { badPasswordError = String(e?.message ?? e) }
    assert.ok(badPasswordError); assert.deepEqual(await snapshot(), before); mode('POS acknowledgement without valid manager: blocked', { mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item, method: 'CARD', amount: 50_000 }); assert.equal(n(ret.refundAmount), 50_000)
    mode('authorized POS return: accepted once', { cardRefund: n(ret.refundAmount) })
  } else if (id === 194) {
    const pairs = [
      { name: 'cash', price: 50_000, tender: 'CASH' },
      { name: 'card', price: 60_000, tender: 'CARD' },
      { name: 'split', price: 70_000, tender: 'SPLIT' }
    ]
    for (const p of pairs) {
      const a = variant(`return-${p.name}`, p.price)
      const cash = p.tender === 'CASH' ? p.price : p.tender === 'SPLIT' ? p.price / 2 : 0
      const card = p.tender === 'CARD' ? p.price : p.tender === 'SPLIT' ? p.price / 2 : 0
      const root = await createSale([line(a)], { cash, card })
      const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: p.tender === 'CARD' ? 'CARD' : 'CASH', amount: p.price })
      assert.equal(n(ret.refundAmount), p.price)
      mode(`${p.tender} funded sale returned in selected physical method`, { tender: p.tender, returnMethod: ret.refundMethod, amount: n(ret.refundAmount) })
    }
  } else if (id === 195) {
    for (const p of [
      { name: 'cash', diff: 20_000, mode: 'CASH' },
      { name: 'POS', diff: 25_000, mode: 'CARD' },
      { name: 'barcode-plus-cash', diff: 30_000, mode: 'CODE' }
    ]) {
      const a = variant(`positive-${p.name}-source`, 100_000), b = variant(`positive-${p.name}-replacement`, 100_000 + p.diff)
      const root = await createSale([line(a)], { cash: 100_000 })
      const code = p.mode === 'CODE' ? await issueCredit(20_000) : null
      const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: `positive-${p.name}`, mode: p.mode === 'CODE' ? 'CASH' : p.mode, code: code?.code })
      assert.equal(n(op.diff), p.diff)
      if (p.mode === 'CASH') assert.equal(n(op.cashReceived), p.diff)
      if (p.mode === 'CARD') assert.equal(n(op.cardReceived), p.diff)
      if (p.mode === 'CODE') { assert.equal(n(op.barcodeCreditApplied), 20_000); assert.equal(n(op.cashReceived), p.diff - 20_000) }
      mode(`positive difference via ${p.name}`, { diff: p.diff, cash: n(op.cashReceived), card: n(op.cardReceived), barcode: n(op.barcodeCreditApplied) })
    }
  } else if (id === 196) {
    for (const p of [
      { name: 'cash', method: 'CASH', pay: 'CASH' },
      { name: 'POS', method: 'CARD', pay: 'CARD' },
      { name: 'voucher', method: 'STORE_CREDIT', pay: 'CASH' }
    ]) {
      const a = variant(`negative-${p.name}-source`, 100_000), b = variant(`negative-${p.name}-target`, 80_000)
      const root = await createSale([line(a)], { [p.pay === 'CARD' ? 'card' : 'cash']: 100_000 })
      const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: `negative-${p.name}`, mode: p.method })
      assert.equal(n(op.diff), -20_000)
      if (p.method === 'CASH') assert.equal(n(op.cashRefunded), 20_000)
      if (p.method === 'CARD') assert.equal(n(op.cardRefunded), 20_000)
      if (p.method === 'STORE_CREDIT') assert.equal(n(op.newStoreCreditAmount), 20_000)
      mode(`negative difference settled by ${p.method}`, { diff: n(op.diff), cashRefund: n(op.cashRefunded), cardRefund: n(op.cardRefunded), credit: n(op.newStoreCreditAmount) })
    }
  } else if (id === 197) {
    const a = variant('three-step-credit-source', 100_000), b = variant('three-step-credit-replacement', 125_000), cItem = variant('final-credit-consumer', 35_000)
    const credit = await issueCredit(100_000, { multiUse: true, maxUses: 8 })
    const root = await createSale([line(a)], { cash: 50_000, storeCredits: [{ code: credit.code, requestedAmount: 50_000 }] })
    assert.equal(root.creditApplied, 50_000); mode('partial source credit redeemed in settled sale', { amount: root.creditApplied })
    const afterSale = seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', credit.id); assert.equal(n(afterSale.usedAmount), 50_000)
    const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'multiuse-source-credit-pays-difference', code: credit.code })
    assert.equal(n(op.diff), 25_000); assert.equal(n(op.barcodeCreditApplied), 25_000); mode('same barcode pays positive exchange difference', { amount: n(op.barcodeCreditApplied) })
    const afterExchange = seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', credit.id); assert.equal(n(afterExchange.usedAmount), 75_000); assert.equal(afterExchange.status, 'PARTIALLY_USED')
    mode('unspent source balance remains active', { usedAmount: n(afterExchange.usedAmount), status: afterExchange.status })
    const next = await createSale([line(cItem)], { cash: 10_000, storeCredits: [{ code: credit.code, requestedAmount: 25_000 }] })
    assert.equal(next.creditApplied, 25_000); const final = seed.one('SELECT usedAmount,status FROM "StoreCredit" WHERE id=?', credit.id)
    assert.equal(n(final.usedAmount), 100_000); assert.equal(final.status, 'USED')
    mode('remaining balance reused in fully settled next sale', { applied: next.creditApplied, finalStatus: final.status })
  } else if (id === 198) {
    const allowedCategory = seed.category(`N${id}-allowed-category`), blockedCategory = seed.category(`N${id}-blocked-category`)
    const eligible = variant('category-eligible-source', 100_000, 10, allowedCategory), eligibleTarget = variant('category-eligible-target', 130_000, 10, allowedCategory)
    const blocked = variant('category-blocked-source', 100_000, 10, blockedCategory), blockedTarget = variant('category-blocked-target', 120_000, 10, blockedCategory)
    const credit = await issueCredit(50_000, { multiUse: true, maxUses: 5, restrictScope: 'CATEGORY', restrictCategoryIds: [allowedCategory] })
    const rootA = await createSale([line(eligible)], { cash: 100_000 })
    const allowed = await exchange({ invoiceId: rootA.id, items: rootA.items, replacements: [line(eligibleTarget)], label: 'category-eligible-credit-exchange', code: credit.code })
    assert.equal(n(allowed.barcodeCreditApplied), 30_000); mode('category-eligible source accepts 30k of credit', { applied: n(allowed.barcodeCreditApplied) })
    const rootB = await createSale([line(blocked)], { cash: 100_000 }), before = await snapshot(); let error = ''
    try { await salesService.createExchange({ userId, shiftId, invoiceId: rootB.id, lines: [{ saleItemId: n(rootB.items[0].id), qty: 1 }],
      replacements: [line(blockedTarget)], exchangeCreditCode: credit.code, expectedSettlementDiff: 20_000, idempotencyKey: `nf21-${id}-blocked-category` }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before); mode('out-of-category source cannot spend remaining code', { mutationFree: true, error })
    const cashRetry = await exchange({ invoiceId: rootB.id, items: rootB.items, replacements: [line(blockedTarget)], label: 'blocked-category-cash-retry' })
    assert.equal(n(cashRetry.cashReceived), 20_000); mode('cash retry settles blocked exchange without touching restricted credit', { cash: n(cashRetry.cashReceived) })
  } else if (id === 199) {
    const a = variant('partial-quantity-sequence-item', 20_000), root = await createSale([line(a, 3)], { cash: 60_000 }), item = root.items[0]
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 20_000 }); mode('first partial return qty 1', { returned: 1 })
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 20_000 }); mode('second partial return qty 1', { cumulative: 2 })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: item.id, qty: 2 }], refundMethod: 'CASH', refundAmount: 40_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before); mode('over-return of two when one remains is blocked', { remaining: 1, mutationFree: true })
    await createReturn({ invoiceId: root.id, item, qty: 1, amount: 20_000 }); mode('last remaining unit returned and totals close', { totalReturned: 3 })
  } else if (id === 200) {
    const a = variant('cross-invoice-original', 45_000), b = variant('foreign-invoice-item', 55_000)
    const rootA = await createSale([line(a)], { cash: 45_000 }), rootB = await createSale([line(b)], { cash: 55_000 })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: rootA.id, full: false, lines: [{ saleItemId: rootB.items[0].id, qty: 1 }], refundMethod: 'CASH', refundAmount: 55_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before); mode('foreign sale-item rejected against another invoice', { mutationFree: true })
    const ret = await createReturn({ invoiceId: rootA.id, item: rootA.items[0], amount: 45_000 }); mode('valid invoice-owned item returned', { amount: n(ret.refundAmount) })
  } else if (id === 201) {
    const a = variant('POS-to-cash-refund', 80_000), root = await createSale([line(a)], { card: 80_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 80_000 })
    assert.equal(n(ret.refundAmount), 80_000); mode('POS-paid sale pays requested cash refund', { cardIn: expected.card, cashOut: expected.refundCash })
    mode('cash and card classifications remain separate', { cardNet: expected.card, cashRefund: expected.refundCash })
  } else if (id === 202) {
    const a = variant('voucher-only-source', 40_000), credit = await issueCredit(40_000)
    const root = await createSale([line(a)], { storeCredits: [{ code: credit.code, requestedAmount: 40_000 }] })
    assert.equal(root.creditApplied, 40_000); mode('voucher fully funds sale with no physical cash', { credit: root.creditApplied, cash: expected.cash })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'CASH', amount: 40_000 })
    assert.equal(n(ret.refundAmount), 0); mode('cash method yields zero payout without money received', { cashRefund: n(ret.refundAmount) })
    mode('source-credit restoration/ successor is recorded separately from cash', { restored: n(ret.sourceCreditRestoredAmount), successors: (ret.sourceCreditSuccessors ?? []).length })
  } else if (id === 203) {
    const a = variant('C2C-double-payment-protection', 90_000), root = await createSale([line(a)], { card: 90_000 })
    const ret = await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: root.items[0].id, qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 90_000 })
    const req = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', ret.id)
    assert.ok(req); assert.equal(req.status, 'PENDING'); mode('C2C request recorded as pending', { amount: n(req.amount) })
    const beforePay = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', a.id).stock)
    await cardTransferService.pay({ id: n(req.id), paidAmount: 90_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `N${id}-FIRST` })
    const paid = seed.one('SELECT status,paidAmount FROM "CardTransferRequest" WHERE id=?', req.id)
    const restock = seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', ret.id)
    assert.equal(paid.status, 'PAID'); assert.equal(n(restock.restockedQty), 1); a.expected += 1
    mode('one authorized payment finalizes deferred restock', { status: paid.status, amount: n(paid.paidAmount), restockedQty: n(restock.restockedQty) })
    const beforeSecond = await snapshot(); let error = ''
    try { await cardTransferService.pay({ id: n(req.id), paidAmount: 90_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `N${id}-SECOND` }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), beforeSecond); mode('duplicate payout attempt rejected without mutation', { error, mutationFree: true })
  } else if (id === 204) {
    const a = variant('C2C-exchange-source', 100_000), b = variant('C2C-exchange-target', 75_000), root = await createSale([line(a)], { cash: 100_000 })
    const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'C2C-exchange-deferred-restock', mode: 'C2C' })
    assert.equal(n(op.cardToCard), 25_000); mode('negative exchange creates 25k pending C2C request', { amount: n(op.cardToCard), restockPending: op.restockPending })
    const req = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', op.returnId)
    assert.equal(req.status, 'PENDING'); await cardTransferService.pay({ id: n(req.id), paidAmount: 25_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `N${id}-EX` })
    const restock = seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', op.returnId)
    assert.equal(n(restock.restockedQty), 1); a.expected += 1; await checkpoint('C2C exchange paid and stock released')
    mode('manager payout releases one returned source unit', { restockedQty: n(restock.restockedQty) })
    mode('cash/POS ledgers remain unchanged by off-ledger C2C payout', { cash: expected.cash, card: expected.card, blue: expected.cash + expected.card })
  } else if (id === 205) {
    const a = variant('cash-refund-cap-item', 64_000), root = await createSale([line(a)], { cash: 64_000 }), before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: root.items[0].id, qty: 1 }], refundMethod: 'CASH', refundAmount: 70_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before); mode('70k request above 64k official cap rejected', { mutationFree: true })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], amount: 64_000 }); mode('exact 64k official amount accepted', { refund: n(ret.refundAmount) })
  } else if (id === 206) {
    const a = variant('stale-preview-A', 100_000), b = variant('stale-preview-B', 118_000), root = await createSale([line(a)], { cash: 100_000 }), before = await snapshot(); let error = ''
    try { await salesService.createExchange({ userId, shiftId, invoiceId: root.id, lines: [{ saleItemId: root.items[0].id, qty: 1 }], replacements: [line(b)], methodId: cashMethod,
      expectedSettlementDiff: 17_000, idempotencyKey: `nf21-${id}-stale` }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before); mode('stale preview diff rejected with full rollback', { quoted: 17_000, actual: 18_000, mutationFree: true })
    const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'fresh-preview-118k-target' })
    assert.equal(n(op.diff), 18_000); mode('fresh preview/cash retry succeeds', { committedDiff: n(op.diff) })
  } else if (id === 207) {
    const a = variant('multi-code-return-item', 100_000), c1 = await issueCredit(100_000, { multiUse: true, maxUses: 5 }), c2 = await issueCredit(100_000, { multiUse: true, maxUses: 5 })
    const root = await createSale([line(a)], { cash: 50_000, storeCredits: [{ code: c1.code, requestedAmount: 30_000 }, { code: c2.code, requestedAmount: 20_000 }] })
    assert.equal(root.creditApplied, 50_000); mode('two separate source codes fund exact 50k share', { applied: root.creditApplied })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const allocs = seed.rows('SELECT sourceCreditId,amount FROM "CreditReturnAllocation" WHERE returnId=?', ret.id)
    assert.equal(allocs.reduce((s,x)=>s+n(x.amount),0), 50_000); assert.equal(n(ret.sourceCreditRestoredAmount), 50_000)
    mode('both source shares restored to their original code IDs', { restored: n(ret.sourceCreditRestoredAmount), allocations: allocs.length })
    const cashVoucher = seed.one('SELECT amount,expiresAt FROM "StoreCredit" WHERE returnId=? AND id NOT IN (?,?) ORDER BY id LIMIT 1', ret.id, c1.id, c2.id)
    assert.ok(cashVoucher); assert.equal(n(cashVoucher.amount), 50_000); assert.equal(cashVoucher.expiresAt, null)
    mode('50k real-money share issued as separate non-expiring voucher', { amount: n(cashVoucher.amount), expiresAt: cashVoucher.expiresAt })
  } else if (id === 208) {
    const a = variant('return-voucher-void-item', 55_000), root = await createSale([line(a)], { cash: 55_000 })
    const ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const c = seed.one('SELECT id,amount,status FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(c); mode('unused return voucher exists', { amount: n(c.amount), status: c.status })
    const voided = await salesService.returnDelete({ id: n(ret.id), userId, reason: 'لغو اعتبار برگشتی N208', panelPassword: DEFAULT_MANAGER_PASSWORD })
    const after = seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', ret.id), credit = seed.one('SELECT status FROM "StoreCredit" WHERE id=?', c.id)
    assert.ok(voided.voided); assert.ok(after.voidedAt); assert.equal(credit.status, 'CANCELED'); a.expected -= 1
    await checkpoint('return void reverses restock and cancels unused credit')
    mode('voiding unused credit reverses stock and cancels the code', { returnVoided: !!after.voidedAt, credit: credit.status, stock: a.expected })
  } else if (id === 209) {
    const a = variant('spent-return-voucher-source', 40_000), b = variant('spent-return-voucher-purchase', 40_000)
    const root = await createSale([line(a)], { cash: 40_000 }), ret = await createReturn({ invoiceId: root.id, item: root.items[0], method: 'STORE_CREDIT' })
    const c = seed.one('SELECT id,code,amount FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', ret.id)
    assert.ok(c); mode('return created a 40k voucher', { amount: n(c.amount) })
    const sale = await createSale([line(b)], { storeCredits: [{ code: c.code, requestedAmount: 40_000 }] }); assert.equal(sale.creditApplied, 40_000)
    mode('voucher spent on fully settled later sale', { applied: sale.creditApplied })
    const before = await snapshot(); let error = ''
    try { await salesService.returnDelete({ id: n(ret.id), userId, reason: 'لغو اعتبار خرج‌شده N209', panelPassword: DEFAULT_MANAGER_PASSWORD }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before)
    mode('void is rejected after voucher spend; all ledgers stay unchanged', { mutationFree: true, error })
  } else if (id === 210) {
    const a = variant('exchange-then-return-source', 85_000), b = variant('exchange-then-return-target', 95_000), root = await createSale([line(a)], { cash: 85_000 })
    const op = await exchange({ invoiceId: root.id, items: root.items, replacements: [line(b)], label: 'consume-source-before-return-retry' })
    assert.equal(n(op.diff), 10_000); mode('source item consumed by valid exchange', { diff: n(op.diff) })
    const before = await snapshot(); let error = ''
    try { await salesService.createReturn({ userId, shiftId, invoiceId: root.id, full: false, lines: [{ saleItemId: root.items[0].id, qty: 1 }], refundMethod: 'CASH', refundAmount: 85_000 }) }
    catch (e) { error = String(e?.message ?? e) }
    assert.ok(error); assert.deepEqual(await snapshot(), before)
    mode('second return from consumed source rejected without mutation', { mutationFree: true, error })
  }
  await checkpoint(`final N${id} reconciliation`)
  result.status = 'PASS'
} catch (e) {
  result.status = 'FAIL'; result.failure = { message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
} finally {
  result.modeCount = modes.length
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, actual: rawPhysical(),
    blue: n(await physicalMovementForCustodyShift(shiftId)), stock: variants.map(v => ({ name: v.name, expected: v.expected,
      actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), credits: seed.count('StoreCredit'),
    checks: seed.count('Payment', `createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`, shiftId) }
  const out = resolve(process.cwd(), 'reports', 'deep-e2e-new-batch-191-210')
  mkdirSync(out, { recursive: true }); const stem = `N${id}`
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const md = [`# سناریوی N${id}`, '', `**وضعیت:** ${result.status}`, `**حالت‌های مستقل ثبت‌شده:** ${result.modeCount}`, `**SQLite ایزوله:** ${process.env.HARNESS_DB}`, '',
    '## Trace', ...events.map(e => `- ${e.operation ?? e.label}: ${JSON.stringify(e)}`),
    ...modes.map((m,i) => `- حالت ${i+1}: ${m.key} ${JSON.stringify(m)}`), '', '## تطبیق نهایی',
    `- موردانتظار: ${JSON.stringify(result.final.expected)}`, `- واقعی: ${JSON.stringify(result.final.actual)}؛ blue=${result.final.blue}`,
    `- موجودی/دفتر: ${JSON.stringify(result.final.stock)}`,
    `- فاکتور=${result.final.invoices}؛ برگشت/تعویض=${result.final.returns}؛ اعتبار=${result.final.credits}؛ چک=${result.final.checks}`,
    `- خطا: ${JSON.stringify(result.failure ?? null)}`, '', 'فقط service-layer و SQLite موقت؛ دیتابیس واقعی و staging استفاده نشدند.']
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
  if (result.status === 'FAIL') process.exitCode = 1
}
