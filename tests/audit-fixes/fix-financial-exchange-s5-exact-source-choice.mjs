// User-locked S5: a single 5M item was funded by exactly 2M barcode credit
// and 3M cash. Returning it restores the 2M credit right to its root and lets
// the customer choose cash OR a new non-cash credit for only the 3M real share.
// The blue custody total contains only cash/card movement; credit and pending
// credit delivery never become physical money.
// node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s5-exact-source-choice.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s5-exact-source-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S5 exact source test')
const categoryId = seed.category('S5 exact category')
const productId = seed.product('S5 exact item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'S5-EXACT-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const shiftId = seed.insert('Shift', {
  name: 'S5 exact shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let seq = 0
const makeSale = async (code, creditChoice) => {
  const expiry = new Date(Date.now() + 20 * 86_400_000 + 12_345)
  const root = await db.$transaction((tx) => issueStoreCredit(tx, {
    source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1,
    carryRemainder: false, days: null, expiresAtExact: expiry, note: `S5 exact root ${code}`, userId
  }))
  const variantId = seed.variant(productId, `S5 exact ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = 5000000 WHERE id = ?').run(variantId)
  const blueBeforeSale = await physicalMovementForCustodyShift(shiftId)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cashMethodId, amount: 3_000_000, destination: 'CASH' }],
    storeCreditCode: root.code, storeCreditAmount: 2_000_000,
    storeCreditIdempotencyKey: `s5-exact-sale-${code}`
  })
  assert.equal(sale.grandTotal, 5_000_000)
  assert.equal(sale.storeCreditApplied, 2_000_000)
  assert.equal(Number(sql.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM "Payment" WHERE invoiceId = ? AND methodId = ?').get(sale.id, cashMethodId).n), 3_000_000)
  assert.equal(Number(sql.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM "StoreCreditRedemption" WHERE invoiceId = ? AND reversedAt IS NULL').get(sale.id).n), 2_000_000)
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeSale, 3_000_000,
    'فروش ۵M فقط ۳M وجه نقد در عدد آبی دارد؛ ۲M اعتبار غیرنقدی است')
  const itemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id).id)
  const blueBeforeReturn = await physicalMovementForCustodyShift(shiftId)
  const returned = await salesService.createReturn({
    invoiceId: sale.id, lines: [{ saleItemId: itemId, qty: 1 }], full: true,
    refundMethod: creditChoice ? 'STORE_CREDIT' : 'CASH',
    refundAmount: 3_000_000, userId, shiftId,
    idempotencyKey: `s5-exact-return-${code}`
  }, { goodsReceiptRequired: false })
  assert.equal(returned.total, 5_000_000)
  assert.equal(returned.refundAmount, 3_000_000,
    'صرفاً سهم ۳M وجه واقعی می‌تواند نقد شود یا به اعتبار غیرنقدی بدل شود')
  assert.equal(returned.creditOpportunity.restored, 2_000_000,
    'تمام ۲M اعتبار غیرنقدی باید جداگانه به حق ریشه برگردد، نه با نسبت ارزش برگشت')
  assert.equal(returned.creditOpportunity.expiredShare, 0)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id = ?', root.id).status, 'USED',
    'بارکد کاملاً مصرف‌شده، پس از صدور حق برگشتی، برای همیشه USED می‌ماند')
  const rootReturnAllocation = seed.one('SELECT amount, rootCreditId, originalExpiresAt, kind FROM "CreditReturnAllocation" WHERE returnId = ?', returned.id)
  assert.equal(Number(rootReturnAllocation.amount), 2_000_000)
  assert.equal(Number(rootReturnAllocation.rootCreditId), root.id)
  assert.equal(new Date(rootReturnAllocation.originalExpiresAt).getTime(), expiry.getTime())
  assert.equal(rootReturnAllocation.kind, 'ORIGINAL_REVERSED')
  const rootBranch = seed.one('SELECT id, amount, status, expiresAt FROM "StoreCredit" WHERE id <> ? AND returnId = ? AND amount = ?', root.id, returned.id, 2_000_000)
  assert.equal(Number(rootBranch.amount), 2_000_000)
  assert.equal(rootBranch.status, 'ACTIVE')
  assert.equal(new Date(rootBranch.expiresAt).getTime(), expiry.getTime())

  if (!creditChoice) {
    assert.equal(returned.refundMethod, 'CASH')
    assert.equal(Number(sql.prepare('SELECT amount FROM "CashMovement" WHERE refType = ? AND refId = ? AND type = ?').get('SaleReturn', returned.id, 'RETURN_REFUND').amount), 3_000_000)
    assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeReturn, -3_000_000,
      'برگشت نقدی فقط ۳M از عدد آبی کم می‌کند؛ اعتبار برگشتی ۲M بی‌اثر فیزیکی است')
    assert.equal(seed.count('CashMovement', 'refType = ? AND refId = ? AND type = ?', 'SaleReturn', returned.id, 'RETURN_REFUND'), 1)
  } else {
    assert.equal(returned.refundMethod, 'STORE_CREDIT')
    assert.equal(seed.count('CashMovement', 'refType = ? AND refId = ? AND type = ?', 'SaleReturn', returned.id, 'RETURN_REFUND'), 0)
    const cashShareBarcode = seed.one('SELECT amount, source, status FROM "StoreCredit" WHERE id <> ? AND id <> ? AND returnId = ? AND amount = ?', root.id, rootBranch.id, returned.id, 3_000_000)
    assert.equal(Number(cashShareBarcode.amount), 3_000_000)
    assert.equal(cashShareBarcode.status, 'ACTIVE')
    assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeReturn, 0,
      'تبدیل سهم ۳M واقعی به اعتبار انتخابی پول را از صندوق/کارت‌خوان خارج نمی‌کند')
  }
  return { root, returned }
}

await makeSale('cash', false)
await makeSale('credit', true)
console.log('✓ S5 exact source split: 2M returned to its gift root + customer-selected settlement of only 3M real money; blue counts cash/card only')
