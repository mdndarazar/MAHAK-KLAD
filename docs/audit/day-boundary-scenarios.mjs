/**
 * آزمون «مرز روز و تجمیع» — آزمون ۲۰۲۶-۱۱-۲۶ (دفتر آزمون مالک: ۴-۴۱، ۴-۱۱۱، ۴-۱۱۲، ۴-۱۱۳ و بند ۱۴).
 *
 * شرط مالک (پس از ثبت ۴-۱۱۱): «به هیچ عنوان نباید تجمیع و انتقال فروش رو قفل کند مثلا صبح که فروشنده شیفت اول
 * صندوق رو باز میکنه یا فروشنده ای که شیفتش ساعت 24 به بعد هست وقتی صندوق رو باز میکنه اگر تجمیع و انتقال زده شده
 * باشه نباید فروش رو قفل کنه و باعث بشه تا فروشنده منتظر مدیر باشه»؛ و همراه «ثبت کن»: هر ویرایش فاکتور که رمز
 * مدیر می‌خواهد، مجوز راه دور با تأیید ربات تلگرام و بله هم داشته باشد (۴-۱۱۳).
 *
 * همه‌چیز از همان کانال‌های IPC صفحه‌ها می‌رود (همان قفل‌ها، رمزها و حضانت صندوق مثل فروشگاه مالک) و ساعت
 * شبیه‌سازی می‌شود (ساعت دیواری تهران؛ `Date` پیش از بارگذاری برنامه جایگزین می‌شود و هارنس هم زمان ردیف‌ها را از
 * همان می‌گیرد). روزها نسبی‌اند: D0 امروزِ اجرا، D1 فردا و… . شش داستان:
 *   S1  شب «بستن نهایی»، رایانه خاموش، صبح تجمیع خودکار (همان سرویس F11 با کاربر سیستم، شبیه ۴-۱۱۱) و شیفت اول.
 *   S2  شب کسی «بستن نهایی» نزد: بستن خودکار حضانت، تجمیع خودکار، شمارش شاهد صبح، شیفت اول.
 *   S3  تجمیع خودکار ساعت ۲۴ و باز کردن صندوق پس از ۲۴ (فروش، تعویض فاکتور ۲۳:۵۰، صفحهٔ عمدهٔ باز مانده).
 *   S4  مدیر ساعت ۲۳:۰۰ F11 می‌زند (صفحه امروز را خودش تیک می‌زند)؛ ساعت آخر روز؛ سپس پس از ۲۴.
 *   S5  F11 ساعت ۰۰:۳۰ (پس از ۲۴؛ روز تازه تیک می‌خورد)؛ سپس شیفت اول صبح.
 *   S6  ویرایش‌هایی که مدیر را صدا می‌زنند: فاکتور تجمیع‌شده (۴-۱۱۲)، فاکتور روز بسته و پرداخت با تاریخ روز بسته
 *       (۴-۱۱۳)، و «قیمت کمتر از قیمت مرجع» (امروز با پنجرهٔ قفل و مجوز یک‌باره درست است). «مجوز راه دور» با همان
 *       «مجوز یک‌باره»ای ساخته می‌شود که تأیید گوشی یا دکمهٔ «✅ تأیید» ربات می‌سازد (`addOneShotTicket` در
 *       `CloudSyncService.ts` ⇐ `addGateTicket(..., 'REMOTE_GRANT')`).
 *
 * انتظار هر گام همان قاعدهٔ مالک است (بند ۱۲ و ۱۴): باز کردن صندوق، فروش، برگشت، تعویض و دریافت نسیه پس از هر نوع
 * تجمیع ⇐ ثبت؛ ویرایش فاکتور تجمیع‌شده ⇐ رد با پاسخ درست، بی صدا زدن مدیر؛ ویرایش رمزدار ⇐ رد با پنجرهٔ قفل
 * (`GATE_REQUIRED`) و پس از مجوز یک‌باره ⇐ ثبت. «یافته»ها همان بندهای ثبت‌شده‌اند (ستون آخر هر گام):
 *   UNEXPECTED_REFUSAL         کاری که باید ثبت شود رد شد
 *   NO_LOCK_WINDOW             رد رمزدار بی کد `GATE_REQUIRED` (پنجرهٔ قفل و راه مجوز باز نمی‌شود)
 *   MISLEADING_MANAGER_PROMPT  فاکتور تجمیع‌شده نخست «رمز مدیر و دلیل» می‌خواهد، با این‌که با رمز هم ویرایش نمی‌شود
 *   ACCEPTED_BUT_SHOULD_REFUSE / REFUSAL_NOT_ATOMIC / MONEY_OR_STOCK_TOUCHED
 * پس از اجرای این بندها همین ابزار باید فقط تفاوت‌های خواسته‌شدهٔ همان‌ها را نشان دهد و یافته‌ها صفر شوند.
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده و پوشهٔ موقت؛ به برنامه، پایگاه واقعی یا آزمون‌های
 * مخزن دست نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/day-boundary-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی شناسه و بی تاریخ؛ روزها نسبی) برای مقایسه
 *   ... --compare docs/audit/day-boundary-scenarios-2026-11-26.json
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_VERBOSE=1  ریز هر گام
 */
