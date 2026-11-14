/**
 * نشست ۲۲۳ · مورد ۱۰ — در انقضای برابر، ترتیب ورود فروشنده تعیین‌کننده است؛
 * کد/شناسه هرگز tie-break نیست و retry پس از commit فروش دوم نمی‌سازد.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item10-pos-input-order.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item10-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { posMultiCreditPlan } = await import('../../src/shared/posMultiCreditPlan.ts')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

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

console.log('\n۱) planner مشترک POS: ترتیب ورود، نه کد الفبایی')
{
  const row = (id, code) => ({
    id,
    code,
    expiresAt: '1404/09/01',
    restrictScope: 'ALL',
    preview: { ok: true, applied: 100000, eligibleVariantIds: [] }
  })
  // کد «A» الفبایی اول است ولی دوم وارد شده؛ مصرف باید با ترتیب ورود باشد.
  const plan = posMultiCreditPlan({
    payable: 150000,
    rows: [row('first', 'ZZZ999'), row('second', 'AAA111')],
    lines: [{ variantId: 1, lineTotal: 150000 }],
    requestedInput: null
  })
  check('ردیف اول ۱۰۰٬۰۰۰ و ردیف دوم ۵۰٬۰۰۰ می‌گیرد', () =>
    assert.deepEqual(plan.appliedById, { first: 100000, second: 50000 }))
  check('مبلغ مصرف‌شده و نقد باقی‌مانده درست است', () => {
    assert.equal(plan.applied, 150000)
    assert.equal(plan.cashDue, 0)
  })

  const reversed = posMultiCreditPlan({
    payable: 150000,
    rows: [row('second', 'AAA111'), row('first', 'ZZZ999')],
    lines: [{ variantId: 1, lineTotal: 150000 }],
    requestedInput: null
  })
  check('ورودی برعکس، تخصیص را برعکس می‌کند', () =>
    assert.deepEqual(reversed.appliedById, { second: 100000, first: 50000 }))
}

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('تست مورد ۱۰')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const category = seed.category('دستهٔ مورد ۱۰')
const productId = seed.product('کالای مورد ۱۰', category)
const variant = () => {
  const id = seed.variant(productId, `سایز ${Math.random().toString(36).slice(2, 7)}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = 150000 WHERE id = ?').run(id)
  return id
}
const issue = async (amount) => {
  const issued = await storeCreditService.issueManual({
    amount, multiUse: false, carryRemainder: true, days: 30, userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  // DTO صدور فقط شناسه را برمی‌گرداند؛ کدِ قابل‌مصرف از همان رکورد خوانده می‌شود.
  const row = seed.one('SELECT id, code FROM "StoreCredit" WHERE id = ?', n(issued.id))
  return { id: n(row.id), code: row.code }
}
const usage = (id) => {
  const row = seed.one('SELECT code, amount, usedAmount, usedCount, status FROM "StoreCredit" WHERE id = ?', n(id))
  return { code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount), status: row.status }
}

console.log('\n۲) commit واقعی: دو بارکد ۱۰۰٬۰۰۰ هم‌انقضا و فاکتور ۱۵۰٬۰۰۰')
{
  const first = await issue(100000)
  const second = await issue(100000)
  const v = variant()
  const creditsBefore = n(seed.count('StoreCredit'))
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 150000, discount: 0, tax: 0 }],
    payments: [],
    storeCredits: [{ code: first.code }, { code: second.code }],
    saleRequestIdempotencyKey: 's223-item10-order-ab'
  })
  check('فاکتور ۱۵۰٬۰۰۰ با اعتبار تسویه شد', () => assert.equal(n(sale.grandTotal), 150000))
  const u1 = usage(first.id)
  const u2 = usage(second.id)
  check('بارکد اول کامل مصرف شد (۱۰۰٬۰۰۰)', () => {
    assert.equal(u1.usedAmount, 100000)
    assert.equal(u1.status, 'USED')
  })
  check('بارکد دوم ۵۰٬۰۰۰ مصرف و ۵۰٬۰۰۰ روی همان ID/کد با PARTIALLY_USED ماند', () => {
    assert.equal(u2.usedAmount, 50000)
    assert.equal(u2.usedCount, 1)
    assert.equal(u2.status, 'PARTIALLY_USED')
    assert.equal(u2.code, second.code)
  })
  check('بارکد جانشین/تازه‌ای ساخته نشد؛ مانده روی همان کد ماند', () =>
    assert.equal(n(seed.count('StoreCredit')), creditsBefore))

  console.log('\n۳) ورودی برعکس، نتیجهٔ برعکس')
  const third = await issue(100000)
  const fourth = await issue(100000)
  await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: variant(), qty: 1, unitPrice: 150000, discount: 0, tax: 0 }],
    payments: [],
    storeCredits: [{ code: fourth.code }, { code: third.code }],
    saleRequestIdempotencyKey: 's223-item10-order-ba'
  })
  const u3 = usage(third.id)
  const u4 = usage(fourth.id)
  check('بارکدِ دومِ ورودی کامل مصرف شد و اولی ۵۰٬۰۰۰', () => {
    assert.equal(u4.usedAmount, 100000)
    assert.equal(u3.usedAmount, 50000)
  })

  console.log('\n۴) retry پس از commit با ترتیب متفاوت: replay بدون فروش دوم')
  const invoicesBefore = n(seed.count('SaleInvoice'))
  const redemptionsBefore = n(seed.count('StoreCreditRedemption'))
  const replay = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 150000, discount: 0, tax: 0 }],
    payments: [],
    storeCredits: [{ code: second.code }, { code: first.code }],
    saleRequestIdempotencyKey: 's223-item10-order-ab'
  })
  check('پاسخ replay با همان فاکتور اول است', () => {
    assert.equal(n(replay.id), n(sale.id))
    assert.equal(replay.idempotentReplay, true)
  })
  check('هیچ فاکتور/مصرف دوم ساخته نشد', () => {
    assert.equal(n(seed.count('SaleInvoice')), invoicesBefore)
    assert.equal(n(seed.count('StoreCreditRedemption')), redemptionsBefore)
  })
  check('مصرف بارکدها پس از retry تغییر نکرد', () => {
    assert.deepEqual(usage(first.id), u1)
    assert.deepEqual(usage(second.id), u2)
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
