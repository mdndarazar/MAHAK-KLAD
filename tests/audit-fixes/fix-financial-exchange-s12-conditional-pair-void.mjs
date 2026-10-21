/** S12 integration: an untouched S11 exchange pair may be voided only with
 * linked reversal evidence for every ledger effect. The offset cheque is
 * restored to its original status, the debt share reopens, B/N rights and
 * transfer pairs are reversed, stock history is appended, and no cash moves.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s12-conditional-pair-void.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s12-pair-void-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { exchangeChequePolicyService } = await import('../../src/main/services/ExchangeChequePolicyService.ts')
const { createManagerCorrectionApprovalSecret } = await import('../../src/main/services/AuthService.ts')
const { getCurrentExchangeFundingSources, getCurrentSaleFundingSources, exchangeFundingBalance } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S12 manager one')
const managerTwoId = seed.user('S12 manager two')
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S12-PIN-ONE'), userId)
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S12-PIN-TWO'), managerTwoId)
const customerId = seed.customer('S12 named customer', '09120000112')
const categoryId = seed.category('S12 category')
const productId = seed.product('S12 item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S12 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S12-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })

const proposal = await exchangeChequePolicyService.propose({
  enabled: true, minimumDelta: 300_000, reason: 'S12 conditional void integration',
  evidenceRef: 'S12-cheque-policy-proposal', proposerUserId: userId, proposerPin: 'S12-PIN-ONE'
})
await exchangeChequePolicyService.approve({
  proposalId: proposal.pending.id, approvingManagerUserId: managerTwoId,
  approvingManagerPin: 'S12-PIN-TWO', approvalReason: 'S12 independent approval',
  approvalEvidenceRef: 'S12-cheque-policy-approval'
})
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 300_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 60, note: 'S12 paid source', userId
}))
const rootVariant = variant('root', 400_000)
const childVariant = variant('child', 500_000)
const grandchildVariant = variant('grandchild', 500_000)
const root = await salesService.create({
  customerId, userId, shiftId, lines: [line(rootVariant, 3, 400_000)],
  payments: [{ methodId: cashMethodId, amount: 900_000, destination: 'CASH' }],
  storeCreditCode: gift.code, storeCreditAmount: 300_000,
  storeCreditIdempotencyKey: 's12-root-gift-redemption-0001'
})
const rootItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', root.id)
const first = await exchange({
  invoiceId: root.id, lines: [{ saleItemId: rootItem.id, qty: 3 }],
  replacements: [line(childVariant, 3, 500_000)],
  chequeNo: 'S12-CHILD-DEBT-300K', bankName: 'Test Bank', dueDateJalali: '1405/08/01',
  userId, shiftId, idempotencyKey: 's12-root-to-child-0001'
})
const childItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
const cheque = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND kind=?', first.exchangeInvoiceId, 'CHEQUE')
const down = await exchange({
  invoiceId: first.exchangeInvoiceId, lines: [{ saleItemId: childItem.id, qty: 3 }],
  replacements: [line(grandchildVariant, 2, 500_000)],
  refundMode: 'S11_DEBT_OFFSET_RIGHTS', userId, shiftId,
  idempotencyKey: 's12-debt-offset-grandchild-0001'
})
assert.deepEqual([down.returnTotal, down.exchangeTotal, down.debtReduction], [1_500_000, 1_000_000, 300_000])
const offset = seed.one('SELECT id, amount, sourceMethodKind FROM "ExchangeFundingEvent" WHERE returnId=? AND kind=?',
  down.returnId, 'DEBT_OFFSET')
assert.deepEqual([offset.amount, offset.sourceMethodKind], [-300_000, 'PENDING'])

const before = {
  exchangeEvents: seed.count('ExchangeFundingEvent', '1=1'),
  rightEvents: seed.count('ExchangeResidualRightEvent', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  stocks: seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id'),
  chequeStatus: seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.id).chequeStatus,
  returnVoid: seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', down.returnId).voidedAt,
  childVoid: seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', down.exchangeInvoiceId).voidedAt
}
assert.equal(before.chequeStatus, 'DEBT_OFFSET')
assert.equal(before.movements, 0)

const result = await salesService.returnDelete({
  id: down.returnId, userId, reason: 'S12 untouched conditional pair void',
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'S12 untouched conditional pair void'
})
assert.equal(result.exchangeVoided, true)
assert.equal(result.exchangeInvoiceId, down.exchangeInvoiceId)
assert.ok(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', down.returnId).voidedAt)
assert.ok(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', down.exchangeInvoiceId).voidedAt)
assert.equal(seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.id).chequeStatus, 'PENDING',
  'void restores the original cheque state; it does not treat the cheque as paid carry')
assert.equal(await exchangeFundingBalance(db, `debt:${first.exchangeInvoiceId}`), 300_000,
  'the linked offset reversal reopens exactly the debt that the exchange had offset')
const offsetReversal = seed.one('SELECT kind, amount, reversesEventId, evidenceKind FROM "ExchangeFundingEvent" WHERE reversesEventId=?', offset.id)
assert.deepEqual([offsetReversal.kind, offsetReversal.amount, offsetReversal.reversesEventId, offsetReversal.evidenceKind],
  ['VOID_DEBT_OFFSET', 300_000, offset.id, 'EXCHANGE_VOID'])
assert.equal(seed.count('ExchangeFundingEvent', `returnId=${down.returnId} AND kind IN ('VOID_TRANSFER_OUT','VOID_TRANSFER_IN')`), 4,
  'both gift and cash carry transfer pairs are reversed append-only')
assert.equal(seed.count('ExchangeResidualRightEvent', `returnId=${down.returnId} AND eventKind='VOIDED'`), 2,
  'both unused B/N rights are canceled with reversals linked to their openings')
assert.equal(seed.count('StockMovement', `refId=${down.exchangeInvoiceId} AND reason='SALE'`), 2,
  'the original replacement deduction and the new positive void movements remain in history')
const fundingAfter = await getCurrentExchangeFundingSources(db, first.exchangeInvoiceId)
assert.deepEqual(fundingAfter.unresolved, [])
assert.deepEqual([fundingAfter.debt, fundingAfter.debtOffset], [300_000, 0])
assert.deepEqual(fundingAfter.sources.map(({ sourceKind, available }) => [sourceKind, available]), [
  ['SOURCE_CASH', 900_000], ['SOURCE_GIFT', 300_000]
], 'void restores the parent paid-source carry, while the debt remains distinct')
const rootFundingAfter = await getCurrentSaleFundingSources(db, root.id)
assert.deepEqual(rootFundingAfter.activeReturnIds, [first.returnId])
assert.equal(rootFundingAfter.sources.reduce((sum, source) => sum + source.available, 0), 0,
  'voiding the nested pair does not erase the still-active root-to-child exchange')
assert.equal(seed.count('CashMovement', '1=1'), before.movements,
  'ledger reversal creates no physical cash refund or receipt')
const stocksAfter = seed.rows('SELECT id, stock FROM "ProductVariant" ORDER BY id')
const replacement = stocksAfter.find((row) => Number(row.id) === grandchildVariant)
const replacementBefore = before.stocks.find((row) => Number(row.id) === grandchildVariant)
assert.equal(replacement.stock, Number(replacementBefore.stock) + 2,
  'the replacement stock deduction is reversed by a new positive stock movement')
assert.notEqual(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', down.returnId).voidedAt, before.returnVoid)
assert.notEqual(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', down.exchangeInvoiceId).voidedAt, before.childVoid)
assert.equal(seed.count('ExchangeFundingEvent', '1=1'), before.exchangeEvents + 5,
  'four transfer reversals and one debt-offset reversal are appended')
assert.equal(seed.count('ExchangeResidualRightEvent', '1=1'), before.rightEvents + 2)

console.log('S12 conditional exchange-pair void: PASS (unused downstream effects reversed with linked events; S11 cheque/debt restored; B/N voided; stock history preserved; no cash fabricated)')
