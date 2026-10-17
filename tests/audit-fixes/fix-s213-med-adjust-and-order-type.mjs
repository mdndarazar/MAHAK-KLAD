/**
 * نشست ۲۱۳ · MED-1 سقف اصلاح مثبت کارت‌به‌کارت · MED-2 allowlist نوع فروش.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s213-med-adjust-and-order-type.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s213-med-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())

let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — انتظار ${JSON.stringify(want)}، دریافت ${JSON.stringify(got)}`) }
}
const rejects = async (label, fn, needle) => {
  try {
    await fn()
    bad++
    console.log(`  ✗ ${label} — هیچ خطایی پرتاب نشد`)
  } catch (e) {
    const m = String(e?.message ?? e)
    if (needle && !m.includes(needle)) {
      bad++
      console.log(`  ✗ ${label} — پیام «${m.split('\\n')[0]}» شامل «${needle}» نبود`)
    } else { ok++; console.log(`  ✓ ${label}`) }
  }
}

const userId = seed.user('مدیر ۲۱۳ متوسط')
const product = seed.product('شلوار', seed.category('پوشاک'))
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3600_000, userId })
const v = seed.variant(product, 'L')
sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = 1000 WHERE id = ?').run(v)

console.log('\\nMED-1) اصلاح مثبت کارت‌به‌کارت از سقف درخواست رد شود')
const inv = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }]
})
const ret = await salesService.createReturn({
  invoiceId: inv.id,
  full: true,
  refundMethod: 'CARD_TO_CARD',
  userId
})
// The issued request is already linked atomically to the financial right.
// Creating a SECOND orphan request here would masquerade as a legacy return
// and bypass the post-cutover bank-evidence guard.
const req = ret.cardTransfer
eq('درخواست یکتا همراه برگشت و دفتر حق ثبت شده است', !!req?.id, true)
const declared = await cardTransferService.pay({ id: req.id, paidAmount: 600, userId, managerPassword: PW })
eq('ثبت عدد پرداخت شاهد بانک نیست', declared.bankEvidenceState, 'UNKNOWN_BANK')
await rejects('اصلاح ۵۰۰ بیش از سقف درخواست بدون شاهد بانک رد می‌شود',
  () => cardTransferService.adjust({ id: req.id, amount: 500, reason: 'اضافه بی‌سقف', userId, managerPassword: PW }),
  'دفتر حق مالی')
await rejects('حتی اصلاح ۴۰۰ زیر سقف نیز پیش از شاهد بانک حق تازه باز نمی‌کند',
  () => cardTransferService.adjust({ id: req.id, amount: 400, reason: 'تا سقف', userId, managerPassword: PW }),
  'دفتر حق مالی')
eq('خالص اعلام‌شده همان ۶۰۰ است، حق مالی همچنان قفل', Number(sql.prepare(
  `SELECT COALESCE(SUM(COALESCE(paidAmount, amount)), 0) AS n FROM "CardTransferRequest" WHERE id = ? OR adjustsRequestId = ?`
).get(req.id, req.id)?.n), 600)

console.log('\\nMED-2) نوع فروش جعلی رد شود و فیش مصرف نشود')
const beforeNo = Number(sql.prepare('SELECT COUNT(*) AS n FROM "SaleInvoice"').get()?.n ?? 0)
const beforeStock = Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id = ?').get(v)?.stock)
await rejects(
  'orderType ساختگی رد می‌شود',
  () => salesService.create({
    userId,
    shiftId,
    orderType: 'NOT_A_REAL_ORDER_TYPE',
    lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }]
  }),
  'نوع فروش'
)
await rejects(
  'EXCHANGE از مسیر فروش عادی رد می‌شود',
  () => salesService.create({
    userId,
    shiftId,
    orderType: 'EXCHANGE',
    lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }]
  }),
  'نوع فروش'
)
eq('فاکتور جعلی ساخته نشد', Number(sql.prepare('SELECT COUNT(*) AS n FROM "SaleInvoice"').get()?.n ?? 0), beforeNo)
eq('موجودی کم نشد', Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id = ?').get(v)?.stock), beforeStock)

console.log(`\\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
if (bad) process.exit(1)
