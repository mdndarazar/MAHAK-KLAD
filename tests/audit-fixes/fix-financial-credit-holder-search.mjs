/* Identity-only credit search. A matched name/number is an aid to finding
 * a record, NEVER proof of the presenter's ownership or consent to SMS.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-holder-search.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-credit-holder-search-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit, storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { creditViewRequest, creditSelectionResetSignature } = await import('../../src/shared/creditUi.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const customerId = seed.customer('مینا رهبر', '09123456789')
const customerCredit = await db.$transaction((tx) => issueStoreCredit(tx, {
  amount: 150, source: 'MANUAL', customerId, multiUse: true,
  note: 'پرونده بدون نام/تلفن روی خود اعتبار'
}))
const direct = await db.$transaction((tx) => issueStoreCredit(tx, {
  amount: 300, source: 'MANUAL', customerName: 'سارا نیکنام', holderPhone: '۰۹۳۵۱۲۳۴۵۶۷',
  multiUse: true, note: 'کد دستیِ دارای اطلاعات اختیاری'
}))
// The usual unfiltered management list is today only. A holder search with
// no date supplied must still locate yesterday's outstanding credit.
db.$harness.db.prepare('UPDATE "StoreCredit" SET issuedAt=?, issuedAtJalali=? WHERE id=?')
  .run(Date.now() - 7 * 86400000, '1400/01/01', direct.id)
for (const [term, expected] of [
  ['رهبر', customerCredit.id], ['09123456789', customerCredit.id],
  ['نیکنام', direct.id], ['09351234567', direct.id]
]) {
  const rows = await storeCreditService.list({ holderSearch: term })
  assert.ok(rows.some((r) => r.id === expected), `missing holder ${term}`)
  for (const r of rows) assert.equal(Object.hasOwn(r, 'code'), false, 'no spendable credential in list')
}
await assert.rejects(() => storeCreditService.list({ holderSearch: 'ا' }), /۲|2/)
assert.equal((await storeCreditService.list({ holderSearch: 'کد ساختگی' })).length, 0)
const req = creditViewRequest('list', { holderSearch: 'نیکنام', search: 'FAKE' })
assert.equal(req.payload.holderSearch, 'نیکنام')
assert.notEqual(creditSelectionResetSignature({ holderSearch: 'رهبر' }),
  creditSelectionResetSignature({ holderSearch: 'نیکنام' }))
console.log('✓ management search: name/customer phone/holder phone across dates; no code in result or ownership inference')

const managerId = seed.user('optional paper holder')
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId: managerId,
  openedAt: Date.now() - 5000, dayJalali: toJalaliDate(new Date()) })
const cat = seed.category('holder print fixture'), product = seed.product('example item', cat)
const v100 = seed.variant(product), v200 = seed.variant(product)
for (const [id, price] of [[v100, 100], [v200, 200]])
  db.$harness.db.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=? WHERE id=?').run(price, id)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'نقد', isActive: 1 })
const buy = async (variantId, amount) => salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: amount, discount: 0, tax: 0 }],
  payments: [{ methodId, amount, destination: 'CASH' }] })
const itemOf = (id) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', id).id
const paid = await buy(v100, 100)
const issued = await salesService.createReturn({ invoiceId: paid.id, full: true,
  lines: [{ saleItemId: itemOf(paid.id), qty: 1 }],
  refundMethod: 'STORE_CREDIT', refundAmount: 100, userId: managerId, shiftId,
  printedHolderFirstName: 'لیلا', printedHolderLastName: 'اکبری', printedHolderPhone: '۰۹۱۱۱۱۱۱۱۱۱' })
const returnCredit = seed.one('SELECT id, customerName, holderPhone, amount, multiUse FROM "StoreCredit" WHERE returnId=?', issued.id)
assert.equal(returnCredit.customerName, 'لیلا اکبری')
assert.equal(returnCredit.holderPhone, '۰۹۱۱۱۱۱۱۱۱۱')
assert.equal(returnCredit.multiUse, 1)
assert.equal((await printService.creditDocDataFor(returnCredit.id, await settingsService.receiptTemplate())).holderName,
  'لیلا اکبری')
assert.ok((await storeCreditService.list({ holderSearch: '09111111111' })).some((r) => r.id === returnCredit.id))
const noHolderSale = await buy(v100, 100)
const noHolderReturn = await salesService.createReturn({ invoiceId: noHolderSale.id, full: true,
  lines: [{ saleItemId: itemOf(noHolderSale.id), qty: 1 }],
  refundMethod: 'STORE_CREDIT', refundAmount: 100, userId: managerId, shiftId })
assert.equal(seed.one('SELECT holderPhone FROM "StoreCredit" WHERE returnId=?', noHolderReturn.id).holderPhone, null)
const bareReturnCreditId = seed.one('SELECT id FROM "StoreCredit" WHERE returnId=?', noHolderReturn.id).id
assert.match(await printService.creditHtml(bareReturnCreditId), /اعتبار خرید|سند اعتبار/,
  'missing name/phone must not prevent the customer paper from rendering')

const exchangeSale = await buy(v200, 200)
const exchanged = await salesService.createExchange({ invoiceId: exchangeSale.id,
  lines: [{ saleItemId: itemOf(exchangeSale.id), qty: 1 }],
  replacements: [{ variantId: v100, qty: 1 }], refundMode: 'STORE_CREDIT',
  userId: managerId, shiftId, printedHolderFirstName: 'مانی', printedHolderLastName: 'محسن',
  printedHolderPhone: '09114445566' })
const exchangeCredit = seed.one('SELECT id, customerName, holderPhone, amount FROM "StoreCredit" WHERE exchangeInvoiceId=?',
  exchanged.exchangeInvoiceId)
assert.equal(exchangeCredit.customerName, 'مانی محسن')
assert.equal(exchangeCredit.holderPhone, '09114445566')
assert.equal(exchangeCredit.amount, 100)
const exchangePaper = await printService.creditDocDataFor(exchangeCredit.id, await settingsService.receiptTemplate())
assert.equal(exchangePaper.holderName, 'مانی محسن')
assert.equal(exchangePaper.holderPhone, '09114445566')
const bareExchangeSale = await buy(v200, 200)
const bareExchange = await salesService.createExchange({ invoiceId: bareExchangeSale.id,
  lines: [{ saleItemId: itemOf(bareExchangeSale.id), qty: 1 }],
  replacements: [{ variantId: v100, qty: 1 }], refundMode: 'STORE_CREDIT',
  userId: managerId, shiftId })
const bareCredit = seed.one('SELECT customerName, holderPhone FROM "StoreCredit" WHERE exchangeInvoiceId=?',
  bareExchange.exchangeInvoiceId)
assert.equal(bareCredit.customerName, null)
assert.equal(bareCredit.holderPhone, null)
assert.match(await printService.creditHtml(seed.one('SELECT id FROM "StoreCredit" WHERE exchangeInvoiceId=?',
  bareExchange.exchangeInvoiceId).id), /اعتبار خرید|سند اعتبار/)
await assert.rejects(() => storeCreditService.list({ holderSearch: 'ا' }), /۲|2/)
console.log('✓ return/exchange papers: optional first/last/phone persisted on new code; omitted fields do not block issue')
