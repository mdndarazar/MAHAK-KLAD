import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-r1-b07-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const [{ harnessClient }, { makeSeeder }, { salesService }, { toJalaliDate }, { tehranStartOfDay }] = await Promise.all([
  import('../../test/harness/stubs/prismaClient.mjs'),
  import('../../test/harness/seed.mjs'),
  import('../../src/main/services/SalesService.ts'),
  import('../../src/shared/jalali.ts'),
  import('../../src/shared/tehranTime.ts')
])

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('R1-B07 lookup/expiry test')
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'R1-B07-CASH', label: 'نقدی تست', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('R1-B07 category')
const today = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', {
  name: 'R1-B07 test shift', number: 907, dayJalali: today, openedAt: Date.now(), userId
})
let serial = 0

function makeVariant(price = 50000) {
  const productId = seed.product(`R1-B07 product ${++serial}`, categoryId)
  const variantId = seed.variant(productId, `R1-B07-${serial}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = ? WHERE id = ?').run(price, variantId)
  return { id: variantId, price }
}

async function makeSale(price = 50000) {
  const variant = makeVariant(price)
  const invoice = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: variant.id, qty: 1, unitPrice: price, discount: 0, tax: 0 }],
    payments: [{ methodId: cashMethodId, amount: price, destination: 'CASH' }]
  })
  const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id LIMIT 1', invoice.id)
  return { invoice, variant, itemId: Number(item.id) }
}

function setReturnCode(invoiceId, code, expiresAt) {
  sql.prepare('UPDATE "SaleInvoice" SET returnCode = ?, returnCodeExpiresAt = ? WHERE id = ?')
    .run(code, expiresAt == null ? null : expiresAt.getTime(), invoiceId)
}

function snapshot(variantIds) {
  const count = (table) => Number(seed.one(`SELECT COUNT(*) AS count FROM "${table}"`).count)
  return {
    invoices: count('SaleInvoice'),
    returns: count('SaleReturn'),
    payments: count('Payment'),
    credits: count('StoreCredit'),
    cashMovements: count('CashMovement'),
    stockMovements: count('StockMovement'),
    stock: variantIds.map((id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', id).stock))
  }
}

// A code remains valid through the entire Tehran expiry date, even if its stored
// instant is at the beginning of that day.
{
  const source = await makeSale()
  const code = 'R1B07SAME'
  setReturnCode(source.invoice.id, code, tehranStartOfDay(new Date()))

  const byCode = await salesService.findByReturnCode(code)
  assert.equal(byCode.lookupKind, 'RETURN_CODE')
  assert.equal(byCode.codeState, 'PRESENT')
  assert.equal(byCode.expiryState, 'VALID')
  assert.equal(byCode.expired, false)
  assert.equal(byCode.daysLeft, 0)
  assert.ok(byCode.expiresAtJalali)

  const byReceipt = await salesService.findByReturnCode(String(source.invoice.receiptNo))
  assert.equal(byReceipt.lookupKind, 'RECEIPT_NUMBER')
  assert.equal(byReceipt.codeState, 'PRESENT')
  assert.equal(byReceipt.returnCode, code)
  assert.equal(byReceipt.expiryState, 'VALID')
}

// Missing code and missing expiry are represented as nullable / NOT_APPLICABLE,
// not mislabeled as an expired barcode.
{
  const source = await makeSale()
  setReturnCode(source.invoice.id, null, null)
  const lookup = await salesService.findByReturnCode(String(source.invoice.receiptNo))
  assert.equal(lookup.lookupKind, 'RECEIPT_NUMBER')
  assert.equal(lookup.codeState, 'NOT_ISSUED')
  assert.equal(lookup.returnCode, null)
  assert.equal(lookup.expiryState, 'NOT_APPLICABLE')
  assert.equal(lookup.expiresAtJalali, null)
  assert.equal(lookup.daysLeft, null)
  assert.equal(lookup.expired, false)
}

// Expired code lookup reports expiry, receipt lookup keeps the invoice/status
// distinct, and both final mutation routes reject stale/bypassed UI requests
// without changing stock or financial records.
{
  const source = await makeSale()
  const code = 'R1B07OLD'
  const expiredAt = new Date(tehranStartOfDay(new Date()).getTime() - 1)
  setReturnCode(source.invoice.id, code, expiredAt)

  await assert.rejects(
    () => salesService.findByReturnCode(code),
    (error) => String(error?.message ?? error).includes('مهلت کد')
  )
  const byReceipt = await salesService.findByReturnCode(String(source.invoice.receiptNo))
  assert.equal(byReceipt.lookupKind, 'RECEIPT_NUMBER')
  assert.equal(byReceipt.codeState, 'PRESENT')
  assert.equal(byReceipt.expiryState, 'EXPIRED')
  assert.equal(byReceipt.expired, true)
  assert.equal(byReceipt.expiresAtJalali, toJalaliDate(expiredAt))

  const beforeReturn = snapshot([source.variant.id])
  await assert.rejects(
    () => salesService.createReturn({
      userId, invoiceId: Number(source.invoice.id), full: false,
      lines: [{ saleItemId: source.itemId, qty: 1 }],
      refundMethod: 'CASH', confirmOverpay: true
    }),
    (error) => String(error?.message ?? error).includes('مهلت برگشت فاکتور')
  )
  assert.deepEqual(snapshot([source.variant.id]), beforeReturn, 'expired ordinary return must not write anything')

  const replacement = makeVariant(source.variant.price)
  const beforeExchange = snapshot([source.variant.id, replacement.id])
  await assert.rejects(
    () => salesService.createExchange({
      userId, shiftId, invoiceId: Number(source.invoice.id),
      lines: [{ saleItemId: source.itemId, qty: 1 }],
      replacements: [{ variantId: replacement.id, qty: 1, unitPrice: replacement.price, discount: 0, tax: 0 }]
    }),
    (error) => String(error?.message ?? error).includes('مهلت برگشت فاکتور')
  )
  assert.deepEqual(snapshot([source.variant.id, replacement.id]), beforeExchange, 'expired exchange must not write anything')
}

console.log('✓ R1-B07 lookup kind, nullable code/expiry, Tehran end-of-day rule, and R2-B01 final guards passed')
await db.$disconnect?.()
