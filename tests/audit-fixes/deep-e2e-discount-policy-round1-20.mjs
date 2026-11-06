import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// All scenarios run against a fresh temporary SQLite database. No production,
// staging, real payment, or non-isolated data is used.
const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round1-20-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (value) => Number(value ?? 0)
const userId = seed.user('discount-policy-round1 isolated cashier')
const shiftId = seed.insert('Shift', {
  name: 'discount policy round 1 isolated', number: 68120,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashId = seed.insert('PaymentMethod', {
  key: 'DP20-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardId = seed.insert('PaymentMethod', {
  key: 'DP20-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2
})
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let sku = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20-${++sku}-${label}`, seed.category(`DP20-CAT-${sku}`))
  const id = seed.variant(product, `DP20-${sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) {
  return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock)
}
function mutationSnapshot(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    transferEvents: seed.count('DiscountTransferEvent'), stocks: ids.map((id) => stockOf(id))
  }
}
const results = []
async function run(id, name, fn) {
  try {
    const details = await fn()
    results.push({ id, name, verdict: 'PASS', details: details ?? null })
    console.log(`PASS ${String(id).padStart(2, '0')}/20 — ${name}`)
  } catch (error) {
    results.push({ id, name, verdict: 'FAIL', details: String(error?.stack ?? error) })
    console.error(`FAIL ${String(id).padStart(2, '0')}/20 — ${name}\n${String(error?.stack ?? error)}`)
  }
}

async function makeFunding(total, mode, suffix) {
  if (mode === 'CASH') return { payments: [{ methodId: cashId, amount: total, destination: 'CASH' }] }
  if (mode === 'CARD') return { payments: [{ methodId: cardId, amount: total, destination: 'CARD' }] }
  if (mode === 'MIXED') {
    const cash = Math.floor(total / 2)
    return { payments: [
      { methodId: cashId, amount: cash, destination: 'CASH' },
      { methodId: cardId, amount: total - cash, destination: 'CARD' }
    ] }
  }
  if (mode === 'CREDIT') {
    const issued = await storeCreditService.issueManual({
      amount: total, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `DP20 ${suffix} full credit tender`
    })
    const credit = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', issued.id)
    return { payments: [], storeCredits: [{ code: credit.code, requestedAmount: total }] }
  }
  if (mode === 'CREDIT_MIXED') {
    const creditAmount = Math.floor(total / 2)
    const issued = await storeCreditService.issueManual({
      amount: creditAmount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `DP20 ${suffix} mixed credit tender`
    })
    const credit = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', issued.id)
    const remainder = total - creditAmount
    const cash = Math.floor(remainder / 2)
    return {
      storeCredits: [{ code: credit.code, requestedAmount: creditAmount }],
      payments: [
        { methodId: cashId, amount: cash, destination: 'CASH' },
        { methodId: cardId, amount: remainder - cash, destination: 'CARD' }
      ]
    }
  }
  throw new Error(`Unknown tender mode ${mode}`)
}

async function makeSingleSale({ suffix, gross, qty = 1, lineDiscount = 0, invoiceDiscount = 0, tender = 'CASH' }) {
  const sourceVariantId = variant(`${suffix}-source`, gross)
  const merchandiseNet = gross * qty - lineDiscount - invoiceDiscount
  const funding = await makeFunding(merchandiseNet, tender, suffix)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: sourceVariantId, qty, unitPrice: gross, discount: lineDiscount, tax: 0 }],
    invoiceDiscount,
    ...funding
  })
  const item = seed.one('SELECT id,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  return { sale, sourceVariantId, item, merchandiseNet }
}

