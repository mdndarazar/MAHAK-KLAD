/**
 * آزمون «صندوق فرعی» (چند صندوق در یک فروشگاه) — آزمون امکان‌سنجی ۲۰۲۶-۱۱-۲۷ (دفتر آزمون مالک: ۴-۱۳۸ و ۴-۱۳۹).
 *
 * خواستهٔ مالک: فروشگاه شلوغ چند پنل فروش داشته باشد که همه به برنامهٔ اصلی وصل‌اند (انبار، تنظیمات، گزارش فروش و
 * گزارش مدیریت فقط روی برنامهٔ اصلی)؛ صندوق کناری فقط پنل فروش تکی دارد؛ مسئولیت با شیفتی است که صندوق اصلی را
 * تحویل گرفته («شیفت اول +زیرمجموعه هاش»). طرح نهایی مالک (۴-۱۴۳): صندوق فرعی کمکی است و همه‌چیز در برنامهٔ اصلی ثبت
 * می‌شود؛ فروش با همهٔ روش‌ها جز نسیه و چک، برگشت و تعویض، و گزارش فروش، برگشت و تعویض خودش؛ بی ورود و رمز شخصی
 * فروشنده؛ قفل‌ها و مجوزها همان قفل‌های برنامهٔ اصلی (پای همان صندوق باز می‌شود)؛ پیام ربات «صندوق ۱ · شیفت اول».
 *
 * امروز «حالت صندوق فرعی» هنوز ساخته نشده است. این ابزار همان چیزی را می‌سنجد که طرح روی آن بنا می‌شود: صندوق فرعی
 * پنجرهٔ دیگری است (فرستندهٔ دیگری) که همان کانال فروش برنامهٔ اصلی را با «اپراتور با رمز شخصی» صدا می‌زند
 * (`saleOperatorMode: 'OPERATOR_PIN'`، همان راه امروز برنامه) و برنامهٔ اصلی با همان سرویس فروش ثبت می‌کند. طرح نهایی
 * (۴-۱۴۳) بی رمز شخصی است و با حالت «مسئول صندوق» می‌فروشد (T8).
 *   T1  صندوق اصلی تحویل گرفته نشده ⇒ صندوق فرعی هم نمی‌فروشد (همان قفل مجاز تحویل صندوق)
 *   T2  فروش از سه پنجره (اصلی با مسئول صندوق، صندوق ۲ و ۳ با فروشندهٔ خودشان): شمارهٔ فاکتور یکی، انبار یکی، مسئولیت
 *       با مسئول صندوق اصلی و همان شیفت، نام فروشندهٔ هر صندوق در سند
 *   T3  قطع شبکه وسط فروش: همان درخواست با همان کلید دوباره ⇒ فاکتور دوم ساخته نمی‌شود؛ همان کلید با سبد دیگر ⇒ رد
 *   T4  رمز اشتباه فروشنده ⇒ رد، بی هیچ نوشتن
 *   T5  قفل باز در پنجرهٔ اصلی در صندوق فرعی باز حساب نمی‌شود
 *   T6  برگشت از پنجرهٔ دیگر با قفل برگشت باز در همان پنجره ⇐ ثبت (۴-۱۴۳: برگشت در صندوق فرعی مجاز، با برچسب صندوق)
 *   T7  «بستن نهایی» با یک شمارش برای همه؛ پس از آن صندوق فرعی تا تحویل بعدی نمی‌فروشد
 *   T8  روز بعد، صندوق فرعی بی ورود فروشنده: فروش زیر نشست مسئول صندوق (حالت «مسئول صندوق»؛ ۴-۱۴۳)
 *   T9  صندوق فرعی با همهٔ روش‌ها جز نسیه و چک: دو بارکد + نقد، بارکد + کارت، نقد + کارت؛ «نقد + کارت + بارکد» امروز رد (۴-۶۸)
 *   T10 برگشت (نقد و بارکد اعتبار) و تعویض از صندوق فرعی ⇐ ثبت؛ امروز هیچ سندی نام صندوق را ندارد (۴-۱۴۳: برچسب صندوق)
 *   T11 قفل «برگشت از فروش و تعویض کالا»: روشن و در صندوق فرعی باز نشده ⇐ رد (۴-۱۴۳: پنجرهٔ قفل همان برنامهٔ اصلی، پای همان صندوق)؛
 *       مدیر قفل را خاموش کند ⇐ همان برگشت در صندوق فرعی ثبت می‌شود
 *
 * هم‌زمانیِ واقعیِ دو فروش در یک لحظه این‌جا سنجیده نمی‌شود (پایگاه آزمون تراکنش‌های هم‌زمان را جدا نمی‌کند)؛
 * در اجرا، درگاه صندوق فرعی فروش‌ها را یکی‌یکی به سرویس فروش می‌دهد و آزمون با دو رایانه انجام می‌شود (۴-۱۳۸).
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت و Electron شبیه‌سازی‌شده؛ به برنامه دست نمی‌زند.
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/terminal-scenarios.mjs
 *   ... --out <file.json> · ... --compare docs/audit/terminal-scenarios-2026-11-27.json · AUD_VERBOSE=1
 */
