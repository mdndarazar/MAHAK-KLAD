/**
 * آزمون «مرز سال، کبیسه، ساعت نادرست و صد سال آینده» — آزمون ۲۰۲۶-۱۱-۲۶، نتیجهٔ رسمی ۲۰۲۶-۱۱-۲۷ (دفتر آزمون مالک: «آزمون‌های پایانی»، ۴-۱۳۲ تا ۴-۱۳۴).
 *
 * خواستهٔ مالک (پس از پاسخ ۱۶؛ به نقل دفتر آزمون، بند ۱۷): آزمون‌های باقی‌مانده «تا خیالم راحت بشه» کامل شود: تغییر سال
 * برنامه را خراب نکند و دست‌کم روی یک رایانه تا ۱۰۰ سال خوب کار کند؛ «فعلا کدی تغییر نده». پس از پاسخ ۱۷: «بله در دفتر آزمون ثبت کن».
 *
 * دو بخش دارد:
 *   بخش الف (بی پایگاه داده) — تقویم:
 *     A1  نوروز ۱۴۰۴ تا ۱۵۰۶ از روی محاسبهٔ نجومی (لحظهٔ اعتدال بهاری، الگوریتم Meeus، با ΔT) در برابر تقویم برنامه
 *         (`jalaali-js`)؛ سال‌هایی که تحویل سال کمتر از ۲۵ دقیقه با ظهر تهران فاصله دارد جدا نوشته می‌شوند.
 *     A2  تقویم «سیستم» (ICU؛ همان که `toLocaleString('fa-IR')` در چند جای نمایشی برنامه به کار می‌برد) در برابر
 *         تقویم برنامه، روزبه‌روز از ۲۰۲۶ تا ۲۱۲۷.
 *     A3  تابع‌های تاریخ برنامه (`@shared/jalali`، `@shared/tehranTime`، `@shared/jalaliBuckets`) روزبه‌روز از
 *         ۲۰۲۶ تا ۲۱۲۷: پیوستگی روزها، مرز نیمه‌شب، رفت‌وبرگشت، ترتیب رشته‌ای، ۳۰ اسفند فقط در کبیسه، ماه‌ها و
 *         انقضای «تا پایان روز» در مرز سال.
 *   بخش ب (پایگاه دادهٔ موقت، ساعت شبیه‌سازی‌شده، همان کانال‌های IPC صفحه‌ها و همان حضانت صندوق فروشگاه مالک):
 *     Y1  شب آخر ۱۴۰۵ و روز اول ۱۴۰۶: حراج نوروزی زمان‌بندی‌شده، چک با سررسید سال بعد، فروش ۲۳:۵۰ شب آخر، خرید پیش و
 *         پس از نوروز، تجمیع، برگشت و تعویض فاکتور سال قبل، گزارش روز و ماه و سال و بازهٔ دوساله، روند ماهانه.
 *     Y2  تعطیلات نوروز ۱۴۰۷: صندوق باز ماند و برنامه ۱۶ روز بعد باز شد.
 *     Y3  سال کبیسهٔ ۱۴۰۸: فروش و فاکتور عمدهٔ ۳۰ اسفند، تاریخ ۳۰ اسفند سال غیرکبیسه.
 *     Y4  سال ۲۱۰۰ میلادی (کبیسه نیست): ۲۸ فوریه تا ۱ مارس ۲۱۰۰.
 *     Y5  سال ۱۴۹۹ به ۱۵۰۰ (۲۱۲۱): فروش، تجمیع، گزارش، بکاپ و ادامهٔ شمارهٔ فاکتور.
 *     Y6  ۱۵۰۲/۱۲/۳۰ (تنها روزی که تقویم سیستم با برنامه فرق دارد) و ۱۵۰۵ (صد سال بعد).
 *     Y7  ساعت نادرست رایانه: عقب رفتن به روز بسته و به روزی بی فروش، ریست ساعت به ۲۰۰۸، جلو رفتن اشتباهی یک‌ساله و برگشت.
 *
 * تجمیع خودکار ۴-۱۱۱ هنوز اجرا نشده؛ این ابزار آن را با همان سرویس F11 شبیه‌سازی می‌کند (همهٔ روزهای پیش از امروز که
 * فاکتور تجمیع‌نشده دارند) و قاعدهٔ ثبت‌شدهٔ «ساعت نادرست» ۴-۱۱۱ را فقط می‌سنجد (نگهبان: ساعت از آخرین فاکتور عقب‌تر).
 *
 * انتظار هر گام قاعدهٔ مالک است (بند ۱۲ و ۱۴): فروش جز در «تحویل صندوق» هرگز قفل نمی‌شود؛ گزارش‌ها در مرز سال
 * جمع‌پذیرند؛ شمارهٔ فاکتور ادامه دارد؛ کالا = دفتر کالا. یافته‌ها:
 *   CALENDAR_MISMATCH / DATE_FUNCTION_FAILURE   تقویم یا تابع تاریخ برنامه خطا دارد
 *   SYSTEM_CALENDAR_DIFF                        تقویم سیستم (فقط چند نمایش) با تقویم برنامه فرق دارد (۴-۱۳۴)
 *   UNEXPECTED_REFUSAL / ACCEPTED_BUT_SHOULD_REFUSE / REFUSAL_NOT_ATOMIC / MONEY_OR_STOCK_TOUCHED
 *   REPORT_SUM_MISMATCH / REPORT_VS_MANAGEMENT    جمع گزارش در مرز سال نمی‌خواند
 *   RECEIPT_GAP / STOCK_LEDGER_MISMATCH / CAMPAIGN_*
 *   PREVIOUS_MONTH_PENDING_HIDDEN               صفحهٔ تجمیع روز تجمیع‌نشدهٔ ماه قبل را با بازهٔ پیش‌فرض نشان نمی‌دهد (۴-۱۳۳)
 *   CLOCK_BEHIND_REFUSAL                         ساعت عقب ⇐ فروش رد شد (ثبت‌شده در ۴-۱۱۱)
 *   CLOCK_GUARD_STUCK                            نگهبان ساعت ۴-۱۱۱ با یک فاکتور تاریخ‌آینده گیر می‌کند (۴-۱۳۲)
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده و پوشهٔ موقت؛ به برنامه، پایگاه واقعی یا آزمون‌های
 * مخزن دست نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن (حدود ۱۰ ثانیه):
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/year-scenarios.mjs
 *   ... --out <file.json> · ... --compare docs/audit/year-scenarios-2026-11-27.json · AUD_VERBOSE=1
 *   (اگر `jalaali-js` واقعی در node_modules باشد، یکی بودن آن با جایگزین هارنس هم چاپ می‌شود؛ جزو نتیجهٔ فشرده نیست.)
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
const sender = { id: 777127, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)

const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const jal = (await imp('/test/harness/stubs/jalaali.mjs')).default
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const J = await imp('/src/shared/jalali.ts')
const T = await imp('/src/shared/tehranTime.ts')
const B = await imp('/src/shared/jalaliBuckets.ts')
const { toJalaliDate, jalaliAddDays, jalaliStartOfDay, jalaliMonthStart } = J
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const { cashboxService } = await imp('/src/main/services/CashboxService.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')
const { priceAdjustService } = await imp('/src/main/services/PriceAdjustService.ts')

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

// ---------------------------------------------------------------- نتیجه‌ها و سنجش‌ها
const stories = []
const allFindings = []
let story = null
let keySeq = 0
let CLOCK = ''
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
function obs(key, value) { story.obs.push({ k: key, v: value }); if (VERBOSE) console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 300)}`) }
function record(label, expect, r, plan, brief) {
  const fullLabel = `${CLOCK} ${label}`.trim()
  if (!r.ok) {
    if (expect === 'ok') finding('UNEXPECTED_REFUSAL', fullLabel, plan, firstLine(r.error))
    story.steps.push({ label: fullLabel, ok: false, expect, plan: plan ?? '', code: r.code ?? null, msg: String(r.error ?? '') })
    if (VERBOSE) console.log(`   ✗ ${fullLabel} ${r.code ? '[' + r.code + '] ' : ''}${firstLine(r.error).slice(0, 170)}`)
  } else {
    if (expect === 'refuse') finding('ACCEPTED_BUT_SHOULD_REFUSE', fullLabel, plan, null)
    story.steps.push({ label: fullLabel, ok: true, expect, plan: plan ?? '', brief: brief ?? null })
    if (VERBOSE) console.log(`   ✓ ${fullLabel} ${brief ? JSON.stringify(brief).slice(0, 160) : ''}`)
  }
  return r
}
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  return fn({ sender }, payload)
}
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
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }

/** ساعت دیواری تهران روی یک روز شمسی */
const wall = (jday, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return jalaliStartOfDay(jday).getTime() + h * 3600000 + m * 60000 }
const go = (jday, hhmm) => { setNow(wall(jday, hhmm)); CLOCK = `${jday} ${hhmm}` }
const goGregorian = (iso, label) => { setNow(new RealDate(iso).getTime()); CLOCK = label }