async function runSingleExchange({
  idempotencySuffix, gross = 1_000_000, sourceQty = 1, returnQty = 1,
  sourceLineDiscount = 100_000, sourceInvoiceDiscount = 100_000,
  replacementGross, replacementLineDiscount = 0, replacementInvoiceDiscount = 0,
  option, tender = 'CASH', expectedHistoricalDiscount, expectedMerchandiseN,
  expectedTransfer, protectExtraRefund = true, expectYesEnabled,
  commit = true, expectDelta, replay = false
}) {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: protectExtraRefund })
  const source = await makeSingleSale({
    suffix: `s${idempotencySuffix}`, gross, qty: sourceQty,
    lineDiscount: sourceLineDiscount, invoiceDiscount: sourceInvoiceDiscount, tender
  })
  const replacementVariantId = variant(`s${idempotencySuffix}-replacement`, replacementGross)
  const lines = [{ saleItemId: n(source.item.id), qty: returnQty }]
  const replacements = [{
    variantId: replacementVariantId, qty: 1, unitPrice: replacementGross,
    discount: replacementLineDiscount, tax: 0
  }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: n(source.sale.id), lines, replacements,
    invoiceDiscount: replacementInvoiceDiscount, discountTransferOption: option
  })
  assert.equal(preview.ok, true, preview.error)
  const N = expectedMerchandiseN ?? Math.round((gross * sourceQty - sourceLineDiscount - sourceInvoiceDiscount) * returnQty / sourceQty)
  const d = expectedHistoricalDiscount ?? Math.round((sourceLineDiscount + sourceInvoiceDiscount) * returnQty / sourceQty)
  const R = replacementGross - replacementLineDiscount - replacementInvoiceDiscount
  const capacity = R
  const delta = R - N
  const expected = option === 'NO' ? 0
    : option === 'YES' ? Math.min(d, capacity)
      : delta > 0 ? Math.min(d, capacity, delta) : 0
  assert.equal(n(preview.discountTransfer?.historicalDiscount), d, 'proven historical source discount')
  assert.equal(n(preview.discountTransfer?.capacity), capacity, 'replacement merchandise discount capacity')
  assert.equal(n(preview.discountTransfer?.policyDelta), expectDelta ?? delta, 'merchandise-only Δ = R − N')
  assert.equal(n(preview.discountTransfer?.selectedAmount), expected, 'selected transfer matches policy')
  assert.equal(expected, expectedTransfer, 'scenario expected transfer')
  assert.equal(n(preview.returnTotal), N, 'actual return value in no-tax/no-service fixture')
  const fullYes = preview.discountTransfer.options.find((row) => row.option === 'YES')
  if (expectYesEnabled != null) assert.equal(fullYes.enabled, expectYesEnabled, 'YES extra-refund guard state')

  const expectedDifference = Number(preview.effectiveDiff)
  assert.equal(expectedDifference, R - expected - N, 'total difference is replacement net after transfer minus the returned merchandise net')
  if (!commit) return { N, R, d, delta, t: expected, effectiveDiff: expectedDifference, yesEnabled: fullYes.enabled }

  const input = {
    userId, shiftId, invoiceId: n(source.sale.id), lines, replacements,
    invoiceDiscount: replacementInvoiceDiscount,
    discountTransferOption: option,
    expectedDiscountTransferAmount: expected,
    expectedSettlementDiff: expectedDifference,
    requestIdempotencyKey: `dp20-ex-${idempotencySuffix}-0001`
  }
  if (expectedDifference > 0) input.methodId = cashId
  if (expectedDifference < 0) {
    input.refundMode = 'CASH'
    input.exchangeSettlementDecision = 'METHOD'
  }
  const beforeSourceStock = stockOf(source.sourceVariantId)
  const beforeReplacementStock = stockOf(replacementVariantId)
  const committed = await salesService.createExchange(input)
  assert.equal(n(committed.returnTotal), N, 'committed return equals preview')
  assert.equal(n(committed.exchangeTotal), R - expected, 'committed replacement total reflects transfer')
  assert.equal(n(committed.diff), expectedDifference, 'commit diff equals option-specific preview')
  assert.equal(n(committed.discountTransferAmount), expected, 'committed historical transfer')
  assert.equal(committed.discountTransferOption, d > 0 ? option : null)
  assert.equal(stockOf(source.sourceVariantId), beforeSourceStock + returnQty, 'returned source stock restored')
  assert.equal(stockOf(replacementVariantId), beforeReplacementStock - 1, 'replacement stock consumed')
  const child = seed.one('SELECT id,grandTotal,discountTotal,paidTotal FROM "SaleInvoice" WHERE id=?', committed.exchangeInvoiceId)
  assert.equal(n(child.grandTotal), R - expected, 'child invoice total')
  assert.equal(n(child.paidTotal), R - expected, 'child settlement total')
  const events = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', committed.returnId)
  assert.equal(events.filter((row) => row.eventType === 'TRANSFER').reduce((sum, row) => sum + n(row.amount), 0), expected)
  assert.equal(events.filter((row) => row.eventType === 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0), d - expected)
  if (replay) {
    const replayed = await salesService.createExchange(input)
    assert.equal(replayed.replayed, true, 'same request replay is idempotent')
    assert.equal(replayed.returnId, committed.returnId)
    assert.equal(replayed.exchangeInvoiceId, committed.exchangeInvoiceId)
  }
  return { N, R, d, delta, t: expected, effectiveDiff: expectedDifference, committed: true, tender }
}

