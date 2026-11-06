import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round9-40-'))
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
const userId = seed.user('discount-policy-round9 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 9', number: 68940, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R9-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R9-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let seq = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R9-${++seq}-${label}`, seed.category(`DP20R9-cat-${seq}`))
  const id = seed.variant(product, `DP20R9-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function snapshot(ids = []) {
  return { invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), redemptions: seed.count('StoreCreditRedemption'), events: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), cardRequests: seed.count('CardTransferRequest'), stocks: ids.map(stockOf) }
}
async function issueCredit(amount, restrictVariantIds = null, note = 'round9') {
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
  const created = await salesService.create({ userId, shiftId, lines: lines.map(line => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments, storeCredits })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { id: n(created.id), items, total, created }
}
async function preview(invoiceId, lines, replacements, option, invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option })
  assert.equal(p.ok, true, p.error)
  return p
}
async function exchange({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0, refundMode = 'CASH', refundAmount, key }) {
  const input = { userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    ...(p.discountTransfer ? { discountTransferOption: option } : {}),
    expectedDiscountTransferAmount: n(p.discountTransfer?.selectedAmount), expectedSettlementDiff: n(p.effectiveDiff),
    requestIdempotencyKey: key ?? `dp20r9-${label}-0001` }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `round9 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  }
  return salesService.createExchange(input)
}
async function formulaCase({ id, N, d, R, option, t, protect = true, refundMode = 'CASH' }) {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: protect })
  const a = variant(`${id}-source`, N + d), b = variant(`${id}-replacement`, R)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: R, discount: 0 }]
  const p = await preview(s.id, lines, replacements, option)
  const delta = R - N
  const oracle = option === 'NO' ? 0 : option === 'YES' ? Math.min(d, R) : delta > 0 ? Math.min(d, R, delta) : 0
  assert.equal(oracle, t, 'independent policy oracle')
  assert.equal(n(p.returnTotal), N)
  assert.equal(n(p.discountTransfer.historicalDiscount), d)
  assert.equal(n(p.discountTransfer.capacity), R)
  assert.equal(n(p.discountTransfer.policyDelta), delta)
  assert.equal(n(p.discountTransfer.selectedAmount), t)
  const diff = R - t - N
  assert.equal(n(p.effectiveDiff), diff)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option, p, label: id, refundMode })
  assert.equal(n(x.returnTotal), N)
  assert.equal(n(x.exchangeTotal), R - t)
  assert.equal(n(x.discountTransferAmount), t)
  assert.equal(n(x.diff), diff)
  if (diff > 0) assert.equal(n(x.cashReceived), diff)
  if (diff < 0 && refundMode === 'CASH') assert.equal(n(x.cashRefunded), -diff)
  if (diff < 0 && refundMode === 'STORE_CREDIT') assert.equal(n(x.newStoreCreditAmount), -diff)
  const child = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(child.reduce((sum, row) => sum + n(row.discount), 0), t)
  assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), R - t)
  const events = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', x.returnId)
  assert.equal(events.filter(row => row.eventType === 'TRANSFER').reduce((sum, row) => sum + n(row.amount), 0), t)
  assert.equal(events.filter(row => row.eventType === 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0), d - t)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { N, d, R, delta, c: R, t, postTransferR: R - t, diff }
}
const outcomes = []
async function run(id, title, fn) {
  try {
    const detail = await fn()
    outcomes.push({ id, title, status: 'PASS', detail: detail ?? null })
    console.log(`PASS ${String(id).padStart(2, '0')}/40 — ${title}`)
  } catch (error) {
    outcomes.push({ id, title, status: 'FAIL', detail: String(error?.stack ?? error) })
    console.error(`FAIL ${String(id).padStart(2, '0')}/40 — ${title}\n${String(error?.stack ?? error)}`)
  }
}

// 01–20: integer-rial policy/settlement matrix with explicit independent oracle and committed ledgers.
const matrix = [
  { N: 100_000, d: 10_000, delta: -1, option: 'NO', t: 0 },
  { N: 200_000, d: 50_000, delta: 0, option: 'NO', t: 0 },
  { N: 300_000, d: 100_000, delta: 0, option: 'YES_ZERO', t: 0 },
  { N: 300_000, d: 100_000, delta: 1, option: 'YES_ZERO', t: 1 },
  { N: 300_000, d: 100_000, delta: 99_999, option: 'YES_ZERO', t: 99_999 },
  { N: 300_000, d: 100_000, delta: 100_000, option: 'YES_ZERO', t: 100_000 },
  { N: 300_000, d: 100_000, delta: 100_001, option: 'YES_ZERO', t: 100_000 },
  { N: 300_000, d: 100_000, delta: 500_000, option: 'YES_ZERO', t: 100_000 },
  { N: 500_000, d: 300_000, delta: -100_000, option: 'YES_ZERO', t: 0 },
  { N: 500_000, d: 300_000, delta: -100_000, option: 'YES', t: 300_000, protect: false, refundMode: 'STORE_CREDIT' },
  { N: 750_000, d: 250_000, delta: 50_000, option: 'YES', t: 250_000, protect: false, refundMode: 'STORE_CREDIT' },
  { N: 750_000, d: 250_000, delta: 250_000, option: 'YES_ZERO', t: 250_000 },
  { N: 750_000, d: 250_000, delta: 250_001, option: 'YES_ZERO', t: 250_000 },
  { N: 900_000, d: 100_000, delta: -1, option: 'NO', t: 0 },
  { N: 900_000, d: 100_000, delta: -100_000, option: 'YES_ZERO', t: 0 },
  { N: 1_100_000, d: 400_000, delta: 400_000, option: 'YES_ZERO', t: 400_000 },
  { N: 1_100_000, d: 400_000, delta: 400_001, option: 'YES_ZERO', t: 400_000 },
  { N: 1_100_000, d: 400_000, delta: 700_000, option: 'NO', t: 0 },
  { N: 125_000, d: 25_000, delta: 25_000, option: 'YES_ZERO', t: 25_000 },
  { N: 2_000_000, d: 500_000, delta: 250_000, option: 'YES_ZERO', t: 250_000 }
]
for (let i = 0; i < matrix.length; i++) {
  const row = matrix[i]
  await run(i + 1, `ماتریس ریالی #${String(i + 1).padStart(2, '0')}؛ ${row.option} با N=${row.N}، d=${row.d}، Δ=${row.delta}`, () =>
    formulaCase({ ...row, id: `m${String(i + 1).padStart(2, '0')}`, R: row.N + row.delta }))
}

