import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round6-20-'))
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
const n = value => Number(value ?? 0)
const userId = seed.user('discount-policy-round6 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 6', number: 68620, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R6-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R6-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let sequence = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R6-${++sequence}-${label}`, seed.category(`DP20R6-cat-${sequence}`))
  const id = seed.variant(product, `DP20R6-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function state(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), redemptions: seed.count('StoreCreditRedemption'),
    events: seed.count('DiscountTransferEvent'), cashMovements: seed.count('CashMovement'),
    cardRequests: seed.count('CardTransferRequest'), stocks: ids.map(stockOf)
  }
}
async function issueCredit(amount, { multiUse = false, maxUses = 1, restrictVariantIds = null, label = 'fixture' } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse, maxUses, carryRemainder: true, days: 30,
    ...(restrictVariantIds ? { restrictScope: 'VARIANTS', restrictVariantIds } : {}),
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `round6 ${label}` })
  return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?', issued.id)
}
async function sale({ lines, invoiceDiscount = 0, tender = 'CASH', credit = null }) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.qty - line.discount, 0) - invoiceDiscount
  let payments = []
  let storeCredits
  if (credit) {
    storeCredits = [{ code: credit.code, requestedAmount: n(credit.amount) }]
    const remainder = total - n(credit.amount)
    if (remainder < 0) throw new Error('credit fixture exceeds invoice total')
    if (tender === 'CASH' && remainder > 0) payments = [{ methodId: cashId, amount: remainder, destination: 'CASH' }]
    else if (tender === 'CARD' && remainder > 0) payments = [{ methodId: cardId, amount: remainder, destination: 'CARD' }]
    else if (tender === 'MIXED' && remainder > 0) {
      const half = Math.floor(remainder / 2)
      payments = [{ methodId: cashId, amount: half, destination: 'CASH' }, { methodId: cardId, amount: remainder - half, destination: 'CARD' }]
    }
  } else if (tender === 'CASH') payments = [{ methodId: cashId, amount: total, destination: 'CASH' }]
  else if (tender === 'CARD') payments = [{ methodId: cardId, amount: total, destination: 'CARD' }]
  else if (tender === 'MIXED') {
    const half = Math.floor(total / 2)
    payments = [{ methodId: cashId, amount: half, destination: 'CASH' }, { methodId: cardId, amount: total - half, destination: 'CARD' }]
  } else throw new Error(`unknown tender ${tender}`)
  const created = await salesService.create({ userId, shiftId, lines: lines.map(line => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments, storeCredits })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { id: n(created.id), items, total, created }
}
async function preview(invoiceId, lines, replacements, option, invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option })
  assert.equal(p.ok, true, p.error)
  return p
}
async function exchange({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0, refundMode = 'CASH', refundAmount, key, cardOverride = true }) {
  const input = { userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    discountTransferOption: p.discountTransfer ? option : undefined,
    expectedDiscountTransferAmount: n(p.discountTransfer?.selectedAmount), expectedSettlementDiff: n(p.effectiveDiff),
    requestIdempotencyKey: key ?? `dp20r6-${label}-0001` }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD' && cardOverride) input.cardPosOverride = {
      acknowledgedNoReverse: true, reason: `round6 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD
    }
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

// 01. Credit-only source funds a replacement after YES_ZERO without cash conversion.
await run(1, 'فروش با اعتبار کامل؛ YES_ZERO اعتبار را به پول نقد تبدیل نمی‌کند', async () => {
  const a = variant('01-source', 1_000_000), b = variant('01-r', 950_000)
  const credit = await issueCredit(800_000, { label: '01 full tender' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '01' })
  assert.equal(n(x.discountTransferAmount), 150_000)
  assert.equal(n(x.cashReceived), 0)
  assert.equal(n(x.cashRefunded), 0)
  return { sourceTender: 'STORE_CREDIT', transfer: 150_000, physicalCash: 0 }
})

// 02. Credit-funded exchange with a positive net difference collects only the residual after transfer.
await run(2, 'اعتبار کامل با جایگزین گران‌تر؛ فقط مابه‌التفاوت پس از انتقال نقدی وصول می‌شود', async () => {
  const a = variant('02-source', 1_000_000), b = variant('02-r', 1_100_000)
  const credit = await issueCredit(800_000, { label: '02 full tender' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '02' })
  assert.equal(n(x.cashReceived), 100_000)
  assert.equal(n(x.discountTransferAmount), 200_000)
  return { sourceCredit: 800_000, transfer: 200_000, additionalCash: 100_000 }
})

// 03. Barcode plus cash/POS funding is settled by the same merchandise policy and source credit is not duplicated.
await run(3, 'اعتبار به‌علاوهٔ وجه ترکیبی؛ انتقال یک‌بار و مازاد تسویهٔ صفر', async () => {
  const a = variant('03-source', 1_000_000), b = variant('03-r', 950_000)
  const credit = await issueCredit(400_000, { label: '03 partial mixed tender' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit, tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '03' })
  assert.equal(n(x.discountTransferAmount), 150_000)
  assert.equal(n(x.cashReceived), 0)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER'), 1)
  return { sourceCredit: 400_000, sourceMoney: 400_000, transfer: 150_000, repeatedCredit: false }
})

// 04. Restricted barcode source is restored rather than silently converted to cash on an out-of-scope exchange.
await run(4, 'اعتبار محدود به SKU مبدأ؛ جایگزین خارج از scope آن را به وجه تبدیل نمی‌کند', async () => {
  const a = variant('04-allowed-source', 1_000_000), b = variant('04-out-of-scope-r', 800_000)
  const credit = await issueCredit(800_000, { restrictVariantIds: [a], label: '04 restricted source' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 800_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(p.ok, true, p.error)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '04', refundMode: 'STORE_CREDIT' })
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.cardRefunded), 0)
  assert.equal(n(x.sourceCreditRestoredAmount), 800_000)
  assert.equal(n(x.newStoreCreditAmount), 0)
  return { restrictedScope: 'VARIANTS', sourceCreditRestored: n(x.sourceCreditRestoredAmount), cashConversion: 0 }
})

// 05. Same-scope replacement can reuse the returned restricted source credit without restoring or duplicating it.
await run(5, 'اعتبار محدود و جایگزین مجاز؛ بازاستفاده در scope بدون صدور اعتبار جانشین', async () => {
  const a = variant('05-allowed-source', 1_000_000)
  const credit = await issueCredit(800_000, { restrictVariantIds: [a], label: '05 restricted source' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '05' })
  assert.equal(n(x.sourceCreditRestoredAmount), 0)
  assert.equal(n(x.discountTransferAmount), 200_000)
  return { sameScopeReuse: true, sourceCreditRestoration: 0, transfer: 200_000 }
})

// 06. Full YES with source credit and negative difference separates credit restoration from real-money payout.
await run(6, 'اعتبار محدود و YES کامل؛ ماندهٔ مازاد در اعتبار می‌ماند', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = variant('06-source', 1_000_000), b = variant('06-r', 700_000)
  const credit = await issueCredit(800_000, { label: '06 full source credit' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 0, 'credit surplus is a source-credit restoration, not a cash refund')
  assert.equal(n(p.sourceCreditRestoration), 300_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '06' })
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.cardRefunded), 0)
  assert.equal(n(x.sourceCreditRestoredAmount), 300_000, 'unused original barcode share returns to its source credit')
  assert.equal(n(x.newStoreCreditAmount), 0, 'credit-only funding must not fabricate a money-backed refund')
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { transfer: 200_000, creditOnlySource: true, restoredOriginalCredit: 300_000, physicalRefund: 0 }
})

// 07. Source credit and real money are separately tracked when the returned value exceeds the replacement.
await run(7, 'ترکیب اعتبار و پول واقعی؛ مازاد پولی جدا از بازگردانی اعتبار حساب می‌شود', async () => {
  const a = variant('07-source', 1_000_000), b = variant('07-r', 700_000)
  const credit = await issueCredit(400_000, { label: '07 partial credit' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit, tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '07', refundMode: 'CASH' })
  assert.equal(n(x.cashRefunded), 0, 'credit-backed surplus is restored as credit, not cash')
  assert.equal(n(x.sourceCreditRestoredAmount), 100_000)
  assert.equal(n(x.newStoreCreditAmount), 0)
  return { cashRefund: 0, sourceCreditRestored: 100_000, noCreditToCashConversion: true }
})

// 08. Transfer only the actual current discount from a chain with an already consumed prior transfer.
await run(8, 'بازگشت نسل دوم؛ انتقال تاریخی قبلی دوباره منبع تخفیف نمی‌شود', async () => {
  const a = variant('08-root', 1_000_000), b = variant('08-child1', 1_000_000), c = variant('08-child2', 900_000)
  const root = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const rootLines = [{ saleItemId: n(root.items[0].id), qty: 1 }], firstReplacement = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 100_000 }]
  const p1 = await preview(root.id, rootLines, firstReplacement, 'YES_ZERO')
  const first = await exchange({ invoiceId: root.id, lines: rootLines, replacements: firstReplacement, option: 'YES_ZERO', p: p1, label: '08a' })
  const child = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
  assert.equal(n(child.discount), 200_000)
  const childLines = [{ saleItemId: n(child.id), qty: 1 }], secondReplacement = [{ variantId: c, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p2 = await preview(first.exchangeInvoiceId, childLines, secondReplacement, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 100_000)
  const second = await exchange({ invoiceId: first.exchangeInvoiceId, lines: childLines, replacements: secondReplacement, option: 'YES_ZERO', p: p2, label: '08b' })
  const child2 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', second.exchangeInvoiceId)
  assert.equal(n(child2.discount), 100_000)
  return { firstTransfer: 100_000, consumedAtGeneration2: 100_000, currentDiscountTransfer: 100_000 }
})

// 09. Original cash/card split must not change the exact NO-versus-YES_ZERO merchandise delta.
await run(9, 'tender ترکیبی؛ Δ و انتقال سیاستی بر مبنای خالص کالا ثابت می‌مانند', async () => {
  const a = variant('09-source', 1_000_000), b = variant('09-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const no = await preview(s.id, lines, replacements, 'NO'), zero = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(no.discountTransfer.policyDelta), 150_000)
  assert.equal(n(zero.discountTransfer.policyDelta), 150_000)
  assert.equal(n(no.discountTransfer.selectedAmount), 0)
  assert.equal(n(zero.discountTransfer.selectedAmount), 150_000)
  return { tender: 'CASH+CARD', deltaBoth: 150_000, transferNO: 0, transferYES_ZERO: 150_000 }
})

// 10. Different transfer choices are read-only projections; no source window is consumed until commit.
await run(10, 'پیش‌نمایش چندگزینه‌ای؛ هیچ پنجره یا دفتر تا زمان commit مصرف نمی‌شود', async () => {
  const a = variant('10-source', 1_000_000), b = variant('10-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const before = state([a, b])
  const all = []
  for (const option of ['NO', 'YES_ZERO', 'YES']) all.push(await preview(s.id, lines, replacements, option))
  assert.deepEqual(state([a, b]), before)
  assert.deepEqual(all.map(p => n(p.discountTransfer.selectedAmount)), [0, 150_000, 200_000])
  return { projections: 3, consumedBeforeCommit: false }
})

// 11. Correct POS refund override produces a card refund and no cash movement.
await run(11, 'اختلاف منفی پس از خرید POS؛ کارت‌به‌کارت نیست و صندوق نقدی تغییر نمی‌کند', async () => {
  const a = variant('11-source', 1_000_000), b = variant('11-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CARD' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const cashBefore = seed.count('CashMovement')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '11', refundMode: 'CARD' })
  assert.equal(n(x.cardRefunded), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('CashMovement'), cashBefore)
  return { cardRefund: 100_000, cashRefund: 0 }
})

// 12. CARD_TO_CARD creates an auditable pending request; it is not recorded as paid.
await run(12, 'کارت‌به‌کارت؛ درخواست pending و عدم ثبت پرداخت قطعی', async () => {
  const a = variant('12-source', 1_000_000), b = variant('12-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '12', refundMode: 'CARD_TO_CARD' })
  const req = seed.one('SELECT amount,status FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(req.amount), 100_000)
  assert.match(String(req.status).toUpperCase(), /PENDING|WAIT/)
  assert.equal(n(x.cashRefunded) + n(x.cardRefunded), 0)
  return { requested: 100_000, status: req.status, physicalRefund: 0 }
})

// 13. A partial cash payout plus non-expiring credit successor exactly accounts for the refund entitlement.
await run(13, 'پرداخت بخشی نقدی و باقی‌مانده با اعتبار؛ جمع تسویه دقیق', async () => {
  const a = variant('13-source', 1_000_000), b = variant('13-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '13', refundMode: 'CASH', refundAmount: 40_000 })
  assert.equal(n(x.cashRefunded), 40_000)
  assert.equal(n(x.newStoreCreditAmount), 60_000)
  const c = seed.one('SELECT amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(c.amount), 60_000)
  assert.equal(c.expiresAt, null)
  return { cash: 40_000, credit: 60_000, expiry: null }
})

// 14. Refund without selecting a method is rejected with no partial return or cash movement.
await run(14, 'ماندهٔ قابل‌پرداخت بدون روش انتخابی؛ rollback و بدون تسویهٔ ضمنی', async () => {
  const a = variant('14-source', 1_000_000), b = variant('14-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO'), before = state([a, b])
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff),
    exchangeSettlementDecision: 'UNSELECTED', requestIdempotencyKey: 'dp20r6-14-no-method-0001' }), /فروشنده روش را انتخاب نکرده/)
  assert.deepEqual(state([a, b]), before)
  return { entitlement: 100_000, selectedMethod: false, mutation: false }
})

// 15. An excessive payout amount is blocked even when the refund method itself is valid.
await run(15, 'مبلغ بازپرداخت بیش از entitlement؛ رد بی‌اثر', async () => {
  const a = variant('15-source', 1_000_000), b = variant('15-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO'), before = state([a, b])
  await assert.rejects(() => exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '15', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(state([a, b]), before)
  return { maxAllowed: 100_000, requested: 100_001, mutation: false }
})

// 16. Reusing an idempotency key with a changed payload cannot duplicate the committed transfer.
await run(16, 'کلید idempotency تکراری با ورودی عوض‌شده؛ تعارض بدون mutation دوم', async () => {
  const a = variant('16-source', 1_000_000), b = variant('16-r1', 950_000), c = variant('16-r2', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements: [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }],
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0,
    requestIdempotencyKey: 'dp20r6-16-conflicting-retry-0001' }
  const x = await salesService.createExchange(input), before = state([a, b, c])
  await assert.rejects(() => salesService.createExchange({ ...input, replacements: [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }] }))
  assert.deepEqual(state([a, b, c]), before)
  assert.equal(n(x.discountTransferAmount), 150_000)
  return { firstTransfer: 150_000, changedReplayRejected: true }
})

// 17. A canceled source invoice is rejected by the read-only preview.
await run(17, 'فاکتور مبدأ لغوشده؛ تعویض در preview قابل‌استفاده نیست', async () => {
  const a = variant('17-source', 1_000_000), b = variant('17-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  sql.prepare('UPDATE "SaleInvoice" SET status=? WHERE id=?').run('CANCELED', s.id)
  const before = state([a, b])
  const p = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: [{ saleItemId: n(s.items[0].id), qty: 1 }],
    replacements: [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }], discountTransferOption: 'YES_ZERO' })
  assert.equal(p.ok, false)
  assert.match(p.error, /قابل برگشت|قابل برگشت یا تعویض/)
  assert.deepEqual(state([a, b]), before)
  return { canceledSourceBlocked: true, mutation: false }
})

// 18. Return quantity cannot exceed sold quantity, even if a replacement was supplied.
await run(18, 'تعداد برگشتی بالاتر از تعداد فروخته‌شده؛ توقف read-only', async () => {
  const a = variant('18-source', 1_000_000), b = variant('18-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const before = state([a, b])
  const p = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: [{ saleItemId: n(s.items[0].id), qty: 2 }],
    replacements: [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }], discountTransferOption: 'YES_ZERO' })
  assert.equal(p.ok, false)
  assert.match(p.error, /باقی‌مانده|بیشتر/)
  assert.deepEqual(state([a, b]), before)
  return { sold: 1, requestedReturn: 2, mutation: false }
})

// 19. No historical discount means no transfer event despite a selected nominal option.
await run(19, 'تخفیف تاریخی صفر؛ گزینهٔ اسمی باعث رویداد انتقال ساختگی نمی‌شود', async () => {
  const a = variant('19-source', 1_000_000), b = variant('19-r', 1_100_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(p.discountTransfer, undefined)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '19' })
  assert.equal(n(x.discountTransferAmount), 0)
  assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=?', x.returnId), 0)
  assert.equal(n(x.cashReceived), 100_000)
  return { historicalDiscount: 0, transferEvents: 0, collected: 100_000 }
})

// 20. A voided transfer cannot be reused; the second exchange has no transfer history.
await run(20, 'پس از void؛ رویداد انتقال باطل است و تعویض بعدی بدون تخفیف تاریخی می‌ماند', async () => {
  const a = variant('20-source', 1_000_000), b = variant('20-first-r', 950_000), c = variant('20-second-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '20a' })
  await salesService.returnDelete({ id: first.returnId, userId, reason: 'round6 isolated void', panelPassword: DEFAULT_MANAGER_PASSWORD })
  const nextLines = [{ saleItemId: n(s.items[0].id), qty: 1 }], nextReplacements = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const next = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: nextLines, replacements: nextReplacements, discountTransferOption: 'YES_ZERO' })
  assert.equal(next.ok, true, next.error)
  assert.equal(next.discountTransfer, undefined)
  const second = await salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: nextLines, replacements: nextReplacements,
    expectedSettlementDiff: n(next.effectiveDiff), requestIdempotencyKey: 'dp20r6-20-after-void-0001' })
  assert.equal(n(second.discountTransferAmount), 0)
  return { firstTransferVoided: 150_000, laterTransfer: 0 }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 6 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