// 01 — NO: ordinary positive difference remains visible and no historical discount moves.
await run(1, 'NO baseline; collect only the ordinary price difference', () => runSingleExchange({
  idempotencySuffix: '01', replacementGross: 950_000, option: 'NO', expectedTransfer: 0,
  expectedHistoricalDiscount: 200_000, expectedMerchandiseN: 800_000, expectDelta: 150_000
}))

// 02 — YES: full transfer succeeds when it does not create additional refund.
await run(2, 'YES full transfer with guard active; no extra refund', () => runSingleExchange({
  idempotencySuffix: '02', replacementGross: 1_000_000, option: 'YES', expectedTransfer: 200_000,
  expectYesEnabled: true, replay: true
}))

// 03 — YES_ZERO reference: N=800k, d=200k, R=950k => t=150k.
await run(3, 'YES_ZERO agreed reference example and commit/replay', () => runSingleExchange({
  idempotencySuffix: '03', replacementGross: 950_000, option: 'YES_ZERO', expectedTransfer: 150_000,
  expectedHistoricalDiscount: 200_000, expectedMerchandiseN: 800_000, replay: true
}))

// 04 — Cheaper replacement: ordinary refund remains, transfer itself is zero.
await run(4, 'YES_ZERO with R<N; ordinary refund is not mistaken for discount refund', async () => {
  const result = await runSingleExchange({
    idempotencySuffix: '04', gross: 1_200_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacementGross: 700_000, option: 'YES_ZERO', expectedTransfer: 0, expectYesEnabled: false
  })
  assert.equal(result.effectiveDiff, -300_000)
  return result
})

// 05 — Equality boundary: no historical transfer at R=N.
await run(5, 'YES_ZERO at R=N; transfer is zero and settlement is zero', () => runSingleExchange({
  idempotencySuffix: '05', replacementGross: 800_000, option: 'YES_ZERO', expectedTransfer: 0
}))

// 06 — One rial above N transfers exactly one rial.
await run(6, 'YES_ZERO at R=N+1; one-rial transfer', () => runSingleExchange({
  idempotencySuffix: '06', replacementGross: 800_001, option: 'YES_ZERO', expectedTransfer: 1
}))

// 07 — At R=N+d the full historical amount is the safe cap.
await run(7, 'YES_ZERO at R=N+d; transfer reaches exactly d', () => runSingleExchange({
  idempotencySuffix: '07', replacementGross: 1_000_000, option: 'YES_ZERO', expectedTransfer: 200_000
}))

// 08 — Above N+d the transfer remains capped at d; safe full-transfer choices tie.
await run(8, 'YES_ZERO at R>N+d; cap at historical d', async () => {
  const result = await runSingleExchange({
    idempotencySuffix: '08', replacementGross: 1_100_000, option: 'YES_ZERO', expectedTransfer: 200_000
  })
  assert.equal(result.effectiveDiff, 100_000)
  return result
})

// 09 — Replacement's current line discount affects R and capacity before historical transfer.
await run(9, 'Current replacement line discount is included before transfer', () => runSingleExchange({
  idempotencySuffix: '09', replacementGross: 1_100_000, replacementLineDiscount: 100_000,
  option: 'YES_ZERO', expectedTransfer: 200_000
}))

// 10 — Replacement invoice-level discount likewise reduces R/capacity.
await run(10, 'Current replacement invoice discount is included before transfer', () => runSingleExchange({
  idempotencySuffix: '10', replacementGross: 1_100_000, replacementInvoiceDiscount: 100_000,
  option: 'YES_ZERO', expectedTransfer: 200_000
}))