// =================================================================== بخش الف — تقویم (بی پایگاه داده)
const cosd = (x) => Math.cos((x * Math.PI) / 180)
/** Meeus، Astronomical Algorithms، فصل ۲۷ (اعتدال مارس، سال‌های ۲۰۰۰ تا ۳۰۰۰؛ خطا کمتر از یک دقیقه). */
const TERMS = [[485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186], [182, 27.85, 445267.112], [156, 73.14, 45036.886], [136, 171.52, 22518.443],
  [77, 222.54, 65928.934], [74, 296.72, 3034.906], [70, 243.58, 9037.513], [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226], [45, 247.54, 29929.562],
  [44, 325.15, 31555.956], [29, 60.93, 4443.417], [18, 155.12, 67555.328], [17, 288.79, 4562.452], [16, 198.04, 62894.029], [14, 199.76, 31436.921], [12, 95.39, 14577.848],
  [12, 287.11, 31931.756], [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074]]
function marchEquinoxJDE(year) {
  const Y = (year - 2000) / 1000
  const JDE0 = 2451623.80984 + 365242.37404 * Y + 0.05169 * Y ** 2 - 0.00411 * Y ** 3 - 0.00057 * Y ** 4
  const Tc = (JDE0 - 2451545.0) / 36525
  const W = 35999.373 * Tc - 2.47
  const dL = 1 + 0.0334 * cosd(W) + 0.0007 * cosd(2 * W)
  const S = TERMS.reduce((s, [A, Bb, C]) => s + A * cosd(Bb + C * Tc), 0)
  return JDE0 + (0.00001 * S) / dL
}
/** ΔT (Espenak و Meeus ۲۰۰۶) */
function deltaT(y) { if (y < 2050) { const t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t } const u = (y - 1820) / 100; return y < 2150 ? -20 + 32 * u * u - 0.5628 * (2150 - y) : -20 + 32 * u * u }
const equinoxUtcMs = (y) => (marchEquinoxJDE(y) - 2440587.5) * 86400000 - deltaT(y) * 1000
const ymdUTC = (ms) => new RealDate(ms).toISOString().slice(0, 10)

begin('A1', 'نوروز ۱۴۰۴ تا ۱۵۰۶: محاسبهٔ نجومی (اعتدال بهاری پیش یا پس از ظهر تهران) در برابر تقویم برنامه')
{
  const IRST = 3.5 * 3600000
  const known = { 2024: '2024-03-20T03:06', 2025: '2025-03-20T09:01', 2026: '2026-03-20T14:46', 2028: '2028-03-20T02:17', 2030: '2030-03-20T13:52' }
  const calib = Object.entries(known).map(([y, iso]) => [Number(y), Math.round((equinoxUtcMs(Number(y)) - RealDate.parse(iso + ':00Z')) / 60000)])
  obs('calibration (minutes vs published equinox times)', calib)
  if (calib.some(([, m]) => Math.abs(m) > 2)) finding('CALENDAR_MISMATCH', 'محاسبهٔ اعتدال با زمان‌های منتشرشده نمی‌خواند (ابزار)', 'A1', calib)
  const mismatches = [], close = []
  for (let gy = 2025; gy <= 2127; gy++) {
    const local = new RealDate(equinoxUtcMs(gy) + IRST)
    const hours = local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600
    const dayStart = RealDate.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
    const astro = ymdUTC(dayStart + (hours < 12 ? 0 : 86400000))
    const g = jal.toGregorian(gy - 621, 1, 1)
    const program = `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`
    const tehran = local.toISOString().slice(11, 16)
    if (astro !== program) mismatches.push([gy - 621, astro, program, tehran])
    if (Math.abs(hours - 12) * 60 < 25) close.push([gy - 621, `تحویل سال ${tehran} به وقت تهران`, `نوروز برنامه ${program}`])
  }
  obs('years compared', 103)
  obs('mismatches', mismatches)
  obs('close calls (equinox within 25 minutes of noon)', close)
  for (const m of mismatches) finding('CALENDAR_MISMATCH', `نوروز ${m[0]}: نجومی ${m[1]} ولی برنامه ${m[2]}`, 'A1', m)
  obs('leap years 1404–1506 (program)', Array.from({ length: 103 }, (_, i) => 1404 + i).filter((y) => jal.isLeapJalaaliYear(y)))
}

begin('A2', 'تقویم سیستم (ICU؛ چند نمایش با toLocaleString) در برابر تقویم برنامه، هر روز ۲۰۲۶ تا ۲۱۲۷')
{
  const icu = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' })
  const diffs = []
  let days = 0
  for (let t = RealDate.UTC(2026, 0, 1); t <= RealDate.UTC(2127, 11, 31); t += 86400000) {
    days++
    const d = new RealDate(t)
    const a = jal.toJalaali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    const p = Object.fromEntries(icu.formatToParts(new RealDate(t + 43200000)).map((x) => [x.type, x.value]))
    if (+p.year !== a.jy || +p.month !== a.jm || +p.day !== a.jd) diffs.push([ymdUTC(t), `${a.jy}/${a.jm}/${a.jd}`, `${p.year}/${p.month}/${p.day}`])
  }
  const ranges = []
  for (const d of diffs) { const last = ranges.at(-1); if (last && RealDate.parse(d[0]) - RealDate.parse(last.to) === 86400000) { last.to = d[0]; last.days++ } else ranges.push({ from: d[0], to: d[0], days: 1, first: d }) }
  obs('days compared', days)
  obs('system calendar (ICU) version', process.versions.icu)
  obs('differing ranges', ranges.map((r) => ({ from: r.from, to: r.to, days: r.days, program: r.first[1], system: r.first[2] })))
  for (const r of ranges) finding('SYSTEM_CALENDAR_DIFF', `از ${r.from} تا ${r.to} (${r.days} روز): برنامه ${r.first[1]} ولی تقویم سیستم ${r.first[2]}`, 'نمایش (۴-۱۳۴)')
  const spots = []
  for (const f of ['src/renderer/src/components/BridgeDiagnosticsModal.tsx', 'src/renderer/src/components/CustodyAdminChip.tsx', 'src/renderer/src/pages/CashClose.tsx', 'src/renderer/src/pages/CreditManagement.tsx', 'src/renderer/src/pages/Settings.tsx']) {
    const text = readFileSync(join(REPO, f), 'utf8')
    const c = (text.match(/new Date\([^)]*\)\.toLocaleString\('fa-IR(?:-u-ca-persian)?'\)/g) ?? []).length
    if (c) spots.push([f.split('/').pop(), c])
  }
  obs('display spots that use the system calendar', spots)
  // اگر jalaali-js واقعی کنار مخزن نصب باشد، یکی بودن جایگزین هارنس با آن (فقط چاپ؛ جزو نتیجهٔ فشرده نیست)
  for (const p of [join(REPO, 'node_modules/jalaali-js/index.js'), join(REPO, '../node_modules/jalaali-js/index.js')]) {
    if (!existsSync(p)) continue
    const real = (await import(pathToFileURL(p).href)).default
    let diff = 0, cnt = 0
    for (let t = RealDate.UTC(1990, 0, 1); t <= RealDate.UTC(2200, 11, 31); t += 86400000) {
      const d = new RealDate(t); cnt++
      const a = real.toJalaali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), b = jal.toJalaali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
      if (a.jy !== b.jy || a.jm !== b.jm || a.jd !== b.jd) diff++
    }
    console.log(`(چاپ جانبی) jalaali-js واقعی در برابر جایگزین هارنس، ۱۹۹۰ تا ۲۲۰۰: ${cnt} روز، ${diff} تفاوت (${p})`)
    break
  }
}

