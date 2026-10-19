/** Exact owner scenario: 15,980,000-rial sale paid with a 2,000,000-rial
 * store-credit barcode plus 13,980,000 real cash; exchange for 15,000,000
 * and request a 980,000-rial barcode. Observe the CURRENT transaction guard,
 * the original credit and all absence-of-side-effect invariants. A separate
 * cash-only control proves the 980,000 arithmetic is supported otherwise.
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
const shiftId = seed.insert('Shift', { name: 'shift', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const gift = await db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, note: 'original credit in exchange test', userId
}))
const purchase = (cash, key, credit = null) => salesService.create({
  userId, shiftId,
  lines: [{ variantId: source, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: cash, destination: 'CASH' }],
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
const originalFunding = seed.rows(`SELECT kind, amount, shareId, rootShareId, sourceCreditId
  FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND eventKey LIKE ? ORDER BY id`,
  original.id, `sale:${original.id}:r1:%`).filter((row) => row.kind.startsWith('SOURCE_'))
assert.deepEqual(originalFunding.map(({ kind, amount, sourceCreditId }) => ({ kind, amount, sourceCreditId }))
  .sort((a, b) => a.kind.localeCompare(b.kind)), [
  { kind: 'SOURCE_CASH', amount: 13_980_000, sourceCreditId: null },
  { kind: 'SOURCE_GIFT', amount: 2_000_000, sourceCreditId: gift.id }
], 'the actual create transaction keeps the 2m gift separate from 13.98m real cash')
assert.equal(originalFunding.find((row) => row.kind === 'SOURCE_GIFT')?.rootShareId, `credit:${gift.id}`)
assert.equal(originalFunding.reduce((sum, row) => sum + Number(row.amount), 0), original.grandTotal)
const stockBefore = seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement)
const attemptedExchange = (invoiceId, saleItemId) => salesService.createExchange({
  invoiceId, lines: [{ saleItemId, qty: 1 }], replacements: [{ variantId: replacement, qty: 1 }],
  refundMode: 'STORE_CREDIT', managerPassword: DEFAULT_MANAGER_PASSWORD, userId, shiftId
})
await assert.rejects(attemptedExchange(original.id, originalItemId), (error) =>
  /تعویضِ خریدی که با اعتبار پرداخت شده/.test(String(error?.message ?? '')),
  'credit-funded exchange is currently blocked before any 980,000-rial barcode is issued')
const giftAfter = seed.one('SELECT status, usedAmount FROM "StoreCredit" WHERE id=?', gift.id)
assert.equal(giftAfter.status, 'USED', 'original 2m barcode is NOT reactivated')
assert.equal(giftAfter.usedAmount, 2_000_000)
await assert.rejects(() => findRedeemable(db, gift.code), (error) =>
  error?.category === 'NOT_REDEEMABLE' || /مصرف شده/.test(String(error?.message ?? '')),
  'credit lookup must not silently accept the already spent original barcode')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=?', original.id).reversedAt, null)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', original.id).n, 0)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE sourceInvoiceId=?', original.id).n, 0)
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n, 1,
  'no 980,000-rial barcode or other credit was silently issued')
assert.deepEqual(seed.rows('SELECT id, stock FROM "ProductVariant" WHERE id IN (?, ?) ORDER BY id', source, replacement), stockBefore)
console.log('✓ mixed purchase 15,980,000 = 2,000,000 credit + 13,980,000 cash; requested exchange rejected; old barcode USED, no new 980,000 barcode, goods unchanged')

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
