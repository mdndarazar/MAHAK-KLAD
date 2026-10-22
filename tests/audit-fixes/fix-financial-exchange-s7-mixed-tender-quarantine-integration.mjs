/** Accepted S7 regression: a successful card payment is paid money, while an
 * uncleared cheque remains debt attached to goods the customer keeps. Returning
 * the paid item can refund the actual card amount; no proportional split may
 * push that return onto the pending cheque.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s7-mixed-tender-quarantine-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-s7-paid-card-pending-cheque-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { invoiceRemaining } = await import('../../src/main/services/invoiceDebt.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('S7 card paid / cheque pending')
const categoryId = seed.category('S7 accepted category')
const productId = seed.product('S7 accepted products', categoryId)
const cashMethodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const cardMethodId = seed.insert('PaymentMethod', { key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1 })
const chequeMethodId = seed.insert('PaymentMethod', { key: 'CHEQUE', label: 'Cheque', kind: 'CUSTOM', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'S7 accepted shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const variant = (code) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=1_000_000 WHERE id=?').run(id)
  return id
}
const paidItemVariant = variant('S7-CARD-PAID-ITEM')
const heldItemVariant = variant('S7-CHEQUE-BACKED-HELD-ITEM')
const sale = await salesService.create({ userId, shiftId,
  lines: [
    { variantId: paidItemVariant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 },
    { variantId: heldItemVariant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }
  ],
  payments: [{ methodId: cardMethodId, amount: 1_000_000, destination: 'CARD', reference: 'S7-CARD-SUCCESS' }]
})
const cheque = await salesService.addPayment({ invoiceId: sale.id, userId, methodId: chequeMethodId,
  kind: 'CHEQUE', amount: 1_000_000, chequeNo: 'S7-PENDING-001', bankName: 'S7 bank',
  dueDateJalali: toJalaliDate(new Date()), idempotencyKey: 's7-pending-cheque-add-0001' })
assert.equal(cheque.payment.chequeStatus, 'PENDING')
const paidLine = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', sale.id, paidItemVariant)
const beforeCash = seed.count('CashMovement', '1=1')
const result = await salesService.createReturn({
  invoiceId: sale.id, full: false, lines: [{ saleItemId: paidLine.id, qty: 1 }],
  refundMethod: 'CARD', refundAmount: 1_000_000, userId, shiftId,
  cardPosOverride: { managerPassword: DEFAULT_MANAGER_PASSWORD,
    reason: 'S7 confirmed refund of actually paid card value', acknowledgedNoReverse: true },
  idempotencyKey: 's7-paid-card-return-keeps-cheque-goods-0001'
}, { goodsReceiptRequired: false })
assert.equal(result.total, 1_000_000)
assert.equal(result.refundMethod, 'CARD')
assert.equal(result.refundAmount, 1_000_000)
assert.equal(seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.payment.id).chequeStatus, 'PENDING',
  'the uncleared cheque remains unpaid and attached to the held line')
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturnItem" WHERE returnId=?', result.id).n, 1)
assert.equal(seed.one('SELECT saleItemId FROM "SaleReturnItem" WHERE returnId=?', result.id).saleItemId, paidLine.id)
assert.equal(seed.count('CashMovement', '1=1'), beforeCash,
  'a card refund never appears as a cash drawer movement')
const remaining = await invoiceRemaining(db, sale.id, 2_000_000, 1_000_000)
assert.equal(remaining.remaining, 1_000_000,
  'the 1M pending cheque debt remains on the 1M item the customer kept')
console.log('✓ S7 integration: refunded the successful 1M card payment for the returned item; the 1M pending cheque stayed open on the retained item, with no cash movement or proportional attribution')
