import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round4-20-'))
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
const n = (value) => Number(value ?? 0)
const userId = seed.user('discount-policy-round4 cashier')
const shiftId = seed.insert('Shift', {
  name: 'discount policy round 4', number: 68420,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashId = seed.insert('PaymentMethod', {
  key: 'DP20-R4-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardId = seed.insert('PaymentMethod', {
  key: 'DP20-R4-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2
})
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let sequence = 0
function makeVariant(label, price, stock = 100) {
  const product = seed.product(`DP20R4-${++sequence}-${label}`, seed.category(`DP20R4-cat-${sequence}`))
  const id = seed.variant(product, `DP20R4-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function stockOf(id) { return n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock) }
function snapshot(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    storeCredits: seed.count('StoreCredit'), transferEvents: seed.count('DiscountTransferEvent'),
    cashMovements: seed.count('CashMovement'), cardRequests: seed.count('CardTransferRequest'),
    stocks: ids.map(stockOf)
  }
}
async function sale({ lines, invoiceDiscount = 0, tender = 'CASH' }) {
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
  } else throw new Error(`unsupported sale tender ${tender}`)
  const created = await salesService.create({ debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },  userId, shiftId, lines: lines.map(line => ({ ...line, tax: line.tax ?? 0 })), invoiceDiscount, payments })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { id: n(created.id), items, total }
}
async function preview(invoiceId, lines, replacements, option, invoiceDiscount = 0) {
  const p = await salesService.previewExchangeFunding({ invoiceId, lines, replacements, invoiceDiscount, discountTransferOption: option })
  assert.equal(p.ok, true, p.error)
  return p
}
async function exchange({ invoiceId, lines, replacements, option, p, label, invoiceDiscount = 0,
  refundMode = 'CASH', refundAmount, idempotencyKey, cardOverride = true }) {
  const input = {
    userId, shiftId, invoiceId, lines, replacements, invoiceDiscount,
    discountTransferOption: p.discountTransfer ? option : undefined,
    expectedDiscountTransferAmount: n(p.discountTransfer?.selectedAmount),
    expectedSettlementDiff: n(p.effectiveDiff),
    requestIdempotencyKey: idempotencyKey ?? `dp20r4-${label}-0001`
  }
  if (n(p.effectiveDiff) > 0) input.methodId = cashId
  if (n(p.effectiveDiff) < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
    if (refundAmount != null) input.refundAmount = refundAmount
    if (refundMode === 'CARD' && cardOverride) {
      input.cardPosOverride = { acknowledgedNoReverse: true, reason: `round4 isolated ${label} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    }
  }
  return salesService.createExchange(input)
}
const outcomes = []
async function run(id, title, body) {
  try {
    const detail = await body()
    outcomes.push({ id, title, status: 'PASS', detail: detail ?? null })
    console.log(`PASS ${String(id).padStart(2, '0')}/20 — ${title}`)
  } catch (error) {
    outcomes.push({ id, title, status: 'FAIL', detail: String(error?.stack ?? error) })
    console.error(`FAIL ${String(id).padStart(2, '0')}/20 — ${title}\n${String(error?.stack ?? error)}`)
  }
}

// 01. YES_ZERO at one rial below the historic discount.
await run(1, 'مرز صحیحی Δ=d−۱؛ انتقال دقیقاً d−۱ می‌شود', async () => {
  const a = makeVariant('01-source', 1_000_000), b = makeVariant('01-replacement', 999_999)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 999_999, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 199_999)
  assert.equal(n(p.discountTransfer.selectedAmount), 199_999)
  assert.equal(n(p.effectiveDiff), 0)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '01' })
  assert.equal(n(x.discountTransferAmount), 199_999)
  return { delta: 199_999, transfer: 199_999, diff: 0 }
})

// 02. YES_ZERO at exact equality d=200,000.
await run(2, 'مرز صحیحی Δ=d؛ YES_ZERO تمام d را منتقل می‌کند', async () => {
  const a = makeVariant('02-source', 1_000_000), b = makeVariant('02-replacement', 1_000_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 200_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '02' })
  assert.equal(n(x.exchangeTotal), 800_000)
  assert.equal(n(x.diff), 0)
  return { delta: 200_000, transfer: 200_000 }
})