const RealDate = Date
let OFFSET = 0
function FakeDate(...a) { if (!new.target) return new RealDate(RealDate.now() + OFFSET).toString(); return a.length === 0 ? new RealDate(RealDate.now() + OFFSET) : new RealDate(...a) }
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

if (process.env.TZ !== 'Asia/Tehran') { console.error('TZ=Asia/Tehran لازم است (مثل رایانهٔ فروشگاه).'); process.exit(2) }
const REPO = process.env.AUD_REPO ?? fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
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
const imp = (p) => import(pathToFileURL(REPO + p).href)
const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { jalaliStartOfDay } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')
const { storeCreditService } = await imp('/src/main/services/StoreCreditService.ts')
const { authService } = await imp('/src/main/services/AuthService.ts')
const db = harnessClient()
{
  const migDir = findMigrationsDir()
  db.$harness.db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`)
  const { createHash, randomUUID } = await import('node:crypto')
  for (const name of readdirSync(migDir).filter((x) => existsSync(join(migDir, x, 'migration.sql'))).sort())
    db.$harness.db.prepare(`INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count") VALUES (?,?,current_timestamp,?,1)`).run(randomUUID(), createHash('sha256').update(readFileSync(join(migDir, name, 'migration.sql'))).digest('hex'), name)
}
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (x) => Number(x ?? 0)