begin('A3', 'تابع‌های تاریخ برنامه، هر روز از ۲۰۲۶ تا ۲۱۲۷ (به وقت تهران)')
{
  const fails = new Map()
  const fail = (kind, ex) => { const f = fails.get(kind) ?? { count: 0, first: ex }; f.count++; fails.set(kind, f) }
  let days = 0
  const dayLen = new Map()
  let prevJ = null
  for (let t = new RealDate(2026, 0, 1).getTime(); ; ) {
    const d0 = new RealDate(t)
    if (d0.getFullYear() > 2127) break
    days++
    const y = d0.getFullYear(), mo = d0.getMonth(), da = d0.getDate()
    const midnight = new RealDate(y, mo, da).getTime(), next = new RealDate(y, mo, da + 1).getTime()
    const len = (next - midnight) / 3600000
    dayLen.set(len, (dayLen.get(len) ?? 0) + 1)
    const instants = [midnight + 30_000, midnight + 4 * 3600000 + 59 * 60000, midnight + 12 * 3600000, next - 1000]
    const js = instants.map((x) => toJalaliDate(new RealDate(x)))
    const j = js[0]
    if (js.some((x) => x !== j)) fail('one local day ⇒ one Jalali date', [d0.toDateString(), js])
    if (!J.isValidJalaliDate(j)) fail('isValidJalaliDate(today)', j)
    if (J.fromJalaliDate(j).getTime() !== midnight) fail('fromJalaliDate round trip', j)
    if (jalaliStartOfDay(j).getTime() !== midnight) fail('jalaliStartOfDay', j)
    if (J.jalaliEndOfDay(j).getTime() !== next - 1) fail('jalaliEndOfDay', j)
    if (prevJ) {
      if (jalaliAddDays(prevJ, 1) !== j) fail('jalaliAddDays(+1) continuity', [prevJ, j])
      if (B.addJalaliDays(j, -1) !== prevJ) fail('addJalaliDays(-1)', [j, prevJ])
      if (!(j > prevJ)) fail('string order = time order', [prevJ, j])
    }
    const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(da).padStart(2, '0')}`
    if (T.tehranDateKey(new RealDate(instants[2])) !== key || T.tehranDateKey(new RealDate(instants[3])) !== key) fail('tehranDateKey', key)
    if (T.tehranStartOfDay(new RealDate(instants[1])).getTime() !== midnight) fail('tehranStartOfDay', key)
    if (T.tehranEndOfDayAfter(new RealDate(instants[2]), 0).getTime() !== next - 1) fail('tehranEndOfDayAfter(0)', key)
    if (J.jalaliMonthStart(j) !== j.slice(0, 8) + '01') fail('jalaliMonthStart', j)
    prevJ = j
    t = next
  }
  // سال به سال: کبیسه، ماه‌ها، روند ماهانه، «همین ماه پارسال»، انقضای «تا پایان روز» در مرز سال
  const leapYears = []
  for (let jy = 1405; jy <= 1506; jy++) {
    const leap = B.monthLength(jy, 12) === 30
    if (leap) leapYears.push(jy)
    if (J.isValidJalaliDate(`${jy}/12/30`) !== leap) fail('30 Esfand only in leap years', jy)
    if (J.isValidJalaliDate(`${jy}/12/31`)) fail('no 31 Esfand', jy)
    if (B.monthEnd(`${jy}/12/01`) !== `${jy}/12/${leap ? 30 : 29}`) fail('monthEnd(Esfand)', jy)
    const buckets = B.enumerateBuckets(`${jy}/01/01`, `${jy}/12/${leap ? 30 : 29}`, 'month')
    const total = buckets.reduce((s, b) => s + J.jalaliDaysBetween(b.fromJalali, b.toJalali).length, 0)
    if (buckets.length !== 12 || total !== (leap ? 366 : 365)) fail('12 month buckets = 365/366 days', [jy, buckets.length, total])
    const ly = B.sameMonthLastYear(`${jy}/12/01`, `${jy}/12/${leap ? 30 : 29}`)
    if (!J.isValidJalaliDate(ly.toJalali)) fail('sameMonthLastYear(Esfand) valid', [jy, ly.toJalali])
    const lastDay = `${jy}/12/${leap ? 30 : 29}`, firstNext = `${jy + 1}/01/01`
    if (jalaliAddDays(lastDay, 1) !== firstNext) fail('last day of year + 1 = 1 Farvardin', jy)
    const issued = new RealDate(wall(lastDay, '20:00'))
    const exp = T.tehranEndOfDayAfter(issued, 1)
    if (toJalaliDate(exp) !== firstNext || exp.getTime() !== J.jalaliEndOfDay(firstNext).getTime()) fail('1-day validity issued on the last night ends with 1 Farvardin', jy)
    if (T.isPastTehranExpiryDate(exp, wall(firstNext, '23:59'))) fail('not expired during 1 Farvardin', jy)
    if (!T.isPastTehranExpiryDate(exp, wall(jalaliAddDays(firstNext, 1), '00:00') + 1000)) fail('expired on 2 Farvardin', jy)
    const thirty = T.tehranEndOfDayAfter(new RealDate(wall(`${jy}/12/15`, '10:00')), 30)
    if (toJalaliDate(thirty) !== jalaliAddDays(`${jy}/12/15`, 30)) fail('30-day validity across the year', jy)
  }
  obs('days checked', days)
  obs('day lengths (hours → days)', [...dayLen.entries()].sort())
  obs('leap years (program functions)', leapYears)
  obs('failures', [...fails.entries()].map(([k, v]) => [k, v.count]))
  for (const [k, v] of fails) finding('DATE_FUNCTION_FAILURE', `${k}: ${v.count} مورد`, 'A3', v.first)
}

// =================================================================== بخش ب — برنامه روی پایگاه موقت
go('1405/12/25', '07:50')
const owner = seed.user('مالک فروشگاه')
const seller = seed.user('فروشنده')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
const cat = seed.category('ممیزی مرز سال')
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const DEBTOR = { firstName: 'رضا', lastName: 'ممیزی', phone: '09121234567', nationalId: null }

registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[priceAdjust]')) return; orig(...a) })(console.log)

let vseq = 0
const OPENING = 200
const VARS = []
function V(label, price) {
  const pid = seed.product(`year-${label}-${++vseq}`, cat)
  const id = seed.variant(pid, `${label}-${vseq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=?, code=?, barcode=? WHERE id=?').run(OPENING, price, `YEAR-${label}`, `BYEAR-${label}`, id)
  const v = { id, label, price }
  VARS.push(v)
  return v
}
const lineOf = (v, qty = 1, unitPrice = v.price) => ({ variantId: v.id, qty, unitPrice, discount: 0, tax: 0 })
const itemFor = (invoiceId, v) => n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=? ORDER BY id', invoiceId, v.id)?.id)
const priceOf = (v) => n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?', v.id)?.salePrice)
function ledgerCheck(label) {
  for (const v of VARS) {
    const st = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id)?.stock)
    const mv = n(seed.one('SELECT COALESCE(SUM(delta),0) s FROM "StockMovement" WHERE variantId=?', v.id)?.s)
    if (st !== OPENING + mv) finding('STOCK_LEDGER_MISMATCH', `${label}: ${v.label} stock ${st} ≠ ${OPENING} + movements ${mv}`)
  }
}