// ---------------------------------------------------------------- ساعت شبیه‌سازی‌شده (پیش از بارگذاری برنامه)
const RealDate = Date
let OFFSET = 0
function FakeDate(...a) {
  if (!new.target) return new RealDate(RealDate.now() + OFFSET).toString()
  return a.length === 0 ? new RealDate(RealDate.now() + OFFSET) : new RealDate(...a)
}
FakeDate.prototype = RealDate.prototype
FakeDate.now = () => RealDate.now() + OFFSET
FakeDate.parse = RealDate.parse
FakeDate.UTC = RealDate.UTC
Object.defineProperty(FakeDate, Symbol.hasInstance, { value: (x) => x instanceof RealDate })
globalThis.Date = FakeDate
const setNow = (ms) => { OFFSET = ms - RealDate.now() }

import { register } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
const VERBOSE = process.env.AUD_VERBOSE === '1'
register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)
const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
const dir = mock.state.userData
mkdirSync(join(dir, 'data'), { recursive: true })
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'data', 'shop.db')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 777120, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)

const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const { toJalaliDate, jalaliAddDays, jalaliStartOfDay } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const { cashboxService } = await imp('/src/main/services/CashboxService.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')
const { periodLockService } = await imp('/src/main/services/PeriodLockService.ts')
const { addGateTicket, clearGateTickets } = await imp('/src/main/services/locks/tickets.ts')

const db = harnessClient()
/** دفتر `_prisma_migrations` مثل پایگاه واقعی (همان کار ابزار بستن صندوق). */
{
  const migDir = findMigrationsDir()
  db.$harness.db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`)
  const { createHash, randomUUID } = await import('node:crypto')
  for (const name of readdirSync(migDir).filter((x) => existsSync(join(migDir, x, 'migration.sql'))).sort()) {
    const raw = readFileSync(join(migDir, name, 'migration.sql'))
    db.$harness.db.prepare(`INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count") VALUES (?,?,current_timestamp,?,1)`)
      .run(randomUUID(), createHash('sha256').update(raw).digest('hex'), name)
  }
}
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (x) => Number(x ?? 0)

// ---------------------------------------------------------------- ساعت دیواری تهران، روزهای نسبی
const D0 = toJalaliDate(new Date())
const day = (k) => jalaliAddDays(D0, k)
const rel = (j) => { for (let k = -40; k <= 40; k++) if (jalaliAddDays(D0, k) === j) return 'D' + k; return String(j) }
const wall = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return jalaliStartOfDay(d).getTime() + h * 3600000 + m * 60000 }
let CLOCK = ''
const go = (k, hhmm) => { setNow(wall(day(k), hhmm)); CLOCK = `D${k} ${hhmm}` }
go(0, '07:50')

const owner = seed.user('مالک فروشگاه')
const seller = seed.user('فروشنده')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
const cat = seed.category('ممیزی مرز روز')
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const DEBTOR = { firstName: 'رضا', lastName: 'ممیزی', phone: '09121234567', nationalId: null }

registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  return fn({ sender }, payload)
}
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }

// ---------------------------------------------------------------- نتیجه‌ها و سنجش‌ها
const stories = []
const allFindings = []
let story = null
let keySeq = 0
const firstLine = (t) => String(t ?? '').split('\n')[0]
const countOf = (t, where = '1=1', ...p) => n(seed.one(`SELECT COUNT(*) c FROM "${t}" WHERE ${where}`, ...p).c)
const moneyStock = () => ({ payments: countOf('Payment'), cashMovements: countOf('CashMovement'), stock: n(seed.one('SELECT COALESCE(SUM(stock),0) s FROM "ProductVariant"').s) })
const sig = () => JSON.stringify(['Shift', 'CashSession', 'CashMovement', 'Payment', 'SaleInvoice', 'SaleInvoiceItem', 'SaleReturn', 'StockMovement', 'Consolidation', 'StoreCredit']
  .map((t) => countOf(t)).concat([countOf('StockMovement', "state='PENDING'"), countOf('SaleInvoice', 'consolidationId IS NOT NULL'), n(seed.one('SELECT COALESCE(SUM(stock),0) s FROM "ProductVariant"').s),
    n(seed.one('SELECT COALESCE(SUM(grandTotal),0) s FROM "SaleInvoice"').s)]))

