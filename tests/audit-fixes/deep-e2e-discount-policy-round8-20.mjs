import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round8-20-'))
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
const userId = seed.user('discount-policy-round8 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 8', number: 68820, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R8-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R8-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let seq = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R8-${++seq}-${label}`, seed.category(`DP20R8-cat-${seq}`))
  const id = seed.variant(product, `DP20R8-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function snapshot(ids = []) {
  return { invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), redemptions: seed.count('StoreCreditRedemption'), events: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), cardRequests: seed.count('CardTransferRequest'), stocks: ids.map(stockOf) }
}
async function issueCredit(amount, restrictVariantIds = null, note = 'round8') {
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
    if (remainder < 0) throw new Error('credit amount exceeds net sale total')
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
    requestIdempotencyKey: key ?? `dp20r8-${label}-0001` }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `round8 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
  }
  return salesService.createExchange(input)
}
async function formulaCase({ id, N = 800_000, d = 200_000, R, option, protect = true, refundMode = 'CASH', t }) {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: protect })
  const a = variant(`${id}-source`, N + d), b = variant(`${id}-replacement`, R)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: N + d, discount: d }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: R, discount: 0 }]
  const p = await preview(s.id, lines, replacements, option)
  const delta = R - N
  const oracleT = option === 'NO' ? 0 : option === 'YES' ? Math.min(d, R) : delta > 0 ? Math.min(d, R, delta) : 0
  assert.equal(oracleT, t)
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
  return { N, d, R, delta, capacity: R, transfer: t, postTransferReplacement: R - t, diff }
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

// 01–04. Independently calculate all three transfer choices for the same simple source basis.
await run(1, 'NO؛ تخفیف تاریخی منتقل نمی‌شود و مبلغ خام Δ تسویه می‌شود', () => formulaCase({ id: '01', R: 950_000, option: 'NO', t: 0 }))
await run(2, 'YES_ZERO؛ فقط min(d,c,Δ) از مثال مرجع منتقل می‌شود', () => formulaCase({ id: '02', R: 950_000, option: 'YES_ZERO', t: 150_000 }))
await run(3, 'YES؛ تخفیف تاریخی کامل در ظرفیت جایگزین جا می‌شود', () => formulaCase({ id: '03', R: 950_000, option: 'YES', protect: false, refundMode: 'STORE_CREDIT', t: 200_000 }))
await run(4, 'YES_ZERO و Δ منفی؛ انتقال صفر و بازپرداخت فقط از وجه واقعی', () => formulaCase({ id: '04', R: 799_999, option: 'YES_ZERO', t: 0 }))

// 05. Explicit current replacement discount plus historical transfer are separately visible in child line discount.
await run(5, 'تخفیف جاری replacement و انتقال تاریخی؛ جمع دو جزء در قلم فرزند دقیق است', async () => {
  const a = variant('05-source', 1_000_000), b = variant('05-r', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 50_000 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '05' })
  const child = seed.one('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(n(child.discount), 200_000, '50k current + 150k transferred')
  assert.equal(n(child.lineTotal), 800_000)
  return { currentDiscount: 50_000, historicalTransfer: 150_000, childDiscount: 200_000 }
})

// 06. Replacement invoice discount is counted in R before policy delta and transfer.
await run(6, 'تخفیف فاکتور جایگزین داخل R؛ transfer و invoice total جدا تطبیق می‌شوند', async () => {
  const a = variant('06-source', 1_000_000), b = variant('06-r', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO', 100_000)
  assert.equal(n(p.discountTransfer.capacity), 900_000)
  assert.equal(n(p.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '06', invoiceDiscount: 100_000 })
  assert.equal(n(x.exchangeTotal), 800_000)
  assert.equal(n(x.diff), 0)
  assert.equal(n(seed.one('SELECT discountTotal FROM "SaleInvoice" WHERE id=?', x.exchangeInvoiceId).discountTotal), 200_000)
  return { R: 900_000, invoiceDiscount: 100_000, transfer: 100_000, childDiscountTotal: 200_000 }
})

// 07. Partial return from a quantity line: discount window uses only the selected unit.
await run(7, 'برگشت یک واحد از qty=۴؛ تخفیف و مبلغ برگشت سهم همان واحد است', async () => {
  const a = variant('07-source', 1_000_000), b = variant('07-r', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 4, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 950_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 50_000)
  assert.equal(n(p.discountTransfer.policyDelta), 50_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 50_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '07' })
  assert.equal(n(x.discountTransferAmount), 50_000)
  return { sourceQty: 4, returnedQty: 1, N: 950_000, windowDiscount: 50_000, transfer: 50_000 }
})

// 08. Two separate visits: first NO expires one unit's window; second YES_ZERO consumes only the untouched unit.
await run(8, 'دو مراجعه؛ NO سهم واحد اول را مصرف می‌کند و YES_ZERO فقط واحد باقی‌مانده را می‌بیند', async () => {
  const a = variant('08-source', 1_000_000), b = variant('08-r1', 900_000), c = variant('08-r2', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 2, unitPrice: 1_000_000, discount: 200_000 }] })
  const item = s.items[0]
  const l1 = [{ saleItemId: n(item.id), qty: 1 }], r1 = [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p1 = await preview(s.id, l1, r1, 'NO')
  const x1 = await exchange({ invoiceId: s.id, lines: l1, replacements: r1, option: 'NO', p: p1, label: '08a' })
  const l2 = [{ saleItemId: n(item.id), qty: 1 }], r2 = [{ variantId: c, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p2 = await preview(s.id, l2, r2, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 100_000)
  const x2 = await exchange({ invoiceId: s.id, lines: l2, replacements: r2, option: 'YES_ZERO', p: p2, label: '08b' })
  const firstExpired = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x1.returnId, 'EXPIRE')
  const secondMoved = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x2.returnId, 'TRANSFER')
  assert.equal(firstExpired.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  assert.equal(secondMoved.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  return { firstExpired: 100_000, secondVisitAvailable: 100_000, secondTransfer: 100_000 }
})

// 09. Four unequally priced lines with invoice discount; preview-derived per-line shares sum exactly to the invoice discount.
await run(9, 'چهار قلم نامساوی؛ سهم‌بندی invoice discount و برگشت کامل حفظ می‌شود', async () => {
  const prices = [100_003, 200_005, 300_007, 400_009]
  const ids = prices.map((price, i) => variant(`09-src${i}`, price))
  const s = await sale({ lines: ids.map((id, i) => ({ variantId: id, qty: 1, unitPrice: prices[i], discount: 0 })), invoiceDiscount: 50_000 })
  const perItem = []
  for (let i = 0; i < s.items.length; i++) {
    const item = s.items[i]
    const probe = await preview(s.id, [{ saleItemId: n(item.id), qty: 1 }], [{ variantId: ids[i], qty: 1, unitPrice: prices[i], discount: 0 }], 'NO')
    const net = n(probe.returnTotal)
    perItem.push({ item, net, discountShare: prices[i] - net })
  }
  assert.equal(perItem.reduce((sum, row) => sum + row.discountShare, 0), 50_000)
  const replacements = perItem.map((row, i) => {
    const id = variant(`09-r${i}`, row.net)
    return { variantId: id, qty: 1, unitPrice: row.net, discount: 0 }
  })
  const lines = perItem.map(row => ({ saleItemId: n(row.item.id), qty: 1 }))
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.returnTotal), s.total)
  assert.equal(n(p.discountTransfer.historicalDiscount), 50_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '09' })
  assert.equal(n(x.diff), 0)
  const events = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'EXPIRE')
  assert.equal(events.reduce((sum, row) => sum + n(row.amount), 0), 50_000)
  return { invoiceDiscount: 50_000, perItemShares: perItem.map(row => row.discountShare), expiry: 50_000 }
})

// 10. One source window is split over three replacement rows with unequal capacities.
await run(10, 'تخصیص انتقال بین جایگزین‌های نامساوی؛ مجموع و ظرفیت هر ردیف کنترل می‌شود', async () => {
  const a = variant('10-source', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const prices = [200_000, 300_000, 500_000]
  const replacements = prices.map((price, i) => ({ variantId: variant(`10-r${i}`, price), qty: 1, unitPrice: price, discount: 0 }))
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 800_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.discountTransfer.policyDelta), 200_000)
  assert.equal(p.replacementTransferShares.reduce((sum, amount) => sum + n(amount), 0), 200_000)
  assert.ok(p.replacementTransferShares.every((amount, i) => n(amount) <= prices[i]))
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '10' })
  const child = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(child.reduce((sum, row) => sum + n(row.discount), 0), 200_000)
  assert.equal(child.reduce((sum, row) => sum + n(row.lineTotal), 0), 800_000)
  return { capacities: prices, allocatedShares: p.replacementTransferShares, childTotal: 800_000 }
})

// 11. Mixed source discount layers on two rows; return only one row and verify the selected row's allocation.
await run(11, 'مبدأ دو‌ردیفی با تخفیف‌های ترکیبی؛ برگشت یک ردیف تخفیف نامرتبط را نمی‌کشد', async () => {
  const a = variant('11-a', 1_000_000), b = variant('11-b', 1_000_000), r = variant('11-r', 1_000_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }
  ], invoiceDiscount: 100_000 })
  const selected = s.items.find(item => n(item.variantId) === a)
  const lines = [{ saleItemId: n(selected.id), qty: 1 }], replacements = [{ variantId: r, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 852_632)
  assert.equal(n(p.discountTransfer.historicalDiscount), 147_368, '100k invoice discount is allocated over 900k/1m weighted rows')
  assert.equal(n(p.discountTransfer.policyDelta), 147_368)
  assert.equal(n(p.discountTransfer.selectedAmount), 147_368)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '11' })
  const transfers = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.equal(transfers.reduce((sum, row) => sum + n(row.amount), 0), 147_368)
  assert.ok(transfers.every(row => n(row.sourceSaleItemId) === n(selected.id)))
  return { selectedRowLineDiscount: 100_000, allocatedInvoiceShare: 47_368, transfer: 147_368 }
})

// 12. Three generations consume a historic transfer once and keep the new current discount distinct.
await run(12, 'زنجیرهٔ سه‌نسلی؛ مصرف انتقال تاریخی و تخفیف جاری جدید هر نسل دقیق است', async () => {
  const a = variant('12-root', 1_000_000), b = variant('12-child1', 1_000_000), c = variant('12-child2', 850_000), d = variant('12-child3', 800_000)
  const root = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const l1 = [{ saleItemId: n(root.items[0].id), qty: 1 }], r1 = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 50_000 }]
  const p1 = await preview(root.id, l1, r1, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.selectedAmount), 150_000)
  const x1 = await exchange({ invoiceId: root.id, lines: l1, replacements: r1, option: 'YES_ZERO', p: p1, label: '12a' })
  const i1 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', x1.exchangeInvoiceId)
  assert.equal(n(i1.discount), 200_000)
  const l2 = [{ saleItemId: n(i1.id), qty: 1 }], r2 = [{ variantId: c, qty: 1, unitPrice: 850_000, discount: 0 }]
  const p2 = await preview(x1.exchangeInvoiceId, l2, r2, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 50_000)
  assert.equal(n(p2.discountTransfer.policyDelta), 50_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 50_000)
  const x2 = await exchange({ invoiceId: x1.exchangeInvoiceId, lines: l2, replacements: r2, option: 'YES_ZERO', p: p2, label: '12b' })
  const i2 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', x2.exchangeInvoiceId)
  assert.equal(n(i2.discount), 50_000)
  const l3 = [{ saleItemId: n(i2.id), qty: 1 }], r3 = [{ variantId: d, qty: 1, unitPrice: 800_000, discount: 0 }]
  const p3 = await salesService.previewExchangeFunding({ invoiceId: x2.exchangeInvoiceId, lines: l3, replacements: r3, discountTransferOption: 'YES_ZERO' })
  assert.equal(p3.ok, true, p3.error)
  assert.equal(p3.discountTransfer, undefined, 'the child discount was transferred in generation two, so no new history remains')
  const x3 = await salesService.createExchange({ userId, shiftId, invoiceId: x2.exchangeInvoiceId, lines: l3, replacements: r3,
    expectedSettlementDiff: n(p3.effectiveDiff), requestIdempotencyKey: 'dp20r8-12c-0001' })
  assert.equal(n(x3.discountTransferAmount), 0)
  return { transferGeneration1: 150_000, currentDiscountGeneration1: 50_000, transferGeneration2: 50_000, generation3Transfer: 0 }
})

// 13. Full store-credit source: positive settlement after policy transfer is cash-only for the residual.
await run(13, 'اعتبار کامل در مبدأ؛ وصول نقدی فقط به‌اندازهٔ باقیماندهٔ پس از انتقال', async () => {
  const a = variant('13-source', 1_000_000), b = variant('13-r', 1_100_000)
  const credit = await issueCredit(800_000, null, '13 full source')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '13' })
  assert.equal(n(x.cashReceived), 100_000)
  assert.equal(n(x.discountTransferAmount), 200_000)
  return { storeCreditSource: 800_000, transferred: 200_000, cashCollected: 100_000 }
})

// 14. Credit-only source with a cheaper replacement restores unused source credit, not cash or new money credit.
await run(14, 'اعتبار کامل و جایگزین ارزان‌تر؛ مانده به همان اعتبار مبدأ برمی‌گردد', async () => {
  const a = variant('14-source', 1_000_000), b = variant('14-r', 700_000)
  const credit = await issueCredit(800_000, null, '14 full source')
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], credit })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  assert.equal(n(p.sourceCreditRestoration), 100_000)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '14' })
  assert.equal(n(x.sourceCreditRestoredAmount), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.newStoreCreditAmount), 0)
  return { sourceCreditRestored: 100_000, physicalRefund: 0, newCredit: 0 }
})

// 15. Tax/service are present on the returned source but remain outside merchandise delta.
await run(15, 'تسویهٔ همراه مالیات و حق‌سرویس؛ Δ فقط خالص کالا را می‌سنجد', async () => {
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
  return { actualReturnWithCharges: 930_000, policyDeltaMerchandiseOnly: 150_000, transfer: 150_000, cashRefund: 130_000 }
})

// 16. POS refund route requires manager override and never emits a cash drawer movement.
await run(16, 'بازپرداخت اختلاف به POS؛ تأیید مدیر و صفر بودن خروج صندوق', async () => {
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

// 17. Card-to-card is only a pending request in the isolated test; no bank transfer is performed.
await run(17, 'کارت‌به‌کارت مدیر؛ درخواست در انتظار، بدون پرداخت واقعی', async () => {
  const a = variant('17-source', 1_000_000), b = variant('17-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '17', refundMode: 'CARD_TO_CARD' })
  const req = seed.one('SELECT amount,status FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(req.amount), 100_000)
  assert.match(String(req.status).toUpperCase(), /PENDING|WAIT/)
  assert.equal(n(x.cashRefunded) + n(x.cardRefunded), 0)
  return { pendingRequest: n(req.amount), status: req.status, actualTransfer: false }
})

// 18. Missing method and excessive payout both reject without any partial write.
await run(18, 'روش تسویهٔ خالی و مبلغ بیش‌ازحد؛ دو رد اتمیک روی همان منبع', async () => {
  const a = variant('18-source', 1_000_000), b = variant('18-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines, replacements,
    discountTransferOption: 'NO', expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff),
    exchangeSettlementDecision: 'UNSELECTED', requestIdempotencyKey: 'dp20r8-18-no-method-0001' }), /فروشنده روش را انتخاب نکرده/)
  assert.deepEqual(snapshot([a, b]), before)
  await assert.rejects(() => exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '18-high', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(snapshot([a, b]), before)
  return { available: 100_000, methodUnselectedRejected: true, excessiveRejected: true, mutation: false }
})

// 19. Same idempotency key and exact payload returns the original ids without duplicate financial rows.
await run(19, 'بازپخش idempotent؛ شناسه‌ها و تعداد رکوردها ثابت می‌مانند', async () => {
  const a = variant('19-source', 1_000_000), b = variant('19-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES_ZERO',
    expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r8-19-replay-0001' }
  const first = await salesService.createExchange(input), before = snapshot([a, b])
  const retry = await salesService.createExchange(input)
  assert.equal(retry.replayed, true)
  assert.equal(retry.returnId, first.returnId)
  assert.equal(retry.exchangeInvoiceId, first.exchangeInvoiceId)
  assert.deepEqual(snapshot([a, b]), before)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { returnId: n(first.returnId), childInvoiceId: n(first.exchangeInvoiceId), replayed: true }
})

// 20. Void permanently consumes the prior history; later valid exchange has no transfer panel.
await run(20, 'void؛ رویداد حفظ می‌شود و مراجعهٔ بعدی انتقال تاریخی نمی‌گیرد', async () => {
  const a = variant('20-source', 1_000_000), b = variant('20-r1', 950_000), c = variant('20-r2', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '20a' })
  await salesService.returnDelete({ id: first.returnId, userId, reason: 'round8 isolated void', panelPassword: DEFAULT_MANAGER_PASSWORD })
  const voidEvents = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
  assert.ok(voidEvents.length > 0)
  assert.ok(voidEvents.every(row => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const lines2 = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements2 = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p2 = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: lines2, replacements: replacements2, discountTransferOption: 'YES_ZERO' })
  assert.equal(p2.ok, true, p2.error)
  assert.equal(p2.discountTransfer, undefined)
  const second = await salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: lines2, replacements: replacements2,
    expectedSettlementDiff: n(p2.effectiveDiff), requestIdempotencyKey: 'dp20r8-20-post-void-0001' })
  assert.equal(n(second.discountTransferAmount), 0)
  return { voidEvidence: voidEvents.length, laterTransfer: 0, historyRestored: false }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 8 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
