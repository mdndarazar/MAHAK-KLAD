/**
 * Verify that voiding a return or exchange also invalidates its already-printed
 * StoreCredit barcode. Runs real SalesService and PrintService code with the OS
 * printer mocked; no user's database or physical printer is touched.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-credit-return-exchange-void-after-print.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-void-after-print-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
register('./support/s129-hooks.mjs', import.meta.url)

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { DEFAULT_MANAGER_PASSWORD, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await import('../../src/shared/credit.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const mock = await import('./support/s129-electron-mock.mjs')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const userId = seed.user('مدیر آزمون ابطال اعتبار چاپ‌شده')
const shiftId = seed.insert('Shift', { name: 'شیفت آزمون ابطال', number: 1, dayJalali: today, openedAt: Date.now() - 60_000, userId })
const cashMethodId = seed.insert('PaymentMethod', { key: 'CREDIT-VOID-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const categoryId = seed.category('دسته ابطال اعتبار چاپ‌شده')
const productId = seed.product('کالای ابطال اعتبار چاپ‌شده', categoryId)
let variantCounter = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز-${++variantCounter}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const invoice = async () => {
  const a = variant(600), b = variant(400)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [line(a, 600), line(b, 400)],
    payments: [{ methodId: cashMethodId, amount: 1_000, destination: 'CASH' }]
  })
  const items = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
  return { sale, items, a, b }
}
const creditRow = (returnId) => seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', returnId)
const saleWithCode = (code, key) => salesService.create({
  userId, shiftId,
  lines: [line(variant(100), 100)],
  payments: [],
  storeCreditCode: code,
  storeCreditIdempotencyKey: key
})
const printSetup = () => {
  mock.reset()
  mock.state.printers = [{ name: 'Axiom', displayName: 'Axiom', isDefault: true }]
  mock.state.executeJavaScriptOutcome = 500
}
seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.salesReturnCorrection]: false })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)

const invoiceCountBefore = () => seed.count('SaleInvoice')
async function expectCanceledBarcodeRejected(credit, label) {
  const count = invoiceCountBefore()
  assert.equal(credit.status, 'CANCELED', `${label}: void cancels credit status`)
  assert.ok(credit.voidedAt != null, `${label}: credit has a void timestamp`)
  assert.equal(Number(credit.usedAmount), 0, `${label}: unused balance remains unspent`)
  assert.equal(Number(credit.usedCount), 0, `${label}: no use was recorded before void`)
  await assert.rejects(() => saleWithCode(credit.code, `${label}-redeem-after-void`), /باطل|لغو|غیرفعال|اعتبار/)
  assert.equal(seed.count('SaleInvoice'), count, `${label}: rejected scan creates no sale`)
}

// 1) A normal return issues its linked credit. Print that exact credit through
// the same existing credit-document service, then void the return.
const returnedSale = await invoice()
const returnResult = await salesService.createReturn({
  invoiceId: returnedSale.sale.id,
  full: false,
  lines: [{ saleItemId: returnedSale.items[0].id, qty: 1 }],
  refundMethod: RefundMethod.STORE_CREDIT,
  refundAmount: 600,
  userId,
  shiftId
})
const returnId = Number(returnResult.id ?? returnResult.returnId)
let returnCredit = creditRow(returnId)
assert.ok(returnCredit?.code)
printSetup()
await printService.printCredit({ id: returnCredit.id, deviceName: 'Axiom', silent: true, markPrinted: true })
returnCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', returnCredit.id)
assert.equal(returnCredit.status, 'ACTIVE')
assert.equal(Number(returnCredit.printCount), 1)
const beforeReturnVoid = invoiceCountBefore()
await salesService.returnDelete({
  id: returnId, userId, reason: 'ابطال برگشت آزمایشی پس از چاپ بارکد', panelPassword: DEFAULT_MANAGER_PASSWORD
})
returnCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', returnCredit.id)
assert.equal(invoiceCountBefore(), beforeReturnVoid, 'voiding return creates no invoice')
await expectCanceledBarcodeRejected(returnCredit, 'اعتبارِ برگشت فروش')

// 2) An exchange issues a linked barcode printed on the exchange receipt; then
// the manager prints the same saved row again and voids the whole exchange.
const exchangedSale = await invoice()
const replacementVariant = variant(200)
const exchange = await salesService.createExchange({
  invoiceId: exchangedSale.sale.id,
  lines: [{ saleItemId: exchangedSale.items[0].id, qty: 1 }],
  replacements: [{ variantId: replacementVariant, qty: 1 }],
  refundMode: 'STORE_CREDIT',
  methodId: cashMethodId,
  userId,
  shiftId
})
let exchangeCredit = creditRow(exchange.returnId)
assert.ok(exchangeCredit?.code)
printSetup()
const exchangePrint = await printService.printExchange({ returnId: exchange.returnId, deviceName: 'Axiom', silent: true, userId })
assert.equal(exchangePrint.returnId, exchange.returnId)
assert.ok(mock.state.windows.at(-1)?._html?.includes(exchangeCredit.code), 'exchange receipt prints this credit code')
exchangeCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', exchangeCredit.id)
assert.equal(Number(exchangeCredit.printCount), 1, 'exchange receipt print is recorded')
const recoveryPrint = await printService.printCredit({ id: exchangeCredit.id, deviceName: 'Axiom', silent: true, markPrinted: true, userId })
assert.equal(recoveryPrint.id, exchangeCredit.id)
const recoveryHtml = mock.state.windows.at(-1)?._html ?? ''
assert.ok(recoveryHtml.includes(exchangeCredit.code), 'manager print reuses the same code')
assert.ok(recoveryHtml.includes('نسخه‌ی مجدد'), 'manager copy is marked as a reprint')
exchangeCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', exchangeCredit.id)
assert.equal(Number(exchangeCredit.printCount), 2)
assert.equal(exchangeCredit.status, 'ACTIVE')
const beforeExchangeVoid = invoiceCountBefore()
await salesService.returnDelete({
  id: exchange.returnId,
  userId,
  reason: 'ابطال تعویض آزمایشی پس از چاپ دوباره بارکد',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
exchangeCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', exchangeCredit.id)
assert.equal(invoiceCountBefore(), beforeExchangeVoid, 'voiding exchange creates no invoice')
await expectCanceledBarcodeRejected(exchangeCredit, 'اعتبارِ تعویض')

// 3) The explicit compensation workflow also cancels an unused printed return
// credit when the manager selects CANCELED_UNUSED (it does not silently leave
// a redeemable barcode behind).
const correctionSale = await invoice()
const correctionReturn = await salesService.createReturn({
  invoiceId: correctionSale.sale.id,
  full: false,
  lines: [{ saleItemId: correctionSale.items[0].id, qty: 1 }],
  refundMethod: RefundMethod.STORE_CREDIT,
  refundAmount: 600,
  userId,
  shiftId
})
const correctionReturnId = Number(correctionReturn.id ?? correctionReturn.returnId)
let correctionCredit = creditRow(correctionReturnId)
printSetup()
await printService.printCredit({ id: correctionCredit.id, deviceName: 'Axiom', silent: true, markPrinted: true, userId })
const correction = await salesService.returnReconcileVoid({
  id: correctionReturnId,
  userId,
  reason: 'اصلاح آزمایشی برگشت دارای بارکد چاپ‌شده',
  panelPassword: DEFAULT_MANAGER_PASSWORD,
  cashRecovered: 0,
  cardRecovered: 0,
  cashPaidOut: 0,
  cardPaidOut: 0,
  creditOutcome: 'CANCELED_UNUSED'
})
assert.ok(correction?.id, 'return correction is recorded')
correctionCredit = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', correctionCredit.id)
await expectCanceledBarcodeRejected(correctionCredit, 'اعتبارِ اصلاح جبرانی برگشت')

console.log('✓ printed return/exchange credits are invalidated by void; correction can explicitly cancel a printed unused credit too')
