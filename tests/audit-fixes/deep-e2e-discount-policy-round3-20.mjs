import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round3-20-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (value) => Number(value ?? 0)
const userId = seed.user('discount-policy-round3 cashier')
const shiftId = seed.insert('Shift', {
  name: 'discount policy round 3', number: 68320,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashId = seed.insert('PaymentMethod', {
  key: 'DP20-R3-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardId = seed.insert('PaymentMethod', {
  key: 'DP20-R3-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2
})
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let sequence = 0
function makeVariant(label, price, stock = 100) {
  const product = seed.product(`DP20R3-${++sequence}-${label}`, seed.category(`DP20R3-cat-${sequence}`))
  const id = seed.variant(product, `DP20R3-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function snapshot(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    storeCredits: seed.count('StoreCredit'), transferEvents: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), stocks: ids.map(stockOf)
  }
}
async function createSale({ label, lines, invoiceDiscount = 0, tender = 'CASH' }) {
  const gross = lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0)
  const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0)
  const total = gross - lineDiscount - invoiceDiscount
  let payments = []
  if (tender === 'CASH') payments = [{ methodId: cashId, amount: total, destination: 'CASH' }]
  else if (tender === 'CARD') payments = [{ methodId: cardId, amount: total, destination: 'CARD' }]
  else if (tender === 'MIXED') {
    const cash = Math.floor(total / 2)
    payments = [
      { methodId: cashId, amount: cash, destination: 'CASH' },
      { methodId: cardId, amount: total - cash, destination: 'CARD' }
    ]
  } else if (tender !== 'NONE') throw new Error(`unknown tender ${tender}`)
  const created = await salesService.create({
    userId, shiftId,
    lines: lines.map((line) => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments
  })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { invoiceId: n(created.id), items, created, gross, lineDiscount, total }
}
async function preview(invoiceId, lines, replacements, option, invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({
    invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option
  })
  assert.equal(p.ok, true, p.error)
  return p
}
async function commit({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0,
  refundMode = 'CASH', refundAmount, key, expectedDiff = p.effectiveDiff, expectedTransfer = p.discountTransfer?.selectedAmount ?? 0,
  omitExpectedDiff = false }) {
  const input = {
    userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    discountTransferOption: p.discountTransfer ? option : undefined,
    expectedDiscountTransferAmount: expectedTransfer,
    requestIdempotencyKey: key ?? `dp20r3-${label}-0001`
  }
  if (!omitExpectedDiff) input.expectedSettlementDiff = expectedDiff
  if (n(expectedDiff) > 0) input.methodId = cashId
  if (n(expectedDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
  }
  return salesService.createExchange(input)
}
const outcomes = []
async function run(id, title, fn) {
  try {
    const detail = await fn()
    outcomes.push({ id, title, status: 'PASS', detail: detail ?? null })
    console.log(`PASS ${String(id).padStart(2, '0')}/20 — ${title}`)
  } catch (error) {
    outcomes.push({ id, title, status: 'FAIL', detail: String(error?.stack ?? error) })
    console.error(`FAIL ${String(id).padStart(2, '0')}/20 — ${title}\n${String(error?.stack ?? error)}`)
  }
}

// 01. Exact zero merchandise delta: YES_ZERO must be zero even with historical discount.
await run(1, 'مرز Δ=۰؛ YES_ZERO انتقالی ایجاد نمی‌کند', async () => {
  const a = makeVariant('01-source', 1_000_000)
  const s = await createSale({ label: '01', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('01-replacement', 800_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 800_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 0)
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  assert.equal(n(p.effectiveDiff), 0)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '01' })
  assert.equal(n(result.discountTransferAmount), 0)
  return { delta: 0, transfer: 0, diff: 0 }
})

// 02. Negative merchandise delta: YES_ZERO is still zero; selected store credit settles the actual refund.
await run(2, 'Δ منفی؛ YES_ZERO صفر می‌ماند و بازپرداخت با اعتبار انتخابی انجام می‌شود', async () => {
  const a = makeVariant('02-source', 1_000_000)
  const s = await createSale({ label: '02', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('02-replacement', 700_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), -100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  assert.equal(n(p.effectiveDiff), -100_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '02', refundMode: 'STORE_CREDIT' })
  assert.equal(n(result.newStoreCreditAmount), 100_000)
  return { delta: -100_000, transfer: 0, refundCredit: n(result.newStoreCreditAmount) }
})

// 03. YES with the guard disabled transfers full historic discount even when delta is negative.
await run(3, 'YES با محافظ خاموش؛ انتقال کاملِ مجاز با مابه‌التفاوت منفی', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = makeVariant('03-source', 1_000_000)
  const s = await createSale({ label: '03', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('03-replacement', 700_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find((x) => x.option === 'YES').enabled, true)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.exchangeTotal), 500_000)
  assert.equal(n(p.effectiveDiff), -300_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES', p, label: '03', refundMode: 'STORE_CREDIT' })
  assert.equal(n(result.discountTransferAmount), 200_000)
  assert.equal(n(result.newStoreCreditAmount), 300_000)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { fullTransfer: 200_000, actualRefund: 300_000 }
})

// 04. Capacity below historic discount: YES is clipped to replacement merchandise capacity.
await run(4, 'سقف جایگزین کمتر از تخفیف تاریخی؛ YES به ظرفیت محدود می‌شود', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = makeVariant('04-source', 1_000_000)
  const s = await createSale({ label: '04', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('04-replacement', 100_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 100_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p.discountTransfer.capacity), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 100_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES', p, label: '04', refundMode: 'STORE_CREDIT' })
  assert.equal(n(result.discountTransferAmount), 100_000)
  assert.equal(n(result.exchangeTotal), 0)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { historic: 200_000, capacity: 100_000, transfer: 100_000 }
})

// 05. A single source discount is distributed over replacement rows with disparate net values.
await run(5, 'دو ردیف جایگزین با ارزش‌های متفاوت؛ جمع سهم‌ها دقیقاً برابر انتقال است', async () => {
  const a = makeVariant('05-source', 1_000_000)
  const s = await createSale({ label: '05', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('05-a', 400_000), c = makeVariant('05-b', 600_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [
    { variantId: b, qty: 1, unitPrice: 400_000, discount: 0 },
    { variantId: c, qty: 1, unitPrice: 600_000, discount: 0 }
  ]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(p.replacementTransferShares.reduce((sum, amount) => sum + n(amount), 0), 200_000)
  assert.ok(p.replacementTransferShares.every((amount, i) => n(amount) <= replacements[i].unitPrice))
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '05' })
  const child = seed.rows('SELECT lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', result.exchangeInvoiceId)
  assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), 800_000)
  return { shares: p.replacementTransferShares, childTotal: 800_000 }
})

// 06. Replacement invoice-level discount contributes to R before YES_ZERO is derived.
await run(6, 'تخفیف فاکتوریِ جایگزین پیش از محاسبهٔ Δ اعمال می‌شود', async () => {
  const a = makeVariant('06-source', 1_000_000)
  const s = await createSale({ label: '06', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const b = makeVariant('06-replacement', 1_000_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO', 100_000)
  assert.equal(n(p.discountTransfer.capacity), 900_000)
  assert.equal(n(p.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 100_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, invoiceDiscount: 100_000, label: '06' })
  assert.equal(n(result.exchangeTotal), 800_000)
  assert.equal(n(result.diff), 0)
  return { R: 900_000, transfer: 100_000, adjustedTotal: 800_000 }
})

// 07. Quantity-based line discount allocation: one of three units carries one-third of the history.
await run(7, 'تخفیف ردیفی روی سه واحد؛ سهم برگشت یک‌واحدی و انتقال دقیق', async () => {
  const a = makeVariant('07-source', 1_000_000)
  const s = await createSale({ label: '07', lines: [{ variantId: a, qty: 3, unitPrice: 1_000_000, discount: 300_000 }] })
  const b = makeVariant('07-replacement', 1_000_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 900_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 100_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '07' })
  assert.equal(n(result.discountTransferAmount), 100_000)
  return { N: 900_000, historicalShare: 100_000, transfer: 100_000 }
})

// 08. Mixed original tenders do not change the merchandise-only discount decision.
await run(8, 'مبدأ نقد وکارت در فاکتور مبدأ؛ YES_ZERO مستقل از ترکیب tender', async () => {
  const a = makeVariant('08-source', 1_000_000)
  const s = await createSale({ label: '08', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'MIXED' })
  const b = makeVariant('08-replacement', 1_150_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 1_150_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 350_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 150_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '08' })
  assert.equal(n(result.cashReceived), 150_000)
  return { originalTender: 'CASH+CARD', transfer: 200_000, additionalCollection: 150_000 }
})

// 09. Taxes and service are kept in actual settlement but excluded from policy N/R and delta.
await run(9, 'مالیات و حق‌سرویس در تسویه می‌مانند اما وارد Δ کالایی نمی‌شوند', async () => {
  const a = makeVariant('09-source', 1_000_000)
  const s = await createSale({ label: '09', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  sql.prepare('UPDATE "SaleInvoiceItem" SET tax=100000,lineTotal=1000000 WHERE id=?').run(s.items[0].id)
  sql.prepare('UPDATE "SaleInvoice" SET taxTotal=100000,serviceCharge=30000,grandTotal=930000,paidTotal=930000 WHERE id=?').run(s.invoiceId)
  sql.prepare('UPDATE "Payment" SET amount=930000 WHERE invoiceId=? AND voidedAt IS NULL').run(s.invoiceId)
  const b = makeVariant('09-replacement', 950_000)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 930_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), -130_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'YES_ZERO', p, label: '09', refundMode: 'CASH' })
  assert.equal(n(result.cashRefunded), 130_000)
  return { settlementReturn: 930_000, merchandiseDelta: 150_000, transfer: 150_000, refund: 130_000 }
})

// 10. A requested payout above the real-money surplus is rejected with no mutation.
await run(10, 'بازپرداخت درخواستی بیش از مازاد واقعی؛ رد mutation-free', async () => {
  const a = makeVariant('10-source', 1_000_000), b = makeVariant('10-replacement', 700_000)
  const s = await createSale({ label: '10', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'NO')
  const before = snapshot([a, b])
  await assert.rejects(() => commit({ invoiceId: s.invoiceId, lines, replacements, option: 'NO', p, label: '10', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(snapshot([a, b]), before)
  return { actualSurplus: 100_000, requested: 100_001, mutation: false }
})

// 11. Explicitly unselected payout method cannot silently create cash, card, or credit.
await run(11, 'ماندهٔ بازپرداخت بدون انتخاب روش؛ عدم تسویهٔ ضمنی و بدون mutation', async () => {
  const a = makeVariant('11-source', 1_000_000), b = makeVariant('11-replacement', 700_000)
  const s = await createSale({ label: '11', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'NO')
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0,
    expectedSettlementDiff: -100_000, exchangeSettlementDecision: 'UNSELECTED',
    requestIdempotencyKey: 'dp20r3-11-unselected-0001'
  }), /روش را انتخاب نکرده|روش را انتخاب کنید|روش تسویه انتخاب نشده/)
  assert.deepEqual(snapshot([a, b]), before)
  return { diff: n(p.effectiveDiff), explicitMethodRequired: true, mutation: false }
})

// 12. Stale expected settlement is rejected atomically, without changing stock or ledgers.
await run(12, 'مبلغ موردانتظارِ تسویهٔ کهنه؛ ثبت رد و rollback کامل', async () => {
  const a = makeVariant('12-source', 1_000_000), b = makeVariant('12-replacement', 900_000)
  const s = await createSale({ label: '12', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), 100_000)
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0,
    expectedSettlementDiff: 99_999, methodId: cashId,
    requestIdempotencyKey: 'dp20r3-12-stale-diff-0001'
  }))
  assert.deepEqual(snapshot([a, b]), before)
  return { previewDiff: n(p.effectiveDiff), submittedDiff: 99_999, mutation: false }
})

// 13. Incorrect expected discount amount is rejected before any exchange record commits.
await run(13, 'مبلغ انتقال ارسالیِ ناهماهنگ با preview؛ رد بی‌اثر', async () => {
  const a = makeVariant('13-source', 1_000_000), b = makeVariant('13-replacement', 950_000)
  const s = await createSale({ label: '13', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 149_999,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r3-13-stale-transfer-0001'
  }))
  assert.deepEqual(snapshot([a, b]), before)
  return { previewTransfer: 150_000, submitted: 149_999, mutation: false }
})

// 14. Manager flips the extra-refund guard after a full-YES preview; commit must recompute and block.
await run(14, 'تغییر محافظ پس از preview؛ YES تازه‌غیرفعال و ثبت بی‌اثر', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = makeVariant('14-source', 1_000_000), b = makeVariant('14-replacement', 700_000)
  const s = await createSale({ label: '14', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find((x) => x.option === 'YES').enabled, true)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements,
    discountTransferOption: 'YES', expectedDiscountTransferAmount: 200_000,
    expectedSettlementDiff: -300_000, refundMode: 'STORE_CREDIT', exchangeSettlementDecision: 'METHOD',
    requestIdempotencyKey: 'dp20r3-14-guard-flip-0001'
  }))
  assert.deepEqual(snapshot([a, b]), before)
  return { initiallyEnabled: true, afterGuardFlip: 'blocked', mutation: false }
})

// 15. Exact idempotent replay returns the saved exchange without duplicate financial evidence.
await run(15, 'ارسال مجدد همان idempotency key؛ سند و دفتر تکراری ساخته نمی‌شود', async () => {
  const a = makeVariant('15-source', 1_000_000), b = makeVariant('15-replacement', 950_000)
  const s = await createSale({ label: '15', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'YES_ZERO')
  const input = {
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r3-15-replay-0001'
  }
  const first = await salesService.createExchange(input)
  const afterFirst = snapshot([a, b])
  const second = await salesService.createExchange(input)
  assert.equal(second.replayed, true)
  assert.equal(second.returnId, first.returnId)
  assert.deepEqual(snapshot([a, b]), afterFirst)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { replayed: true, singleReturn: true, singleTransfer: 150_000 }
})

// 16. Reusing a completed idempotency key with changed replacements must not create a second exchange.
await run(16, 'همان idempotency key با payload متفاوت؛ تعویض دوم ساخته نمی‌شود', async () => {
  const a = makeVariant('16-source', 1_000_000), b = makeVariant('16-replacement-a', 950_000), c = makeVariant('16-replacement-b', 950_000)
  const s = await createSale({ label: '16', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacementsA = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacementsA, 'YES_ZERO')
  const input = {
    userId, shiftId, invoiceId: s.invoiceId, lines, replacements: replacementsA,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r3-16-conflict-0001'
  }
  const first = await salesService.createExchange(input)
  const before = snapshot([a, b, c])
  await assert.rejects(() => salesService.createExchange({
    ...input, replacements: [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  }))
  assert.deepEqual(snapshot([a, b, c]), before)
  assert.equal(n(first.discountTransferAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  return { firstTransfer: 150_000, alteredReplayRejected: true, secondMutation: false }
})

// 17. Canceled source invoices cannot be previewed for exchange.
await run(17, 'فاکتور لغوشده؛ preview تعویض را رد می‌کند', async () => {
  const a = makeVariant('17-source', 1_000_000), b = makeVariant('17-replacement', 900_000)
  const s = await createSale({ label: '17', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  sql.prepare('UPDATE "SaleInvoice" SET status=? WHERE id=?').run('CANCELED', s.invoiceId)
  const before = snapshot([a, b])
  const p = await salesService.previewExchangeFunding({
    invoiceId: s.invoiceId, lines: [{ saleItemId: n(s.items[0].id), qty: 1 }],
    replacements: [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }], discountTransferOption: 'NO'
  })
  assert.equal(p.ok, false)
  assert.match(p.error, /قابل برگشت|قابل برگشت یا تعویض/)
  assert.deepEqual(snapshot([a, b]), before)
  return { previewRejected: true, mutation: false }
})

// 18. Returning more quantity than sold is rejected in read-only preview.
await run(18, 'تعداد برگشتی بیش از فروش؛ preview رد و داده‌ها دست‌نخورده', async () => {
  const a = makeVariant('18-source', 1_000_000), b = makeVariant('18-replacement', 900_000)
  const s = await createSale({ label: '18', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const before = snapshot([a, b])
  const p = await salesService.previewExchangeFunding({
    invoiceId: s.invoiceId, lines: [{ saleItemId: n(s.items[0].id), qty: 2 }],
    replacements: [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }], discountTransferOption: 'YES_ZERO'
  })
  assert.equal(p.ok, false)
  assert.match(p.error, /باقی‌مانده|بیشتر/)
  assert.deepEqual(snapshot([a, b]), before)
  return { requestedQty: 2, soldQty: 1, rejectedWithoutMutation: true }
})

// 19. No historical discount: options are absent and standard positive settlement still works.
await run(19, 'فاکتور بی‌تخفیف تاریخی؛ مسیر عادی بدون گزینه و بدون انتقال', async () => {
  const a = makeVariant('19-source', 1_000_000), b = makeVariant('19-replacement', 1_050_000)
  const s = await createSale({ label: '19', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 1_050_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'NO')
  assert.equal(p.discountTransfer, undefined)
  assert.equal(n(p.effectiveDiff), 50_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'NO', p, label: '19' })
  assert.equal(n(result.discountTransferAmount), 0)
  assert.equal(n(result.cashReceived), 50_000)
  return { transfer: 0, collected: 50_000 }
})

// 20. Partial real-money payout with the remainder converted to an explicit store-credit successor.
await run(20, 'بازپرداخت جزئی نقدی؛ مانده به اعتبار جدید تفکیک می‌شود', async () => {
  const a = makeVariant('20-source', 1_000_000), b = makeVariant('20-replacement', 700_000)
  const s = await createSale({ label: '20', lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.invoiceId, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const result = await commit({ invoiceId: s.invoiceId, lines, replacements, option: 'NO', p, label: '20', refundMode: 'CASH', refundAmount: 40_000 })
  assert.equal(n(result.cashRefunded), 40_000)
  assert.equal(n(result.newStoreCreditAmount), 60_000)
  const issued = seed.one('SELECT amount FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', result.returnId)
  assert.equal(n(issued.amount), 60_000)
  return { cashRefund: 40_000, storeCreditRemainder: 60_000 }
})

await db.$disconnect?.()
const failed = outcomes.filter((row) => row.status !== 'PASS')
console.log(`\nROUND 3 SUMMARY: ${outcomes.filter((row) => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
