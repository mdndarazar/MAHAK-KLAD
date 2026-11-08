/**
 * Manager recovery: scan an exchange invoice barcode (or enter its receipt
 * number) and find the exact already-issued credit records linked to it.
 * Lookup must be read-only and must never return a redeemable credit code.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-credit-invoice-recovery-lookup.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-invoice-recovery-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const today = toJalaliDate(new Date())
const sql = db.$harness.db

const sourceInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 82001, issuedAtJalali: today, status: 'SETTLED', orderType: 'INTERNAL',
  returnCode: 'SRCINVOICE1', grandTotal: 5_000_000
})
const exchangeInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 82002, issuedAtJalali: today, status: 'SETTLED', orderType: 'EXCHANGE',
  returnCode: 'EXCHINVOICE1', grandTotal: 5_000_000, sourceInvoiceId
})
const exchangeReturnId = seed.insert('SaleReturn', {
  invoiceId: sourceInvoiceId, kind: 'EXCHANGE', total: 5_000_000,
  returnedAtJalali: today, exchangeInvoiceId: exchangeInvoiceId, exchangeReceiptNo: 82002
})
sql.prepare('UPDATE "SaleInvoice" SET exchangeReturnId=? WHERE id=?').run(exchangeReturnId, exchangeInvoiceId)

const directExchangeCredit = await storeCreditService.issueManual({
  amount: 1_000_000,
  multiUse: false,
  carryRemainder: true,
  restrictScope: 'ALL',
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
sql.prepare('UPDATE "StoreCredit" SET returnId=?,exchangeInvoiceId=?,sourceInvoiceId=? WHERE id=?')
  .run(exchangeReturnId, exchangeInvoiceId, sourceInvoiceId, directExchangeCredit.id)

// A direct return made from the scanned replacement invoice is also linked to
// that exact invoice. It appears beside the exchange credit, without traversing
// further descendants from sourceInvoiceId.
const childReturnId = seed.insert('SaleReturn', {
  invoiceId: exchangeInvoiceId, kind: 'RETURN', total: 500_000, returnedAtJalali: today
})
const childReturnCredit = await storeCreditService.issueManual({
  amount: 500_000,
  multiUse: false,
  carryRemainder: true,
  restrictScope: 'ALL',
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
sql.prepare('UPDATE "StoreCredit" SET returnId=?,sourceInvoiceId=? WHERE id=?')
  .run(childReturnId, exchangeInvoiceId, childReturnCredit.id)

// This credit only names the scanned invoice as an old source ancestor. It is
// deliberately not returned: lookup follows direct document links, not guesses
// across the entire descendant chain.
const unrelatedDescendantCredit = await storeCreditService.issueManual({
  amount: 250_000,
  multiUse: false,
  carryRemainder: true,
  restrictScope: 'ALL',
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
sql.prepare('UPDATE "StoreCredit" SET sourceInvoiceId=? WHERE id=?')
  .run(exchangeInvoiceId, unrelatedDescendantCredit.id)

const countBefore = seed.count('StoreCredit')
const originalDirectBarcode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', directExchangeCredit.id).code
const byBarcode = await storeCreditService.linkedCreditsForInvoice({ code: 'EXCHINVOICE1' })
assert.equal(byBarcode.invoice.receiptNo, 82002)
assert.equal(byBarcode.invoice.lookupKind, 'BARCODE')
assert.deepEqual(byBarcode.credits.map((credit) => Number(credit.id)).sort((a, b) => a - b),
  [directExchangeCredit.id, childReturnCredit.id].sort((a, b) => a - b))
assert.ok(byBarcode.credits.every((credit) => !('code' in credit)),
  'lookup returns only safe references; no redeemable barcode crosses IPC')
assert.equal(byBarcode.credits.find((credit) => credit.id === directExchangeCredit.id).publicReference,
  `اعتبار #${directExchangeCredit.id}`)
assert.equal(seed.count('StoreCredit'), countBefore, 'lookup never issues a new credit')
assert.equal(seed.one('SELECT code FROM "StoreCredit" WHERE id=?', directExchangeCredit.id).code,
  originalDirectBarcode, 'the existing barcode record stays unchanged')

const byReceipt = await storeCreditService.linkedCreditsForInvoice({ code: '۸۲۰۰۲' })
assert.equal(byReceipt.invoice.lookupKind, 'RECEIPT')
assert.deepEqual(byReceipt.credits.map((credit) => Number(credit.id)).sort((a, b) => a - b),
  [directExchangeCredit.id, childReturnCredit.id].sort((a, b) => a - b))

const noCreditInvoiceId = seed.insert('SaleInvoice', {
  receiptNo: 82003, issuedAtJalali: today, status: 'SETTLED', orderType: 'EXCHANGE',
  returnCode: 'EXCHNOCREDIT', grandTotal: 0
})
const noCreditResult = await storeCreditService.linkedCreditsForInvoice({ code: 'EXCHNOCREDIT' })
assert.equal(noCreditResult.invoice.id, noCreditInvoiceId)
assert.deepEqual(noCreditResult.credits, [], 'missing issued credit is reported as empty, not fabricated')
assert.equal(seed.count('StoreCredit'), countBefore)

seed.insert('SaleInvoice', {
  receiptNo: 82004, issuedAtJalali: today, status: 'SETTLED', orderType: 'INTERNAL',
  returnCode: 'EXCHINVOICE1', grandTotal: 0
})
await assert.rejects(() => storeCreditService.linkedCreditsForInvoice({ code: 'EXCHINVOICE1' }), /چند سند قدیمی/,
  'reused invoice barcode fails closed instead of choosing a possibly wrong credit')
assert.equal(seed.count('StoreCredit'), countBefore)

// The only renderer action for a found credit must print its existing id. The
// lookup IPC itself is manager-session gated on the main side.
const ipcSource = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../src/renderer/src/pages/CreditManagement.tsx', import.meta.url), 'utf8')
assert.match(ipcSource, /handle\(IPC\.creditInvoiceLookup, async \(p\) => \{\s*assertManagerSession/)
assert.match(uiSource, /const printLinkedCredit = async \(creditId: number\)[\s\S]*?await printOne\(creditId\)/)
assert.doesNotMatch(uiSource, /printLinkedCredit[\s\S]{0,300}creditIssue/,
  'invoice recovery must not call a credit-issue operation')

console.log('✓ manager invoice lookup finds only directly linked existing credits by barcode/receipt; safe, read-only, and ambiguity-safe')
