import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round5-20-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = value => Number(value ?? 0)
const userId = seed.user('discount-policy-round5 cashier')
const shiftId = seed.insert('Shift', { name: 'discount policy round 5', number: 68520, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashId = seed.insert('PaymentMethod', { key: 'DP20-R5-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardId = seed.insert('PaymentMethod', { key: 'DP20-R5-CARD', label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let sequence = 0
function variant(label, price, stock = 100) {
  const product = seed.product(`DP20R5-${++sequence}-${label}`, seed.category(`DP20R5-cat-${sequence}`))
  const id = seed.variant(product, `DP20R5-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function state(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    credits: seed.count('StoreCredit'), transferEvents: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), cardRequests: seed.count('CardTransferRequest'),
    stocks: ids.map(stockOf)
  }
}
async function sale({ lines, invoiceDiscount = 0, tender = 'CASH' }) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.qty - line.discount, 0) - invoiceDiscount
  let payments
  if (tender === 'CASH') payments = [{ methodId: cashId, amount: total, destination: 'CASH' }]
  else if (tender === 'CARD') payments = [{ methodId: cardId, amount: total, destination: 'CARD' }]
  else if (tender === 'MIXED') {
    const cash = Math.floor(total / 2)
    payments = [{ methodId: cashId, amount: cash, destination: 'CASH' }, { methodId: cardId, amount: total - cash, destination: 'CARD' }]
  } else throw new Error(`Unknown tender ${tender}`)
  const created = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: lines.map(line => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { id: n(created.id), items, total }
}
async function preview(invoiceId, lines, replacements, option, invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option })
  assert.equal(p.ok, true, p.error)
  return p
}
async function exchange({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0, refundMode = 'CASH', refundAmount, key }) {
  const input = {
    userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    discountTransferOption: p.discountTransfer ? option : undefined,
    expectedDiscountTransferAmount: n(p.discountTransfer?.selectedAmount),
    expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: key ?? `dp20r5-${label}-0001`
  }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD') input.cardPosOverride = {
      acknowledgedNoReverse: true, reason: `round5 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD
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

// 01. Invoice-discount rounding is conserved across unequal line values and separate exchanges.
await run(1, 'تخفیف فاکتوری باقیمانده‌دار؛ مجموع سهم سه قلم در سه تعویض حفظ می‌شود', async () => {
  const sourceIds = [variant('01-a', 100_003), variant('01-b', 200_005), variant('01-c', 300_007)]
  const s = await sale({ lines: sourceIds.map(id => ({ variantId: id, qty: 1, unitPrice: n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?', id).salePrice), discount: 0 })), invoiceDiscount: 59_900 })
  const shares = []
  for (let i = 0; i < s.items.length; i++) {
    const item = s.items[i]
    const rawPrice = n(item.unitPrice)
    const lines = [{ saleItemId: n(item.id), qty: 1 }]
    const provisional = await preview(s.id, lines, [{ variantId: sourceIds[i], qty: 1, unitPrice: rawPrice, discount: 0 }], 'NO')
    const net = n(provisional.returnTotal)
    const historicalShare = rawPrice - net
    assert.equal(n(provisional.discountTransfer.historicalDiscount), historicalShare)
    shares.push({ net, historicalShare })
    const replacementId = variant(`01-r${i}`, net)
    const replacements = [{ variantId: replacementId, qty: 1, unitPrice: net, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'NO')
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: `01-${i}` })
    assert.equal(n(x.diff), 0)
  }
  assert.equal(shares.reduce((sum, row) => sum + row.historicalShare, 0), 59_900)
  const expires = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE eventType=?', 'EXPIRE')
  assert.equal(expires.reduce((sum, row) => sum + n(row.amount), 0), 59_900)
  return { invoiceDiscount: 59_900, roundedShares: shares.map(row => row.historicalShare), expiryTotal: 59_900 }
})

// 02. Four visits to the same discounted quantity line use disjoint unit discount windows.
await run(2, 'چهار مراجعه روی qty=۴؛ NO، YES_ZERO و YES پنجره‌های مستقل دارند', async () => {
  const a = variant('02-source', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 4, unitPrice: 1_000_000, discount: 100_000 }] })
  const sourceItem = s.items[0]
  const results = []
  const options = ['NO', 'YES_ZERO', 'YES', 'NO']
  for (let i = 0; i < options.length; i++) {
    const replacementId = variant(`02-r${i}`, 1_000_000)
    const lines = [{ saleItemId: n(sourceItem.id), qty: 1 }]
    const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 1_000_000, discount: 0 }]
    const p = await preview(s.id, lines, replacements, options[i])
    assert.equal(n(p.discountTransfer.historicalDiscount), 25_000)
    const expected = options[i] === 'NO' ? 0 : 25_000
    assert.equal(n(p.discountTransfer.selectedAmount), expected)
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: options[i], p, label: `02-${i}` })
    results.push(x.returnId)
  }
  const events = seed.rows(`SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId IN (${results.map(() => '?').join(',')})`, ...results)
  assert.equal(events.filter(e => e.eventType === 'TRANSFER').reduce((s, e) => s + n(e.amount), 0), 50_000)
  assert.equal(events.filter(e => e.eventType === 'EXPIRE').reduce((s, e) => s + n(e.amount), 0), 50_000)
  return { visits: 4, transferred: 50_000, expired: 50_000 }
})

// 03. Current discount on the first replacement remains available after the transferred share is consumed.
await run(3, 'زنجیرهٔ دو‌نسلی؛ تخفیف جاری فرزند پس از مصرف انتقال تاریخی قابل‌ردیابی است', async () => {
  const a = variant('03-root', 1_000_000), b = variant('03-child1', 1_000_000), c = variant('03-child2', 900_000)
  const root = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const rootLines = [{ saleItemId: n(root.items[0].id), qty: 1 }]
  const child1Replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 100_000 }]
  const p1 = await preview(root.id, rootLines, child1Replacements, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.selectedAmount), 100_000)
  const first = await exchange({ invoiceId: root.id, lines: rootLines, replacements: child1Replacements, option: 'YES_ZERO', p: p1, label: '03a' })
  const child1 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
  assert.equal(n(child1.discount), 200_000)
  const childLines = [{ saleItemId: n(child1.id), qty: 1 }]
  const child2Replacements = [{ variantId: c, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p2 = await preview(first.exchangeInvoiceId, childLines, child2Replacements, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 100_000)
  const second = await exchange({ invoiceId: first.exchangeInvoiceId, lines: childLines, replacements: child2Replacements, option: 'YES_ZERO', p: p2, label: '03b' })
  assert.equal(n(second.discountTransferAmount), 100_000)
  return { child1Discount: 200_000, consumedHistorical: 100_000, newTransferFromCurrent: 100_000 }
})

// 04. Switching from NO to a later YES cannot reuse a source discount window already expired.
await run(4, 'تخفیف منقضی‌شده با NO؛ مراجعهٔ بعدی نمی‌تواند آن را احیا کند', async () => {
  const a = variant('04-source', 1_000_000), b = variant('04-r1', 950_000), c = variant('04-r2', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 2, unitPrice: 1_000_000, discount: 200_000 }] })
  const item = s.items[0]
  const firstLines = [{ saleItemId: n(item.id), qty: 1 }]
  const firstReplacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p1 = await preview(s.id, firstLines, firstReplacements, 'NO')
  const first = await exchange({ invoiceId: s.id, lines: firstLines, replacements: firstReplacements, option: 'NO', p: p1, label: '04a' })
  const secondLines = [{ saleItemId: n(item.id), qty: 1 }]
  const secondReplacements = [{ variantId: c, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p2 = await preview(s.id, secondLines, secondReplacements, 'YES')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 100_000)
  const second = await exchange({ invoiceId: s.id, lines: secondLines, replacements: secondReplacements, option: 'YES', p: p2, label: '04b' })
  const firstExpire = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'EXPIRE')
  const secondTransfer = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', second.returnId, 'TRANSFER')
  assert.equal(firstExpire.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  assert.equal(secondTransfer.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  return { firstWindowExpired: 100_000, remainingWindowTransferred: 100_000 }
})

// 05. Three source items, one invoice discount, and reverse return order conserve discount rounding.
await run(5, 'ترتیب معکوس برگشت سه قلم؛ جمع تخفیف فاکتور و expiry ثابت می‌ماند', async () => {
  const prices = [300_001, 200_003, 100_007]
  const ids = prices.map((price, i) => variant(`05-src${i}`, price))
  const s = await sale({ lines: ids.map((id, i) => ({ variantId: id, qty: 1, unitPrice: prices[i], discount: 0 })), invoiceDiscount: 59_000 })
  const order = [...s.items].reverse()
  const expiryBefore = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE eventType=?', 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0)
  let expiredExpected = 0
  for (let i = 0; i < order.length; i++) {
    const item = order[i]
    const sourcePrice = n(item.unitPrice)
    const first = await preview(s.id, [{ saleItemId: n(item.id), qty: 1 }], [{ variantId: ids[prices.length - 1 - i], qty: 1, unitPrice: sourcePrice, discount: 0 }], 'NO')
    const net = n(first.returnTotal)
    expiredExpected += sourcePrice - net
    const replacement = variant(`05-r${i}`, net)
    const lines = [{ saleItemId: n(item.id), qty: 1 }], replacements = [{ variantId: replacement, qty: 1, unitPrice: net, discount: 0 }]
    const p = await preview(s.id, lines, replacements, 'NO')
    const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: `05-${i}` })
    assert.equal(n(x.diff), 0)
  }
  assert.equal(expiredExpected, 59_000)
  const expiredActual = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE eventType=?', 'EXPIRE').reduce((sum, row) => sum + n(row.amount), 0)
  assert.equal(expiredActual - expiryBefore, 59_000)
  return { returnedInReverseOrder: true, invoiceDiscount: 59_000, newExpiryEvents: expiredActual - expiryBefore }
})