// 21. Line discount plus invoice discount on one source row; source history total is the sum, not either layer alone.
await run(21, 'دو لایهٔ تخفیف مبدأ روی قلم واحد؛ تاریخی برابر مجموع دو لایه', async () => {
  const a = variant('21-source', 1_000_000), b = variant('21-r', 1_100_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 800_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p.discountTransfer.policyDelta), 300_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '21' })
  assert.equal(n(x.diff), 100_000)
  assert.equal(n(x.cashReceived), 100_000)
  return { direct: 100_000, invoice: 100_000, N: 800_000, delta: 300_000, t: 200_000, due: 100_000 }
})

// 22. Four source lines with exact invoice discount conservation, then a full NO exchange.
await run(22, 'چهار قلم هم‌قیمت؛ تخفیف فاکتور کامل به شکل expiry ثبت می‌شود', async () => {
  const sourceIds = [0, 1, 2, 3].map(i => variant(`22-s${i}`, 250_000))
  const s = await sale({ lines: sourceIds.map(id => ({ variantId: id, qty: 1, unitPrice: 250_000, discount: 0 })), invoiceDiscount: 100_000 })
  const shares = []
  for (let i = 0; i < s.items.length; i++) {
    const item = s.items[i]
    const probe = await preview(s.id, [{ saleItemId: n(item.id), qty: 1 }], [{ variantId: sourceIds[i], qty: 1, unitPrice: 250_000, discount: 0 }], 'NO')
    shares.push(250_000 - n(probe.returnTotal))
  }
  assert.deepEqual(shares, [25_000, 25_000, 25_000, 25_000])
  const replacements = shares.map((_, i) => ({ variantId: variant(`22-r${i}`, 225_000), qty: 1, unitPrice: 225_000, discount: 0 }))
  const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.returnTotal), 900_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '22' })
  assert.equal(n(x.diff), 0)
  const expires = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'EXPIRE')
  assert.equal(expires.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  return { allocatedShares: shares, totalInvoiceDiscount: 100_000, expired: 100_000 }
})