// ---------------------------------------------------------------- کارهای صفحه‌ها (همان ابزار مرز روز)
const OWNER_PIN = 'Owner-Pin-7391!', SELLER_TMP = 'Seller-Tmp-48!', SELLER_PIN = 'Seller-Pin-5527!'
let drawer = 0
const openDrawer = (label, plan) => call(`${label} (PIN + count ${drawer.toLocaleString('en')})`, 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: drawer }, plan)
const finalClose = (label) => call(`${label} (count ${drawer.toLocaleString('en')})`, 'ok', IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: drawer })
const pos = async (label, v, kind, expect = 'ok', plan, unitPrice = v.price) => {
  const payments = kind === 'NESIEH' ? [] : [{ methodId: kind === 'CARD' ? cardM : cashM, amount: unitPrice, destination: kind === 'CARD' ? 'CARD' : 'CASH' }]
  const r = await call(label, expect, IPC.saleCreate, { lines: [lineOf(v, 1, unitPrice)], payments, ...(kind === 'NESIEH' ? { debtor: DEBTOR } : {}), saleRequestIdempotencyKey: `year-sale-${++keySeq}` }, plan,
    (d) => ({ receiptNo: n(d.receiptNo), day: d.issuedAtJalali ?? null, grandTotal: n(d.grandTotal) }))
  if (r.ok && kind !== 'NESIEH') drawer += unitPrice
  return r
}
const wholesale = async (label, jday, v, expect = 'ok', plan) => {
  unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
  const r = await call(label, expect, IPC.saleCreate, { orderType: 'WHOLESALE', issuedAtJalali: jday, lines: [lineOf(v)], payments: [{ methodId: cashM, amount: v.price, destination: 'CASH' }], saleRequestIdempotencyKey: `year-sale-${++keySeq}` }, plan,
    (d) => ({ receiptNo: n(d.receiptNo), day: d.issuedAtJalali ?? null, grandTotal: n(d.grandTotal) }))
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
  const input = { invoiceId, lines, full: false, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `year-ex-${++keySeq}` }
  if (pv.data.discountTransfer) input.discountTransferOption = 'NO'
  if (diff > 0) input.methodId = cashM
  else if (diff < 0) { input.exchangeSettlementDecision = 'METHOD'; input.refundMode = 'CASH' }
  const r = await call(`${label} (diff ${diff})`, expect, IPC.saleExchangeCreate, input, plan, () => ({ diff }))
  if (r.ok) drawer += diff
  return r
}
/** تجمیع خودکار ۴-۱۱۱ (شبیه‌سازی): همان سرویس F11 با کاربر «سیستم»، همهٔ روزهای پیش از امروز که فاکتور تجمیع‌نشده دارند («روزهای جامانده‌تر هم»). */
/** «+voidedAt» تا پرس‌وجو با شاخص consolidationId برود، نه با خواندن همهٔ تاریخچه. */
const pendingDaysBefore = (today) => seed.rows(`SELECT DISTINCT issuedAtJalali d FROM "SaleInvoice" WHERE consolidationId IS NULL AND +voidedAt IS NULL AND issuedAtJalali < ? ORDER BY 1`, today).map((r) => r.d)
const autoConsolidation = async (label, plan = '4-111 الف') => {
  const today = toJalaliDate(new Date())
  const before = moneyStock()
  return svc(label, 'ok', async () => {
    const days = pendingDaysBefore(today)
    const res = days.length ? await cashboxService.finalizeDays({ days, userId: null }) : { done: [], invoiceCount: 0, finalizedMovements: 0 }
    const after = moneyStock()
    const delta = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]))
    if (Object.values(delta).some((x) => x !== 0)) finding('MONEY_OR_STOCK_TOUCHED', `${CLOCK} ${label}`, plan, delta)
    obs('autoConsolidation', { at: CLOCK, days: res.done.map((d) => d.dayJalali), invoices: n(res.invoiceCount), movements: n(res.finalizedMovements) })
    return res
  }, plan)
}
/** صبح پس از فراموشی «بستن نهایی»: وضعیت (بستن خودکار)، تجمیع خودکار، شمارش شاهد، باز کردن صندوق. */
const morningAfterForgotten = async (label) => {
  const st = await call(`${label}: custody status (automatic close of the forgotten drawer)`, 'ok', IPC.custodyStatus, {}, '4-17، ۴-۱۸', (d) => ({ state: d.state, unresolved: n(d.unresolvedCount) }))
  await autoConsolidation('automatic consolidation after the automatic close')
  const resolutionId = st.ok ? n(st.data.unresolved?.[0]?.id) : 0
  let rec = await call('witness count of the old drawer (seller PIN, exact count)', 'either', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: drawer }, '4-104')
  if (!rec.ok) rec = await call('witness count again with a note', 'ok', IPC.custodyUnattendedRecover, { resolutionId, userId: seller, password: SELLER_PIN, countedCash: drawer, note: 'شمارش صبح پس از تعطیلی' }, '4-104')
  return rec
}
/** «گزارشات فروش» ← سرجمع: تعداد و جمع فاکتورهای بازه (برگشت‌ها جدا در returnedTotal). */
const rep = async (label, from, to, expect = 'ok') => {
  unlock(PANEL_KEYS.salesReports)
  const r = await call(`sales report ${label} (${from} … ${to})`, expect, IPC.saleReportSummary, { fromJalali: from, toJalali: to }, 'گزارش',
    (d) => ({ count: n(d.count), grandTotal: n(d.grandTotal), returned: n(d.returnedTotal), exchangeReturned: n(d.exchangeReturnedTotal) }))
  return r.ok ? { count: n(r.data.count), grandTotal: n(r.data.grandTotal) } : null
}
/** «گزارش مدیریت»: فروش خالص (برگشت‌ها در روز برگشت کم می‌شوند)؛ پس با گزارش مدیریت بازه‌های کوچک‌تر جمع زده می‌شود، نه با جمع فاکتورها. */
const mg = async (label, from, to) => {
  unlock(PANEL_KEYS.managementReports, PANEL_KEYS.managementProfit)
  const r = await call(`management report ${label} (${from} … ${to})`, 'ok', IPC.mgmtSnapshot, { fromJalali: from, toJalali: to }, 'گزارش',
    (d) => ({ invoiceCount: n(d.accounting?.invoice?.invoiceCount), netAccrualSales: n(d.accounting?.invoice?.netAccrualSales) }))
  return r.ok ? { count: n(r.data.accounting?.invoice?.invoiceCount), grandTotal: n(r.data.accounting?.invoice?.netAccrualSales) } : null
}
const agree = (label, a, b, type = 'REPORT_SUM_MISMATCH') => {
  if (!a || !b) return
  if (a.count !== b.count || a.grandTotal !== b.grandTotal) finding(type, `${label}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`, 'گزارش')
}
const sameCount = (label, salesRep, mgmt) => {
  if (!salesRep || !mgmt) return
  if (salesRep.count !== mgmt.count) finding('REPORT_VS_MANAGEMENT', `${label}: تعداد فاکتور گزارشات فروش ${salesRep.count} ≠ گزارش مدیریت ${mgmt.count}`, 'گزارش')
}
const sumOf = (...xs) => xs.reduce((s, x) => ({ count: s.count + (x?.count ?? 0), grandTotal: s.grandTotal + (x?.grandTotal ?? 0) }), { count: 0, grandTotal: 0 })

const a = V('A', 700_000), b = V('B', 300_000), c = V('C', 500_000), w = V('W', 1_000_000), e = V('E', 300_000), nw = V('N', 2_000_000)

begin('S0', 'راه‌اندازی: رمز شخصی مالک و فروشنده، روشن کردن حضانت صندوق (مثل فروشگاه مالک)')
await svc('owner sets personal custody PIN', 'ok', () => custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW }))
await svc('enable custody (single shift)', 'ok', () => custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN }))
await svc('owner issues a temporary PIN for the seller', 'ok', () => custodyService.setPin({ userId: seller, newPassword: SELLER_TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'راه‌اندازی آزمون مرز سال' }))
await svc('seller sets personal PIN', 'ok', () => custodyService.setPin({ userId: seller, currentPassword: SELLER_TMP, newPassword: SELLER_PIN }))

// =================================================================== Y1
begin('Y1', 'شب آخر ۱۴۰۵ و روز اول ۱۴۰۶ (۲۰ و ۲۱ مارس ۲۰۲۷): حراج نوروزی، چک سال بعد، فروش ۲۳:۵۰، تجمیع، برگشت و گزارش‌ها')
go('1405/12/25', '09:00'); drawer = 2_000_000; await openDrawer('seller opens the drawer')
go('1405/12/25', '09:05'); unlock(PANEL_KEYS.priceAdjust)
await call('schedule Nowruz sale −20% on N from 1405/12/25 09:30 to 1406/01/13 23:59', 'ok', IPC.priceAdjustApply,
  { kind: 'DISCOUNT', mode: 'PERCENT', value: 20, scope: 'VARIANTS', variantIds: [nw.id], target: 'SALE', round: 1000, startDate: '1405/12/25', startTime: '09:30', endDate: '1406/01/13', endTime: '23:59', note: 'حراج نوروزی', password: PW })
