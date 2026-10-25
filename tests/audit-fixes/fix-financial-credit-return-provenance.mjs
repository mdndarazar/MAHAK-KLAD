/** H1/B/E: original opportunity, mixed cash/gift allocation, one-shot
 * dormant balance, nested branch, expiry and debt-first. Real services and
 * additive migrations on an isolated SQLite fixture, NOT a customer DB.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-return-provenance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-credit-return-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit, findRedeemable, changeCreditExpiry, deleteCredit } = await import('../../src/main/services/StoreCreditService.ts')
const { salesService, saleWhere } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { calculateReturnTotals } = await import('../../src/shared/accounting.ts')
const { returnBridgeShare, buildStatements } = await import('../../src/main/services/accountingReport.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate, jalaliStartOfDay, jalaliEndOfDay } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('H1 test')
const cat = seed.category('Credit provenance')
const product = seed.product('Credit item', cat)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId,
  openedAt: Date.now() - 10000, dayJalali: toJalaliDate(new Date()) })
function variant(price) {
  const id = seed.variant(product)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const v100 = variant(100), v400 = variant(400), v50 = variant(50), v500 = variant(500)
const line = (variantId, unitPrice, qty = 1) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const getItem = (invoiceId, variantId) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', invoiceId, variantId).id
const sale = (lines, payments = [], extra = {}) => salesService.create({ userId, shiftId, lines,
  payments: payments.map((amount) => ({ methodId, amount, destination: 'CASH' })), ...extra })
const ret = (invoiceId, saleItemId, refundMethod, refundAmount, full = false) => salesService.createReturn({
  invoiceId, full, lines: [{ saleItemId, qty: 1 }], refundMethod, refundAmount, userId, shiftId
})
const credit = (amount = 1_000) => db.$transaction((tx) => issueStoreCredit(tx, {
  source: 'MANUAL', amount, multiUse: false, maxUses: 1, carryRemainder: false, days: 30,
  note: 'هدیهٔ دارای فرصت یک‌بارمصرف', userId
}))

const h1 = await credit()
const expiry = new Date(h1.expiresAt).getTime()
const mixed = await sale([line(v100, 100), line(v400, 400)], [200],
  { storeCreditCode: h1.code, storeCreditAmount: 300, storeCreditIdempotencyKey: 'h1-spend-300' })
assert.equal(mixed.storeCreditApplied, 300)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', h1.id).status, 'USED')
await assert.rejects(() => ret(mixed.id, getItem(mixed.id, v100), 'CASH', 100), /سهم اعتبار|حق بازپرداخت|منشأ/)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "SaleReturn" WHERE invoiceId=?', mixed.id).n, 0)
const preview = await salesService.returnProvenancePreview({ invoiceId: mixed.id,
  lines: [{ saleItemId: getItem(mixed.id, v100), qty: 1 }] })
assert.deepEqual([preview.returnTotal, preview.debtReduced, preview.giftOpportunity, preview.cashRight], [100, 0, 100, 0])
const part = await ret(mixed.id, getItem(mixed.id, v100), 'NONE', 0)
assert.equal(part.refundAmount, 0)
assert.equal(part.creditOpportunity.restored, 100)
assert.equal(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', part.id).creditRestored, 100)
assert.equal(part.creditOpportunity.pendingDelivery.length, 1)
assert.equal(part.invoiceOverpaid, 0, 'the non-cash restoration cannot become OVERPAY')
const b = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', part.creditOpportunity.pendingDelivery[0].creditId)
assert.equal(Number(b.amount), 100)
assert.equal(b.status, 'DRAFT')
assert.equal(b.multiUse, 1)
assert.equal(new Date(b.expiresAt).getTime(), expiry, 'B retains H1 exact expiry')
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', h1.id).usedAmount, 300)
const partAllocation = seed.one('SELECT id,amount FROM "CreditReturnAllocation" WHERE returnId=?', part.id)
assert.equal(Number(partAllocation.amount), 100)
assert.throws(() => sql.prepare('UPDATE "CreditReturnAllocation" SET amount=amount+1 WHERE id=?').run(partAllocation.id),
  /CreditReturnAllocation is append-only/)
assert.throws(() => sql.prepare('DELETE FROM "CreditReturnAllocation" WHERE id=?').run(partAllocation.id),
  /CreditReturnAllocation is append-only/)
assert.equal(Number(seed.one('SELECT realMoneyRefundAmount FROM "SaleReturn" WHERE id=?', part.id).realMoneyRefundAmount), 0,
  'the source-credit-only return has no real-money entitlement')
assert.equal(Number(seed.one('SELECT creditReturnPolicyVersion FROM "SaleReturn" WHERE id=?', part.id).creditReturnPolicyVersion), 1)
assert.throws(() => sql.prepare('UPDATE "SaleReturn" SET realMoneyRefundAmount=1 WHERE id=?').run(part.id),
  /Real-money refund entitlement includes non-cashable source credit or exceeds return value/)
assert.throws(() => sql.prepare(`INSERT INTO "CashMovement" (amount,type,occurredAt,refType,refId)
  VALUES(?,?,?,?,?)`).run(1, 'RETURN_REFUND', Date.now(), 'SaleReturn', part.id),
  /Return cash refund exceeds the authorized real-money entitlement/)
assert.throws(() => sql.prepare(`INSERT INTO "CashMovement" (amount,type,occurredAt,refType,refId)
  VALUES(?,?,?,?,?)`).run(1, 'CASH_OUT', Date.now(), 'SaleReturn', part.id),
  /SaleReturn cash movements must use a policy-controlled refund type/)
assert.throws(() => sql.prepare('INSERT INTO "CardTransferRequest" (returnId,amount) VALUES(?,?)').run(part.id, 1),
  /Manager transfer exceeds the authorized real-money return entitlement/)
const creditTender = seed.one('SELECT id FROM "Payment" WHERE invoiceId=? AND storeCreditId=?', mixed.id, h1.id)
assert.throws(() => sql.prepare('UPDATE "Payment" SET destination=? WHERE id=?').run('CASH', creditTender.id),
  /Barcode credit is non-cashable and cannot have a money destination/)
const receiptHtml = await printService.returnHtml(part.id)
assert.match(receiptHtml, /سهم اعتبار غیرنقدی/)
assert.match(receiptHtml, /۰/)
assert.doesNotMatch(receiptHtml, new RegExp(h1.code + '|' + b.code), 'accounting receipt must not reveal credit credentials')
assert.equal((await printService.receiptDataFor(mixed.id)).remaining, 0)
await assert.rejects(() => findRedeemable(db, b.code), /پیش‌نویس/)
await assert.rejects(() => printService.creditHtml(b.id), /پیش‌نمایش|جانشین/)
await assert.rejects(() => printService.creditBatchDocs({ ids: [b.id] }), /گروهی|تحویل‌نشده/)
await assert.rejects(() => printService.printCredit({ id: b.id }), /رمز|گذرواژه/)
await assert.rejects(() => changeCreditExpiry({ id: h1.id, expiresAtJalali: null,
  reason: 'تمدید ناخواستهٔ منشأ', managerPassword: DEFAULT_MANAGER_PASSWORD }), /زنجیره/)
await assert.rejects(() => deleteCredit({ id: b.id, reason: 'حذف بی‌سند',
  managerPassword: DEFAULT_MANAGER_PASSWORD }), /زنجیره/)
await confirmCreditDelivery({ creditId: b.id, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'دریافت کد چاپی توسط مشتری با شاهد', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
console.log('✓ unrestricted 300 gift + 200 cash; a 100 return restores 100 gift first, with no cash entitlement')

// B is a multi-use barcode. A partial return restores its share onto B itself;
// it must not create a child E or reopen H1 in parallel.
const bSale = await sale([line(v50, 50, 2)], [50], { storeCreditCode: b.code,
  storeCreditAmount: 50, storeCreditIdempotencyKey: 'b-spend-50' })
const bReturn = await salesService.createReturn({ invoiceId: bSale.id, full: false,
  lines: [{ saleItemId: getItem(bSale.id, v50), qty: 1 }], refundMethod: 'NONE',
  refundAmount: 0, userId, shiftId })
assert.equal(bReturn.creditOpportunity.restored, 50)
assert.deepEqual(bReturn.creditOpportunity.pendingDelivery, [], 'return does not issue an E successor for multi-use B')
const bAllocation = seed.one('SELECT kind, amount, parentCreditId, rootCreditId, successorCreditId FROM "CreditReturnAllocation" WHERE returnId=?', bReturn.id)
assert.equal(bAllocation.kind, 'MULTI_USE_RESTORED')
assert.equal(Number(bAllocation.amount), 50)
assert.equal(bAllocation.parentCreditId, b.id)
assert.equal(bAllocation.rootCreditId, h1.id)
assert.equal(bAllocation.successorCreditId, null)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', b.id).usedAmount), 0,
  'returned share restores the same B barcode')
assert.equal(Number(seed.one('SELECT usedCount FROM "StoreCredit" WHERE id=?', b.id).usedCount), 1,
  'the prior redemption count is not rewound')
console.log('✓ multi-use B restores 50 on the same barcode; no E successor and no second H1 right')

const rest = await ret(mixed.id, getItem(mixed.id, v400), 'CASH', 200, true)
assert.equal(rest.refundAmount, 200)
assert.equal(rest.creditOpportunity.restored, 200)
const s = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', rest.creditOpportunity.pendingDelivery[0].creditId)
assert.equal(Number(s.amount), 900, 'supplement restores the dormant 700 only once, not previously branched 100')
assert.equal(s.status, 'DRAFT')
assert.equal(new Date(s.expiresAt).getTime(), expiry)
const allocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', rest.id)
assert.equal(Number(allocation.amount), 200)
assert.equal(Number(allocation.supplementUnspent), 700)
assert.equal(allocation.kind, 'SUPPLEMENT')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', h1.id).status, 'USED')
assert.equal(seed.one('SELECT compensatedReturnId FROM "StoreCreditRedemption" WHERE invoiceId=?', mixed.id).compensatedReturnId, rest.id)
assert.equal(rest.reversedCreditRedemptions, 0)
assert.equal(rest.invoiceRemaining, 0)
assert.equal(rest.invoiceOverpaid, 0)
assert.equal(seed.one('SELECT SUM(amount) AS n FROM "CreditReturnAllocation" WHERE invoiceId=?', mixed.id).n, 300)
assert.equal(seed.one('SELECT SUM(amount) AS n FROM "CashMovement" WHERE refType=? AND refId IN (?,?)', 'SaleReturn', part.id, rest.id).n, 200)
console.log('✓ full after B keeps H1 USED; S=900 (700 dormant+200 fresh), B=100, never doubles E')

// Full return without a previous branch restores the ORIGINAL H1 to 1M.
const direct = await credit()
const allGift = await sale([line(v500, 500)], [], { storeCreditCode: direct.code,
  storeCreditAmount: 300, storeCreditIdempotencyKey: 'direct-h1-300' })
const directReturn = await ret(allGift.id, getItem(allGift.id, v500), 'NONE', 0, true)
// The source barcode was fully consumed. A full return records the recovered
// gift value as a successor, while the original barcode remains terminal USED.
assert.equal(directReturn.creditOpportunity.restored, 300)
assert.equal(directReturn.creditOpportunity.pendingDelivery.length, 1)
assert.equal(directReturn.creditOpportunity.pendingDelivery[0].amount, 300)
assert.equal(directReturn.reversedCreditRedemptions, 1)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', direct.id).usedAmount), 300)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', direct.id).status, 'USED')
const directSuccessor = seed.one('SELECT id, amount, status, expiresAt FROM "StoreCredit" WHERE returnId=? AND sourceInvoiceId=?',
  directReturn.id, allGift.id)
assert.equal(Number(directSuccessor.amount), 300)
assert.equal(directSuccessor.status, 'DRAFT')
assert.equal(new Date(directSuccessor.expiresAt).getTime(), new Date(direct.expiresAt).getTime())
assert.equal(seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', directSuccessor.id).status, 'PENDING_DELIVERY')
assert.equal(seed.one('SELECT kind FROM "CreditReturnAllocation" WHERE returnId=?', directReturn.id).kind, 'ORIGINAL_REVERSED')
await assert.rejects(() => changeCreditExpiry({ id: direct.id, expiresAtJalali: null,
  reason: 'تمدید بارکد قدیمیِ مصرف‌شده', managerPassword: DEFAULT_MANAGER_PASSWORD }), /زنجیره|مصرف|USED/)
await confirmCreditDelivery({ creditId: directSuccessor.id, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'گواهی تحویل بارکد برگشتی', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', directSuccessor.id).status, 'ACTIVE')
const successorSale = await sale([line(v100, 100)], [], {
  storeCreditCode: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', directSuccessor.id).code,
  storeCreditAmount: 100, storeCreditIdempotencyKey: 'successor-after-full-return'
})
const successorReturn = await ret(successorSale.id, getItem(successorSale.id, v100), 'NONE', 0, true)
assert.equal(successorReturn.reversedCreditRedemptions, 1)
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', direct.id).usedAmount, 300)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', direct.id).status, 'USED')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CreditReturnAllocation" WHERE parentCreditId=? AND kind=?',
  direct.id, 'ORIGINAL_REVERSED').n, 1)
const secondSuccessor = seed.one('SELECT amount, status, expiresAt FROM "StoreCredit" WHERE returnId=? AND sourceInvoiceId=?',
  successorReturn.id, successorSale.id)
assert.equal(Number(secondSuccessor.amount), 100)
assert.equal(secondSuccessor.status, 'DRAFT')
assert.equal(new Date(secondSuccessor.expiresAt).getTime(), new Date(direct.expiresAt).getTime())
await confirmCreditDelivery({ creditId: Number(seed.one('SELECT id FROM "StoreCredit" WHERE returnId=? AND sourceInvoiceId=?',
  successorReturn.id, successorSale.id).id), witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'گواهی تحویل بارکد دوم', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
console.log('✓ full returns stage exact-expiry successors until witnessed handoff; original barcode stays USED')

const creditSale = await sale([line(v500, 500, 2)], [500])
const firstDebt = await ret(creditSale.id, getItem(creditSale.id, v500), 'NONE', 0)
assert.equal(firstDebt.refundAmount, 0)
assert.equal(firstDebt.invoiceRemaining, 0)
const secondDebt = await ret(creditSale.id, getItem(creditSale.id, v500), 'CASH', 500, true)
assert.equal(secondDebt.refundAmount, 500)
assert.equal(secondDebt.invoiceRemaining, 0)
console.log('✓ debt_first: two 500 items, paid 500/debt 500 => first reduces debt, second cash right 500')

const expired = await credit()
// A genuinely short original expiry: fix it BEFORE redemption so its new
// redemption snapshot agrees with the source, then let the clock pass.
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() + 1600, expired.id)
const expiredSale = await sale([line(v100, 100), line(v400, 400)], [200], { storeCreditCode: expired.code,
  storeCreditAmount: 300, storeCreditIdempotencyKey: 'expires-before-return' })
await new Promise((resolve) => setTimeout(resolve, 1700))
const expiredPart = await ret(expiredSale.id, getItem(expiredSale.id, v100), 'NONE', 0)
assert.equal(expiredPart.creditOpportunity.restored, 100)
assert.equal(expiredPart.creditOpportunity.pendingDelivery.length, 0)
assert.equal(seed.one('SELECT kind FROM "CreditReturnAllocation" WHERE returnId=?', expiredPart.id).kind, 'EXPIRED')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCredit" WHERE returnId=?', expiredPart.id).n, 0)
const expiredRest = await ret(expiredSale.id, getItem(expiredSale.id, v400), 'CASH', 200, true)
assert.equal(expiredRest.creditOpportunity.restored, 200)
assert.equal(expiredRest.creditOpportunity.pendingDelivery.length, 0)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCredit" WHERE returnId IN (?,?)', expiredPart.id, expiredRest.id).n, 0)
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', expired.id).usedAmount, 300)
console.log('✓ expiry mid-chain: 100+200 accounted as expired, no reissued credit, H1 never revived')
const fullyExpiredH1 = await credit()
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(Date.now() + 850, fullyExpiredH1.id)
const fullyExpiredSale = await sale([line(v100, 100)], [], {
  storeCreditCode: fullyExpiredH1.code, storeCreditAmount: 100,
  storeCreditIdempotencyKey: 'expired-full-return-without-branch'
})
await new Promise((resolve) => setTimeout(resolve, 950))
const fullyExpiredReturn = await ret(fullyExpiredSale.id, getItem(fullyExpiredSale.id, v100), 'NONE', 0, true)
assert.equal(fullyExpiredReturn.creditOpportunity.restored, 100)
assert.equal(fullyExpiredReturn.creditOpportunity.expiredShare, 100)
const expiredPaper = await printService.returnHtml(fullyExpiredReturn.id)
assert.match(expiredPaper, /منقضی بود و احیا نشد/)
assert.doesNotMatch(expiredPaper, /سهم معتبر اعتبار به فرصت قبلی/)
assert.equal(fullyExpiredReturn.reversedCreditRedemptions, 0)
assert.equal(fullyExpiredReturn.creditOpportunity.pendingDelivery.length, 0)
assert.equal(seed.one('SELECT kind FROM "CreditReturnAllocation" WHERE returnId=?', fullyExpiredReturn.id).kind, 'EXPIRED')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', fullyExpiredH1.id).status, 'USED')
console.log('✓ full return after original expiry: ledger records expired share; H1 is not reactivated')

const hBank = await credit()
const c2cSale = await sale([line(v100, 100), line(v400, 400)], [200], {
  storeCreditCode: hBank.code, storeCreditAmount: 300, storeCreditIdempotencyKey: 'c2c-gift-spend'
})
const c2cReturn = await ret(c2cSale.id, getItem(c2cSale.id, v100), 'CARD_TO_CARD', 200, true)
assert.equal(c2cReturn.cardTransfer.amount, 200)
const bankClaim = seed.one('SELECT * FROM "ReturnEntitlement" WHERE returnId=?', c2cReturn.id)
assert.equal(Number(bankClaim.cashRight), 200)
assert.equal(Number(bankClaim.cashPaid), 0)
assert.equal(Number(bankClaim.cashReserved), 200)
assert.equal(Number(bankClaim.giftOpportunity), 300)
assert.equal(seed.one('SELECT creditRestored FROM "SaleReturn" WHERE id=?', c2cReturn.id).creditRestored, 300)
assert.equal(Number(bankClaim.debtReduced), 0)
assert.equal(c2cReturn.creditOpportunity.restored, 300)
const pendingReceipt = await printService.returnHtml(c2cReturn.id)
assert.match(pendingReceipt, /شاهد پرداخت بانک نیست/)
assert.match(pendingReceipt, /هنوز شاهد تأییدشدهٔ بانک ثبت نشده/)
assert.doesNotMatch(pendingReceipt, new RegExp(hBank.code))
const blueBeforeManagerPay = await physicalMovementForCustodyShift(shiftId)
await cardTransferService.pay({
  id: c2cReturn.cardTransfer.id, paidAmount: 200, userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(await physicalMovementForCustodyShift(shiftId), blueBeforeManagerPay,
  'actual payment from the manager account never changes the store drawer/POS blue')
assert.throws(() => sql.prepare('UPDATE "CardTransferRequest" SET paidAmount=201 WHERE id=?')
  .run(c2cReturn.cardTransfer.id), /Manager payment exceeds the authorized real-money return entitlement/)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refId=? AND type IN (?,?)',
  c2cReturn.id, 'RETURN_REFUND', 'EXCHANGE_REFUND').n, 0,
  'manager account payment is not recorded as a store cash movement')
console.log('✓ full return reserves only 200 real money for C2C and restores 300 unrestricted credit; manager payment leaves blue unchanged')

const orphan = await credit()
const orphanSale = await sale([line(v100, 100)], [], { storeCreditCode: orphan.code,
  storeCreditIdempotencyKey: 'orphan-before-test' })
sql.prepare('DELETE FROM "StoreCreditRedemption" WHERE invoiceId=?').run(orphanSale.id)
await assert.rejects(() => ret(orphanSale.id, getItem(orphanSale.id, v100), 'CASH', 100, true), /منشأ|قابل اثبات/)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "SaleReturn" WHERE invoiceId=?', orphanSale.id).n, 0)
console.log('✓ orphan legacy Payment has UNKNOWN provenance, no inferred cash or gift')

const raceH1 = await credit()
const raceSale = await sale([line(v100, 100), line(v400, 400)], [200], {
  storeCreditCode: raceH1.code, storeCreditAmount: 300, storeCreditIdempotencyKey: 'race-h1-spend'
})
const raceFirstItem = getItem(raceSale.id, v100)
const raceItem = getItem(raceSale.id, v400)
await ret(raceSale.id, raceFirstItem, 'NONE', 0)
const workerArgs = ['--import', './test/harness/register.mjs',
  'tests/audit-fixes/helpers/financial-credit-return-race-worker.mjs',
  raceSale.id, raceItem, userId, shiftId, 200].map(String)
const subprocess = () => execFileAsync(process.execPath, workerArgs, {
  cwd: process.cwd(), env: { ...process.env, HARNESS_DB_EXISTING: '1' }, timeout: 20000
}).then(({ stdout }) => JSON.parse(stdout.trim()))
const contenders = await Promise.all([subprocess(), subprocess()])
assert.equal(contenders.filter((row) => row.ok).length, 1,
  `separate SQLite connections: ${JSON.stringify(contenders)}`)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "SaleReturn" WHERE invoiceId=?', raceSale.id).n, 2)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CreditReturnAllocation" WHERE invoiceId=?', raceSale.id).n, 2)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CardTransferRequest" WHERE sourceInvoiceId=? AND kind=?', raceSale.id, 'REQUEST').n, 1)
await assert.rejects(() => ret(raceSale.id, raceItem, 'CARD_TO_CARD', 200), /تعداد|قابل برگشت|برگشت خورده/)
console.log('✓ concurrent separate SQLite connections: exactly one B/request/return after prior general-credit restoration')

const report = calculateReturnTotals([
  { kind: 'RETURN', total: 100, refundMethod: 'CARD_TO_CARD', refundAmount: 40, creditRestored: 60 },
  { kind: 'RETURN', total: 300, refundMethod: 'NONE', refundAmount: 0, creditRestored: 300 },
  { kind: 'RETURN', total: 500, refundMethod: 'NONE', refundAmount: 0, creditRestored: 0 }
])
assert.equal(report.simpleReturns, 900)
assert.equal(report.cardToCardPending, 40)
assert.equal(report.debtOnlyReturns, 500)
assert.equal(returnBridgeShare({ id: 1, invoiceId: 1, receiptNo: 1, dateJalali: null,
  kind: 'RETURN', total: 100, refund: 40, debtCut: 0, method: 'CARD_TO_CARD', inScope: false },
'priorDebtReturns'), 0)
console.log('✓ report and bridge: gift 360 is not cash, debt, or prior-period debt reduction')
const today = toJalaliDate(new Date())
const filter = { fromJalali: today, toJalali: today }
const { statements } = await buildStatements({ where: saleWhere(filter),
  from: jalaliStartOfDay(today), to: jalaliEndOfDay(today),
  period: { fromJalali: today, toJalali: today, source: 'explicit' }, filter })
const persisted = seed.rows('SELECT total, refundMethod, refundAmount, creditRestored, kind FROM "SaleReturn" WHERE voidedAt IS NULL')
const expected = calculateReturnTotals(persisted)
assert.equal(statements.returns.simpleReturns, expected.simpleReturns)
assert.equal(statements.returns.debtOnlyReturns, expected.debtOnlyReturns,
  'aggregate reports must not mislabel H1/B/E as debt-only return')
assert.equal(statements.returns.cashRefunds, expected.cashRefunds)
console.log('✓ real aggregate report agrees with persisted H1/B/E snapshots, no invented debt-only returns')