// 03. YES_ZERO one rial above historic discount transfers only d.
await run(3, 'مرز صحیحی Δ=d+۱؛ انتقال از d فراتر نمی‌رود', async () => {
  const a = makeVariant('03-source', 1_000_000), b = makeVariant('03-replacement', 1_000_001)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_000_001, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 200_001)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 1)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '03' })
  assert.equal(n(x.diff), 1)
  assert.equal(n(x.cashReceived), 1)
  return { delta: 200_001, transfer: 200_000, collected: 1 }
})

// 04. Preview all three choices against the same source without mutating between projections.
await run(4, 'مقایسهٔ NO/YES_ZERO/YES روی یک منبع واحد پیش از ثبت', async () => {
  const a = makeVariant('04-source', 1_000_000), b = makeVariant('04-replacement', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const returnsBefore = seed.count('SaleReturn')
  const no = await preview(s.id, lines, replacements, 'NO')
  const zero = await preview(s.id, lines, replacements, 'YES_ZERO')
  const yes = await preview(s.id, lines, replacements, 'YES')
  assert.equal(n(no.discountTransfer.selectedAmount), 0)
  assert.equal(n(zero.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(yes.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(no.effectiveDiff), 150_000)
  assert.equal(n(zero.effectiveDiff), 0)
  assert.equal(n(yes.effectiveDiff), -50_000)
  assert.equal(seed.count('SaleReturn'), returnsBefore, 'read-only option projections create no new return')
  return { NO: 0, YES_ZERO: 150_000, YES: 200_000, mutation: false }
})

// 05. Duplicate replacement rows for one SKU must aggregate exactly in the child invoice.
await run(5, 'یک SKU جایگزین در دو ردیف؛ جمع تخفیف انتقالی و سند فرزند تطبیق دارد', async () => {
  const a = makeVariant('05-source', 1_000_000), b = makeVariant('05-replacement', 500_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const replacements = [
    { variantId: b, qty: 1, unitPrice: 500_000, discount: 0 },
    { variantId: b, qty: 1, unitPrice: 500_000, discount: 0 }
  ]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '05' })
  const children = seed.rows('SELECT variantId,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', x.exchangeInvoiceId)
  assert.equal(children.length, 2)
  assert.equal(children.reduce((sum, row) => sum + n(row.discount), 0), 200_000)
  assert.equal(children.reduce((sum, row) => sum + n(row.lineTotal), 0), 800_000)
  return { duplicateRows: 2, transfer: 200_000, childNet: 800_000 }
})

// 06. Unequal source discounts: return only the low-discount source line and preserve its provenance.
await run(6, 'دو قلم با تخفیف تاریخی نامساوی؛ برگشت یکی فقط پنجرهٔ خودش را مصرف می‌کند', async () => {
  const a = makeVariant('06-source-a', 1_000_000), b = makeVariant('06-source-b', 1_000_000), r = makeVariant('06-r', 1_000_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 300_000 }
  ] })
  const itemA = s.items.find(item => n(item.variantId) === a)
  const lines = [{ saleItemId: n(itemA.id), qty: 1 }], replacements = [{ variantId: r, qty: 1, unitPrice: 1_000_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 900_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '06' })
  const events = seed.rows('SELECT eventType,amount,sourceSaleItemId FROM "DiscountTransferEvent" WHERE sourceReturnId=?', x.returnId)
  const transfers = events.filter(row => row.eventType === 'TRANSFER')
  assert.equal(transfers.reduce((sum, row) => sum + n(row.amount), 0), 100_000)
  assert.ok(transfers.every(row => n(row.sourceSaleItemId) === n(itemA.id)))
  return { returnedSourceDiscount: 100_000, untouchedSourceDiscount: 300_000, transferred: 100_000 }
})