go('1405/12/25', '09:31'); await priceAdjustService.runDueSchedules(new Date())
obs('N price after the sale starts (1405/12/25 09:31)', priceOf(nw))
if (priceOf(nw) !== 1_600_000) finding('CAMPAIGN_NOT_APPLIED', `${CLOCK} قیمت N پس از شروع حراج ${priceOf(nw)}`, 'زمان‌بندی')
go('1405/12/25', '09:40'); await pos('POS sale N at the Nowruz price 1,600,000 (cash)', nw, 'CASH', 'ok', 'زمان‌بندی', 1_600_000)
go('1405/12/25', '10:00'); const q1 = await pos('POS sale C نسیه 500,000', c, 'NESIEH')
go('1405/12/25', '10:05'); const chq = await call('cheque 500,000 for sale C, due 1406/01/15 (next year)', 'ok', IPC.salePaymentAdd, { invoiceId: n(q1.data?.id), kind: 'CHEQUE', amount: 500_000, chequeNo: 'YEAR-Q-1', bankName: 'ملت', dueDateJalali: '1406/01/15' }, 'چک', (d) => ({ status: d?.payment?.chequeStatus ?? null }))
go('1405/12/25', '21:00'); await finalClose('«بستن نهایی»')
go('1405/12/29', '08:30'); await autoConsolidation('program opens on the last day of the year: automatic consolidation')
go('1405/12/29', '08:31'); await openDrawer('seller opens the drawer', 'بند ۱۴')
go('1405/12/29', '10:00'); const y1a = await pos('POS sale A cash 700,000', a, 'CASH')
go('1405/12/29', '12:00'); const y1b = await pos('POS sale B card 300,000', b, 'CARD')
go('1405/12/29', '18:00'); await wholesale('wholesale W 1,000,000 dated 1405/12/29', '1405/12/29', w)
go('1405/12/29', '19:00'); unlock(PANEL_KEYS.purchase)
const pu1 = await call('purchase W×5@600,000 on the last day of 1405', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 3_000_000, lines: [{ variantId: w.id, qty: 5, unitPrice: 600_000 }] }, 'خرید', (d) => ({ invoiceNo: n(d.invoiceNo) }))
go('1405/12/29', '23:50'); const late = await pos('POS sale E cash 300,000 at 23:50 on the last night', e, 'CASH')
obs('the 23:50 sale is dated', late.ok ? late.data.issuedAtJalali : null)
if (late.ok && late.data.issuedAtJalali !== '1405/12/29') finding('DATE_FUNCTION_FAILURE', `${CLOCK} فروش ۲۳:۵۰ شب آخر با تاریخ ${late.data.issuedAtJalali} ثبت شد`, 'مرز روز')
go('1405/12/29', '23:58'); await finalClose('«بستن نهایی» of the last night of 1405')
go('1406/01/01', '10:00'); await autoConsolidation('program opens on 1 Farvardin 1406: automatic consolidation of 1405/12/29')
go('1406/01/01', '10:01'); await openDrawer('seller opens the drawer on 1 Farvardin', 'بند ۱۴')
await priceAdjustService.runDueSchedules(new Date())
obs('N price on 1 Farvardin (sale runs until 1406/01/13)', priceOf(nw))
if (priceOf(nw) !== 1_600_000) finding('CAMPAIGN_NOT_APPLIED', `${CLOCK} حراج نوروزی پس از تحویل سال قیمت ${priceOf(nw)} دارد`, 'زمان‌بندی')
go('1406/01/01', '10:05'); await pos('POS sale N at the Nowruz price 1,600,000 (card)', nw, 'CARD', 'ok', 'زمان‌بندی', 1_600_000)
obs('return deadline of the 1405/12/29 sale (returnCodeDays = 1)', toJalaliDate(new Date(seed.one('SELECT returnCodeExpiresAt x FROM "SaleInvoice" WHERE id=?', n(y1a.data?.id))?.x)))
go('1406/01/01', '10:10'); await fullReturn('full return of the 1405/12/29 sale A (last year, consolidated)', y1a, a.price, 'ok', 'بند ۱۴')
go('1406/01/01', '10:15'); await exchange('exchange of the 1405/12/29 sale B → E (same price)', y1b, b, e, 'ok', 'بند ۱۴')
go('1406/01/01', '10:18'); unlock(PANEL_KEYS.purchase)
const pu2 = await call('purchase W×5@650,000 on 1 Farvardin 1406', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 3_250_000, lines: [{ variantId: w.id, qty: 5, unitPrice: 650_000 }] }, 'خرید', (d) => ({ invoiceNo: n(d.invoiceNo) }))
obs('purchase numbers across the year', [n(pu1.data?.invoiceNo), n(pu2.data?.invoiceNo)])
if (pu1.ok && pu2.ok && n(pu2.data.invoiceNo) !== n(pu1.data.invoiceNo) + 1) finding('RECEIPT_GAP', `شمارهٔ خرید پس از تحویل سال پیوسته نیست: ${n(pu1.data.invoiceNo)} ⇒ ${n(pu2.data.invoiceNo)}`, 'شماره')
go('1406/01/01', '10:20'); await wholesale('wholesale W dated 1406/01/01', '1406/01/01', w, 'ok', 'بند ۱۴')
const stale = await wholesale('wholesale page left open since last night (date still 1405/12/29)', '1405/12/29', w, 'either', '4-111 ب')
obs('old-date wholesale after consolidation', stale.ok ? 'ثبت شد' : `${stale.code ?? ''} ${firstLine(stale.error).slice(0, 160)}`)
go('1406/01/01', '10:30')
const d25 = await rep('day 1405/12/25', '1405/12/25', '1405/12/25')
const d29 = await rep('day 1405/12/29', '1405/12/29', '1405/12/29')
const d01 = await rep('day 1406/01/01', '1406/01/01', '1406/01/01')
const esf = await rep('Esfand 1405', '1405/12/01', '1405/12/29')
const yr05 = await rep('year 1405', '1405/01/01', '1405/12/29')
const cross = await rep('across the years', '1405/12/20', '1406/01/01')
agree('Esfand 1405 = 1405/12/25 + 1405/12/29', esf, sumOf(d25, d29))
agree('year 1405 = Esfand 1405 (no sales before)', yr05, esf)
agree('1405/12/20…1406/01/01 = three days', cross, sumOf(d25, d29, d01))
const mCross = await mg('across the years', '1405/12/20', '1406/01/01')
const mEsf = await mg('Esfand 1405', '1405/12/01', '1405/12/29'), mYr05 = await mg('year 1405', '1405/01/01', '1405/12/29'), mD01 = await mg('day 1406/01/01', '1406/01/01', '1406/01/01')
agree('management: across the years = Esfand 1405 + 1 Farvardin 1406', mCross, sumOf(mEsf, mD01))
agree('management: year 1405 = Esfand 1405', mYr05, mEsf)
sameCount('across the years', cross, mCross); sameCount('year 1405', yr05, mYr05)
obs('sales report vs management on 1 Farvardin (returns of last year’s sales are subtracted on the return day)', { salesReport: d01, management: mD01 })
{
  const bad = await rep('range ending 1405/12/30 (API only; the page checks the date first: SalesReports.tsx)', '1405/12/01', '1405/12/30', 'either')
  obs('sales report API with 1405/12/30 (that day does not exist)', bad ? { ...bad, sameAsUpTo1406_01_01: bad.count === cross.count && bad.grandTotal === cross.grandTotal } : 'refused')
}
{
  unlock(PANEL_KEYS.managementReports)
  const tr = await call('management trend by month 1405/12 … 1406/01', 'ok', IPC.mgmtTrend, { fromJalali: '1405/12/01', toJalali: '1406/01/01', grain: 'month' }, 'گزارش',
    (d) => (d.points ?? []).map((p) => [p.label, n(p.invoiceCount), n(p.netAccrualSales), p.lastYearLabel ?? null]))
  if (tr.ok) {
    const pts = tr.data.points ?? []
    obs('monthly buckets', pts.map((p) => [p.label, p.fromJalali, p.toJalali]))
    const esfPt = pts.find((p) => p.label === '1405/12'), farPt = pts.find((p) => p.label === '1406/01')
    if (!esfPt || !farPt) finding('REPORT_SUM_MISMATCH', 'روند ماهانه ستون اسفند ۱۴۰۵ یا فروردین ۱۴۰۶ ندارد', 'گزارش')
    else {
      agree('trend Esfand bucket = management Esfand', { count: n(esfPt.invoiceCount), grandTotal: n(esfPt.netAccrualSales) }, mEsf)
      agree('trend Farvardin bucket = management 1 Farvardin', { count: n(farPt.invoiceCount), grandTotal: n(farPt.netAccrualSales) }, mD01)
    }
  }
}
go('1406/01/01', '21:00'); await finalClose('«بستن نهایی» 1 Farvardin')
go('1406/01/14', '00:05'); await priceAdjustService.runDueSchedules(new Date())
obs('N price after the sale ends (1406/01/14 00:05)', priceOf(nw))
if (priceOf(nw) !== 2_000_000) finding('CAMPAIGN_NOT_REVERTED', `${CLOCK} قیمت N پس از پایان حراج ${priceOf(nw)}`, 'زمان‌بندی')
go('1406/01/15', '10:00'); await autoConsolidation('program opens on 1406/01/15')
go('1406/01/15', '10:01'); await openDrawer('seller opens the drawer')
{
  unlock(PANEL_KEYS.salesReports)
  const rowsOf = (d) => (Array.isArray(d) ? d : d?.rows ?? [])
  const due = await call('cheque list due 1406/01/15', 'ok', IPC.saleChequeList, { fromJalali: '1406/01/15', toJalali: '1406/01/15' }, 'چک', (d) => ({ rows: rowsOf(d).length }))
  const dueOld = await call('cheque list due in Esfand 1405 (should be empty)', 'ok', IPC.saleChequeList, { fromJalali: '1405/12/01', toJalali: '1405/12/29' }, 'چک', (d) => ({ rows: rowsOf(d).length }))
  if (due.ok && rowsOf(due.data).length !== 1) finding('REPORT_SUM_MISMATCH', `چک با سررسید ۱۴۰۶/۰۱/۱۵ در فهرست همان روز ${rowsOf(due.data).length} ردیف دارد`, 'چک')
  if (dueOld.ok && rowsOf(dueOld.data).length !== 0) finding('REPORT_SUM_MISMATCH', 'چک سال بعد در فهرست سررسید اسفند آمد', 'چک')
}
await call('cheque 500,000 CLEARED → manager account', 'ok', IPC.saleChequeStatus, { id: n(chq.data?.payment?.id), status: 'CLEARED', destination: 'MANAGER', managerPassword: PW }, 'چک')
go('1406/01/15', '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y1')

