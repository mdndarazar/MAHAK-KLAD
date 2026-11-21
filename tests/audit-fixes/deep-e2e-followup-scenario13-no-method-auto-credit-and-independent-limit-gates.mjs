/**
 * Independent isolated regression: no selected refund method means no cash/POS
 * payout. Only genuinely overpay-backed money becomes non-expiring credit, and
 * the manager password for that credit limit is independent from refund/period
 * authorization.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s13-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('S13 no-method auto-credit cashier')
const shiftId = seed.insert('Shift', { name: 'S13 no-method return', number: 13, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const category = seed.category('S13 no-method category')
const product = seed.product('S13 no-method product', category)
const variant = seed.variant(product, 'S13-variant')
sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=1000 WHERE id=?').run(variant)
const cash = seed.insert('PaymentMethod', { key: 'S13-CASH', label: 'cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'S13-CARD', label: 'card', kind: 'CARD', isActive: 1, sortOrder: 2 })
const policy = await settingsService.accountingPolicy()
await settingsService.setAccountingPolicy({ policy: { ...policy, storeCreditLimit: 100 }, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
const n = x => Number(x ?? 0)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const raw = () => ({
  returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
  credits: seed.count('StoreCredit'),
  cashMoves: seed.count('CashMovement', 'shiftId=?', shiftId),
  payments: seed.count('Payment', 'createdShiftId=?', shiftId),
  returnCash: n(seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CASH'`, shiftId).amount),
  stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant).stock)
})

// Current policy rejects new overpayments, even with confirmation. Verify the
// rejection first, including the absence of financial/stock side effects.
const beforeOverpayAttempt = raw()
const invoicesBeforeAttempt = n(seed.count('SaleInvoice'))
await assert.rejects(() => salesService.create({
  userId, shiftId, lines: [line(variant, 1000)],
  payments: [{ methodId: cash, amount: 1200, destination: 'CASH' }],
  confirmOverpay: true, saleRequestIdempotencyKey: 's13-overpay-rejected'
}), /بیشتر است/)
assert.deepEqual(raw(), beforeOverpayAttempt, 'new overpayment rejection has no financial or stock mutation')
assert.equal(n(seed.count('SaleInvoice')), invoicesBeforeAttempt)

// Model an existing pre-S224 invoice in this isolated SQLite fixture only.
// Create the normal invoice via the service, then restore the historical paid
// amount and its corresponding attribution; do not relax production validation.
const sale = await salesService.create({
  userId, shiftId, lines: [line(variant, 1000)],
  payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }]
})
const paymentsBeforeFixture = seed.rows('SELECT id,amount,overpayAmount FROM "Payment" WHERE invoiceId=?', sale.id)
assert.equal(paymentsBeforeFixture.length, 1)
assert.equal(n(paymentsBeforeFixture[0].amount), 1000)
assert.equal(n(paymentsBeforeFixture[0].overpayAmount), 0)
sql.prepare('UPDATE "Payment" SET amount=1200, overpayAmount=200 WHERE id=?').run(paymentsBeforeFixture[0].id)
sql.prepare('UPDATE "SaleInvoice" SET paidTotal=1200 WHERE id=?').run(sale.id)
const paid = seed.rows('SELECT amount,overpayAmount FROM "Payment" WHERE invoiceId=?', sale.id)
assert.equal(paid.length, 1)
assert.equal(n(paid[0].amount), 1200)
assert.equal(n(paid[0].overpayAmount), 200)
const historical = seed.one('SELECT grandTotal,paidTotal FROM "SaleInvoice" WHERE id=?', sale.id)
assert.equal(n(historical.grandTotal), 1000)
assert.equal(n(historical.paidTotal), 1200)
assert.equal(raw().cashMoves, beforeOverpayAttempt.cashMoves, 'sale cash receipt is represented by Payment, not a separate cash movement')
const saleItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
const beforeReturn = raw()

// A historical overpayment must not bypass the new-return confirmation.
await assert.rejects(() => salesService.createReturn({
  userId, shiftId, invoiceId: n(sale.id), full: true,
  lines: [{ saleItemId: n(saleItem.id), qty: 1 }],
  refundDecision: 'DECLINED', refundMethod: 'NONE', refundNote: 'مشتری وجه نمی‌خواهد'
}), /اضافه‌دریافت/)
assert.deepEqual(raw(), beforeReturn, 'unconfirmed return does not mutate historical invoice or stock')

// An unrelated managerPassword must not satisfy the credit-limit gate.
await assert.rejects(() => salesService.createReturn({
  userId, shiftId, invoiceId: n(sale.id), full: true,
  lines: [{ saleItemId: n(saleItem.id), qty: 1 }],
  refundDecision: 'DECLINED', refundMethod: 'NONE', refundNote: 'اعتبار با درخواست صریح مشتری',
  confirmOverpay: true, overpayAsCredit: true, managerPassword: DEFAULT_MANAGER_PASSWORD
}), /تایید مدیر لازم دارد/)
assert.deepEqual(raw(), beforeReturn, 'rejected return/credit limit attempt has no financial or stock mutation')

// The dedicated credit authorization passes. The backed amount is capped by
// the actual 1,200 cash received; the account never issues beyond real funding.
const returned = await salesService.createReturn({
  userId, shiftId, invoiceId: n(sale.id), full: true,
  lines: [{ saleItemId: n(saleItem.id), qty: 1 }],
  refundDecision: 'DECLINED', refundMethod: 'NONE', refundNote: 'اعتبار با درخواست صریح مشتری',
  confirmOverpay: true, overpayAsCredit: true,
  overpayManagerPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(n(returned.refundAmount), 0, 'no physical refund is made')
assert.equal(returned.refundMethod, 'NONE')
assert.equal(n(returned.overpayAmount), 1000)
assert.equal(n(returned.overpayCredit?.amount), 1000, 'credit is limited to the actual backed overpay created by this return')
assert.ok(n(returned.overpayCredit?.amount) <= 1200, 'credit cannot exceed actual cash received')
assert.equal(returned.overpayCredit?.expiresAt ?? null, null, 'auto-issued credit never expires')
const credit = seed.one('SELECT id,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=?', returned.id)
assert.equal(n(credit.amount), 1000)
assert.equal(n(credit.usedAmount), 0)
assert.equal(credit.status, 'ACTIVE')
assert.equal(credit.expiresAt, null)
assert.equal(credit.source, 'OVERPAY')
const afterReturn = raw()
assert.equal(afterReturn.returns, beforeReturn.returns + 1)
assert.equal(afterReturn.credits, beforeReturn.credits + 1)
assert.equal(afterReturn.cashMoves, beforeReturn.cashMoves, 'NONE creates no cash payout movement')
assert.equal(afterReturn.returnCash, beforeReturn.returnCash, 'NONE creates no cash refund amount')
assert.equal(afterReturn.stock, beforeReturn.stock + 1, 'return restores stock exactly once')

// Explicitly declining a refund without choosing overpayAsCredit must never
// automatically create a barcode, even when the return produces an overpay.
const noCreditVariant = seed.variant(product, 'S13-no-automatic-credit')
sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=1000 WHERE id=?').run(noCreditVariant)
const noCreditSale = await salesService.create({
  userId, shiftId, lines: [line(noCreditVariant, 1000)],
  payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 's13-no-automatic-credit'
})
const noCreditItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', noCreditSale.id)
const beforeNoCredit = raw()
const declined = await salesService.createReturn({
  userId, shiftId, invoiceId: n(noCreditSale.id), full: true,
  lines: [{ saleItemId: n(noCreditItem.id), qty: 1 }],
  refundDecision: 'DECLINED', refundMethod: 'NONE', refundNote: 'مشتری وجه نمی‌خواهد', confirmOverpay: true
})
assert.equal(n(declined.refundAmount), 0)
assert.equal(declined.overpayCredit ?? null, null)
assert.equal(n(seed.count('StoreCredit')), n(beforeNoCredit.credits), 'no barcode is automatically issued')
assert.equal(n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', noCreditVariant).stock), 20)
assert.equal(raw().cashMoves, beforeNoCredit.cashMoves, 'declined refund does not create a cash payout')

// A negative exchange with a real-money surplus requires an explicit settlement.
// The general managerPassword is not a substitute for either the tender choice
// or the separate high-credit-limit authorization.
const original2 = seed.variant(product, 'S13-exchange-original')
const replacement = seed.variant(product, 'S13-exchange-replacement')
sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=1000 WHERE id=?').run(original2)
sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=800 WHERE id=?').run(replacement)
const sale2 = await salesService.create({
  userId, shiftId, lines: [line(original2, 1000)],
  payments: [{ methodId: card, amount: 1000, destination: 'CARD' }],
  saleRequestIdempotencyKey: 's13-exchange-source-sale'
})
const sale2Item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale2.id)
const exchangeInput = {
  userId, shiftId, invoiceId: n(sale2.id), full: false,
  lines: [{ saleItemId: n(sale2Item.id), qty: 1 }],
  replacements: [line(replacement, 800)],
  // This is the marker sent by the screen when no settlement option is picked.
  exchangeSettlementDecision: 'UNSELECTED'
}
const beforeExchange = raw()
await assert.rejects(
  () => salesService.createExchange({ ...exchangeInput, managerPassword: DEFAULT_MANAGER_PASSWORD }),
  /روش تسویه انتخاب نشده/
)
assert.deepEqual(raw(), beforeExchange, 'no explicit tender choice does not mutate the rejected exchange')
const explicitCreditChoice = {
  ...exchangeInput,
  refundMode: 'STORE_CREDIT',
  exchangeSettlementDecision: 'METHOD'
}
await assert.rejects(
  () => salesService.createExchange({ ...explicitCreditChoice, managerPassword: DEFAULT_MANAGER_PASSWORD }),
  /تایید مدیر لازم دارد/
)
assert.deepEqual(raw(), beforeExchange, 'general manager password does not pass the independent credit-limit gate')
const exchange = await salesService.createExchange({
  ...explicitCreditChoice, storeCreditManagerPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(n(exchange.diff), -200)
assert.equal(exchange.refundMode, 'STORE_CREDIT', 'credit is issued only after explicit tender choice')
assert.equal(n(exchange.payoutAmount), 0, 'no cash/card payout')
assert.equal(n(exchange.newStoreCreditAmount), 200, 'only the backed negative difference is credited')
const exchangeCredit = seed.one('SELECT id,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE exchangeInvoiceId=? ORDER BY id DESC LIMIT 1', exchange.exchangeInvoiceId)
assert.equal(n(exchangeCredit.amount), 200)
assert.equal(exchangeCredit.expiresAt, null)
assert.equal(exchangeCredit.source, 'EXCHANGE')
const postExchange = raw()
assert.equal(postExchange.cashMoves, beforeExchange.cashMoves)
assert.equal(postExchange.returnCash, beforeExchange.returnCash)
assert.equal(postExchange.stock, beforeExchange.stock)
assert.equal(n(await settingsService.accountingPolicy().then(p => p.storeCreditLimit)), 100)
console.log('Scenario 13 PASS: unselected exchange tender was blocked without writes; explicit STORE_CREDIT plus its dedicated authorization passed; automatic no-method credit selection stayed disabled.')
await db.$disconnect?.()