// 07. Return both unequal source rows: aggregate provenance must be complete and bounded by policy delta.
await run(7, 'برگشت دو قلم نامساوی؛ جمع provenance با Δ و انتقال منتخب برابر است', async () => {
  const a = makeVariant('07-source-a', 1_000_000), b = makeVariant('07-source-b', 1_000_000), r = makeVariant('07-r', 1_900_000)
  const s = await sale({ lines: [
    { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 },
    { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 300_000 }
  ] })
  const lines = s.items.map(item => ({ saleItemId: n(item.id), qty: 1 }))
  const replacements = [{ variantId: r, qty: 1, unitPrice: 1_900_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 1_600_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 400_000)
  assert.equal(n(p.discountTransfer.policyDelta), 300_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 300_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '07' })
  const events = seed.rows('SELECT eventType,amount,sourceSaleItemId FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER')
  assert.equal(events.reduce((sum, row) => sum + n(row.amount), 0), 300_000)
  assert.equal(new Set(events.map(row => n(row.sourceSaleItemId))).size, 2)
  return { sourceDiscount: 400_000, delta: 300_000, transfer: 300_000, provenanceSources: 2 }
})

// 08. Current line discount and source invoice discount coexist; only the selected transfer is added on the child.
await run(8, 'تخفیف ردیفی و فاکتوری مبدأ؛ تخفیف منتقل‌شده جداگانه و فقط یک‌بار', async () => {
  const a = makeVariant('08-source', 1_000_000), b = makeVariant('08-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 800_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '08' })
  const child = seed.one('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', x.exchangeInvoiceId)
  assert.equal(n(child.discount), 150_000)
  assert.equal(n(child.lineTotal), 800_000)
  return { sourceLineDiscount: 100_000, sourceInvoiceDiscount: 100_000, replacementTransfer: 150_000 }
})

// 09. POS-origin refund on a negative exchange difference follows the POS gate and does not touch cash.
await run(9, 'مبدأ خرید POS؛ بازپرداخت اختلاف به POS فقط با تأیید لازم', async () => {
  const a = makeVariant('09-source', 1_000_000), b = makeVariant('09-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CARD' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '09', refundMode: 'CARD' })
  assert.equal(n(x.cardRefunded), 100_000)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(seed.count('CashMovement', 'refId=?', x.returnId), 0)
  return { sourceTender: 'CARD', cardRefund: 100_000, cashMovement: 0 }
})

// 10. POS refund without override is rejected before any sale/return/stock mutation.
await run(10, 'بازپرداخت POS بدون acknowledgement/manager؛ رد mutation-free', async () => {
  const a = makeVariant('10-source', 1_000_000), b = makeVariant('10-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'NO',
    expectedDiscountTransferAmount: 0, expectedSettlementDiff: n(p.effectiveDiff), refundMode: 'CARD',
    exchangeSettlementDecision: 'METHOD', requestIdempotencyKey: 'dp20r4-10-card-gate-0001'
  }), /کارت‌خوان قفل است/)
  assert.deepEqual(snapshot([a, b]), before)
  return { posPayout: 100_000, overrideMissing: true, mutation: false }
})

// 11. Card-to-card exchange refund creates a pending request, not a physical payment.
await run(11, 'کارت‌به‌کارت در تعویض؛ درخواست pending بدون پرداخت بانکی واقعی', async () => {
  const a = makeVariant('11-source', 1_000_000), b = makeVariant('11-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '11', refundMode: 'CARD_TO_CARD' })
  assert.equal(n(x.cardToCard), 100_000)
  const request = seed.one('SELECT id,amount,status FROM "CardTransferRequest" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(request.amount), 100_000)
  assert.match(String(request.status).toUpperCase(), /PENDING|WAIT/)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.cardRefunded), 0)
  return { requested: n(request.amount), status: request.status, actualBankTransfer: false }
})

