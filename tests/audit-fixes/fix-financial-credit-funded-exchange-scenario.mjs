/** Exact S1 production scenario: 15,980,000-rial sale paid with a 2,000,000-rial
 * store-credit barcode plus 13,980,000 real cash; exchange for 15,000,000 and
 * verify exact 15M carry plus rooted B/N residuals. A cash-only control remains
 * on the legacy generic-credit path; unresolved tenders stay fail-closed.
 * No customer database, printer or credential output is involved.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-funded-exchange-scenario.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-funded-exchange-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { getCurrentExchangeFundingSources, getCurrentSaleFundingSources } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { allocateExchangeFundingProportionalFloor } = await import('../../src/shared/exchangeFundingAllocation.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('funded-exchange-scenario')
const categoryId = seed.category('two exact prices')
const variant = (name, price) => {
  const id = seed.variant(seed.product(name, categoryId))
  sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=? WHERE id=?').run(price, id)
  return id
}
const source = variant('original item', 15_980_000)
const replacement = variant('replacement item', 15_000_000)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const storeCreditMethodId = seed.insert('PaymentMethod', {
  key: 'STORE_CREDIT', label: 'Store credit', kind: 'STORE_CREDIT', isActive: 1
})
const customMethodId = seed.insert('PaymentMethod', {
  key: 'C2C', label: 'Unresolved card transfer', kind: 'CUSTOM', isActive: 1
})
const chequeMethodId = seed.insert('PaymentMethod', {
  key: 'CHEQUE', label: 'Cheque', kind: 'CUSTOM', isActive: 1
})
const shiftId = seed.insert('Shift', { name: 'shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'original credit in exchange test', userId
}))
const purchase = (cash, key, credit = null, paymentMethodId = methodId, destination = 'CASH') => salesService.create({
  userId, shiftId,
  lines: [{ variantId: source, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
  payments: [{ methodId: paymentMethodId, amount: cash, destination }],
  ...(credit ? { storeCreditCode: credit.code, storeCreditAmount: 2_000_000,
    storeCreditIdempotencyKey: key } : {})
})
const original = await purchase(13_980_000, 'scenario-gift-2m', gift)
assert.equal(original.grandTotal, 15_980_000)
assert.equal(original.storeCreditApplied, 2_000_000)
assert.equal(seed.one('SELECT paidTotal FROM "SaleInvoice" WHERE id=?', original.id).paidTotal, 15_980_000)
const originalItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', original.id).id
const redeemed = seed.one('SELECT amount, reversedAt, compensatedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', original.id)
assert.equal(redeemed.amount, 2_000_000)
assert.equal(redeemed.reversedAt, null)
assert.equal(redeemed.compensatedAt, null)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
const originalFunding = seed.rows(`SELECT id, kind, amount, shareId, rootShareId, sourceCreditId
  FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND eventKey LIKE ? ORDER BY id`,
  original.id, `sale:${original.id}:r1:%`).filter((row) => row.kind.startsWith('SOURCE_'))
assert.deepEqual(originalFunding.map(({ kind, amount, sourceCreditId }) => ({ kind, amount, sourceCreditId }))
  .sort((a, b) => a.kind.localeCompare(b.kind)), [
  { kind: 'SOURCE_CASH', amount: 13_980_000, sourceCreditId: null },
  { kind: 'SOURCE_GIFT', amount: 2_000_000, sourceCreditId: gift.id }
], 'the actual create transaction keeps the 2m gift separate from 13.98m real cash')
assert.equal(originalFunding.find((row) => row.kind === 'SOURCE_GIFT')?.rootShareId, `credit:${gift.id}`)
assert.equal(originalFunding.reduce((sum, row) => sum + Number(row.amount), 0), original.grandTotal)
const provenSaleFunding = await getCurrentSaleFundingSources(db, original.id)
assert.equal(provenSaleFunding.unresolved.length, 0, 'the existing ordinary-sale reader proves all S1 source rows')
const s1Allocation = allocateExchangeFundingProportionalFloor({
  replacementTotal: 15_000_000,
  sources: provenSaleFunding.sources.map((source) => ({
    sourceEventId: Number(source.event.id),
    sourceKind: source.sourceKind,
    available: source.available
  }))
})
assert.deepEqual(s1Allocation.allocations.map(({ sourceKind, carry, remainder }) => ({ sourceKind, carry, remainder })), [
  { sourceKind: 'SOURCE_GIFT', carry: 1_877_346, remainder: 122_654 },
  { sourceKind: 'SOURCE_CASH', carry: 13_122_654, remainder: 857_346 }
], 'the FINAL-DESIGN S1 values are derived from the existing proven root-source reader')
assert.equal(s1Allocation.giftCarry + s1Allocation.cashCarry, 15_000_000)
assert.equal(s1Allocation.allocations.reduce((sum, row) => sum + row.remainder, 0), 980_000)
const stockBefore = seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement)
const attemptedExchange = (invoiceId, saleItemId) => salesService.createExchange({
  invoiceId, lines: [{ saleItemId, qty: 1 }], replacements: [{ variantId: replacement, qty: 1 }],
  refundMode: 'STORE_CREDIT', managerPassword: DEFAULT_MANAGER_PASSWORD, userId, shiftId
})
const assertExchangeGateHasNoEffects = async (invoiceId, saleItemId, label) => {
  const before = {
    returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', invoiceId).n,
    children: seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', invoiceId).n,
    payments: seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=?', invoiceId).n,
    redemptions: seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId=?', invoiceId).n,
    fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', invoiceId).n,
    cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
    credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
    stock: seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement)
  }
  await assert.rejects(attemptedExchange(invoiceId, saleItemId), (error) =>
    /تعویضِ این فاکتور|lineage فرزند/iu.test(String(error?.message ?? '')), label)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', invoiceId).n, before.returns)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', invoiceId).n, before.children)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "Payment" WHERE invoiceId=?', invoiceId).n, before.payments)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId=?', invoiceId).n, before.redemptions)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?', invoiceId).n,
    before.fundingEvents)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n, before.cashMovements)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n, before.credits)
  assert.deepEqual(seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement),
    before.stock, 'fail-closed evidence gate must not change either inventory balance')
}
const s1Exchange = await salesService.createExchange({
  invoiceId: original.id, lines: [{ saleItemId: originalItemId, qty: 1 }],
  replacements: [{ variantId: replacement, qty: 1, unitPrice: 15_000_000, discount: 0, tax: 0 }],
  refundMode: 'S1_RESIDUAL_RIGHTS', userId, shiftId
})
assert.equal(s1Exchange.returnTotal, 15_980_000)
assert.equal(s1Exchange.exchangeTotal, 15_000_000)
assert.equal(s1Exchange.diff, -980_000)
assert.equal(s1Exchange.settlement, 'S1_RESIDUAL_RIGHTS')
assert.equal(s1Exchange.storeCredit, null, 'no general-purpose 980k credit is issued')
assert.deepEqual(s1Exchange.residualRights.rights.map(({ rightKind, amount }) => ({ rightKind, amount })), [
  { rightKind: 'B', amount: 122_654 }, { rightKind: 'N', amount: 857_346 }
])
const giftAfter = seed.one('SELECT status, usedAmount FROM "StoreCredit" WHERE id=?', gift.id)
assert.equal(giftAfter.status, 'USED', 'original 2m barcode is NOT reactivated')
assert.equal(giftAfter.usedAmount, 2_000_000)
await assert.rejects(() => findRedeemable(db, gift.code), (error) =>
  error?.category === 'NOT_REDEEMABLE' || /مصرف شده/.test(String(error?.message ?? '')),
  'credit lookup must not silently accept the already spent original barcode')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', original.id).reversedAt, null)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', original.id).n, 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', original.id).n, 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit" WHERE exchangeResidualRightKey IS NOT NULL').n, 2)
const s1StockAfter = seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement)
assert.equal(s1StockAfter[0].stock, stockBefore[0].stock, 'returned source stock remains pending until goods receipt')
assert.equal(s1StockAfter[1].stock, stockBefore[1].stock - 1, 'replacement stock is deducted exactly once')
console.log('✓ mixed S1 source 15,980,000 = 2,000,000 gift + 13,980,000 cash; exact carry 15M and B/N residuals; original gift stays USED')

// Control: the same two prices with 100% cash, to distinguish an arithmetic
// error from the explicit provenance guard above. This is NOT the owner's
// mixed-payment scenario and must never be reported as if it succeeded there.
const cashOnly = await purchase(15_980_000, 'cash-only-control')
const cashItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', cashOnly.id).id
const control = await attemptedExchange(cashOnly.id, cashItemId)
assert.equal(control.returnTotal, 15_980_000)
assert.equal(control.exchangeTotal, 15_000_000)
assert.equal(control.diff, -980_000)
assert.equal(control.settlement, 'CREDIT')
assert.equal(control.storeCredit?.amount, 980_000)
assert.equal(seed.one('SELECT amount FROM "StoreCredit" WHERE id=?', control.storeCredit.id).amount, 980_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', gift.id).status, 'USED')
console.log('✓ all-cash control: 980,000-rial difference issues a new code; does NOT demonstrate that mixed-credit exchange works')

// An exchange invoice is funded by EXCHANGE_CREDIT (returned goods value), not
// by real cash. Until downstream child-lineage transfer is integrated, it must
// not be treated as a fresh cash-funded source for a second exchange.
const controlChildItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', control.exchangeInvoiceId).id
const unjournaledChildFunding = await getCurrentExchangeFundingSources(db, control.exchangeInvoiceId)
assert.equal(unjournaledChildFunding.snapshotExists, false)
assert.ok(unjournaledChildFunding.unresolved.some((row) => row.kind === 'MISSING_EXCHANGE_TRANSFER_SNAPSHOT'))
assert.equal(unjournaledChildFunding.sources.length, 0,
  'the EXCHANGE_CREDIT payment cannot replace the missing parent-to-child transfer lineage')
await assertExchangeGateHasNoEffects(control.exchangeInvoiceId, controlChildItemId,
  'an EXCHANGE_CREDIT child requires its complete parent-funding lineage')
const exchangeCreditMethodId = seed.one('SELECT id FROM "PaymentMethod" WHERE key=?', 'EXCHANGE_CREDIT').id
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('CASH', exchangeCreditMethodId)
await assertExchangeGateHasNoEffects(control.exchangeInvoiceId, controlChildItemId,
  'the reserved EXCHANGE_CREDIT method key remains a signal if its kind is malformed')
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('EXCHANGE_CREDIT', exchangeCreditMethodId)
console.log('✓ downstream EXCHANGE_CREDIT child and malformed reserved method key stay quarantined')

const unresolvedTenderSale = await purchase(15_980_000, 'unresolved-custom-tender', null, customMethodId, 'MANAGER')
const unresolvedTenderItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', unresolvedTenderSale.id).id
assert.ok(seed.one(`SELECT id FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=?
  AND kind='SOURCE_UNKNOWN' ORDER BY id DESC LIMIT 1`, unresolvedTenderSale.id),
  'a CUSTOM payment persisted at sale is explicitly quarantined as SOURCE_UNKNOWN')
await assertExchangeGateHasNoEffects(unresolvedTenderSale.id, unresolvedTenderItem,
  'a CUSTOM/C2C tender has no proven cash/card source and cannot be converted to cash or exchange credit')
console.log('✓ unsupported CUSTOM/C2C tender is not inferred to be cash or refund backing')

const pendingChequeSale = await purchase(15_980_000, 'pending-cheque-tender')
const pendingChequeItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', pendingChequeSale.id).id
assert.equal(sql.prepare(`UPDATE "Payment" SET methodId=?, kind='CHEQUE', chequeStatus='PENDING'
  WHERE invoiceId=? AND voidedAt IS NULL`).run(chequeMethodId, pendingChequeSale.id).changes, 1)
await assertExchangeGateHasNoEffects(pendingChequeSale.id, pendingChequeItem,
  'an uncleared cheque is not received cash and cannot back an exchange refund')
console.log('✓ pending cheque remains unresolved, not cash or exchange-credit backing')

const zeroPaymentSale = await purchase(15_980_000, 'zero-payment-row')
const zeroPaymentItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', zeroPaymentSale.id).id
assert.equal(sql.prepare('UPDATE "Payment" SET amount=0 WHERE invoiceId=? AND voidedAt IS NULL')
  .run(zeroPaymentSale.id).changes, 1)
await assertExchangeGateHasNoEffects(zeroPaymentSale.id, zeroPaymentItem,
  'a zero-value Payment row cannot establish funding lineage')
console.log('✓ zero-value Payment row is not accepted as funding proof')

// Fail closed on all stored credit signals, not just Payment.storeCreditId.
const methodOnlySale = await purchase(15_980_000, 'method-only-credit-signal')
const methodOnlyItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', methodOnlySale.id).id
const methodUpdate = sql.prepare('UPDATE "Payment" SET methodId=? WHERE invoiceId=? AND voidedAt IS NULL')
  .run(storeCreditMethodId, methodOnlySale.id)
assert.equal(methodUpdate.changes, 1)
assert.equal(seed.one('SELECT storeCreditId FROM "Payment" WHERE invoiceId=?', methodOnlySale.id).storeCreditId, null)
await assertExchangeGateHasNoEffects(methodOnlySale.id, methodOnlyItem,
  'a live STORE_CREDIT method is a credit signal even if the Payment has no credit ID')
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('CASH', storeCreditMethodId)
await assertExchangeGateHasNoEffects(methodOnlySale.id, methodOnlyItem,
  'the reserved STORE_CREDIT method key remains a signal if its kind is malformed')
sql.prepare('UPDATE "PaymentMethod" SET kind=? WHERE id=?').run('STORE_CREDIT', storeCreditMethodId)
console.log('✓ STORE_CREDIT kind and reserved method key are blocked before any return, barcode or stock effects')

const redemptionOnlySale = await purchase(15_980_000, 'redemption-only-credit-signal')
const redemptionOnlyItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', redemptionOnlySale.id).id
const orphanCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 100, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'orphan redemption gate fixture', userId
}))
seed.insert('StoreCreditRedemption', {
  creditId: orphanCredit.id, code: orphanCredit.code, amount: 100, remainderAfter: 0,
  invoiceId: redemptionOnlySale.id, paymentId: null,
  idempotencyKey: 'orphan-active-redemption-exchange-gate', expiryCaptured: false,
  expiryAtRedeem: null
})
await assertExchangeGateHasNoEffects(redemptionOnlySale.id, redemptionOnlyItem,
  'an active persisted redemption is a credit signal even when it has no linked Payment')
console.log('✓ orphan active redemption remains quarantined; its credit cannot silently become exchange cash')

const reversedRedemptionSale = await purchase(15_980_000, 'reversed-redemption-control')
const reversedRedemptionItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', reversedRedemptionSale.id).id
seed.insert('StoreCreditRedemption', {
  creditId: orphanCredit.id, code: orphanCredit.code, amount: 100, remainderAfter: 0,
  invoiceId: reversedRedemptionSale.id, paymentId: null,
  idempotencyKey: 'reversed-redemption-exchange-gate-control', expiryCaptured: false,
  expiryAtRedeem: null, reversedAt: new Date(), reversedReason: 'fixture: already reversed'
})
const reversedRedemptionControl = await attemptedExchange(reversedRedemptionSale.id, reversedRedemptionItem)
assert.equal(reversedRedemptionControl.returnTotal, 15_980_000)
assert.equal(reversedRedemptionControl.exchangeTotal, 15_000_000)
assert.equal(reversedRedemptionControl.diff, -980_000)
assert.equal(reversedRedemptionControl.storeCredit?.amount, 980_000)
console.log('✓ reversed redemption history alone does not block a persisted all-cash exchange')