// 11 — Historical invoice-level source discount remains traceable and transferable.
await run(11, 'Source discount is entirely invoice-level', () => runSingleExchange({
  idempotencySuffix: '11', sourceLineDiscount: 0, sourceInvoiceDiscount: 200_000,
  replacementGross: 950_000, option: 'YES_ZERO', expectedHistoricalDiscount: 200_000,
  expectedMerchandiseN: 800_000, expectedTransfer: 150_000
}))

// 12 — A partial-quantity return prorates both merchandise N and historical d.
await run(12, 'Partial return of one of two discounted units', () => runSingleExchange({
  idempotencySuffix: '12', gross: 1_000_000, sourceQty: 2, returnQty: 1,
  sourceLineDiscount: 200_000, sourceInvoiceDiscount: 0,
  replacementGross: 950_000, option: 'YES_ZERO', expectedHistoricalDiscount: 100_000,
  expectedMerchandiseN: 900_000, expectedTransfer: 50_000
}))

// 13 — Invoice discount allocated over two source items; return one item only.
await run(13, 'Multi-item source invoice; proportional invoice-discount share on one returned item', async () => {
  const A = variant('13-source-A', 1_000_000)
  const B = variant('13-source-B', 1_000_000)
  const replacement = variant('13-replacement', 950_000)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [A, B].map((variantId) => ({ variantId, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 })),
    invoiceDiscount: 200_000,
    payments: [{ methodId: cashId, amount: 1_800_000, destination: 'CASH' }]
  })
  const itemA = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', sale.id, A)
  const preview = await salesService.previewExchangeFunding({
    invoiceId: n(sale.id), lines: [{ saleItemId: n(itemA.id), qty: 1 }],
    replacements: [{ variantId: replacement, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }],
    discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(n(preview.returnTotal), 900_000)
  assert.equal(n(preview.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(preview.discountTransfer.policyDelta), 50_000)
  assert.equal(n(preview.discountTransfer.selectedAmount), 50_000)
  const exchange = await salesService.createExchange({
    userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(itemA.id), qty: 1 }],
    replacements: [{ variantId: replacement, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }],
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 50_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20-ex-13-0001'
  })
  assert.equal(n(exchange.discountTransferAmount), 50_000)
  assert.equal(n(exchange.returnTotal), 900_000)
  return { sourceInvoiceDiscount: 200_000, returnedItemShare: 100_000, N: 900_000, R: 950_000, t: 50_000 }
})

// 14 — Capacity smaller than d: source discount exceeds net goods value.
await run(14, 'YES_ZERO capped by c when c<d', async () => {
  seed.setting(SETTING_KEYS.discountPolicy, {
    mode: 'FREE', fixedMode: 'PERCENT', fixedValue: 0, allowLine: true, allowInvoice: true,
    maxPercent: 100, maxAmount: 0, wholesaleMaxPercent: 100, wholesaleMaxAmount: 0
  })
  const sourceVariantId = variant('14-fully-discounted-source', 200_000)
  const replacementVariantId = variant('14-cap-replacement', 100_000)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: sourceVariantId, qty: 1, unitPrice: 200_000, discount: 200_000, tax: 0 }],
    payments: []
  })
  const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  const lines = [{ saleItemId: n(item.id), qty: 1 }]
  const replacements = [{ variantId: replacementVariantId, qty: 1, unitPrice: 100_000, discount: 0, tax: 0 }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: n(sale.id), lines, replacements, discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(n(preview.returnTotal), 0)
  assert.equal(n(preview.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(preview.discountTransfer.capacity), 100_000)
  assert.equal(n(preview.discountTransfer.policyDelta), 100_000)
  assert.equal(n(preview.discountTransfer.selectedAmount), 100_000)
  const exchange = await salesService.createExchange({
    userId, shiftId, invoiceId: n(sale.id), lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 100_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20-ex-14-0001'
  })
  assert.equal(n(exchange.discountTransferAmount), 100_000)
  assert.equal(n(exchange.exchangeTotal), 0)
  return { N: 0, d: 200_000, R: 100_000, c: 100_000, t: 100_000 }
})