// 12. Partial cash payout returns the remainder as non-expiring store credit.
await run(12, 'بازپرداخت نقدی جزئی؛ ماندهٔ مابه‌التفاوت به اعتبار جداگانه تبدیل می‌شود', async () => {
  const a = makeVariant('12-source', 1_000_000), b = makeVariant('12-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '12', refundMode: 'CASH', refundAmount: 40_000 })
  assert.equal(n(x.cashRefunded), 40_000)
  assert.equal(n(x.newStoreCreditAmount), 60_000)
  const credit = seed.one('SELECT amount,expiresAt FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', x.returnId)
  assert.equal(n(credit.amount), 60_000)
  assert.equal(credit.expiresAt, null)
  return { cash: 40_000, creditRemainder: 60_000, creditExpiry: null }
})

// 13. Full cash refund and receipt ledger agree exactly for a negative exchange difference.
await run(13, 'اختلاف منفی با بازپرداخت نقدی کامل؛ خروج صندوق دقیقاً برابر مانده', async () => {
  const a = makeVariant('13-source', 1_000_000), b = makeVariant('13-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  const cashBefore = seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type=?', shiftId, 'EXCHANGE_REFUND')
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '13', refundMode: 'CASH' })
  const cashAfter = seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type=?', shiftId, 'EXCHANGE_REFUND')
  assert.equal(n(cashAfter.amount) - n(cashBefore.amount), 100_000)
  assert.equal(n(x.cashRefunded), 100_000)
  return { refund: 100_000, cashMovementDelta: n(cashAfter.amount) - n(cashBefore.amount) }
})

// 14. A YES_ZERO transfer can be committed while the source money was split between cash and POS.
await run(14, 'YES_ZERO با مبدأ tender ترکیبی؛ provenance تخفیف و مابه‌التفاوت مثبت جدا می‌مانند', async () => {
  const a = makeVariant('14-source', 1_000_000), b = makeVariant('14-r', 1_100_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 1_100_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  assert.equal(n(p.effectiveDiff), 100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '14' })
  assert.equal(n(x.discountTransferAmount), 200_000)
  assert.equal(n(x.cashReceived), 100_000)
  return { originalTender: 'CASH+CARD', transfer: 200_000, positiveDiff: 100_000 }
})

// 15. Mixed source funding with an explicit credit barcode cannot make the cash refund exceed real-money backing.
await run(15, 'مبدأ نقد+کارت و برگشت نقدی؛ سقف بازپرداخت به وجه واقعی محدود است', async () => {
  const a = makeVariant('15-source', 1_000_000), b = makeVariant('15-r', 700_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'MIXED' })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 700_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'NO', p, label: '15', refundMode: 'CASH' })
  assert.equal(n(x.cashRefunded), 100_000)
  assert.equal(n(x.cardRefunded), 0)
  return { sourceCashAndCard: 800_000, cashRefund: 100_000, cardRefund: 0 }
})

// 16. Retrying an exchange with the same key reproduces result without duplicate events or payments.
await run(16, 'retry با کلید ثابت؛ خروجی بازپخش‌شده و بدون رکورد تکراری', async () => {
  const a = makeVariant('16-source', 1_000_000), b = makeVariant('16-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const key = 'dp20r4-16-replay-0001'
  const input = { userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES_ZERO',
    expectedDiscountTransferAmount: 150_000, expectedSettlementDiff: 0, requestIdempotencyKey: key }
  const first = await salesService.createExchange(input)
  const before = snapshot([a, b])
  const replay = await salesService.createExchange(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.returnId, first.returnId)
  assert.deepEqual(snapshot([a, b]), before)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { returnId: n(first.returnId), replayed: true, duplicateMutation: false }
})

// 17. A wrong expected transfer amount cannot sneak through a valid option choice.
await run(17, 'مقدار انتقال موردانتظار اشتباه؛ پیش از mutation رد می‌شود', async () => {
  const a = makeVariant('17-source', 1_000_000), b = makeVariant('17-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES_ZERO',
    expectedDiscountTransferAmount: 150_001, expectedSettlementDiff: 0,
    requestIdempotencyKey: 'dp20r4-17-wrong-transfer-0001'
  }))
  assert.deepEqual(snapshot([a, b]), before)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  return { correct: 150_000, submitted: 150_001, mutation: false }
})

// 18. A transfer request with a disabled option is blocked without committing a return.
await run(18, 'گزینهٔ YES غیرفعال با محافظ روشن؛ ثبت و انتقالی ایجاد نمی‌کند', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const a = makeVariant('18-source', 1_000_000), b = makeVariant('18-r', 900_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 900_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find(x => x.option === 'YES').enabled, false)
  const before = snapshot([a, b])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines, replacements, discountTransferOption: 'YES',
    expectedDiscountTransferAmount: 200_000, expectedSettlementDiff: -100_000,
    refundMode: 'STORE_CREDIT', exchangeSettlementDecision: 'METHOD',
    requestIdempotencyKey: 'dp20r4-18-disabled-yes-0001'
  }))
  assert.deepEqual(snapshot([a, b]), before)
  return { yesEnabled: false, mutation: false }
})

