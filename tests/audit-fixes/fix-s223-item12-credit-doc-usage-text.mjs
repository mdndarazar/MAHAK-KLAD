/**
 * نشست ۲۲۳ · مورد ۱۲ — متن دفعات مصرف فقط از سند اعتبارِ جایگزینِ وجه حذف می‌شود.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item12-credit-doc-usage-text.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item12-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (v) => Number(v ?? 0)
let ok = 0
let bad = 0
const check = (label, fn) => {
  try {
    fn()
    ok++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    bad++
    console.log(`  ✗ ${label} — ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const userId = seed.user('تست مورد ۱۲')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۱۲')
const productId = seed.product('کالای مورد ۱۲', category)
const variantId = seed.variant(productId, 'سایز ۱')
sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = 100000 WHERE id = ?').run(variantId)

const sale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 100000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 100000, destination: 'CASH' }],
  saleRequestIdempotencyKey: 's223-item12-sale'
})
const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id)

console.log('\n۱) اعتبار صادرشده به‌جای وجه بازپرداخت')
const returned = await salesService.createReturn({
  userId,
  shiftId,
  invoiceId: n(sale.id),
  full: true,
  lines: [{ saleItemId: n(item.id), qty: 1 }],
  refundMethod: 'STORE_CREDIT',
  refundAmount: 100000,
  creditDays: 30
})
const creditRow = seed.one('SELECT * FROM "StoreCredit" WHERE returnId = ?', returned.return?.id ?? returned.id)
assert.ok(creditRow, 'باید اعتبارِ برگشتی صادر شده باشد')
const creditId = n(creditRow.id)
const before = {
  amount: n(creditRow.amount),
  maxUses: n(creditRow.maxUses),
  multiUse: n(creditRow.multiUse),
  carryRemainder: n(creditRow.carryRemainder),
  status: creditRow.status,
  expiresAt: creditRow.expiresAt
}
const refundHtml = await printService.creditHtml(creditId)

check('سند اعتبارِ جایگزینِ وجه «دفعات مجاز» ندارد', () =>
  assert.equal(refundHtml.includes('دفعات مجاز'), false))
check('سند اعتبارِ جایگزینِ وجه «یک‌بارمصرف» ندارد', () =>
  assert.equal(refundHtml.includes('یک‌بارمصرف'), false))
check('سند اعتبارِ جایگزینِ وجه «چندبارمصرف» ندارد', () =>
  assert.equal(refundHtml.includes('چندبارمصرف'), false))
check('مبلغ سند همان مقدار دیتابیس است', () =>
  assert.ok(refundHtml.includes('100,000') || refundHtml.includes('۱۰۰٬۰۰۰'), 'مبلغ باید روی سند باشد'))
check('کد اعتبار روی سند هست', () => assert.ok(refundHtml.includes(String(creditRow.code))))

console.log('\n۲) اعتبار دستی (خارج از دامنهٔ مورد ۱۲) دست‌نخورده می‌ماند')
const manual = await storeCreditService.issueManual({
  amount: 50000,
  multiUse: false,
  carryRemainder: true,
  days: 30,
  userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD
})
const manualHtml = await printService.creditHtml(n(manual.id))
check('اعتبار دستی «دفعات مجاز» را نشان می‌دهد', () =>
  assert.ok(manualHtml.includes('دفعات مجاز')))
check('اعتبار دستی «یک‌بارمصرف» را نشان می‌دهد', () =>
  assert.ok(manualHtml.includes('یک‌بارمصرف')))

console.log('\n۳) چاپ، هیچ metadata یا رفتاری را عوض نمی‌کند')
const after = seed.one('SELECT amount, maxUses, multiUse, carryRemainder, status, expiresAt FROM "StoreCredit" WHERE id = ?', creditId)
check('مبلغ/دفعات/انقضا/وضعیت ثابت ماند', () =>
  assert.deepEqual(
    {
      amount: n(after.amount),
      maxUses: n(after.maxUses),
      multiUse: n(after.multiUse),
      carryRemainder: n(after.carryRemainder),
      status: after.status,
      expiresAt: after.expiresAt
    },
    before
  ))
check('status اعتبار ACTIVE است', () => assert.equal(after.status, 'ACTIVE'))

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
