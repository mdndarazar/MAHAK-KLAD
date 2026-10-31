/** Focused financial diagnostic for store-credit -> return/exchange entitlement.
 * All modes exercise REAL services on a separate throwaway SQLite fixture;
 * no customer DB, code/barcode value, secrets, or printer is accessed.
 * Classification distinguishes independent root causes from variants of a
 * single guard. This probe DOES NOT change application behavior.
 *
 * HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-family-2026-10-17.mjs <mode>
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2]
const modes = new Set(['even-all-gift', 'even-mixed', 'more-mixed', 'partial-mixed', 'return-code-even',
  'prior-partial-return', 'gift-debt-first-control', 'orphan-exchange-credit',
  'orphan-exchange-return-code', 'orphan-child-with-code'])
if (!modes.has(mode)) throw new Error('Choose mode: ' + [...modes].join(', '))
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-credit-exchange-family-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD: password } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('synthetic entitlement diagnostic')
const shiftId = seed.insert('Shift', { name: 'synthetic shift', number: 1, userId,
  openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const cashMethod = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
const category = seed.category('synthetic entitlement category')
function variant(price) {
  const id = seed.variant(seed.product('synthetic product', category))
  sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=100 WHERE id=?').run(price, id)
  return id
}
const line = (variantId, price) => ({ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 })
const item = (invoiceId, variantId) => seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', invoiceId, variantId).id
const sale = (lines, cash, credit = null, key = 'synthetic-spend') => salesService.create({
  userId, shiftId, lines, payments: cash > 0 ? [{ methodId: cashMethod, amount: cash, destination: 'CASH' }] : [],
  ...(credit ? { storeCreditCode: credit.code, storeCreditAmount: credit.spend,
    storeCreditIdempotencyKey: key } : {})
})
const manual = (amount, spend) => db.$transaction(tx => issueStoreCredit(tx, {
  amount, source: 'MANUAL', multiUse: false, maxUses: 1, days: 30,
  userId, note: 'isolated synthetic gift'
})).then(credit => ({ ...credit, spend }))
const exchange = (invoiceId, saleItemId, newVariant, newPrice, refundMode, extra = {}) =>
  salesService.createExchange({ invoiceId, lines: [{ saleItemId, qty: 1 }],
    replacements: [line(newVariant, newPrice)], userId, shiftId,
    ...(refundMode ? { refundMode } : {}),
    ...(newPrice > Number(seed.one('SELECT lineTotal FROM "SaleInvoiceItem" WHERE id=?', saleItemId).lineTotal)
      ? { methodId: cashMethod, destination: 'CASH' } : {}), ...extra })
const ret = (invoiceId, saleItemId, method, amount, full = false) =>
  salesService.createReturn({ invoiceId, lines: [{ saleItemId, qty: 1 }],
    full, refundMethod: method, refundAmount: amount, userId, shiftId })
const purge = ids => salesService.purge({ invoiceIds: ids, userId, restoreStock: true,
  managerPassword: password, managerVerified: true, overrideReason: 'isolated financial diagnostic' })
async function attempt(fn) {
  try { return { ok: true, value: await fn() } }
  catch (err) { return { ok: false, error: String(err?.message ?? err).split('\n')[0] } }
}
function output(classification, evidence) {
  console.log(JSON.stringify({ mode, classification, evidence }))
}
const creditRow = id => seed.one('SELECT id, status, amount, usedAmount, multiUse, source, returnId, sourceInvoiceId FROM "StoreCredit" WHERE id=?', id)
const counts = invoiceId => ({ returns: seed.count('SaleReturn', 'invoiceId=? AND voidedAt IS NULL', invoiceId),
  children: seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', invoiceId),
  credits: seed.count('StoreCredit') })

if (['even-all-gift', 'even-mixed', 'more-mixed', 'partial-mixed', 'return-code-even', 'prior-partial-return'].includes(mode)) {
  const two = mode === 'partial-mixed' || mode === 'prior-partial-return'
  const first = variant(two ? 500_000 : 1_000_000)
  const second = two ? variant(500_000) : null
  const oldLines = two ? [line(first, 500_000), line(second, 500_000)] : [line(first, 1_000_000)]
  const newPrice = mode === 'more-mixed' ? 1_200_000 : mode === 'prior-partial-return' ? 450_000 : two ? 500_000 : 1_000_000
  const newVariant = variant(newPrice)
  let gift
  if (mode === 'return-code-even') {
    const initial = await sale([line(variant(300_000), 300_000)], 300_000)
    const back = await ret(initial.id, seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', initial.id).id,
      'STORE_CREDIT', 300_000, true)
    const created = creditRow(back.storeCredit.id)
    assert.equal(created.source, 'EXCHANGE')
    assert.equal(created.multiUse, 1)
    gift = { ...seed.one('SELECT code FROM "StoreCredit" WHERE id=?', created.id), id: created.id, spend: 300_000 }
  } else {
    const giftAmount = mode === 'even-all-gift' ? 1_000_000 :
      mode === 'prior-partial-return' ? 500_000 : 300_000
    gift = await manual(giftAmount, giftAmount)
  }
  const realCash = mode === 'even-all-gift' ? 0 :
    mode === 'prior-partial-return' ? 500_000 : 700_000
  const original = await sale(oldLines, realCash, gift, `synthetic-${mode}`)
  assert.equal(original.storeCreditApplied, gift.spend)
  let priorReturn = null
  if (mode === 'prior-partial-return') {
    priorReturn = await ret(original.id, item(original.id, second), 'CASH', 250_000)
    assert.equal(priorReturn.creditOpportunity.restored, 250_000)
    assert.equal(priorReturn.refundAmount, 250_000)
  }
  const before = counts(original.id)
  const attempted = await attempt(() => exchange(original.id, item(original.id, first),
    newVariant, newPrice, newPrice < (two ? 500_000 : 1_000_000) ? 'STORE_CREDIT' : null))
  const after = counts(original.id)
  assert.equal(attempted.ok, false)
  assert.match(attempted.error, /تعویضِ خریدی که با اعتبار پرداخت شده/)
  assert.deepEqual(after, before)
  const row = creditRow(gift.id)
  assert.equal(Number(row.usedAmount), gift.spend)
  // Same SKU/prices and return history funded entirely with real cash: the
  // exchange operation itself is supported; the provenance guard is decisive.
  const controlSale = await sale(oldLines, 1_000_000)
  if (mode === 'prior-partial-return')
    await ret(controlSale.id, item(controlSale.id, second), 'CASH', 500_000)
  const control = await attempt(() => exchange(controlSale.id, item(controlSale.id, first),
    newVariant, newPrice, newPrice < (two ? 500_000 : 1_000_000) ? 'STORE_CREDIT' : null))
  const evidence = { bought: 1_000_000,
    giftSpent: gift.spend, realCash,
    exchangedItem: two ? 500_000 : 1_000_000, replacement: newPrice,
    difference: newPrice - (two ? 500_000 : 1_000_000),
    oldCode: { source: row.source, status: row.status, usedAmount: Number(row.usedAmount) },
    priorSimpleReturn: priorReturn ? { giftShare: priorReturn.creditOpportunity.restored,
      realCashRefund: priorReturn.refundAmount,
      pendingGiftBranches: priorReturn.creditOpportunity.pendingDelivery.length } : null,
    before, after, rejected: attempted.error,
    cashControl: { accepted: control.ok, difference: control.ok ? control.value.diff : null,
      issuedCreditAmount: control.ok ? Number(control.value.storeCredit?.amount ?? 0) : 0,
      error: control.ok ? null : control.error } }
  if (mode === 'return-code-even') assert.equal(row.multiUse, 1)
  output('SAME_PROVENANCE_GUARD_REJECTS_VALID_EXCHANGE', evidence)
}

if (mode === 'gift-debt-first-control') {
  const a = variant(500_000), b = variant(500_000)
  const gift = await manual(300_000, 300_000)
  const original = await sale([line(a, 500_000), line(b, 500_000)], 200_000, gift, 'debt-gift')
  const first = await ret(original.id, item(original.id, a), 'NONE', 0)
  assert.equal(first.creditOpportunity.restored, 0)
  assert.equal(first.invoiceRemaining, 0)
  const second = await ret(original.id, item(original.id, b), 'CASH', 200_000, true)
  assert.equal(second.creditOpportunity.restored, 300_000)
  assert.equal(second.refundAmount, 200_000)
  assert.equal(creditRow(gift.id).status, 'ACTIVE')
  output('CONTROL_PASS_DEBT_FIRST_GIFT_AND_CASH', { first: { debtCut: 500_000, credit: 0, cash: 0 },
    second: { credit: 300_000, cash: 200_000 }, originalReactivated: true })
}

if (mode === 'orphan-exchange-credit' || mode === 'orphan-exchange-return-code') {
  const oldPrice = mode === 'orphan-exchange-credit' ? 15_980_000 : 1_000_000
  const newPrice = mode === 'orphan-exchange-credit' ? 15_000_000 : 1_000_000
  const a = variant(oldPrice), b = variant(newPrice)
  const original = await sale([line(a, oldPrice)], oldPrice)
  const ex = await exchange(original.id, item(original.id, a), b, newPrice,
    oldPrice > newPrice ? 'STORE_CREDIT' : null)
  assert.equal(ex.diff, newPrice - oldPrice)
  const originalCreditId = ex.storeCredit?.id ?? null
  const before = originalCreditId ? creditRow(originalCreditId) : null
  const canceled = await attempt(() => purge([original.id]))
  const parent = seed.one('SELECT status, paidTotal, voidedAt FROM "SaleInvoice" WHERE id=?', original.id)
  const child = seed.one('SELECT status, paidTotal, voidedAt FROM "SaleInvoice" WHERE id=?', ex.exchangeInvoiceId)
  const parentPayment = seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', original.id).n
  // A canceled parent's cached paidTotal must NEVER be treated as fresh bank/cash
  // evidence for a descendant. The child has only EXCHANGE_CREDIT, not cash.
  const childFunding = seed.rows(`SELECT m.kind, p.amount FROM "Payment" p
    JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? AND p.voidedAt IS NULL`, ex.exchangeInvoiceId)
    .map(row => ({ kind: row.kind, amount: Number(row.amount) }))
  if (mode === 'orphan-exchange-credit') {
    const credit = originalCreditId ? creditRow(originalCreditId) : null
    const valid = originalCreditId ? await attempt(() => findRedeemable(db,
      seed.one('SELECT code FROM "StoreCredit" WHERE id=?', originalCreditId).code)) : null
    output('ORPHANED_EXCHANGE_DIFFERENCE_CREDIT_IF_PURGE_SUCCEEDS', {
      purgeSucceeded: canceled.ok, purgeError: canceled.error, parentStatus: parent.status,
      parentLivePayments: parentPayment, parentCachedPaidTotal: Number(parent.paidTotal),
      childStatus: child.status, childVoided: child.voidedAt != null, childFunding,
      exchangeDiff: ex.diff, codeBefore: before && { id: before.id, status: before.status, amount: Number(before.amount) },
      codeAfter: credit && { id: credit.id, status: credit.status, amount: Number(credit.amount) },
      barcodeSpendable: valid?.ok })
  } else {
    const childReturn = await attempt(() => ret(ex.exchangeInvoiceId,
      seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', ex.exchangeInvoiceId).id,
      'STORE_CREDIT', 1_000_000, true))
    const issued = childReturn.ok ? creditRow(childReturn.value.storeCredit.id) : null
    const code = issued ? seed.one('SELECT code FROM "StoreCredit" WHERE id=?', issued.id).code : null
    const spendable = code ? await attempt(() => findRedeemable(db, code)) : null
    let spent = null
    if (spendable?.ok) {
      const following = await sale([line(variant(1_000_000), 1_000_000)], 0,
        { code, spend: 1_000_000 }, 'orphan-descendant-code-spend')
      spent = { invoiceId: following.id, applied: following.storeCreditApplied,
        usedAmount: Number(creditRow(issued.id).usedAmount) }
    }
    output('ORPHANED_EXCHANGE_RETURN_MINT_IF_PURGE_SUCCEEDS', {
      purgeSucceeded: canceled.ok, purgeError: canceled.error, parentStatus: parent.status,
      parentLivePayments: parentPayment, parentCachedPaidTotal: Number(parent.paidTotal),
      childStatus: child.status, childVoided: child.voidedAt != null, childFunding,
      childReturnAccepted: childReturn.ok, error: childReturn.error,
      issuedBarcode: issued && { id: issued.id, amount: Number(issued.amount), status: issued.status,
        multiUse: issued.multiUse, sourceInvoiceId: issued.sourceInvoiceId },
      barcodeSpendableBefore: spendable?.ok ?? false, redeemedInNextSale: spent })
  }
}

if (mode === 'orphan-child-with-code') {
  const a = variant(15_980_000), b = variant(15_000_000)
  const original = await sale([line(a, 15_980_000)], 15_980_000)
  const ex = await exchange(original.id, item(original.id, a), b, 15_000_000, 'STORE_CREDIT')
  assert.equal(ex.diff, -980_000)
  const before = creditRow(ex.storeCredit.id)
  const canceled = await attempt(() => purge([ex.exchangeInvoiceId]))
  const parent = seed.one('SELECT status, voidedAt FROM "SaleInvoice" WHERE id=?', original.id)
  const child = seed.one('SELECT status, voidedAt FROM "SaleInvoice" WHERE id=?', ex.exchangeInvoiceId)
  const credit = creditRow(ex.storeCredit.id)
  const back = seed.one('SELECT id, voidedAt FROM "SaleReturn" WHERE invoiceId=? AND kind=?', original.id, 'EXCHANGE')
  const spendable = await attempt(() => findRedeemable(db,
    seed.one('SELECT code FROM "StoreCredit" WHERE id=?', ex.storeCredit.id).code))
  output('EXCHANGE_CHILD_PURGE_WITH_ACTIVE_CODE', { purgeSucceeded: canceled.ok,
    purgeError: canceled.error, parentStatus: parent.status, childStatus: child.status,
    parentReturnStillActive: back.voidedAt == null,
    codeBefore: { amount: Number(before.amount), status: before.status },
    codeAfter: { amount: Number(credit.amount), status: credit.status }, spendable: spendable.ok })
}
