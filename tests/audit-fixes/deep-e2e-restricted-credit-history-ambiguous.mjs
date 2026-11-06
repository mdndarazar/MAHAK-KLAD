/**
 * Scope history is mutable on StoreCredit, while redemptions hold no immutable
 * scope snapshot. If an audited restriction edit occurs after redemption, a
 * return must stop instead of treating today's scope as historical evidence.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-restricted-credit-history-ambiguous.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-history-ambiguous-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService, changeCreditRestrictions } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('credit-history-proof')
const shiftId = seed.insert('Shift', {
  name: 'credit-history-proof', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'HISTORY-PROOF-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const category = seed.category('credit-history-proof-category')
const product = seed.product('credit-history-proof-product', category)
const itemA = seed.variant(product, 'HISTORY-A')
const itemB = seed.variant(product, 'HISTORY-B')
for (const id of [itemA, itemB]) sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=100000 WHERE id=?').run(id)
const credit = await storeCreditService.issueManual({
  amount: 50_000, multiUse: false, carryRemainder: false,
  restrictScope: 'VARIANTS', restrictVariantIds: [itemA],
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'A-only before redemption'
})
const creditCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', credit.id).code
const sale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: itemA, qty: 1, unitPrice: 100_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 50_000, destination: 'CASH' }],
  storeCreditCode: creditCode,
  storeCreditIdempotencyKey: 'history-proof-sale-redemption'
})
await changeCreditRestrictions({
  id: credit.id,
  restrictScope: 'VARIANTS',
  restrictVariantIds: [itemB],
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD,
  reason: 'scope changed after redemption'
})
const saleItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
const before = {
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  cash: seed.count('CashMovement', '1=1'),
  stockA: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', itemA).stock),
  credit: seed.one('SELECT status,usedAmount,usedCount,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', credit.id)
}
await assert.rejects(() => salesService.createReturn({
  userId, shiftId,
  invoiceId: sale.id,
  lines: [{ saleItemId: Number(saleItem.id), qty: 1 }],
  refundMethod: 'CASH'
}), /محدودیت بارکد اعتبار.*بعد از مصرف تغییر کرده|تاریخی.*ثبت نشد/u)
assert.deepEqual({
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  cash: seed.count('CashMovement', '1=1'),
  stockA: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', itemA).stock),
  credit: seed.one('SELECT status,usedAmount,usedCount,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', credit.id)
}, before, 'ambiguous historical scope must fail closed without writes')
console.log('✓ post-redemption scope edit makes historical eligibility ambiguous; return stops mutation-free rather than inferring from current scope')
