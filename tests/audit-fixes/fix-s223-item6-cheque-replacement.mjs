/**
 * نشست ۲۲۳ · مورد ۶ — جایگزینی اتمیک چک با مبلغ دقیق.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item6-cheque-replacement.mjs
 *
 * قواعد آزموده‌شده:
 *   • مبلغ چک جدید دقیقاً برابر مبلغ هدف؛ کمتر/بیشتر با اختلاف دقیق و بدون mutation رد می‌شود.
 *   • فقط چک «در جریان»/«برگشت‌خورده»؛ چک پاس‌شده یا باطل‌شده هرگز.
 *   • پرداخت جدید + ابطال قبلی اتمیک‌اند؛ شکست ⇒ چک قبلی دست‌نخورده.
 *   • در تعویض با D>0، مابه‌التفاوت فقط یک‌بار به چک جایگزین اضافه می‌شود.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item6-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

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
const rejectsWith = async (label, fn, pattern) => {
  try {
    await fn()
    bad++
    console.log(`  ✗ ${label} — هیچ خطایی پرتاب نشد`)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (pattern.test(message)) {
      ok++
      console.log(`  ✓ ${label} (${message.split('\n')[0].slice(0, 90)}…)`)
    } else {
      bad++
      console.log(`  ✗ ${label} — پیام نامنتظره: ${message.split('\n')[0]}`)
    }
  }
}

const userId = seed.user('تست مورد ۶')
const shiftId = seed.insert('Shift', {
  name: 'صبح', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 3600_000, userId
})
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const category = seed.category('دستهٔ مورد ۶')
const productId = seed.product('کالای مورد ۶', category)
let seq = 0
const variant = (price) => {
  const id = seed.variant(productId, `سایز ${++seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 10, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const paymentRow = (id) => seed.one('SELECT * FROM "Payment" WHERE id = ?', id)
const paymentCount = () => n(seed.count('Payment'))

const addCheque = async (invoiceId, amount, chequeNo) => {
  const res = await salesService.addPayment({
    userId,
    invoiceId,
    kind: 'CHEQUE',
    amount,
    chequeNo,
    dueDateJalali: toJalaliDate(new Date())
  })
  return Number(res?.payment?.id ?? res?.id ?? seed.one('SELECT id FROM "Payment" WHERE invoiceId = ? ORDER BY id DESC LIMIT 1', invoiceId).id)
}

console.log('\n۱) جمع tenderها در فروش اولیه دقیق است (نقد + چک + نسیه)')
{
  const v = variant(1000)
  const sale = await salesService.create({
    userId,
    shiftId,
    debtor: { firstName: 'مریم', lastName: 'رضایی', phone: '09120000000' },
    lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 300, destination: 'CASH' }],
    allowPartial: true,
    saleRequestIdempotencyKey: 's223-item6-total-ok'
  })
  const chq = await addCheque(Number(sale.id), 200, 'CHQ-600')
  const pays = seed.rows('SELECT amount FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL', Number(sale.id))
  const paid = pays.reduce((sum, row) => sum + n(row.amount), 0)
  check('۳۰۰ نقد + ۲۰۰ چک + ۵۰۰ نسیه = ۱٬۰۰۰', () => {
    assert.ok(chq > 0)
    assert.equal(paid, 500)
    assert.equal(1000 - paid, 500)
  })
}

console.log('\n۲) جایگزینی ساده: مبلغ دقیق، چک قبلی باطل، ردیف جدید با زنجیره')
let original = null
{
  const v = variant(1000)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: 1000, destination: 'CASH' }],
    saleRequestIdempotencyKey: 's223-item6-base'
  })
  // پرداخت کامل نقدی، بعد چک جای پرداخت نقدی؟ برای سادگی: فاکتور دوم با چک کامل
  const v2 = variant(2000)
  const sale2 = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v2, qty: 1, unitPrice: 2000, discount: 0, tax: 0 }],
    payments: [],
    debtor: { firstName: 'علی', lastName: 'کریمی', phone: '09121110000' },
    allowPartial: true,
    saleRequestIdempotencyKey: 's223-item6-cheque-sale'
  })
  const chequeId = await addCheque(Number(sale2.id), 2000, 'CHQ-700')
  original = { invoiceId: Number(sale2.id), chequeId }

  const before = paymentCount()
  await rejectsWith('مبلغ کمتر رد می‌شود', () => salesService.replaceCheque({
    id: chequeId, amount: 1900, chequeNo: 'CHQ-701', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'چک مشتری پاره شد'
  }), /اختلاف ۱۰۰ ریال/)
  check('مبلغ کمتر هیچ ردیفی نساخت', () => assert.equal(paymentCount(), before))
  check('چک قبلی هنوز در جریان است', () => {
    const row = paymentRow(chequeId)
    assert.equal(row.voidedAt, null)
    assert.equal(row.chequeStatus, 'PENDING')
  })

  await rejectsWith('مبلغ بیشتر رد می‌شود', () => salesService.replaceCheque({
    id: chequeId, amount: 2100, chequeNo: 'CHQ-701', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'چک مشتری پاره شد'
  }), /اختلاف ۱۰۰ ریال/)

  const auditBefore = n(seed.count('AuditLog', "entity = 'Payment'"))
  const replaced = await salesService.replaceCheque({
    id: chequeId,
    amount: 2000,
    chequeNo: 'CHQ-701',
    bankName: 'ملت',
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    userId,
    overrideReason: 'چک قبلی پاره شد و مشتری چک نو داد'
  })
  check('چک جدید ۲٬۰۰۰ ریالی ثبت شد', () => assert.equal(n(replaced.amount), 2000))
  const newRow = paymentRow(n(replaced.paymentId))
  check('ردیف جدید: PENDING و اشاره به چک قبلی', () => {
    assert.equal(newRow.kind, 'CHEQUE')
    assert.equal(newRow.chequeStatus, 'PENDING')
    assert.equal(n(newRow.amount), 2000)
    assert.equal(n(newRow.replacedChequeId), chequeId)
    assert.equal(n(newRow.invoiceId), original.invoiceId)
    assert.equal(newRow.chequeNo, 'CHQ-701')
  })
  check('چک قبلی باطل شد با دلیل فارسی', () => {
    const old = paymentRow(chequeId)
    assert.ok(old.voidedAt)
    assert.match(String(old.voidReason), /CHQ-701/)
    assert.match(String(old.voidReason), /پاره/)
  })
  check('یک ردیف Audit برای جایگزینی نوشته شد', () => {
    assert.equal(n(seed.count('AuditLog', "entity = 'Payment'")), auditBefore + 1)
  })
  check('فقط یک ردیف پرداخت اضافه شد (چک + جایگزین)', () => {
    assert.equal(n(seed.count('Payment', 'invoiceId = ?', original.invoiceId)), 2)
  })

  await rejectsWith('جایگزینیِ چکِ باطل‌شده رد می‌شود', () => salesService.replaceCheque({
    id: chequeId, amount: 2000, chequeNo: 'CHQ-702', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'دوباره'
  }), /باطل/)
  await rejectsWith('مبلغ صفر رد می‌شود', () => salesService.replaceCheque({
    id: n(replaced.paymentId), amount: 0, chequeNo: 'CHQ-703', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'صفر'
  }), /بزرگ‌تر از صفر/)
  await rejectsWith('بدون رمز مدیر رد می‌شود', () => salesService.replaceCheque({
    id: n(replaced.paymentId), amount: 2000, chequeNo: 'CHQ-704', userId, overrideReason: 'بدون رمز'
  }), /رمز|رمز مدیر/)
}

console.log('\n۳) وضعیت‌ها: پاس‌شده قابل جایگزینی نیست، برگشت‌خورده هست')
{
  const v = variant(1500)
  const sale = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 1500, discount: 0, tax: 0 }],
    payments: [],
    debtor: { firstName: 'سعید', lastName: 'نوری', phone: '09121230000' },
    allowPartial: true,
    saleRequestIdempotencyKey: 's223-item6-status'
  })
  const clearedId = await addCheque(Number(sale.id), 1500, 'CHQ-800')
  const bouncedId = Number((await salesService.addPayment({
    userId, invoiceId: Number(sale.id), kind: 'CHEQUE', amount: 0 ?? undefined, chequeNo: 'x'
  }).catch(() => null))?.payment?.id ?? 0)
  void bouncedId
  // چک دوم: همان مبلغ صفر مجاز نیست؛ یک چک ۵۰۰ ریالی اضافه‌دریافتی نمی‌خواهیم، پس
  // فقط همان چک را «برگشت خورده» می‌کنیم و بعد جایگزین می‌کنیم.
  await salesService.setChequeStatus({
    id: clearedId, status: 'CLEARED', destination: 'MANAGER', managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  await rejectsWith('چک پاس‌شده رد می‌شود', () => salesService.replaceCheque({
    id: clearedId, amount: 1500, chequeNo: 'CHQ-801', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'چک پاس‌شده'
  }), /پاس‌شده/)

  const v2 = variant(900)
  const sale2 = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v2, qty: 1, unitPrice: 900, discount: 0, tax: 0 }],
    payments: [],
    debtor: { firstName: 'نگار', lastName: 'شاهی', phone: '09121234000' },
    allowPartial: true,
    saleRequestIdempotencyKey: 's223-item6-bounced'
  })
  const chqId = await addCheque(Number(sale2.id), 900, 'CHQ-900')
  await salesService.setChequeStatus({
    id: chqId, status: 'BOUNCED', managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  const replaced = await salesService.replaceCheque({
    id: chqId, amount: 900, chequeNo: 'CHQ-901', managerPassword: DEFAULT_MANAGER_PASSWORD, userId,
    overrideReason: 'چک برگشت خورد؛ چک نو گرفتیم'
  })
  check('چک برگشت‌خورده جایگزین شد', () => assert.equal(n(replaced.amount), 900))
  check('وضعیت قبلی در تاریخچه گذارها حفظ شده است', () => {
    const hist = seed.rows('SELECT status FROM "PaymentChequeStatusHistory" WHERE paymentId = ? ORDER BY id', chqId)
    assert.ok(hist.some((row) => row.status === 'BOUNCED'))
  })
}

console.log('\n۴) تعویض: D دوباره به چک اضافه نمی‌شود (D همان لحظه دریافت شده است)')
{
  const v = variant(1000)
  const source = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId: v, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [],
    debtor: { firstName: 'حسن', lastName: 'مرادی', phone: '09121235000' },
    allowPartial: true,
    saleRequestIdempotencyKey: 's223-item6-exchange-source'
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', Number(source.id))
  const chequeId = await addCheque(Number(source.id), 1000, 'CHQ-1000')
  const expensive = variant(1600)
  const exchange = await salesService.createExchange({
    invoiceId: Number(source.id),
    lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
    replacements: [{ variantId: expensive, qty: 1, unitPrice: 1600, discount: 0, tax: 0 }],
    methodId: cash,
    destination: 'CASH',
    userId,
    shiftId,
    requestIdempotencyKey: 's223-item6-exchange-D'
  })
  const exInvoiceId = Number(exchange.exchangeInvoiceId)
  const exRow = seed.one('SELECT exchangeDiff FROM "SaleReturn" WHERE exchangeInvoiceId = ?', exInvoiceId)
  check('مابه‌التفاوت تعویض ۶۰۰ و همان لحظه نقد دریافت شد', () => {
    assert.equal(n(exRow.exchangeDiff), 600)
    const pays = seed.rows('SELECT amount, kind FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL', exInvoiceId)
    assert.ok(pays.some((row) => n(row.amount) === 600), JSON.stringify(pays))
    const exInvoice = seed.one('SELECT grandTotal, settledAt FROM "SaleInvoice" WHERE id = ?', exInvoiceId)
    assert.ok(exInvoice.settledAt != null, 'سند تعویض نباید بدهی باز داشته باشد')
    assert.equal(pays.reduce((sum, row) => sum + n(row.amount), 0), n(exInvoice.grandTotal))
  })

  const before = paymentCount()
  await rejectsWith('افزودن دوبارهٔ D به چک جایگزین رد می‌شود', () => salesService.replaceCheque({
    id: chequeId, amount: 1600, chequeNo: 'CHQ-1001', exchangeInvoiceId: exInvoiceId,
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId, overrideReason: 'تعویض گران‌تر'
  }), /دریافت می‌شود|مجاز نیست/)
  check('رد شدن هیچ ردیفی نساخت و چک قبلی در جریان ماند', () => {
    assert.equal(paymentCount(), before)
    assert.equal(paymentRow(chequeId).voidedAt, null)
  })

  const replaced = await salesService.replaceCheque({
    id: chequeId, amount: 1000, chequeNo: 'CHQ-1002',
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId, overrideReason: 'چک پاره شد'
  })
  check('جایگزینی ساده همان ۱٬۰۰۰ ریال است (بدون D)', () => {
    assert.equal(n(replaced.targetAmount), 1000)
    assert.equal(n(replaced.amount), 1000)
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