function begin(id, title) { story = { id, title, steps: [], findings: [], findingKeys: new Set(), obs: [] }; stories.push(story); if (VERBOSE) console.log(`\n=== ${id} ${title}`) }
function finding(type, label, plan, detail) {
  const key = `${type}|${label}`
  if (story.findingKeys.has(key)) return
  story.findingKeys.add(key)
  const f = { story: story.id, type, label, plan: plan ?? '', detail }
  story.findings.push(f)
  allFindings.push(f)
  if (VERBOSE) console.log(`    ⚠ ${type} [${plan ?? ''}] ${label}`)
}
function obs(key, value) { story.obs.push({ k: key, v: value }); if (VERBOSE) console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 240)}`) }
/**
 * expect: 'ok' | 'refuse' | 'either' | 'window:<شناسهٔ قفل>' (رد با پنجرهٔ قفل، یعنی کد `GATE_REQUIRED:<شناسه>`).
 * plan: بندی که این گام را می‌سنجد یا عوض می‌کند (برای خواندن یافته‌ها).
 */
function record(label, expect, r, plan, brief) {
  const fullLabel = `${CLOCK} ${label}`
  if (!r.ok) {
    if (expect === 'ok') finding('UNEXPECTED_REFUSAL', fullLabel, plan, firstLine(r.error))
    if (expect.startsWith('window:') && r.code !== 'GATE_REQUIRED:' + expect.slice(7)) finding('NO_LOCK_WINDOW', fullLabel, plan, r.code ?? null)
    story.steps.push({ label: fullLabel, ok: false, expect, plan: plan ?? '', code: r.code ?? null, msg: String(r.error ?? '') })
    if (VERBOSE) console.log(`   ✗ ${fullLabel} ${r.code ? '[' + r.code + '] ' : ''}${firstLine(r.error).slice(0, 170)}`)
  } else {
    if (expect === 'refuse' || expect.startsWith('window:')) finding('ACCEPTED_BUT_SHOULD_REFUSE', fullLabel, plan, null)
    story.steps.push({ label: fullLabel, ok: true, expect, plan: plan ?? '', brief: brief ?? null })
    if (VERBOSE) console.log(`   ✓ ${fullLabel} ${brief ? JSON.stringify(brief).slice(0, 160) : ''}`)
  }
  return r
}
/** یک گام از راه صفحه (کانال IPC)؛ رد هیچ اثری نمی‌گذارد. */
async function call(label, expect, channel, payload, plan, briefOf) {
  const before = sig()
  let r
  try { r = await invoke(channel, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  if (!r.ok && sig() !== before) finding('REFUSAL_NOT_ATOMIC', `${CLOCK} ${label}`, plan, firstLine(r.error))
  return record(label, expect, r, plan, r.ok && briefOf ? briefOf(r.data) : null)
}
async function svc(label, expect, fn, plan) {
  let r
  try { r = { ok: true, data: await fn() } } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: e?.code ?? null } }
  return record(label, expect, r, plan, null)
}

let vseq = 0
function V(label, price, stock = 60) {
  const pid = seed.product(`day-${label}-${++vseq}`, cat)
  const id = seed.variant(pid, `${label}-${vseq}`)
  // کد و بارکد ثابت، تا متن پیام‌ها (مثل «کد …» در قیمت مرجع) در هر اجرا یکی باشد
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=?, code=?, barcode=? WHERE id=?').run(stock, price, `DAY-${label}`, `BDAY-${label}`, id)
  return { id, label, price }
}
const lineOf = (v, qty = 1, unitPrice = v.price) => ({ variantId: v.id, qty, unitPrice, discount: 0, tax: 0 })
const itemFor = (invoiceId, v) => n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=? ORDER BY id', invoiceId, v.id)?.id)

// ---------------------------------------------------------------- کارهای صفحه‌ها
const OWNER_PIN = 'Owner-Pin-7391!', SELLER_TMP = 'Seller-Tmp-48!', SELLER_PIN = 'Seller-Pin-5527!'
/** «جمع عملیاتی» حضانت: کشو + کارت‌خوان (مثل ابزار بستن صندوق، سناریوی K)؛ شمارش‌ها همیشه دقیق. */
let drawer = 0
const openDrawer = async (label, plan) => {
  const r = await call(`${label} (PIN + count ${drawer.toLocaleString('en')})`, 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: drawer }, plan)
  return r
}
const finalClose = (label) => call(`${label} (count ${drawer.toLocaleString('en')})`, 'ok', IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: drawer })
const pos = async (label, v, kind, expect = 'ok', plan) => {
  const payments = kind === 'NESIEH' ? [] : [{ methodId: kind === 'CARD' ? cardM : cashM, amount: v.price, destination: kind === 'CARD' ? 'CARD' : 'CASH' }]
  const r = await call(label, expect, IPC.saleCreate, { lines: [lineOf(v)], payments, ...(kind === 'NESIEH' ? { debtor: DEBTOR } : {}), saleRequestIdempotencyKey: `day-sale-${++keySeq}` }, plan, (d) => ({ grandTotal: n(d.grandTotal) }))
  if (r.ok && kind !== 'NESIEH') drawer += v.price
  return r
}
const wholesale = async (label, k, v, expect = 'ok', plan, extra = {}) => {
  unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
  const r = await call(label, expect, IPC.saleCreate, { orderType: 'WHOLESALE', issuedAtJalali: day(k), lines: [lineOf(v)], payments: [{ methodId: cashM, amount: v.price, destination: 'CASH' }], saleRequestIdempotencyKey: `day-sale-${++keySeq}`, ...extra }, plan, (d) => ({ grandTotal: n(d.grandTotal) }))
  if (r.ok) drawer += v.price
  return r
}
const fullReturn = async (label, inv, price, expect = 'ok', plan) => {
  unlock(PANEL_KEYS.salesReturn)
  const r = await call(label, expect, IPC.saleReturn, { invoiceId: n(inv.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, plan, (d) => ({ refund: n(d.refundAmount ?? d.total ?? 0) }))
  if (r.ok) drawer -= price
  return r
}
const exchange = async (label, inv, oldV, newV, expect = 'ok', plan) => {
  unlock(PANEL_KEYS.salesReturn)
  const invoiceId = n(inv.data?.id)
  const lines = [{ saleItemId: itemFor(invoiceId, oldV), qty: 1 }]
  const replacements = [lineOf(newV)]
  const pv = await invoke(IPC.saleExchangePreview, { invoiceId, lines, replacements, full: false })
  if (!pv.ok || !pv.data?.ok) return record(label + ' [preview]', expect, { ok: false, error: pv.ok ? pv.data?.error : pv.error, code: pv.code ?? null }, plan)
  const diff = n(pv.data.effectiveDiff)
  const input = { invoiceId, lines, full: false, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `day-ex-${++keySeq}` }
  if (pv.data.discountTransfer) input.discountTransferOption = 'NO'
  if (diff > 0) input.methodId = cashM
  else if (diff < 0) { input.exchangeSettlementDecision = 'METHOD'; input.refundMode = 'CASH' }
  const r = await call(`${label} (diff ${diff})`, expect, IPC.saleExchangeCreate, input, plan, () => ({ diff }))
  if (r.ok) drawer += diff
  return r
}
const debtPay = async (label, inv, amount, expect = 'ok', plan, extra = {}) => {
  unlock(PANEL_KEYS.salesCredit); const r = await call(label, expect, IPC.salePaymentAdd, { invoiceId: n(inv.data?.id), kind: 'CASH', amount, methodId: cashM, destination: 'CASH', ...extra }, plan, () => ({ amount }))
  if (r.ok) drawer += amount
  return r
}
/** صفحهٔ فاکتور عمده ← «فاکتورهای عمده» ← «ویرایش» ← «ثبت» (پرداخت‌ها دست‌نخورده: keepPayments). */
const wholesaleEdit = (label, inv, lines, k, expect, plan, extra = {}) => {
  unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
  return call(label, expect, IPC.saleUpdate, { id: n(inv.data?.id), orderType: 'WHOLESALE', issuedAtJalali: day(k), lines, note: 'ویرایش آزمایشی', keepPayments: true, ...extra }, plan, (d) => ({ grandTotal: n(d.grandTotal) }))
}
/** تجمیع خودکار ۴-۱۱۱ (شبیه‌سازی): همان سرویس F11 با کاربر «سیستم»، فقط روزهای پیش از امروز. */
const autoConsolidation = async (label, plan = '4-111 الف') => {
  const today = toJalaliDate(new Date())
  const before = moneyStock()
  return svc(label, 'ok', async () => {
    const st = await cashboxService.days({ fromJalali: jalaliAddDays(today, -30), toJalali: jalaliAddDays(today, -1) })
    const res = st.pendingDays.length ? await cashboxService.finalizeDays({ days: st.pendingDays, userId: null }) : { done: [], invoiceCount: 0, finalizedMovements: 0 }
    const after = moneyStock()
    const delta = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]))
    if (Object.values(delta).some((x) => x !== 0)) finding('MONEY_OR_STOCK_TOUCHED', `${CLOCK} ${label}`, plan, delta)
    obs('autoConsolidation', { at: CLOCK, days: res.done.map((d) => rel(d.dayJalali)), invoices: n(res.invoiceCount), movements: n(res.finalizedMovements), delta })
    return res
  }, plan)
}
/** صفحهٔ «تجمیع و انتقال»: همهٔ روزهای عقب‌افتاده از اول ماه تا امروز خودش تیک می‌خورد (`Consolidation.tsx`). */
const pageF11 = async (label, plan) => {
  unlock(PANEL_KEYS.consolidation)
  const today = toJalaliDate(new Date())
  const st = await invoke(IPC.consolidationDays, { fromJalali: jalaliAddDays(today, -30), toJalali: today })
  const days = st.ok ? st.data.pendingDays : []
  const before = moneyStock()
  const r = await call(label, 'ok', IPC.consolidationFinalizeDays, { days }, plan, (d) => ({ selected: days.map(rel), daysDone: d.done.length, invoices: n(d.invoiceCount) }))
  const after = moneyStock()
  const delta = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]))
  if (r.ok && Object.values(delta).some((x) => x !== 0)) finding('MONEY_OR_STOCK_TOUCHED', `${CLOCK} ${label}`, plan, delta)
  const lock = await periodLockService.status({})
  obs('periodLockAfterF11', { at: CLOCK, selected: days.map(rel), todayLocked: lock.enforced })
  return r
}
/** همان «مجوز یک‌باره»ای که تأیید گوشی یا دکمهٔ ربات می‌سازد (`addOneShotTicket`). */
const remoteOneShot = (id) => { const made = addGateTicket(sender.id, id, 120_000, 'REMOTE_GRANT', { memberId: 'bot-000000000001' }); obs('remoteOneShot', { at: CLOCK, id, made }); return made }

const a = V('A', 700_000), b = V('B', 300_000), c = V('C', 500_000), w = V('W', 1_000_000), e = V('E', 300_000)

// =================================================================== راه‌اندازی حضانت (مثل فروشگاه مالک)
begin('S0', 'راه‌اندازی: رمز شخصی مالک و فروشنده، روشن کردن حضانت صندوق')
await svc('owner sets personal custody PIN', 'ok', () => custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW }))
await svc('enable custody (single shift)', 'ok', () => custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN }))
await svc('owner issues a temporary PIN for the seller', 'ok', () => custodyService.setPin({ userId: seller, newPassword: SELLER_TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'راه‌اندازی آزمون مرز روز' }))
await svc('seller sets personal PIN', 'ok', () => custodyService.setPin({ userId: seller, currentPassword: SELLER_TMP, newPassword: SELLER_PIN }))

// =================================================================== S1
begin('S1', 'شب «بستن نهایی»، رایانه خاموش، صبح تجمیع خودکار و شیفت اول')
go(0, '08:00'); drawer = 2_000_000; await openDrawer('morning: seller opens the drawer')
go(0, '10:00'); const s1 = await pos('POS sale A cash 700,000', a, 'CASH')
go(0, '12:00'); const s2 = await pos('POS sale B card 300,000', b, 'CARD')
go(0, '15:00'); const s3 = await pos('POS sale C نسیه 500,000', c, 'NESIEH')
go(0, '18:00'); const w1 = await wholesale('wholesale W 1,000,000 dated D0', 0, w)
go(0, '22:00'); await finalClose('«بستن نهایی»')
go(1, '08:30'); await autoConsolidation('program opens (PC was off): automatic consolidation, drawer closed, nobody logged in')
go(1, '08:31'); await openDrawer('first shift opens the drawer after consolidation', 'بند ۱۴')
go(1, '08:35'); await pos('POS sale E cash 300,000', e, 'CASH', 'ok', 'بند ۱۴')
go(1, '08:40'); await fullReturn('return of yesterday sale A (consolidated)', s1, a.price, 'ok', 'بند ۱۴')
go(1, '08:45'); await exchange('exchange of yesterday sale B → E (same price)', s2, b, e, 'ok', 'بند ۱۴')
go(1, '08:50'); await debtPay('نسیه payment 200,000 on yesterday sale C', s3, 200_000, 'ok', 'بند ۱۴')
go(1, '09:00'); await wholesale('wholesale dated today', 1, w, 'ok', 'بند ۱۴')
go(1, '09:05'); await wholesale('wholesale page left open since last night (date still D0)', 0, w, 'ok', '4-111 ب')

// =================================================================== S2
begin('S2', 'شب کسی «بستن نهایی» نزد: بستن خودکار حضانت، تجمیع خودکار، شمارش شاهد صبح، شیفت اول')
go(1, '11:00'); await pos('POS sale A cash 700,000 (nobody closes tonight)', a, 'CASH')
go(2, '08:30')
const st2 = await call('program opens: custody status (automatic close of the forgotten drawer)', 'ok', IPC.custodyStatus, {}, '4-17، ۴-۱۸', (d) => ({ state: d.state, unresolved: n(d.unresolvedCount) }))
await autoConsolidation('automatic consolidation after the automatic close')
const resolutionId = st2.ok ? n(st2.data.unresolved?.[0]?.id) : 0
go(2, '08:32')
let rec = await call('morning witness count of the old drawer (seller PIN, exact count, no note)', 'either', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: drawer }, '4-104')
if (!rec.ok) rec = await call('morning witness count again with a note', 'ok', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: drawer, note: 'شمارش صبح' }, '4-104')
go(2, '08:35'); await openDrawer('first shift opens the drawer after consolidation', 'بند ۱۴')
go(2, '08:40'); await pos('POS sale B card 300,000', b, 'CARD', 'ok', 'بند ۱۴')

// =================================================================== S3
begin('S3', 'تجمیع خودکار ساعت ۲۴ و باز کردن صندوق پس از ۲۴')
go(2, '20:00'); await pos('POS sale A cash 700,000', a, 'CASH')
go(2, '23:50'); const s7 = await pos('POS sale B card 300,000 at 23:50', b, 'CARD')
go(2, '23:58'); await finalClose('«بستن نهایی» before 24:00')
go(3, '00:00'); await autoConsolidation('automatic consolidation of D2 at the agreed 24:00 moment')
go(3, '00:01'); await openDrawer('seller opens the drawer after 24:00', 'بند ۱۴')
go(3, '00:05'); await pos('POS sale A cash 700,000 after 24:00', a, 'CASH', 'ok', 'بند ۱۴')
go(3, '00:10'); await exchange('exchange of the 23:50 sale B → E', s7, b, e, 'ok', 'بند ۱۴')
go(3, '00:20'); await wholesale('wholesale page opened at 23:00 (date still D2)', 2, w, 'ok', '4-111 ب')
go(3, '04:30'); await finalClose('«بستن نهایی» of the night drawer')

// =================================================================== S4
begin('S4', 'مدیر ساعت ۲۳:۰۰ F11 می‌زند (امروز خودش تیک می‌خورد)؛ ساعت آخر روز؛ سپس پس از ۲۴')
go(3, '08:00'); await openDrawer('morning: seller opens the drawer')
go(3, '12:00'); const s9 = await pos('POS sale A cash 700,000', a, 'CASH')
go(3, '23:00'); await pageF11('manager presses F11 on the page (default selection)', '4-41')
go(3, '23:30'); await pos('POS sale B card 300,000 after F11 of today', b, 'CARD', 'ok', '4-41 الف')
go(3, '23:40'); await fullReturn('return of the 12:00 sale A after F11 of today', s9, a.price, 'ok', '4-41 الف')
go(3, '23:58'); await finalClose('«بستن نهایی»')
go(4, '00:05'); await openDrawer('seller opens the drawer after 24:00', 'بند ۱۴')
go(4, '00:10'); await pos('POS sale A cash 700,000 after 24:00', a, 'CASH', 'ok', 'بند ۱۴')

// =================================================================== S5
begin('S5', 'F11 ساعت ۰۰:۳۰ (پس از ۲۴؛ روز تازه تیک می‌خورد)؛ سپس شیفت اول صبح')
go(4, '00:30'); await pageF11('F11 pressed after 24:00 (default selection)', '4-41')
go(4, '00:40'); await pos('POS sale B card 300,000 after F11 of the new day', b, 'CARD', 'ok', '4-41 الف')
go(4, '04:30'); await finalClose('«بستن نهایی» of the night drawer')
go(4, '08:30'); await autoConsolidation('automatic consolidation (days before today only)')
go(4, '08:31'); await openDrawer('first shift opens the drawer after F11 at 00:30', 'بند ۱۴')
go(4, '08:35'); await pos('POS sale A cash 700,000 in the morning', a, 'CASH', 'ok', '4-41 الف')
go(4, '08:40'); await wholesale('wholesale dated today in the morning', 4, w, 'ok', '4-41 الف')
go(4, '15:00'); await pos('POS sale E cash 300,000 in the afternoon', e, 'CASH', 'ok', '4-41 الف')
go(4, '23:58'); await finalClose('«بستن نهایی»')

// =================================================================== S6
begin('S6', 'ویرایش‌هایی که مدیر را صدا می‌زنند: تجمیع‌شده (۴-۱۱۲)، روز بسته و پرداخت روز بسته (۴-۱۱۳)، قیمت مرجع')
go(5, '08:30'); await autoConsolidation('automatic consolidation')
go(5, '08:31'); await openDrawer('first shift opens the drawer')
go(5, '09:00')
const ed1 = await wholesaleEdit('edit the consolidated D0 wholesale W (page: no password)', w1, [lineOf(w, 1)], 0, 'refuse', '4-112')
if (!ed1.ok && /رمز مدیر/.test(String(ed1.error))) finding('MISLEADING_MANAGER_PROMPT', `${CLOCK} edit the consolidated D0 wholesale W (page: no password)`, '4-112', firstLine(ed1.error))
await wholesaleEdit('the same edit after the manager comes: password + reason', w1, [lineOf(w, 1)], 0, 'refuse', '4-112', { managerPassword: PW, overrideReason: 'اصلاح فاکتور دیروز' })
const w2 = await wholesale('wholesale dated D3 (closed day) with manager password + reason', 3, w, 'ok', '4-111 ب', { managerPassword: PW, overrideReason: 'فاکتور کاغذی' })
await wholesaleEdit('edit that closed-day invoice (page: no password, no reason)', w2, [lineOf(w, 1)], 3, 'window:period.closed-entry', '4-113')
remoteOneShot('period.closed-entry')
await wholesaleEdit('the same edit after a one-shot remote permission (bot or phone) + reason', w2, [lineOf(w, 1)], 3, 'ok', '4-113', { overrideReason: 'اصلاح با مجوز راه دور' })
clearGateTickets({ owner: sender.id })
await wholesaleEdit('the same edit with the typed manager password + reason', w2, [lineOf(w, 1)], 3, 'ok', '4-113', { managerPassword: PW, overrideReason: 'اصلاح با رمز مدیر' })
go(5, '10:00')
unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
const w3 = await call('wholesale today 2 × 1,000,000, cash 1,000,000, rest نسیه', 'ok', IPC.saleCreate, { orderType: 'WHOLESALE', issuedAtJalali: day(5), lines: [lineOf(w, 2)], payments: [{ methodId: cashM, amount: 1_000_000, destination: 'CASH' }], debtor: DEBTOR, saleRequestIdempotencyKey: `day-sale-${++keySeq}` }, null, (d) => ({ grandTotal: n(d.grandTotal) }))
if (w3.ok) drawer += 1_000_000
await wholesaleEdit('edit: price 900,000 below the reference (no password)', w3, [lineOf(w, 2, 900_000)], 5, 'window:sales.price-below-reference', 'قیمت مرجع')
remoteOneShot('sales.price-below-reference')
await wholesaleEdit('the same edit after a one-shot remote permission', w3, [lineOf(w, 2, 900_000)], 5, 'ok', 'قیمت مرجع')
await wholesaleEdit('edit again: price 850,000 (the permission was used)', w3, [lineOf(w, 2, 850_000)], 5, 'window:sales.price-below-reference', 'قیمت مرجع')
clearGateTickets({ owner: sender.id })
go(5, '11:00')
await debtPay('payment 100,000 dated D0 (closed day) on the D0 نسیه sale (no password)', s3, 100_000, 'window:period.closed-entry', '4-113', { paidAtJalali: day(0) })
remoteOneShot('period.closed-entry')
await debtPay('the same payment after a one-shot remote permission + reason', s3, 100_000, 'ok', '4-113', { paidAtJalali: day(0), overrideReason: 'پرداخت دیروز' })
clearGateTickets({ owner: sender.id })
await debtPay('the same payment with the typed manager password + reason', s3, 100_000, 'ok', '4-113', { paidAtJalali: day(0), managerPassword: PW, overrideReason: 'پرداخت دیروز' })
obs('closedPeriodOverrides', seed.rows(`SELECT entity, note FROM "AuditLog" WHERE action='CLOSED_PERIOD_OVERRIDE' ORDER BY id`).map((r) => [r.entity, String(r.note ?? '')]))

// =================================================================== خلاصه، نتیجهٔ فشرده و مقایسه
const byType = {}, byPlan = {}
for (const f of allFindings) { byType[f.type] = (byType[f.type] ?? 0) + 1; byPlan[f.plan] = (byPlan[f.plan] ?? 0) + 1 }
const summary = {
  stories: stories.length,
  steps: stories.reduce((s, x) => s + x.steps.length, 0),
  refusals: stories.reduce((s, x) => s + x.steps.filter((st) => !st.ok).length, 0),
  observations: stories.reduce((s, x) => s + x.obs.length, 0),
  findings: allFindings.length,
  findingTypes: byType,
  findingPlans: byPlan,
  consolidations: countOf('Consolidation')
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ D0, summary, stories, ipcErrors }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))

// نتیجهٔ فشرده: بی شناسه و بی تاریخ؛ روزها نسبی (D0…). در پیام‌ها رقم فارسی «#» و رقم لاتین «0»؛ در برچسب‌ها و
// دیده‌ها (ساخت خود ابزار، مثل «D1 08:30») فقط رقم فارسی «#» می‌شود تا روز و ساعت نسبی بمانند.
const normStr = (t, onlyFirstLine = true) => {
  let s = String(t ?? '')
  if (onlyFirstLine) s = s.split('\n')[0]
  return s.replace(/[۰-۹٠-٩][۰-۹٠-٩٬,\/:.]*/g, '#').replace(/[0-9][0-9,\/:.]*/g, '0').slice(0, 240)
}
const normFa = (t) => String(t ?? '').replace(/[۰-۹٠-٩][۰-۹٠-٩٬,\/:.]*/g, '#').slice(0, 240)
const normDeep = (v) => {
  if (typeof v === 'string') return normFa(v)
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(normDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normDeep(x)]))
  return v ?? null
}
const snapshot = stories.map((s) => ({
  id: s.id,
  title: s.title,
  steps: s.steps.map((st) => [st.label, st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? normDeep(st.brief ?? null) : `${st.code ? '[' + st.code + '] ' : ''}${normStr(st.msg)}`, st.plan]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${f.label} | ${f.plan}`))].sort(),
  obs: normDeep(s.obs)
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/day-boundary-scenarios.mjs', programCommit: head, summary }, stories: snapshot }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify(snapshotDoc, null, 1) + '\n')

