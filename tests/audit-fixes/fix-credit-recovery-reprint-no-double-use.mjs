/**
 * Exercise the actual exchange-receipt and existing-credit print services with
 * the Electron printer mocked, then redeem the credential through a real sale.
 * This proves that printing the same barcode twice does not create or consume
 * a second credit; redemption remains single-use.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-credit-recovery-reprint-no-double-use.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-recovery-print-use-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
register('./support/s129-hooks.mjs', import.meta.url)

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS, DEFAULT_RECEIPT_TEMPLATE } = await import('../../src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await import('../../src/shared/credit.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const mock = await import('./support/s129-electron-mock.mjs')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const sourceInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 93001, issuedAtJalali: today, status: 'SETTLED', orderType: 'INTERNAL',
  returnCode: 'S93001', grandTotal: 1_000
})
const exchangeInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 93002, issuedAtJalali: today, status: 'SETTLED', orderType: 'EXCHANGE',
  returnCode: 'E93002', grandTotal: 1_000, sourceInvoiceId
})
const exchangeReturnId = seed.insert('SaleReturn', {
  invoiceId: sourceInvoiceId, kind: 'EXCHANGE', total: 1_000,
  returnedAtJalali: today, exchangeInvoiceId, exchangeReceiptNo: 93002
})
sql.prepare('UPDATE "SaleInvoice" SET exchangeReturnId=? WHERE id=?').run(exchangeReturnId, exchangeInvoiceId)

// Issue one normal persistent credit record and link it to the exchange.
const issued = await storeCreditService.issueManual({
  amount: 1_000,
  multiUse: false,
  carryRemainder: true,
  restrictScope: 'ALL',
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
sql.prepare('UPDATE "StoreCredit" SET returnId=?,exchangeInvoiceId=?,sourceInvoiceId=? WHERE id=?')
  .run(exchangeReturnId, exchangeInvoiceId, sourceInvoiceId, issued.id)
const original = seed.one('SELECT code,status,printCount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', issued.id)
assert.ok(original.code)
assert.equal(original.status, 'ACTIVE')
assert.equal(Number(original.printCount), 0)

// Printing is mocked at the OS boundary; production HTML and print services run.
mock.reset()
mock.state.printers = [{ name: 'Axiom', displayName: 'Axiom', isDefault: true }]
mock.state.executeJavaScriptOutcome = 500
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const originalExchangeGet = salesService.exchangeGet
salesService.exchangeGet = async ({ id }) => ({
  returnId: id,
  exchangeInvoiceId,
  receiptNo: 93001,
  exchangeReceiptNo: 93002,
  dateJalali: today,
  time: '12:00',
  customerName: 'مشتری تست',
  userName: 'مدیر تست',
  shiftName: null,
  returnedItems: [],
  returnTotal: 1_000,
  replacementItems: [],
  exchangeTotal: 1_000,
  diff: -1_000,
  settlementLabel: 'اعتبار خرید',
  cashReceived: 0,
  storeCreditAmount: 1_000,
  storeCreditStatusLabel: 'فعال',
  note: null
})

const creditCountBefore = seed.count('StoreCredit')
try {
  // A) One print from the exchange screen includes the already-issued barcode.
  const exchangeOutcome = await printService.printExchange({ returnId: exchangeReturnId, deviceName: 'Axiom', silent: true })
  assert.equal(exchangeOutcome.returnId, exchangeReturnId)
  assert.equal(mock.state.printCalls.length, 1, 'one exchange document was sent to mocked printer')
  const exchangeHtml = mock.state.windows.at(-1)?._html ?? ''
  assert.ok(exchangeHtml.includes(`<b>${original.code}</b>`), 'exchange receipt prints the existing credential text')
  assert.ok(exchangeHtml.includes(`alt="${original.code}"`), 'exchange receipt barcode represents the same existing code')
  assert.equal(seed.count('StoreCredit'), creditCountBefore, 'printing the exchange receipt issues no extra credit')
  let afterExchangePrint = seed.one('SELECT code,status,printCount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', issued.id)
  assert.equal(Number(afterExchangePrint.printCount), 1, 'successful exchange receipt counts its barcode copy')
  assert.equal(afterExchangePrint.status, 'ACTIVE')
  assert.equal(Number(afterExchangePrint.usedAmount), 0)
  assert.equal(Number(afterExchangePrint.usedCount), 0)

  // B) Manager recovery prints that same StoreCredit id, not an issue endpoint.
  const managerPrint = await printService.printCredit({
    id: issued.id,
    deviceName: 'Axiom',
    silent: true,
    markPrinted: true
  })
  assert.equal(managerPrint.id, issued.id)
  const standaloneHtml = mock.state.windows.at(-1)?._html ?? ''
  assert.ok(standaloneHtml.includes(original.code), 'recovery print contains the exact same existing code')
  assert.ok(standaloneHtml.includes(`alt="${original.code}"`), 'recovery barcode is the same code')
  assert.equal(seed.count('StoreCredit'), creditCountBefore, 'recovery print does not issue a second StoreCredit')
  let afterPrint = seed.one('SELECT code,status,printCount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', issued.id)
  assert.equal(afterPrint.code, original.code)
  assert.equal(afterPrint.status, 'ACTIVE', 'printing does not consume/close the credit')
  assert.equal(Number(afterPrint.printCount), 2, 'both physical copies are tracked')
  assert.ok(standaloneHtml.includes('نسخه‌ی مجدد'), 'manager recovery copy is visibly marked as a reprint')
  assert.equal(Number(afterPrint.usedAmount), 0)
  assert.equal(Number(afterPrint.usedCount), 0)

  // A definite cancellation changes no print audit. An unknown printer outcome
  // is counted conservatively so any later copy is never mislabeled as original.
  mock.state.printOutcome = 'canceled'
  await assert.rejects(
    () => printService.printExchange({ returnId: exchangeReturnId, deviceName: 'Axiom', silent: true }),
    /لغو/
  )
  assert.equal(Number(seed.one('SELECT printCount FROM "StoreCredit" WHERE id=?', issued.id).printCount), 2,
    'definite cancellation does not increment the counter')
  mock.state.printOutcome = 'crash'
  await assert.rejects(
    () => printService.printExchange({ returnId: exchangeReturnId, deviceName: 'Axiom', silent: true }),
    (error) => error?.printOutcomeUnknown === true
  )
  assert.equal(Number(seed.one('SELECT printCount FROM "StoreCredit" WHERE id=?', issued.id).printCount), 3,
    'uncertain printer result is conservatively tracked')
  mock.state.printOutcome = 'success'

  // C) The barcode works through the ordinary POS path once and is rejected on
  // a second redemption; duplicate paper copies are not duplicate value.
  const userId = seed.user('مدیر فروش تست اعتبار')
  const categoryId = seed.category('دسته تست چاپ')
  const productId = seed.product('کالای تست چاپ', categoryId)
  const variantId = seed.variant(productId, 'تست-چاپ')
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=1000 WHERE id=?').run(variantId)
  const shiftId = seed.insert('Shift', { name: 'شیفت تست چاپ', number: 1, dayJalali: today, openedAt: Date.now(), userId })
  const invoiceCountBefore = seed.count('SaleInvoice')
  const sale = (idempotencyKey) => salesService.create({
    userId,
    shiftId,
    lines: [{ variantId, qty: 1, unitPrice: 1_000, discount: 0, tax: 0 }],
    payments: [],
    storeCreditCode: original.code,
    storeCreditIdempotencyKey: idempotencyKey
  })
  const redeemed = await sale('recovery-print-use-once')
  assert.ok(redeemed, 'ordinary POS sale accepted the printed barcode once')
  afterPrint = seed.one('SELECT code,status,printCount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', issued.id)
  assert.equal(afterPrint.code, original.code)
  assert.equal(afterPrint.status, 'USED')
  assert.equal(Number(afterPrint.usedAmount), 1_000)
  assert.equal(Number(afterPrint.usedCount), 1)
  await assert.rejects(() => sale('recovery-print-use-twice'), /مصرف|استفاده|تمام|بسته|اعتبار/)
  assert.equal(seed.count('SaleInvoice'), invoiceCountBefore + 1, 'rejected second redemption creates no second sale')
  assert.equal(seed.count('StoreCredit'), creditCountBefore, 'two print routes plus one redemption remain one credit record')
  console.log('✓ exchange print is counted; manager recovery prints the same stored barcode as a marked reprint; POS redeems it once only')
} finally {
  salesService.exchangeGet = originalExchangeGet
}
