import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round10-200-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const n = value => Number(value ?? 0)
const userId = seed.user('discount-policy-round10 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 10', number: 69200, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R10-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R10-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let seq = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R10-${++seq}-${label}`, seed.category(`DP20R10-cat-${seq}`))
  const id = seed.variant(product, `DP20R10-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function snapshot(ids = []) {
  return { invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), redemptions: seed.count('StoreCreditRedemption'), events: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), cardRequests: seed.count('CardTransferRequest'), stocks: ids.map(stockOf) }
}
function allocation(total, weights) {
  const clean = weights.map(x => Math.max(0, Math.round(x))), sum = clean.reduce((a, b) => a + b, 0)
  if (!total || !sum || !clean.length) return clean.map(() => 0)
  const parts = clean.map((w, i) => { const exact = total * w / sum; return { i, floor: Math.floor(exact), rem: exact - Math.floor(exact) } })
  let left = Math.round(total) - parts.reduce((a, p) => a + p.floor, 0)
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i)) { if (!left) break; p.floor++; left-- }
  const out = clean.map(() => 0); for (const p of parts) out[p.i] = p.floor; return out
}
function cum(amount, qty) { return qty <= 0 ? 0 : Math.floor(amount * qty / 1 + 0.5) }
function windowAmount(amount, totalQty, startQty, qty) {
  const share = q => totalQty <= 0 ? 0 : Math.floor(amount * q / totalQty + 0.5)
  return share(startQty + qty) - share(startQty)
}
async function issueCredit(amount, restrictVariantIds = null, note = 'round10') {
  const issued = await storeCreditService.issueManual({ amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
    ...(restrictVariantIds ? { restrictScope: 'VARIANTS', restrictVariantIds } : {}),
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note })
  return seed.one('SELECT id,code,amount,usedAmount,status,expiresAt,restrictScope FROM "StoreCredit" WHERE id=?', issued.id)
}
async function sale({ lines, invoiceDiscount = 0, tender = 'CASH', credit = null }) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.qty - line.discount, 0) - invoiceDiscount
  let payments = [], storeCredits
  if (credit) {
    storeCredits = [{ code: credit.code, requestedAmount: n(credit.amount) }]
    const remainder = total - n(credit.amount)
    if (remainder < 0) throw new Error('credit amount exceeds invoice net')
    if (remainder > 0 && tender === 'CASH') payments = [{ methodId: cashId, amount: remainder, destination: 'CASH' }]
    else if (remainder > 0 && tender === 'CARD') payments = [{ methodId: cardId, amount: remainder, destination: 'CARD' }]
    else if (remainder > 0 && tender === 'MIXED') {
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
async function preview(invoiceId, lines, replacements, option = 'YES_ZERO', invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option })
  assert.equal(p.ok, true, p.error)
  return p
}
async function exchange({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0, refundMode = 'CASH', refundAmount, key, managerPassword }) {
  const input = { userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    ...(p?.discountTransfer ? { discountTransferOption: option } : {}),
    expectedDiscountTransferAmount: n(p?.discountTransfer?.selectedAmount), expectedSettlementDiff: n(p?.effectiveDiff),
    requestIdempotencyKey: key ?? `dp20r10-${label}-0001`, ...(managerPassword ? { managerPassword } : {}) }
  if (n(p?.effectiveDiff) > 0) input.methodId = cashId
  if (n(p?.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `round10 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  }
  return salesService.createExchange(input)
}
async function formulaCase({ id, N, d, R, option, protect = true, refundMode = 'CASH' }) {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: protect })
  const a = variant(`${id}-source`, N + d), b = variant(`${id}-replacement`, R)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: R, discount: 0 }]
  const p = await preview(s.id, lines, replacements, option)
  const delta = R - N, c = R
  const t = option === 'NO' ? 0 : option === 'YES' ? Math.min(d, c) : delta > 0 ? Math.min(d, c, delta) : 0
  assert.equal(n(p.returnTotal), N)
  assert.equal(n(p.discountTransfer.historicalDiscount), d)
  assert.equal(n(p.discountTransfer.capacity), c)
  assert.equal(n(p.discountTransfer.policyDelta), delta)
  assert.equal(n(p.discountTransfer.selectedAmount), t)
  const diff = R - t - N
  assert.equal(n(p.effectiveDiff), diff)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option, p, label: id, refundMode })
  assert.equal(n(x.returnTotal), N); assert.equal(n(x.exchangeTotal), R - t)
  assert.equal(n(x.discountTransferAmount), t); assert.equal(n(x.diff), diff)
  const child = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(child.reduce((sum, row) => sum + n(row.discount), 0), t)
  assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), R - t)
  const events = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', x.returnId)
  assert.equal(events.filter(row => row.eventType === 'TRANSFER').reduce((sum, row) => sum + n(row.amount), 0), t)
  assert.equal(events.filter(row => row.eventType === 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0), d - t)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { N, d, R, delta, capacity: c, transfer: t, settlement: diff }
}
const outcomes = []
async function run(id, title, fn) {
  try {
    const detail = await fn()
    outcomes.push({ id, title, status: 'PASS', detail: detail ?? null })
    console.log(`PASS ${String(id).padStart(3, '0')}/200 — ${title}`)
  } catch (error) {
    outcomes.push({ id, title, status: 'FAIL', detail: String(error?.stack ?? error) })
    console.error(`FAIL ${String(id).padStart(3, '0')}/200 — ${title}\n${String(error?.stack ?? error)}`)
  }
}
function invariantSnapshot(ids = []) { return snapshot(ids) }
async function rejectedWithoutFinancialMutation(ids, fn) {
  const before = invariantSnapshot(ids)
  await assert.rejects(fn)
  assert.deepEqual(invariantSnapshot(ids), before)
}

// 001–040: independent integer-rial arithmetic at several price scales and policy boundaries.
const deltas = [-10_000, -1, 0, 1, 1_000, 5_000, 9_999, 10_000, 10_001, 20_000]
const choices = ['NO', 'YES_ZERO', 'YES', 'YES_ZERO', 'NO', 'YES_ZERO', 'YES_ZERO', 'YES', 'NO', 'YES_ZERO']
let caseId = 1
for (const N of [100_000, 375_000, 1_250_000, 2_500_000]) {
  const d = Math.floor(N / 10)
  for (let j = 0; j < deltas.length; j++) {
    const scaledDelta = Math.round(deltas[j] * (d / 10_000))
    const option = choices[j]
    await run(caseId, `مرز سیاست ${option}؛ N=${N}، تخفیف=${d}، Δ=${scaledDelta}`, () =>
      formulaCase({ id: `p${caseId}`, N, d, R: N + scaledDelta, option, protect: option !== 'YES' }))
    caseId++
  }
}

// 041–060: partial quantities, cumulative rounding and repeated windows on one source line.
for (let i = 0; i < 20; i++) {
  const id = 41 + i
  await run(id, `پنجرهٔ مقداری ${i + 1}؛ برگشت جزئی با رُند تجمعی`, async () => {
    const qty = 2 + (i % 6), unit = 210_000 + i * 3_701, perDiscount = 1_001 + i * 83
    const totalDiscount = perDiscount * qty + (i % 2)
    const a = variant(`q${id}-source`, unit), s = await sale({ lines: [{ variantId: a, qty, unitPrice: unit, discount: totalDiscount }] })
    const item = s.items[0], take1 = 1 + (i % (qty - 1)), d1 = windowAmount(totalDiscount, qty, 0, take1)
    const net1 = windowAmount(unit * qty - totalDiscount, qty, 0, take1)
    const b = variant(`q${id}-replacement`, net1 + d1)
    const lines = [{ saleItemId: n(item.id), qty: take1 }], replacements = [{ variantId: b, qty: 1, unitPrice: net1 + d1, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'YES_ZERO')
    assert.equal(n(p.returnTotal), net1); assert.equal(n(p.discountTransfer.historicalDiscount), d1)
    assert.equal(n(p.discountTransfer.policyDelta), d1); assert.equal(n(p.discountTransfer.selectedAmount), d1)
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: `q${id}` })
    assert.equal(n(x.exchangeTotal), net1); assert.equal(n(x.diff), 0)
    if (i >= 10) {
      const take2 = qty - take1, d2 = windowAmount(totalDiscount, qty, take1, take2)
      const net2 = windowAmount(unit * qty - totalDiscount, qty, take1, take2)
      const c = variant(`q${id}-replacement2`, net2 + d2), lines2 = [{ saleItemId: n(item.id), qty: take2 }]
      const replacements2 = [{ variantId: c, qty: 1, unitPrice: net2 + d2, discount: 0 }]
      const p2 = await preview(s.id, lines2, replacements2, 'YES_ZERO')
      assert.equal(n(p2.returnTotal), net2); assert.equal(n(p2.discountTransfer.historicalDiscount), d2)
      const x2 = await exchange({ invoiceId: s.id, lines: lines2, replacements: replacements2, option: 'YES_ZERO', p: p2, label: `q${id}-second` })
      assert.equal(n(x2.exchangeTotal), net2); assert.equal(n(x2.diff), 0)
      assert.equal(d1 + d2, totalDiscount); assert.equal(net1 + net2, unit * qty - totalDiscount)
      return { qty, firstReturned: take1, secondReturned: take2, discounts: [d1, d2], nets: [net1, net2], cumulativeConservation: true }
    }
    return { qty, returned: take1, historicalWindow: d1, netReturn: net1, transfer: d1 }
  })
}

// 061–080: invoice-level discount allocation over unequal source rows and selected subsets.
for (let i = 0; i < 20; i++) {
  const id = 61 + i
  await run(id, `تخصیص تخفیف فاکتور چندقلمی ${i + 1}؛ وزن و انتخاب ردیف`, async () => {
    const count = 2 + (i % 4), prices = Array.from({ length: count }, (_, k) => 150_003 + i * 1_307 + k * (37_019 + i))
    const discounts = prices.map((price, k) => Math.floor(price * ((k + i) % 5 + 1) / 100))
    const weights = prices.map((price, k) => price - discounts[k]), invoiceDiscount = Math.floor(weights.reduce((a, b) => a + b, 0) * (1 + (i % 5)) / 100)
    const ids = prices.map((price, k) => variant(`mi${id}-s${k}`, price))
    const s = await sale({ lines: ids.map((variantId, k) => ({ variantId, qty: 1, unitPrice: prices[k], discount: discounts[k] })), invoiceDiscount })
    const shares = allocation(invoiceDiscount, weights)
    assert.equal(shares.reduce((a, b) => a + b, 0), invoiceDiscount)
    const selectedIdx = i % 2 === 0 ? [i % count] : Array.from(new Set([i % count, (i + 1) % count]))
    const lines = selectedIdx.map(k => ({ saleItemId: n(s.items[k].id), qty: 1 }))
    const historical = selectedIdx.reduce((sum, k) => sum + discounts[k] + shares[k], 0)
    const returnNet = selectedIdx.reduce((sum, k) => sum + prices[k] - discounts[k] - shares[k], 0)
    const replacementPrice = returnNet + historical, r = variant(`mi${id}-r`, replacementPrice)
    const replacements = [{ variantId: r, qty: 1, unitPrice: replacementPrice, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'YES_ZERO')
    assert.equal(n(p.returnTotal), returnNet); assert.equal(n(p.discountTransfer.historicalDiscount), historical)
    assert.equal(n(p.discountTransfer.selectedAmount), historical); assert.equal(n(p.effectiveDiff), 0)
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: `mi${id}` })
    assert.equal(n(x.discountTransferAmount), historical); assert.equal(n(x.exchangeTotal), returnNet)
    const ev = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
    assert.equal(ev.reduce((sum, row) => sum + n(row.amount), 0), historical)
    assert.equal(new Set(ev.map(row => n(row.sourceSaleItemId))).size, selectedIdx.length)
    return { sourceRows: count, selected: selectedIdx, invoiceDiscount, allocatedShares: shares, N: returnNet, d: historical }
  })
}

// 081–100: many replacement rows, independent capacity and invoice-discount allocation.
for (let i = 0; i < 20; i++) {
  const id = 81 + i
  await run(id, `جایگزین‌های متعدد ${i + 1}؛ ظرفیت پس از تخفیف‌های جاری`, async () => {
    const N = 700_000 + i * 11_003, d = 70_000 + i * 503, a = variant(`mr${id}-s`, N + d)
    const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
    const count = 2 + (i % 4), prices = Array.from({ length: count }, (_, k) => 180_000 + i * 1_113 + k * (41_003 + i * 7))
    const discounts = prices.map((price, k) => k === i % count ? Math.floor(price / 20) : Math.floor(price / 100))
    const weights = prices.map((price, k) => price - discounts[k]), invD = Math.floor(weights.reduce((x, y) => x + y, 0) * (i % 3) / 100)
    const rids = prices.map((price, k) => variant(`mr${id}-r${k}`, price))
    const replacements = rids.map((variantId, k) => ({ variantId, qty: 1, unitPrice: prices[k], discount: discounts[k] }))
    const net = weights.reduce((x, y) => x + y, 0) - invD, capacity = net
    const delta = net - N, expectedTransfer = delta > 0 ? Math.min(d, capacity, delta) : 0
    const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], p = await preview(s.id, lines, replacements, 'YES_ZERO', invD)
    assert.equal(n(p.returnTotal), N); assert.equal(n(p.discountTransfer.historicalDiscount), d)
    assert.equal(n(p.discountTransfer.capacity), capacity); assert.equal(n(p.discountTransfer.policyDelta), delta)
    assert.equal(n(p.discountTransfer.selectedAmount), expectedTransfer)
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, invoiceDiscount: invD, label: `mr${id}` })
    assert.equal(n(x.discountTransferAmount), expectedTransfer); assert.equal(n(x.exchangeTotal), net - expectedTransfer)
    const child = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', x.exchangeInvoiceId)
    assert.equal(child.reduce((sum, row) => sum + n(row.discount), 0), discounts.reduce((x, y) => x + y, 0) + expectedTransfer)
    const childInvoice = seed.one('SELECT discountTotal,grandTotal FROM "SaleInvoice" WHERE id=?', x.exchangeInvoiceId)
    assert.equal(n(childInvoice.discountTotal), discounts.reduce((x, y) => x + y, 0) + invD + expectedTransfer)
    assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), weights.reduce((x, y) => x + y, 0) - expectedTransfer)
    assert.equal(n(childInvoice.grandTotal), net - expectedTransfer)
    return { replacements: count, baseDiscount: discounts.reduce((x, y) => x + y, 0), invoiceDiscount: invD, capacity, delta, transfer: expectedTransfer }
  })
}

// 101–120: multi-source/multi-replacement exchange, tying provenance to every returned SKU.
for (let i = 0; i < 20; i++) {
  const id = 101 + i
  await run(id, `تعویض مرکب ${i + 1}؛ چند مبدأ و چند جایگزین`, async () => {
    const count = 2 + (i % 3), prices = Array.from({ length: count }, (_, k) => 260_000 + i * 2_003 + k * 77_013)
    const ds = prices.map((price, k) => Math.floor(price * ((k + 1) / 50)))
    const ids = prices.map((price, k) => variant(`mm${id}-s${k}`, price))
    const s = await sale({ lines: ids.map((variantId, k) => ({ variantId, qty: 1, unitPrice: prices[k], discount: ds[k] })), invoiceDiscount: (i % 2) * 17_003 })
    const w = prices.map((price, k) => price - ds[k]), invShare = allocation((i % 2) * 17_003, w)
    const N = prices.reduce((sum, p, k) => sum + p - ds[k] - invShare[k], 0)
    const d = ds.reduce((x, y) => x + y, 0) + invShare.reduce((x, y) => x + y, 0)
    const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
    const rc = 2 + (i % 3), rPrices = Array.from({ length: rc }, (_, k) => Math.floor((N + d + ((i % 5) - 2) * 20_000) / rc) + k * 13)
    const rids = rPrices.map((price, k) => variant(`mm${id}-r${k}`, price))
    const rDiscounts = rPrices.map((p, k) => k === 0 ? Math.floor(p / 100) : 0)
    const replacements = rids.map((variantId, k) => ({ variantId, qty: 1, unitPrice: rPrices[k], discount: rDiscounts[k] }))
    const baseNet = rPrices.reduce((x, y) => x + y, 0) - rDiscounts.reduce((x, y) => x + y, 0)
    const delta = baseNet - N, t = delta > 0 ? Math.min(d, baseNet, delta) : 0
    const p = await preview(s.id, lines, replacements, 'YES_ZERO')
    assert.equal(n(p.returnTotal), N); assert.equal(n(p.discountTransfer.historicalDiscount), d)
    assert.equal(n(p.discountTransfer.selectedAmount), t); assert.equal(n(p.discountTransfer.policyDelta), delta)
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: `mm${id}` })
    assert.equal(n(x.discountTransferAmount), t); assert.equal(n(x.exchangeTotal), baseNet - t)
    const sourceIds = new Set(seed.rows('SELECT sourceSaleItemId FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'EXPIRE').map(row => n(row.sourceSaleItemId)))
    if (d - t > 0) assert.equal(sourceIds.size, count)
    return { sourceRows: count, replacementRows: rc, sourceNet: N, historical: d, delta, transfer: t }
  })
}

// 121–140: cash/card/mixed/credit source tender and credit-restoration reconciliation.
for (let i = 0; i < 20; i++) {
  const id = 121 + i
  await run(id, `منبع تسویهٔ ترکیبی ${i + 1}؛ اعتبار/نقد/POS و تعویض`, async () => {
    const N = 600_000 + i * 9_017, d = 60_000 + i * 211, a = variant(`fund${id}-s`, N + d)
    const creditAmount = Math.floor(N * [0.2, 0.4, 0.6, 0.8, 1][i % 5]), credit = await issueCredit(creditAmount, null, `fund${id}`)
    const tender = ['CASH', 'CARD', 'MIXED'][i % 3]
    const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }], credit, tender })
    const delta = [-150_000, -50_000, 0, 50_000, 150_000][Math.floor(i / 4)]
    const R = N + delta, b = variant(`fund${id}-r`, R), lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
    const replacements = [{ variantId: b, qty: 1, unitPrice: R, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'NO')
    assert.equal(n(p.returnTotal), N); assert.equal(n(p.discountTransfer.selectedAmount), 0)
    const refundMode = i % 4 === 0 ? 'CARD' : i % 4 === 1 ? 'STORE_CREDIT' : 'CASH'
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: `fund${id}`, refundMode })
    assert.equal(n(x.returnTotal), N); assert.equal(n(x.exchangeTotal), R)
    assert.equal(n(x.diff), n(p.effectiveDiff), `preview/commit diff mismatch: ${JSON.stringify({ previewDiff: p.effectiveDiff, actualDiff: x.diff, sourceCredit: creditAmount, tender, delta })}`)
    const expectedMoneySurplus = Math.max(0, N - creditAmount - R)
    const expectedCreditRestore = creditAmount - Math.min(creditAmount, Math.max(0, R - (N - creditAmount)))
    assert.equal(n(p.realMoneySurplus), expectedMoneySurplus)
    assert.equal(n(p.sourceCreditRestoration), expectedCreditRestore)
    assert.equal(n(x.sourceCreditRestoredAmount), expectedCreditRestore)
    assert.equal(n(x.realMoneyRefundAmount), expectedMoneySurplus)
    assert.equal(n(x.finalRefundValue), expectedMoneySurplus + expectedCreditRestore)
    assert.equal(n(x.cashRefunded) + n(x.cardRefunded) + n(x.newStoreCreditAmount) + n(x.cardToCard), expectedMoneySurplus)
    const currentCredit = seed.one('SELECT amount,usedAmount,status FROM "StoreCredit" WHERE id=?', credit.id)
    assert.ok(n(currentCredit.usedAmount) >= 0 && n(currentCredit.usedAmount) <= n(currentCredit.amount))
    return { sourceCredit: creditAmount, tender, N, replacement: R, diff: delta, sourceCreditRestored: n(x.sourceCreditRestoredAmount), refundMode }
  })
}

// 141–160: multi-step exchanges and unconsumed discount windows on the same source invoice.
for (let i = 0; i < 20; i++) {
  const id = 141 + i
  await run(id, `زنجیرهٔ چندمرحله‌ای ${i + 1}؛ جلوگیری از انتقال دوباره یا از دست‌رفتن پنجره`, async () => {
    if (i < 10) {
      const N = 500_000 + i * 7_001, d = 50_000 + i * 301
      const a = variant(`chain${id}-a`, N + d), b = variant(`chain${id}-b`, N + d), c = variant(`chain${id}-c`, N + d)
      const root = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
      const srcLines = [{ saleItemId: n(root.items[0].id), qty: 1 }], repl1 = [{ variantId: b, qty: 1, unitPrice: N + d, discount: 0 }]
      const p1 = await preview(root.id, srcLines, repl1, 'YES_ZERO')
      assert.equal(n(p1.discountTransfer.selectedAmount), d)
      const x1 = await exchange({ invoiceId: root.id, lines: srcLines, replacements: repl1, option: 'YES_ZERO', p: p1, label: `chain${id}a` })
      const childItem = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', x1.exchangeInvoiceId)[0]
      const repl2 = [{ variantId: c, qty: 1, unitPrice: N + d, discount: 0 }]
      const p2 = await preview(n(x1.exchangeInvoiceId), [{ saleItemId: n(childItem.id), qty: 1 }], repl2, 'YES_ZERO')
      assert.equal(p2.discountTransfer, undefined, 'transferred discount cannot be treated as fresh historic discount')
      const x2 = await salesService.createExchange({ userId, shiftId, invoiceId: n(x1.exchangeInvoiceId),
        lines: [{ saleItemId: n(childItem.id), qty: 1 }], replacements: repl2,
        expectedSettlementDiff: n(p2.effectiveDiff), requestIdempotencyKey: `dp20r10-chain${id}b-0001` })
      assert.equal(n(x2.discountTransferAmount), 0)
      assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=? AND eventType=?', x2.returnId, 'TRANSFER'), 0)
      return { stages: 2, firstTransfer: d, secondTransfer: 0, childHistoricWindowReused: false }
    }
    const qty = 2 + (i % 5), unit = 450_000 + i * 1_001, perDiscount = 10_003 + (i % 7) * 101, d = perDiscount * qty
    const a = variant(`partialchain${id}-a`, unit), root = await sale({ lines: [{ variantId: a, qty, unitPrice: unit, discount: d }] })
    const firstQty = 1, firstN = windowAmount(unit * qty - d, qty, 0, firstQty), firstD = windowAmount(d, qty, 0, firstQty)
    const b = variant(`partialchain${id}-b`, firstN + firstD), l1 = [{ saleItemId: n(root.items[0].id), qty: firstQty }], r1 = [{ variantId: b, qty: 1, unitPrice: firstN + firstD, discount: 0 }]
    const p1 = await preview(root.id, l1, r1, 'YES_ZERO')
    assert.equal(n(p1.discountTransfer.historicalDiscount), firstD)
    await exchange({ invoiceId: root.id, lines: l1, replacements: r1, option: 'YES_ZERO', p: p1, label: `partialchain${id}a` })
    const restQty = qty - 1, restN = windowAmount(unit * qty - d, qty, 1, restQty), restD = windowAmount(d, qty, 1, restQty)
    const c = variant(`partialchain${id}-c`, restN + restD), l2 = [{ saleItemId: n(root.items[0].id), qty: restQty }], r2 = [{ variantId: c, qty: 1, unitPrice: restN + restD, discount: 0 }]
    const p2 = await preview(root.id, l2, r2, 'YES_ZERO')
    assert.equal(n(p2.returnTotal), restN); assert.equal(n(p2.discountTransfer.historicalDiscount), restD)
    const x2 = await exchange({ invoiceId: root.id, lines: l2, replacements: r2, option: 'YES_ZERO', p: p2, label: `partialchain${id}b` })
    assert.equal(n(x2.discountTransferAmount), restD); assert.equal(firstD + restD, d)
    return { sourceQty: qty, firstWindow: firstD, remainingWindow: restD, allDiscountWindowsConserved: true }
  })
}

// 161–180: atomic rejection matrix for malformed, over-limit and stale settlement requests.
for (let i = 0; i < 20; i++) {
  const id = 161 + i
  await run(id, `رد اتمیک درخواست ناسالم ${i + 1}؛ هیچ دفتر یا موجودی نیمه‌ثبت نشود`, async () => {
    const N = 300_000 + i * 997, d = 30_000, a = variant(`bad${id}-s`, N + d), b = variant(`bad${id}-r`, N + 20_000)
    const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
    const goodLines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: N + 20_000, discount: 0 }]
    const p = await preview(s.id, goodLines, replacements, 'YES_ZERO'), beforeIds = [a, b]
    const variants = [
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements: [], expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-empty` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: [{ saleItemId: n(s.items[0].id), qty: 2 }], replacements, expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-overqty` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: [{ saleItemId: 9_999_999_001, qty: 1 }], replacements, expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-foreign` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: n(p.discountTransfer.selectedAmount), expectedSettlementDiff: n(p.effectiveDiff) + 1, methodId: cashId, requestIdempotencyKey: `dp20r10-bad${id}-diff` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: n(p.discountTransfer.selectedAmount) + 1, expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-transfer` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, discountTransferOption: 'INVALID', expectedDiscountTransferAmount: 0, expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-option` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements: [{ ...replacements[0], unitPrice: N + 19_999 }], expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-price` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, refundMode: 'UNKNOWN', exchangeSettlementDecision: 'METHOD', expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-refundmode` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, requestIdempotencyKey: 'x' }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, refundAmount: -1, refundMode: 'CASH', exchangeSettlementDecision: 'METHOD', expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-negative-refund` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: [{ ...goodLines[0], qty: 0 }], replacements, expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-zeroqty` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: 9_999_999_002, lines: goodLines, replacements, expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-invoice` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-bad-expected` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, exchangeSettlementDecision: 'METHOD', expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-missing-method` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, refundMode: 'CASH', exchangeSettlementDecision: 'UNSELECTED', expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: `dp20r10-bad${id}-conflict` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements: [{ variantId: 9_999_999_003, qty: 1, unitPrice: N, discount: 0 }], expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-missing-sku` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements: [{ variantId: b, qty: 0, unitPrice: N, discount: 0 }], expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-zero-replacement` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, expectedDiscountTransferAmount: 0, expectedSettlementDiff: 1, methodId: cashId, requestIdempotencyKey: `dp20r10-bad${id}-stale-amount` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: [...goodLines, ...goodLines], replacements, expectedSettlementDiff: 0, requestIdempotencyKey: `dp20r10-bad${id}-duplicate-overreturn` }),
      () => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: goodLines, replacements, refundMode: 'CARD', exchangeSettlementDecision: 'METHOD', refundAmount: 999_999, expectedSettlementDiff: -1, requestIdempotencyKey: `dp20r10-bad${id}-oversized-refund` })
    ]
    const fn = variants[i]
    await rejectedWithoutFinancialMutation(beforeIds, fn)
    return { rejectedCase: i + 1, mutationFree: true, baseline: { sourceNet: N, discount: d } }
  })
}

// 181–200: idempotent retries, voided windows, no-history control and post-void safety.
for (let i = 0; i < 20; i++) {
  const id = 181 + i
  await run(id, `تکرار/ابطال/کنترل ${i + 1}؛ قفل پنجره و کلید ثبت`, async () => {
    const N = 400_000 + i * 1_009, d = 40_000, a = variant(`life${id}-s`, N + d), b = variant(`life${id}-r1`, N + d), c = variant(`life${id}-r2`, N + d)
    const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
    const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: N + d, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'YES_ZERO')
    if (i < 10) {
      const key = `dp20r10-life${id}-idem-0001`, input = { userId, shiftId, invoiceId: s.id, lines, replacements,
        discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: d, expectedSettlementDiff: 0, requestIdempotencyKey: key }
      const first = await salesService.createExchange(input), afterFirst = snapshot([a, b, c])
      const replay = await salesService.createExchange(input)
      assert.equal(replay.replayed, true); assert.equal(replay.returnId, first.returnId)
      assert.deepEqual(snapshot([a, b, c]), afterFirst)
      await assert.rejects(() => salesService.createExchange({ ...input, replacements: [{ variantId: c, qty: 1, unitPrice: N + d, discount: 0 }] }))
      assert.deepEqual(snapshot([a, b, c]), afterFirst)
      return { samePayloadReplay: true, changedPayloadRejected: true, duplicateMutation: false }
    }
    if (i < 15) {
      const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: `life${id}-void` })
      await salesService.returnDelete({ id: first.returnId, userId, reason: `round10 isolated void ${id}`, panelPassword: DEFAULT_MANAGER_PASSWORD })
      const voidEvents = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
      assert.ok(voidEvents.length > 0)
      const p2 = await salesService.previewExchangeFunding({ invoiceId: s.id, lines, replacements: [{ variantId: c, qty: 1, unitPrice: N + d, discount: 0 }], discountTransferOption: 'YES_ZERO' })
      assert.equal(p2.ok, true, p2.error); assert.equal(p2.discountTransfer, undefined)
      return { voidEvents: voidEvents.length, historicalWindowRestored: false, freshTransfer: 0 }
    }
    const plain = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: 0 }] })
    const plainItem = plain.items[0], plainR = [{ variantId: c, qty: 1, unitPrice: N + d, discount: 0 }]
    const plainLines = [{ saleItemId: n(plainItem.id), qty: 1 }], p2 = await preview(plain.id, plainLines, plainR, 'YES')
    assert.equal(p2.discountTransfer, undefined)
    const before = snapshot([a, c]), x = await exchange({ invoiceId: plain.id, lines: plainLines, replacements: plainR, option: 'YES', p: p2, label: `life${id}-nohistory` })
    assert.equal(n(x.discountTransferAmount), 0); assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=?', x.returnId), 0)
    assert.equal(stockOf(a), before.stocks[0] + 1)
    return { historicalDiscount: 0, transferEvents: 0, noSyntheticTransfer: true }
  })
}

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 10 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/200 PASS; ${failed.length}/200 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
