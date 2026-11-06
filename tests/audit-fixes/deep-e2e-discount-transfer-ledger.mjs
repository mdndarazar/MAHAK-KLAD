/**
 * Historical-discount transfer E2E across preview, commit, replay, settlement,
 * inventory and exchange void. Every run constructs a fresh SQLite DB from the
 * repository migrations; no live/staging database or real payment is touched.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-discount-transfer-ledger.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-transfer-e2e-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const {
  discountTransferAmounts,
  discountTransferExplanation,
  discountTransferPolicyDelta,
  recommendDiscountTransferChoices
} = await import('../../src/shared/discountTransfer.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const number = (value) => Number(value ?? 0)
const userId = seed.user('historical discount transfer e2e cashier')

// Pure policy boundaries: Δ=R−N, with transfer capped by historical discount and capacity.
assert.equal(discountTransferPolicyDelta(950_000, 800_000), 150_000)
for (const [delta, expected] of [
  [-1, 0], [0, 0], [1, 1], [149_999, 149_999], [150_000, 150_000],
  [200_000, 200_000], [200_001, 200_000], [300_000, 200_000]
]) {
  const zero = discountTransferAmounts({
    historicalDiscount: 200_000, capacity: 1_000_000, policyDelta: delta,
    protectExtraRefund: true, refundValueWithoutTransfer: 0, refundValueWithFullTransfer: 0
  }).find((row) => row.option === 'YES_ZERO')
  assert.equal(number(zero?.transferAmount), expected, `YES_ZERO transfer for Δ=${delta}`)
}
assert.equal(number(discountTransferAmounts({
  historicalDiscount: 200_000, capacity: 50_000, policyDelta: 100_000,
  protectExtraRefund: true, refundValueWithoutTransfer: 0, refundValueWithFullTransfer: 0
}).find((row) => row.option === 'YES_ZERO')?.transferAmount), 50_000, 'replacement capacity caps YES_ZERO')
assert.equal(discountTransferExplanation('YES_ZERO', 200_000, 150_000, (n) => n.toLocaleString('fa-IR')),
  'تخفیف کالای قبلی ۲۰۰٬۰۰۰ ریال بود؛ با انتخاب این گزینه، ۱۵۰٬۰۰۰ ریال تخفیف به کالای جدید منتقل می‌شود و ۵۰٬۰۰۰ ریال باقی‌مانده که برای تخفیف است به مشتری بازپرداخت نمی‌شود.')
assert.match(discountTransferExplanation('YES', 200_000, 150_000, (n) => n.toLocaleString('fa-IR')),
  /۵۰٬۰۰۰ ریال باقی‌مانده به‌دلیل سقف ظرفیت منتقل نمی‌شود/)
assert.match(discountTransferExplanation('NO', 200_000, 0, (n) => n.toLocaleString('fa-IR')),
  /۲۰۰٬۰۰۰ ریال باقی‌ماندهٔ تخفیف به مشتری بازپرداخت نمی‌شود/)
const recommendationExample = recommendDiscountTransferChoices([
  { option: 'NO', transferAmount: 0, enabled: true, disabledReason: null, refundValue: 100_000 },
  { option: 'YES', transferAmount: 200_000, enabled: false, disabledReason: 'guard', refundValue: 150_000 },
  { option: 'YES_ZERO', transferAmount: 150_000, enabled: true, disabledReason: null, refundValue: 100_000 }
])
assert.equal(recommendationExample.find((row) => row.option === 'YES_ZERO')?.recommended, true,
  'ordinary baseline refund does not disqualify safe recommendation')
assert.equal(recommendationExample.find((row) => row.option === 'NO')?.recommended, false,
  'lower safe transfer is not recommended when a higher safe transfer exists')
const shiftId = seed.insert('Shift', {
  name: 'historical discount transfer e2e', number: 65001,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'TRANSFER-E2E-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'TRANSFER-E2E-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2
})
const categoryId = seed.category('historical-discount-transfer-e2e')
let variantNumber = 0
function makeVariant(label, price) {
  const productId = seed.product(`discount transfer ${label} ${++variantNumber}`, categoryId)
  const variantId = seed.variant(productId, `TRANSFER-E2E-${variantNumber}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, variantId)
  return variantId
}
function stock(variantId) {
  return number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
}
function stockLedger(variantId) {
  return number(seed.one('SELECT COALESCE(SUM(delta),0) value FROM "StockMovement" WHERE variantId=?', variantId).value)
}

const scenarios = [
  { option: 'YES', source: 1_000_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacement: 1_100_000, replacementDiscount: 50_000, replacementInvoiceDiscount: 50_000,
    transfer: 200_000, exchangeTotal: 800_000, diff: 0 },
  { option: 'NO', source: 1_000_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacement: 1_200_000, replacementDiscount: 50_000, replacementInvoiceDiscount: 50_000,
    transfer: 0, exchangeTotal: 1_100_000, diff: 300_000 },
  { option: 'YES_ZERO', source: 1_000_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacement: 1_200_000, replacementDiscount: 50_000, replacementInvoiceDiscount: 50_000,
    transfer: 200_000, exchangeTotal: 900_000, diff: 100_000 },
  // Agreed example: N=800,000; R=950,000; d=200,000 => t=150,000.
  { option: 'YES_ZERO', source: 1_000_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacement: 1_050_000, replacementDiscount: 50_000, replacementInvoiceDiscount: 50_000,
    transfer: 150_000, exchangeTotal: 800_000, diff: 0 }
]

for (const [index, scenario] of scenarios.entries()) {
  const sourceVariantId = makeVariant(`source-${scenario.option}`, scenario.source)
  const replacementVariantId = makeVariant(`replacement-${scenario.option}`, scenario.replacement)
  const sourceNet = scenario.source - scenario.sourceLineDiscount - scenario.sourceInvoiceDiscount
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: sourceVariantId, qty: 1, unitPrice: scenario.source, discount: scenario.sourceLineDiscount, tax: 0 }],
    invoiceDiscount: scenario.sourceInvoiceDiscount,
    payments: [{ methodId: cashMethodId, amount: sourceNet, destination: 'CASH' }]
  })
  const sourceItem = seed.one('SELECT id,lineTotal,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  assert.equal(number(sourceItem.discount), scenario.sourceLineDiscount)
  assert.equal(number(sale.grandTotal), sourceNet)

  const replacements = [{
    variantId: replacementVariantId, qty: 1, unitPrice: scenario.replacement,
    discount: scenario.replacementDiscount, tax: 0
  }]
  const lines = [{ saleItemId: number(sourceItem.id), qty: 1 }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: number(sale.id), lines, replacements,
    invoiceDiscount: scenario.replacementInvoiceDiscount,
    discountTransferOption: scenario.option
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(number(preview.discountTransfer?.historicalDiscount), 200_000)
  assert.equal(number(preview.discountTransfer?.capacity), scenario.replacement - scenario.replacementDiscount - scenario.replacementInvoiceDiscount)
  assert.equal(number(preview.discountTransfer?.selectedAmount), scenario.transfer)
  assert.equal(number(preview.discountTransfer?.policyDelta),
    scenario.replacement - scenario.replacementDiscount - scenario.replacementInvoiceDiscount - sourceNet)
  assert.equal(number(preview.exchangeTotal), scenario.exchangeTotal)
  assert.equal(number(preview.effectiveDiff), scenario.diff)
  for (const option of ['NO', 'YES', 'YES_ZERO']) {
    const outcome = preview.discountTransfer.options.find((row) => row.option === option)
    assert.ok(outcome, `preview includes the ${option} option`)
    for (const field of ['effectiveDiff', 'realMoneyRefund', 'debtReduction', 'sourceCreditRestoration', 'sourceCreditClosedExpired'])
      assert.ok(Number.isFinite(Number(outcome[field])), `${option} preview exposes ${field}`)
  }
  assert.equal(number(preview.replacementTaxes?.reduce((sum, amount) => sum + amount, 0)), 0)
  if (index === scenarios.length - 1) {
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'YES_ZERO').recommended, true,
      'reference N=800,000 / R=950,000 recommends the 150,000 safe partial transfer')
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'NO').recommended, false)
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'YES').recommended, false)
  }

  const requestIdempotencyKey = `transfer-e2e-${index}-${scenario.option.toLowerCase()}`
  const input = {
    userId, shiftId, invoiceId: number(sale.id), lines, replacements,
    invoiceDiscount: scenario.replacementInvoiceDiscount,
    expectedSettlementDiff: scenario.diff,
    discountTransferOption: scenario.option,
    expectedDiscountTransferAmount: scenario.transfer,
    requestIdempotencyKey,
    methodId: cashMethodId
  }
  await assert.rejects(
    () => salesService.createExchange({ ...input, discountTransferOption: undefined }),
    /پیش از ثبت تعویض، گزینهٔ انتقال تخفیف تاریخی را صریح انتخاب کنید/
  )
  const committed = await salesService.createExchange(input)
  assert.equal(number(committed.returnTotal), sourceNet)
  assert.equal(number(committed.exchangeTotal), scenario.exchangeTotal)
  assert.equal(number(committed.diff), scenario.diff)
  assert.equal(number(committed.discountTransferAmount), scenario.transfer)
  assert.equal(committed.discountTransferOption, scenario.option)

  const replay = await salesService.createExchange(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.returnId, committed.returnId)
  assert.equal(replay.exchangeInvoiceId, committed.exchangeInvoiceId)
  await assert.rejects(
    () => salesService.createExchange({ ...input, discountTransferOption: scenario.option === 'NO' ? 'YES' : 'NO' }),
    /کلید ثبت تعویض قبلاً برای درخواست مالی متفاوتی استفاده شده است/
  )

  const child = seed.one('SELECT id,grandTotal,discountTotal,paidTotal FROM "SaleInvoice" WHERE id=?', committed.exchangeInvoiceId)
  const childItem = seed.one('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', committed.exchangeInvoiceId)
  assert.equal(number(child.grandTotal), scenario.exchangeTotal)
  assert.equal(number(child.paidTotal), scenario.exchangeTotal)
  assert.equal(number(child.discountTotal), scenario.replacementDiscount + scenario.replacementInvoiceDiscount + scenario.transfer)
  assert.equal(number(childItem.discount), scenario.replacementDiscount + scenario.transfer)
  assert.equal(number(childItem.lineTotal), scenario.replacement - scenario.replacementDiscount - scenario.transfer)

  const transferEvents = seed.rows('SELECT eventType,amount,windowDiscount,sourceQtyStart,sourceQtyEnd,childInvoiceId FROM "DiscountTransferEvent" WHERE sourceReturnId=? ORDER BY id', committed.returnId)
  if (scenario.transfer > 0) {
    assert.equal(transferEvents.filter((event) => event.eventType === 'TRANSFER').reduce((sum, event) => sum + number(event.amount), 0), scenario.transfer)
    assert.equal(transferEvents.filter((event) => event.eventType === 'EXPIRE').reduce((sum, event) => sum + number(event.amount), 0), 200_000 - scenario.transfer)
  } else {
    assert.equal(transferEvents.filter((event) => event.eventType === 'TRANSFER').length, 0)
    assert.equal(transferEvents.filter((event) => event.eventType === 'EXPIRE').reduce((sum, event) => sum + number(event.amount), 0), 200_000)
  }
  assert.equal(transferEvents.filter((event) => event.eventType !== 'VOID').reduce((sum, event) => sum + number(event.windowDiscount), 0) >= 200_000, true)

  const paymentRows = seed.rows('SELECT amount,kind,destination FROM "Payment" WHERE invoiceId=? AND voidedAt IS NULL', committed.exchangeInvoiceId)
  assert.equal(paymentRows.reduce((sum, payment) => sum + number(payment.amount), 0), scenario.exchangeTotal)
  assert.equal(paymentRows.filter((payment) => payment.destination === 'CASH').reduce((sum, payment) => sum + number(payment.amount), 0), scenario.diff)
  assert.equal(stock(sourceVariantId), 10)
  assert.equal(stock(replacementVariantId), 9)
  assert.equal(stock(sourceVariantId), 10 + stockLedger(sourceVariantId))
  assert.equal(stock(replacementVariantId), 10 + stockLedger(replacementVariantId))

  if (index === 0) {
    const voided = await salesService.returnDelete({
      id: committed.returnId, userId, reason: 'E2E void must not restore historical discount',
      panelPassword: DEFAULT_MANAGER_PASSWORD
    })
    assert.ok(voided)
    const voidEvents = seed.rows('SELECT eventType,amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', committed.returnId, 'VOID')
    assert.equal(voidEvents.length, transferEvents.filter((event) => event.eventType === 'TRANSFER' || event.eventType === 'EXPIRE').length)
    assert.ok(voidEvents.every((event) => number(event.amount) === 0 && JSON.parse(event.provenanceJson).sourceWindowNotRestored === true))
    assert.ok(seed.count('DiscountTransferEvent', 'sourceInvoiceId=? AND sourceQtyStart=0 AND sourceQtyEnd=1 AND eventType IN (?,?)', sale.id, 'TRANSFER', 'EXPIRE') > 0)
    assert.equal(stock(sourceVariantId), 9)
    assert.equal(stock(replacementVariantId), 10)
    assert.equal(stock(sourceVariantId), 10 + stockLedger(sourceVariantId))
    assert.equal(stock(replacementVariantId), 10 + stockLedger(replacementVariantId))
  }
}

// Merchandise policy basis excludes taxes and service charges even though actual return settlement includes them.
const taxedSource = makeVariant('taxed-source', 1_000_000)
const taxedReplacement = makeVariant('taxed-replacement', 950_000)
const taxedSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: taxedSource, qty: 1, unitPrice: 1_000_000, discount: 100_000, tax: 0 }],
  invoiceDiscount: 100_000,
  payments: [{ methodId: cashMethodId, amount: 800_000, destination: 'CASH' }]
})
const taxedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', taxedSale.id)
// Model a historical invoice with item tax and service charge; the checkout policy itself is intentionally unchanged.
sql.prepare('UPDATE "SaleInvoiceItem" SET tax=100000,lineTotal=1000000 WHERE id=?').run(taxedItem.id)
sql.prepare('UPDATE "SaleInvoice" SET taxTotal=100000,serviceCharge=30000,grandTotal=930000,paidTotal=930000 WHERE id=?').run(taxedSale.id)
sql.prepare('UPDATE "Payment" SET amount=930000 WHERE invoiceId=? AND voidedAt IS NULL').run(taxedSale.id)
assert.equal(number(seed.one('SELECT grandTotal FROM "SaleInvoice" WHERE id=?', taxedSale.id).grandTotal), 930_000)
const taxedPreview = await salesService.previewExchangeFunding({
  invoiceId: number(taxedSale.id),
  lines: [{ saleItemId: number(taxedItem.id), qty: 1 }],
  replacements: [{ variantId: taxedReplacement, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }],
  discountTransferOption: 'YES_ZERO'
})
assert.equal(taxedPreview.ok, true, taxedPreview.error)
assert.equal(number(taxedPreview.returnTotal), 930_000, 'actual settlement return still includes source tax/service')
assert.equal(number(taxedPreview.discountTransfer.policyDelta), 150_000,
  'policy Δ compares merchandise-only R=950,000 against N=800,000')
assert.equal(number(taxedPreview.discountTransfer.selectedAmount), 150_000)

// End-to-end preview boundaries around N and N+d; the ordinary refund at R<N remains a valid baseline.
const boundarySource = makeVariant('boundary-source', 1_000_000)
const boundaryReplacement = makeVariant('boundary-replacement', 1_100_000)
const boundarySale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: boundarySource, qty: 1, unitPrice: 1_000_000, discount: 100_000, tax: 0 }],
  invoiceDiscount: 100_000,
  payments: [{ methodId: cashMethodId, amount: 800_000, destination: 'CASH' }]
})
const boundaryItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', boundarySale.id)
for (const [replacementNet, expectedTransfer] of [
  [700_000, 0], [799_999, 0], [800_000, 0], [800_001, 1],
  [999_999, 199_999], [1_000_000, 200_000], [1_000_001, 200_000]
]) {
  const preview = await salesService.previewExchangeFunding({
    invoiceId: number(boundarySale.id),
    lines: [{ saleItemId: number(boundaryItem.id), qty: 1 }],
    replacements: [{ variantId: boundaryReplacement, qty: 1, unitPrice: replacementNet, discount: 0, tax: 0 }],
    discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(number(preview.discountTransfer.policyDelta), replacementNet - 800_000)
  assert.equal(number(preview.discountTransfer.selectedAmount), expectedTransfer, `preview at R=${replacementNet}`)
  assert.equal(number(preview.exchangeTotal), replacementNet - expectedTransfer)
  assert.equal(number(preview.returnTotal), 800_000, 'settlement return baseline remains the actual returned value')
  if (replacementNet === 700_000) {
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'NO').recommended, true)
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'YES_ZERO').recommended, true,
      'normal cheaper-replacement refund is not confused with refund caused by historical transfer')
    assert.equal(preview.discountTransfer.options.find((row) => row.option === 'YES').recommended, false)
  }
}

// Partial-quantity return: both N and the historical discount are prorated from the same merchandise-only item basis.
const partialSourceVariant = makeVariant('partial-quantity-source', 1_000_000)
const partialReplacementVariant = makeVariant('partial-quantity-replacement', 950_000)
const partialSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: partialSourceVariant, qty: 2, unitPrice: 1_000_000, discount: 200_000, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 1_800_000, destination: 'CASH' }]
})
const partialItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', partialSale.id)
const partialLines = [{ saleItemId: number(partialItem.id), qty: 1 }]
const partialReplacements = [{ variantId: partialReplacementVariant, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
const partialPreview = await salesService.previewExchangeFunding({
  invoiceId: number(partialSale.id), lines: partialLines, replacements: partialReplacements,
  discountTransferOption: 'YES_ZERO'
})
assert.equal(partialPreview.ok, true, partialPreview.error)
assert.equal(number(partialPreview.returnTotal), 900_000)
assert.equal(number(partialPreview.discountTransfer.historicalDiscount), 100_000)
assert.equal(number(partialPreview.discountTransfer.policyDelta), 50_000)
assert.equal(number(partialPreview.discountTransfer.selectedAmount), 50_000)
const partialExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: number(partialSale.id), lines: partialLines, replacements: partialReplacements,
  discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 50_000, expectedSettlementDiff: 0,
  requestIdempotencyKey: 'transfer-partial-quantity-001'
})
assert.equal(number(partialExchange.discountTransferAmount), 50_000)
assert.equal(number(partialExchange.returnTotal), 900_000)
assert.equal(number(partialExchange.exchangeTotal), 900_000)

// Same policy transaction across cash, card, store-credit barcode, and split funding.
for (const mode of ['CASH', 'CARD', 'STORE_CREDIT', 'MIXED']) {
  const sourceVariantId = makeVariant(`tender-source-${mode}`, 1_000_000)
  const replacementVariantId = makeVariant(`tender-replacement-${mode}`, 950_000)
  const tender = mode === 'CASH'
    ? { payments: [{ methodId: cashMethodId, amount: 800_000, destination: 'CASH' }] }
    : mode === 'CARD'
      ? { payments: [{ methodId: cardMethodId, amount: 800_000, destination: 'CARD' }] }
      : mode === 'MIXED'
        ? { payments: [
            { methodId: cashMethodId, amount: 400_000, destination: 'CASH' },
            { methodId: cardMethodId, amount: 400_000, destination: 'CARD' }
          ] }
        : { payments: [], storeCredits: [] }
  if (mode === 'STORE_CREDIT') {
    const credit = await storeCreditService.issueManual({
      amount: 800_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'isolated discount-transfer tender matrix'
    })
    const creditRow = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', credit.id)
    tender.storeCredits = [{ code: creditRow.code, requestedAmount: 800_000 }]
  }
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: sourceVariantId, qty: 1, unitPrice: 1_000_000, discount: 100_000, tax: 0 }],
    invoiceDiscount: 100_000,
    ...tender
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  const lines = [{ saleItemId: number(sourceItem.id), qty: 1 }]
  const replacements = [{ variantId: replacementVariantId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: number(sale.id), lines, replacements, discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview.ok, true, `${mode}: ${preview.error}`)
  assert.equal(number(preview.discountTransfer.policyDelta), 150_000, `${mode}: tender-independent Δ`)
  assert.equal(number(preview.discountTransfer.selectedAmount), 150_000, `${mode}: tender-independent transfer`)
  const exchanged = await salesService.createExchange({
    userId, shiftId, invoiceId: number(sale.id), lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: `transfer-tender-${mode.toLowerCase()}-001`
  })
  assert.equal(number(exchanged.returnTotal), 800_000, `${mode}: actual return baseline`)
  assert.equal(number(exchanged.discountTransferAmount), 150_000, `${mode}: committed transfer matches preview`)
  assert.equal(number(exchanged.exchangeTotal), 800_000, `${mode}: no accidental positive/negative settlement`)
  const tenderEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', exchanged.returnId)
  assert.equal(tenderEvents.filter((event) => event.eventType === 'TRANSFER').reduce((sum, event) => sum + number(event.amount), 0), 150_000)
  assert.equal(tenderEvents.filter((event) => event.eventType === 'EXPIRE').reduce((sum, event) => sum + number(event.amount), 0), 50_000)
}

// Cheaper replacement boundary: returned merchandise N=1,000,000, replacement R=900,000,
// so Δ_policy=−100,000 and YES_ZERO must transfer zero. Full YES still exceeds NO refund and is guarded.
const guardedSource = makeVariant('guarded-source', 1_200_000)
const guardedReplacement = makeVariant('guarded-replacement', 900_000)
const guardedSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: guardedSource, qty: 1, unitPrice: 1_200_000, discount: 100_000, tax: 0 }],
  invoiceDiscount: 100_000,
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }]
})
const guardedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', guardedSale.id)
const guardedLines = [{ saleItemId: number(guardedItem.id), qty: 1 }]
const guardedReplacements = [{ variantId: guardedReplacement, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
const guardedPreview = await salesService.previewExchangeFunding({
  invoiceId: number(guardedSale.id), lines: guardedLines, replacements: guardedReplacements
})
assert.equal(guardedPreview.ok, true, guardedPreview.error)
assert.equal(guardedPreview.discountTransfer.selectedOption, null,
  'a read-only preview never records a seller choice when no option was submitted')
assert.equal(number(guardedPreview.discountTransfer.policyDelta), -100_000)
assert.equal(guardedPreview.discountTransfer.options.find((option) => option.option === 'YES').enabled, false)
assert.equal(number(guardedPreview.discountTransfer.options.find((option) => option.option === 'YES_ZERO').transferAmount), 0)
assert.equal(guardedPreview.discountTransfer.options.find((option) => option.option === 'NO').recommended, true)
assert.equal(guardedPreview.discountTransfer.options.find((option) => option.option === 'YES_ZERO').recommended, true)
assert.equal(guardedPreview.discountTransfer.options.find((option) => option.option === 'YES').recommended, false)
const beforeRejectedYes = {
  returns: seed.count('SaleReturn'), invoices: seed.count('SaleInvoice'), payments: seed.count('Payment'),
  sourceStock: stock(guardedSource), replacementStock: stock(guardedReplacement)
}
await assert.rejects(() => salesService.createExchange({
  userId, shiftId, invoiceId: number(guardedSale.id), lines: guardedLines, replacements: guardedReplacements,
  discountTransferOption: 'YES', expectedDiscountTransferAmount: 200_000,
  expectedSettlementDiff: -300_000, refundMode: 'CASH', exchangeSettlementDecision: 'METHOD'
}), /بازپرداخت نهایی|گزینهٔ انتقال|گزینهٔ «خیر»/)
assert.deepEqual({
  returns: seed.count('SaleReturn'), invoices: seed.count('SaleInvoice'), payments: seed.count('Payment'),
  sourceStock: stock(guardedSource), replacementStock: stock(guardedReplacement)
}, beforeRejectedYes, 'disabled YES preview/commit rejection is mutation-free')
const guardedExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: number(guardedSale.id), lines: guardedLines, replacements: guardedReplacements,
  discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 0,
  expectedSettlementDiff: -100_000, refundMode: 'CASH', exchangeSettlementDecision: 'METHOD'
})
assert.equal(number(guardedExchange.discountTransferAmount), 0)
assert.equal(number(guardedExchange.exchangeTotal), 900_000)
assert.equal(number(guardedExchange.cashRefunded), 100_000)
assert.equal(number(guardedExchange.finalRefundValue), 100_000)

// Turning off only the extra-refund guard leaves source provenance, capacity and
// single-consumption ledger constraints intact, while permitting full YES.
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
const unguardedSource = makeVariant('unguarded-source', 1_200_000)
const unguardedReplacement = makeVariant('unguarded-replacement', 900_000)
const unguardedSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: unguardedSource, qty: 1, unitPrice: 1_200_000, discount: 100_000, tax: 0 }],
  invoiceDiscount: 100_000,
  payments: [{ methodId: cashMethodId, amount: 1_000_000, destination: 'CASH' }]
})
const unguardedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', unguardedSale.id)
const unguardedLines = [{ saleItemId: number(unguardedItem.id), qty: 1 }]
const unguardedReplacements = [{ variantId: unguardedReplacement, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
const unguardedPreview = await salesService.previewExchangeFunding({
  invoiceId: number(unguardedSale.id), lines: unguardedLines, replacements: unguardedReplacements
})
assert.equal(unguardedPreview.discountTransfer.preventExtraRefund, false)
assert.equal(unguardedPreview.discountTransfer.options.find((option) => option.option === 'YES').enabled, true)
const unguardedExchange = await salesService.createExchange({
  userId, shiftId, invoiceId: number(unguardedSale.id), lines: unguardedLines, replacements: unguardedReplacements,
  discountTransferOption: 'YES', expectedDiscountTransferAmount: 200_000,
  expectedSettlementDiff: -300_000, refundMode: 'CASH', exchangeSettlementDecision: 'METHOD'
})
assert.equal(number(unguardedExchange.discountTransferAmount), 200_000)
assert.equal(number(unguardedExchange.exchangeTotal), 700_000)
assert.equal(number(unguardedExchange.cashRefunded), 300_000)
const unguardedEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? ORDER BY id', unguardedExchange.returnId)
assert.equal(unguardedEvents.filter((event) => event.eventType === 'TRANSFER').reduce((sum, event) => sum + number(event.amount), 0), 200_000)
assert.equal(unguardedEvents.filter((event) => event.eventType === 'EXPIRE').length, 0)
assert.equal(number(seed.one('SELECT discountTransferAmount FROM "SaleReturn" WHERE id=?', unguardedExchange.returnId).discountTransferAmount), 200_000)

await db.$disconnect?.()
console.log(`PASS: ${scenarios.length} committed option cases; R−N boundaries, partial-quantity returns, tax/service-excluded policy basis, CASH/CARD/STORE_CREDIT/MIXED tenders, YES guard, YES_ZERO, replay/conflict, discount ledger, stock, mutation-free rejection and exchange void verified on isolated SQLite: ${process.env.HARNESS_DB}`)