// 23. Mixed direct/invoice discount: return only one source line; verify its weighted invoice share.
await run(23, 'دو قلم وزن‌دار؛ سهم تخفیف invoice روی ردیف منتخب دقیقاً متناسب است', async () => {
  const a = variant('23-a', 900_000), b = variant('23-b', 1_100_000), r = variant('23-r', 1_100_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 900_000, discount: 90_000 },
    { variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }
  ], invoiceDiscount: 100_000 })
  const itemA = s.items.find(item => n(item.variantId) === a)
  const lines = [{ saleItemId: n(itemA.id), qty: 1 }], replacements = [{ variantId: r, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const rowNet = n(p.returnTotal)
  const historic = n(p.discountTransfer.historicalDiscount)
  assert.equal(rowNet + historic, 900_000)
  assert.equal(n(p.discountTransfer.policyDelta), 1_100_000 - rowNet)
  assert.equal(n(p.discountTransfer.selectedAmount), Math.min(historic, 1_100_000 - rowNet))
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '23' })
  const ev = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.ok(ev.every(row => n(row.sourceSaleItemId) === n(itemA.id)))
  return { returnedNet: rowNet, historicalShare: historic, transferred: n(x.discountTransferAmount) }
})

// 24. A return of two units from a four-unit invoice preserves exact line discount allocation.
await run(24, 'qty=۴؛ برگشت دو واحد در یک تعویض، دو پنجره را دقیق جمع می‌کند', async () => {
  const a = variant('24-source', 500_000), b = variant('24-r', 500_000)
  const s = await sale({ lines: [{ variantId: a, qty: 4, unitPrice: 500_000, discount: 80_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 2 }], replacements = [{ variantId: b, qty: 2, unitPrice: 500_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 960_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 40_000)
  assert.equal(n(p.discountTransfer.policyDelta), 40_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 40_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '24' })
  assert.equal(n(x.exchangeTotal), 960_000)
  assert.equal(n(x.diff), 0)
  return { qtyReturned: 2, N: 960_000, dWindow: 40_000, transfer: 40_000, diff: 0 }
})

// 25. Three distinct source lines with discounts are exchanged to one replacement row; all source IDs survive provenance.
await run(25, 'سه مبدأ به یک جایگزین؛ هر پنجره در provenance ثبت می‌شود', async () => {
  const ids = [0, 1, 2].map(i => variant(`25-s${i}`, 1_000_000))
  const s = await sale({ lines: ids.map((id, i) => ({ variantId: id, qty: 1, unitPrice: 1_000_000, discount: [50_000, 100_000, 150_000][i] })) })
  const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
  const r = variant('25-r', 2_700_000)
  const replacements = [{ variantId: r, qty: 1, unitPrice: 2_700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 2_700_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 300_000)
  assert.equal(n(p.discountTransfer.policyDelta), 0)
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '25' })
  const expires = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'EXPIRE')
  assert.equal(expires.reduce((sum, row) => sum + n(row.amount), 0), 300_000)
  assert.equal(new Set(expires.map(row => n(row.sourceSaleItemId))).size, 3)
  return { sources: 3, historical: 300_000, delta: 0, transferred: 0, expired: 300_000 }
})

// 26. Four replacement rows with one current discount: capacity and final discount total are independently checked.
await run(26, 'چهار جایگزین؛ یک تخفیف جاری و انتقال تاریخی در سقف خالص', async () => {
  const a = variant('26-source', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const prices = [300_000, 300_000, 300_000, 300_000]
  const ids = prices.map((price, i) => variant(`26-r${i}`, price))
  const replacements = prices.map((price, i) => ({ variantId: ids[i], qty: 1, unitPrice: price, discount: i === 0 ? 50_000 : 0 }))
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.capacity), 1_150_000)
  assert.equal(n(p.discountTransfer.policyDelta), 350_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '26' })
  const rows = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(rows.reduce((sum, row) => sum + n(row.discount), 0), 250_000)
  assert.equal(rows.reduce((sum, row) => sum + n(row.lineTotal), 0), 950_000)
  return { currentDiscount: 50_000, transfer: 200_000, childDiscountTotal: 250_000, childNet: 950_000 }
})

// 27. A barcode-only source with a positive residual collects cash only after eligible credit is exhausted.
await run(27, 'اعتبار کامل و جایگزین بزرگ‌تر؛ اعتبار و وجه نقد جدا تسویه می‌شوند', async () => {
  const a = variant('27-source', 1_000_000), b = variant('27-r', 1_100_000)
  const credit = await issueCredit(800_000, null, '27 full credit')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.effectiveDiff), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '27' })
  assert.equal(n(x.cashReceived), 100_000)
  assert.equal(n(x.exchangeCreditApplied), 800_000)
  return { creditApplied: 800_000, cashCollected: 100_000, transfer: 200_000 }
})

