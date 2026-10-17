/** A compensated return is historical evidence, not an active returned item.
 * It must still reserve its sold quantity against an automatic second payout,
 * while later returns of other items must not re-mark the invoice FULLY_RETURNED.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-corrected-return-cap.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-corrected-return-cap-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const userId = seed.user('corrected return status witness')
const cat = seed.category('corrected return cap')
const a = seed.variant(seed.product('first garment', cat))
const b = seed.variant(seed.product('second garment', cat))
for (const id of [a, b]) db.$harness.db.prepare('UPDATE "ProductVariant" SET salePrice=100 WHERE id=?').run(id)
const shiftId = seed.insert('Shift', { name: 'open return shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const sale = await salesService.create({ userId, shiftId, deductInventory: false,
  lines: [a, b].map((variantId) => ({ variantId, qty: 1, unitPrice: 100, discount: 0, tax: 0 })),
  payments: [] })
const [itemA, itemB] = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
const returnItem = (id) => salesService.createReturn({ invoiceId: sale.id, full: false,
  lines: [{ saleItemId: id, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
const first = await returnItem(itemA.id)
assert.equal(first.status, 'PARTIALLY_RETURNED')
await salesService.returnReconcileVoid({ id: first.id, reason: 'اصلاح سند اول با شاهد مدیر',
  panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal(seed.one('SELECT status FROM "SaleInvoice" WHERE id=?', sale.id).status, 'SETTLED')
const lookup = await salesService.findByReturnCode(String(sale.receiptNo))
assert.deepEqual(lookup.items.map((i) => [i.returnedQty, i.remainingQty]), [[1, 0], [0, 1]],
  'corrected item cannot be made returnable simply by recomputing invoice status')
assert.match(lookup.warnings.join(' | '), /اصلاح جبرانی|اصلاح‌شده/,
  'seller must be told why a settled invoice still has an unavailable item')
const actualCode = seed.one('SELECT returnCode FROM "SaleInvoice" WHERE id=?', sale.id).returnCode
assert.ok(actualCode, 'ordinary sale has a valid short receipt credential')
assert.match((await salesService.findByReturnCode(actualCode)).warnings.join(' | '), /اصلاح جبرانی/,
  'barcode lookup and receipt-number lookup must show the same correction warning')
await assert.rejects(returnItem(itemA.id), /اصلاح جبرانی|اصلاح‌شده/,
  'corrected item cannot pay out twice, even with an explicit quantity')
const second = await salesService.createReturn({ invoiceId: sale.id, full: true,
  lines: [{ saleItemId: itemB.id, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
assert.equal(second.fullyReturned, false,
  'the historical corrected item cannot turn an unrelated return into a full return')
assert.equal(second.status, 'PARTIALLY_RETURNED')
assert.equal(seed.one('SELECT status FROM "SaleInvoice" WHERE id=?', sale.id).status, 'PARTIALLY_RETURNED')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', first.id).n, 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', sale.id).n, 2)
await assert.rejects(salesService.createReturn({ invoiceId: sale.id, full: true,
  refundMethod: 'NONE', userId, shiftId }), /اصلاح جبرانی|اصلاح‌شده/,
  'full-return shortcut must explain why there are no automatically returnable units')
// A debt-first, gift-funded sale is the sensitive case: a false FULL return
// would silently reactivate H1 even though the first returned item was
// compensated and no physical/full-return right has been proven.
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 100, multiUse: false, maxUses: 1, carryRemainder: false,
  days: 30, note: 'gift-funded corrected return guard', userId
}))
const giftSale = await salesService.create({ userId, shiftId, deductInventory: false,
  lines: [a, b].map((variantId) => ({ variantId, qty: 1, unitPrice: 100, discount: 0, tax: 0 })),
  payments: [], storeCreditCode: gift.code, storeCreditAmount: 100,
  storeCreditIdempotencyKey: 'corrected-return-debt-first-100' })
assert.equal(giftSale.storeCreditApplied, 100)
const [giftA, giftB] = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', giftSale.id)
const debtReturn = await salesService.createReturn({ invoiceId: giftSale.id, full: false,
  lines: [{ saleItemId: giftA.id, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
assert.equal(debtReturn.creditOpportunity?.restored ?? 0, 0, 'first return reduces debt; it does not return a gift share')
await salesService.returnReconcileVoid({ id: debtReturn.id, reason: 'اصلاح سند بدهی بدون ایجاد حق هدیه',
  panelPassword: DEFAULT_MANAGER_PASSWORD })
const other = await salesService.createReturn({ invoiceId: giftSale.id, full: true,
  lines: [{ saleItemId: giftB.id, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
assert.equal(other.fullyReturned, false)
assert.equal(other.reversedCreditRedemptions, 0, 'do not resurrect H1 via a corrected historical return')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', giftSale.id).reversedAt, null)
assert.equal(seed.one('SELECT status FROM "SaleInvoice" WHERE id=?', giftSale.id).status, 'PARTIALLY_RETURNED')
console.log('✓ corrected quantity stays reserved; unrelated return remains partial and never reactivates H1 as a fake full return')