// 19. A zero-difference exchange must not create a cash movement or refund method record.
await run(19, 'مابه‌التفاوت صفر؛ بدون حرکت نقدی، بازپرداخت یا اعتبار تازه', async () => {
  const a = makeVariant('19-source', 1_000_000), b = makeVariant('19-r', 950_000)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const before = snapshot([a, b])
  const x = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '19' })
  assert.equal(n(x.diff), 0)
  assert.equal(n(x.cashRefunded), 0)
  assert.equal(n(x.cardRefunded), 0)
  assert.equal(n(x.newStoreCreditAmount), 0)
  assert.equal(seed.count('CashMovement', 'refId=?', x.returnId), 0)
  assert.equal(seed.count('StoreCredit', 'returnId=?', x.returnId), 0)
  assert.equal(seed.count('DiscountTransferEvent', 'sourceReturnId=? AND eventType=?', x.returnId, 'TRANSFER'), 1)
  assert.equal(seed.count('SaleInvoice'), before.invoices + 1)
  return { diff: 0, transfer: 150_000, physicalOrNewCreditSettlement: false }
})

// 20. Void is retained as evidence; returned stock is corrected, but consumed historical discount is not reissued.
await run(20, 'ابطال exchange؛ پنجرهٔ تخفیف مصرف‌شده دوباره صادر نمی‌شود', async () => {
  const a = makeVariant('20-source', 1_000_000), b = makeVariant('20-r1', 950_000), c = makeVariant('20-r2', 950_000)
  const sourceBefore = stockOf(a)
  const s = await sale({ lines: [{ variantId: a, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(s.items[0].id), qty: 1 }], replacements = [{ variantId: b, qty: 1, unitPrice: 950_000, discount: 0 }]
  const p = await preview(s.id, lines, replacements, 'YES_ZERO')
  const first = await exchange({ invoiceId: s.id, lines, replacements, option: 'YES_ZERO', p, label: '20-first' })
  const voidResult = await salesService.returnDelete({
    id: first.returnId, userId, reason: 'round4 isolated audit void', panelPassword: DEFAULT_MANAGER_PASSWORD
  })
  assert.ok(voidResult)
  assert.equal(stockOf(a), sourceBefore - 1, 'void reverses the return; original sale remains')
  assert.equal(stockOf(b), 100, 'void restores the replacement stock')
  const voidEvents = seed.rows('SELECT amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', first.returnId, 'VOID')
  assert.ok(voidEvents.length > 0)
  assert.ok(voidEvents.every(row => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const afterLines = [{ saleItemId: n(s.items[0].id), qty: 1 }]
  const afterReplacements = [{ variantId: c, qty: 1, unitPrice: 950_000, discount: 0 }]
  const after = await salesService.previewExchangeFunding({
    invoiceId: s.id, lines: afterLines, replacements: afterReplacements, discountTransferOption: 'YES_ZERO'
  })
  assert.equal(after.ok, true, after.error)
  assert.equal(after.discountTransfer, undefined, 'VOID evidence must not restore consumed discount history')
  const second = await salesService.createExchange({
    userId, shiftId, invoiceId: s.id, lines: afterLines, replacements: afterReplacements,
    expectedSettlementDiff: n(after.effectiveDiff), requestIdempotencyKey: 'dp20r4-20-after-void-0001'
  })
  assert.equal(n(second.discountTransferAmount), 0)
  assert.equal(n(second.diff), n(after.effectiveDiff))
  return { voidEvidenceRows: voidEvents.length, sourceDiscountReissued: false, secondExchangeTransfer: 0 }
})

await db.$disconnect?.()
const failed = outcomes.filter(row => row.status !== 'PASS')
console.log(`\nROUND 4 SUMMARY: ${outcomes.filter(row => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