// 28. Restricted credit source: out-of-scope replacement cannot turn credit restoration into cash refund.
await run(28, 'اعتبار محدود و replacement خارج از scope؛ بازگردانی منبع بدون بازپرداخت نقدی', async () => {
  const a = variant('28-allowed', 1_000_000), b = variant('28-outside', 800_000)
  const credit = await issueCredit(800_000, [a], '28 restricted')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 800_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '28' })
  assert.equal(n(x.sourceCreditRestoredAmount), 800_000)
  assert.equal(n(x.cashRefunded) + n(x.cardRefunded), 0)
  assert.equal(n(x.cashReceived), 800_000)
  return { restoredToSource: 800_000, cashRefund: 0, outOfScopeCollection: 800_000 }
})

// 29. Mixed barcode plus cash/card source, zero economic difference after transfer.
await run(29, 'اعتبار+نقد+کارت در خرید؛ YES_ZERO انتقال را یک‌بار ثبت می‌کند', async () => {
  const a = variant('29-source', 1_000_000), b = variant('29-r', 950_000)
  const credit = await issueCredit(400_000, null, '29 mixed credit tender')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit, tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '29' })
  assert.equal(n(x.discountTransferAmount), 150_000)
  assert.equal(n(x.cashReceived), 0)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER'), 1)
  return { tenderMix: 'credit+cash+card', transfer: 150_000, diff: 0, transferEvents: 1 }
})

// 30. A source credit and real cash surplus are never conflated during a negative exchange.
await run(30, 'وجه واقعی و اعتبار مبدأ؛ مازاد اعتبار به نقد تبدیل نمی‌شود', async () => {
  const a = variant('30-source', 1_000_000), b = variant('30-r', 700_000)
  const credit = await issueCredit(400_000, null, '30 mixed credit tender')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit, tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '30', refundMode: 'CASH' })
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.sourceCreditRestoredAmount), 100_000)
  assert.equal(n(x.newStoreCreditAmount), 0)
  return { cashRefund: 0, sourceCreditRestored: 100_000, newMoneyCredit: 0 }
})

// 31. A full-YES selection with a negative difference and guard off gives only the source-backed cash refund.
await run(31, 'YES محافظ‌خاموش با اختلاف منفی؛ بازپرداخت فقط مازاد پس از انتقال', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = variant('31-source', 1_000_000), b = variant('31-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), -300_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '31', refundMode: 'CASH' })
  assert.equal(n(x.cashRefunded), 300_000)
  assert.equal(n(x.discountTransferAmount), 200_000)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { transfer: 200_000, cashRefund: 300_000 }
})

// 32. On a source invoice with no historic discount, even YES does not emit discount-transfer evidence.
await run(32, 'فاکتور بدون تخفیف تاریخی؛ YES هم رویداد انتقال مصنوعی ایجاد نمی‌کند', async () => {
  const a = variant('32-source', 1_000_000), b = variant('32-r', 1_100_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(p.discountTransfer, undefined)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '32' })
  assert.equal(n(x.discountTransferAmount), 0)
  assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=?', x.returnId), 0)
  assert.equal(n(x.cashReceived), 100_000)
  return { history: 0, transferEventCount: 0, amountCollected: 100_000 }
})

// 33. A missing replacement SKU stops preview before any return or stock movement.
await run(33, 'SKU جایگزین ناموجود؛ preview ناموفق و بدون mutation', async () => {
  const a = variant('33-source', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const before = snapshot([a])
  const p = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: [{ saleItemId: n(s.items[0].id), qty: 1 }],
    replacements: [{ variantId: 999_999_991, qty: 1, unitPrice: 950_000, discount: 0 }], discountTransferOption: 'YES_ZERO' })
  assert.equal(p.ok, false)
  assert.match(p.error, /پیدا نشد|موجودی/)
  assert.deepEqual(snapshot([a]), before)
  return { replacementMissing: true, previewRejected: true, mutation: false }
})

// 34. One-rial-invalid negative payout cannot bypass the source-backed refund ceiling.
await run(34, 'refundAmount فقط یک ریال بالاتر از سقف؛ رد اتمیک', async () => {
  const a = variant('34-source', 1_000_000), b = variant('34-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO'), before = snapshot([a, b])
  assert.equal(n(p.effectiveDiff), -100_000)
  await assert.rejects(() => exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '34', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(snapshot([a, b]), before)
  return { allowedRefund: 100_000, requested: 100_001, mutation: false }
})

// 35. Wrong expected settlement amount is rejected and leaves the transaction graph unchanged.
await run(35, 'expectedSettlementDiff اشتباه؛ ثبت و همهٔ دفترها rollback می‌شوند', async () => {
  const a = variant('35-source', 1_000_000), b = variant('35-r', 900_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO'), before = snapshot([a, b])
  assert.equal(n(p.effectiveDiff), 100_000)
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0, expectedSettlementDiff: 99_999, methodId: cashId,
    requestIdempotencyKey: 'dp20r9-35-wrong-diff-0001' }))
  assert.deepEqual(snapshot([a, b]), before)
  return { preview: 100_000, submitted: 99_999, mutation: false }
})

