/**
 * Audit: seller records a return that did not physically happen and chooses
 * store credit. Verify what reference the seller sees, how a manager can locate
 * and void that exact credit in Credit Management, and the safer whole-return
 * correction that also reverses the false inventory restock.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-erroneous-return-credit-manager-lookup.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-false-return-credit-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { creditLinkFacts } = await import('../../src/shared/creditUi.ts')
const { CreditSource } = await import('../../src/shared/credit.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('cashier false return')
const managerId = seed.user('manager false return')
const customerId = seed.customer('مشتری برگشت اشتباهی', '09120000001')
const shiftId = seed.insert('Shift', {
  name: 'false-return-credit-audit', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethod = seed.insert('PaymentMethod', {
  key: 'FALSE-RETURN-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('false-return-credit')
const productId = seed.product('کالای برگشت اشتباهی', categoryId)
const variantId = seed.variant(productId, 'FR-01')
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=1000000 WHERE id=?').run(variantId)
const stock = () => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const itemId = (invoiceId) => Number(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1', invoiceId
).id)

const blueStart = await physicalMovementForCustodyShift(shiftId)
const sale = await salesService.create({
  userId, shiftId, customerId,
  lines: [{ variantId, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethod, amount: 1_000_000, destination: 'CASH' }]
})
assert.equal(stock(), 9)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 1_000_000)

// The item was not actually returned, but the seller accidentally records a
// full return with a store-credit refund. This is deliberately a false-world
// fixture: the software only sees the entered return, not physical reality.
const falseReturn = await salesService.createReturn({
  invoiceId: sale.id,
  full: false,
  lines: [{ saleItemId: itemId(sale.id), qty: 1 }],
  refundMethod: RefundMethod.STORE_CREDIT,
  refundAmount: 1_000_000,
  userId,
  shiftId
})
assert.equal(falseReturn.restocked, true)
assert.equal(stock(), 10, 'the false return incorrectly adds one item back to stock')
assert.equal(falseReturn.storeCreditReference, `اعتبار #${falseReturn.storeCredit.id}`)
assert.equal(Object.hasOwn(falseReturn.storeCredit, 'code'), false, 'normal return result reveals only a safe credit reference')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 1_000_000,
  'a store-credit issue creates no cash refund, so physical blue stays at the original 1M cash receipt')

// Manager's Credit Management list: filter today + EXCHANGE-origin + ACTIVE +
// this customer. Search-by-secret-code is intentionally disabled; the public
// reference returned on the erroneous-return screen is the safe lookup key.
const listed = await storeCreditService.list({
  mode: 'issued',
  fromJalali: toJalaliDate(new Date()),
  toJalali: toJalaliDate(new Date()),
  source: CreditSource.EXCHANGE,
  status: 'ACTIVE',
  customerId,
  take: 500,
  skip: 0
})
const found = listed.find((row) => Number(row.id) === Number(falseReturn.storeCredit.id))
assert.ok(found, 'manager can find the exact credit in the filtered Credit Management list')
assert.equal(found.publicReference, falseReturn.storeCreditReference)
assert.equal(Number(found.amount), 1_000_000)
assert.equal(found.status, 'ACTIVE')
assert.equal(Object.hasOwn(found, 'code'), false, 'the list does not expose the redeemable barcode')

const detail = await storeCreditService.detail({ id: Number(found.id) })
assert.equal(Number(detail.credit.returnId), Number(falseReturn.id))
assert.equal(Number(detail.credit.sourceInvoiceId), Number(sale.id))
const returnLink = creditLinkFacts(detail).find((fact) => fact.key === 'return')
assert.equal(returnLink.value, `#${falseReturn.id}`)
assert.equal(Object.hasOwn(detail.credit, 'code'), false)
console.log(`✓ seller's return result gives manager the safe reference ${falseReturn.storeCreditReference}`)
console.log(`✓ manager's filtered credit list finds it; details link it to return #${falseReturn.id} and the original sale`)

// Try the apparent fix first: remove all returned lines in the edit form.
// Since this return already issued a 1M credit, the server must refuse to leave
// a zero-value return backing an active 1M credit and direct the manager to void it.
const editError = await (async () => {
  try {
    await salesService.returnUpdate({
      id: Number(falseReturn.id), lines: [], userId: managerId,
      managerPassword: DEFAULT_MANAGER_PASSWORD,
      overrideReason: 'برگشت اشتباهی؛ کالا تحویل نشده بود'
    })
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
})()
assert.match(editError ?? '', /هیچ قلمی.*دکمه‌ی «حذف»|کل این برگشت باطل شود/)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', found.id).status, 'ACTIVE')
assert.equal(stock(), 10, 'a rejected edit changes neither the credit nor the false stock increase')
console.log('✓ edit-to-zero is blocked because the active 1M credit would have no valid return behind it')

// The single-operation correction is the preferred path here: abort the false
// return itself, so the linked active credit and false inventory movement are
// both reversed together. A credit-only void is possible in Credit Management,
// but by itself it does not correct the return document or stock.
const code = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', found.id).code
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', found.id).status, 'ACTIVE')
await salesService.returnDelete({
  id: Number(falseReturn.id),
  userId: managerId,
  reason: 'ابطال برگشت اشتباهی؛ کالا واقعاً به فروشگاه برنگشته بود',
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
assert.ok(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', falseReturn.id).voidedAt)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', found.id).status, 'CANCELED')
await assert.rejects(() => salesService.create({
  userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [], storeCreditCode: code,
  storeCreditIdempotencyKey: 'false-return-voided-credit-reuse'
}), /باطل|معتبر|قابل استفاده|اعتبار/)
assert.equal(stock(), 9, 'voiding the return reverses the false inventory restock; no manual decrement needed')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 1_000_000,
  'voiding the false store-credit return does not alter physical blue')
console.log('✓ voiding the whole false return automatically cancels its credit, restores stock to 9, and leaves the original 1M cash blue unchanged')