// 15 — With protection active, full YES that increases refund is rejected without mutation.
await run(15, 'Guard active: YES disabled and commit rejection is mutation-free', async () => {
  const source = await makeSingleSale({
    suffix: 's15', gross: 1_200_000, qty: 1, lineDiscount: 100_000, invoiceDiscount: 100_000, tender: 'CASH'
  })
  const replacement = variant('15-cheaper', 900_000)
  const lines = [{ saleItemId: n(source.item.id), qty: 1 }]
  const replacements = [{ variantId: replacement, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: n(source.sale.id), lines, replacements, discountTransferOption: 'YES'
  })
  assert.equal(preview.ok, true, preview.error)
  const yes = preview.discountTransfer.options.find((row) => row.option === 'YES')
  assert.equal(yes.enabled, false)
  assert.ok(yes.disabledReason)
  assert.equal(n(preview.discountTransfer.policyDelta), -100_000)
  assert.equal(n(preview.discountTransfer.options.find((row) => row.option === 'YES_ZERO').transferAmount), 0)
  const before = mutationSnapshot([source.sourceVariantId, replacement])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: n(source.sale.id), lines, replacements,
    discountTransferOption: 'YES', requestIdempotencyKey: 'dp20-ex-15-0001'
  }), /بازپرداخت نهایی|گزینهٔ انتقال|گزینهٔ «خیر»/)
  assert.deepEqual(mutationSnapshot([source.sourceVariantId, replacement]), before)
  return { guard: 'on', YES: 'disabled', YES_ZERO: 0, rejection: 'mutation-free' }
})

// 16 — Manager disables only the extra-refund guard; full YES remains allowed and auditable.
await run(16, 'Guard off: full YES is allowed with its real refund and provenance', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const result = await runSingleExchange({
    idempotencySuffix: '16', gross: 1_200_000, sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000,
    replacementGross: 900_000, option: 'YES', expectedTransfer: 200_000,
    protectExtraRefund: false, expectYesEnabled: true
  })
  assert.equal(result.effectiveDiff, -300_000)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { guard: 'off', fullTransfer: 200_000, totalDifference: result.effectiveDiff }
})