// =================================================================== Y2
begin('Y2', 'تعطیلات نوروز ۱۴۰۷: صندوق ۱۴۰۶/۱۲/۲۷ باز ماند و برنامه ۱۶ روز بعد (۱۴۰۷/۰۱/۱۴) باز شد')
go('1406/12/27', '08:55'); await autoConsolidation('program opens on 1406/12/27')
go('1406/12/27', '09:00'); await openDrawer('seller opens the drawer')
go('1406/12/27', '11:00'); const y2a = await pos('POS sale A cash 700,000', a, 'CASH')
go('1406/12/27', '12:00'); await pos('POS sale B card 300,000 (nobody closes the drawer; the shop closes for Nowruz)', b, 'CARD')
go('1407/01/14', '09:00')
{
  unlock(PANEL_KEYS.consolidation)
  const def = await call('consolidation page with its default range (start of this month … today)', 'ok', IPC.consolidationDays, { fromJalali: jalaliMonthStart(), toJalali: toJalaliDate(new Date()) }, '۴-۱۱۱', (d) => ({ pendingDays: d.pendingDays }))
  const wide = await call('consolidation page with the range moved back to Esfand', 'ok', IPC.consolidationDays, { fromJalali: '1406/12/01', toJalali: toJalaliDate(new Date()) }, '۴-۱۱۱', (d) => ({ pendingDays: d.pendingDays }))
  if (def.ok && wide.ok && !def.data.pendingDays.length && wide.data.pendingDays.length)
    finding('PREVIOUS_MONTH_PENDING_HIDDEN', `صفحهٔ «تجمیع و انتقال» با بازهٔ پیش‌فرض (${jalaliMonthStart()} تا امروز) روز تجمیع‌نشدهٔ ${wide.data.pendingDays.join('، ')} را نشان نمی‌دهد`, '۴-۱۳۳')
}
await morningAfterForgotten('program opens 16 days later')
go('1407/01/14', '09:10'); await openDrawer('first shift opens the drawer after the holidays', 'بند ۱۴')
go('1407/01/14', '09:15'); await pos('POS sale E cash 300,000', e, 'CASH', 'ok', 'بند ۱۴')
go('1407/01/14', '09:20')
{
  const r = await fullReturn('full return of the 1406/12/27 sale A after 17 days (return window = 1 day)', y2a, a.price, 'either', 'مهلت برگشت')
  obs('return after the window', r.ok ? 'ثبت شد' : firstLine(r.error).slice(0, 200))
}
{
  const gap = await rep('Nowruz holidays 1406/12/28 … 1407/01/13 (closed)', '1406/12/28', '1407/01/13')
  if (gap && (gap.count !== 0 || gap.grandTotal !== 0)) finding('REPORT_SUM_MISMATCH', `روزهای تعطیل فروش نشان می‌دهند: ${JSON.stringify(gap)}`, 'گزارش')
  const r1 = await rep('1406/12/20 … 1407/01/14', '1406/12/20', '1407/01/14'), r2 = await rep('1406/12/27', '1406/12/27', '1406/12/27'), r3 = await rep('1407/01/14', '1407/01/14', '1407/01/14')
  agree('1406/12/20 … 1407/01/14 = 1406/12/27 + 1407/01/14', r1, sumOf(r2, r3))
  sameCount('1406/12/20 … 1407/01/14', r1, await mg('1406/12/20 … 1407/01/14', '1406/12/20', '1407/01/14'))
}
go('1407/01/14', '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y2')

// =================================================================== Y3
begin('Y3', 'سال کبیسهٔ ۱۴۰۸: ۳۰ اسفند ۱۴۰۸ (۲۰ مارس ۲۰۳۰) و روز اول ۱۴۰۹')
go('1408/12/30', '08:55'); await autoConsolidation('program opens on 1408/12/30')
go('1408/12/30', '09:00'); await openDrawer('seller opens the drawer on 30 Esfand')
go('1408/12/30', '10:00'); const y3a = await pos('POS sale A cash 700,000 on 30 Esfand', a, 'CASH')
obs('sale on 30 Esfand is dated', y3a.ok ? y3a.data.issuedAtJalali : null)
go('1408/12/30', '11:00'); await wholesale('wholesale W dated 1408/12/30', '1408/12/30', w)
go('1408/12/30', '11:05'); await wholesale('wholesale W dated 1407/12/30 (that day does not exist)', '1407/12/30', w, 'refuse', 'تاریخ')
go('1408/12/30', '11:10')
const e08 = await rep('Esfand 1408 (30 days)', '1408/12/01', '1408/12/30')
const d30 = await rep('day 1408/12/30', '1408/12/30', '1408/12/30')
agree('Esfand 1408 = 30 Esfand', e08, d30)
go('1408/12/30', '21:00'); await finalClose('«بستن نهایی» of 30 Esfand')
go('1409/01/01', '09:00'); await autoConsolidation('program opens on 1 Farvardin 1409: consolidation of 30 Esfand')
go('1409/01/01', '09:01'); await openDrawer('seller opens the drawer')
go('1409/01/01', '09:10'); await pos('POS sale B card 300,000', b, 'CARD')
go('1409/01/01', '09:15'); await fullReturn('full return of the 30 Esfand sale A', y3a, a.price, 'ok', 'بند ۱۴')
agree('year 1408 report = 30 Esfand (only sales of 1408)', await rep('year 1408', '1408/01/01', '1408/12/30'), d30)
{
  unlock(PANEL_KEYS.managementReports)
  const tr = await call('management trend by month 1408/11 … 1409/01 (with “same month last year”)', 'ok', IPC.mgmtTrend, { fromJalali: '1408/11/01', toJalali: '1409/01/01', grain: 'month' }, 'گزارش',
    (d) => (d.points ?? []).map((p) => [p.label, n(p.invoiceCount), p.lastYearLabel ?? null]))
  if (tr.ok) obs('monthly buckets with last-year labels', (tr.data.points ?? []).map((p) => [p.label, p.toJalali, p.lastYearLabel ?? null]))
}
go('1409/01/01', '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y3')

