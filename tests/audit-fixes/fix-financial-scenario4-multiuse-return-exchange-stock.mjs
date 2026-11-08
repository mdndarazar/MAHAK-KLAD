/**
 * Scenario 4 multi-line characterization: a 50M multi-use barcode funds a 10M
 * sale of two items; those are exchanged for four 1M items; invoice 2 is then
 * exchanged for four items totaling 60M. Check lineage, payments, and stock in
 * the temporary harness database only.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-scenario4-multiuse-return-exchange-stock.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-scenario4-multiuse-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('scenario4-financial-audit')
const shiftId = seed.insert('Shift', {
  name: 'scenario4', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'S4-CASH', label: 'نقدی سناریو ۴', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('scenario4')
const productId = seed.product('scenario4-product', categoryId)
let variantNo = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S4-${label}-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const stock = (variantId) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const values = (rows) => rows.reduce((sum, row) => sum + Number(row), 0)

// Root barcode: 50M, multi-use, and 10M is redeemed over two sale lines.
const issued = await storeCreditService.issueManual({
  amount: 50_000_000,
  multiUse: true,
  maxUses: 10,
  carryRemainder: true,
  days: 30,
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
const root = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
const originalVariants = [variant('original-6m', 6_000_000), variant('original-4m', 4_000_000)]
const originalSale = await salesService.create({
  userId,
  shiftId,
  lines: [line(originalVariants[0], 6_000_000), line(originalVariants[1], 4_000_000)],
  payments: [],
  storeCreditCode: root.code,
  storeCreditIdempotencyKey: 'scenario4-root-redemption-10m'
})
const rootAfterSale = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
assert.equal(Number(rootAfterSale.amount), 50_000_000)
assert.equal(Number(rootAfterSale.usedAmount), 10_000_000)
assert.equal(Number(rootAfterSale.amount) - Number(rootAfterSale.usedAmount), 40_000_000)
assert.equal(rootAfterSale.status, 'PARTIALLY_USED')
assert.deepEqual(originalVariants.map(stock), [9, 9], 'both original items were removed from stock')

// Exchange the two returned items (6M + 4M) for four separate 1M items.
const originalItems = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', originalSale.id)
assert.equal(originalItems.length, 2)
const firstReplacementVariants = [1, 2, 3, 4].map((n) => variant(`replacement-1m-${n}`, 1_000_000))
const firstExchangeInput = {
  invoiceId: originalSale.id,
  lines: originalItems.map((item) => ({ saleItemId: Number(item.id), qty: 1 })),
  replacements: firstReplacementVariants.map((id) => line(id, 1_000_000))
}
const firstExchangePreview = await salesService.previewExchangeFunding(firstExchangeInput)
assert.equal(firstExchangePreview.ok, true, `first exchange preview: ${firstExchangePreview.error ?? ''}`)
assert.equal(Number(firstExchangePreview.nominalDiff), -6_000_000, 'nominal replacement-minus-return is still -6M')
const exchanged = await salesService.createExchange({
  ...firstExchangeInput,
  userId, shiftId,
  expectedSettlementDiff: Number(firstExchangePreview.effectiveDiff),
  refundMode: 'STORE_CREDIT'
})

const rootAfterExchange = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
const successors = seed.rows('SELECT id,amount,expiresAt,status,sourceInvoiceId,returnId FROM "StoreCredit" WHERE returnId=?', exchanged.returnId)
const ret = seed.one('SELECT restockPending,restockReleasedAt FROM "SaleReturn" WHERE id=?', exchanged.returnId)
const returnItems = seed.rows('SELECT qty,restockedQty,variantId FROM "SaleReturnItem" WHERE returnId=? ORDER BY id', exchanged.returnId)

assert.equal(Number(rootAfterExchange.usedAmount), 4_000_000)
assert.equal(rootAfterExchange.status, 'PARTIALLY_USED')
assert.equal(Number(rootAfterExchange.amount) - Number(rootAfterExchange.usedAmount), 46_000_000)
assert.equal(rootAfterExchange.expiresAt, rootAfterSale.expiresAt)
assert.equal(successors.length, 0, 'the live root barcode itself receives the 6M surplus')
assert.equal(Number(exchanged.diff), Number(firstExchangePreview.effectiveDiff),
  'the recorded settlement difference matches the source-funding preview; 6M source credit is restored separately')
assert.equal(Number(exchanged.sourceCreditRestoredAmount), 6_000_000)
assert.equal(returnItems.length, 2)
assert.deepEqual(returnItems.map((item) => Number(item.qty)), [1, 1])
assert.deepEqual(returnItems.map((item) => Number(item.restockedQty)), [1, 1])
assert.equal(ret.restockPending, 0)
assert.deepEqual(originalVariants.map(stock), [10, 10], 'both returned original items were immediately restocked')
assert.deepEqual(firstReplacementVariants.map(stock), [9, 9, 9, 9], 'all four replacement items were deducted')

console.log('✓ Exchange 1: two returned items totaling 10M → four replacement items totaling 4M.')
console.log(`  Root after exchange 1: amount=${Number(rootAfterExchange.amount)}, used=${Number(rootAfterExchange.usedAmount)}, remaining=${Number(rootAfterExchange.amount) - Number(rootAfterExchange.usedAmount)}, status=${rootAfterExchange.status}`)
console.log(`  Stock after exchange 1: originals=${originalVariants.map(stock).join('/')}; four 1M replacements=${firstReplacementVariants.map(stock).join('/')}; pending=${Boolean(ret.restockPending)}`)

// Return all four 1M lines from invoice 2, and create invoice 3 with four
// replacement lines totaling 60M. Consume the root's 46M first, then receive 10M cash.
const secondSourceItems = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', exchanged.exchangeInvoiceId)
assert.equal(secondSourceItems.length, 4, 'invoice 2 has four separate 1M items')
const finalPrices = [15_000_000, 15_000_000, 20_000_000, 10_000_000]
assert.equal(values(finalPrices), 60_000_000)
const finalVariants = finalPrices.map((price, index) => variant(`final-${index + 1}`, price))
const thirdExchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: exchanged.exchangeInvoiceId,
  lines: secondSourceItems.map((item) => ({ saleItemId: Number(item.id), qty: 1 })),
  replacements: finalVariants.map((id, index) => line(id, finalPrices[index])),
  exchangeCreditCode: root.code,
  idempotencyKey: 'scenario4-invoice2-to-invoice3-0001',
  methodId: cashMethodId
})
const rootAfterThirdInvoice = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', root.id)
const sourceInvoice2 = seed.one('SELECT sourceInvoiceId,orderType,exchangeReturnId FROM "SaleInvoice" WHERE id=?', exchanged.exchangeInvoiceId)
const finalInvoice3 = seed.one('SELECT sourceInvoiceId,orderType,exchangeReturnId,grandTotal FROM "SaleInvoice" WHERE id=?', thirdExchange.exchangeInvoiceId)
const secondReturn = seed.one('SELECT invoiceId,restockPending FROM "SaleReturn" WHERE id=?', thirdExchange.returnId)
const secondReturnItems = seed.rows('SELECT qty,restockedQty,variantId FROM "SaleReturnItem" WHERE returnId=? ORDER BY id', thirdExchange.returnId)
const secondRedemption = seed.one('SELECT amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?', thirdExchange.exchangeInvoiceId, root.id)
const thirdCashPayment = seed.one('SELECT amount FROM "Payment" WHERE invoiceId=? AND methodId=? AND voidedAt IS NULL', thirdExchange.exchangeInvoiceId, cashMethodId)
const noShareProvenance = seed.one(
  'SELECT eventKey,amount,redemptionId,sourceCreditId,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=? AND amount=0 ORDER BY id LIMIT 1',
  thirdExchange.returnId
)

assert.equal(Number(thirdExchange.diff), 56_000_000, '60M replacement less 4M returned items is a 56M difference')
assert.equal(Number(thirdExchange.barcodeCreditApplied), 46_000_000, 'the root balance of 46M is used first')
assert.equal(Number(thirdExchange.cashDue), 10_000_000)
assert.equal(Number(thirdExchange.cashReceived), 10_000_000)
assert.equal(Number(secondRedemption.amount), 46_000_000)
assert.ok(noShareProvenance, 'positive exchange of a child invoice retains the zero-value NO_SHARE lineage row')
assert.match(noShareProvenance.eventKey, /:iNO_SHARE$/)
assert.equal(Number(noShareProvenance.amount), 0, 'the lineage marker carries no financial value')
assert.equal(Number(noShareProvenance.sourceCreditId), Number(root.id))
assert.equal(noShareProvenance.restrictScope, 'ALL')
assert.equal(noShareProvenance.saleItemId, null)
assert.equal(Number(thirdCashPayment.amount), 10_000_000)
assert.equal(Number(rootAfterThirdInvoice.usedAmount), 50_000_000)
assert.equal(Number(rootAfterThirdInvoice.amount) - Number(rootAfterThirdInvoice.usedAmount), 0)
assert.equal(rootAfterThirdInvoice.status, 'USED')
assert.equal(rootAfterThirdInvoice.expiresAt, rootAfterSale.expiresAt, 'root expiry stays unchanged through the chain')
assert.equal(Number(sourceInvoice2.sourceInvoiceId), Number(originalSale.id), 'invoice 2 points back to invoice 1')
assert.equal(sourceInvoice2.orderType, 'EXCHANGE')
assert.equal(Number(finalInvoice3.sourceInvoiceId), Number(exchanged.exchangeInvoiceId), 'invoice 3 is created from invoice 2')
assert.equal(finalInvoice3.orderType, 'EXCHANGE')
assert.equal(Number(finalInvoice3.grandTotal), 60_000_000)
assert.equal(Number(secondReturn.invoiceId), Number(exchanged.exchangeInvoiceId), 'the second return belongs to invoice 2')
assert.equal(secondReturnItems.length, 4)
assert.deepEqual(secondReturnItems.map((item) => Number(item.qty)), [1, 1, 1, 1])
assert.deepEqual(secondReturnItems.map((item) => Number(item.restockedQty)), [1, 1, 1, 1])
assert.equal(secondReturn.restockPending, 0)
assert.deepEqual(firstReplacementVariants.map(stock), [10, 10, 10, 10], 'four returned 1M items return to stock once each')
assert.deepEqual(finalVariants.map(stock), [9, 9, 9, 9], 'all four invoice-3 replacement items are deducted')

console.log('✓ Chained exchange: invoice 1 (two lines) → invoice 2 (four 1M lines) → invoice 3 (four lines totaling 60M).')
console.log('  Invoice 2 was explicitly used as the source invoice for the second exchange.')
console.log('  Invoice 3 was settled by 4M returned value + 46M old barcode + 10M cash.')
console.log(`  Root after invoice 3: used=${Number(rootAfterThirdInvoice.usedAmount)}, remaining=${Number(rootAfterThirdInvoice.amount) - Number(rootAfterThirdInvoice.usedAmount)}, status=${rootAfterThirdInvoice.status}.`)
console.log(`  Stock: four returned 1M items=${firstReplacementVariants.map(stock).join('/')}; four new items=${finalVariants.map(stock).join('/')}; pending=${Boolean(secondReturn.restockPending)}.`)