// 17 — Actual return settlement includes tax/service, but the policy basis N/R excludes them symmetrically.
await run(17, 'Tax/service do not contaminate merchandise-only Δ; actual settlement remains intact', async () => {
  const source = await makeSingleSale({
    suffix: 's17', gross: 1_000_000, qty: 1, lineDiscount: 100_000, invoiceDiscount: 100_000, tender: 'CASH'
  })
  sql.prepare('UPDATE "SaleInvoiceItem" SET tax=100000,lineTotal=1000000 WHERE id=?').run(source.item.id)
  sql.prepare('UPDATE "SaleInvoice" SET taxTotal=100000,serviceCharge=30000,grandTotal=930000,paidTotal=930000 WHERE id=?').run(source.sale.id)
  sql.prepare('UPDATE "Payment" SET amount=930000 WHERE invoiceId=? AND voidedAt IS NULL').run(source.sale.id)
  const replacement = variant('17-replacement', 950_000)
  const lines = [{ saleItemId: n(source.item.id), qty: 1 }]
  const replacements = [{ variantId: replacement, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: n(source.sale.id), lines, replacements, discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(n(preview.returnTotal), 930_000, 'tax/service stay in actual return settlement')
  assert.equal(n(preview.discountTransfer.policyDelta), 150_000, 'N=800k and R=950k are merchandise only')
  assert.equal(n(preview.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(preview.effectiveDiff), -130_000, 'actual settlement difference still reflects source taxes/service')
  const exchange = await salesService.createExchange({
    userId, shiftId, invoiceId: n(source.sale.id), lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: -130_000, refundMode: 'CASH', exchangeSettlementDecision: 'METHOD',
    requestIdempotencyKey: 'dp20-ex-17-0001'
  })
  assert.equal(n(exchange.discountTransferAmount), 150_000)
  assert.equal(n(exchange.cashRefunded), 130_000)
  return { returnSettlement: 930_000, merchandiseN: 800_000, replacementR: 950_000, t: 150_000, actualDifference: -130_000 }
})

// 18 — Card-only source funding gives the same discount decision.
await run(18, 'Card tender: YES_ZERO formula and commit match cash baseline', () => runSingleExchange({
  idempotencySuffix: '18', replacementGross: 950_000, option: 'YES_ZERO', expectedTransfer: 150_000, tender: 'CARD'
}))

// 19 — Credit barcode plus cash/card: mixed funding does not reverse the sign or transfer.
await run(19, 'Mixed barcode-credit/cash/card tender: same merchandise policy and committed transfer', () => runSingleExchange({
  idempotencySuffix: '19', replacementGross: 950_000, option: 'YES_ZERO', expectedTransfer: 150_000, tender: 'CREDIT_MIXED'
}))

// 20 — Customer visits repeatedly: first transfer is consumed once; later exchanges cannot re-transfer it.
await run(20, 'Three-step exchange chain does not transfer the same historical discount twice', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const root = await makeSingleSale({
    suffix: 's20-root', gross: 1_000_000, qty: 1, lineDiscount: 100_000, invoiceDiscount: 100_000, tender: 'CASH'
  })
  const replacement1 = variant('20-replacement-1', 950_000)
  const rootLines = [{ saleItemId: n(root.item.id), qty: 1 }]
  const replacements1 = [{ variantId: replacement1, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const preview1 = await salesService.previewExchangeFunding({
    invoiceId: n(root.sale.id), lines: rootLines, replacements: replacements1, discountTransferOption: 'YES_ZERO'
  })
  assert.equal(preview1.ok, true, preview1.error)
  assert.equal(n(preview1.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(preview1.discountTransfer.selectedAmount), 150_000)
  const first = await salesService.createExchange({
    userId, shiftId, invoiceId: n(root.sale.id), lines: rootLines, replacements: replacements1,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20-ex-20-0001'
  })
  assert.equal(n(first.exchangeTotal), 800_000)
  const child1 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)

  const replacement2 = variant('20-replacement-2', 900_000)
  const child1Lines = [{ saleItemId: n(child1.id), qty: 1 }]
  const replacements2 = [{ variantId: replacement2, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
  const preview2 = await salesService.previewExchangeFunding({
    invoiceId: Number(first.exchangeInvoiceId), lines: child1Lines, replacements: replacements2
  })
  assert.equal(preview2.ok, true, preview2.error)
  assert.equal(preview2.discountTransfer, undefined, 'already-transferred discount is not available again')
  assert.equal(n(preview2.returnTotal), 800_000)
  assert.equal(n(preview2.effectiveDiff), 100_000)
  const second = await salesService.createExchange({
    userId, shiftId, invoiceId: Number(first.exchangeInvoiceId), lines: child1Lines, replacements: replacements2,
    methodId: cashId, expectedSettlementDiff: 100_000, requestIdempotencyKey: 'dp20-ex-20-0002'
  })
  assert.equal(n(second.discountTransferAmount), 0)
  assert.equal(n(second.exchangeTotal), 900_000)
  const child2 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', second.exchangeInvoiceId)

  const replacement3 = variant('20-replacement-3', 1_000_000)
  const child2Lines = [{ saleItemId: n(child2.id), qty: 1 }]
  const replacements3 = [{ variantId: replacement3, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }]
  const preview3 = await salesService.previewExchangeFunding({
    invoiceId: Number(second.exchangeInvoiceId), lines: child2Lines, replacements: replacements3
  })
  assert.equal(preview3.ok, true, preview3.error)
  assert.equal(preview3.discountTransfer, undefined)
  assert.equal(n(preview3.returnTotal), 900_000)
  assert.equal(n(preview3.effectiveDiff), 100_000)
  const third = await salesService.createExchange({
    userId, shiftId, invoiceId: Number(second.exchangeInvoiceId), lines: child2Lines, replacements: replacements3,
    methodId: cashId, expectedSettlementDiff: 100_000, requestIdempotencyKey: 'dp20-ex-20-0003'
  })
  assert.equal(n(third.discountTransferAmount), 0)
  assert.equal(n(third.exchangeTotal), 1_000_000)
  const rootEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', first.returnId)
  assert.equal(rootEvents.filter((row) => row.eventType === 'TRANSFER').reduce((sum, row) => sum + n(row.amount), 0), 150_000)
  assert.equal(rootEvents.filter((row) => row.eventType === 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0), 50_000)
  return { chain: ['N=800k,d=200k,R=950k,t=150k', 'returned child at 800k; no historical discount re-transfer', 'returned next child at 900k; no historical discount re-transfer'], exchanges: 3 }
})

await db.$disconnect?.()
const failed = results.filter((result) => result.verdict !== 'PASS')
console.log(`\nROUND 1 SUMMARY: ${results.filter((result) => result.verdict === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
