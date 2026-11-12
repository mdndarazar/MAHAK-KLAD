import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round7-20-'))
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
const userId = seed.user('discount-policy-round7 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 7', number: 68720, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R7-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R7-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let seq = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R7-${++seq}-${label}`, seed.category(`DP20R7-cat-${seq}`))
  const id = seed.variant(product, `DP20R7-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function state(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), redemptions: seed.count('StoreCreditRedemption'),
    transferEvents: seed.count('DiscountTransferEvent'), cashMovements: seed.count('CashMovement'),
    cardRequests: seed.count('CardTransferRequest'), stocks: ids.map(stockOf)
  }
}
async function issueCredit(amount, { restrictVariantIds = null, label = 'fixture' } = {}) {
  const issued = await storeCreditService.issueManual({ amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
    ...(restrictVariantIds ? { restrictScope: 'VARIANTS', restrictVariantIds } : {}),
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: `round7 ${label}` })
  return seed.one('SELECT id,code,amount,usedAmount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?', issued.id)
}
async function sale({ lines, invoiceDiscount = 0, tender = 'CASH', credit = null }) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.qty - line.discount, 0) - invoiceDiscount
  let payments = []
  let storeCredits
  if (credit) {
    storeCredits = [{ code: credit.code, requestedAmount: n(credit.amount) }]
    const remainder = total - n(credit.amount)
    if (remainder < 0) throw new Error('credit fixture exceeds sale net')
    if (tender === 'CASH' && remainder) payments = [{ methodId: cashId, amount: remainder, destination: 'CASH' }]
    else if (tender === 'CARD' && remainder) payments = [{ methodId: cardId, amount: remainder, destination: 'CARD' }]
    else if (tender === 'MIXED' && remainder) {
      const half = Math.floor(remainder / 2)
      payments = [{ methodId: cashId, amount: half, destination: 'CASH' }, { methodId: cardId, amount: remainder - half, destination: 'CARD' }]
    }
  } else if (tender === 'CASH') payments = [{ methodId: cashId, amount: total, destination: 'CASH' }]
  else if (tender === 'CARD') payments = [{ methodId: cardId, amount: total, destination: 'CARD' }]
  else if (tender === 'MIXED') {
    const half = Math.floor(total / 2)
    payments = [{ methodId: cashId, amount: half, destination: 'CASH' }, { methodId: cardId, amount: total - half, destination: 'CARD' }]
  } else throw new Error(`unknown tender ${tender}`)
  const created = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: lines.map(line => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments, storeCredits })
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
    ...(p.discountTransfer ? { discountTransferOption: option } : {}),
    expectedDiscountTransferAmount: n(p.discountTransfer?.selectedAmount), expectedSettlementDiff: n(p.effectiveDiff),
    requestIdempotencyKey: key ?? `dp20r7-${label}-0001` }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD' && cardOverride) input.cardPosOverride = {
      acknowledgedNoReverse: true, reason: `round7 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD
    }
  }
  return salesService.createExchange(input)
}
async function formulaCase({ id, N, d, R, option, protect = true, refundMode = 'CASH', expectedTransfer }) {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: protect })
  const sourceId = variant(`${id}-source`, N + d), replacementId = variant(`${id}-replacement`, R)
  const s = await sale({ lines: [{ variantId: sourceId, qty: 1, unitPrice: N + d, discount: d }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: R, discount: 0 }]
  const p = await preview(s.id, lines, replacements, option)
  const delta = R - N
  const transfer = option === 'NO' ? 0 : option === 'YES' ? Math.min(d, R) : delta > 0 ? Math.min(d, R, delta) : 0
  assert.equal(transfer, expectedTransfer, 'independent oracle transfer')
  assert.equal(n(p.returnTotal), N, 'returned net merchandise N')
  assert.equal(n(p.discountTransfer.historicalDiscount), d, 'historical discount d')
  assert.equal(n(p.discountTransfer.capacity), R, 'replacement capacity c')
  assert.equal(n(p.discountTransfer.policyDelta), delta, 'merchandise delta Δ')
  assert.equal(n(p.discountTransfer.selectedAmount), transfer, 'preview transfer t')
  const expectedDiff = R - transfer - N
  assert.equal(n(p.effectiveDiff), expectedDiff, 'cash-funded source: effective difference equals R−t−N')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option, p, label: `${id}`, refundMode })
  assert.equal(n(x.returnTotal), N)
  assert.equal(n(x.exchangeTotal), R - transfer)
  assert.equal(n(x.discountTransferAmount), transfer)
  assert.equal(n(x.diff), expectedDiff)
  if (expectedDiff > 0) assert.equal(n(x.cashReceived), expectedDiff)
  if (expectedDiff < 0 && refundMode === 'CASH') assert.equal(n(x.cashRefunded), -expectedDiff)
  if (expectedDiff < 0 && refundMode === 'STORE_CREDIT') assert.equal(n(x.newStoreCreditAmount), -expectedDiff)
  const rows = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', x.exchangeInvoiceId)
  assert.equal(rows.reduce((sum, row) => sum + n(row.discount), 0), transfer)
  assert.equal(rows.reduce((sum, row) => sum + n(row.lineTotal), 0), R - transfer)
  const events = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', x.returnId)
  assert.equal(events.filter(row => row.eventType === 'TRANSFER').reduce((sum, row) => sum + n(row.amount), 0), transfer)
  assert.equal(events.filter(row => row.eventType === 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0), d - transfer)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { N, d, R, delta, capacity: R, transfer, adjustedReplacement: R - transfer, diff: expectedDiff }
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

// 01. Recheck the owner's concrete example with independent integer-rial arithmetic.
await run(1, 'مثال مرجع مالک؛ N=۸۰۰٬۰۰۰، d=۲۰۰٬۰۰۰، R=۹۵۰٬۰۰۰', () => formulaCase({ id: '01', N: 800_000, d: 200_000, R: 950_000, option: 'YES_ZERO', expectedTransfer: 150_000 }))

// 02–05. One-rial boundary values around Δ=0 and Δ=d.
await run(2, 'مرز Δ=۰؛ انتقال YES_ZERO دقیقاً صفر', () => formulaCase({ id: '02', N: 800_000, d: 200_000, R: 800_000, option: 'YES_ZERO', expectedTransfer: 0 }))
await run(3, 'مرز Δ=۱؛ انتقال یک ریال و اختلاف نهایی صفر', () => formulaCase({ id: '03', N: 800_000, d: 200_000, R: 800_001, option: 'YES_ZERO', expectedTransfer: 1 }))
await run(4, 'مرز Δ=d−۱؛ انتقال یک ریال کمتر از کل تخفیف تاریخی', () => formulaCase({ id: '04', N: 800_000, d: 200_000, R: 999_999, option: 'YES_ZERO', expectedTransfer: 199_999 }))
await run(5, 'مرز Δ=d+۱؛ انتقال در سقف d متوقف می‌شود', () => formulaCase({ id: '05', N: 800_000, d: 200_000, R: 1_000_001, option: 'YES_ZERO', expectedTransfer: 200_000 }))

// 06. NO records expiry and leaves the full positive merchandise gap collectible.
await run(6, 'گزینهٔ NO؛ تخفیف منقضی، اختلاف مثبت کامل وصول می‌شود', () => formulaCase({ id: '06', N: 800_000, d: 200_000, R: 950_000, option: 'NO', expectedTransfer: 0 }))

// 07. Full YES is tested with the extra-refund guard deliberately disabled.
await run(7, 'YES با محافظ خاموش؛ انتقال کامل و بازپرداخت مازاد جدا از d', () => formulaCase({ id: '07', N: 800_000, d: 200_000, R: 900_000, option: 'YES', protect: false, refundMode: 'STORE_CREDIT', expectedTransfer: 200_000 }))

// 08. Multiple replacement rows: row shares sum to one source transfer and preserve child total.
await run(8, 'یک منبع به سه جایگزین؛ سهم‌ها و child total دقیق', async () => {
  const a = variant('08-source', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const ids = [variant('08-r1', 250_000), variant('08-r2', 300_000), variant('08-r3', 400_000)]
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = ids.map((id, i) => ({ variantId: id, qty: 1, unitPrice: [250_000, 300_000, 400_000][i], discount: 0 }))
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 800_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(p.replacementTransferShares.reduce((sum, amount) => sum + n(amount), 0), 150_000)
  assert.ok(p.replacementTransferShares.every((amount, i) => n(amount) <= replacements[i].unitPrice))
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '08' })
  const child = seed.rows('SELECT variantId,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', x.exchangeInvoiceId)
  assert.equal(child.length, 3)
  assert.equal(child.reduce((sum, row) => sum + n(row.discount), 0), 150_000)
  assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), 800_000)
  return { shares: p.replacementTransferShares, transfer: 150_000, childTotal: 800_000 }
})

// 09. Two source windows with different discounts: only the selected item contributes to transfer.
await run(9, 'دو پنجرهٔ نامساوی؛ انتقال فقط از قلم برگشتی انتخاب‌شده', async () => {
  const a = variant('09-a', 1_000_000), b = variant('09-b', 1_000_000), r = variant('09-r', 1_000_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 300_000 }
  ] })
  const selected = s.items.find(item => n(item.variantId) === b)
  const lines = [{ saleItemId: n(selected.id), qty: 1 }], replacements = [{ variantId: r, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 700_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 300_000)
  assert.equal(n(p.discountTransfer.policyDelta), 300_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '09' })
  const events = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.equal(events.reduce((sum, row) => sum + n(row.amount), 0), 300_000)
  assert.ok(events.every(row => n(row.sourceSaleItemId) === n(selected.id)))
  return { selectedItemDiscount: 300_000, otherItemDiscountUntouched: 100_000, transfer: 300_000 }
})

// 10. Two source windows feed three replacements; provenance, capacity, and allocation are checked independently.
await run(10, 'دو مبدأ به سه جایگزین؛ provenance منبع و سقف هر مقصد کنترل می‌شود', async () => {
  const a = variant('10-a', 1_000_000), b = variant('10-b', 1_000_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 200_000 }
  ] })
  const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
  const prices = [700_000, 600_000, 700_000]
  const targets = prices.map((price, i) => variant(`10-r${i + 1}`, price))
  const replacements = targets.map((id, i) => ({ variantId: id, qty: 1, unitPrice: prices[i], discount: 0 }))
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 1_700_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 300_000)
  assert.equal(n(p.discountTransfer.policyDelta), 300_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 300_000)
  assert.equal(p.replacementTransferShares.reduce((sum, amount) => sum + n(amount), 0), 300_000)
  assert.ok(p.replacementTransferShares.every((amount, i) => n(amount) <= prices[i]))
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '10' })
  const events = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.equal(events.reduce((sum, row) => sum + n(row.amount), 0), 300_000)
  assert.equal(new Set(events.map(row => n(row.sourceSaleItemId))).size, 2)
  return { sourceWindows: 2, replacementRows: 3, transfer: 300_000, shares: p.replacementTransferShares }
})

// 11. Current line discount on the child is distinct from the prior transferred share.
await run(11, 'تخفیف جاری جایگزین از انتقال قبلی جدا می‌ماند', async () => {
  const a = variant('11-root', 1_000_000), b = variant('11-child1', 1_000_000), c = variant('11-child2', 900_000)
  const root = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines1 = [{ saleItemId: n(root.items[0].id), qty: 1 }]
  const r1 = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 50_000 }]
  const p1 = await preview(root.id, lines1, r1, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.selectedAmount), 150_000)
  const x1 = await exchange({ invoiceId: root.id, lines: lines1, replacements: r1, option: 'YES_ZERO', p: p1, label: '11a' })
  const child = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', x1.exchangeInvoiceId)
  assert.equal(n(child.discount), 200_000)
  const lines2 = [{ saleItemId: n(child.id), qty: 1 }], r2 = [{ variantId: c, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p2 = await preview(x1.exchangeInvoiceId, lines2, r2, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 50_000)
  assert.equal(n(p2.discountTransfer.policyDelta), 100_000, 'Δ = R900k − N800k; it is independent of the remaining 50k source discount')
  assert.equal(n(p2.discountTransfer.selectedAmount), 50_000)
  const x2 = await exchange({ invoiceId: x1.exchangeInvoiceId, lines: lines2, replacements: r2, option: 'YES_ZERO', p: p2, label: '11b' })
  assert.equal(n(x2.discountTransferAmount), 50_000)
  return { firstHistoricalTransfer: 150_000, childCurrentDiscount: 50_000, secondTransfer: 50_000 }
})

// 12. Full source credit, positive remaining cash due after transfer.
await run(12, 'منبع اعتبار کامل؛ دریافت نقدی فقط برای باقیمانده پس از انتقال', async () => {
  const a = variant('12-source', 1_000_000), b = variant('12-r', 1_100_000)
  const credit = await issueCredit(800_000, { label: '12 full credit tender' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '12' })
  assert.equal(n(x.cashReceived), 100_000)
  assert.equal(n(x.discountTransferAmount), 200_000)
  return { sourceCredit: 800_000, transfer: 200_000, cashDue: 100_000 }
})

// 13. Out-of-scope replacement restores restricted credit and cannot cash it out.
await run(13, 'اعتبار محدود؛ SKU جایگزین خارج از scope و بازگردانی به منبع اصلی', async () => {
  const a = variant('13-allowed', 1_000_000), b = variant('13-outside', 800_000)
  const credit = await issueCredit(800_000, { restrictVariantIds: [a], label: '13 restricted' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 800_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '13' })
  assert.equal(n(x.sourceCreditRestoredAmount), 800_000)
  assert.equal(n(x.cardRefunded) + n(x.cashRefunded), 0)
  assert.equal(n(x.cashReceived), 800_000)
  return { originalRestrictedCreditRestored: 800_000, physicalRefund: 0, collectionForOutsideSku: 800_000 }
})

// 14. Restricted credit remains eligible when replacement stays inside its SKU scope.
await run(14, 'اعتبار محدود و جایگزین داخل scope؛ مصرف دوباره با همان منبع', async () => {
  const a = variant('14-allowed', 1_000_000)
  const credit = await issueCredit(800_000, { restrictVariantIds: [a], label: '14 restricted' })
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '14' })
  assert.equal(n(x.sourceCreditRestoredAmount), 0)
  assert.equal(n(x.discountTransferAmount), 200_000)
  return { scope: 'VARIANTS', sourceCreditRestored: 0, discountTransfer: 200_000 }
})

// 15. Tax and service remain in settlement while the discount delta stays merchandise-only.
await run(15, 'مالیات/حق‌سرویس در تسویه؛ مبنای انتقال فقط N و R کالایی است', async () => {
  const a = variant('15-source', 1_000_000), b = variant('15-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  sql.prepare('UPDATE "SaleInvoiceItem" SET tax=100000,lineTotal=1000000 WHERE id=?').run(s.items[0].id)
  sql.prepare('UPDATE "SaleInvoice" SET taxTotal=100000,serviceCharge=30000,grandTotal=930000,paidTotal=930000 WHERE id=?').run(s.id)
  sql.prepare('UPDATE "Payment" SET amount=930000 WHERE invoiceId=? AND voidedAt IS NULL').run(s.id)
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 930_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), -130_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '15', refundMode: 'CASH' })
  assert.equal(n(x.cashRefunded), 130_000)
  return { policyDeltaMerchandiseOnly: 150_000, transfer: 150_000, actualRefundIncludingCharges: 130_000 }
})

// 16. POS-origin negative exchange refund follows the manager-approved POS route only.
await run(16, 'بازپرداخت اختلاف به POS؛ تفکیک از نقد و با تأیید مدیر', async () => {
  const a = variant('16-source', 1_000_000), b = variant('16-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CARD' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = seed.count('CashMovement')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '16', refundMode: 'CARD' })
  assert.equal(n(x.cardRefunded), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('CashMovement'), before)
  return { posRefund: 100_000, cashMovementDelta: 0 }
})

// 17. CARD_TO_CARD is pending; no payout enters cash/POS ledger.
await run(17, 'بازپرداخت کارت‌به‌کارت؛ درخواست درانتظار و بدون حرکت پولی', async () => {
  const a = variant('17-source', 1_000_000), b = variant('17-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '17', refundMode: 'CARD_TO_CARD' })
  const request = seed.one('SELECT amount,status FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(request.amount), 100_000)
  assert.match(String(request.status).toUpperCase(), /PENDING|WAIT/)
  assert.equal(n(x.cashRefunded) + n(x.cardRefunded), 0)
  return { pendingRequest: n(request.amount), status: request.status, physicalPayout: 0 }
})

// 18. Two invalid payout attempts are both mutation-free on the same source invoice.
await run(18, 'روش تسویهٔ نامشخص و مبلغ بیش‌ازحد؛ هر دو رد بدون mutation', async () => {
  const a = variant('18-source', 1_000_000), b = variant('18-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = state([a, b])
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff),
    exchangeSettlementDecision: 'UNSELECTED', requestIdempotencyKey: 'dp20r7-18-unselected-0001' }), /فروشنده روش را انتخاب نکرده/)
  assert.deepEqual(state([a, b]), before)
  await assert.rejects(() => exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '18-over', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(state([a, b]), before)
  return { availableRefund: 100_000, unselectedRejected: true, excessiveRejected: true, mutation: false }
})

// 19. Exact idempotent replay returns the original committed identifiers.
await run(19, 'پاسخ replay همان شناسهٔ سند اصلی را بازمی‌گرداند', async () => {
  const a = variant('19-source', 1_000_000), b = variant('19-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES_ZERO',
    expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r7-19-replay-0001' }
  const first = await salesService.createExchange(input)
  const before = state([a, b])
  const again = await salesService.createExchange(input)
  assert.equal(again.replayed, true)
  assert.equal(again.returnId, first.returnId)
  assert.equal(again.exchangeInvoiceId, first.exchangeInvoiceId)
  assert.deepEqual(state([a, b]), before)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { replayed: true, sameReturn: true, sameChildInvoice: true }
})

// 20. After void, the discount event is immutable evidence; a later exchange gets no historic transfer.
await run(20, 'ابطال تعویض؛ تخفیف مصرف‌شده در مراجعهٔ بعدی احیا نمی‌شود', async () => {
  const a = variant('20-source', 1_000_000), b = variant('20-first', 950_000), c = variant('20-second', 950_000)
  const initialStock = stockOf(a)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '20-first' })
  await salesService.returnDelete({ id: first.returnId, userId, reason: 'round7 isolated void check', panelPassword: DEFAULT_MANAGER_PASSWORD })
  assert.equal(stockOf(a), initialStock - 1)
  assert.equal(stockOf(b), 100)
  const voidRows = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
  assert.ok(voidRows.length > 0)
  assert.ok(voidRows.every(row => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const nextLines = [{ saleItemId: n(s.items[0].id), qty: 1 }], nextReplacements = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const next = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: nextLines, replacements: nextReplacements, discountTransferOption: 'YES_ZERO' })
  assert.equal(next.ok, true, next.error)
  assert.equal(next.discountTransfer, undefined)
  const second = await salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: nextLines, replacements: nextReplacements,
    expectedSettlementDiff: n(next.effectiveDiff), requestIdempotencyKey: 'dp20r7-20-after-void-0001' })
  assert.equal(n(second.discountTransferAmount), 0)
  return { voidEvidence: voidRows.length, historicalTransferReissued: false, laterTransfer: 0 }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 7 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
