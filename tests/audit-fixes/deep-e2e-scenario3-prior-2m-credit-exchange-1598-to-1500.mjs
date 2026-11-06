import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-prior-2m-credit-exchange-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const { tehranEndOfDayAfter } = await import('../../src/shared/tehranTime.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('E100 prior 2m barcode exchange cashier')
const cash = seed.insert('PaymentMethod', { key: 'E3-2M-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const n = value => Number(value ?? 0)
const shiftId = seed.insert('Shift', { name: 'E100 prior 2m credit, 50m invoice, 980k exchange', number: 9303, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const category = seed.category('E100-prior-2m-credit-exchange')
let seq = 0
function variant(label, price) {
  const product = seed.product(`E3-2M-${++seq}-${label}`, category)
  const id = seed.variant(product, `E3-2M-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
const A = variant('return-item-15980000', 15_980_000)
const B = variant('other-goods-14020000', 14_020_000)
const C = variant('other-goods-20000000', 20_000_000)
const A1 = variant('replacement-15000000', 15_000_000)
const items = [A, B, C, A1]
const line = item => ({ variantId: item.id, qty: 1, unitPrice: item.price, discount: 0, tax: 0 })
const originalCredit = await storeCreditService.issueManual({
  amount: 2_000_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
  userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note: 'E100 prior credit supplied before 50m multi-item purchase'
})
const originalRaw = () => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,source,restrictScope,restrictVariantIdsJson,returnId FROM "StoreCredit" WHERE id=?', originalCredit.id)
const originalBefore = originalRaw()
assert.equal(n(originalBefore.amount), 2_000_000)
assert.equal(originalBefore.restrictScope, 'ALL')
const root = await salesService.create({
  userId, shiftId, lines: [A, B, C].map(line),
  storeCredits: [{ code: originalBefore.code, requestedAmount: 2_000_000 }],
  payments: [{ methodId: cash, amount: 48_000_000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 'e3-prior-2m-root-50m'
})
assert.equal(n(root.grandTotal), 50_000_000)
assert.equal(n(root.storeCreditApplied), 2_000_000)
assert.equal(n(root.paidTotal), 50_000_000)
const sourceLines = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', root.id)
const sourceItem = item => sourceLines.find(row => n(row.variantId) === item.id)
const rootInvoice = seed.one('SELECT id,grandTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE id=?', root.id)
const originalAfterSale = originalRaw()
assert.equal(originalAfterSale.status, 'USED')

const beforeExchange = {
  invoice: seed.one('SELECT grandTotal,paidTotal,status FROM "SaleInvoice" WHERE id=?', root.id),
  originalCredit: originalRaw(),
  stocks: items.map(item => ({ label: item.label, stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', item.id).stock) })),
  cashRefunds: n(seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN (\'RETURN_REFUND\',\'EXCHANGE_REFUND\')', shiftId).amount)
}
const exchange = await salesService.createExchange({
  userId, shiftId, invoiceId: n(root.id),
  lines: [{ saleItemId: n(sourceItem(A).id), qty: 1 }],
  replacements: [line(A1)],
  refundMode: 'CASH',
  idempotencyKey: 'e3-prior-2m-exchange-1598-to-1500'
})
const originalAfterExchange = originalRaw()
const successorRows = seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,source,restrictScope,restrictVariantIdsJson,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id', exchange.returnId)
  .map(row => ({ id: n(row.id), code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount), status: row.status, expiresAt: row.expiresAt == null ? null : n(row.expiresAt), expiresAtJalali: row.expiresAtJalali, source: row.source, scope: row.restrictScope, variants: row.restrictVariantIdsJson, returnId: n(row.returnId) }))
const allocationRows = seed.rows('SELECT id,invoiceId,returnId,redemptionId,sourceCreditId,amount,creditRestored,saleItemId,restrictScope FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', exchange.returnId)
  .map(row => ({ id: n(row.id), invoiceId: n(row.invoiceId), returnId: n(row.returnId), redemptionId: n(row.redemptionId), sourceCreditId: n(row.sourceCreditId), amount: n(row.amount), creditRestored: !!row.creditRestored, saleItemId: row.saleItemId == null ? null : n(row.saleItemId), restrictScope: row.restrictScope }))
const cashRefundTotal = n(seed.one('SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN (\'RETURN_REFUND\',\'EXCHANGE_REFUND\')', shiftId).amount)
const exchangeReturn = seed.one('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeDiff,exchangeSettlement,exchangeCreditReversed FROM "SaleReturn" WHERE id=?', exchange.returnId)
const childInvoice = seed.one('SELECT id,grandTotal,paidTotal,status,settledAt,sourceInvoiceId,exchangeReturnId FROM "SaleInvoice" WHERE id=?', exchange.exchangeInvoiceId)
const checks = {
  originalInvoiceIs50m: n(rootInvoice.grandTotal) === 50_000_000,
  creditUsedAs2mTender: n(root.storeCreditApplied) === 2_000_000 && originalAfterSale.status === 'USED',
  realCashReceived48m: beforeExchange.invoice.paidTotal === 50_000_000 && n(seed.one('SELECT COALESCE(SUM(p.amount),0) amount FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? AND m.kind=\'CASH\'', shiftId).amount) === 48_000_000,
  exchangedItemValue1598m: n(exchange.returnTotal) === 15_980_000,
  replacementValue15m: n(exchange.exchangeTotal) === 15_000_000,
  differenceNegative980k: n(exchange.diff) === -980_000,
  sourceCreditRestored980k: n(exchange.sourceCreditRestoredAmount) === 980_000,
  oneFreshSuccessor980k: successorRows.length === 1 && successorRows[0].amount === 980_000,
  old2mCodeStaysUsed: originalAfterExchange.status === 'USED' && n(originalAfterExchange.usedAmount) === 2_000_000,
  successorKeepsSourceExpiry: successorRows.length === 1 && successorRows[0].expiresAt === n(originalBefore.expiresAt),
  noCashRefundBecauseSurplusWasCreditBacked: cashRefundTotal === 0 && n(exchange.cashRefunded) === 0,
  exchangeReturnsStoreCredit: String(exchange.refundMode) === 'STORE_CREDIT' && String(exchangeReturn.refundMethod) === 'STORE_CREDIT',
  allocationIsInvoicePoolNotItemShare: allocationRows.length === 1 && allocationRows[0].amount === 980_000 && allocationRows[0].saleItemId === null,
  replacementInvoicePaid: n(childInvoice.grandTotal) === 15_000_000 && n(childInvoice.paidTotal) === 15_000_000 && childInvoice.settledAt != null,
  stockReturnedAndReplacementSold: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', A.id).stock) === 10 && n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', A1.id).stock) === 9,
  noOtherProductChanged: [B, C].every(item => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', item.id).stock) === 9)
}
assert.ok(Object.values(checks).every(Boolean), `E100 amount exchange checks: ${JSON.stringify(checks)}; exchange=${JSON.stringify({diff:exchange.diff,refundMode:exchange.refundMode,cashRefunded:exchange.cashRefunded,sourceCreditRestoredAmount:exchange.sourceCreditRestoredAmount,newStoreCreditAmount:exchange.newStoreCreditAmount})}`)
const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  assumptions: {
    invoiceMeaning: '50,000,000 gross sale; prior 2,000,000 store-credit barcode is a tender; customer pays the remaining 48,000,000 cash. Thus the POS invoice grandTotal remains 50,000,000 and is fully paid.',
    sourceBarcode: { id: n(originalBefore.id), code: originalBefore.code, amount: n(originalBefore.amount), statusAfterUse: originalAfterSale.status, scope: originalBefore.restrictScope, expiry: originalBefore.expiresAtJalali },
    sourceScope: 'ALL invoice-wide pool; no item-level attribution is assigned.'
  },
  originalSale: { invoiceId: n(root.id), items: [A, B, C].map(item => ({ label: item.label, price: item.price })), total: n(root.grandTotal), creditApplied: n(root.storeCreditApplied), actualCashPaid: 48_000_000, paidTotal: n(root.paidTotal), settled: rootInvoice.settledAt != null },
  exchange: {
    originalItem: { label: A.label, price: A.price }, replacement: { label: A1.label, price: A1.price },
    returnId: n(exchange.returnId), exchangeInvoiceId: n(exchange.exchangeInvoiceId), returnTotal: n(exchange.returnTotal), exchangeTotal: n(exchange.exchangeTotal), diff: n(exchange.diff),
    requestedRefundMode: 'CASH', appliedRefundMode: exchange.refundMode, settlement: exchange.settlement,
    cashRefunded: n(exchange.cashRefunded), cardRefunded: n(exchange.cardRefunded), realMoneyRefundAmount: n(exchange.realMoneyRefundAmount),
    sourceCreditRestoredAmount: n(exchange.sourceCreditRestoredAmount), newStoreCreditAmount: n(exchange.newStoreCreditAmount),
    sourceSuccessors: exchange.sourceCreditSuccessors?.map(code => ({ id: n(code.id), amount: n(code.amount), expiresAt: code.expiresAt, status: code.status })) ?? [],
    allocationRows, successorRows, originalCodeAfter: { id: n(originalAfterExchange.id), amount: n(originalAfterExchange.amount), usedAmount: n(originalAfterExchange.usedAmount), status: originalAfterExchange.status, expiresAt: originalAfterExchange.expiresAtJalali },
    childInvoice: { id: n(childInvoice.id), total: n(childInvoice.grandTotal), paid: n(childInvoice.paidTotal), status: childInvoice.status, settled: childInvoice.settledAt != null },
    cashRefundTotalAfterExchange: cashRefundTotal, checks
  },
  verdict: 'PASS',
  safety: { liveDatabase: false, productionCodeChanged: false, cashRefund: cashRefundTotal, unpaidInvoices: 0, checksOrDebt: false }
}
const out = resolve(process.cwd(), 'reports')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-scenario3-prior-2m-credit-exchange-1598-to-1500.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = value => Number(value ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مبلغی: اعتبار قبلی ۲٬۰۰۰٬۰۰۰، خرید ۵۰٬۰۰۰٬۰۰۰ و تعویض ۱۵٬۹۸۰٬۰۰۰ به ۱۵٬۰۰۰٬۰۰۰', '',
  `**نتیجه:** PASS؛ ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} تطبیق درست.`, 
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,
  '**فرض ثبت:** منظور از ۴۸٬۰۰۰٬۰۰۰، مبلغ نقدیِ باقی‌مانده پس از مصرف بارکد ۲٬۰۰۰٬۰۰۰ است؛ جمع فاکتور فروش در دفتر POS برابر ۵۰٬۰۰۰٬۰۰۰ می‌ماند.',
  '',
  '## فروش اولیه',
  '- اقلام: کالای برگشتی ۱۵٬۹۸۰٬۰۰۰ + کالای دیگر ۱۴٬۰۲۰٬۰۰۰ + کالای دیگر ۲۰٬۰۰۰٬۰۰۰ = **۵۰٬۰۰۰٬۰۰۰**.',
  '- بارکد قبلی ۲٬۰۰۰٬۰۰۰ به‌عنوان اعتبار عادی `ALL` مصرف شد؛ مشتری ۴۸٬۰۰۰٬۰۰۰ نقد پرداخت کرد. فاکتور ۵۰٬۰۰۰٬۰۰۰ کامل تسویه شد.',
  `- بعد از فروش اولیه، کد اصلی ${originalBefore.code} با مبلغ ۲٬۰۰۰٬۰۰۰ وضعیت ${originalAfterSale.status} داشت.`,
  '',
  '## تعویض',
  `- کالای ${fa(A.price)} برگشت و کالای ${fa(A1.price)} جایگزین شد. اختلاف: **${fa(A.price)} − ${fa(A1.price)} = ${fa(-n(exchange.diff))}** به نفع مشتری.`,
  '- درخواست برگشت نقدی بررسی شد؛ سیستم هیچ وجه نقدی برنگرداند، چون ماندهٔ ۹۸۰٬۰۰۰ از سهم اعتبار منبعی آمده بود، نه از وجه نقد واقعی.',
  `- سیستم سهم اعتبار اولیه را در کل فاکتور (ALL) محاسبه کرد: ۲٬۰۰۰٬۰۰۰ اعتبار از ۱۵٬۹۸۰٬۰۰۰ برگشتی باز شد؛ ۱۳٬۹۸۰٬۰۰۰ سهم پول واقعی بود. جایگزین ۱۵٬۰۰۰٬۰۰۰ ابتدا ۱۳٬۹۸۰٬۰۰۰ پولی و سپس ۱٬۰۲۰٬۰۰۰ اعتباری را پوشاند؛ بنابراین **۹۸۰٬۰۰۰ اعتبار منبعی** باقی ماند.`,
  `- کد اصلی ۲٬۰۰۰٬۰۰۰ با وضعیت 'USED' ماند؛ یک جانشین تازهٔ **۹۸۰٬۰۰۰** با همان انقضای منبع ساخته شد. سهم آن در allocation به‌صورت invoice-pool با saleItemId برابر null ثبت شد، نه سهم اختصاصیِ آن کالا.`, 
  '',
  '## نتیجهٔ عددی',
  '| مورد | نتیجهٔ واقعی |', '|---|---:|',
  '| جمع فاکتور اولیه | ۵۰٬۰۰۰٬۰۰۰ |',
  '| اعتبار قبلی مصرف‌شده | ۲٬۰۰۰٬۰۰۰ |',
  '| پول واقعی پرداخت‌شده | ۴۸٬۰۰۰٬۰۰۰ |',
  '| ارزش برگشتی/جایگزین | ۱۵٬۹۸۰٬۰۰۰ / ۱۵٬۰۰۰٬۰۰۰ |',
  '| اختلاف قیمت | ۹۸۰٬۰۰۰ |',
  '| بازپرداخت نقدی | ۰ |',
  '| اعتبار جانشین برای مشتری | ۹۸۰٬۰۰۰ |',
  '| وضعیت کد اصلی | USED باقی ماند |',
  '',
  '## ایمنی و محدودیت',
  '- فقط service-layer و SQLite موقت ایزوله؛ هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB واقعی، stage یا reset اجرا نشد.',
  '- هیچ production code تغییر نکرد.',
  '- اگر منظور از «فاکتور ۴۸٬۰۰۰٬۰۰۰» قیمت نهایی خودِ فاکتور پس از تخفیف بوده، نه وجهی که پس از اعتبار پرداخت شده، آن تعبیر نیازمند سناریوی جداست؛ در POS بارکد اعتبار tender است و grandTotal را پایین نمی‌آورد.'
]
writeFileSync(join(out, 'deep-e2e-scenario3-prior-2m-credit-exchange-1598-to-1500.md'), md.join('\n') + '\n')
console.log(`Prior 2m barcode exchange: PASS; invoice=50m; credit=2m; cash=48m; diff=980k; cashRefund=${cashRefundTotal}; sourceSuccessor=${n(exchange.sourceCreditRestoredAmount)}; oldCode=${originalAfterExchange.status}`)
await db.$disconnect?.()
if (!Object.values(checks).every(Boolean)) process.exitCode = 1
