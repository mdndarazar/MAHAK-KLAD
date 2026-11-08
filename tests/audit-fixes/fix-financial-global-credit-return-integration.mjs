import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-global-credit-return-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { invoiceRemaining } = await import('../../src/main/services/invoiceDebt.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { exchangeReceiptHtml } = await import('../../src/main/print/templates.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('global-credit-return-manager')
const today = toJalaliDate(new Date())
const categoryA = seed.category('policy-A')
const categoryB = seed.category('policy-B')
const productA = seed.product('policy product A', categoryA)
const productB = seed.product('policy product B', categoryB)
const shiftId = seed.insert('Shift', { name: 'policy-return', number: 1, dayJalali: today, openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: 'POLICY-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
let n = 0
const variant = (productId, price) => {
  const id = seed.variant(productId, `P${++n}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=50,salePrice=? WHERE id=?').run(price, id)
  return id
}
const saleItems = (invoiceId) => seed.rows(
  'SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId
)
const manualCredit = async ({ amount, scope = 'ALL', variants = [], categories = [] }) => {
  const row = await storeCreditService.issueManual({
    amount, multiUse: false, carryRemainder: true, restrictScope: scope,
    restrictVariantIds: variants, restrictCategoryIds: categories,
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  return { id: row.id, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', row.id).code }
}
const createSale = (lines, payments, credit) => salesService.create({
  userId, shiftId,
  lines: lines.map((line) => ({ variantId: line.variantId, qty: 1, unitPrice: line.value, discount: 0, tax: 0 })),
  payments: payments > 0 ? [{ methodId: cashMethod, amount: payments, destination: 'CASH' }] : [],
  ...(credit ? { storeCreditCode: credit.code, storeCreditIdempotencyKey: `global-policy-${Date.now()}-${Math.random()}` } : {})
})
const returnLine = (invoiceId, itemId, amount, refundAmount) => salesService.createReturn({
  invoiceId, lines: [{ saleItemId: itemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount, userId, shiftId
})

// ALL-scope credit: pooled across four lines. A 20M return restores the 5M
// source share and exposes only 15M as a customer-selectable money right.
const pooled = await manualCredit({ amount: 5_000_000 })
const pooledItems = [
  { variantId: variant(productA, 20_000_000), value: 20_000_000 },
  { variantId: variant(productB, 20_000_000), value: 20_000_000 },
  { variantId: variant(productA, 20_000_000), value: 20_000_000 },
  { variantId: variant(productB, 20_000_000), value: 20_000_000 }
]
const pooledSale = await createSale(pooledItems, 75_000_000, pooled)
const pooledSaleItems = saleItems(pooledSale.id)
const firstPooledReturn = await returnLine(pooledSale.id, pooledSaleItems[0].id, 20_000_000, 15_000_000)
assert.equal(Number(firstPooledReturn.returnCreditAmount), 5_000_000)
assert.equal(firstPooledReturn.exchangeCreditReversed, null,
  'ordinary returns leave the new lineage-only field NULL so legacy parent-debt propagation is unchanged')
assert.equal(Number(firstPooledReturn.refundAmount), 15_000_000)
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', pooled.id).usedAmount), 5_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', pooled.id).status, 'USED',
  'the old one-shot barcode stays USED after source restoration')
const pooledRows = seed.rows('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', firstPooledReturn.id)
assert.equal(pooledRows.length, 1)
assert.equal(pooledRows[0].saleItemId, null, 'ALL pooled source shares never acquire a sale-item association')
assert.equal(pooledRows[0].restrictScope, 'ALL')
const pooledSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', firstPooledReturn.id)
assert.ok(pooledSuccessor)
assert.equal(Number(pooledSuccessor.amount), 5_000_000)
assert.equal(pooledSuccessor.expiresAt, seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', pooled.id).expiresAt)

const secondPooledReturn = await returnLine(pooledSale.id, pooledSaleItems[1].id, 20_000_000, 20_000_000)
assert.equal(Number(secondPooledReturn.returnCreditAmount), 0, 'the same pooled source is not returned twice across chunks')
assert.equal(Number(secondPooledReturn.refundAmount), 20_000_000)
assert.equal(Number(seed.one('SELECT SUM(amount) amount FROM "CreditReturnAllocation" WHERE invoiceId=? AND redemptionId=?',
  pooledSale.id, pooledRows[0].redemptionId).amount), 5_000_000)

// Manager-limited credit: returning B cannot consume A's credit entitlement;
// returning A restores exactly 2M and leaves an 8M real-money right.
const variantA = variant(productA, 10_000_000)
const variantB = variant(productB, 10_000_000)
const scoped = await manualCredit({ amount: 2_000_000, scope: 'VARIANTS', variants: [variantA] })
const scopedSale = await createSale([
  { variantId: variantA, value: 10_000_000 },
  { variantId: variantB, value: 10_000_000 }
], 18_000_000, scoped)
const scopedItems = saleItems(scopedSale.id)
const returnedB = await returnLine(scopedSale.id, scopedItems.find((item) => Number(item.variantId) === variantB).id,
  10_000_000, 10_000_000)
assert.equal(Number(returnedB.returnCreditAmount), 0)
assert.equal(Number(returnedB.refundAmount), 10_000_000, 'B keeps its full money right')
const noShareAllocation = seed.one(
  'SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', returnedB.id
)
assert.equal(Number(noShareAllocation.amount), 0, 'out-of-scope return keeps a zero-value NO_SHARE provenance row')
assert.equal(noShareAllocation.restrictScope, 'VARIANTS')
assert.equal(noShareAllocation.saleItemId, null)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', scoped.id).status, 'USED')

const returnedA = await returnLine(scopedSale.id, scopedItems.find((item) => Number(item.variantId) === variantA).id,
  10_000_000, 8_000_000)
assert.equal(Number(returnedA.returnCreditAmount), 2_000_000)
assert.equal(Number(returnedA.refundAmount), 8_000_000)
const scopedAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', returnedA.id)
assert.equal(Number(scopedAllocation.saleItemId), Number(scopedItems.find((item) => Number(item.variantId) === variantA).id))
assert.equal(scopedAllocation.restrictScope, 'VARIANTS')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', scoped.id).status, 'USED')
const scopedSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', returnedA.id)
assert.ok(scopedSuccessor)
assert.equal(Number(scopedSuccessor.amount), 2_000_000)
assert.equal(scopedSuccessor.restrictScope, 'VARIANTS')
assert.equal(scopedSuccessor.restrictVariantIdsJson, JSON.stringify([variantA]))

// Exchange must preserve the same source-vs-money split: out of a 20M returned
// item, 5M is restored to its spent barcode source and only the net 5M real
// money after the 10M replacement is offered for settlement.
const blueBeforeCashExchange = await physicalMovementForCustodyShift(shiftId)
const exchangeRoot = await manualCredit({ amount: 5_000_000 })
const exchangeItems = [20_000_000, 20_000_000, 20_000_000, 20_000_000]
  .map((value, index) => ({ variantId: variant(index % 2 ? productB : productA, value), value }))
const exchangeSale = await createSale(exchangeItems, 75_000_000, exchangeRoot)
const exchangeSaleItems = saleItems(exchangeSale.id)
const exchangeReplacement = variant(productA, 10_000_000)
const exchangeResult = await salesService.createExchange({
  userId, shiftId, invoiceId: exchangeSale.id,
  lines: [{ saleItemId: exchangeSaleItems[0].id, qty: 1 }],
  replacements: [{ variantId: exchangeReplacement, qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(exchangeResult.diff, -10_000_000)
assert.equal(exchangeResult.cashRefunded, 5_000_000,
  'only the 5M real-money remainder is paid out; the 5M barcode source is not cashed')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', exchangeRoot.id).status, 'USED',
  'the fully spent source barcode stays USED')
const exchangeSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', exchangeResult.returnId)
assert.ok(exchangeSuccessor)
assert.equal(Number(exchangeSuccessor.amount), 5_000_000, 'the original credit-source share is restored as a 5M successor')
const exchangeCashOut = seed.one('SELECT amount,type FROM "CashMovement" WHERE refId=? AND type=?',
  exchangeResult.returnId, 'EXCHANGE_REFUND')
assert.equal(Number(exchangeCashOut.amount), 5_000_000, 'only the seller-selected real-money share leaves the drawer/blue')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeCashExchange, 70_000_000,
  '75M real cash received minus only 5M actually refunded changes blue by 70M; barcode value is excluded')
assert.equal(exchangeSuccessor.status, 'ACTIVE')
assert.equal(exchangeResult.sourceCreditRestoredAmount, 5_000_000)
assert.equal(exchangeResult.realMoneyRefundAmount, 5_000_000)
const exchangeAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', exchangeResult.returnId)
assert.equal(Number(exchangeAllocation.amount), 5_000_000)
assert.equal(exchangeAllocation.saleItemId, null, 'exchange ALL-credit remains pooled')
assert.equal(exchangeAllocation.settlementAdjusted, 0,
  'exchange source credit is not counted a second time in the simple-return settlement bridge')

const makeExchangeCase = async (suffix, refundMode) => {
  const blueBefore = await physicalMovementForCustodyShift(shiftId)
  const root = await manualCredit({ amount: 5_000_000 })
  const items = [20_000_000, 20_000_000, 20_000_000, 20_000_000]
    .map((value, index) => ({ variantId: variant(index % 2 ? productB : productA, value), value }))
  const invoice = await createSale(items, 75_000_000, root)
  const rows = saleItems(invoice.id)
  const result = await salesService.createExchange({
    userId, shiftId, invoiceId: invoice.id,
    lines: [{ saleItemId: rows[0].id, qty: 1 }],
    replacements: [{ variantId: variant(productB, 10_000_000), qty: 1 }],
    refundMode
  })
  assert.equal(result.sourceCreditRestoredAmount, 5_000_000, `${suffix}: source share stays non-cash`)
  assert.equal(result.realMoneyRefundAmount, 5_000_000, `${suffix}: only the remaining real-money share is selectable`)
  assert.equal(result.cashRefunded, 0, `${suffix}: this mode does not create a cash refund`)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', root.id).status, 'USED')
  const successors = result.sourceCreditSuccessors.map((safeRow) =>
    seed.one('SELECT * FROM "StoreCredit" WHERE id=?', safeRow.id))
  assert.equal(successors.length, 1, `${suffix}: source successor remains a separate noncash barcode`)
  assert.equal(Number(successors[0].amount), 5_000_000)
  const cashOutCount = seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE refId=? AND type=?',
    result.returnId, 'EXCHANGE_REFUND').n
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBefore, 75_000_000,
    `${suffix}: the 75M receipt changes blue; source barcode and noncash payout do not`)
  return { result, successors, cashOutCount }
}

const pendingMode = await makeExchangeCase('card-to-card', 'CARD_TO_CARD')
assert.equal(pendingMode.result.cardToCard, 5_000_000, 'manager transfer request covers only real-money remainder')
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE returnId=?', pendingMode.result.returnId).status, 'PENDING')
assert.equal(pendingMode.cashOutCount, 0)

const storeCreditMode = await makeExchangeCase('store-credit', 'STORE_CREDIT')
assert.equal(Number(storeCreditMode.result.storeCredit.amount), 5_000_000,
  'seller-selected new barcode covers only the 5M real-money remainder')
assert.equal(storeCreditMode.successors.length, 1, 'the original source share is separately reissued as a successor')
assert.equal(storeCreditMode.cashOutCount, 0, 'barcode settlement does not change the drawer/blue')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCredit" WHERE returnId=?', storeCreditMode.result.returnId).n, 2,
  'the source successor and seller-selected money barcode are separate records')
const printedExchange = exchangeReceiptHtml({
  exchangeReceiptNo: 123, sourceReceiptNo: 45, dateJalali: today, time: '12:00:00',
  returnedItems: [], returnTotal: 20_000_000, replacementItems: [], exchangeTotal: 10_000_000,
  diff: -10_000_000, settlementLabel: 'صدور اعتبار', cashReceived: 0,
  storeCredits: [
    { code: 'SOURCE-SUCCESSOR-5M', amount: 5_000_000, label: 'اعتبار منشأدار غیرنقدی' },
    { code: 'MONEY-CHOICE-5M', amount: 5_000_000, label: 'اعتبار سهم وجه واقعی' }
  ]
})
assert.ok(printedExchange.includes('SOURCE-SUCCESSOR-5M'))
assert.ok(printedExchange.includes('MONEY-CHOICE-5M'))
assert.ok(printedExchange.includes('اعتبار منشأدار غیرنقدی'))
assert.ok(printedExchange.includes('اعتبار سهم وجه واقعی'))

// If the 5M source barcode expires between purchase and return, only that
// noncash share closes. The customer can settle the remaining 5M real money,
// but no new credit is created from the expired share.
const blueBeforeExpiredExchange = await physicalMovementForCustodyShift(shiftId)
const expiredRoot = await manualCredit({ amount: 5_000_000 })
const expiredItems = [20_000_000, 20_000_000, 20_000_000, 20_000_000]
  .map((value, index) => ({ variantId: variant(index % 2 ? productA : productB, value), value }))
const expiredSale = await createSale(expiredItems, 75_000_000, expiredRoot)
sql.prepare('UPDATE "StoreCredit" SET status=?, expiresAt=? WHERE id=?')
  .run('EXPIRED', Date.now() - 1_000, expiredRoot.id)
const expiredSaleItems = saleItems(expiredSale.id)
const expiredExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: expiredSale.id,
  lines: [{ saleItemId: expiredSaleItems[0].id, qty: 1 }],
  replacements: [{ variantId: variant(productA, 10_000_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(expiredExchange.sourceCreditRestoredAmount, 0)
assert.equal(expiredExchange.sourceCreditClosedExpiredAmount, 5_000_000)
assert.equal(expiredExchange.realMoneyRefundAmount, 5_000_000)
assert.equal(expiredExchange.cashRefunded, 5_000_000)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', expiredRoot.id).status, 'EXPIRED')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "StoreCredit" WHERE returnId=?', expiredExchange.returnId).n, 0,
  'the expired source share does not produce a successor or cash-equivalent barcode')
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeExpiredExchange, 70_000_000,
  'only the 5M real-money part changes the blue; the expired credit does not')

// A fully unpaid A item is exchanged for B, then B is returned. The return
// must cancel the transferred debt once, not create a new barcode or overpay.
const unpaidA = await createSale([{ variantId: variant(productA, 1_000_000), value: 1_000_000 }], 0, null)
const unpaidAItem = saleItems(unpaidA.id)[0]
const unpaidExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: unpaidA.id,
  lines: [{ saleItemId: unpaidAItem.id, qty: 1 }],
  replacements: [{ variantId: variant(productB, 800_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(unpaidExchange.debtReduction, 200_000)
assert.equal((await invoiceRemaining(db, unpaidA.id, 1_000_000, 0)).remaining, 800_000,
  'after exchanging unpaid A, only B’s 800K obligation remains')
const unpaidBItem = saleItems(unpaidExchange.exchangeInvoiceId)[0]
const returnedUnpaidB = await returnLine(unpaidExchange.exchangeInvoiceId, unpaidBItem.id, 800_000, 800_000)
assert.equal(returnedUnpaidB.refundMethod, 'NONE', 'unpaid A→B value cannot be paid out as cash')
assert.equal(Number(returnedUnpaidB.refundAmount), 0)
assert.equal(Number(returnedUnpaidB.exchangeCreditReversed), 800_000)
assert.equal(Number(returnedUnpaidB.invoiceRemaining), 0)
assert.equal(Number(returnedUnpaidB.invoiceOverpaid), 0)
assert.equal((await invoiceRemaining(db, unpaidA.id, 1_000_000, 0)).remaining, 0,
  'returning B clears the linked unpaid debt once')
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCredit" WHERE returnId=?', returnedUnpaidB.id).n, 0,
  'no new barcode is issued for unpaid exchange value')
assert.equal(seed.one('SELECT id FROM "SaleInvoice" WHERE id=?', unpaidExchange.exchangeInvoiceId).id,
  unpaidExchange.exchangeInvoiceId, 'B’s invoice remains as an audit record')

// A cash-paid A→B chain remains refundable: pooled debt-first reversal is zero
// when the linked invoices have no debt, and only the actual source cash leaves.
const paidA = await createSale([{ variantId: variant(productA, 1_000_000), value: 1_000_000 }], 1_000_000, null)
const paidAItem = saleItems(paidA.id)[0]
const paidExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: paidA.id,
  lines: [{ saleItemId: paidAItem.id, qty: 1 }],
  replacements: [{ variantId: variant(productB, 800_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(paidExchange.cashRefunded, 200_000)
const paidBItem = saleItems(paidExchange.exchangeInvoiceId)[0]
const returnedPaidB = await returnLine(paidExchange.exchangeInvoiceId, paidBItem.id, 800_000, 800_000)
assert.equal(returnedPaidB.refundMethod, 'CASH')
assert.equal(Number(returnedPaidB.refundAmount), 800_000)
assert.equal(Number(returnedPaidB.exchangeCreditReversed), 0)
assert.equal(Number(returnedPaidB.invoiceRemaining), 0)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refId=? AND type=?',
  returnedPaidB.id, 'RETURN_REFUND').amount), 800_000,
  'cash payout remains limited to the real-money source on paid A')

// Barcode-funded A→B→return B remains noncash end to end. The source credit
// used on A is split by the exchange into a 200K A-return successor and 800K
// carried by B; returning B restores only that carried share with root expiry.
const barcodeRoot = await manualCredit({ amount: 1_000_000 })
const barcodeExpiry = seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', barcodeRoot.id).expiresAt
const barcodeA = await createSale(
  [{ variantId: variant(productA, 1_000_000), value: 1_000_000 }], 0, barcodeRoot
)
const barcodeAItem = saleItems(barcodeA.id)[0]
const barcodeExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: barcodeA.id,
  lines: [{ saleItemId: barcodeAItem.id, qty: 1 }],
  replacements: [{ variantId: variant(productB, 800_000), qty: 1 }],
  refundMode: 'STORE_CREDIT'
})
assert.equal(barcodeExchange.nominalDiff, -200_000, 'the nominal return-minus-replacement gap remains visible')
assert.equal(barcodeExchange.diff, 0, 'restored source credit is separate from effective money settlement')
assert.equal(barcodeExchange.sourceCreditRestoredAmount, 200_000)
assert.equal(barcodeExchange.cashRefunded, 0)
const barcodeB = saleItems(barcodeExchange.exchangeInvoiceId)[0]
const returnedBarcodeB = await returnLine(barcodeExchange.exchangeInvoiceId, barcodeB.id, 800_000, 800_000)
assert.equal(returnedBarcodeB.refundMethod, 'NONE')
assert.equal(Number(returnedBarcodeB.refundAmount), 0)
assert.equal(Number(returnedBarcodeB.returnCreditAmount), 800_000)
assert.equal(Number(returnedBarcodeB.sourceCreditRestoredAmount), 800_000)
assert.equal(Number(returnedBarcodeB.exchangeCreditReversed), 0)
assert.equal(Number(returnedBarcodeB.invoiceRemaining), 0)
assert.equal(seed.count('CashMovement', 'refId=? AND type=?', returnedBarcodeB.id, 'RETURN_REFUND'), 0,
  'barcode-funded return never issues a cash refund')
const barcodeSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', returnedBarcodeB.id)
assert.equal(Number(barcodeSuccessor.amount), 800_000)
assert.equal(barcodeSuccessor.expiresAt, barcodeExpiry, 'the successor preserves the original barcode expiry')
const barcodeAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=?', returnedBarcodeB.id)
assert.equal(Number(barcodeAllocation.amount), 800_000)
assert.equal(barcodeAllocation.saleItemId, null, 'ALL credit remains invoice-pooled on child return')
assert.equal(barcodeAllocation.settlementAdjusted, 1)
assert.equal(seed.one('SELECT id FROM "SaleInvoice" WHERE id=?', barcodeA.id).id, barcodeA.id)
assert.equal(seed.one('SELECT id FROM "SaleInvoice" WHERE id=?', barcodeExchange.exchangeInvoiceId).id,
  barcodeExchange.exchangeInvoiceId, 'both A and B remain available for audit')

// Mixed A source: 300K barcode + 200K cash + 500K invoice debt. Exchanging
// for an 800K B clears 200K of A debt; returning B then restores 300K as a
// barcode, reverses the remaining 300K chain debt, and pays only 200K cash.
const mixedRoot = await manualCredit({ amount: 300_000 })
const mixedA = await createSale(
  [{ variantId: variant(productA, 1_000_000), value: 1_000_000 }], 200_000, mixedRoot
)
const mixedAItem = saleItems(mixedA.id)[0]
const mixedExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: mixedA.id,
  lines: [{ saleItemId: mixedAItem.id, qty: 1 }],
  replacements: [{ variantId: variant(productB, 800_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(mixedExchange.nominalDiff, -200_000, 'the nominal return/replacement gap is reduced against source debt')
assert.equal(mixedExchange.diff, 0, 'the effective settlement is zero after the 200K debt cut')
assert.equal(mixedExchange.debtReduction, 200_000)
assert.equal(mixedExchange.cashRefunded, 0, 'the debt-backed portion is not paid out as cash')
assert.equal((await invoiceRemaining(db, mixedA.id, 1_000_000, 500_000)).remaining, 300_000)
const mixedB = saleItems(mixedExchange.exchangeInvoiceId)[0]
const returnedMixedB = await returnLine(mixedExchange.exchangeInvoiceId, mixedB.id, 800_000, 200_000)
assert.equal(Number(returnedMixedB.returnCreditAmount), 300_000)
assert.equal(Number(returnedMixedB.exchangeCreditReversed), 300_000)
assert.equal(Number(returnedMixedB.refundAmount), 200_000)
assert.equal(Number(returnedMixedB.invoiceRemaining), 0)
assert.equal((await invoiceRemaining(db, mixedA.id, 1_000_000, 500_000)).remaining, 0)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refId=? AND type=?',
  returnedMixedB.id, 'RETURN_REFUND').amount), 200_000,
  'mixed lineage exposes only its traced 200K cash source after credit and debt')
assert.equal(Number(seed.one('SELECT amount FROM "CreditReturnAllocation" WHERE returnId=?',
  returnedMixedB.id).amount), 300_000)

console.log('✓ global returns and exchange: pooled ALL, restricted scope, source credit stays noncash, expired share closes, debt-first child return, and real-money settlement')