// 36. Wrong expected transfer amount is rejected even though the selected option itself is valid.
await run(36, 'expectedDiscountTransferAmount اشتباه؛ انتقال جایگزین یا return ساخته نمی‌شود', async () => {
  const a = variant('36-source', 1_000_000), b = variant('36-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO'), before = snapshot([a, b])
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 149_999, expectedSettlementDiff: 0,
    requestIdempotencyKey: 'dp20r9-36-wrong-transfer-0001' }))
  assert.deepEqual(snapshot([a, b]), before)
  return { previewTransfer: 150_000, submitted: 149_999, mutation: false }
})

// 37. Guard changes after preview; a newly disabled YES is recomputed and rejected atomically.
await run(37, 'محافظ از خاموش به روشن تغییر می‌کند؛ YES تازه‌غیرفعال و ثبت رد می‌شود', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = variant('37-source', 1_000_000), b = variant('37-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find(row => row.option === 'YES').enabled, true)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'YES', expectedDiscountTransferAmount: 200_000, expectedSettlementDiff: -300_000,
    refundMode: 'STORE_CREDIT', exchangeSettlementDecision: 'METHOD', requestIdempotencyKey: 'dp20r9-37-guard-flip-0001' }))
  assert.deepEqual(snapshot([a, b]), before)
  return { initiallyEnabled: true, disabledAfterRecompute: true, mutation: false }
})

// 38. Idempotency replay and a changed payload are both checked against the same committed key.
await run(38, 'retry همان payload بازپخش و payload متفاوت با همان کلید رد می‌شود', async () => {
  const a = variant('38-source', 1_000_000), b = variant('38-r1', 950_000), c = variant('38-r2', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements: [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }],
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0,
    requestIdempotencyKey: 'dp20r9-38-idempotency-0001' }
  const first = await salesService.createExchange(input), beforeReplay = snapshot([a, b, c])
  const replay = await salesService.createExchange(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.returnId, first.returnId)
  assert.deepEqual(snapshot([a, b, c]), beforeReplay)
  await assert.rejects(() => salesService.createExchange({ ...input, replacements: [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }] }))
  assert.deepEqual(snapshot([a, b, c]), beforeReplay)
  return { samePayloadReplay: true, changedPayloadRejected: true, duplicateMutation: false }
})

// 39. Full credit-tender refund must restore its original source credit; cash/card outputs remain zero.
await run(39, 'بازگرداندن کامل اعتبار مبدأ؛ refund نقدی/POS یا اعتبار پولی تازه ساخته نمی‌شود', async () => {
  const a = variant('39-source', 1_000_000), b = variant('39-r', 700_000)
  const credit = await issueCredit(800_000, null, '39 all-credit')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.sourceCreditRestoration), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '39' })
  assert.equal(n(x.sourceCreditRestoredAmount), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.cardRefunded), 0)
  assert.equal(n(x.newStoreCreditAmount), 0)
  return { restoredToOriginalBarcode: 100_000, cashRefund: 0, cardRefund: 0, newlyIssuedMoneyCredit: 0 }
})

// 40. Void creates immutable VOID events and a subsequent same-source exchange gets no historic transfer.
await run(40, 'void نهایی؛ پنجرهٔ تخفیف احیا نمی‌شود و مراجعهٔ بعدی انتقال نمی‌گیرد', async () => {
  const a = variant('40-source', 1_000_000), b = variant('40-first', 950_000), c = variant('40-second', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '40a' })
  await salesService.returnDelete({ id: first.returnId, userId, reason: 'round9 isolated void', panelPassword: DEFAULT_MANAGER_PASSWORD })
  const voids = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
  assert.ok(voids.length > 0)
  assert.ok(voids.every(row => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const lines2 = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements2 = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p2 = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: lines2, replacements: replacements2, discountTransferOption: 'YES_ZERO' })
  assert.equal(p2.ok, true, p2.error)
  assert.equal(p2.discountTransfer, undefined)
  const second = await salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: lines2, replacements: replacements2,
    expectedSettlementDiff: n(p2.effectiveDiff), requestIdempotencyKey: 'dp20r9-40-after-void-0001' })
  assert.equal(n(second.discountTransferAmount), 0)
  return { voidEvidence: voids.length, laterTransfer: 0, oldDiscountWindowRestored: false }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 9 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/40 PASS; ${failed.length}/40 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