// ---------------------------------------------------------------- نتیجه‌ها
const stories = []
const allFindings = []
let story = null
const firstLine = (t) => String(t ?? '').split('\n')[0]
const countOf = (t, where = '1=1', ...p) => n(seed.one(`SELECT COUNT(*) c FROM "${t}" WHERE ${where}`, ...p).c)
const sig = () => JSON.stringify(['SaleInvoice', 'SaleInvoiceItem', 'Payment', 'StockMovement', 'SaleReturn', 'CustodySaleEvidence', 'CashMovement'].map((t) => countOf(t)))
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
function obs(key, value) { story.obs.push({ k: key, v: value }); if (VERBOSE) console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 300)}`) }
const senders = {
  main: { id: 777300, isDestroyed: () => false, once: () => {} },
  t2: { id: 9002, isDestroyed: () => false, once: () => {} },
  t3: { id: 9003, isDestroyed: () => false, once: () => {} },
  t4: { id: 9004, isDestroyed: () => false, once: () => {} }
}
const NAMES = { main: 'صندوق اصلی', t2: 'صندوق ۲', t3: 'صندوق ۳', t4: 'صندوق ۴' }
async function call(who, label, expect, channel, payload, plan, briefOf) {
  const before = sig()
  let r
  try { r = await handlers.get(channel)({ sender: senders[who] }, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  const fullLabel = `${NAMES[who]}: ${label}`
  if (!r.ok) {
    if (sig() !== before) finding('REFUSAL_NOT_ATOMIC', fullLabel, plan, firstLine(r.error))
    if (expect === 'ok') finding('UNEXPECTED_REFUSAL', fullLabel, plan, firstLine(r.error))
    story.steps.push({ label: fullLabel, ok: false, expect, plan: plan ?? '', code: r.code ?? null, msg: String(r.error ?? '') })
    if (VERBOSE) console.log(`   ✗ ${fullLabel} ${r.code ? '[' + r.code + '] ' : ''}${firstLine(r.error).slice(0, 170)}`)
  } else {
    if (expect === 'refuse') finding('ACCEPTED_BUT_SHOULD_REFUSE', fullLabel, plan, null)
    story.steps.push({ label: fullLabel, ok: true, expect, plan: plan ?? '', brief: briefOf ? briefOf(r.data) : null })
    if (VERBOSE) console.log(`   ✓ ${fullLabel}`)
  }
  return r
}
const go = (jday, hhmm) => { const [h, m] = hhmm.split(':').map(Number); setNow(jalaliStartOfDay(jday).getTime() + h * 3600000 + m * 60000) }

// =================================================================== T0
begin('T0', 'راه‌اندازی: حضانت صندوق روشن (مثل فروشگاه مالک)، مسئول صندوق و دو فروشندهٔ صندوق فرعی با رمز شخصی')
go('1405/09/06', '08:00')
const owner = seed.user('مالک')
const custodian = seed.user('مسئول صندوق')
const op1 = seed.user('فروشندهٔ صندوق ۲'), op2 = seed.user('فروشندهٔ صندوق ۳')
sql.prepare(`UPDATE "User" SET role='CASHIER' WHERE id IN (?,?,?)`).run(custodian, op1, op2)
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const cat = seed.category('آزمون صندوق فرعی')
const v = seed.variant(seed.product('کالای الف', cat), 'الف')
sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=500000, code=?, barcode=? WHERE id=?').run('T-A', 'B-T-A', v)
registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const OWNER_PIN = 'Owner-Pin-7391!', TMP = 'Tmp-Pin-4821!', CUST = 'Cust-Pin-5527!', P1 = 'Op1-Pin-6618!', P2 = 'Op2-Pin-7729!'
await custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN })
for (const [u, pin] of [[custodian, CUST], [op1, P1], [op2, P2]]) {
  await custodyService.setPin({ userId: u, newPassword: TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'آزمون صندوق فرعی' })
  await custodyService.setPin({ userId: u, currentPassword: TMP, newPassword: pin })
}
obs('people', { custodian: 'مسئول صندوق (صندوق اصلی)', terminal2: 'فروشندهٔ صندوق ۲', terminal3: 'فروشندهٔ صندوق ۳' })
const line = { variantId: v, qty: 1, unitPrice: 500000, discount: 0, tax: 0 }
const asOp = (who) => (who === 't2' ? { saleOperatorMode: 'OPERATOR_PIN', saleOperatorUserId: op1, saleOperatorPassword: P1 } : who === 't3' ? { saleOperatorMode: 'OPERATOR_PIN', saleOperatorUserId: op2, saleOperatorPassword: P2 } : {})
const sale = (who, label, expect, key, kind = 'CASH', plan = '۴-۱۳۸', extra = {}) =>
  call(who, label, expect, IPC.saleCreate, { lines: [line], payments: [{ methodId: kind === 'CARD' ? cardM : cashM, amount: 500000, destination: kind }], saleRequestIdempotencyKey: key, ...asOp(who), ...extra }, plan,
    (d) => ({ receiptNo: n(d.receiptNo), replay: !!d.idempotentReplay }))

// =================================================================== T1
begin('T1', 'صندوق اصلی هنوز تحویل گرفته نشده: صندوق فرعی هم نمی‌فروشد (همان قفل مجاز تحویل صندوق)')
go('1405/09/06', '08:30')
await sale('t2', 'POS sale 500,000 cash before the main drawer is taken over', 'refuse', 'term-2-000001')

// =================================================================== T2
begin('T2', 'فروش از سه پنجره: یک شمارهٔ فاکتور، یک انبار، یک مسئول (مسئول صندوق اصلی و همان شیفت)')
go('1405/09/06', '09:00')
await call('main', 'custodian takes over the main drawer (PIN + count 0)', 'ok', IPC.custodyOpen, { userId: custodian, password: CUST, operationalTotal: 0 }, 'بند ۱۲ د')
go('1405/09/06', '10:00')
const a = await sale('main', 'POS sale 500,000 cash (custodian)', 'ok', 'main-0000001', 'CASH', 'امروز')
const b = await sale('t2', 'POS sale 500,000 cash (operator PIN)', 'ok', 'term-2-000002')
const c = await sale('t3', 'POS sale 500,000 card (operator PIN)', 'ok', 'term-3-000001', 'CARD')
const evidence = seed.rows('SELECT e.invoiceId i, e.operatorKind k, u1.displayName op, u2.displayName cust, e.custodyShiftId s FROM "CustodySaleEvidence" e LEFT JOIN "User" u1 ON u1.id=e.operatorUserId LEFT JOIN "User" u2 ON u2.id=e.custodianUserId ORDER BY e.id')
obs('custody evidence per sale [kind, operator, custodian, custody shift]', evidence.map((x) => [x.k, x.op, x.cust, n(x.s)]))
obs('invoice owner (SaleInvoice.userId) per sale', seed.rows('SELECT s.receiptNo r, u.displayName name FROM "SaleInvoice" s LEFT JOIN "User" u ON u.id=s.userId ORDER BY s.receiptNo').map((x) => [n(x.r), x.name]))
{
  const shifts = new Set(evidence.map((x) => n(x.s)))
  if (shifts.size !== 1) finding('ATTRIBUTION_WRONG', `فروش سه پنجره در ${shifts.size} شیفت حضانت ثبت شد (باید یک شیفت)`, '۴-۱۳۸')
  if (evidence.some((x) => x.cust !== 'مسئول صندوق')) finding('ATTRIBUTION_WRONG', 'مسئول صندوق در همهٔ فروش‌ها مسئول صندوق اصلی نیست', '۴-۱۳۸')
  const ops = evidence.map((x) => x.op)
  if (ops[1] !== 'فروشندهٔ صندوق ۲' || ops[2] !== 'فروشندهٔ صندوق ۳') finding('ATTRIBUTION_WRONG', `نام فروشندهٔ صندوق فرعی در سند درست نیست: ${JSON.stringify(ops)}`, '۴-۱۳۸')
}
obs('receipt numbers', seed.rows('SELECT receiptNo FROM "SaleInvoice" ORDER BY receiptNo').map((x) => n(x.receiptNo)))
obs('stock after three sales (from 100)', n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v).stock))

// =================================================================== T3
begin('T3', 'قطع شبکه وسط فروش: صندوق فرعی همان درخواست را با همان کلید دوباره می‌فرستد')
const before = countOf('SaleInvoice')
const again = await sale('t2', 'the same POS sale again with the same key (network retry)', 'ok', 'term-2-000002')
obs('retry with the same key', again.ok ? { replay: !!again.data.idempotentReplay, sameInvoice: n(again.data.id) === n(b.data?.id), invoicesBefore: before, invoicesAfter: countOf('SaleInvoice') } : 'refused')
if (countOf('SaleInvoice') !== before) finding('DUPLICATE_ON_RETRY', 'فرستادن دوبارهٔ همان فروش فاکتور دوم ساخت', '۴-۱۳۸')
await call('t2', 'the same key with a different cart (2 × 500,000)', 'refuse', IPC.saleCreate,
  { lines: [{ ...line, qty: 2 }], payments: [{ methodId: cashM, amount: 1000000, destination: 'CASH' }], saleRequestIdempotencyKey: 'term-2-000002', ...asOp('t2') }, '۴-۱۳۸')

// =================================================================== T4
begin('T4', 'رمز اشتباه فروشندهٔ صندوق فرعی: رد، بی هیچ نوشتن')
await call('t2', 'POS sale with a wrong operator PIN', 'refuse', IPC.saleCreate,
  { lines: [line], payments: [{ methodId: cashM, amount: 500000, destination: 'CASH' }], saleRequestIdempotencyKey: 'term-2-000003', saleOperatorMode: 'OPERATOR_PIN', saleOperatorUserId: op1, saleOperatorPassword: 'wrong-pin-000' }, '۴-۱۳۸')

// =================================================================== T5
begin('T5', 'قفل باز در پنجرهٔ اصلی در صندوق فرعی باز حساب نمی‌شود (هر پنجره نشست خودش را دارد)')
notePanelUnlocked(PANEL_KEYS.salesReports, 'PANEL', senders.main.id)
await call('main', 'sales report summary (unlocked in this window)', 'ok', IPC.saleReportSummary, { fromJalali: '1405/09/06', toJalali: '1405/09/06' }, 'قفل', (d) => ({ count: n(d.count), grandTotal: n(d.grandTotal) }))
const leak = await call('t2', 'sales report summary (unlocked only in the main window)', 'refuse', IPC.saleReportSummary, { fromJalali: '1405/09/06', toJalali: '1405/09/06' }, 'قفل')
if (leak.ok) finding('SESSION_LEAK', 'باز بودن قفل «گزارشات فروش» در پنجرهٔ اصلی به صندوق فرعی رسید', '۴-۱۳۸')

// =================================================================== T6
begin('T6', 'برگشت از پنجرهٔ دیگر با قفل برگشت باز در همان پنجره ⇐ ثبت (۴-۱۴۳: برگشت در صندوق فرعی مجاز، با برچسب صندوق)')
notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', senders.t2.id)
const ret = await call('t2', 'full return of its own sale (salesReturn unlocked in this window)', 'either', IPC.saleReturn, { invoiceId: n(b.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, '۴-۱۴۳')
obs('return from a second window today', ret.ok ? 'ثبت شد (۴-۱۴۳: برگشت در صندوق فرعی مجاز است؛ قفل روشن و بازنشده ⇐ T11؛ برچسب صندوق ⇐ T10)' : firstLine(ret.error).slice(0, 160))

// =================================================================== T7
begin('T7', '«بستن نهایی» صندوق اصلی با یک شمارش برای همه؛ پس از آن صندوق فرعی تا تحویل بعدی نمی‌فروشد')
go('1405/09/06', '21:00')
const cashAll = 500000 + 500000 - (ret.ok ? 500000 : 0), cardAll = 500000
obs('expected count for all drawers (cash + card)', { cash: cashAll, card: cardAll })
await call('main', `«بستن نهایی» with one count for all (${(cashAll + cardAll).toLocaleString('en')})`, 'ok', IPC.custodyFinalClose, { password: CUST, operationalTotal: cashAll + cardAll }, 'بند ۱۲ د')
go('1405/09/06', '21:05')
await sale('t2', 'POS sale after the main final close', 'refuse', 'term-2-000004')
{
  const rows = seed.rows('SELECT receiptNo FROM "SaleInvoice" ORDER BY receiptNo').map((x) => n(x.receiptNo))
  if (rows.some((x, i) => x !== i + 1)) finding('RECEIPT_GAP', `شمارهٔ فاکتورها پیوسته نیست: ${JSON.stringify(rows)}`, 'شماره')
  const st = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v).stock), mv = n(seed.one('SELECT COALESCE(SUM(delta),0) s FROM "StockMovement" WHERE variantId=?', v).s)
  obs('stock and ledger at the end', { stock: st, ledger: 100 + mv })
  if (st !== 100 + mv) finding('STOCK_LEDGER_MISMATCH', `موجودی ${st} ≠ ۱۰۰ + دفتر ${mv}`, 'انبار')
}

// =================================================================== T8
begin('T8', 'روز بعد، صندوق فرعی بی ورود فروشنده: فروش زیر نشست مسئول صندوق (حالت «مسئول صندوق»؛ ۴-۱۴۳)')
go('1405/09/07', '09:00')
await call('main', 'custodian takes over the main drawer (PIN + count 1,000,000)', 'ok', IPC.custodyOpen, { userId: custodian, password: CUST, operationalTotal: 1000000 }, 'بند ۱۲ د')
go('1405/09/07', '10:00')
const d2main = await sale('main', 'POS sale 500,000 cash (custodian)', 'ok', 'main-0000002', 'CASH', 'امروز')
const d2t2 = await call('t2', 'POS sale 500,000 cash without any operator or PIN (CUSTODIAN mode)', 'ok', IPC.saleCreate,
  { lines: [line], payments: [{ methodId: cashM, amount: 500000, destination: 'CASH' }], saleRequestIdempotencyKey: 'term-2-000010' }, '۴-۱۴۳', (d) => ({ receiptNo: n(d.receiptNo) }))
if (d2t2.ok) obs('custody evidence of that sale [kind, operator, auth method]', seed.rows('SELECT e.operatorKind k, u.displayName op, e.authMethod a FROM "CustodySaleEvidence" e LEFT JOIN "User" u ON u.id=e.operatorUserId WHERE e.invoiceId=?', n(d2t2.data.id)).map((x) => [x.k, x.op, x.a]))

// =================================================================== T9
begin('T9', 'صندوق فرعی با همهٔ روش‌های پرداخت جز نسیه و چک (۴-۱۴۳)')
go('1405/09/07', '11:00')
const creditCode = async (amount) => {
  const r = await storeCreditService.issueManual({ amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId: owner, managerPassword: PW })
  return seed.one('SELECT code FROM "StoreCredit" WHERE id=?', r.id).code
}
const k1 = await creditCode(300000), k2 = await creditCode(200000), k3 = await creditCode(100000), k4 = await creditCode(100000)
const saleBrief = (d) => ({ receiptNo: n(d.receiptNo), grandTotal: n(d.grandTotal), paidTotal: n(d.paidTotal), creditApplied: n(d.storeCreditApplied) })
const bc = await call('t2', '3 × 500,000: two barcodes 300,000 + 200,000 and cash 1,000,000', 'ok', IPC.saleCreate,
  { lines: [{ ...line, qty: 3 }], payments: [{ methodId: cashM, amount: 1000000, destination: 'CASH' }], storeCredits: [{ code: k1, requestedAmount: 300000 }, { code: k2, requestedAmount: 200000 }], saleRequestIdempotencyKey: 'term-2-000011' }, '۴-۱۴۳', saleBrief)
await call('t3', '500,000: barcode 100,000 and card 400,000', 'ok', IPC.saleCreate,
  { lines: [line], payments: [{ methodId: cardM, amount: 400000, destination: 'CARD' }], storeCredits: [{ code: k3, requestedAmount: null }], saleRequestIdempotencyKey: 'term-3-000011' }, '۴-۱۴۳', saleBrief)
await call('t2', '500,000: cash 200,000 + card 300,000 (split)', 'ok', IPC.saleCreate,
  { lines: [line], splitPayment: true, payments: [{ methodId: cashM, amount: 200000, destination: 'CASH' }, { methodId: cardM, amount: 300000, destination: 'CARD' }], saleRequestIdempotencyKey: 'term-2-000012' }, '۴-۱۴۳', saleBrief)
await call('t3', '500,000: barcode 100,000 + cash 200,000 + card 200,000 (split; refused today in every window, ۴-۶۸)', 'either', IPC.saleCreate,
  { lines: [line], splitPayment: true, payments: [{ methodId: cashM, amount: 200000, destination: 'CASH' }, { methodId: cardM, amount: 200000, destination: 'CARD' }], storeCredits: [{ code: k4, requestedAmount: 100000 }], saleRequestIdempotencyKey: 'term-3-000012' }, '۴-۶۸', saleBrief)
obs('barcodes after these sales [status, used]', seed.rows('SELECT status, usedAmount FROM "StoreCredit" ORDER BY id').map((x) => [x.status, n(x.usedAmount)]))

// =================================================================== T10
begin('T10', 'برگشت (نقد و بارکد اعتبار) و تعویض از صندوق فرعی ⇐ ثبت؛ امروز هیچ سندی نام صندوق را ندارد (۴-۱۴۳: برچسب صندوق)')
go('1405/09/07', '12:00')
const auditMark = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "AuditLog"').m)
notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', senders.t3.id)
await call('t3', 'full return of the main sale of this day (cash refund)', 'ok', IPC.saleReturn, { invoiceId: n(d2main.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, '۴-۱۴۳')
notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', senders.t2.id)
if (bc.ok) {
  const invoiceId = n(bc.data.id)
  const itemId = n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)?.id)
  await call('t2', 'return 1 of the 3 items of the barcode sale (refund as a store credit barcode)', 'ok', IPC.saleReturn,
    { invoiceId, lines: [{ saleItemId: itemId, qty: 1 }], refundDecision: 'METHOD', refundMethod: 'STORE_CREDIT' }, '۴-۱۴۳')
  const lines = [{ saleItemId: itemId, qty: 1 }], replacements = [line]
  const pv = await handlers.get(IPC.saleExchangePreview)({ sender: senders.t2 }, { invoiceId, lines, replacements, full: false })
  if (pv.ok && pv.data?.ok) {
    const diff = n(pv.data.effectiveDiff)
    const input = { invoiceId, lines, full: false, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: 'term-2-ex000001' }
    if (pv.data.discountTransfer) input.discountTransferOption = 'NO'
    if (diff > 0) input.methodId = cardM
    else if (diff < 0) { input.exchangeSettlementDecision = 'METHOD'; input.refundMode = 'CASH' }
    await call('t2', `exchange 1 item for the same item (difference ${diff})`, 'ok', IPC.saleExchangeCreate, input, '۴-۱۴۳')
  } else story.steps.push({ label: 'صندوق ۲: exchange preview', ok: false, expect: 'ok', plan: '۴-۱۴۳', code: null, msg: firstLine(pv.ok ? pv.data?.error : pv.error) })
}
{
  const rows = seed.rows('SELECT action, note FROM "AuditLog" WHERE id>? ORDER BY id', auditMark)
  obs('records written by these returns and the exchange (action)', rows.map((x) => x.action))
  obs('records that say which checkout did it (۴-۱۴۳: all of them)', rows.filter((x) => /صندوق: ?[۰-۹0-9]/.test(String(x.note ?? ''))).length)
}

// =================================================================== T11
begin('T11', 'قفل «برگشت از فروش و تعویض کالا» روشن و در صندوق فرعی باز نشده ⇐ رد؛ مدیر قفل را خاموش کند ⇐ ثبت (۴-۱۴۳)')
go('1405/09/07', '12:30')
await call('t4', 'return from a checkout where the return lock was never opened (lock on)', 'refuse', IPC.saleReturn, { invoiceId: n(d2t2.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, '۴-۱۴۳')
{
  let off = null
  try { off = await authService.setPanelLocks({ managerPassword: PW, locks: { [PANEL_KEYS.salesReturn]: false }, userId: owner }) } catch (e) { off = { error: firstLine(String(e?.message ?? e)).slice(0, 160) } }
  obs('manager turns the return lock off in the main program', off?.error ?? `changed ${n(off?.changed)}`)
}
await call('t4', 'the same return from the same checkout (lock off)', 'ok', IPC.saleReturn, { invoiceId: n(d2t2.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, '۴-۱۴۳')
{
  const st = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v).stock), mv = n(seed.one('SELECT COALESCE(SUM(delta),0) s FROM "StockMovement" WHERE variantId=?', v).s)
  obs('stock and ledger at the end of day 2', { stock: st, ledger: 100 + mv })
  if (st !== 100 + mv) finding('STOCK_LEDGER_MISMATCH', `موجودی ${st} ≠ ۱۰۰ + دفتر ${mv}`, 'انبار')
}

// =================================================================== خلاصه، نتیجهٔ فشرده و مقایسه
const byType = {}
for (const f of allFindings) byType[f.type] = (byType[f.type] ?? 0) + 1
const summary = {
  stories: stories.length,
  steps: stories.reduce((s, x) => s + x.steps.length, 0),
  refusals: stories.reduce((s, x) => s + x.steps.filter((st) => !st.ok).length, 0),
  observations: stories.reduce((s, x) => s + x.obs.length, 0),
  findings: allFindings.length,
  findingTypes: byType
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, stories, ipcErrors }, (k, x) => (typeof x === 'bigint' ? Number(x) : x), 2))
const normStr = (t) => String(t ?? '').split('\n')[0].replace(/[۰-۹٠-٩][۰-۹٠-٩٬,\/:.]*/g, '#').replace(/[0-9][0-9,\/:.]*/g, '0').slice(0, 240)
const snapshot = stories.map((s) => ({
  id: s.id,
  title: s.title,
  steps: s.steps.map((st) => [st.label, st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? st.brief ?? null : `${st.code ? '[' + st.code + '] ' : ''}${normStr(st.msg)}`, st.plan]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${f.label} | ${f.plan}`))].sort(),
  obs: s.obs
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify({ meta: { tool: 'docs/audit/terminal-scenarios.mjs', programCommit: head, summary }, stories: snapshot }, null, 1) + '\n')
for (const s of stories) {
  console.log(`\n${s.id} — ${s.title}`)
  for (const st of s.steps) console.log(`  ${st.ok ? '✓' : '✗'} ${st.label}${st.ok ? '' : `  :: ${st.code ? '[' + st.code + '] ' : ''}${firstLine(st.msg).slice(0, 150)}`}`)
  for (const o of s.obs) console.log(`  · ${o.k}: ${JSON.stringify(o.v).slice(0, 300)}`)
  for (const f of s.findings) console.log(`  ⚠ ${f.type} [${f.plan}] ${f.label}`)
}
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)
if (COMPARE) {
  const base = JSON.parse(readFileSync(COMPARE, 'utf8')).stories
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const bb = byId.get(s.id)
    if (!bb) { diffs.push(`+ داستان تازه: ${s.id}`); continue }
    byId.delete(s.id)
    for (const [kind, xs, ys] of [['گام', s.steps, bb.steps], ['دیده', s.obs, bb.obs ?? []]]) {
      const len = Math.max(xs.length, ys.length)
      for (let i = 0; i < len; i++) { const x = JSON.stringify(xs[i] ?? null), y = JSON.stringify(ys[i] ?? null); if (x !== y) diffs.push(`${s.id} · ${kind} ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`) }
    }
    const x = JSON.stringify(s.findings), y = JSON.stringify(bb.findings)
    if (x !== y) diffs.push(`${s.id} · یافته‌ها\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- داستان نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 300)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
