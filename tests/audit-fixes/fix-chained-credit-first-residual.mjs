/**
 * Adversarial chained-exchange audit: a rooted barcode is consumed in A,
 * carried through B, partly restored when B->C becomes cheaper, then consumed
 * as the tender for C->D. D->E must recover the exact two source-code shares
 * and the real-money remainder without mixing them. Also verifies chained C2C
 * stock/blue behavior. The early-code probe injects a DB-known code directly;
 * it characterizes backend behavior, not ordinary UI visibility before printing.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-chained-credit-first-residual.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-chain-credit-audit-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('chained-credit-lineage-audit')
const shiftId = seed.insert('Shift', {
  name: 'chain-credit-lineage', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethod = seed.insert('PaymentMethod', {
  key: 'CHAIN-LINEAGE-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('chain-credit-lineage')
const productId = seed.product('chain-credit-lineage goods', categoryId)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `CHAIN-LINEAGE-${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const itemId = (invoiceId) => Number(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1', invoiceId
).id)
const stock = (variantId) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const issueManual = async (amount) => {
  const credit = await storeCreditService.issueManual({
    amount, multiUse: false, carryRemainder: false, userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  return { id: credit.id, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', credit.id).code }
}

// A(15M = 13M cash + 2M gift) -> B(15M) -> C(14M): the only 1M surplus
// belongs to the gift source; the original cash source is fully retained.
const rootGift = await issueManual(2_000_000)
const [aVariant, bVariant, cVariant, dVariant, eVariant] = [
  15_000_000, 15_000_000, 14_000_000, 16_000_000, 2_000_000
].map(variant)
const blueStart = await physicalMovementForCustodyShift(shiftId)
const root = await salesService.create({
  userId, shiftId, lines: [line(aVariant, 15_000_000)],
  payments: [{ methodId: cashMethod, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: rootGift.code, storeCreditIdempotencyKey: 'chain-a-root-credit-0001'
})
const childB = await salesService.createExchange({
  userId, shiftId, invoiceId: root.id,
  lines: [{ saleItemId: itemId(root.id), qty: 1 }], replacements: [line(bVariant, 15_000_000)]
})
assert.equal(childB.diff, 0)
const childC = await salesService.createExchange({
  userId, shiftId, invoiceId: childB.exchangeInvoiceId,
  lines: [{ saleItemId: itemId(childB.exchangeInvoiceId), qty: 1 }],
  replacements: [line(cVariant, 14_000_000)], refundMode: 'CASH'
})
assert.equal(childC.diff, -1_000_000)
assert.equal(childC.sourceCreditRestoredAmount, 1_000_000)
assert.equal(childC.realMoneyRefundAmount, 0)
assert.equal(childC.cashRefunded, 0)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootGift.id).status, 'USED')
const childCSuccessor = seed.one('SELECT id,code,amount,status,printCount FROM "StoreCredit" WHERE returnId=?', childC.returnId)
assert.equal(Number(childCSuccessor.amount), 1_000_000)
assert.equal(childC.sourceCreditSuccessors.length, 1)
assert.equal(Object.hasOwn(childC.sourceCreditSuccessors[0], 'code'), false,
  'normal exchange result does not expose the redeemable code')
assert.notEqual(childCSuccessor.id, rootGift.id)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', childCSuccessor.id).status, 'ACTIVE')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 13_000_000,
  'the 1M noncash source return does not reduce the 13M actual cash receipt')

// C->D costs 2M more. The 1M successor from C is consumed first; exactly 1M
// additional cash is received. That barcode is still unprinted at this point.
const childD = await salesService.createExchange({
  userId, shiftId, invoiceId: childC.exchangeInvoiceId,
  lines: [{ saleItemId: itemId(childC.exchangeInvoiceId), qty: 1 }],
  replacements: [line(dVariant, 16_000_000)],
  exchangeCreditCode: childCSuccessor.code,
  idempotencyKey: 'chain-c-to-d-successor-credit-0001',
  methodId: cashMethod
})
assert.equal(childD.diff, 2_000_000)
assert.equal(childD.barcodeCreditApplied, 1_000_000)
assert.equal(childD.cashDue, 1_000_000)
assert.equal(childD.cashReceived, 1_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', childCSuccessor.id).status, 'USED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', childCSuccessor.id).usedAmount), 1_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 14_000_000)

// D->E is much cheaper. The 13M difference must be split from D's actual
// source lineage: 2M rooted/noncash codes + 11M real cash, with distinct codes.
const childE = await salesService.createExchange({
  userId, shiftId, invoiceId: childD.exchangeInvoiceId,
  lines: [{ saleItemId: itemId(childD.exchangeInvoiceId), qty: 1 }],
  replacements: [line(eVariant, 2_000_000)], refundMode: 'CASH'
})
assert.equal(childE.diff, -14_000_000)
assert.equal(childE.sourceCreditRestoredAmount, 2_000_000)
assert.equal(childE.realMoneyRefundAmount, 12_000_000)
assert.equal(childE.cashRefunded, 12_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', rootGift.id).status, 'USED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', childCSuccessor.id).status, 'USED')
const childESuccessors = seed.rows('SELECT id,code,amount,status,printCount,sourceInvoiceId FROM "StoreCredit" WHERE returnId=? ORDER BY id', childE.returnId)
assert.equal(childESuccessors.length, 2, 'each source barcode produces its own successor')
assert.equal(childE.sourceCreditSuccessors.every((row) => !Object.hasOwn(row, 'code')), true,
  'normal exchange result does not expose the successor codes')
assert.deepEqual(childESuccessors.map((row) => Number(row.amount)), [1_000_000, 1_000_000])
assert.equal(new Set(childESuccessors.map((row) => Number(row.sourceInvoiceId))).size, 1)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 2_000_000,
  '13M cash in + 1M cash tender - 12M real cash refund; all barcode value excluded')
for (const row of childESuccessors) {
  if (row.status === 'ACTIVE' && Number(row.printCount) === 0)
    console.log(`ℹ backend record ${row.id}: ACTIVE, printCount=0; code is not in the normal exchange response`)
}
// The test harness reads the secret from SQLite to exercise the server-side
// redemption rule. This does not simulate a customer seeing the code in the UI.
assert.equal(Number(childCSuccessor.printCount), 0)
console.log('✓ four exchange actions A→B→C→D→E: source amount, barcode tender, cash remainder, successors, and blue reconcile')
console.log('✓ ordinary exchange responses omit successor codes; this test uses direct DB access for the backend probe')

// Backend characterization only: if an otherwise valid code is already known,
// redemption succeeds even at printCount=0. Customer/UI access is a separate path.
const prematureSale = await salesService.create({
  userId, shiftId, lines: [line(variant(1_000_000), 1_000_000)], payments: [],
  storeCreditCode: childESuccessors[0].code,
  storeCreditIdempotencyKey: 'chain-premature-successor-spend-0001'
})
assert.ok(prematureSale.id)
console.log('✓ backend accepts a known, unprinted code; the test does not establish that ordinary users can see it before printing')
const spentBarcodeRetry = await salesService.create({
  userId, shiftId, lines: [line(variant(1_000_000), 1_000_000)], payments: [],
  storeCreditCode: childCSuccessor.code,
  storeCreditIdempotencyKey: 'chain-spent-successor-replay-0001'
})
assert.equal(spentBarcodeRetry.storeCreditApplied, 0, 'spent parent barcode is rejected without value')
assert.equal(spentBarcodeRetry.storeCreditOutcomes[0].status, 'REJECTED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', childCSuccessor.id).status, 'USED')
console.log('✓ invalid spent parent barcode is reported and never reactivated; only a new successor has independent value')

// Chained full return with mixed sources and C2C: gift residue 2M is kept
// noncash; only 1M real money waits for manager payment.
const c2cShift = seed.insert('Shift', {
  name: 'chain-c2c-release', number: 2, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const c2cGift = await issueManual(2_000_000)
const [c2cA, c2cB, c2cC] = [15_000_000, 15_000_000, 12_000_000].map(variant)
const c2cBlueStart = await physicalMovementForCustodyShift(c2cShift)
const c2cRoot = await salesService.create({
  userId, shiftId: c2cShift, lines: [line(c2cA, 15_000_000)],
  payments: [{ methodId: cashMethod, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: c2cGift.code, storeCreditIdempotencyKey: 'chain-c2c-root-0001'
})
const c2cBInvoice = await salesService.createExchange({
  userId, shiftId: c2cShift, invoiceId: c2cRoot.id,
  lines: [{ saleItemId: itemId(c2cRoot.id), qty: 1 }], replacements: [line(c2cB, 15_000_000)]
})
const c2cChild = await salesService.createExchange({
  userId, shiftId: c2cShift, invoiceId: c2cBInvoice.exchangeInvoiceId,
  lines: [{ saleItemId: itemId(c2cBInvoice.exchangeInvoiceId), qty: 1 }],
  replacements: [line(c2cC, 12_000_000)], refundMode: 'CARD_TO_CARD'
})
assert.equal(c2cChild.diff, -3_000_000)
assert.equal(c2cChild.cardToCard, 1_000_000)
assert.equal(c2cChild.sourceCreditRestoredAmount, 2_000_000)
assert.equal(c2cChild.realMoneyRefundAmount, 1_000_000)
assert.equal(c2cChild.restockPending, true)
assert.equal(c2cChild.pendingRestockQty, 1)
const c2cRequest = seed.one('SELECT id,amount,status FROM "CardTransferRequest" WHERE returnId=?', c2cChild.returnId)
assert.equal(Number(c2cRequest.amount), 1_000_000)
assert.equal(c2cRequest.status, 'PENDING')
const c2cReturnedVariant = c2cBInvoice.exchangeInvoiceId
  ? Number(seed.one('SELECT variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', c2cBInvoice.exchangeInvoiceId).variantId)
  : -1
const c2cReplacementVariant = Number(seed.one('SELECT variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', c2cChild.exchangeInvoiceId).variantId)
assert.equal(stock(c2cReturnedVariant), 19, 'returned item stays unavailable while manager payment is pending')
assert.equal(stock(c2cReplacementVariant), 19, 'replacement stock is deducted immediately')
assert.equal(await physicalMovementForCustodyShift(c2cShift) - c2cBlueStart, 13_000_000,
  'only the original actual-money receipt enters blue')
assert.equal(seed.count('CashMovement', 'refType=? AND refId=?', 'SaleReturn', c2cChild.returnId), 0)
const c2cPaid = await cardTransferService.pay({
  id: Number(c2cRequest.id), paidAmount: 1_000_000,
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId
})
assert.equal(c2cPaid.releasedQty, 1)
assert.equal(Number(seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', c2cChild.returnId).restockPending), 0)
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', c2cRequest.id).status, 'PAID')
assert.equal(stock(c2cReturnedVariant), 20, 'full manager payment releases only the returned item')
assert.equal(stock(c2cReplacementVariant), 19)
assert.equal(await physicalMovementForCustodyShift(c2cShift) - c2cBlueStart, 13_000_000,
  'manager C2C payment does not change blue')
console.log('✓ chained C2C: only actual money is pending; exact payment releases returned stock without blue movement')

// The manager can enter the actual amount transferred even when it differs
// from the visible request. Per the business rule, confirming payment releases
// all physically returned stock; the actual paid amount remains recorded.
const partialShift = seed.insert('Shift', {
  name: 'chain-c2c-partial-payment', number: 3, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const [partialA, partialB, partialC] = [1_000_000, 1_000_000, 800_000].map(variant)
const partialRoot = await salesService.create({
  userId, shiftId: partialShift, lines: [line(partialA, 1_000_000)],
  payments: [{ methodId: cashMethod, amount: 1_000_000, destination: 'CASH' }]
})
const partialBInvoice = await salesService.createExchange({
  userId, shiftId: partialShift, invoiceId: partialRoot.id,
  lines: [{ saleItemId: itemId(partialRoot.id), qty: 1 }], replacements: [line(partialB, 1_000_000)]
})
const partialChild = await salesService.createExchange({
  userId, shiftId: partialShift, invoiceId: partialBInvoice.exchangeInvoiceId,
  lines: [{ saleItemId: itemId(partialBInvoice.exchangeInvoiceId), qty: 1 }],
  replacements: [line(partialC, 800_000)], refundMode: 'CARD_TO_CARD'
})
const partialRequest = seed.one('SELECT id,amount,status FROM "CardTransferRequest" WHERE returnId=?', partialChild.returnId)
assert.equal(Number(partialRequest.amount), 200_000)
const partialReturnedVariant = Number(seed.one(
  'SELECT variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', partialBInvoice.exchangeInvoiceId
).variantId)
assert.equal(stock(partialReturnedVariant), 19, 'returned item remains pending before manager confirms payment')
const partialPaid = await cardTransferService.pay({
  id: Number(partialRequest.id), paidAmount: 100_000,
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId
})
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', partialRequest.id).status, 'PAID')
assert.equal(Number(seed.one('SELECT paidAmount FROM "CardTransferRequest" WHERE id=?', partialRequest.id).paidAmount), 100_000)
assert.equal(partialPaid.releasedQty, 1)
assert.equal(stock(partialReturnedVariant), 20)
console.log('✓ manager sees a 200K request, records the actual 100K transfer, and confirmation releases the returned item')