for (const s of stories) {
  console.log(`\n${s.id} — ${s.title}`)
  for (const st of s.steps) console.log(`  ${st.ok ? '✓' : '✗'} ${st.label}${st.ok ? '' : `  :: ${st.code ? '[' + st.code + '] ' : ''}${firstLine(st.msg).slice(0, 150)}`}`)
  for (const f of s.findings) console.log(`  ⚠ ${f.type} [${f.plan}] ${f.label}`)
}
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)

if (COMPARE) {
  const base = JSON.parse(readFileSync(COMPARE, 'utf8')).stories
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const b = byId.get(s.id)
    if (!b) { diffs.push(`+ داستان تازه: ${s.id}`); continue }
    byId.delete(s.id)
    const len = Math.max(s.steps.length, b.steps.length)
    for (let i = 0; i < len; i++) {
      const x = JSON.stringify(s.steps[i] ?? null), y = JSON.stringify(b.steps[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · گام ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const olen = Math.max(s.obs.length, (b.obs ?? []).length)
    for (let i = 0; i < olen; i++) {
      const x = JSON.stringify(s.obs[i] ?? null), y = JSON.stringify((b.obs ?? [])[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · دیدهٔ ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const x = JSON.stringify(s.findings), y = JSON.stringify(b.findings)
    if (x !== y) diffs.push(`${s.id} · یافته‌ها\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- داستان نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 500)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
