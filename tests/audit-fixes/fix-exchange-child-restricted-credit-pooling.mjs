/**
 * Regression for the critical exchange-child return bug:
 * Ordinary ALL-scope credit may pool over an exchange invoice, but manager-
 * restricted credit must retain its product/category eligibility after exchange.
 * Returning a different replacement product cannot restore that restricted share.
 *
 * Exercises ABC and CBA request order, full-cash overpayment rejection,
 * automatic source-traced refund (4M cash + 1M credit), replay safety, stock,
 * and the blue physical movement.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-child-restricted-credit-pooling.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-child-restricted-credit-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('exchange-child-credit-lineage')
const shiftId = seed.insert('Shift', {
  name: 'exchange-child-credit-lineage', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethod = seed.insert('PaymentMethod', {
  key: 'CHILD-CREDIT-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryA = seed.category('exchange-child-credit-A')
const categoryB = seed.category('exchange-child-credit-B')
const productA = seed.product('exchange-child-credit product A', categoryA)
const productB = seed.product('exchange-child-credit product B', categoryB)
let variantSeq = 0
const variant = (productId) => {
  const id = seed.variant(productId, `child-credit-${++variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=50,salePrice=5000000 WHERE id=?').run(id)
  return id
}
const saleItems = (invoiceId) => seed.rows(
  'SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId
)
const stock = (variantId) => Number(seed.one(
  'SELECT stock FROM "ProductVariant" WHERE id=?', variantId
).stock)
const sourceCodes = ['ABC', 'CBA']

for (const scope of ['VARIANTS', 'ALL']) {
for (const order of sourceCodes) {
  const sourceVariants = [variant(productA), variant(productB), variant(productA)]
  const replacementVariants = [variant(productB), sourceVariants[0], variant(productB)]
  const credit = await storeCreditService.issueManual({
    amount: 1_000_000,
    multiUse: false,
    carryRemainder: true,
    restrictScope: scope,
    ...(scope === 'VARIANTS' ? { restrictVariantIds: [sourceVariants[0]] } : {}),
    userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  const creditCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', credit.id).code
  const creditExpiry = seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', credit.id).expiresAt
  const blueStart = await physicalMovementForCustodyShift(shiftId)

  const sourceLines = sourceVariants.map((variantId) => ({
    variantId, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0
  }))
  const invoice = await salesService.create({
    userId,
    shiftId,
    lines: order === 'ABC' ? sourceLines : [...sourceLines].reverse(),
    payments: [{ methodId: cashMethod, amount: 14_000_000, destination: 'CASH' }],
    storeCreditCode: creditCode,
    storeCreditIdempotencyKey: `${scope}-credit-source-${order}`
  })
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 14_000_000,
    `${order}: only 14M received cash enters blue`)
  for (const variantId of sourceVariants) assert.equal(stock(variantId), 49)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', credit.id).status, 'USED')

  const sourceRows = saleItems(invoice.id)
  const sourceItemByVariant = new Map(sourceRows.map((row) => [Number(row.variantId), Number(row.id)]))
  const requestedSourceVariants = order === 'ABC' ? sourceVariants : [...sourceVariants].reverse()
  const requestedLines = requestedSourceVariants.map((variantId) => ({
    saleItemId: sourceItemByVariant.get(variantId), qty: 1
  }))
  const replacements = replacementVariants.map((variantId) => ({
    variantId, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0
  }))
  const exchange = await salesService.createExchange({
    userId, shiftId, invoiceId: invoice.id,
    lines: requestedLines,
    replacements: order === 'ABC' ? replacements : [...replacements].reverse()
  })
  assert.equal(exchange.diff, 0, `${order}: same total exchanged; no cash top-up/refund`)
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 14_000_000,
    `${order}: equal exchange adds no cash to blue`)
  const replacementSet = new Set(replacementVariants)
  for (const variantId of sourceVariants) assert.equal(stock(variantId), replacementSet.has(variantId) ? 49 : 50,
    `${order}: returned source items restock, net of any same-variant replacement`)
  for (const variantId of replacementVariants) assert.equal(stock(variantId), 49,
    `${order}: all three replacements are deducted`)

  const childRows = saleItems(exchange.exchangeInvoiceId)
  const returnedReplacement = childRows.find((row) => Number(row.variantId) === replacementVariants[0])
  assert.ok(returnedReplacement)
  const invoiceCountBeforeReplay = seed.count('SaleInvoice')
  const returnCountBeforeReplay = seed.count('SaleReturn')
  const blueBeforeReplay = await physicalMovementForCustodyShift(shiftId)
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: invoice.id,
    lines: requestedLines,
    replacements: order === 'ABC' ? replacements : [...replacements].reverse()
  }), /قبلاً در تعویض ثبت شده.*گزارشات فروش.*تعویض کالا|تعداد برگشتی برای پیش‌نمایش از باقی‌ماندهٔ مجاز بیشتر است/u)
  assert.equal(seed.count('SaleInvoice'), invoiceCountBeforeReplay,
    `${order}: replay creates no duplicate invoice`)
  assert.equal(seed.count('SaleReturn'), returnCountBeforeReplay,
    `${order}: replay creates no duplicate return`)
  assert.equal(await physicalMovementForCustodyShift(shiftId), blueBeforeReplay,
    `${order}: rejected replay does not move blue`)
  for (const variantId of replacementVariants) assert.equal(stock(variantId), 49,
    `${order}: rejected replay does not alter replacement stock`)

  // More than the item's full 5M return value is never permitted. For ALL credit,
  // only 4M is real money; for restricted credit on this B product, the credit
  // share is ineligible and the money right is 5M.
  const returnsBeforeOverpayment = seed.count('SaleReturn')
  await assert.rejects(() => salesService.createReturn({
    userId, shiftId,
    invoiceId: exchange.exchangeInvoiceId,
    lines: [{ saleItemId: returnedReplacement.id, qty: 1 }],
    refundMethod: 'CASH', refundAmount: 6_000_000
  }), /قابل‌تسویه|وجه واقعی|بیشتر|ارزش رسمی/u)
  assert.equal(seed.count('SaleReturn'), returnsBeforeOverpayment,
    `${order}: overpayment rejection creates no return`)
  assert.equal(await physicalMovementForCustodyShift(shiftId), blueBeforeReplay,
    `${order}: overpayment rejection does not move blue`)
  assert.equal(stock(returnedReplacement.variantId), 49,
    `${order}: overpayment rejection does not restock the item`)

  // Same as the UI's empty amount field: an ALL credit pools over this B item;
  // VARIANTS(A) remains restricted and therefore cannot be restored by B.
  const returned = await salesService.createReturn({
    userId, shiftId,
    invoiceId: exchange.exchangeInvoiceId,
    lines: [{ saleItemId: returnedReplacement.id, qty: 1 }],
    refundMethod: 'CASH'
  })
  const expectedCredit = scope === 'ALL' ? 1_000_000 : 0
  const expectedCash = 5_000_000 - expectedCredit
  assert.equal(Number(returned.total), 5_000_000, `${order}: whole item returned`)
  assert.equal(Number(returned.refundAmount), expectedCash,
    `${scope}/${order}: only source-traced money for this eligible return leaves the drawer`)
  const cashRefund = seed.one('SELECT amount FROM "CashMovement" WHERE refId=? AND type=?', returned.id, 'RETURN_REFUND')
  assert.equal(Number(cashRefund.amount), expectedCash,
    `${scope}/${order}: cash ledger records only actual money`)
  assert.equal(Number(returned.returnCreditAmount), expectedCredit,
    `${scope}/${order}: credit is pooled only for ALL scope`)
  assert.equal(Number(returned.sourceCreditRestoredAmount), expectedCredit)
  const allocationCount = seed.count('CreditReturnAllocation', 'returnId=?', returned.id)
  assert.equal(allocationCount, 1,
    `${scope}/${order}: persist either the positive allocation or the explicit zero-share proof`)
  if (scope === 'ALL') {
    const sourceAllocation = seed.one('SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', returned.id)
    assert.equal(Number(sourceAllocation.amount), 1_000_000)
    assert.equal(sourceAllocation.restrictScope, 'ALL')
    assert.equal(sourceAllocation.saleItemId, null, 'ordinary ALL credit is invoice-pooled')
  }
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueStart, 14_000_000 - expectedCash,
    `${scope}/${order}: only actual cash refund reduces blue; credit is noncash`)
  assert.equal(stock(returnedReplacement.variantId), 50,
    `${order}: returned replacement is restocked exactly once`)
  assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', credit.id).status, 'USED',
    `${order}: consumed source barcode remains USED`)
  const successorRows = seed.rows(
    'SELECT amount,expiresAt,status,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC',
    returned.id
  )
  assert.equal(successorRows.length, scope === 'ALL' ? 1 : 0,
    `${scope}/${order}: only pooled ALL credit is restored for replacement B`)
  if (scope === 'ALL') {
    const successor = successorRows[0]
    assert.equal(Number(successor.amount), 1_000_000)
    assert.equal(successor.expiresAt, creditExpiry)
    assert.equal(successor.status, 'ACTIVE')
    assert.equal(successor.restrictScope, 'ALL')
    assert.equal(successor.restrictVariantIdsJson, null)
  } else {
    const noShare = seed.one('SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', returned.id)
    assert.equal(Number(noShare.amount), 0, 'out-of-scope B records proof that no restricted credit funded this return')
    assert.equal(noShare.restrictScope, 'VARIANTS')
    assert.equal(noShare.saleItemId, null)
    // The same restricted source share is still refundable on its eligible A
    // replacement; it is not lost or rebound to the earlier B return.
    const allowedA = childRows.find((row) => Number(row.variantId) === replacementVariants[1])
    assert.ok(allowedA)
    const allowedReturn = await salesService.createReturn({
      userId, shiftId,
      invoiceId: exchange.exchangeInvoiceId,
      lines: [{ saleItemId: allowedA.id, qty: 1 }],
      refundMethod: 'CASH'
    })
    assert.equal(Number(allowedReturn.returnCreditAmount), 1_000_000)
    assert.equal(Number(allowedReturn.sourceCreditRestoredAmount), 1_000_000)
    assert.equal(Number(allowedReturn.refundAmount), 4_000_000)
    const eligibleAllocation = seed.one(
      'SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', allowedReturn.id
    )
    assert.equal(Number(eligibleAllocation.amount), 1_000_000)
    assert.equal(eligibleAllocation.restrictScope, 'VARIANTS')
    assert.equal(Number(eligibleAllocation.saleItemId), Number(allowedA.id),
      'restricted credit allocation stays on the eligible replacement line')
    const eligibleSuccessor = seed.one('SELECT restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE returnId=?', allowedReturn.id)
    assert.equal(eligibleSuccessor.restrictScope, 'VARIANTS')
    assert.equal(eligibleSuccessor.restrictVariantIdsJson, JSON.stringify([sourceVariants[0]]))
  }
  console.log(`✓ ${scope}/${order}: B return used ${expectedCash / 1_000_000}M real money + ${expectedCredit / 1_000_000}M eligible credit; order, replay, blue, and stock checks passed`)
}
}

// Exact historical gift-credit case: one 5M source item was paid with 4M
// cash + 1M manual gift credit, exchanged for a different variant, then the
// replacement is returned independently. A full 5M cash request must be
// rejected, while the UI's blank-amount/auto path returns 4M cash + 1M credit.
const giftSourceVariant = variant(productA)
const giftReplacementVariant = variant(productB)
const giftRoot = await storeCreditService.issueManual({
  amount: 1_000_000,
  multiUse: false,
  carryRemainder: true,
  restrictScope: 'ALL',
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
const giftRootRow = seed.one('SELECT code,expiresAt FROM "StoreCredit" WHERE id=?', giftRoot.id)
const giftBlueStart = await physicalMovementForCustodyShift(shiftId)
const giftSourceInvoice = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: giftSourceVariant, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethod, amount: 4_000_000, destination: 'CASH' }],
  storeCreditCode: giftRootRow.code,
  storeCreditIdempotencyKey: 'single-item-gift-source-mixed-4m-1m'
})
assert.equal(await physicalMovementForCustodyShift(shiftId) - giftBlueStart, 4_000_000)
const giftSourceItem = saleItems(giftSourceInvoice.id)[0]
const giftExchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: giftSourceInvoice.id,
  lines: [{ saleItemId: giftSourceItem.id, qty: 1 }],
  replacements: [{ variantId: giftReplacementVariant, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0 }]
})
assert.equal(giftExchange.diff, 0)
const sourceReceiptNo = Number(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id=?', giftSourceInvoice.id).receiptNo)
const exchangeReceiptNo = Number(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id=?', giftExchange.exchangeInvoiceId).receiptNo)
assert.notEqual(exchangeReceiptNo, sourceReceiptNo,
  'the exchange replacement has its own independent receipt number')
assert.equal(await physicalMovementForCustodyShift(shiftId) - giftBlueStart, 4_000_000,
  'same-value exchange does not move drawer cash')
const giftReplacementItem = saleItems(giftExchange.exchangeInvoiceId)[0]
const giftReturnsBeforeOverpayment = seed.count('SaleReturn')
await assert.rejects(() => salesService.createReturn({
  userId,
  shiftId,
  invoiceId: giftExchange.exchangeInvoiceId,
  lines: [{ saleItemId: giftReplacementItem.id, qty: 1 }],
  refundMethod: 'CASH',
  refundAmount: 5_000_000
}), /۴٬۰۰۰٬۰۰۰/)
assert.equal(seed.count('SaleReturn'), giftReturnsBeforeOverpayment,
  'full 5M cash attempt is rejected without creating a return')
assert.equal(await physicalMovementForCustodyShift(shiftId) - giftBlueStart, 4_000_000,
  'rejected 5M cash attempt leaves blue unchanged')
const giftReturn = await salesService.createReturn({
  userId,
  shiftId,
  invoiceId: giftExchange.exchangeInvoiceId,
  lines: [{ saleItemId: giftReplacementItem.id, qty: 1 }],
  refundMethod: 'CASH'
})
assert.equal(Number(giftReturn.total), 5_000_000)
assert.equal(Number(giftReturn.refundAmount), 4_000_000)
assert.equal(Number(giftReturn.returnCreditAmount), 1_000_000)
assert.equal(Number(giftReturn.sourceCreditRestoredAmount), 1_000_000)
assert.equal(Number(seed.one('SELECT amount FROM "CashMovement" WHERE refId=? AND type=?',
  giftReturn.id, 'RETURN_REFUND').amount), 4_000_000,
'gift-credit case writes only real cash to the cash ledger')
assert.equal(await physicalMovementForCustodyShift(shiftId) - giftBlueStart, 0,
  '4M received cash minus 4M refund; 1M gift credit never enters blue')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', giftRoot.id).status, 'USED')
const giftSuccessor = seed.one(
  'SELECT amount,source,expiresAt,status,restrictScope FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1',
  giftReturn.id
)
assert.equal(Number(giftSuccessor.amount), 1_000_000)
assert.equal(giftSuccessor.source, 'MANUAL')
assert.equal(giftSuccessor.expiresAt, giftRootRow.expiresAt)
assert.equal(giftSuccessor.status, 'ACTIVE')
assert.equal(giftSuccessor.restrictScope, 'ALL')
assert.equal(stock(giftReplacementVariant), 50,
  'returned replacement is restored to stock once')
const giftCashMovements = Number(seed.one(
  'SELECT COUNT(*) AS n FROM "CashMovement" WHERE refId=? AND type=?', giftReturn.id, 'RETURN_REFUND'
).n)
await assert.rejects(() => salesService.createReturn({
  userId,
  shiftId,
  invoiceId: giftExchange.exchangeInvoiceId,
  lines: [{ saleItemId: giftReplacementItem.id, qty: 1 }],
  refundMethod: 'CASH'
}), /قابل برگشت|باقی‌مانده|برگشت/)
assert.equal(seed.count('SaleReturn'), giftReturnsBeforeOverpayment + 1,
  'return replay does not create another return')
assert.equal(Number(seed.one(
  'SELECT COUNT(*) AS n FROM "CashMovement" WHERE refId=? AND type=?', giftReturn.id, 'RETURN_REFUND'
).n), giftCashMovements)
assert.equal(await physicalMovementForCustodyShift(shiftId) - giftBlueStart, 0,
  'return replay does not issue extra cash')

console.log('✓ restricted/ALL multi-item permutations and exact 4M cash + 1M gift-credit exchange-item return all pass')
