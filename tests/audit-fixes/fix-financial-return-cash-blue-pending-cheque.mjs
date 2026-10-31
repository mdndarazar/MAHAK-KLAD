// A pending cheque remains non-cash; it cannot inflate a return payout. A
// return of goods covered by actual cash/POS remains possible even if an
// unrelated pending cheque/debt remains on the goods the customer keeps.
// The blue figure is exactly cash + store POS received minus real cash/POS
// refunds; pending cheque, credit, debt, and manager balances stay outside it.
// node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-return-cash-blue-pending-cheque.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-return-pending-cheque-blue-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('Return pending cheque user')
const categoryId = seed.category('Return pending cheque category')
const productId = seed.product('Return pending cheque items', categoryId)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cheque = seed.insert('PaymentMethod', { key: 'CHEQUE', label: 'Cheque', kind: 'CHEQUE', isActive: 1, sortOrder: 3 })
const shiftId = seed.insert('Shift', {
  name: 'Return cheque shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
const variant = (label) => {
  const id = seed.variant(productId, label)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=2000000 WHERE id=?').run(id)
  return id
}
const returnedVariant = variant('cash-funded return item')
const keptVariant = variant('kept item with pending cheque')
const blueBefore = await physicalMovementForCustodyShift(shiftId)
const sale = await salesService.create({
  userId, shiftId,
  lines: [
    { variantId: returnedVariant, qty: 1, unitPrice: 2_000_000, discount: 0, tax: 0 },
    { variantId: keptVariant, qty: 1, unitPrice: 2_000_000, discount: 0, tax: 0 }
  ],
  payments: [
    { methodId: cash, amount: 1_000_000, destination: 'CASH' },
    { methodId: card, amount: 1_500_000, destination: 'CARD' }
  ]
})
const chequeId = seed.insert('Payment', {
  invoiceId: sale.id, methodId: cheque, amount: 1_500_000, kind: 'CHEQUE',
  seq: 3, chequeStatus: 'PENDING', paidAt: Date.now(), paidAtJalali: toJalaliDate(new Date())
})
const blueAfterSale = await physicalMovementForCustodyShift(shiftId)
assert.equal(blueAfterSale - blueBefore, 2_500_000,
  'blue is exactly 1M cash + 1.5M POS; the pending cheque is excluded')
const returnedItem = Number(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', sale.id, returnedVariant
).id)
const returnDoc = await salesService.createReturn({
  invoiceId: sale.id,
  lines: [{ saleItemId: returnedItem, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 2_000_000, userId, shiftId,
  idempotencyKey: 'return-cash-funded-item-pending-cheque-kept-item-0001'
}, { goodsReceiptRequired: false })
assert.equal(returnDoc.total, 2_000_000)
assert.equal(returnDoc.refundAmount, 2_000_000,
  'no allocation metadata is required to return actually paid goods; pending cheque does not cap or create cash')
assert.equal(seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', chequeId).chequeStatus, 'PENDING')
assert.equal(Number(sql.prepare(
  'SELECT amount FROM "CashMovement" WHERE refType=? AND refId=? AND type=?'
).get('SaleReturn', returnDoc.id, 'RETURN_REFUND').amount), 2_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBefore, 500_000,
  'blue = 1M cash + 1.5M POS − 2M actual cash refund; pending cheque and remaining debt do not count')
console.log('✓ pending cheque stayed non-cash, return did not block, and blue reconciled to 500K (1M cash + 1.5M POS − 2M cash refund)')
