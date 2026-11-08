/**
 * Return/exchange barcodes are ACTIVE immediately; print/delivery are audit-only.
 * A customer may redeem the credit before the delivery record is confirmed, and
 * recording delivery must not change its consumption state.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-return-exchange-credit-handoff.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-handoff-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { confirmStoreCreditDelivery, storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const { creditDocHtml, exchangeReceiptHtml } = await import('../../src/main/print/templates.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('credit-handoff-cashier')
const shiftId = seed.insert('Shift', {
  name: 'credit-handoff', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'HANDOFF-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('handoff-category')
const productId = seed.product('handoff-product', categoryId)
const makeVariant = (code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price, id)
  return id
}
const original = makeVariant('HANDOFF-ORIGINAL', 8_000_000)
const replacement = makeVariant('HANDOFF-REPLACEMENT', 4_000_000)
const unrelated = makeVariant('HANDOFF-UNRELATED', 2_000_000)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const sale = (variantId, price) => salesService.create({
  userId, shiftId, lines: [line(variantId, price)],
  payments: [{ methodId: cashMethodId, amount: price, destination: 'CASH' }]
})
const itemId = (invoiceId) => Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', invoiceId).id)

const returnedSale = await sale(original, 8_000_000)
const returned = await salesService.createReturn({
  invoiceId: returnedSale.id, full: false, lines: [{ saleItemId: itemId(returnedSale.id), qty: 1 }],
  refundMethod: 'STORE_CREDIT', refundAmount: 8_000_000, userId, shiftId
})
const returnCreditId = Number(returned.storeCredit.id)
const returnCreditRow = seed.one('SELECT status,returnId,code FROM "StoreCredit" WHERE id=?', returnCreditId)
const returnCreditCode = returnCreditRow.code
assert.equal(returnCreditRow.status, 'ACTIVE', 'simple return credit is usable immediately when issued')
assert.equal(Number(returnCreditRow.returnId), returned.id)
assert.equal(returned.handoffCredits.some((credit) => credit.id === returnCreditId), true)
assert.equal(seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', returnCreditId).status, 'PENDING')
const draftCertificate = creditDocHtml({
  code: returnCreditCode, amount: 8_000_000, usedAmount: 0, remaining: 8_000_000,
  sourceLabel: 'برگشت', statusLabel: 'فعال', deliveryPending: true,
  issuedJalali: toJalaliDate(new Date()), issuedTime: '12:00', expiresJalali: null,
  usesLabel: 'یک‌بارمصرف', maxUses: 1, usedCount: 0, restrictLabel: null,
  minPurchase: 0, maxPerTransaction: 0, holderName: null, holderCompany: null,
  holderPhone: null, holderAgent: null, holderAddress: null, holderNationalId: null,
  barcodeDataUrl: null, rulesText: '', showRules: false, showHolder: false,
  showRemaining: true, reprint: false, printCount: 0
})
assert.match(draftCertificate, /از لحظه‌ی صدور قابل استفاده است/u)
assert.match(draftCertificate, /فقط سابقه‌ی تحویل به مشتری را ثبت می‌کنند/u)
assert.doesNotMatch(draftCertificate, /تا تحویل واقعی.*قابل استفاده نیست/u)
const draftExchangeReceipt = exchangeReceiptHtml({
  exchangeReceiptNo: null, sourceReceiptNo: 1, dateJalali: toJalaliDate(new Date()), time: '12:00',
  returnedItems: [], returnTotal: 1, replacementItems: [], exchangeTotal: 0, diff: -1,
  settlementLabel: 'بازپرداخت کارتی', cashReceived: 0, cashRefunded: 0, cardRefunded: 1,
  storeCredits: [{ code: 'DRAFTCODE', amount: 1, statusLabel: 'پیش‌نویس', deliveryPending: true }]
})
assert.match(draftExchangeReceipt, /از لحظه‌ی صدور قابل استفاده است/u)
assert.match(draftExchangeReceipt, /فقط سابقه‌ی تحویل به مشتری را ثبت می‌کنند/u)
assert.doesNotMatch(draftExchangeReceipt, /تا تحویل واقعی.*قابل استفاده نیست/u)
assert.match(draftExchangeReceipt, /بازپرداخت کارتی/u)
assert.match(draftExchangeReceipt, /بازپرداخت به کارت مشتری/u)
assert.doesNotMatch(draftExchangeReceipt, /بازپرداخت نقدی از صندوق/u)
await storeCreditService.markPrinted({ id: returnCreditId, userId })
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', returnCreditId).status, 'ACTIVE', 'printing is history and does not change immediate usability')
assert.equal(seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', returnCreditId).status, 'PENDING')
await salesService.create({
  userId, shiftId, lines: [line(unrelated, 2_000_000)], payments: [],
  storeCreditCode: returnCreditCode, storeCreditIdempotencyKey: 'handoff-before-delivery-0001'
})
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', returnCreditId).status, 'PARTIALLY_USED',
  'the barcode can be redeemed before a separate delivery record is written')
const deliveredReturn = await confirmStoreCreditDelivery({ id: returnCreditId, userId })
assert.equal(deliveredReturn.credit.status, 'PARTIALLY_USED', 'recording delivery never resets or activates credit')
assert.equal(deliveredReturn.replayed, false)
assert.equal(seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', returnCreditId).status, 'DELIVERED')
const auditBeforeReplay = seed.count('AuditLog', 'action=? AND entityId=?', 'CREDIT_DELIVERY_CONFIRM', returnCreditId)
const replay = await confirmStoreCreditDelivery({ id: returnCreditId, userId })
assert.equal(replay.replayed, true, 'repeated delivery history recording is idempotent')
assert.equal(seed.count('AuditLog', 'action=? AND entityId=?', 'CREDIT_DELIVERY_CONFIRM', returnCreditId), auditBeforeReplay)
await salesService.create({
  userId, shiftId, lines: [line(unrelated, 2_000_000)], payments: [],
  storeCreditCode: returnCreditCode, storeCreditIdempotencyKey: 'handoff-after-delivery-0001'
})
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', returnCreditId).status, 'PARTIALLY_USED')

const exchangedSale = await sale(original, 8_000_000)
const exchange = await salesService.createExchange({
  userId, shiftId, invoiceId: exchangedSale.id,
  lines: [{ saleItemId: itemId(exchangedSale.id), qty: 1 }],
  replacements: [line(replacement, 4_000_000)], refundMode: 'STORE_CREDIT'
})
assert.ok(exchange.handoffCredits.length > 0, 'exchange response includes safe references for all pending barcodes')
for (const credit of exchange.handoffCredits) {
  const row = seed.one('SELECT status,returnId FROM "StoreCredit" WHERE id=?', credit.id)
  assert.equal(row.status, 'ACTIVE', 'exchange credit is usable immediately')
  assert.equal(Number(row.returnId), exchange.returnId)
  assert.equal(seed.one('SELECT status FROM "StoreCreditDelivery" WHERE creditId=?', credit.id).status, 'PENDING')
  const delivered = await confirmStoreCreditDelivery({ id: credit.id, userId })
  assert.equal(delivered.credit.status, 'ACTIVE', 'delivery record does not alter the already-active credit')
}

console.log('✓ return and exchange credits are immediately usable; printing/delivery are audit-only and delivery recording is idempotent')