// 06. One source line carries both direct and invoice-level discount; transfer cannot exceed total source history.
await run(6, 'دو لایهٔ تخفیف روی قلم مبدأ؛ سقف انتقال برابر تخفیف تاریخی کل است', async () => {
  const a = variant('06-source', 1_000_000), b = variant('06-r', 1_100_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.ok(n(p.discountTransfer.selectedAmount) <= n(p.discountTransfer.historicalDiscount))
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '06' })
  assert.equal(n(x.discountTransferAmount), 200_000)
  assert.equal(n(x.diff), 100_000)
  return { lineDiscount: 100_000, invoiceDiscount: 100_000, transfer: 200_000, collected: 100_000 }
})

// 07. Distinct source windows can feed separate replacement rows and preserve source-item attribution.
await run(7, 'دو مبدأ و دو جایگزین؛ attribution هر پنجره و جمع سهم جایگزین‌ها دقیق است', async () => {
  const a = variant('07-a', 1_000_000), b = variant('07-b', 1_000_000), r1 = variant('07-r1', 1_000_000), r2 = variant('07-r2', 900_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 200_000 }
  ] })
  const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
  const replacements = [
    { variantId: r1, qty: 1, unitPrice: 1_000_000, discount: 0 },
    { variantId: r2, qty: 1, unitPrice: 900_000, discount: 0 }
  ]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.historicalDiscount), 300_000)
  assert.equal(n(p.discountTransfer.policyDelta), 200_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(p.replacementTransferShares.reduce((sum, amount) => sum + n(amount), 0), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '07' })
  const transferEvents = seed.rows('SELECT sourceSaleItemId,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.equal(transferEvents.reduce((sum, event) => sum + n(event.amount), 0), 200_000)
  assert.equal(new Set(transferEvents.map(event => n(event.sourceSaleItemId))).size, 2)
  return { sourceWindows: 2, transfer: 200_000, replacementShares: p.replacementTransferShares }
})

