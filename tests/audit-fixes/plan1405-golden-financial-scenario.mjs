/**
 * طرح ۱۴۰۵ · مرحلهٔ ۰ — «سناریوی طلایی مالی» (معماری §۸-۱).
 *
 * روی پایگاه موقت و ایزوله، با ساعت ساختگی، منطقهٔ زمانی ثابت و اعداد تصادفی با بذر
 * ثابت اجرا می‌شود. خروجی متنی (نقد مورد انتظار، موجودی، اعتبار باز، جمع مبلغ‌ها و
 * ستون‌های مالی ردیف‌ها، بی زمان و بی کد) باید بایت‌به‌بایت با
 * `tests/plan-1405/golden-financial-baseline.txt` برابر باشد.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-golden-financial-scenario.mjs
 *
 * ثبت خروجی پایه فقط یک بار، روی کامیت شروع (src بی‌تغییر):
 *   PLAN1405_GOLDEN_WRITE=1 node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-golden-financial-scenario.mjs
 *
 * همهٔ گیت‌ها با رمز تایپی مدیر یا رمز دوم، مثل امروز، بیرون از IPC صدا زده می‌شوند؛
 * پس پس از هر مرحلهٔ طرح، رفتار و عددها باید همان بمانند.
 */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// ۱) ثابت کردن محیط: منطقهٔ زمانی، اعداد تصادفی و ساعت
// ---------------------------------------------------------------------------
process.env.TZ = 'Asia/Tehran'
let seedState = 0x14050901
const rnd32 = () => {
  seedState = (seedState + 0x6d2b79f5) | 0
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (t ^ (t >>> 14)) >>> 0
}
Math.random = () => rnd32() / 4294967296
const fill = (buf, off = 0, size = buf.length - off) => { for (let i = off; i < off + size; i++) buf[i] = rnd32() & 255; return buf }
crypto.randomBytes = (n, cb) => { const b = fill(Buffer.alloc(n)); if (typeof cb === 'function') { queueMicrotask(() => cb(null, b)); return undefined } return b }
crypto.randomFillSync = (buf, off = 0, size) => fill(buf, off, size ?? buf.length - off)
crypto.randomInt = (a, b, cb) => {
  let min = 0, max = a, done = cb
  if (typeof b === 'number') { min = a; max = b } else if (typeof b === 'function') done = b
  const v = min + (rnd32() % (max - min))
  if (typeof done === 'function') { queueMicrotask(() => done(null, v)); return undefined }
  return v
}
crypto.randomUUID = () => {
  const b = fill(Buffer.alloc(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues = (arr) => { fill(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); return arr }
syncBuiltinESMExports()

const RealDate = Date
let clockMs = RealDate.UTC(2026, 9, 14, 6, 30, 0) // چهارشنبه ۲۲ مهر ۱۴۰۵، ساعت ۱۰:۰۰ تهران
const tick = () => (clockMs += 1)
const advance = (ms) => { clockMs += ms }
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [tick()], newTarget) },
  apply() { return new RealDate(tick()).toString() },
  get(target, prop, receiver) { return prop === 'now' ? () => tick() : Reflect.get(target, prop, receiver) }
})

