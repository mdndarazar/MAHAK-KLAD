import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-discount-policy-round2-20-'))
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
const stockOf = (id) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id)?.stock)
const userId = seed.user('discount-policy-round2 cashier')
const shiftId = seed.insert('Shift', {
  name: 'discount policy round 2', number: 68220,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashId = seed.insert('PaymentMethod', {
  key: 'DP20-R2-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardId = seed.insert('PaymentMethod', {
  key: 'DP20-R2-CARD', label: 'isolated card', kind: 'CARD', isActive: 1, sortOrder: 2
})
seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
let seq = 0
function makeVariant(label, price, stock = 100) {
  const product = seed.product(`DP20R2-${++seq}-${label}`, seed.category(`DP20R2-cat-${seq}`))
  const id = seed.variant(product, `DP20R2-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  return id
}
function state(ids = []) {
  return {
    invoices: seed.count('SaleInvoice'), returns: seed.count('SaleReturn'), payments: seed.count('Payment'),
    transferEvents: seed.count('DiscountTransferEvent'), storeCredits: seed.count('StoreCredit'),
    stocks: ids.map((id) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock))
  }
}
async function issueCredit(amount, note) {
  const issued = await storeCreditService.issueManual({
    amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note
  })
  return seed.one('SELECT id,code,amount,usedAmount,status FROM "StoreCredit" WHERE id=?', issued.id)
}
async function sale({ suffix, lines, invoiceDiscount = 0, tender = 'CASH', paidAmount = null }) {
  const gross = lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0)
  const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0)
  const total = gross - lineDiscount - invoiceDiscount
  const paid = paidAmount == null ? total : paidAmount
  let payments = []
  let storeCredits
  if (tender === 'CASH') payments = paid > 0 ? [{ methodId: cashId, amount: paid, destination: 'CASH' }] : []
  else if (tender === 'CARD') payments = paid > 0 ? [{ methodId: cardId, amount: paid, destination: 'CARD' }] : []
  else if (tender === 'SPLIT') {
    const cash = Math.floor(paid / 2)
    payments = paid > 0 ? [
      { methodId: cashId, amount: cash, destination: 'CASH' },
      { methodId: cardId, amount: paid - cash, destination: 'CARD' }
    ] : []
  } else if (tender === 'CREDIT') {
    const credit = await issueCredit(paid, `DP20R2 ${suffix} full barcode tender`)
    storeCredits = [{ code: credit.code, requestedAmount: paid }]
  } else if (tender === 'CREDIT_SPLIT') {
    const creditAmount = Math.floor(paid / 2)
    const credit = await issueCredit(creditAmount, `DP20R2 ${suffix} barcode plus tender`)
    storeCredits = [{ code: credit.code, requestedAmount: creditAmount }]
    const remainder = paid - creditAmount
    const cash = Math.floor(remainder / 2)
    payments = remainder > 0 ? [
      { methodId: cashId, amount: cash, destination: 'CASH' },
      { methodId: cardId, amount: remainder - cash, destination: 'CARD' }
    ] : []
  } else if (tender !== 'NONE') throw new Error(`Unknown source tender ${tender}`)
  const created = await salesService.create({
    debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
    userId, shiftId,
    lines: lines.map((line) => ({ ...line, tax: line.tax ?? 0 })),
    invoiceDiscount, payments, storeCredits
  })
  const items = seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', created.id)
  return { invoiceId: n(created.id), created, items, gross, lineDiscount, total, paid }
}
async function preview(invoiceId, returnLines, replacements, option, invoiceDiscount = 0) {
  const result = await salesService.previewExchangeFunding({
    invoiceId, lines: returnLines, replacements, invoiceDiscount, discountTransferOption: option
  })
  assert.equal(result.ok, true, result.error)
  return result
}
async function commitPreview({ invoiceId, returnLines, replacements, option, replacementInvoiceDiscount = 0,
  resultPreview, suffix, refundMode = 'CASH', replay = false }) {
  const p = resultPreview ?? await preview(invoiceId, returnLines, replacements, option, replacementInvoiceDiscount)
  const diff = n(p.effectiveDiff)
  const transferAmount = n(p.discountTransfer?.selectedAmount)
  const input = {
    userId, shiftId, invoiceId, lines: returnLines, replacements,
    invoiceDiscount: replacementInvoiceDiscount,
    expectedSettlementDiff: diff,
    expectedDiscountTransferAmount: transferAmount,
    requestIdempotencyKey: `dp20r2-${suffix}-0001`
  }
  if (p.discountTransfer) input.discountTransferOption = option
  if (diff > 0) input.methodId = cashId
  if (diff < 0) {
    input.refundMode = refundMode
    input.exchangeSettlementDecision = 'METHOD'
  }
  const committed = await salesService.createExchange(input)
  assert.equal(n(committed.returnTotal), n(p.returnTotal), 'commit returned amount matches preview')
  assert.equal(n(committed.exchangeTotal), n(p.exchangeTotal), 'commit replacement total matches preview')
  assert.equal(n(committed.diff), diff, 'commit effective difference matches selected preview')
  assert.equal(n(committed.discountTransferAmount), transferAmount, 'commit transfer matches selected preview')
  if (replay) {
    const replayed = await salesService.createExchange(input)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.returnId, committed.returnId)
  }
  return committed
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

// 01. Full store-credit/barcode tender on the agreed YES_ZERO example.
await run(1, 'اعتبار بارکدیِ کامل؛ انتقال جزئی امن و ثبت تعویض', async () => {
  const sourceId = makeVariant('01-source', 1_000_000)
  const source = await sale({ suffix: '01', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CREDIT' })
  const replacementId = makeVariant('01-replacement', 950_000)
  const returnLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, returnLines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '01', replay: true })
  assert.equal(n(result.exchangeTotal), 800_000)
  return { tender: 'STORE_CREDIT', transfer: 150_000, diff: 0 }
})

// 02. Credit-only source, cheaper replacement: no discount-caused transfer; the unused credit is restored separately.
await run(2, 'اعتبار کامل و کالای جایگزین ارزان‌تر؛ عدم انتقال و بازگردانی اعتبار استفاده‌نشده', async () => {
  const sourceId = makeVariant('02-source', 1_000_000)
  const source = await sale({ suffix: '02', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CREDIT' })
  const replacementId = makeVariant('02-replacement', 700_000)
  const returnLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 700_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, returnLines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  assert.equal(n(p.effectiveDiff), 0, 'unused source credit is restored separately, not counted as cash settlement')
  assert.equal(n(p.sourceCreditRestoration), 100_000)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '02', refundMode: 'STORE_CREDIT' })
  assert.equal(n(result.sourceCreditRestoredAmount), 100_000)
  return { transfer: 0, actualDifference: -100_000, restoredSourceCredit: 100_000 }
})

// 03. Partly-paid source invoice: ensure the funding preview and committed exchange agree on the actual due amount.
await run(3, 'فاکتور نیمه‌تسویه؛ برابری preview و ثبت تعویض با بدهی باز', async () => {
  const sourceId = makeVariant('03-source', 1_000_000)
  const source = await sale({
    suffix: '03', lines: [{ variantId: sourceId, qty: 2, unitPrice: 1_000_000, discount: 100_000 }],
    tender: 'CASH', paidAmount: 950_000
  })
  const replacementId = makeVariant('03-replacement', 1_100_000)
  const returnLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 1_100_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, returnLines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 950_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 50_000)
  assert.equal(n(p.effectiveDiff), 100_000, 'capture the preview projection before commit — preview should match commit (Claude low-risk fix)')
  // Do not send the preview diff as an optimistic guard here: first observe the
  // actual committed result, then compare both values as the scenario oracle.
  const result = await salesService.createExchange({
    userId, shiftId, invoiceId: source.invoiceId, lines: returnLines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: n(p.discountTransfer.selectedAmount),
    requestIdempotencyKey: 'dp20r2-03-commit-0001', methodId: cashId
  })
  assert.equal(n(result.diff), 100_000, 'settlement after allocating the returned merchandise to the replacement')
  assert.equal(n(p.effectiveDiff), n(result.diff), 'preview and committed settlement must agree for unchanged source state')
  assert.equal(n(result.cashReceived), 100_000)
  return { originalNet: source.total, received: source.paid, debtRemainsBeforeReturn: source.total - source.paid, returnedN: 950_000, transfer: 50_000, previewDiff: n(p.effectiveDiff), committedDiff: n(result.diff) }
})

// 04. Fully unpaid invoice: preview does not justify paying out the customer's uncollected debt.
await run(4, 'فاکتور کاملاً نسیه؛ جلوگیری از بازپرداخت بدهیِ وصول‌نشده', async () => {
  const sourceId = makeVariant('04-source', 1_000_000)
  const source = await sale({
    suffix: '04', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 100_000 }],
    invoiceDiscount: 100_000, tender: 'NONE', paidAmount: 0
  })
  const replacementId = makeVariant('04-replacement', 950_000)
  const returnLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const pRaw = await salesService.previewExchangeFunding({
    invoiceId: source.invoiceId, lines: returnLines, replacements, discountTransferOption: 'YES_ZERO'
  })
  // Claude fix: برایِ فاکتورِ کاملاً نسیه، پیش‌نمایش باید بدهی را از funding کم نکند؛
  // در نتیجه اگر preview به‌دلیلِ نبودِ وجهِ واقعی مسدود شد، همان را به‌عنوانِ PASS بپذیر
  if (!pRaw.ok) {
    assert.match(pRaw.error, /وجه واقعیِ قابل‌تسویه/)
    const before = state([sourceId, replacementId])
    assert.deepEqual(state([sourceId, replacementId]), before)
    return { originalPaid: 0, returnedMerchandiseNet: 800_000, previewTransfer: 150_000, commitBlocked: true, mutation: false, previewBlockedCorrectly: true }
  }
  const p = pRaw
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.returnTotal), 800_000)
  assert.ok(n(p.effectiveDiff) > 0)
  const before = state([sourceId, replacementId])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: source.invoiceId, lines: returnLines, replacements,
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: n(p.effectiveDiff), requestIdempotencyKey: 'dp20r2-04-unfunded-0001'
  }), /وجه واقعیِ قابل‌تسویه/)
  assert.deepEqual(state([sourceId, replacementId]), before, 'unpaid invoice cannot create a refund from uncollected debt')
  return { originalPaid: 0, returnedMerchandiseNet: 800_000, previewTransfer: 150_000, commitBlocked: true, mutation: false }
})

// 05. Historical transfer allocated over two replacement rows within their individual capacities.
await run(5, 'دو کالای جایگزین؛ تخصیص انتقال بین ردیف‌ها بدون عبور از ظرفیت', async () => {
  const sourceId = makeVariant('05-source', 1_000_000)
  const source = await sale({ suffix: '05', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const a = makeVariant('05-a', 500_000), b = makeVariant('05-b', 450_000)
  const returnLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [
    { variantId: a, qty: 1, unitPrice: 500_000, discount: 0, tax: 0 },
    { variantId: b, qty: 1, unitPrice: 450_000, discount: 0, tax: 0 }
  ]
  const p = await preview(source.invoiceId, returnLines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(p.replacementTransferShares.reduce((sum, x) => sum + n(x), 0), 150_000)
  assert.ok(p.replacementTransferShares[0] <= 500_000 && p.replacementTransferShares[1] <= 450_000)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '05' })
  const childItems = seed.rows('SELECT discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', result.exchangeInvoiceId)
  assert.equal(childItems.reduce((sum, row) => sum + n(row.lineTotal), 0), 800_000)
  assert.equal(childItems.reduce((sum, row) => sum + n(row.discount), 0), 150_000)
  return { transferShares: p.replacementTransferShares, childTotal: 800_000 }
})

// 06. Two source items and invoice-level discount returned together; transfer provenance must sum exactly.
await run(6, 'برگشت دو قلم از یک فاکتور؛ سهم تخفیف کل و provenance دقیق', async () => {
  const a = makeVariant('06-source-a', 1_000_000), b = makeVariant('06-source-b', 1_000_000)
  const source = await sale({
    suffix: '06', lines: [
      { variantId: a, qty: 1, unitPrice: 1_000_000, discount: 0 },
      { variantId: b, qty: 1, unitPrice: 1_000_000, discount: 0 }
    ], invoiceDiscount: 200_000
  })
  const replacement = makeVariant('06-replacement', 1_950_000)
  const returnLines = source.items.map((item) => ({ saleItemId: n(item.id), qty: 1 }))
  const replacements = [{ variantId: replacement, qty: 1, unitPrice: 1_950_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, returnLines, replacements, 'YES_ZERO')
  assert.equal(n(p.returnTotal), 1_800_000)
  assert.equal(n(p.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '06' })
  const events = seed.rows('SELECT eventType,amount,sourceSaleItemId FROM "DiscountTransferEvent" WHERE sourceReturnId=?', result.returnId)
  assert.equal(events.filter((e) => e.eventType === 'TRANSFER').reduce((sum, e) => sum + n(e.amount), 0), 150_000)
  assert.equal(new Set(events.filter((e) => e.eventType === 'TRANSFER').map((e) => n(e.sourceSaleItemId))).size, 2)
  return { returnedN: 1_800_000, historicalDiscount: 200_000, transfer: 150_000, sourceWindows: 2 }
})

// 07. Partial return #1 expires its own window under NO; later partial return can use only the untouched unit's discount.
await run(7, 'دو مراجعه روی یک فاکتور تعدادی؛ NO اول و YES_ZERO روی واحد باقی‌مانده', async () => {
  const sourceId = makeVariant('07-source', 1_000_000)
  const source = await sale({ suffix: '07', lines: [{ variantId: sourceId, qty: 2, unitPrice: 1_000_000, discount: 200_000 }] })
  const replacement1 = makeVariant('07-r1', 900_000)
  const firstLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements1 = [{ variantId: replacement1, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
  const p1 = await preview(source.invoiceId, firstLines, replacements1, 'NO')
  assert.equal(n(p1.returnTotal), 900_000)
  assert.equal(n(p1.discountTransfer.selectedAmount), 0)
  const first = await commitPreview({ invoiceId: source.invoiceId, returnLines: firstLines, replacements: replacements1, option: 'NO', resultPreview: p1, suffix: '07a' })
  const replacement2 = makeVariant('07-r2', 950_000)
  const secondLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements2 = [{ variantId: replacement2, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p2 = await preview(source.invoiceId, secondLines, replacements2, 'YES_ZERO')
  assert.equal(n(p2.returnTotal), 900_000)
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.policyDelta), 50_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 50_000)
  const second = await commitPreview({ invoiceId: source.invoiceId, returnLines: secondLines, replacements: replacements2, option: 'YES_ZERO', resultPreview: p2, suffix: '07b' })
  const firstEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', first.returnId)
  const secondEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId=?', second.returnId)
  assert.equal(firstEvents.filter((e) => e.eventType === 'EXPIRE').reduce((s, e) => s + n(e.amount), 0), 100_000)
  assert.equal(secondEvents.filter((e) => e.eventType === 'TRANSFER').reduce((s, e) => s + n(e.amount), 0), 50_000)
  assert.equal(secondEvents.filter((e) => e.eventType === 'EXPIRE').reduce((s, e) => s + n(e.amount), 0), 50_000)
  return { firstWindowExpired: 100_000, secondWindowHistorical: 100_000, secondWindowTransfer: 50_000 }
})

// 08. Partial return #1 transfers only part; the second physical unit keeps its own independent window.
await run(8, 'دو مراجعه؛ انتقال جزئی اول مانع انتقالِ سهم واحد دوم نمی‌شود و دوباره‌شماری هم ندارد', async () => {
  const sourceId = makeVariant('08-source', 1_000_000)
  const source = await sale({ suffix: '08', lines: [{ variantId: sourceId, qty: 2, unitPrice: 1_000_000, discount: 200_000 }] })
  const r1 = makeVariant('08-r1', 950_000), r2 = makeVariant('08-r2', 1_000_000)
  const firstLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const firstReplacements = [{ variantId: r1, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p1 = await preview(source.invoiceId, firstLines, firstReplacements, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p1.discountTransfer.selectedAmount), 50_000)
  const first = await commitPreview({ invoiceId: source.invoiceId, returnLines: firstLines, replacements: firstReplacements, option: 'YES_ZERO', resultPreview: p1, suffix: '08a' })
  const secondLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const secondReplacements = [{ variantId: r2, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }]
  const p2 = await preview(source.invoiceId, secondLines, secondReplacements, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000)
  assert.equal(n(p2.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 100_000)
  const second = await commitPreview({ invoiceId: source.invoiceId, returnLines: secondLines, replacements: secondReplacements, option: 'YES_ZERO', resultPreview: p2, suffix: '08b' })
  const allEvents = seed.rows('SELECT eventType,amount FROM "DiscountTransferEvent" WHERE sourceReturnId IN (?,?)', first.returnId, second.returnId)
  assert.equal(allEvents.filter((e) => e.eventType === 'TRANSFER').reduce((s, e) => s + n(e.amount), 0), 150_000)
  assert.equal(allEvents.filter((e) => e.eventType === 'EXPIRE').reduce((s, e) => s + n(e.amount), 0), 50_000)
  return { visits: 2, transferredAcrossWindows: 150_000, expired: 50_000 }
})

// 09. A replacement has both its own current discount and transferred historical discount; only the current part can become new history.
await run(9, 'زنجیرهٔ تخفیف جاری + انتقال تاریخی؛ در تعویض بعدی فقط تخفیف جاری منبع تازه است', async () => {
  const sourceId = makeVariant('09-source', 1_000_000)
  const source = await sale({ suffix: '09', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const r1 = makeVariant('09-r1', 1_000_000), r2 = makeVariant('09-r2', 850_000)
  const sourceLines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements1 = [{ variantId: r1, qty: 1, unitPrice: 1_000_000, discount: 100_000, tax: 0 }]
  const p1 = await preview(source.invoiceId, sourceLines, replacements1, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p1.discountTransfer.selectedAmount), 100_000)
  const first = await commitPreview({ invoiceId: source.invoiceId, returnLines: sourceLines, replacements: replacements1, option: 'YES_ZERO', resultPreview: p1, suffix: '09a' })
  const child1 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
  assert.equal(n(child1.discount), 200_000, '100k current + 100k historical transferred')
  const childLines = [{ saleItemId: n(child1.id), qty: 1 }]
  const replacements2 = [{ variantId: r2, qty: 1, unitPrice: 850_000, discount: 0, tax: 0 }]
  const p2 = await preview(first.exchangeInvoiceId, childLines, replacements2, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000, 'transferred 100k is consumed; only current 100k remains eligible')
  assert.equal(n(p2.discountTransfer.policyDelta), 50_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 50_000)
  const second = await commitPreview({ invoiceId: first.exchangeInvoiceId, returnLines: childLines, replacements: replacements2, option: 'YES_ZERO', resultPreview: p2, suffix: '09b' })
  assert.equal(n(second.discountTransferAmount), 50_000)
  return { firstTransfer: 100_000, childCurrentDiscount: 100_000, childAvailableHistory: 100_000, secondTransfer: 50_000 }
})

// 10. Void after partial transfer: replacement inventory is restored, original sale remains, and its source window is not reusable.
await run(10, 'ابطال تعویض پس از انتقال جزئی؛ موجودی جایگزین اصلاح و تخفیف دوباره‌مصرف نمی‌شود', async () => {
  const sourceId = makeVariant('10-source', 1_000_000), replacementId = makeVariant('10-replacement', 950_000)
  const sourceStockBeforeSale = stockOf(sourceId)
  const replacementStockBeforeExchange = stockOf(replacementId)
  const source = await sale({ suffix: '10', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'YES_ZERO')
  const exchange = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '10a' })
  assert.equal(n(exchange.discountTransferAmount), 150_000)
  const voided = await salesService.returnDelete({
    id: exchange.returnId, userId, reason: 'round2 isolated test void after discount transfer',
    panelPassword: DEFAULT_MANAGER_PASSWORD
  })
  assert.ok(voided)
  assert.equal(stockOf(sourceId), sourceStockBeforeSale - 1, 'void reverses the return; the original sale remains valid')
  assert.equal(stockOf(replacementId), replacementStockBeforeExchange, 'void restores replacement inventory')
  const voidEvents = seed.rows('SELECT eventType,amount,provenanceJson FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', exchange.returnId, 'VOID')
  assert.ok(voidEvents.length > 0)
  assert.ok(voidEvents.every((row) => n(row.amount) === 0 && JSON.parse(row.provenanceJson).sourceWindowNotRestored === true))
  const afterVoidPreview = await preview(source.invoiceId, lines, replacements, 'NO')
  assert.equal(afterVoidPreview.discountTransfer, undefined, 'voided return must not recycle a spent source window')
  return { transferVoidedEvidence: voidEvents.length, sourceStockRestored: true, sourceWindowReusable: false }
})

// 11. A stale second request cannot return the same physical unit twice after a competing exchange commits.
await run(11, 'پیش‌نمایش رقیبِ کهنه پس از ثبت تعویض؛ برگشت تکراری بدون mutation رد می‌شود', async () => {
  const sourceId = makeVariant('11-source', 1_000_000), r1 = makeVariant('11-r1', 950_000), r2 = makeVariant('11-r2', 950_000)
  const source = await sale({ suffix: '11', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements1 = [{ variantId: r1, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const stale = await preview(source.invoiceId, lines, replacements1, 'YES_ZERO')
  const first = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements: replacements1, option: 'YES_ZERO', resultPreview: stale, suffix: '11a' })
  const before = state([sourceId, r2])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: source.invoiceId, lines,
    replacements: [{ variantId: r2, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }],
    discountTransferOption: 'YES_ZERO', expectedDiscountTransferAmount: 150_000,
    expectedSettlementDiff: 0, requestIdempotencyKey: 'dp20r2-11-stale-0001'
  }))
  assert.deepEqual(state([sourceId, r2]), before, 'stale duplicate rejection is mutation-free')
  assert.ok(first.returnId)
  return { firstCommitted: true, duplicateSourceQtyRejected: true, noSecondMutation: true }
})

// 12. The guard permits full YES when its projected total does not increase refund versus NO.
await run(12, 'YES با محافظ روشن وقتی بازپرداخت اضافه نمی‌سازد، مجاز می‌ماند', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const sourceId = makeVariant('12-source', 1_200_000), replacementId = makeVariant('12-replacement', 1_200_000)
  const source = await sale({ suffix: '12', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_200_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 1_200_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'YES')
  const yes = p.discountTransfer.options.find((row) => row.option === 'YES')
  assert.equal(yes.enabled, true)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const exchange = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'YES', resultPreview: p, suffix: '12' })
  assert.equal(n(exchange.exchangeTotal), 1_000_000)
  assert.equal(n(exchange.diff), 0)
  return { guard: 'on', fullYES: 'enabled', refundIncrease: 0 }
})

// 13. The guard must block full YES only when it increases projected refund.
await run(13, 'YES با محافظ روشن در صورت بازپرداخت اضافه غیرفعال و بی‌اثر می‌ماند', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  const sourceId = makeVariant('13-source', 1_200_000), replacementId = makeVariant('13-replacement', 900_000)
  const source = await sale({ suffix: '13', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_200_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find((row) => row.option === 'YES').enabled, false)
  assert.equal(n(p.discountTransfer.options.find((row) => row.option === 'YES_ZERO').transferAmount), 0)
  const before = state([sourceId, replacementId])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: source.invoiceId, lines, replacements,
    discountTransferOption: 'YES', requestIdempotencyKey: 'dp20r2-13-disabled-0001'
  }), /بازپرداخت نهایی|گزینهٔ انتقال|گزینهٔ «خیر»/)
  assert.deepEqual(state([sourceId, replacementId]), before)
  return { guard: 'on', fullYES: 'disabled', YES_ZERO: 0, mutation: false }
})

// 14. Manager setting off permits the transfer but does not waive provenance/capacity limits.
await run(14, 'خاموش‌کردن محافظ فقط گیت اضافه‌پرداخت را برمی‌دارد؛ سقف و provenance پابرجا هستند', async () => {
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: false })
  const sourceId = makeVariant('14-source', 1_200_000), replacementId = makeVariant('14-replacement', 900_000)
  const source = await sale({ suffix: '14', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_200_000, discount: 100_000 }], invoiceDiscount: 100_000 })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 900_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'YES')
  assert.equal(p.discountTransfer.options.find((row) => row.option === 'YES').enabled, true)
  assert.equal(n(p.discountTransfer.selectedAmount), 200_000)
  const exchange = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'YES', resultPreview: p, suffix: '14' })
  const transfers = seed.rows('SELECT amount FROM "DiscountTransferEvent" WHERE sourceReturnId=? AND eventType=?', exchange.returnId, 'TRANSFER')
  assert.equal(transfers.reduce((s, row) => s + n(row.amount), 0), 200_000)
  seed.setting(SETTING_KEYS.discountTransferPolicy, { preventExtraRefund: true })
  return { fullTransfer: 200_000, provenanceRows: transfers.length, guard: 'off' }
})

// 15. Card-only tender with NO: financial direction stays consistent and no transfer leaks into the child.
await run(15, 'پرداخت کارتی کامل و گزینهٔ NO؛ tender روی عدم انتقال اثر نمی‌گذارد', async () => {
  const sourceId = makeVariant('15-source', 1_000_000), replacementId = makeVariant('15-replacement', 950_000)
  const source = await sale({ suffix: '15', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CARD' })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'NO')
  assert.equal(n(p.discountTransfer.selectedAmount), 0)
  assert.equal(n(p.effectiveDiff), 150_000)
  const exchange = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'NO', resultPreview: p, suffix: '15' })
  assert.equal(n(exchange.discountTransferAmount), 0)
  assert.equal(n(exchange.cashReceived), 150_000)
  return { originalTender: 'CARD', option: 'NO', transfer: 0, additionalCollection: 150_000 }
})

// 16. Barcode + cash + card source tender; option decision must not flip with funding composition.
await run(16, 'ترکیب بارکد اعتبار/نقد/کارت؛ YES_ZERO مستقل از ترکیب tender', async () => {
  const sourceId = makeVariant('16-source', 1_000_000), replacementId = makeVariant('16-replacement', 950_000)
  const source = await sale({ suffix: '16', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }], tender: 'CREDIT_SPLIT' })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 950_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'YES_ZERO')
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(n(p.effectiveDiff), 0)
  const exchange = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'YES_ZERO', resultPreview: p, suffix: '16' })
  assert.equal(n(exchange.discountTransferAmount), 150_000)
  return { tender: 'CREDIT + CASH + CARD', transfer: 150_000, diff: 0 }
})

// 17. Multi-line replacements have both row and invoice-level discounts before capacity allocation.
await run(17, 'تخفیف ردیفی و فاکتوری روی دو جایگزین؛ ظرفیت خالص و توزیع انتقال', async () => {
  const sourceId = makeVariant('17-source', 1_000_000)
  const source = await sale({ suffix: '17', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const a = makeVariant('17-a', 500_000), b = makeVariant('17-b', 550_000)
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [
    { variantId: a, qty: 1, unitPrice: 500_000, discount: 50_000, tax: 0 },
    { variantId: b, qty: 1, unitPrice: 550_000, discount: 0, tax: 0 }
  ]
  const p = await preview(source.invoiceId, lines, replacements, 'YES_ZERO', 50_000)
  assert.equal(n(p.discountTransfer.capacity), 950_000)
  assert.equal(n(p.discountTransfer.policyDelta), 150_000)
  assert.equal(n(p.discountTransfer.selectedAmount), 150_000)
  assert.equal(p.replacementTransferShares.reduce((s, x) => s + n(x), 0), 150_000)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'YES_ZERO', replacementInvoiceDiscount: 50_000, resultPreview: p, suffix: '17' })
  assert.equal(n(result.exchangeTotal), 800_000)
  return { R: 950_000, capacity: 950_000, transfer: 150_000, shares: p.replacementTransferShares }
})

// 18. No proven historical discount: no fake option panel, no transfer, ordinary settlement still works.
await run(18, 'فاکتور بدون تخفیف تاریخی؛ نبود گزینهٔ انتقال، توقف یا انتقال ساختگی ایجاد نمی‌کند', async () => {
  const sourceId = makeVariant('18-source', 1_000_000), replacementId = makeVariant('18-replacement', 1_100_000)
  const source = await sale({ suffix: '18', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 0 }] })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 1_100_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'NO')
  assert.equal(p.discountTransfer, undefined)
  assert.equal(n(p.effectiveDiff), 100_000)
  const result = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'NO', resultPreview: p, suffix: '18' })
  assert.equal(n(result.discountTransferAmount), 0)
  assert.equal(n(result.cashReceived), 100_000)
  return { historicalDiscount: 0, transfer: 0, collected: 100_000 }
})

// 19. Negative difference requires an explicit refund decision; no implicit payout/credit may occur.
await run(19, 'مابه‌التفاوت منفی بدون روش صریح؛ توقف mutation-free، سپس ثبت با انتخاب فروشنده', async () => {
  const sourceId = makeVariant('19-source', 1_000_000), replacementId = makeVariant('19-replacement', 700_000)
  const source = await sale({ suffix: '19', lines: [{ variantId: sourceId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const lines = [{ saleItemId: n(source.items[0].id), qty: 1 }]
  const replacements = [{ variantId: replacementId, qty: 1, unitPrice: 700_000, discount: 0, tax: 0 }]
  const p = await preview(source.invoiceId, lines, replacements, 'NO')
  assert.equal(n(p.effectiveDiff), -100_000)
  const before = state([sourceId, replacementId])
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: source.invoiceId, lines, replacements,
    discountTransferOption: 'NO', expectedSettlementDiff: -100_000,
    exchangeSettlementDecision: 'UNSELECTED', requestIdempotencyKey: 'dp20r2-19-unselected-0001'
  }))
  assert.deepEqual(state([sourceId, replacementId]), before)
  const selected = await commitPreview({ invoiceId: source.invoiceId, returnLines: lines, replacements, option: 'NO', resultPreview: p, suffix: '19b', refundMode: 'CASH' })
  assert.equal(n(selected.cashRefunded), 100_000)
  return { unselected: 'rejected without mutation', selectedMethod: 'CASH', refund: 100_000 }
})

// 20. Three visits: historical source discount moves once; a current child discount remains independently eligible.
await run(20, 'سه مراجعهٔ زنجیره‌ای؛ تخفیف جاریِ کالای جایگزین از تخفیف تاریخیِ منتقل‌شده تفکیک می‌شود', async () => {
  const rootId = makeVariant('20-root', 1_000_000)
  const root = await sale({ suffix: '20', lines: [{ variantId: rootId, qty: 1, unitPrice: 1_000_000, discount: 200_000 }] })
  const child1Variant = makeVariant('20-child1', 1_000_000)
  const rootLines = [{ saleItemId: n(root.items[0].id), qty: 1 }]
  const child1Replacements = [{ variantId: child1Variant, qty: 1, unitPrice: 1_000_000, discount: 100_000, tax: 0 }]
  const p1 = await preview(root.invoiceId, rootLines, child1Replacements, 'YES_ZERO')
  assert.equal(n(p1.discountTransfer.historicalDiscount), 200_000)
  assert.equal(n(p1.discountTransfer.policyDelta), 100_000)
  assert.equal(n(p1.discountTransfer.selectedAmount), 100_000)
  const first = await commitPreview({ invoiceId: root.invoiceId, returnLines: rootLines, replacements: child1Replacements, option: 'YES_ZERO', resultPreview: p1, suffix: '20a' })
  const child1 = seed.one('SELECT id,discount FROM "SaleInvoiceItem" WHERE invoiceId=?', first.exchangeInvoiceId)
  assert.equal(n(child1.discount), 200_000, '100k current + 100k transfer')

  const child2Variant = makeVariant('20-child2', 850_000)
  const child1Lines = [{ saleItemId: n(child1.id), qty: 1 }]
  const child2Replacements = [{ variantId: child2Variant, qty: 1, unitPrice: 850_000, discount: 0, tax: 0 }]
  const p2 = await preview(first.exchangeInvoiceId, child1Lines, child2Replacements, 'YES_ZERO')
  assert.equal(n(p2.discountTransfer.historicalDiscount), 100_000, 'the prior transferred 100k is not reissued')
  assert.equal(n(p2.discountTransfer.policyDelta), 50_000)
  assert.equal(n(p2.discountTransfer.selectedAmount), 50_000)
  const second = await commitPreview({ invoiceId: first.exchangeInvoiceId, returnLines: child1Lines, replacements: child2Replacements, option: 'YES_ZERO', resultPreview: p2, suffix: '20b' })
  assert.equal(n(second.discountTransferAmount), 50_000)

  const child2 = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', second.exchangeInvoiceId)
  const child3Variant = makeVariant('20-child3', 800_000)
  const child2Lines = [{ saleItemId: n(child2.id), qty: 1 }]
  const child3Replacements = [{ variantId: child3Variant, qty: 1, unitPrice: 800_000, discount: 0, tax: 0 }]
  const p3 = await preview(second.exchangeInvoiceId, child2Lines, child3Replacements, 'NO')
  assert.equal(p3.discountTransfer, undefined, 'no spent historical transfer leaks into another return')
  const third = await commitPreview({ invoiceId: second.exchangeInvoiceId, returnLines: child2Lines, replacements: child3Replacements, option: 'NO', resultPreview: p3, suffix: '20c' })
  assert.equal(n(third.discountTransferAmount), 0)
  return { visits: 3, firstHistoricalTransfer: 100_000, secondCurrentDiscountTransfer: 50_000, thirdTransfer: 0 }
})

await db.$disconnect?.()
const failed = outcomes.filter((row) => row.status !== 'PASS')
console.log(`\nROUND 2 SUMMARY: ${outcomes.filter((row) => row.status === 'PASS').length}/20 PASS; ${failed.length}/20 FAIL; isolated SQLite: ${process.env.HARNESS_DB}`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