// 08. Guard-on YES is allowed when it does not turn a positive collection into a payout.
await run(8, 'محافظ روشن؛ YES مجاز است اگر بازپرداخت اضافه نسازد', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const a = variant('08-source', 1_000_000), b = variant('08-r', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find(row => row.option === 'YES').enabled, true)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '08' })
  assert.equal(n(x.discountTransferAmount), 200_000)
  assert.equal(n(x.diff), 0)
  return { guard: 'on', yesEnabled: true, transfer: 200_000, diff: 0 }
})

// 09. In the same case, a full-YES projection that causes a refund is disabled while YES_ZERO remains selectable.
await run(9, 'محافظ روشن؛ YES بازپرداخت‌زا مسدود اما YES_ZERO مجاز است', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const a = variant('09-source', 1_000_000), b = variant('09-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const yes = await preview(s.id, lines, replacements, 'YES')
  const zero = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(yes.discountTransfer.options.find(row => row.option === 'YES').enabled, false)
  assert.equal(zero.discountTransfer.options.find(row => row.option === 'YES_ZERO').enabled, true)
  assert.equal(n(zero.discountTransfer.selectedAmount), 150_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p: zero, label: '09' })
  assert.equal(n(x.diff), 0)
  return { yesEnabled: false, yesZeroEnabled: true, yesZeroTransfer: 150_000 }
})

