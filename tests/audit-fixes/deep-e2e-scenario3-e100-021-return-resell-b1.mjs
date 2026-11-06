import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-021-return-resell-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('E100-021 restricted-credit return/resell cashier')
const cash = seed.insert('PaymentMethod', { key: 'E021-RR-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const n = value => Number(value ?? 0)
const shiftId = seed.insert('Shift', { name: 'E100-021 restricted return/resell', number: 9021, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const category = seed.category('E100-021-return-resell')
let seq = 0
function variant(label, price) {
  const product = seed.product(`E021-RR-${++seq}-${label}`, category)
  const id = seed.variant(product, `E021-RR-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const A = variant('A-200k', 200_000), B = variant('B-200k', 200_000), C = variant('C-300k', 300_000), D = variant('D-300k', 300_000)
const B1 = variant('B1-180k', 180_000), C1 = variant('C1-290k', 290_000), D1 = variant('D1-290k', 290_000)
const aux1 = variant('aux1-25k', 25_000), aux2 = variant('aux2-25k', 25_000)
const variants = [A, B, C, D, B1, C1, D1, aux1, aux2]
const allowedVariantIds = [B, C, D, B1, C1, D1, aux1, aux2].map(v => v.id)
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const rawCredit = id => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,restrictScope,restrictVariantIdsJson,returnId FROM "StoreCredit" WHERE id=?', id)
async function snapshot() {
  return {
    invoices: seed.rows('SELECT id,grandTotal,paidTotal,status FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId).map(r => ({ id: n(r.id), total: n(r.grandTotal), paid: n(r.paidTotal), status: r.status })),
    returns: seed.rows('SELECT id,invoiceId,total,refundMethod,refundAmount,exchangeDiff,exchangeInvoiceId FROM "SaleReturn" WHERE shiftId=? ORDER BY id', shiftId).map(r => ({ id: n(r.id), invoiceId: n(r.invoiceId), total: n(r.total), method: r.refundMethod, refund: n(r.refundAmount), diff: n(r.exchangeDiff), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId) })),
    stocks: variants.map(v => ({ label: v.label, stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock) })),
    credits: seed.rows('SELECT id,amount,usedAmount,usedCount,status,expiresAt,restrictScope,restrictVariantIdsJson,returnId FROM "StoreCredit" ORDER BY id').map(c => ({ id: n(c.id), amount: n(c.amount), used: n(c.usedAmount), usedCount: n(c.usedCount), status: c.status, expiresAt: c.expiresAt == null ? null : n(c.expiresAt), scope: c.restrictScope, variants: c.restrictVariantIdsJson, returnId: c.returnId == null ? null : n(c.returnId) })),
    payments: seed.rows('SELECT p.amount,m.kind FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? ORDER BY p.id', shiftId).map(p => ({ amount: n(p.amount), kind: p.kind })),
    cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId)
  }
}
const issued = []
for (let i = 0; i < 2; i++) {
  const credit = await storeCreditService.issueManual({ amount: 50_000, multiUse: true, maxUses: 10, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, restrictScope: 'VARIANTS', restrictVariantIds: allowedVariantIds })
  issued.push({ id: n(credit.id), code: rawCredit(credit.id).code })
}
const root = await salesService.create({
  userId, shiftId, lines: [A, B, C, D].map(line),
  storeCredits: issued.map(c => ({ code: c.code, requestedAmount: 25_000 })),
  payments: [{ methodId: cash, amount: 950_000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 'e021-rr-root'
})
assert.equal(n(root.grandTotal), 1_000_000)
assert.equal(n(root.storeCreditApplied), 50_000)
assert.equal(n(root.paidTotal), 1_000_000)
const rootItems = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', root.id)
const rootItem = v => rootItems.find(row => n(row.variantId) === v.id)
const auxiliarySale = await salesService.create({
  userId, shiftId, lines: [line(aux1), line(aux2)],
  storeCredits: issued.map(c => ({ code: c.code, requestedAmount: 25_000 })), payments: [],
  saleRequestIdempotencyKey: 'e021-rr-redeem-second-time'
})
assert.equal(n(auxiliarySale.grandTotal), 50_000)
assert.equal(n(auxiliarySale.storeCreditApplied), 50_000)
const afterRootAndSecondRedemption = await snapshot()
const aReturn = await salesService.createReturn({ userId, shiftId, invoiceId: n(root.id), full: false, lines: [{ saleItemId: n(rootItem(A).id), qty: 1 }], refundMethod: 'STORE_CREDIT' })
assert.equal(n(aReturn.total), 200_000)
assert.equal(n(aReturn.sourceCreditRestoredAmount), 0)
const afterAReturn = await snapshot()
let directExchange = null, directError = ''
try {
  directExchange = await salesService.createExchange({ userId, shiftId, invoiceId: n(root.id), lines: [{ saleItemId: n(rootItem(B).id), qty: 1 }], replacements: [line(B1)], refundMode: 'STORE_CREDIT', idempotencyKey: 'e021-rr-direct-b-exchange' })
} catch (error) { directError = String(error?.message ?? error) }
const afterRejectedDirectExchange = await snapshot()
const directExchangeMutationFree = JSON.stringify(afterAReturn) === JSON.stringify(afterRejectedDirectExchange)
assert.equal(directExchange, null, `The expected blocked direct exchange unexpectedly succeeded: ${JSON.stringify(directExchange)}`)
assert.ok(directExchangeMutationFree, 'Rejected direct B exchange changed the isolated database')

const bReturn = await salesService.createReturn({ userId, shiftId, invoiceId: n(root.id), full: false, lines: [{ saleItemId: n(rootItem(B).id), qty: 1 }], refundMethod: 'STORE_CREDIT' })
assert.equal(n(bReturn.total), 200_000)
const bReturnCodes = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,expiresAtJalali,source,restrictScope,restrictVariantIdsJson,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id', bReturn.id).map(r => ({ id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status, expiresAt: r.expiresAt == null ? null : n(r.expiresAt), expiresAtJalali: r.expiresAtJalali, source: r.source, scope: r.restrictScope, variants: r.restrictVariantIdsJson, returnId: n(r.returnId) }))
assert.equal(bReturnCodes.reduce((sum, code) => sum + code.amount, 0), 200_000, 'B return must issue store credit equal to B return total')
assert.ok(bReturnCodes.length > 0)
const afterBReturn = await snapshot()
const physicalReceived = state => state.payments.filter(p => p.kind === 'CASH' || p.kind === 'CARD').reduce((sum, p) => sum + p.amount, 0)
// Mirror the service's FEFO order, then preview each exact requested amount against the remaining balance.
const orderedReturnCodes = [...bReturnCodes].sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY) || a.code.localeCompare(b.code))
let balanceBefore = B1.price, eligibleLineBefore = B1.price
const resalePreviews = []
const codesBeforeSale = []
for (const credit of orderedReturnCodes) {
  const requestedAmount = Math.min(credit.amount, balanceBefore)
  const lineTotal = credit.scope === 'ALL' ? eligibleLineBefore : Math.max(0, eligibleLineBefore)
  const preview = await storeCreditService.preview({ code: credit.code, applicable: balanceBefore, invoiceTotal: B1.price, requested: requestedAmount, lines: [{ variantId: B1.id, qty: 1, lineTotal }], userId })
  resalePreviews.push({ credit, requestedAmount, balanceBefore, preview })
  if (!preview.ok || preview.applied !== requestedAmount) throw new Error(`Read-only preflight says ${credit.code} cannot apply exact requested ${requestedAmount}: ${preview.error}`)
  codesBeforeSale.push({ code: credit.code, requestedAmount })
  balanceBefore -= preview.applied
  if (credit.scope !== 'ALL') eligibleLineBefore = Math.max(0, eligibleLineBefore - preview.applied)
}
const plannedCredit = codesBeforeSale.reduce((sum, x) => sum + x.requestedAmount, 0)
const cashDue = B1.price - plannedCredit
if (cashDue !== 0) throw new Error(`Expected the three actual credits to cover B1 exactly after preview; uncovered=${cashDue}`)
const resale = await salesService.create({ userId, shiftId, lines: [line(B1)], storeCredits: codesBeforeSale, payments: [], saleRequestIdempotencyKey: 'e021-rr-pos-resale-b1' })
assert.equal(n(resale.grandTotal), 180_000)
assert.equal(n(resale.storeCreditApplied), plannedCredit)
assert.equal(n(resale.paidTotal), 180_000)
const resaleRedemptions = seed.rows('SELECT creditId,amount,remainderAfter FROM "StoreCreditRedemption" WHERE invoiceId=? ORDER BY id', resale.id).map(r => ({ creditId: n(r.creditId), amount: n(r.amount), remainderAfter: n(r.remainderAfter) }))
const afterResale = await snapshot()
const oldCodesAfter = issued.map(c => rawCredit(c.id)).map(c => ({ id: n(c.id), amount: n(c.amount), usedAmount: n(c.usedAmount), usedCount: n(c.usedCount), status: c.status, expiresAt: n(c.expiresAt) }))
const checks = {
  directExchangeBlockedForExpectedGate: directError.includes('تخصیص منشأ اعتبار ندارد'),
  rejectedDirectExchangeMutationFree: directExchangeMutationFree,
  fullBReturnIssued200k: bReturnCodes.reduce((sum, c) => sum + c.amount, 0) === 200_000,
  posResaleB1PaidByPreviewedCodes: n(resale.storeCreditApplied) === plannedCredit && n(resale.paidTotal) === 180_000,
  physicalTenderMatchesUncoveredBalance: physicalReceived(afterResale) - physicalReceived(afterBReturn) === cashDue,
  sourceCodesRemainUsed: oldCodesAfter.every(c => c.status === 'USED' && c.usedCount === 2 && c.usedAmount === c.amount),
  stockBalancedForBAndB1: afterResale.stocks.find(s => s.label === 'B-200k').stock === 10 && afterResale.stocks.find(s => s.label === 'B1-180k').stock === 9
}
const report = {
  title: 'E100-021: workaround check after restricted-credit B exchange rejection',
  isolatedDatabase: process.env.HARNESS_DB,
  scope: 'VARIANTS_BCD',
  originalSale: { invoiceId: n(root.id), total: n(root.grandTotal), sourceCreditApplied: n(root.storeCreditApplied), cashPaid: 950_000, barcodeValueEach: 50_000, initialCreditCount: 2, secondRedemptionInvoiceId: n(auxiliarySale.id), secondRedemptionTotal: n(auxiliarySale.storeCreditApplied) },
  priorAReturn: { id: n(aReturn.id), total: n(aReturn.total), refundMethod: aReturn.refundMethod, sourceCreditRestoredAmount: n(aReturn.sourceCreditRestoredAmount), snapshot: afterAReturn },
  rejectedDirectExchange: { message: directError, mutationFree: directExchangeMutationFree },
  fallbackBReturn: { id: n(bReturn.id), total: n(bReturn.total), sourceCreditRestoredAmount: n(bReturn.sourceCreditRestoredAmount), issuedCredits: bReturnCodes, originalCodesAfterReturn: oldCodesAfter, snapshot: afterBReturn },
  posResale: { invoiceId: n(resale.id), total: n(resale.grandTotal), storeCreditApplied: n(resale.storeCreditApplied), paidTotal: n(resale.paidTotal), cashDue, preflight: resalePreviews.map(x => ({ id: x.credit.id, amount: x.credit.amount, source: x.credit.source, scope: x.credit.restrictScope, requestedAmount: x.requestedAmount, balanceBefore: x.balanceBefore, applicable: x.preview.applied, ok: x.preview.ok, error: x.preview.error })), physicalTenderDelta: physicalReceived(afterResale) - physicalReceived(afterBReturn), redemptions: resaleRedemptions, snapshot: afterResale },
  checks, verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'MISMATCH',
  safety: { liveDatabase: false, productionCodeChanged: false, checksOrDebt: false, creditCodesManuallyMerged: false }
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-scenario3-e100-021-return-resell-b1.json'), JSON.stringify(report, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const lines = [
  '# نکتهٔ آموزشی E100-021: برگشت کامل B و فروش دوبارهٔ B1', '',
  `**نتیجه:** ${report.verdict} (${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} تطبیق).`,
  `**DB:** SQLite موقت ایزوله (${report.isolatedDatabase}).`,
  '**آزمایش:** همان fixture محدودشدهٔ VARIANTS_BCD؛ رد تعویض مستقیم B پس از برگشت A را بازتولید کردم، سپس از مسیر رسمی برگشت کامل B به STORE_CREDIT و فروش تازهٔ B1 در POS رفتم.',
  `**فروش اول:** ۱٬۰۰۰٬۰۰۰ = ۵۰٬۰۰۰ اعتبار + ۹۵۰٬۰۰۰ نقد. دو کد چندبارمصرف ۵۰٬۰۰۰تومانی، هر کدام ۲۵٬۰۰۰ روی فروش اول و ۲۵٬۰۰۰ در فروش دوم مصرف شدند. A به مبلغ ۲۰۰٬۰۰۰ با اعتبار فروشگاه برگشت شد؛ سهم اعتبار برگشتی صفر بود.`,
  `**تعویض مستقیم B→B1:** رد شد؛ پیام: ${directError}؛ رد بدون تغییر=${directExchangeMutationFree}.`,
  `**برگشت B:** ${fa(bReturn.total)} با STORE_CREDIT؛ اعتبار منبع برگشتی=${fa(bReturn.sourceCreditRestoredAmount)}؛ کدهای واقعی صادرشده: ${bReturnCodes.map(c => `${fa(c.amount)}، ${c.expiresAt == null ? 'بی‌انقضا' : 'دارای انقضای منبع'}، scope=${c.scope}`).join('؛ ')}.`,
  `**پیش‌نمایش مرحله‌ای POS:** ${resalePreviews.map(x => `کد ${fa(x.credit.amount)}، درخواست ${fa(x.requestedAmount)} وقتی ${fa(x.balanceBefore)} از قیمت مانده بود → قبول ${fa(x.preview.applied)}`).join('؛ ')}.`,`**فروش تازهٔ B1 در POS:** ${fa(resale.grandTotal)}؛ اعتبار مصرفی=${fa(resale.storeCreditApplied)}؛ پرداخت نقدی واقعی=${fa(cashDue)}؛ جمع تسویه=${fa(resale.paidTotal)}؛ redemptionها=${resaleRedemptions.map(r => `${fa(r.amount)} (مانده ${fa(r.remainderAfter)})`).join('، ')}.`,
  '', '## علت پذیرفته‌نشدنِ ۱۵۰٬۰۰۰ در تلاش اول',
  'بارکدهای منبعی تاریخ انقضای نزدیک‌تری داشتند، پس قبل از کد بی‌انقضای پولی مصرف شدند: ۲۵٬۰۰۰+۲۵٬۰۰۰=۵۰٬۰۰۰. از ۱۸۰٬۰۰۰ فقط ۱۳۰٬۰۰۰ می‌ماند. چون runner برای کد ۱۵۰٬۰۰۰ درخواست کامل ۱۵۰٬۰۰۰ فرستاده بود، `decideRedeem` آن را رد کرد؛ درخواست از سقف جاری ۱۳۰٬۰۰۰ بیشتر بود و سرویس آن را خودکار تا ۱۳۰٬۰۰۰ پایین نمی‌آورد. با درخواست درست ۱۳۰٬۰۰۰، هر سه کد دقیقاً ۱۸۰٬۰۰۰ را پوشاندند.',
  '', '## تطبیق',
  '| بررسی | نتیجه |', '|---|---|',
  ...Object.entries(checks).map(([key, value]) => `| ${key} | ${value ? 'PASS' : 'FAIL'} |`),
  '', '## نتیجهٔ آموزشی',
  'یک تلاش مقدماتی هر سه کد را با مبلغ کامل فرستاد: دو کد منبعی ۲۵٬۰۰۰تومانی زودتر (چون انقضایشان نزدیک‌تر بود) مصرف شدند؛ ۵۰٬۰۰۰ از قیمت ۱۸۰٬۰۰۰ کم شد و ۱۳۰٬۰۰۰ باقی ماند. بعد درخواست ۱۵۰٬۰۰۰ از کد پولی از سقف باقی‌ماندهٔ ۱۳۰٬۰۰۰ بیشتر بود، پس موتور اعتبار کل همان درخواست را رد کرد؛ مبلغ درخواستی را خودکار از ۱۵۰ به ۱۳۰ کم نمی‌کند. به همین دلیل فقط ۵۰٬۰۰۰ قابل‌اعمال شد. این اجرا PASS نبود و paidTotal آن تطبیق نشد. در اجرای نهایی، درخواست‌ها دقیق شدند: ۲۵٬۰۰۰ + ۲۵٬۰۰۰ + ۱۳۰٬۰۰۰ = ۱۸۰٬۰۰۰؛ پیش‌نمایش هر مرحله را تأیید کرد و کل فروش با اعتبار تسویه شد. بیست‌هزار از کد پولی باقی ماند. این مسیر مشکلِ تعویض مستقیم را اصلاح نمی‌کند، ولی فروشنده می‌تواند بعد از برگشت کامل B از همین راه POS را کامل ثبت کند. کدهای اصلیِ مصرف‌شده USED ماندند.',
  '', '## ایمنی',
  '- فقط service-layer و SQLite موقت؛ فروش POS service-layer شبیه‌سازی شد، چاپ/تحویل فیزیکی اجرا نشد.',
  '- هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB واقعی، stage، reset یا production change انجام نشد.'
]
writeFileSync(join(out, 'deep-e2e-scenario3-e100-021-return-resell-b1.md'), lines.join('\n') + '\n')
console.log(`E100-021 return/resell workaround: ${report.verdict}; direct blocked mutation-free=${directExchangeMutationFree}; returned codes=${bReturnCodes.map(c => c.amount).join('+')}; resale=${n(resale.grandTotal)}; checks=${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length}`)
await db.$disconnect?.()
if (report.verdict !== 'PASS') process.exitCode = 1