// ---------------------------------------------------------------------------
// ۲) پایگاه موقت و سرویس‌ها
// ---------------------------------------------------------------------------
const DIR = mkdtempSync(join(tmpdir(), 'mahak-plan1405-golden-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { priceAdjustService } = await import('../../src/main/services/PriceAdjustService.ts')
const { purchaseService } = await import('../../src/main/services/PurchaseService.ts')
const { secondaryStockService } = await import('../../src/main/services/SecondaryStockService.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const tables = db.$harness.tables

const OUT = []
const log = (line) => { OUT.push(line); console.log(line) }
const n = (x) => (x == null ? 0 : Number(x))
const short = (e) => String(e?.message ?? e).split('\n')[0].replace(/\s+/g, ' ').slice(0, 90).trimEnd()
const step = async (label, fn) => {
  try { const r = await fn(); log(`  ${label}: OK`); return r }
  catch (e) { log(`  ${label}: REJECT ${short(e)}`); return null }
}

// ---------------------------------------------------------------------------
// ۳) دادهٔ پایه
// ---------------------------------------------------------------------------
const today = toJalaliDate(new Date())
const userId = seed.user('صندوق‌دار سناریوی طلایی')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
const catWear = seed.category('پوشاک')
const catBag = seed.category('کیف')
const mk = (name, cat, price, stock = 100) => {
  const pid = seed.product(name, cat)
  const id = seed.variant(pid, name)
  sql.prepare('UPDATE "ProductVariant" SET stock = ?, salePrice = ? WHERE id = ?').run(stock, price, id)
  return id
}
const vA = mk('کت', catWear, 1_000_000)
const vB = mk('شلوار', catWear, 700_000)
const vC = mk('پیراهن', catWear, 400_000)
const vD = mk('کیف دستی', catBag, 250_000)
const VARIANTS = { A: vA, B: vB, C: vC, D: vD }
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId, staffConfirmed: 1 })

const debtor = { firstName: 'مشتری', lastName: 'طلایی', phone: '09120000001' }
const L = (v, unitPrice, qty = 1, discount = 0) => ({ variantId: v, qty, unitPrice, discount, tax: 0 })
const payC = (x) => [{ methodId: cash, amount: x, destination: 'CASH' }]
const payK = (x) => [{ methodId: card, amount: x, destination: 'CARD' }]
const itemsOf = (id) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', id)
const itemOfVariant = (id, v) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? AND variantId = ? ORDER BY id DESC LIMIT 1', id, v)?.id
const sale = (label, input) => step(label, () => salesService.create({ debtor, userId, shiftId, ...input }))

// ---------------------------------------------------------------------------
// ۴) عکس وضعیت
// ---------------------------------------------------------------------------
const one = (q, ...p) => seed.one(q, ...p)
async function snapshot(tag) {
  const expected = await cashboxService.expected({ shiftId }).then((r) => n(r?.expectedCash)).catch((e) => `ERR ${short(e)}`)
  const stock = Object.entries(VARIANTS).map(([k, id]) => `${k}=${n(one('SELECT stock FROM "ProductVariant" WHERE id = ?', id)?.stock)}`).join(',')
  const inv = one(`SELECT COUNT(*) c, COALESCE(SUM(grandTotal),0) s FROM "SaleInvoice"`)
  const pay = seed.rows(`SELECT kind, destination, COALESCE(SUM(amount),0) s, COUNT(*) c FROM "Payment" WHERE voidedAt IS NULL GROUP BY kind, destination ORDER BY kind, destination`)
    .map((r) => `${r.kind}/${r.destination}:${n(r.s)}#${n(r.c)}`).join(' ')
  const ret = one(`SELECT COUNT(*) c, COALESCE(SUM(refundAmount),0) s FROM "SaleReturn" WHERE voidedAt IS NULL`)
  const cred = seed.rows(`SELECT status, COUNT(*) c, COALESCE(SUM(amount),0) a, COALESCE(SUM(usedAmount),0) u FROM "StoreCredit" GROUP BY status ORDER BY status`)
    .map((r) => `${r.status}:${n(r.c)}/${n(r.a)}/${n(r.u)}`).join(' ')
  const mov = seed.rows(`SELECT type, COALESCE(SUM(amount),0) s, COUNT(*) c FROM "CashMovement" GROUP BY type ORDER BY type`)
    .map((r) => `${r.type}:${n(r.s)}#${n(r.c)}`).join(' ')
  log(`[${tag}] expectedCash=${expected} stock=${stock} invoices=${n(inv.c)}/${n(inv.s)} returns=${n(ret.c)}/${n(ret.s)}`)
  log(`[${tag}] payments=${pay || '-'}`)
  log(`[${tag}] credits=${cred || '-'} cashMovements=${mov || '-'}`)
}

// ---------------------------------------------------------------------------
// ۵) جریان‌ها
// ---------------------------------------------------------------------------
log('# plan1405 golden financial scenario v1')

log('## A) فروش خرد')
const a1 = await sale('a1 نقد', { lines: [L(vA, 1_000_000)], payments: payC(1_000_000) })
const a2 = await sale('a2 کارت‌خوان', { lines: [L(vB, 700_000)], payments: payK(700_000) })
const a3 = await sale('a3 ترکیبی', { lines: [L(vA, 1_000_000)], payments: [...payC(400_000), ...payK(600_000)] })
const a4 = await sale('a4 نسیه', { lines: [L(vC, 400_000)], payments: [] })
const a5 = await sale('a5 چندقلم', { lines: [L(vA, 1_000_000), L(vB, 700_000)], payments: payC(1_700_000) })
const a6 = await sale('a6 سه عدد', { lines: [L(vC, 400_000, 3)], payments: payC(1_200_000) })
const a7 = await sale('a7 تخفیف ردیف', { lines: [L(vA, 1_000_000, 1, 100_000)], payments: payC(900_000) })
await sale('a8 قیمت کمتر از مرجع بی رمز', { lines: [L(vA, 800_000)], payments: payC(800_000) })
const a8 = await sale('a8 قیمت کمتر از مرجع با رمز مدیر', { lines: [L(vA, 800_000)], payments: payC(800_000), managerPassword: PW })
const a9 = await sale('a9 کیف نقد', { lines: [L(vD, 250_000, 2)], payments: payC(500_000) })
await snapshot('A')

log('## B) پرداخت بعدی و چک')
const f1 = await sale('f1 نسیه', { lines: [L(vC, 400_000)], payments: [] })
if (f1) await step('f1 وصول نقد', () => salesService.addPayment({ invoiceId: f1.id, userId, methodId: cash, amount: 400_000, destination: 'CASH' }))
if (f1) await step('f1 اضافه‌دریافت', () => salesService.addPayment({ invoiceId: f1.id, userId, methodId: cash, amount: 100_000, destination: 'CASH' }))
const f2 = await sale('f2 نسیه برای چک', { lines: [L(vC, 400_000)], payments: [] })
let chequeId = null
if (f2) {
  await step('f2 ثبت چک', () => salesService.addPayment({ invoiceId: f2.id, kind: 'CHEQUE', amount: 400_000, chequeNo: 'G1405', bankName: 'ملت', dueDateJalali: today, userId }))
  chequeId = one(`SELECT id FROM "Payment" WHERE invoiceId = ? AND kind = 'CHEQUE'`, f2.id)?.id ?? null
}
if (chequeId) {
  await step('چک: پاس به مدیر بی رمز', () => salesService.setChequeStatus({ id: chequeId, userId, status: 'CLEARED', destination: 'MANAGER' }))
  await step('چک: پاس به مدیر با رمز', () => salesService.setChequeStatus({ id: chequeId, userId, status: 'CLEARED', destination: 'MANAGER', managerPassword: PW }))
  await step('چک پاس‌شده: ابطال بی رمز', () => salesService.deletePayment({ id: chequeId, userId, reason: 'آزمون' }))
}
const f4 = await sale('f4 نسیه برای جایگزینی چک', { lines: [L(vC, 400_000)], payments: [] })
if (f4) {
  await step('f4 ثبت چک', () => salesService.addPayment({ invoiceId: f4.id, kind: 'CHEQUE', amount: 400_000, chequeNo: 'G1405-2', bankName: 'ملی', dueDateJalali: today, userId }))
  const chq = one(`SELECT id FROM "Payment" WHERE invoiceId = ? AND kind = 'CHEQUE' AND voidedAt IS NULL`, f4.id)?.id
  if (chq) {
    await step('f4 جایگزینی چک بی رمز', () => salesService.replaceCheque({ id: chq, amount: 400_000, chequeNo: 'G1405-3', userId, overrideReason: 'چک مشتری پاره شد' }))
    await step('f4 جایگزینی چک با رمز', () => salesService.replaceCheque({ id: chq, amount: 400_000, chequeNo: 'G1405-3', managerPassword: PW, userId, overrideReason: 'چک مشتری پاره شد' }))
  }
}
if (chequeId) {
  await step('چک پاس‌شده: ویرایش مبلغ بی رمز', () => salesService.updatePayment({ id: chequeId, userId, amount: 390_000 }))
  await step('چک پاس‌شده: ویرایش توضیح با رمز', () => salesService.updatePayment({ id: chequeId, userId, note: 'ویرایش توضیح', managerPassword: PW }))
}
const f3 = await sale('f3 نقد برای ابطال', { lines: [L(vC, 400_000)], payments: payC(400_000) })
if (f3) {
  const live = one('SELECT id FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL', f3.id)
  await step('f3 ابطال نقد بی رمز', () => salesService.deletePayment({ id: live.id, userId, reason: 'آزمون' }))
  await step('f3 ابطال نقد با رمز', () => salesService.deletePayment({ id: live.id, userId, reason: 'ثبت اشتباه', managerPassword: PW, overrideReason: 'ثبت اشتباه' }))
}
await snapshot('B')

log('## C) برگشت')
const bFull = await sale('c1 فروش', { lines: [L(vB, 700_000)], payments: payC(700_000) })
if (bFull) await step('c1 برگشت کامل نقد', () => salesService.createReturn({ invoiceId: bFull.id, full: true, lines: [{ saleItemId: itemsOf(bFull.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId }))
const bTwo = await sale('c2 فروش دوقلم', { lines: [L(vA, 1_000_000), L(vC, 400_000)], payments: payC(1_400_000) })
if (bTwo) await step('c2 برگشت یک قلم', () => salesService.createReturn({ invoiceId: bTwo.id, full: false, lines: [{ saleItemId: itemsOf(bTwo.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId }))
const bNas = await sale('c3 نسیه', { lines: [L(vC, 400_000)], payments: [] })
if (bNas) await step('c3 برگشت نسیه', () => salesService.createReturn({ invoiceId: bNas.id, full: true, lines: [{ saleItemId: itemsOf(bNas.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId }))
const bDisc = await sale('c4 تخفیف‌دار', { lines: [L(vA, 1_000_000, 1, 100_000)], payments: payC(900_000) })
if (bDisc) await step('c4 برگشت تخفیف‌دار', () => salesService.createReturn({ invoiceId: bDisc.id, full: true, lines: [{ saleItemId: itemsOf(bDisc.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId }))
const bCardSale = await sale('c5 فروش کارتی', { lines: [L(vB, 700_000)], payments: payK(700_000) })
if (bCardSale) {
  const ln = [{ saleItemId: itemsOf(bCardSale.id)[0].id, qty: 1 }]
  await step('c5 بازپرداخت کارت‌خوان بی رمز', () => salesService.createReturn({ invoiceId: bCardSale.id, full: true, lines: ln, refundMethod: 'CARD', userId, cardPosOverride: { acknowledgedNoReverse: true, reason: 'مشتری کارت دیگری ندارد' } }))
  await step('c5 بازپرداخت کارت‌خوان با رمز و دلیل', () => salesService.createReturn({ invoiceId: bCardSale.id, full: true, lines: ln, refundMethod: 'CARD', userId, cardPosOverride: { acknowledgedNoReverse: true, reason: 'مشتری کارت دیگری ندارد', managerPassword: PW } }))
}
const bC2C = await sale('c6 فروش برای کارت‌به‌کارت', { lines: [L(vC, 400_000)], payments: payC(400_000) })
if (bC2C) {
  const r = await step('c6 برگشت کارت‌به‌کارت', () => salesService.createReturn({ invoiceId: bC2C.id, full: true, lines: [{ saleItemId: itemsOf(bC2C.id)[0].id, qty: 1 }], refundMethod: 'CARD_TO_CARD', userId, cardTransfer: { cardNumber: '6037991234567890', holderName: 'مشتری طلایی' } }))
  const req = one('SELECT id, amount FROM "CardTransferRequest" ORDER BY id DESC LIMIT 1')
  if (r && req) await step('c6 پرداخت کارت‌به‌کارت با رمز', () => cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: PW, trackingNo: 'G1405-C2C' }))
}
const bOver = await sale('c7 فروش تخفیف فاکتور', { lines: [L(vA, 1_000_000), L(vB, 700_000)], payments: payC(1_700_000) })
await snapshot('C')

log('## D) تعویض')
const e1 = await sale('d1 فروش', { lines: [L(vA, 1_000_000)], payments: payC(1_000_000) })
let ex1 = null
if (e1) {
  sql.prepare('UPDATE "ProductVariant" SET salePrice = 1300000 WHERE id = ?').run(vB)
  ex1 = await step('d1 تعویض گران‌تر با نقد', () => salesService.createExchange({ invoiceId: e1.id, userId, shiftId, lines: [{ saleItemId: itemsOf(e1.id)[0].id, qty: 1 }], replacements: [{ variantId: vB, qty: 1, unitPrice: 1_300_000 }], methodId: cash, destination: 'CASH' }))
  sql.prepare('UPDATE "ProductVariant" SET salePrice = 700000 WHERE id = ?').run(vB)
}
const e2 = await sale('d2 فروش', { lines: [L(vA, 1_000_000)], payments: payC(1_000_000) })
if (e2) await step('d2 تعویض ارزان‌تر بازپرداخت نقد', () => salesService.createExchange({ invoiceId: e2.id, userId, shiftId, lines: [{ saleItemId: itemsOf(e2.id)[0].id, qty: 1 }], replacements: [{ variantId: vB, qty: 1, unitPrice: 700_000 }], refundMode: 'CASH' }))
const e3 = await sale('d3 فروش', { lines: [L(vA, 1_000_000)], payments: payC(1_000_000) })
if (e3) {
  sql.prepare('UPDATE "ProductVariant" SET salePrice = 1000000 WHERE id = ?').run(vC)
  await step('d3 تعویض هم‌قیمت', () => salesService.createExchange({ invoiceId: e3.id, userId, shiftId, lines: [{ saleItemId: itemsOf(e3.id)[0].id, qty: 1 }], replacements: [{ variantId: vC, qty: 1, unitPrice: 1_000_000 }] }))
  sql.prepare('UPDATE "ProductVariant" SET salePrice = 400000 WHERE id = ?').run(vC)
}
const e4 = await sale('d4 فروش کارتی', { lines: [L(vA, 1_000_000)], payments: payK(1_000_000) })
if (e4) {
  const base = { invoiceId: e4.id, userId, shiftId, lines: [{ saleItemId: itemsOf(e4.id)[0].id, qty: 1 }], replacements: [{ variantId: vC, qty: 1, unitPrice: 400_000 }], refundMode: 'CARD' }
  await step('d4 تعویض ارزان‌تر بازپرداخت کارت‌خوان بی رمز', () => salesService.createExchange({ ...base, cardPosOverride: { acknowledgedNoReverse: true, reason: 'تعویض با کارت' } }))
  await step('d4 تعویض ارزان‌تر بازپرداخت کارت‌خوان با رمز', () => salesService.createExchange({ ...base, cardPosOverride: { acknowledgedNoReverse: true, reason: 'تعویض با کارت', managerPassword: PW } }))
}
// تعویض زنجیره‌ای: فاکتور تعویض d1 دوباره تعویض می‌شود و سپس از فاکتور سوم برگشت می‌خورد
const exInv = (r) => n(r?.exchangeInvoiceId ?? 0)
const chain2Inv = ex1 ? exInv(ex1) : 0
let ex2 = null
if (chain2Inv) ex2 = await step('d5 تعویض زنجیره‌ای (فاکتور دوم)', () => salesService.createExchange({ invoiceId: chain2Inv, userId, shiftId, lines: [{ saleItemId: itemOfVariant(chain2Inv, vB), qty: 1 }], replacements: [{ variantId: vD, qty: 1, unitPrice: 250_000 }, { variantId: vB, qty: 1, unitPrice: 700_000 }], refundMode: 'CASH' }))
const chain3Inv = ex2 ? exInv(ex2) : 0
if (chain3Inv) await step('d6 برگشت در فاکتور سوم', () => salesService.createReturn({ invoiceId: chain3Inv, full: false, lines: [{ saleItemId: itemOfVariant(chain3Inv, vD), qty: 1 }], refundMethod: 'CASH', userId }))
log(`  chain: second=${chain2Inv ? 'yes' : 'no'} third=${chain3Inv ? 'yes' : 'no'}`)
await snapshot('D')

log('## E) اعتبار خرید')
const credInv = await sale('e1 فروش', { lines: [L(vB, 700_000)], payments: payC(700_000) })
let credCode = null
if (credInv) {
  await step('e1 برگشت به اعتبار', () => salesService.createReturn({ invoiceId: credInv.id, full: true, lines: [{ saleItemId: itemsOf(credInv.id)[0].id, qty: 1 }], refundMethod: 'STORE_CREDIT', userId }))
  credCode = one('SELECT code FROM "StoreCredit" ORDER BY id DESC LIMIT 1')?.code ?? null
}
if (credCode) await sale('e2 فروش با اعتبار (مصرف یک‌باره)', { lines: [L(vC, 400_000)], payments: [], storeCreditCode: credCode })
await step('e3 صدور دستی بی رمز', () => storeCreditService.issueManual({ amount: 600_000, userId }))
const multi = await step('e3 صدور دستی چندبارمصرف با رمز', () => storeCreditService.issueManual({ amount: 600_000, multiUse: true, maxUses: 3, carryRemainder: true, days: 30, userId, managerPassword: PW }))
const multiCode = multi ? one('SELECT code FROM "StoreCredit" WHERE id = ?', multi.id)?.code : null
if (multiCode) {
  await sale('e4 مصرف اول چندبارمصرف', { lines: [L(vD, 250_000)], payments: [], storeCreditCode: multiCode })
  await sale('e5 مصرف دوم چندبارمصرف', { lines: [L(vD, 250_000)], payments: [], storeCreditCode: multiCode })
}
const expiring = await step('e6 صدور دستی یک‌روزه', () => storeCreditService.issueManual({ amount: 300_000, days: 1, userId, managerPassword: PW }))
const voidable = await step('e7 صدور دستی برای ابطال', () => storeCreditService.issueManual({ amount: 200_000, days: 30, userId, managerPassword: PW }))
if (voidable) {
  await step('e7 ابطال بی رمز', () => storeCreditService.void({ id: voidable.id, userId, reason: 'آزمون ابطال' }))
  await step('e7 ابطال با رمز', () => storeCreditService.void({ id: voidable.id, userId, reason: 'آزمون ابطال', managerPassword: PW }))
}
const deletable = await step('e8 صدور دستی برای حذف', () => storeCreditService.issueManual({ amount: 150_000, days: 30, userId, managerPassword: PW }))
if (deletable) await step('e8 حذف با رمز', () => storeCreditService.remove({ id: deletable.id, userId, reason: 'آزمون حذف', managerPassword: PW }))
await step('e9 تولید گروهی بی رمز', () => storeCreditService.bulkIssue({ count: 2, amountEach: 100_000, userId }))
await step('e9 تولید گروهی با رمز', () => storeCreditService.bulkIssue({ count: 2, amountEach: 100_000, userId, managerPassword: PW }))
if (expiring) sql.prepare('UPDATE "StoreCredit" SET expiresAt = ? WHERE id = ?').run(Date.now() - 24 * 3_600_000, expiring.id)
const expCode = expiring ? one('SELECT code FROM "StoreCredit" WHERE id = ?', expiring.id)?.code : null
if (expCode) await sale('e10 مصرف اعتبار منقضی', { lines: [L(vD, 250_000)], payments: [], storeCreditCode: expCode })
await snapshot('E')

log('## F) اعتبار اضافه‌دریافت و سقف')
const pol = await settingsService.accountingPolicy()
await step('f سقف اعتبار ۲۰۰٬۰۰۰ و قفل دورهٔ بسته با رمز مدیر', () => settingsService.setAccountingPolicy({ policy: { ...pol, storeCreditLimit: 200_000, lockClosedPeriods: true }, userId, managerPassword: PW }))
const half = await sale('f فروش نیمه‌پرداخت', { lines: [L(vA, 1_000_000)], payments: payC(300_000) })
if (half) {
  const ln = [{ saleItemId: itemsOf(half.id)[0].id, qty: 1 }]
  await step('f برگشت با اضافه‌دریافت بالاتر از سقف بی رمز', () => salesService.createReturn({ invoiceId: half.id, full: true, lines: ln, refundMethod: 'NONE', noRefundReason: 'اعتبار مشتری', userId, confirmOverpay: true, overpayAsCredit: true }))
  await step('f برگشت با اضافه‌دریافت بالاتر از سقف با رمز', () => salesService.createReturn({ invoiceId: half.id, full: true, lines: ln, refundMethod: 'NONE', noRefundReason: 'اعتبار مشتری', userId, confirmOverpay: true, overpayAsCredit: true, overpayManagerPassword: PW }))
}
await snapshot('F')

log('## G) اصلاح برگشت')
const g1 = await sale('g1 فروش', { lines: [L(vB, 700_000)], payments: payC(700_000) })
const g1r = g1 ? await step('g1 برگشت نقد', () => salesService.createReturn({ invoiceId: g1.id, full: true, lines: [{ saleItemId: itemsOf(g1.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId })) : null
const g1rid = g1r ? n(g1r.id ?? g1r.returnId) : 0
if (g1rid) {
  await step('g1 حذف برگشت بی رمز', () => salesService.returnDelete({ id: g1rid, userId, reason: 'آزمون حذف برگشت' }))
  await step('g1 اصلاح جبرانی با رمز', () => salesService.returnReconcileVoid({ id: g1rid, userId, reason: 'اصلاح جبرانی سناریوی طلایی؛ وجه برگشت', panelPassword: PW, cashRecovered: 700_000, creditOutcome: 'NONE' }))
}
const g2 = await sale('g2 فروش نسیه', { lines: [L(vC, 400_000)], payments: [] })
const g2r = g2 ? await step('g2 برگشت نسیه‌ای بی بازپرداخت', () => salesService.createReturn({ invoiceId: g2.id, full: true, lines: [{ saleItemId: itemsOf(g2.id)[0].id, qty: 1 }], refundMethod: 'CASH', userId })) : null
const g2rid = g2r ? n(g2r.id ?? g2r.returnId) : 0
if (g2rid) await step('g2 حذف برگشت با رمز', () => salesService.returnDelete({ id: g2rid, userId, reason: 'آزمون حذف برگشت', panelPassword: PW }))
await snapshot('G')

log('## H) انبار مرکزی، تغییر قیمت گروهی، فاکتور خرید')
await step('h انبار مرکزی: ثبت کالا', () => secondaryStockService.upsert({ name: 'شلوار مرکزی طلایی', code: 'G1405W', qty: 10, minQty: 2, userId }))
const adj = { kind: 'DISCOUNT', mode: 'PERCENT', value: 10, scope: 'CATEGORY', categoryId: catBag, target: 'SALE', userId, password: PW, note: 'سناریوی طلایی' }
await step('h تغییر قیمت گروهی: پیش‌نمایش', () => priceAdjustService.preview(adj))
await step('h تغییر قیمت گروهی: اعمال', () => priceAdjustService.apply(adj))
log(`  price D=${n(one('SELECT salePrice FROM "ProductVariant" WHERE id = ?', vD)?.salePrice)}`)
await sale('h فروش کیف پس از تغییر قیمت', { lines: [L(vD, n(one('SELECT salePrice FROM "ProductVariant" WHERE id = ?', vD)?.salePrice))], payments: payC(n(one('SELECT salePrice FROM "ProductVariant" WHERE id = ?', vD)?.salePrice)) })
await step('h فاکتور خرید نقدی', () => purchaseService.create({ settlementType: 'CASH', lines: [{ variantId: vD, qty: 5, unitPrice: 150_000 }], userId, panelPassword: PW }))
await snapshot('H')

log('## K) بستن صندوق')
const counted = await cashboxService.expected({ shiftId }).then((r) => n(r?.expectedCash)).catch(() => 0)
await step('k بستن صندوق وسط روز', () => cashboxService.close({ shiftId, explicitShift: true, userId, countedCash: counted, closeShift: false, note: 'سناریوی طلایی' }))
await step('k بستن دوباره', () => cashboxService.close({ shiftId, explicitShift: true, userId, countedCash: counted, closeShift: false, note: 'دوباره' }))
await step('k بستن دوباره با تأیید', () => cashboxService.close({ shiftId, explicitShift: true, userId, countedCash: counted, closeShift: false, note: 'دوباره', allowRepeatClose: true }))
const late = a5 ? itemsOf(a5.id)[0]?.id : null
if (late) {
  await step('k برگشت پس از بستن بی رمز دوره', () => salesService.createReturn({ invoiceId: a5.id, lines: [{ saleItemId: late, qty: 1 }], refundMethod: 'CASH', userId }))
}
await step('k بستن پایانی شیفت', () => cashboxService.close({ shiftId, explicitShift: true, userId, countedCash: counted, closeShift: true, note: 'پایان روز', allowRepeatClose: true }))
const oldPay = a9 ? one('SELECT id FROM "Payment" WHERE invoiceId = ? AND voidedAt IS NULL', a9.id)?.id : null
if (oldPay) {
  await step('k ابطال پرداخت دورهٔ بسته بی رمز', () => salesService.deletePayment({ id: oldPay, userId, reason: 'ثبت اشتباه' }))
  await step('k ابطال پرداخت دورهٔ بسته با رمز', () => salesService.deletePayment({ id: oldPay, userId, reason: 'ثبت اشتباه', managerPassword: PW, overrideReason: 'اصلاح پس از بستن صندوق' }))
}
await snapshot('K')

// ---------------------------------------------------------------------------
// ۶) ستون‌های مالی همهٔ ردیف‌ها (بی زمان، بی کد، بی یادداشت)
// ---------------------------------------------------------------------------
const DROP = /(At|Date|Time|time|date)$|^(code|barcode|publicReference|note|notes|reason|hash|salt|token|uuid|idempotencyKey|meta|json|snapshot|payload|before|after|voidedReason|overrideReason|cardNumber|trackingNo|holderName|phone|reference)$|Hash$|Json$|Snapshot$|Key$/
const TABLES = ['SaleInvoice', 'SaleInvoiceItem', 'Payment', 'SaleReturn', 'SaleReturnItem', 'StoreCredit', 'StoreCreditRedemption', 'CashMovement', 'CardTransferRequest', 'StockMovement', 'ProductVariant', 'CashSession', 'PurchaseInvoice', 'PurchaseInvoiceItem', 'SecondaryStockItem', 'Shift']
log('## Z) ردیف‌ها')
for (const t of TABLES) {
  const meta = tables.get(t)
  if (!meta) { log(`${t}: (no table)`); continue }
  const cols = [...meta.columns.keys()].filter((c) => !DROP.test(c) && !String(meta.columns.get(c).type).match(/DATE|TIME/))
  const rows = seed.rows(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${t}" ORDER BY id`)
  log(`${t} (${rows.length}) cols=${cols.join(',')}`)
  for (const r of rows) log('  ' + cols.map((c) => (r[c] == null ? '' : String(r[c]))).join('|'))
}

// ---------------------------------------------------------------------------
// ۷) مقایسه با خروجی پایه
// ---------------------------------------------------------------------------
const baselinePath = resolve('tests/plan-1405/golden-financial-baseline.txt')
const text = OUT.join('\n') + '\n'
writeFileSync(join(DIR, 'golden-output.txt'), text, 'utf8')
if (process.env.PLAN1405_GOLDEN_WRITE === '1') {
  mkdirSync(resolve('tests/plan-1405'), { recursive: true })
  writeFileSync(baselinePath, text, 'utf8')
  console.log(`\n✓ خروجی پایه نوشته شد: ${baselinePath} (${OUT.length} خط)`)
} else {
  let base = null
  try { base = readFileSync(baselinePath, 'utf8') } catch { /* نبود */ }
  if (base === null) { console.log('\n✗ خروجی پایه پیدا نشد'); process.exit(1) }
  if (base === text) console.log(`\n✓ سناریوی طلایی بایت‌به‌بایت برابر خروجی پایه است (${OUT.length} خط)`)
  else {
    const a = base.split('\n'), b = text.split('\n')
    const i = a.findIndex((x, k) => x !== b[k])
    console.log(`\n✗ سناریوی طلایی با خروجی پایه فرق دارد؛ نخستین خط متفاوت: ${i + 1}`)
    console.log(`  پایه : ${a[i]}`)
    console.log(`  اکنون: ${b[i]}`)
    console.log(`  خروجی کامل: ${join(DIR, 'golden-output.txt')}`)
    process.exit(1)
  }
}