// 10. Turn off the policy guard and confirm full YES remains bounded by historical discount.
await run(10, 'محافظ خاموش؛ YES تخفیف تاریخی موجود را منتقل می‌کند، نه بیشتر', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const a = variant('10-source', 1_000_000), b = variant('10-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES', p, label: '10', refundMode: 'STORE_CREDIT' })
  assert.equal(n(x.discountTransferAmount), 200_000)
  assert.equal(n(x.diff), -50_000)
  assert.equal(n(x.newStoreCreditAmount), 50_000)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { transfer: 200_000, sourceHistory: 200_000, refundCredit: 50_000 }
})

// 11. A card refund is kept distinct from cash movement and tied to a manager override.
await run(11, 'بازپرداخت POS در اختلاف منفی؛ تفکیک کامل از صندوق نقدی', async () => {
  const a = variant('11-source', 1_000_000), b = variant('11-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CARD' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const beforeCash = seed.count('CashMovement')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '11', refundMode: 'CARD' })
  assert.equal(n(x.cardRefunded), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('CashMovement'), beforeCash)
  return { cardRefund: 100_000, cashRefund: 0 }
})

// 12. Card-to-card is a pending manager request, not an executed bank transfer.
await run(12, 'کارت‌به‌کارت مدیر؛ درخواست در انتظار و بدون جابه‌جایی واقعی وجه', async () => {
  const a = variant('12-source', 1_000_000), b = variant('12-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '12', refundMode: 'CARD_TO_CARD' })
  const req = seed.one('SELECT amount,status FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(req.amount), 100_000)
  assert.match(String(req.status).toUpperCase(), /PENDING|WAIT/)
  assert.equal(n(x.cashRefunded) + n(x.cardRefunded), 0)
  return { requested: 100_000, status: req.status, actualTransfer: false }
})

// 13. Cash payout partial plus credit remainder should conserve the negative difference.
await run(13, 'بازپرداخت جزئی؛ جمع نقد و اعتبار برابر مابه‌التفاوت منفی است', async () => {
  const a = variant('13-source', 1_000_000), b = variant('13-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '13', refundMode: 'CASH', refundAmount: 40_000 })
  assert.equal(n(x.cashRefunded) + n(x.newStoreCreditAmount), 100_000)
  assert.equal(n(x.cashRefunded), 40_000)
  assert.equal(n(x.newStoreCreditAmount), 60_000)
  return { negativeDiff: 100_000, cash: 40_000, credit: 60_000 }
})

// 14. A full store-credit refund is separate from physical cash movement.
await run(14, 'بازپرداخت کامل به اعتبار؛ صندوق نقدی بدون خروج وجه', async () => {
  const a = variant('14-source', 1_000_000), b = variant('14-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const cashBefore = seed.count('CashMovement')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '14', refundMode: 'STORE_CREDIT' })
  assert.equal(n(x.newStoreCreditAmount), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('CashMovement'), cashBefore)
  return { newCredit: 100_000, physicalCashMovement: 0 }
})

// 15. No payout method is an explicit safe rejection for a real refund entitlement.
await run(15, 'نداشتن روش تسویه برای مازاد واقعی؛ رد امن و بدون mutation', async () => {
  const a = variant('15-source', 1_000_000), b = variant('15-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = state([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'NO',
    expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff),
    exchangeSettlementDecision: 'UNSELECTED', requestIdempotencyKey: 'dp20r5-15-unselected-0001'
  }), /فروشنده روش را انتخاب نکرده/)
  assert.deepEqual(state([a, b]), before)
  return { realMoneySurplus: 100_000, method: 'unselected', mutation: false }
})

// 16. Payout above the actual money-backed surplus is rejected without mutation.
await run(16, 'مبلغ بازپرداخت بالاتر از entitlement واقعی؛ رد mutation-free', async () => {
  const a = variant('16-source', 1_000_000), b = variant('16-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = state([a, b])
  await assert.rejects(() => exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '16', refundMode: 'CASH', refundAmount: 100_001 }))
  assert.deepEqual(state([a, b]), before)
  return { entitlement: 100_000, requested: 100_001, mutation: false }
})