// =================================================================== Y4
const F28 = toJalaliDate(new RealDate(2100, 1, 28, 12)), M01 = toJalaliDate(new RealDate(2100, 2, 1, 12))
begin('Y4', `سال ۲۱۰۰ میلادی (کبیسه نیست؛ ۲۹ فوریه ندارد): ${F28} (۲۸ فوریه) و ${M01} (۱ مارس) — ۶۹ سال پس از آخرین فروش`)
obs('2100-02-28 and 2100-03-01 in the program calendar', [F28, M01, jalaliAddDays(F28, 1) === M01])
go(F28, '08:55'); await autoConsolidation('program opens after 69 years')
go(F28, '09:00'); await openDrawer('seller opens the drawer on 2100-02-28')
go(F28, '10:00'); const y4a = await pos('POS sale A cash 700,000 on 2100-02-28', a, 'CASH')
go(F28, '21:00'); await finalClose('«بستن نهایی»')
go(M01, '09:00'); await autoConsolidation('program opens on 2100-03-01')
go(M01, '09:01'); await openDrawer('seller opens the drawer on 2100-03-01')
go(M01, '10:00'); const y4 = await pos('POS sale B card 300,000 on 2100-03-01', b, 'CARD')
const isoLocal = (id) => { const d = new Date(seed.one('SELECT issuedAt FROM "SaleInvoice" WHERE id=?', id)?.issuedAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
obs('Gregorian (Tehran) / Jalali of the two sales', [y4a.ok ? [isoLocal(n(y4a.data.id)), y4a.data.issuedAtJalali] : null, y4.ok ? [isoLocal(n(y4.data.id)), y4.data.issuedAtJalali] : null])
{
  const r1 = await rep(`${F28} … ${M01}`, F28, M01), r2 = await rep(F28, F28, F28), r3 = await rep(M01, M01, M01)
  agree('two days = 2100-02-28 + 2100-03-01', r1, sumOf(r2, r3))
  sameCount(`${F28} … ${M01}`, r1, await mg(`${F28} … ${M01}`, F28, M01))
}
go(M01, '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y4')

// =================================================================== Y5
begin('Y5', 'سال ۱۴۹۹ به ۱۵۰۰ (۲۰ و ۲۱ مارس ۲۱۲۱): فروش، تجمیع، گزارش، بکاپ و شمارهٔ فاکتور')
go('1499/12/29', '08:55'); await autoConsolidation('program opens on 1499/12/29')
go('1499/12/29', '09:00'); await openDrawer('seller opens the drawer')
go('1499/12/29', '10:00'); const y5a = await pos('POS sale A cash 700,000', a, 'CASH')
go('1499/12/29', '11:00'); await wholesale('wholesale W dated 1499/12/29', '1499/12/29', w)
go('1499/12/29', '23:50'); await pos('POS sale E cash 300,000 at 23:50 on the last night of 1499', e, 'CASH')
go('1499/12/29', '23:58'); await finalClose('«بستن نهایی»')
go('1500/01/01', '10:00'); await autoConsolidation('program opens on 1 Farvardin 1500')
go('1500/01/01', '10:01'); await openDrawer('seller opens the drawer on 1 Farvardin 1500')
go('1500/01/01', '10:05'); const y5b = await pos('POS sale B card 300,000 on 1 Farvardin 1500', b, 'CARD')
obs('sale dated', y5b.ok ? y5b.data.issuedAtJalali : null)
go('1500/01/01', '10:10'); await fullReturn('full return of the 1499/12/29 sale A', y5a, a.price, 'ok', 'بند ۱۴')
{
  const y99 = await rep('year 1499', '1499/01/01', '1499/12/29')
  const d00 = await rep('day 1500/01/01', '1500/01/01', '1500/01/01')
  agree('1499/12/25 … 1500/01/01 = year 1499 + 1 Farvardin 1500', await rep('1499/12/25 … 1500/01/01', '1499/12/25', '1500/01/01'), sumOf(y99, d00))
  const m99 = await mg('year 1499', '1499/01/01', '1499/12/29'), m00 = await mg('day 1500/01/01', '1500/01/01', '1500/01/01')
  agree('management: 1499/12/25 … 1500/01/01 = year 1499 + 1 Farvardin 1500', await mg('1499/12/25 … 1500/01/01', '1499/12/25', '1500/01/01'), sumOf(m99, m00))
  sameCount('year 1499', y99, m99)
  unlock(PANEL_KEYS.managementReports)
  await call('management trend by month 1499/11 … 1500/01', 'ok', IPC.mgmtTrend, { fromJalali: '1499/11/01', toJalali: '1500/01/01', grain: 'month' }, 'گزارش', (d) => (d.points ?? []).map((p) => [p.label, n(p.invoiceCount), p.lastYearLabel ?? null]))
}
{
  const b1 = await call('backup now (manager password) on 1500/01/01', 'ok', IPC.backupNow, { managerPassword: PW }, 'بکاپ')
  const list = await invoke(IPC.backupList, {})
  const auto = list.ok ? list.data.filter((x) => x.source === 'auto') : []
  obs('backup file names (digits → 0)', auto.map((x) => String(x.fileName).replace(/[0-9]/g, '0')))
  obs('backup file year', auto.map((x) => (String(x.fileName).match(/(\d{4})/) ?? [null, null])[1]))
  if (b1.ok && !auto.length) finding('UNEXPECTED_REFUSAL', `${CLOCK} بکاپ ساخته شد ولی در فهرست نیامد`, 'بکاپ')
}
go('1500/01/01', '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y5')

// =================================================================== Y6
begin('Y6', '۱۵۰۲/۱۲/۳۰ (تقویم سیستم این روز را ۱۵۰۳/۰۱/۰۱ می‌داند) و ۱۵۰۵/۰۶/۱۵ (صد سال پس از امروز)')
go('1502/12/30', '08:55'); await autoConsolidation('program opens on 1502/12/30')
go('1502/12/30', '09:00'); await openDrawer('seller opens the drawer')
go('1502/12/30', '10:00'); const y6a = await pos('POS sale A cash 700,000 on 1502/12/30', a, 'CASH')
obs('sale dated (program calendar)', y6a.ok ? y6a.data.issuedAtJalali : null)
obs('the same instant in the system calendar (ICU)', new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
await rep('day 1502/12/30', '1502/12/30', '1502/12/30')
go('1502/12/30', '21:00'); await finalClose('«بستن نهایی»')
go('1505/06/15', '08:55'); await autoConsolidation('program opens on 1505/06/15')
go('1505/06/15', '09:00'); await openDrawer('seller opens the drawer')
go('1505/06/15', '10:00'); await pos('POS sale B card 300,000', b, 'CARD')
go('1505/06/15', '10:05'); await wholesale('wholesale W dated 1505/06/15', '1505/06/15', w)
sameCount('day 1505/06/15', await rep('day 1505/06/15', '1505/06/15', '1505/06/15'), await mg('day 1505/06/15', '1505/06/15', '1505/06/15'))
go('1505/06/15', '21:00'); await finalClose('«بستن نهایی»')
ledgerCheck('Y6')
{
  const rows = seed.rows('SELECT receiptNo, issuedAtJalali FROM "SaleInvoice" ORDER BY receiptNo')
  const nos = rows.map((r) => n(r.receiptNo))
  const gaps = nos.filter((x, i) => i > 0 && x !== nos[i - 1] + 1)
  obs('invoice numbers 1405 … 1505', { count: nos.length, first: nos[0], last: nos.at(-1), gaps: gaps.length })
  if (gaps.length || nos[0] !== 1) finding('RECEIPT_GAP', `شمارهٔ فاکتورها پیوسته نیست: ${JSON.stringify(gaps.slice(0, 5))}`, 'شماره')
  const byYear = {}
  for (const r of rows) { const y = String(r.issuedAtJalali).slice(0, 4); byYear[y] = (byYear[y] ?? 0) + 1 }
  obs('invoices per Jalali year', byYear)
}

// =================================================================== Y7
begin('Y7', 'ساعت نادرست رایانه: عقب رفتن به دیروزِ بسته و به روزی بی فروش، ریست به ۲۰۰۸ و درست شدن؛ سپس جلو رفتن اشتباهی یک‌ساله و برگشت')
/** قاعدهٔ ثبت‌شدهٔ ۴-۱۱۱ («ساعت نادرست»): اگر ساعت رایانه از زمان آخرین فاکتور عقب‌تر باشد، تجمیع خودکار نه و خط زرد. */
const guardState = () => {
  const row = seed.one('SELECT issuedAt x, issuedAtJalali j FROM "SaleInvoice" ORDER BY issuedAt DESC LIMIT 1')
  return { now: toJalaliDate(new Date()), lastInvoice: row?.j ?? null, autoConsolidationHeld: Date.now() < n(row?.x) }
}
const saleObs = (r) => (r.ok ? `ثبت شد با تاریخ ${r.data.issuedAtJalali}` : `${r.code ?? ''} ${firstLine(r.error).slice(0, 200)}`.trim())
go('1505/06/16', '08:55'); await autoConsolidation('program opens on 1505/06/16 (1505/06/15 consolidated)')
go('1505/06/16', '09:00'); await openDrawer('seller opens the drawer')
go('1505/06/16', '09:05'); await pos('POS sale A cash 700,000 (clock correct)', a, 'CASH')
go('1505/06/15', '15:00')
const back1 = await pos('the clock fell back to yesterday 15:00 (consolidated, drawer closed): POS sale E cash 300,000', e, 'CASH', 'either', '4-111')
obs('sale with the clock one day behind (yesterday is consolidated)', saleObs(back1))
if (!back1.ok) finding('CLOCK_BEHIND_REFUSAL', `${CLOCK} ساعت رایانه یک روز عقب رفت ⇒ فروش رد شد: «${firstLine(back1.error).slice(0, 110)}»`, '4-111 (ثبت‌شده: «سند همین لحظه ⇐ بی ایست» و «ساعت نادرست»)')
go('1505/06/10', '09:10')
const back6 = await pos('the clock fell back 6 days (a day without sales): POS sale E cash 300,000', e, 'CASH', 'either', '4-111')
obs('sale with the clock 6 days behind', saleObs(back6))
obs('4-111 clock guard with the clock 6 days behind', guardState())
goGregorian('2008-01-01T06:00:00Z', '2008-01-01 09:30 (CMOS reset)')
const cmos = await pos('the clock reset to 2008 (CMOS battery): POS sale E cash 300,000', e, 'CASH', 'either', '4-111')
obs('sale with the clock reset to 2008', saleObs(cmos))
obs('4-111 clock guard with the clock in 2008', guardState())
go('1505/06/16', '09:30')
await pos('the clock is set right again: POS sale B card 300,000', b, 'CARD', 'ok', 'ساعت')
obs('4-111 clock guard after setting the clock right', guardState())
go('1506/06/16', '09:40')
const fwd = await pos('the clock was set one year ahead by mistake: POS sale E cash 300,000', e, 'CASH', 'either', 'ساعت')
obs('sale with the clock one year ahead', saleObs(fwd))
if (!fwd.ok && fwd.code === 'CUSTODY_AUTH_REQUIRED') {
  await morningAfterForgotten('the program thinks a year has passed')
  await openDrawer('the seller takes over the drawer (clock still wrong)', 'تحویل صندوق')
  const fwd2 = await pos('POS sale E cash 300,000 with the wrong clock', e, 'CASH', 'ok', 'ساعت')
  obs('sale with the wrong clock after the takeover', saleObs(fwd2))
}
go('1505/06/16', '09:50')
let fixed = await pos('the clock is corrected back to today: POS sale B card 300,000', b, 'CARD', 'either', 'ساعت')
obs('sale right after correcting the clock', saleObs(fixed))
if (!fixed.ok && fixed.code === 'CUSTODY_AUTH_REQUIRED') {
  const st = await call('custody status after the correction', 'ok', IPC.custodyStatus, {}, 'تحویل صندوق', (d) => ({ state: d.state, unresolved: n(d.unresolvedCount) }))
  if (st.ok && n(st.data.unresolvedCount)) await morningAfterForgotten('after the correction')
  await call(`the seller takes over the drawer again (PIN + count ${drawer.toLocaleString('en')})`, 'either', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: drawer }, 'تحویل صندوق')
  fixed = await pos('POS sale B card 300,000 after taking over again', b, 'CARD', 'either', 'ساعت')
  obs('sale after taking over again', saleObs(fixed))
}
if (!fixed.ok) finding(fixed.code === 'CUSTODY_AUTH_REQUIRED' ? 'DRAWER_TAKEOVER_STUCK' : 'CLOCK_BEHIND_REFUSAL', `${CLOCK} پس از برگرداندن ساعت فروش رد شد: «${firstLine(fixed.error).slice(0, 110)}»`, '4-111 (ثبت‌شده) / بند ۱۴')
{
  const g = guardState()
  obs('4-111 clock guard after correcting a forward mistake', g)
  if (g.autoConsolidationHeld) finding('CLOCK_GUARD_STUCK', `پس از برگرداندن ساعت، یک فاکتور با تاریخ ${g.lastInvoice} (آینده) مانده؛ قاعدهٔ ثبت‌شدهٔ ۴-۱۱۱ («ساعت از آخرین فاکتور عقب‌تر ⇒ تجمیع خودکار نه، خط زرد») تا ${g.lastInvoice} تجمیع خودکار و خط زرد را نگه می‌دارد`, '۴-۱۳۲')
  obs('consolidated days after the year-ahead mistake', seed.rows('SELECT dayJalali d FROM "Consolidation" WHERE dayJalali >= ? OR dayJalali < ? ORDER BY dayJalali', '1505/06/10', '1400/01/01').map((r) => r.d))
}
obs('report: today 1505/06/16', await rep('today after the clock troubles', '1505/06/16', '1505/06/16'))
obs('report: the mistaken future day 1506/06/16', await rep('the mistaken future day 1506/06/16', '1506/06/16', '1506/06/16'))
obs('report: the 2008 day 1386/10/11', await rep('the 2008 day 1386/10/11', '1386/10/11', '1386/10/11'))
go('1505/06/16', '21:00'); await call(`«بستن نهایی» (count ${drawer.toLocaleString('en')})`, 'either', IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: drawer })
ledgerCheck('Y7')

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
  invoices: countOf('SaleInvoice'),
  consolidations: countOf('Consolidation')
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, stories, ipcErrors }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))
const normStr = (t) => String(t ?? '').split('\n')[0].replace(/[۰-۹٠-٩][۰-۹٠-٩٬,\/:.]*/g, '#').replace(/[0-9][0-9,\/:.]*/g, '0').slice(0, 240)
const normDeep = (v) => {
  if (typeof v === 'string') return v.slice(0, 240)
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
const snapshotDoc = { meta: { tool: 'docs/audit/year-scenarios.mjs', programCommit: head, summary }, stories: snapshot }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify(snapshotDoc, null, 1) + '\n')

