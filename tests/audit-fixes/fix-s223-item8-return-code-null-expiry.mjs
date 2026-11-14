/**
 * نشست ۲۲۳ · مورد ۸ — کد برگشتِ غیرخالی با تاریخ تهی = بدون انقضا؛
 * پیش‌فرض صدور ۱/۱/۷/۷ روز و تغییر تنظیم فقط روی صدورهای بعدی.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item8-return-code-null-expiry.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item8-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { parseSaleDefaults, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (v) => Number(v ?? 0)
const DAY = 86400_000
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

console.log('\n۱) پیش‌فرض‌های هدف: عادی ۱ روز، راه دور ۷ روز (خرد و عمده)')
{
  const d = parseSaleDefaults({})
  check('returnCodeDays = 1', () => assert.equal(d.returnCodeDays, 1))
  check('returnCodeDaysRemote = 7', () => assert.equal(d.returnCodeDaysRemote, 7))
  check('wholesaleReturnCodeDays = 1', () => assert.equal(d.wholesaleReturnCodeDays, 1))
  check('wholesaleReturnCodeDaysRemote = 7', () => assert.equal(d.wholesaleReturnCodeDaysRemote, 7))
}

const userId = seed.user('تست مورد ۸')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۸')
const productId = seed.product('کالای مورد ۸', category)
let seq = 0
const variant = (price = 100000) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const makeSale = async (key, remote = false) => {
  const v = variant()
  const sale = await salesService.create({
    userId, shiftId, lines: [{ variantId: v, qty: 1, unitPrice: 100000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 100000, destination: 'CASH' }],
    remoteCustomer: remote,
    saleRequestIdempotencyKey: key
  })
  const row = seed.one('SELECT id, returnCode, returnCodeExpiresAt, issuedAt FROM "SaleInvoice" WHERE id = ?', sale.id)
  return { ...row, sale, item: seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id) }
}

console.log('\n۲) صدور پیش‌فرض = ۱ روز؛ مشتری راه دور = ۷ روز')
{
  const normal = await makeSale('s223-item8-normal')
  const days = Math.round((n(normal.returnCodeExpiresAt) - n(normal.issuedAt)) / DAY)
  check('فاکتور عادی مهلت ۱ روزه گرفت', () => assert.equal(days, 1))
  const remote = await makeSale('s223-item8-remote', true)
  const remoteDays = Math.round((n(remote.returnCodeExpiresAt) - n(remote.issuedAt)) / DAY)
  check('مشتری راه دور مهلت ۷ روزه گرفت', () => assert.equal(remoteDays, 7))
}

console.log('\n۳) کد غیرخالی با تاریخ تهی = بدون انقضا')
{
  const inv = await makeSale('s223-item8-nullexpiry')
  sql.prepare('UPDATE "SaleInvoice" SET returnCodeExpiresAt = NULL WHERE id = ?').run(inv.id)
  const lookup = await salesService.findByReturnCode(String(inv.returnCode))
  check('lookup کد را معتبر می‌داند (نه UNPROVEN)', () =>
    assert.equal(lookup.expiryState, 'VALID'))
  const ret = await salesService.createReturn({
    userId, shiftId, invoiceId: n(inv.id), full: true,
    lines: [{ saleItemId: n(inv.item.id), qty: 1 }],
    refundDecision: 'METHOD', refundMethod: 'CASH', refundAmount: 100000
  })
  check('برگشت با کدِ بدون انقضا ثبت شد', () => assert.ok(ret.id))
}

console.log('\n۴) تاریخ صریحِ گذشته همچنان رد می‌شود')
{
  const inv = await makeSale('s223-item8-expired')
  const past = Date.now() - 3 * DAY
  sql.prepare('UPDATE "SaleInvoice" SET returnCodeExpiresAt = ? WHERE id = ?').run(past, inv.id)
  let lookupError = null
  try {
    await salesService.findByReturnCode(String(inv.returnCode))
  } catch (error) {
    lookupError = String(error?.message ?? error)
  }
  check('lookup کد منقضی را با پیام مهلت رد می‌کند', () => {
    assert.ok(lookupError, 'باید رد شود')
    assert.match(lookupError, /به پایان رسیده/)
  })
  let message = null
  try {
    await salesService.createReturn({
      userId, shiftId, invoiceId: n(inv.id), full: true,
      lines: [{ saleItemId: n(inv.item.id), qty: 1 }],
      refundDecision: 'METHOD', refundMethod: 'CASH', refundAmount: 100000
    })
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('ثبت برگشت با کد منقضی رد شد', () => {
    assert.ok(message, 'باید رد شود')
    assert.match(message, /مهلت/)
  })
}

console.log('\n۵) تغییر تنظیم فقط روی صدورهای بعدی اثر دارد')
{
  const before = await makeSale('s223-item8-before-setting')
  const settingsRow = seed.one('SELECT key FROM "Setting" WHERE key = ?', SETTING_KEYS.saleDefaults)
  const value = JSON.stringify({ ...parseSaleDefaults({}), returnCodeDays: 5, returnCodeDaysRemote: 9 })
  if (settingsRow) sql.prepare('UPDATE "Setting" SET value = ? WHERE key = ?').run(value, SETTING_KEYS.saleDefaults)
  else sql.prepare('INSERT INTO "Setting" (key, value) VALUES (?, ?)').run(SETTING_KEYS.saleDefaults, value)
  const after = await makeSale('s223-item8-after-setting')
  const afterDays = Math.round((n(after.returnCodeExpiresAt) - n(after.issuedAt)) / DAY)
  check('فاکتور جدید مهلت ۵ روزه گرفت', () => assert.equal(afterDays, 5))
  check('تاریخ صریحِ فاکتور قبلی بازنویسی نشد', () => {
    const row = seed.one('SELECT returnCodeExpiresAt FROM "SaleInvoice" WHERE id = ?', before.id)
    assert.equal(n(row.returnCodeExpiresAt), n(before.returnCodeExpiresAt))
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
