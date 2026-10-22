// @ts-check
/**
 * Regression coverage for barcode-credit exchange tender, safe reversal, and
 * cash-first returns when an uncleared cheque remains attached to kept goods.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-exchange-credit-tender-reversal-and-cheque.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-exchange-credit-regression-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { reverseInvoiceRedemptions } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const userId = seed.user('فروشنده تست اعتبار تعویض')
const shiftId = seed.insert('Shift', { name: 'شیفت تست', number: 1, dayJalali: today, openedAt: Date.now() - 60_000, userId })
const cash = seed.insert('PaymentMethod', { key: 'REG-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'REG-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cheque = seed.insert('PaymentMethod', { key: 'REG-CHEQUE', label: 'چک', kind: 'CHEQUE', isActive: 1, sortOrder: 3 })
const categoryId = seed.category('دسته رگرسیون')
const productId = seed.product('کالای رگرسیون', categoryId)
let vNo = 0
const variant = (price) => {
  const id = seed.variant(productId, `مدل ${++vNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const makeCredit = (code, amount, overrides = {}) =>
  seed.insert('StoreCredit', {
    code,
    amount,
    source: 'MANUAL',
    usedAmount: 0,
    usedCount: 0,
    maxUses: 1,
    multiUse: 0,
    carryRemainder: 1,
    status: 'ACTIVE',
    issuedAt: Date.now() - 60_000,
    issuedAtJalali: today,
    expiresAt: new Date(Date.now() + 10 * 86_400_000),
    ...overrides
  })

console.log('۱) اعتبار بارکدی روی اختلاف مثبت، قبل از وجه نقد مصرف می‌شود')
const blueBeforePositiveExchange = await physicalMovementForCustodyShift(shiftId)
const tenderCreditId = makeCredit('EXCHCREDIT1', 700)
const a = variant(1_000)
const b = variant(1_000)
const c = variant(1_500)
const original = await salesService.create({
  userId,
  shiftId,
  lines: [
    { variantId: a, qty: 1, unitPrice: 1_000, discount: 0, tax: 0 },
    { variantId: b, qty: 1, unitPrice: 1_000, discount: 0, tax: 0 }
  ],
  payments: [
    { methodId: cash, amount: 2_000, destination: 'CASH' }
  ]
})
const saleItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', original.id)
const firstExchangeInput = {
  userId,
  shiftId,
  invoiceId: original.id,
  lines: [{ saleItemId: Number(saleItems[0].id), qty: 1 }],
  replacements: [{ variantId: c, qty: 1 }],
  exchangeCreditCode: 'EXCHCREDIT1',
  idempotencyKey: 'exchange-credit-first-1',
  methodId: cash
}
const first = await salesService.createExchange(firstExchangeInput)
assert.equal(first.diff, 500)
assert.equal(first.barcodeCreditApplied, 500)
assert.equal(first.cashDue, 0)
assert.equal(first.cashReceived, 0, 'بارکد اعتبار نباید دریافتی نقد صندوق شود')
assert.equal(Number(sql.prepare('SELECT usedAmount FROM "StoreCredit" WHERE id = ?').get(tenderCreditId).usedAmount), 500)
assert.equal(Number(sql.prepare('SELECT COUNT(*) AS n FROM "Payment" WHERE invoiceId = ? AND storeCreditId = ?').get(first.exchangeInvoiceId, tenderCreditId).n), 1)
assert.equal(
  await physicalMovementForCustodyShift(shiftId) - blueBeforePositiveExchange,
  2_000,
  'عدد آبی باید فقط وجه نقد فروش اولیه را بشمارد؛ EXCHANGE_CREDIT و بارکد مصرف‌شده پول نیستند'
)
console.log('  ✓ اختلاف ۵۰۰ با اعتبار پوشش داده شد؛ دریافتی نقد صفر است و عدد آبی فقط ۲٬۰۰۰ وجه واقعی دارد')

console.log('۲) کلید retry مصرف را دوباره ثبت نمی‌کند و مانده‌ی بارکد دقیق می‌ماند')
const returnCountBeforeRetry = seed.count('SaleReturn')
await assert.rejects(() => salesService.createExchange({
  ...firstExchangeInput,
  lines: [{ saleItemId: Number(saleItems[1].id), qty: 1 }]
}), /کلید تکرار|درخواست|فاکتور دیگری|مصرف شد/)
assert.equal(seed.count('SaleReturn'), returnCountBeforeRetry, 'تراکنش retry باید کاملاً rollback شود')
assert.equal(Number(sql.prepare('SELECT usedAmount FROM "StoreCredit" WHERE id = ?').get(tenderCreditId).usedAmount), 500)
const second = await salesService.createExchange({
  ...firstExchangeInput,
  lines: [{ saleItemId: Number(saleItems[1].id), qty: 1 }],
  idempotencyKey: 'exchange-credit-second-2'
})
assert.equal(second.barcodeCreditApplied, 200)
assert.equal(second.cashDue, 300)
assert.equal(second.cashReceived, 300)
assert.equal(Number(sql.prepare('SELECT usedAmount FROM "StoreCredit" WHERE id = ?').get(tenderCreditId).usedAmount), 700)
assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?').get(tenderCreditId).status), 'USED')
assert.equal(
  await physicalMovementForCustodyShift(shiftId) - blueBeforePositiveExchange,
  2_300,
  'عدد آبی پس از مصرف ۲۰۰ اعتبار باید فقط ۳۰۰ وجه واقعی تازه را اضافه کند'
)
console.log('  ✓ retry مبلغی را دوباره کم نکرد؛ مصرف دوم فقط مانده‌ی ۲۰۰ را گرفت، ۳۰۰ نقد شد و blue=۲٬۳۰۰ ماند')

console.log('۳) برگشت مصرف بارکد USED، بارکد قدیمی را زنده نمی‌کند')
const reverseInvoice = seed.invoice({ grandTotal: 500, status: 'SETTLED' })
const returnId = seed.insert('SaleReturn', { invoiceId: reverseInvoice.id, total: 500, returnedAt: Date.now(), returnedAtJalali: today })
const deadline = new Date(Date.now() + 4 * 86_400_000 + 12_345)
const usedCodeId = makeCredit('USEDROOT123', 500, {
  usedAmount: 500,
  usedCount: 1,
  status: 'USED',
  expiresAt: deadline
})
seed.insert('StoreCreditRedemption', {
  creditId: usedCodeId,
  code: 'USEDROOT123',
  amount: 500,
  remainderAfter: 0,
  seq: 1,
  invoiceId: reverseInvoice.id,
  at: Date.now() - 1_000,
  atJalali: today
})
const reversed = await db.$transaction((tx) => reverseInvoiceRedemptions(tx, {
  invoiceId: reverseInvoice.id,
  returnId,
  reason: 'رگرسیون برگشت کامل'
}))
assert.equal(reversed, 1)
const oldCode = sql.prepare('SELECT status, usedAmount FROM "StoreCredit" WHERE id = ?').get(usedCodeId)
assert.equal(oldCode.status, 'USED')
assert.equal(Number(oldCode.usedAmount), 500)
const successor = sql.prepare('SELECT id, amount, expiresAt FROM "StoreCredit" WHERE id != ? AND returnId = ?').get(usedCodeId, returnId)
assert.ok(successor, 'اعتبار جانشین باید به سند برگشت متصل شود')
assert.equal(Number(successor.amount), 500)
assert.equal(Number(successor.expiresAt), deadline.getTime(), 'مهلت جانشین باید عین مهلت ریشه باشد')
assert.equal(Number(await db.$transaction((tx) => reverseInvoiceRedemptions(tx, { invoiceId: reverseInvoice.id, returnId }))), 0)
console.log('  ✓ قدیمی USED ماند؛ جانشین با مبلغ و timestamp انقضای دقیق ریشه صادر شد و retry تکراری نساخت')

console.log('۴) برگشت اعتبار فعال/نیمه‌مصرف‌شده همان بارکد و همان مهلت را نگه می‌دارد')
const activeInvoice = seed.invoice({ grandTotal: 400, status: 'SETTLED' })
const activeDeadline = new Date(Date.now() + 8 * 86_400_000 + 7_654)
const activeCodeId = makeCredit('ACTIVEHALF123', 1_000, {
  usedAmount: 400,
  usedCount: 1,
  status: 'PARTIALLY_USED',
  expiresAt: activeDeadline
})
const creditCountBeforeActiveReverse = seed.count('StoreCredit')
seed.insert('StoreCreditRedemption', {
  creditId: activeCodeId,
  code: 'ACTIVEHALF123',
  amount: 400,
  remainderAfter: 600,
  seq: 1,
  invoiceId: activeInvoice.id,
  at: Date.now() - 1_000,
  atJalali: today
})
await db.$transaction((tx) => reverseInvoiceRedemptions(tx, { invoiceId: activeInvoice.id, reason: 'رگرسیون بارکد فعال' }))
const activeAfter = sql.prepare('SELECT status, usedAmount, usedCount, expiresAt FROM "StoreCredit" WHERE id = ?').get(activeCodeId)
assert.equal(activeAfter.status, 'ACTIVE')
assert.equal(Number(activeAfter.usedAmount), 0)
assert.equal(Number(activeAfter.usedCount), 0)
assert.equal(Number(activeAfter.expiresAt), activeDeadline.getTime())
assert.equal(seed.count('StoreCredit'), creditCountBeforeActiveReverse, 'برای کد فعال نباید جانشین صادر شود')
console.log('  ✓ همان بارکد فعال شد؛ مهلت root دست‌نخورده و جانشینی صادر نشد')

console.log('۵) S1: مابه‌التفاوت ۹۸۰٬۰۰۰ از منشأ اعتبار، یک بارکد با مهلت ریشه می‌گیرد')
const rootExpiry = new Date(Date.now() + 6 * 86_400_000 + 54_321)
const rootCreditId = makeCredit('S1ROOTCREDIT', 2_000_000, { expiresAt: rootExpiry })
const originalS1Variant = variant(15_980_000)
const replacementS1Variant = variant(15_000_000)
const originalS1 = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: originalS1Variant, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 13_980_000, destination: 'CASH' }],
  storeCreditCode: 'S1ROOTCREDIT',
  storeCreditIdempotencyKey: 's1-original-credit-use'
})
const originalS1Item = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', originalS1.id).id)
const s1Exchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: originalS1.id,
  lines: [{ saleItemId: originalS1Item, qty: 1 }],
  replacements: [{ variantId: replacementS1Variant, qty: 1 }],
  refundMode: 'STORE_CREDIT'
})
assert.equal(s1Exchange.diff, -980_000)
assert.equal(s1Exchange.settlement, 'CREDIT')
assert.equal(s1Exchange.cashRefunded, 0)
assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?').get(rootCreditId).status), 'USED')
const s1Credits = seed.rows('SELECT id, amount, expiresAt FROM "StoreCredit" WHERE returnId = ? ORDER BY id', s1Exchange.returnId)
assert.equal(s1Credits.length, 1, 'S1 باید یک بارکد جانشین داشته باشد، نه B/N یا چند کد')
assert.equal(Number(s1Credits[0].amount), 980_000)
assert.equal(Number(s1Credits[0].expiresAt), rootExpiry.getTime())
assert.equal(seed.count('CashMovement', 'refId = ? AND type = ?', s1Exchange.returnId, 'EXCHANGE_REFUND'), 0)
console.log('  ✓ ۹۸۰٬۰۰۰ ریال یک اعتبار غیرنقدی شد؛ کد ریشه USED ماند و مهلت دقیق ریشه حفظ شد')

console.log('۶) S8: منشأ نقد/اعتبار در زنجیره‌ی P→C→G حفظ می‌شود')
const s8Expiry = new Date(Date.now() + 9 * 86_400_000 + 98_765)
const s8RootId = makeCredit('S8ROOTCREDIT', 2_000_000, { expiresAt: s8Expiry })
const pVariant = variant(15_000_000)
const cVariant = variant(5_000_000)
const gVariant = variant(5_000_000)
const gReplacement = variant(4_000_000)
const pSale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: pVariant, qty: 1, unitPrice: 15_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 13_000_000, destination: 'CASH' }],
  storeCreditCode: 'S8ROOTCREDIT',
  storeCreditIdempotencyKey: 's8-p-credit-use'
})
const pItem = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', pSale.id).id)
const pToC = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: pSale.id,
  lines: [{ saleItemId: pItem, qty: 1 }],
  replacements: [{ variantId: cVariant, qty: 3 }]
})
assert.equal(pToC.diff, 0)
const cItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', pToC.exchangeInvoiceId)
const cToG = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: pToC.exchangeInvoiceId,
  lines: [{ saleItemId: Number(cItems[0].id), qty: 1 }],
  replacements: [{ variantId: gVariant, qty: 1 }]
})
assert.equal(cToG.diff, 0)
const gItem = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', cToG.exchangeInvoiceId).id)
const gToCheaper = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: cToG.exchangeInvoiceId,
  lines: [{ saleItemId: gItem, qty: 1 }],
  replacements: [{ variantId: gReplacement, qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(gToCheaper.diff, -1_000_000)
assert.equal(gToCheaper.cashRefunded, 1_000_000, '۵M انتقال‌یافته از C همچنان منشأ پول واقعی دارد')
assert.equal(seed.count('CashMovement', 'refId = ? AND type = ?', gToCheaper.returnId, 'EXCHANGE_REFUND'), 1)
const cRemainderItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', pToC.exchangeInvoiceId)
const cRemainder = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: pToC.exchangeInvoiceId,
  lines: [{ saleItemId: Number(cRemainderItems[0].id), qty: 2 }],
  replacements: [{ variantId: variant(9_000_000), qty: 1 }],
  refundMode: 'CASH'
})
assert.equal(cRemainder.diff, -1_000_000)
assert.equal(cRemainder.cashRefunded, 0, 'پس از انتقال ۵M، باقیمانده‌ی ۱۰M = ۸M پول + ۲M اعتبار')
assert.equal(cRemainder.settlement, 'CREDIT')
const s8Successor = seed.one('SELECT amount, expiresAt FROM "StoreCredit" WHERE returnId = ?', cRemainder.returnId)
assert.equal(Number(s8Successor.amount), 1_000_000)
assert.equal(Number(s8Successor.expiresAt), s8Expiry.getTime())
assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?').get(s8RootId).status), 'USED')
console.log('  ✓ C→G منتقل‌شده ۵M از پول بود؛ C پس از آن ۸M پول + ۲M اعتبار نگه داشت و ۱M برگشتی از بارکد با deadline ریشه صادر شد')

console.log('۷) S11: بدهی ۳۰۰٬۰۰۰ اول کم می‌شود؛ فقط ۲۰۰٬۰۰۰ مانده یک بارکد غیرنقدی می‌گیرد')
const s11OriginalVariant = variant(1_000_000)
const s11ReplacementVariant = variant(500_000)
const s11Sale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: s11OriginalVariant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 700_000, destination: 'CASH' }]
})
const s11Item = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', s11Sale.id).id)
const s11Exchange = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: s11Sale.id,
  lines: [{ saleItemId: s11Item, qty: 1 }],
  replacements: [{ variantId: s11ReplacementVariant, qty: 1 }],
  refundMode: 'STORE_CREDIT'
})
assert.equal(s11Exchange.diff, -500_000)
assert.equal(s11Exchange.debtReduction, 300_000)
assert.equal(s11Exchange.storeCredit.amount, 200_000)
assert.equal(s11Exchange.cashRefunded, 0)
assert.equal(s11Exchange.settlement, 'CREDIT')
const s11Credit = seed.one('SELECT amount, source, sourceInvoiceId, returnId, exchangeInvoiceId FROM "StoreCredit" WHERE returnId = ?', s11Exchange.returnId)
assert.equal(Number(s11Credit.amount), 200_000)
assert.equal(s11Credit.source, 'EXCHANGE')
assert.equal(Number(s11Credit.sourceInvoiceId), s11Sale.id)
assert.equal(Number(s11Credit.exchangeInvoiceId), s11Exchange.exchangeInvoiceId)
console.log('  ✓ بدهی ۳۰۰٬۰۰۰ کاهش یافت؛ یک اعتبار ۲۰۰٬۰۰۰ریالی با منشأ فاکتور/تعویض ثبت شد و پول نقدی خارج نشد')

console.log('۸) برگشت کالای پول‌داده‌شده از چکِ وصول‌نشده‌ی کالای نگه‌داشته‌شده جدا می‌ماند')
const cashPaid = variant(2_000_000)
const chequeKept = variant(2_000_000)
const blueBeforeMixedSale = await physicalMovementForCustodyShift(shiftId)
const mixedSale = await salesService.create({
  userId,
  shiftId,
  lines: [
    { variantId: cashPaid, qty: 1, unitPrice: 2_000_000, discount: 0, tax: 0 },
    { variantId: chequeKept, qty: 1, unitPrice: 2_000_000, discount: 0, tax: 0 }
  ],
  payments: [
    { methodId: cash, amount: 1_000_000, destination: 'CASH' },
    { methodId: card, amount: 1_500_000, destination: 'CARD' }
  ]
})
const chequeRowId = seed.insert('Payment', {
  invoiceId: mixedSale.id,
  methodId: cheque,
  amount: 1_500_000,
  kind: 'CHEQUE',
  seq: 3,
  chequeStatus: 'PENDING',
  paidAt: Date.now(),
  paidAtJalali: today
})
const cashPaidItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? AND variantId = ?', mixedSale.id, cashPaid).id)
const returned = await salesService.createReturn({
  invoiceId: mixedSale.id,
  lines: [{ saleItemId: cashPaidItemId, qty: 1 }],
  refundMethod: 'CASH',
  refundAmount: 2_000_000,
  userId
})
assert.equal(Number(returned.refundAmount), 2_000_000)
assert.equal(String(sql.prepare('SELECT chequeStatus FROM "Payment" WHERE id = ?').get(chequeRowId).chequeStatus), 'PENDING')
assert.equal(Number(sql.prepare('SELECT amount FROM "CashMovement" WHERE refId = ? AND type = ?').get(returned.id, 'RETURN_REFUND').amount), 2_000_000)
assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeMixedSale, 500_000, 'blue = ۱M cash + ۱٫۵M card − ۲M نقدی برگشتی؛ چک pending/بدهی وارد عدد آبی نشود')
console.log('  ✓ ۲ میلیون از مبلغ پول‌داده‌شده برگشت؛ چک ۱٫۵ میلیونی همچنان PENDING و روی فاکتور کالای نگه‌داشته‌شده باقی ماند')

console.log('۹) S5 دقیق: قلم ۵M با ۲M اعتبار و ۳M وجه واقعی، برگشت نقدی فقط ۳M پول می‌دهد و ۲M به منبع اعتبار برمی‌گردد')
{
  const expiry = new Date(Date.now() + 12 * 86_400_000 + 31_415)
  const rootId = makeCredit('S5ROOTCASH', 2_000_000, { expiresAt: expiry })
  const itemVariant = variant(5_000_000)
  const blueBefore = await physicalMovementForCustodyShift(shiftId)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: itemVariant, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 3_000_000, destination: 'CASH' }],
    storeCreditCode: 'S5ROOTCASH',
    storeCreditIdempotencyKey: 's5-root-credit-cash-return'
  })
  const saleItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id).id)
  assert.equal(Number(sql.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM "StoreCreditRedemption" WHERE invoiceId = ? AND reversedAt IS NULL').get(sale.id).n), 2_000_000, 'پشتوانهٔ بارکدی S5 باید دقیقاً ۲M و جدا از ۳M وجه نقد باشد')
  const returned = await salesService.createReturn({
    invoiceId: sale.id,
    lines: [{ saleItemId, qty: 1 }],
    refundMethod: 'CASH',
    refundAmount: 5_000_000,
    userId
  })
  assert.equal(Number(returned.refundAmount), 3_000_000)
  assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?').get(rootId).status), 'USED')
  const successor = seed.one('SELECT amount, expiresAt FROM "StoreCredit" WHERE id <> ? AND returnId = ?', rootId, returned.id)
  assert.equal(Number(successor.amount), 2_000_000)
  assert.equal(Number(successor.expiresAt), expiry.getTime())
  assert.equal(Number(sql.prepare('SELECT amount FROM "CashMovement" WHERE refId = ? AND type = ?').get(returned.id, 'RETURN_REFUND').amount), 3_000_000)
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBefore, 0, 'فروش ۳M نقد و بازپرداخت همان ۳M باید در blue دقیقاً خنثی شوند')
  console.log('  ✓ سهم ۲M به جانشین با مهلت ریشه برگشت؛ فقط ۳M واقعی نقد شد؛ اثر خالص blue صفر است')
}

console.log('۱۰) S5 انتخاب اعتبار: سهم ۳M پول واقعی به اعتبار غیرنقدی تبدیل می‌شود و ۲M به ریشه برمی‌گردد')
{
  const expiry = new Date(Date.now() + 13 * 86_400_000 + 27_182)
  const rootId = makeCredit('S5ROOTCREDIT', 2_000_000, { expiresAt: expiry })
  const itemVariant = variant(5_000_000)
  const blueBefore = await physicalMovementForCustodyShift(shiftId)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: itemVariant, qty: 1, unitPrice: 5_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 3_000_000, destination: 'CASH' }],
    storeCreditCode: 'S5ROOTCREDIT',
    storeCreditIdempotencyKey: 's5-root-credit-noncash-return'
  })
  const saleItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id).id)
  const returned = await salesService.createReturn({
    invoiceId: sale.id,
    lines: [{ saleItemId, qty: 1 }],
    refundMethod: 'STORE_CREDIT',
    refundAmount: 5_000_000,
    userId
  })
  assert.equal(Number(returned.refundAmount), 3_000_000, 'فقط سهم پول واقعی به اعتبار تازه تبدیل می‌شود؛ سهم ۲M از دفتر ریشه جدا برمی‌گردد')
  assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?').get(rootId).status), 'USED')
  const credits = seed.rows('SELECT amount, expiresAt FROM "StoreCredit" WHERE id <> ? AND returnId = ? ORDER BY amount', rootId, returned.id)
  assert.deepEqual(credits.map((row) => Number(row.amount)), [2_000_000, 3_000_000])
  assert.equal(Number(credits.find((row) => Number(row.amount) === 2_000_000).expiresAt), expiry.getTime())
  assert.equal(seed.count('CashMovement', 'refId = ? AND type = ?', returned.id, 'RETURN_REFUND'), 0)
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBefore, 3_000_000, 'اعتبار غیرنقدی blue را کم نمی‌کند؛ وجه فروش واقعاً دریافت شده بود')
  console.log('  ✓ مجموع اعتبارها ۵M است: ۲M با lineage/مهلت ریشه و ۳M غیرنقدی از وجه واقعی؛ هیچ cash refund ثبت نشد')
}

console.log('۱۱) S11 دقیق: ۹۰۰K وجه + ۳۰۰K هدیه + ۳۰۰K بدهی، تعویض ۱M ⇒ ۹۰۰K وجه + ۱۰۰K هدیه + جانشین ۲۰۰K')
{
  const expiry = new Date(Date.now() + 14 * 86_400_000 + 16_180)
  const rootId = makeCredit('S11ROOTGIFT', 300_000, { source: 'EXCHANGE', expiresAt: expiry })
  const originalVariant = variant(1_500_000)
  const replacementVariant = variant(1_000_000)
  const blueBefore = await physicalMovementForCustodyShift(shiftId)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: originalVariant, qty: 1, unitPrice: 1_500_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 900_000, destination: 'CASH' }],
    storeCreditCode: 'S11ROOTGIFT',
    storeCreditIdempotencyKey: 's11-root-gift-source'
  })
  assert.equal(Number(sql.prepare('SELECT paidTotal FROM "SaleInvoice" WHERE id = ?').get(sale.id).paidTotal), 1_200_000)
  assert.equal(Number(sql.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM "Payment" WHERE invoiceId = ? AND methodId = ?').get(sale.id, cash).n), 900_000, 'منشأ پولی کالای مرجع S11 دقیقاً ۹۰۰K نقد است')
  assert.equal(Number(sql.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM "StoreCreditRedemption" WHERE invoiceId = ? AND reversedAt IS NULL').get(sale.id).n), 300_000, 'منشأ هدیهٔ کالای مرجع S11 دقیقاً ۳۰۰K اعتبار است')
  const itemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id).id)
  const exchanged = await salesService.createExchange({
    userId,
    shiftId,
    invoiceId: sale.id,
    lines: [{ saleItemId: itemId, qty: 1 }],
    replacements: [{ variantId: replacementVariant, qty: 1 }],
    refundMode: 'STORE_CREDIT'
  })
  assert.equal(exchanged.returnTotal, 1_500_000)
  assert.equal(exchanged.exchangeTotal, 1_000_000)
  assert.equal(exchanged.diff, -500_000)
  assert.equal(exchanged.debtReduction, 300_000)
  assert.equal(exchanged.cashRefunded, 0)
  assert.equal(seed.count('CashMovement', 'refId = ? AND type = ?', exchanged.returnId, 'EXCHANGE_REFUND'), 0)
  assert.equal(String(sql.prepare('SELECT status FROM "StoreCredit" WHERE id = ?', rootId).get(rootId).status), 'USED')
  const successor = seed.one('SELECT amount, expiresAt FROM "StoreCredit" WHERE id <> ? AND returnId = ?', rootId, exchanged.returnId)
  assert.equal(Number(successor.amount), 200_000)
  assert.equal(Number(successor.expiresAt), expiry.getTime())
  const exchangeValue = Number(sql.prepare('SELECT SUM(amount) AS n FROM "Payment" WHERE invoiceId = ? AND methodId = (SELECT id FROM "PaymentMethod" WHERE key = ?)').get(exchanged.exchangeInvoiceId, 'EXCHANGE_CREDIT').n)
  assert.equal(exchangeValue, 1_000_000)
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBefore, 900_000, 'S11 نباید هیچ cash payout/credit را به دریافت فیزیکی اضافه کند')
  console.log('  ✓ کالای جدید ۹۰۰K وجه + ۱۰۰K هدیه را حمل کرد؛ ۲۰۰K هدیه جانشین شد؛ بدهی ۳۰۰K جدا offset شد')
}

console.log('\\n✓ همه‌ی رگرسیون‌های اعتبار تعویض، lineage، S5/S11، چک و عدد آبی موفق شدند')