for (const s of stories) {
  console.log(`\n${s.id} — ${s.title}`)
  for (const st of s.steps) console.log(`  ${st.ok ? '✓' : '✗'} ${st.label}${st.ok ? '' : `  :: ${st.code ? '[' + st.code + '] ' : ''}${firstLine(st.msg).slice(0, 150)}`}`)
  for (const o of s.obs) console.log(`  · ${o.k}: ${JSON.stringify(o.v).slice(0, 400)}`)
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
    const len = Math.max(s.steps.length, bb.steps.length)
    for (let i = 0; i < len; i++) {
      const x = JSON.stringify(s.steps[i] ?? null), y = JSON.stringify(bb.steps[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · گام ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const olen = Math.max(s.obs.length, (bb.obs ?? []).length)
    for (let i = 0; i < olen; i++) {
      const x = JSON.stringify(s.obs[i] ?? null), y = JSON.stringify((bb.obs ?? [])[i] ?? null)
      if (x !== y) diffs.push(`${s.id} · دیدهٔ ${i + 1}\n    پیش: ${y}\n    پس:  ${x}`)
    }
    const x = JSON.stringify(s.findings), y = JSON.stringify(bb.findings)
    if (x !== y) diffs.push(`${s.id} · یافته‌ها\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- داستان نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 500)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