// 17. Wrong POS acknowledgement must not get past the manager gate.
await run(17, 'رمز مدیر نادرست در بازپرداخت POS؛ سند تعویض ساخته نمی‌شود', async () => {
  const a = variant('17-source', 1_000_000), b = variant('17-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = state([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'NO',
    expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff), refundMode: 'CARD',
    exchangeSettlementDecision: 'METHOD', cardPosOverride: { acknowledgedNoReverse: true, reason: 'isolated bad password probe', managerPassword: 'not-a-valid-password' },
    requestIdempotencyKey: 'dp20r5-17-bad-card-manager-0001'
  }))
  assert.deepEqual(state([a, b]), before)
  return { incorrectManagerPassword: true, mutation: false }
})

// 18. Exact idempotent replay returns the original exchange and leaves ledgers untouched.
await run(18, 'بازپخش idempotent؛ return، رویداد تخفیف و stock تکرار نمی‌شوند', async () => {
  const a = variant('18-source', 1_000_000), b = variant('18-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const key = 'dp20r5-18-replay-0001'
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES_ZERO',
    expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0, requestIdempotencyKey: key }
  const first = await salesService.createExchange(input)
  const before = state([a, b])
  const replay = await salesService.createExchange(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.returnId, first.returnId)
  assert.deepEqual(state([a, b]), before)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { returnId: n(first.returnId), replay: true, duplicateLedger: false }
})

// 19. Same idempotency key with a changed replacement must fail without a second mutation.
await run(19, 'idempotency key با replacement متفاوت؛ تعارض بدون تعویض دوم', async () => {
  const a = variant('19-source', 1_000_000), b = variant('19-r1', 950_000), c = variant('19-r2', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const p = await preview(s.id, lines, [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }], 'YES_ZERO')
  const key = 'dp20r5-19-conflict-0001'
  const firstInput = { userId, shiftId, invoiceId: s.id, lines, replacements: [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 },
  ], discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0, requestIdempotencyKey: key }
  const first = await salesService.createExchange(firstInput)
  const before = state([a, b, c])
  await assert.rejects(() => salesService.createExchange({ ...firstInput, replacements: [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }] }))
  assert.deepEqual(state([a, b, c]), before)
  assert.equal(n(first.discountTransferAmount), n(p.discountTransfer.selectedAmount))
  return { changedPayloadRejected: true, secondMutation: false }
})

// 20. Void retains immutable evidence and a subsequent valid exchange cannot recycle the spent history.
await run(20, 'void؛ provenance حفظ می‌شود و تعویض بعدی تخفیف تاریخی را دوباره نمی‌گیرد', async () => {
  const a = variant('20-source', 1_000_000), b = variant('20-first-r', 950_000), c = variant('20-second-r', 950_000)
  const sourceStock = stockOf(a)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '20-first' })
  await salesService.returnDelete({ id: first.returnId, userId, reason: 'round5 isolated void', panelPassword: DEFAULT_MANAGER_PASSWORD })
  assert.equal(stockOf(a), sourceStock - 1)
  assert.equal(stockOf(b), 100)
  const voids = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
  assert.ok(voids.length > 0)
  assert.ok(voids.every(row => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const nextLines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const nextReplacements = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const next = await salesService.previewExchangeFunding({ invoiceId: s.id, lines: nextLines, replacements: nextReplacements, discountTransferOption: 'YES_ZERO' })
  assert.equal(next.ok, true, next.error)
  assert.equal(next.discountTransfer, undefined)
  const second = await salesService.createExchange({ userId, shiftId, invoiceId: s.id, lines: nextLines, replacements: nextReplacements,
    expectedSettlementDiff: n(next.effectiveDiff), requestIdempotencyKey: 'dp20r5-20-post-void-0001' })
  assert.equal(n(second.discountTransferAmount), 0)
  return { voidEvidenceRows: voids.length, laterTransfer: 0, oldWindowRestored: false }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 5 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
