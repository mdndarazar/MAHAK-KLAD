/**
 * آزمون «حجم چندساله و کار پیوسته» — آزمون ۲۰۲۶-۱۱-۲۶، نتیجهٔ رسمی ۲۰۲۶-۱۱-۲۷ (دفتر آزمون مالک: «آزمون‌های پایانی»، ۴-۱۳۵ تا ۴-۱۳۷).
 *
 * خواستهٔ مالک (پس از پاسخ ۱۶): «باید فاکتورهای زیادی ثبت کنه بدون مشکل این برای مغازه های پر فروش حیاتیه… مثل ساعت
 * یک ساعت خوب کار کنه بعدش… [نه]… حداقل روی یک سیستم باید تا 100 سال به خوبی بدون مشکل کار کنه».
 *
 * چه می‌کند (پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده، ساعت شبیه‌سازی‌شده، همان کانال‌های IPC صفحه‌ها):
 *   V0  راه‌اندازی مثل فروشگاه مالک: حضانت صندوق روشن، کالاهای فروشی با خرید آغازین (لات و فی خرید واقعی)، کالاهای بیشتر
 *       برای جست‌وجو؛ پیام ثبت خرید وقتی هنوز کسی صندوق را تحویل نگرفته.
 *   V1  روزها کار پیوسته، همه از راه برنامه و در یک اجرا (بی بستن برنامه): صبح تجمیع خودکار روزهای گذشته (شبیه‌سازی ۴-۱۱۱)
 *       و تحویل صندوق، فروش تکی نقد و کارت، نسیه، فاکتور عمده، برگشت، چک، خرید ماهانه؛ شب «بستن نهایی»؛ گزارش سود هر
 *       AUD_COST_EVERY روز (مثل مدیری که گاه‌گاه گزارش مدیریت را باز می‌کند). هر ۳۰ روز: زمان هر فروش و حافظهٔ برنامه
 *       پس از جمع‌آوری زباله (برای «یک ساعت خوب، بعد خراب»).
 *   V2  زمان کارهای روزانه و گزارش‌ها (میانهٔ سه بار)، و برای هر کار، جمله‌های SQL واقعیِ آن با EXPLAIN QUERY PLAN: آیا
 *       جدول بزرگی را سراسر می‌خواند (کند شدن با بزرگ شدن تاریخچه) یا با شاخص می‌رود.
 *   V3  درستی در حجم بالا: جمع ماه‌ها = گزارش ۳۶۵ روز؛ شمارهٔ فاکتورها پیوسته؛ کالا = دفتر کالا؛ همهٔ روزهای گذشته تجمیع‌شده.
 *   V4  سقف‌ها و برآورد: بزرگ‌ترین شناسه و مبلغ در برابر سقف‌ها؛ حجم پایگاه به ازای هر فاکتور؛ رشد سالانه با همین آهنگ
 *       فروش؛ فضای بکاپ‌ها با پیش‌فرض «هر روز، ۳۰ نسخه».
 *   V5  بکاپ هم‌زمان با نوشتن سند (همان «بکاپ الان»، ۵ بار): آیا کپی فایل پایگاه سالم درمی‌آید (PRAGMA quick_check).
 *
 * یافته‌ها:
 *   UNEXPECTED_REFUSAL     کاری که باید انجام می‌شد رد شد
 *   WORDING                متن پیام با کار نمی‌خواند (۴-۱۳۷)
 *   SLOWDOWN               زمان هر فروش با بزرگ شدن تاریخچه بیش از دو برابر شد
 *   MEMORY_GROWTH          حافظهٔ برنامه در کار پیوسته رشد پایدار دارد (نشانهٔ نشت)
 *   SLOW_OPERATION         کار روزانه (سقف ۱ ثانیه) یا گزارش (سقف ۱۵ ثانیه) کندتر است
 *   FULL_SCAN              کار روزانه جدول بزرگی را سراسر می‌خواند
 *   REPORT_SUM_MISMATCH / RECEIPT_GAP / STOCK_LEDGER_MISMATCH / NOT_CONSOLIDATED
 *   HEADROOM               سقف شناسه کمتر از صد سال جا دارد
 *   BACKUP_TORN            بکاپی که هم‌زمان با نوشتن گرفته شد خراب است (۴-۱۳۵)
 *
 * زمان‌ها روی همین موتور سبک آزمون (node:sqlite) است، نه Prisma واقعی؛ برای «رشد با حجم» معتبرند، نه زمان دقیق رایانهٔ
 * فروشگاه. زمان، حافظه و نتیجهٔ بکاپ هم‌زمان در نتیجهٔ فشرده هستند ولی در --compare سنجیده نمی‌شوند (به سرعت دیسک و
 * پردازندهٔ همان رایانه بسته‌اند). دیده‌ها و دیگر یافته‌ها با همان AUD_* همیشه یکی‌اند.
 *
 * فقط ابزار آزمون است: به برنامه، پایگاه واقعی یا آزمون‌های مخزن دست نمی‌زند.
 *
 * اجرا از ریشهٔ مخزن (پیش‌فرض کوتاه برای سنجش پیش و پس از اجرا: ۳۰ روز، روزی ۱۵۰ فاکتور، حدود ۳ دقیقه):
 *   TZ=Asia/Tehran node --expose-gc --import ./test/harness/register.mjs docs/audit/volume-scenarios.mjs
 *   ... --out <file.json> · ... --compare docs/audit/volume-scenarios-2026-11-27.json · AUD_VERBOSE=1
 * دو اجرای بزرگ آزمون (هر کدام حدود یک ساعت؛ نتیجه‌ها volume-scenarios-3y-…json و volume-scenarios-busy-…json):
 *   AUD_START=1402/08/15 AUD_DAYS=1095 AUD_PER_DAY=150 AUD_VARIANTS=3000 AUD_EXTRA_SKUS=20000 AUD_COST_EVERY=30   (۳ سال)
 *   AUD_START=1404/08/15 AUD_DAYS=365  AUD_PER_DAY=300 AUD_VARIANTS=3000 AUD_EXTRA_SKUS=20000 AUD_COST_EVERY=30   (پرفروش)
 *   (برای اجرای بزرگ: node --max-old-space-size=3072)
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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

if (process.env.TZ !== 'Asia/Tehran') { console.error('TZ=Asia/Tehran لازم است (مثل رایانهٔ فروشگاه).'); process.exit(2) }
const REPO = process.env.AUD_REPO ?? fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
const VERBOSE = process.env.AUD_VERBOSE === '1'
const DAYS = Number(process.env.AUD_DAYS ?? 30)
const PER_DAY = Number(process.env.AUD_PER_DAY ?? 150)
const VARIANTS = Number(process.env.AUD_VARIANTS ?? 600)
const EXTRA_SKUS = Number(process.env.AUD_EXTRA_SKUS ?? 2000)
const COST_EVERY = Number(process.env.AUD_COST_EVERY ?? 7)
const START = process.env.AUD_START ?? '1405/07/01'
const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null

register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)
const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
const dir = mock.state.userData
mkdirSync(join(dir, 'data'), { recursive: true })
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'data', 'shop.db')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 777128, isDestroyed: () => false, once: () => {} }
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
const { jalaliAddDays, jalaliStartOfDay } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const { cashboxService } = await imp('/src/main/services/CashboxService.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')

const db = harnessClient()
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

// ---------------------------------------------------------------- ضبط جمله‌های SQL برای EXPLAIN QUERY PLAN
const realPrepare = sql.prepare.bind(sql)
let capture = null
sql.prepare = (text, ...rest) => {
  const stmt = realPrepare(text, ...rest)
  if (!capture) return stmt
  const wrap = (fn) => (...p) => { if (capture && capture.length < 4000) capture.push({ text, params: p }); return fn.apply(stmt, p) }
  return new Proxy(stmt, { get(t, prop) { const v = Reflect.get(t, prop); if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'iterate') return wrap(v); return typeof v === 'function' ? v.bind(t) : v } })
}
const BIG = ['SaleInvoice', 'SaleInvoiceItem', 'Payment', 'StockMovement', 'AuditLog', 'SaleReturn', 'SaleReturnItem', 'CashMovement', 'CostConsumption', 'PurchaseLot', 'SaleItemCost', 'ProductVariant', 'Product']
function plansOf(captured) {
  const scans = new Map()
  const seen = new Set()
  for (const c of captured) {
    const key = c.text
    if (seen.has(key)) continue
    seen.add(key)
    if (!/^\s*(SELECT|UPDATE|DELETE|WITH)/i.test(c.text)) continue
    let rows = []
    try { rows = realPrepare('EXPLAIN QUERY PLAN ' + c.text).all(...c.params.map((p) => (p instanceof RealDate ? p.getTime() : typeof p === 'boolean' ? (p ? 1 : 0) : p))) } catch { continue }
    for (const r of rows) {
      const d = String(r.detail)
      const m = d.match(/^SCAN (?:TABLE )?"?([A-Za-z_]+)"?(.*)$/)
      if (!m) continue
      const table = m[1]
      if (!BIG.includes(table)) continue
      const viaIndex = /USING (COVERING )?INDEX/.test(m[2])
      const k = `${table}${viaIndex ? ' (index scan)' : ''}`
      if (!scans.has(k)) scans.set(k, c.text.replace(/\s+/g, ' ').slice(0, 220))
    }
  }
  return [...scans.entries()].map(([k, q]) => ({ scan: k, sql: q }))
}
/** کار روزانه نباید جدول بزرگی را سراسر بخواند؛ جست‌وجوی نام کالا ذاتاً سراسری است و «آخرین شماره» با شاخص و LIMIT یک ردیف است. */
const dailyScanFindings = (label, scans) => {
  for (const s of scans) {
    if (/^(Product|ProductVariant)\b/.test(s.scan)) continue
    if (/index scan/.test(s.scan) && /ORDER BY/i.test(s.sql) && /LIMIT/i.test(s.sql)) continue
    finding('FULL_SCAN', `${label}: ${s.scan} — ${s.sql}`, 'حجم')
  }
}

// ---------------------------------------------------------------- نتیجه‌ها
const stories = []
const allFindings = []
let story = null
let keySeq = 0
let CLOCK = ''
const firstLine = (t) => String(t ?? '').split('\n')[0]
const countOf = (t, where = '1=1', ...p) => n(seed.one(`SELECT COUNT(*) c FROM "${t}" WHERE ${where}`, ...p).c)
function begin(id, title) { story = { id, title, steps: [], findings: [], findingKeys: new Set(), obs: [], timings: [] }; stories.push(story); console.log(`\n=== ${id} ${title}`) }
function finding(type, label, plan, detail) {
  const key = `${type}|${label}`
  if (story.findingKeys.has(key)) return
  story.findingKeys.add(key)
  const f = { story: story.id, type, label, plan: plan ?? '', detail }
  story.findings.push(f)
  allFindings.push(f)
  console.log(`    ⚠ ${type} [${plan ?? ''}] ${label}`)
}
function obs(key, value) { story.obs.push({ k: key, v: value }); console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 400)}`) }
function timing(key, value) { story.timings.push({ k: key, v: value }); console.log(`    ⏱ ${key}: ${JSON.stringify(value).slice(0, 400)}`) }
const stepCounts = new Map()
function record(label, expect, r, plan) {
  if (!r.ok) {
    if (expect === 'ok') finding('UNEXPECTED_REFUSAL', `${CLOCK} ${label}`, plan, firstLine(r.error))
    if (VERBOSE || expect === 'ok') console.log(`   ✗ ${CLOCK} ${label} ${r.code ? '[' + r.code + '] ' : ''}${firstLine(r.error).slice(0, 170)}`)
  }
  const k = `${label.replace(/[0-9][0-9,]*/g, '#')}|${r.ok ? 'OK' : 'REFUSED'}`
  stepCounts.set(k, (stepCounts.get(k) ?? 0) + 1)
  return r
}
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  return fn({ sender }, payload)
}
async function call(label, expect, channel, payload, plan) {
  let r
  try { r = await invoke(channel, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  return record(label, expect, r, plan)
}
async function svc(label, expect, fn, plan) {
  let r
  try { r = { ok: true, data: await fn() } } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: e?.code ?? null } }
  return record(label, expect, r, plan)
}
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }
const wall = (jday, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return jalaliStartOfDay(jday).getTime() + h * 3600000 + m * 60000 }
const go = (jday, hhmm) => { setNow(wall(jday, hhmm)); CLOCK = `${jday} ${hhmm}` }
const goMs = (jday, ms) => { setNow(jalaliStartOfDay(jday).getTime() + ms); CLOCK = jday }

/** mulberry32 — همیشه همان داده */
let rs = 0x5eed1405
const rnd = () => { rs |= 0; rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const ms = (x) => Math.round(x * 10) / 10

// =================================================================== V0
begin('V0', `راه‌اندازی: حضانت صندوق، ${VARIANTS.toLocaleString('en')} کالای فروشی با خرید آغازین و ${EXTRA_SKUS.toLocaleString('en')} کالای دیگر برای جست‌وجو`)
go(START, '07:00')
const owner = seed.user('مالک فروشگاه')
const seller = seed.user('فروشنده')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { if (ipcErrors.length < 200) ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { if (ipcErrors.length < 200) ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const OWNER_PIN = 'Owner-Pin-7391!', SELLER_TMP = 'Seller-Tmp-48!', SELLER_PIN = 'Seller-Pin-5527!'
await svc('owner sets personal custody PIN', 'ok', () => custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW }))
await svc('enable custody (single shift)', 'ok', () => custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN }))
await svc('owner issues a temporary PIN for the seller', 'ok', () => custodyService.setPin({ userId: seller, newPassword: SELLER_TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'آزمون حجم' }))
await svc('seller sets personal PIN', 'ok', () => custodyService.setPin({ userId: seller, currentPassword: SELLER_TMP, newPassword: SELLER_PIN }))

const cats = Array.from({ length: 12 }, (_, i) => seed.category(`گروه ${i + 1}`))
const V = []
const t0 = performance.now()
sql.exec('BEGIN')
for (let i = 0; i < VARIANTS + EXTRA_SKUS; i++) {
  const pid = seed.product(`کالای ${i + 1}`, cats[i % cats.length])
  const id = seed.variant(pid, `${i + 1}`)
  const price = 100_000 * (1 + Math.floor(rnd() * 40))
  sql.prepare('UPDATE "ProductVariant" SET stock=0, salePrice=?, code=?, barcode=? WHERE id=?').run(price, `VOL-${i + 1}`, `62${String(1000000000 + i)}`, id)
  if (i < VARIANTS) V.push({ id, price, barcode: `62${String(1000000000 + i)}` })
}
sql.exec('COMMIT')
timing('catalog insert (SQL)', { variants: VARIANTS + EXTRA_SKUS, ms: ms(performance.now() - t0) })
/** خرید آغازین (لات و فی خرید واقعی)؛ با حضانت روشن، خرید هم مثل فروش پس از تحویل صندوق ثبت می‌شود. */
async function openingPurchases() {
  unlock(PANEL_KEYS.purchase)
  const t1 = performance.now()
  for (let i = 0; i < V.length; i += 200) {
    const lines = V.slice(i, i + 200).map((v) => ({ variantId: v.id, qty: 2000, unitPrice: Math.round(v.price * 0.6) }))
    const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)
    await call('opening purchase (200 lines × 2,000)', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی آغازین', settlementType: 'CASH', paidTotal: total, lines })
  }
  timing('opening purchases', { purchases: Math.ceil(V.length / 200), ms: ms(performance.now() - t1) })
}
{
  // پیام خرید وقتی صندوق تحویل گرفته نشده (پیش از راه‌اندازی صندوق روز اول)
  unlock(PANEL_KEYS.purchase)
  const r = await call('purchase before anyone has taken over the drawer', 'either', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی آغازین', settlementType: 'ACCOUNT', paidTotal: 0, lines: [{ variantId: V[0].id, qty: 1, unitPrice: 60_000 }] })
  obs('purchase with no drawer taken over', r.ok ? 'ثبت شد' : `${r.code ?? ''} ${firstLine(r.error).slice(0, 200)}`.trim())
  if (!r.ok && /ثبت فروش/.test(String(r.error))) finding('WORDING', `ثبت خرید با صندوقِ تحویل‌نشده پیام «${firstLine(r.error).slice(0, 60)}…» می‌دهد (سخن از «فروش» است، نه خرید)`, '۴-۱۳۷')
}

// ---------------------------------------------------------------- کارهای روزانه
let drawer = 0
const openDrawer = (label) => call(`${label}`, 'ok', IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: drawer })
const finalClose = (label) => call(`${label}`, 'ok', IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: drawer })
const phones = Array.from({ length: 3000 }, (_, i) => `0912${String(1000000 + i * 37).slice(-7)}`)
const daySales = []
async function oneSale(jday) {
  const lines = []
  const k = 1 + Math.floor(rnd() * 4)
  for (let j = 0; j < k; j++) { const v = pick(V); if (!lines.some((l) => l.variantId === v.id)) lines.push({ variantId: v.id, qty: 1 + Math.floor(rnd() * 2), unitPrice: v.price, discount: 0, tax: 0 }) }
  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)
  const u = rnd()
  if (u < 0.05) {
    unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
    const r = await call('wholesale invoice (cash)', 'ok', IPC.saleCreate, { orderType: 'WHOLESALE', issuedAtJalali: jday, lines, payments: [{ methodId: cashM, amount: total, destination: 'CASH' }], saleRequestIdempotencyKey: `vol-sale-${++keySeq}` })
    if (r.ok) drawer += total
    return r
  }
  if (u < 0.10) {
    const ph = pick(phones)
    const r = await call('POS sale نسیه', 'ok', IPC.saleCreate, { lines, payments: [], debtor: { firstName: 'مشتری', lastName: ph.slice(-4), phone: ph, nationalId: null }, saleRequestIdempotencyKey: `vol-sale-${++keySeq}` })
    if (r.ok) daySales.push({ id: n(r.data.id), total, kind: 'NESIEH' })
    return r
  }
  const card = u < 0.40
  const r = await call(`POS sale ${card ? 'card' : 'cash'}`, 'ok', IPC.saleCreate, { lines, payments: [{ methodId: card ? cardM : cashM, amount: total, destination: card ? 'CARD' : 'CASH' }], saleRequestIdempotencyKey: `vol-sale-${++keySeq}` })
  if (r.ok) { drawer += total; daySales.push({ id: n(r.data.id), total, kind: card ? 'CARD' : 'CASH' }) }
  return r
}
/** تجمیع خودکار ۴-۱۱۱ (شبیه‌سازی): همهٔ روزهای پیش از امروز که فاکتور تجمیع‌نشده دارند.
 *  «+voidedAt» تا پرس‌وجو با شاخص consolidationId برود، نه با خواندن همهٔ تاریخچه (نکتهٔ اجرای ۴-۱۱۱). */
const pendingDaysBefore = (today) => seed.rows(`SELECT DISTINCT issuedAtJalali d FROM "SaleInvoice" WHERE consolidationId IS NULL AND +voidedAt IS NULL AND issuedAtJalali < ? ORDER BY 1`, today).map((r) => r.d)

// =================================================================== V1
begin('V1', `${DAYS.toLocaleString('en')} روز کار پیوسته از ${START} (روزی ${PER_DAY} فاکتور)، بی بستن برنامه`)
const windows = []
let win = { from: null, sales: 0, saleMs: 0, consolidationMs: 0, closeMs: 0, costMs: 0 }
let day = START
const tGen = performance.now()
for (let d = 0; d < DAYS; d++) {
  if (!win.from) win.from = day
  go(day, '08:50')
  {
    const t = performance.now()
    const days = pendingDaysBefore(day)
    if (days.length) await svc('automatic consolidation of earlier days (4-111 simulation)', 'ok', () => cashboxService.finalizeDays({ days, userId: null }), '4-111')
    win.consolidationMs += performance.now() - t
  }
  go(day, '08:55'); await openDrawer('seller opens the drawer')
  if (d === 0) { go(day, '08:57'); await openingPurchases() }
  daySales.length = 0
  const span = 12 * 3600000
  for (let i = 0; i < PER_DAY; i++) {
    goMs(day, 9 * 3600000 + Math.floor((span * (i + 0.5)) / PER_DAY))
    const t = performance.now()
    await oneSale(day)
    win.saleMs += performance.now() - t
    win.sales++
    if (rnd() < 0.01 && daySales.length > 3) {
      const s = daySales[Math.floor(rnd() * (daySales.length - 1))]
      if (s.kind !== 'NESIEH' && !s.returned) {
        unlock(PANEL_KEYS.salesReturn)
        const r = await call('full return of an earlier sale today (cash refund)', 'ok', IPC.saleReturn, { invoiceId: s.id, full: true, refundDecision: 'METHOD', refundMethod: 'CASH' })
        if (r.ok) { drawer -= s.total; s.returned = true }
      }
    }
  }
  if (d % 10 === 5) {
    const q = daySales.find((s) => s.kind === 'NESIEH')
    if (q) await call('cheque for a نسیه sale (due +30 days)', 'ok', IPC.salePaymentAdd, { invoiceId: q.id, kind: 'CHEQUE', amount: q.total, chequeNo: `VOL-${d}`, bankName: 'ملت', dueDateJalali: jalaliAddDays(day, 30) })
  }
  if (day.endsWith('/01')) {
    go(day, '21:10'); unlock(PANEL_KEYS.purchase)
    const lines = Array.from({ length: 30 }, () => pick(V)).filter((v, i, a) => a.indexOf(v) === i).map((v) => ({ variantId: v.id, qty: 100, unitPrice: Math.round(v.price * 0.62) }))
    await call('monthly restock purchase (30 lines × 100)', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی ماهانه', settlementType: 'CASH', paidTotal: lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), lines })
  }
  go(day, '21:30')
  { const t = performance.now(); await finalClose('«بستن نهایی»'); win.closeMs += performance.now() - t }
  if (COST_EVERY > 0 && d % COST_EVERY === COST_EVERY - 1) {
    go(day, '21:40'); unlock(PANEL_KEYS.managementReports, PANEL_KEYS.managementProfit)
    const t = performance.now()
    await call('periodic management profit report (runs the cost ledger)', 'ok', IPC.mgmtProfit, { fromJalali: jalaliAddDays(day, -6), toJalali: day })
    win.costMs += performance.now() - t
  }
  if ((d + 1) % 30 === 0 || d === DAYS - 1) {
    if (gc) { gc(); gc() }
    const mu = process.memoryUsage()
    windows.push({ from: win.from, to: day, sales: win.sales, msPerSale: ms(win.saleMs / Math.max(1, win.sales)), consolidationMsPerDay: ms(win.consolidationMs / 30), closeMsPerDay: ms(win.closeMs / 30),
      costMsPerRun: COST_EVERY ? ms(win.costMs / Math.max(1, Math.round(30 / COST_EVERY))) : null, heapMB: Math.round(mu.heapUsed / 1048576), rssMB: Math.round(mu.rss / 1048576), invoices: countOf('SaleInvoice') })
    const w = windows.at(-1)
    console.log(`  [${w.from} … ${w.to}] invoices ${w.invoices} · ${w.msPerSale} ms/sale · heap ${w.heapMB} MB · rss ${w.rssMB} MB · consolidation ${w.consolidationMsPerDay} ms/day · close ${w.closeMsPerDay} ms/day${COST_EVERY ? ` · profit ${w.costMsPerRun} ms/run` : ''}`)
    win = { from: null, sales: 0, saleMs: 0, consolidationMs: 0, closeMs: 0, costMs: 0 }
  }
  day = jalaliAddDays(day, 1)
}
const TODAY = day
timing('generation', { days: DAYS, invoices: countOf('SaleInvoice'), minutes: ms((performance.now() - tGen) / 60000) })
timing('30-day windows', windows)
{
  const first = windows.find((w, i) => i >= 1) ?? windows[0], last = windows.at(-1)
  timing('first and last window (ms per sale, heap MB)', { first: first ? [first.msPerSale, first.heapMB] : null, last: last ? [last.msPerSale, last.heapMB] : null })
  if (first && last && windows.length > 3 && last.msPerSale > 2 * first.msPerSale + 2) finding('SLOWDOWN', `زمان هر فروش از ${first.msPerSale} به ${last.msPerSale} میلی‌ثانیه رسید`, 'حجم')
  const heaps = windows.slice(2).map((w) => w.heapMB)
  if (heaps.length > 4) {
    const a = median(heaps.slice(0, Math.ceil(heaps.length / 3))), b = median(heaps.slice(-Math.ceil(heaps.length / 3)))
    timing('heap after GC: median of the first third vs the last third (MB)', [a, b])
    if (b > a * 1.5 + 30) finding('MEMORY_GROWTH', `حافظهٔ برنامه پس از جمع‌آوری زباله از ${a} به ${b} مگابایت رسید`, 'کار پیوسته')
  }
}
obs('step results during the days (label → count)', Object.fromEntries([...stepCounts.entries()].sort()))

// =================================================================== V2
begin('V2', `پس از ${DAYS.toLocaleString('en')} روز: زمان کارهای روزانه و گزارش‌ها، و خواندن سراسری جدول‌های بزرگ`)
const ops = []
/** یک بار، با ضبط SQL (برای کارهایی که تکرارشدنی نیستند). */
async function once(label, kind, fn) {
  capture = []
  const t = performance.now()
  let r
  try { r = await fn() } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
  const took = ms(performance.now() - t)
  const scans = plansOf(capture); capture = null
  const ok = !(r && r.ok === false)
  ops.push({ label, kind, ok, medianMs: took, scans: scans.map((x) => x.scan) })
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${took} ms${scans.length ? ' · SCAN ' + scans.map((x) => x.scan).join(', ') : ''}`)
  if (!ok) finding('UNEXPECTED_REFUSAL', `${label}: ${firstLine(r.error).slice(0, 200)}`, 'حجم')
  if (kind === 'daily') dailyScanFindings(label, scans)
  return r
}
go(TODAY, '08:50')
{
  const days = pendingDaysBefore(TODAY)
  if (days.length) await once('automatic consolidation of yesterday (4-111 simulation)', 'daily', async () => ({ ok: true, data: await cashboxService.finalizeDays({ days, userId: null }) }))
}
go(TODAY, '08:55'); await once('seller opens the drawer', 'daily', () => invoke(IPC.custodyOpen, { userId: seller, password: SELLER_PIN, operationalTotal: drawer }))
const [ty, tm] = TODAY.split('/')
const monthStart = `${ty}/${tm}/01`
const yearAgo = jalaliAddDays(TODAY, -365)
/**
 * kind: daily = کار هر روز فروشنده یا مدیر (سقف ۱ ثانیه، و نباید جدول بزرگ را سراسر بخواند)
 *       report = گزارش بازه‌ای (سقف ۱۵ ثانیه؛ خواندن سراسری بازه طبیعی است)
 */
async function measure(label, kind, fn, runs = 3) {
  const times = []
  let ok = true, err = null, scans = []
  for (let i = 0; i < runs; i++) {
    capture = i === 0 ? [] : null
    const t = performance.now()
    let r
    try { r = await fn(i) } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
    times.push(performance.now() - t)
    if (i === 0) { scans = plansOf(capture); capture = null }
    if (r && r.ok === false) { ok = false; err = firstLine(r.error).slice(0, 200) }
  }
  const med = ms(median(times))
  ops.push({ label, kind, ok, medianMs: med, scans: scans.map((s) => s.scan) })
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${med} ms${scans.length ? ' · SCAN ' + scans.map((s) => s.scan).join(', ') : ''}${err ? ' :: ' + err : ''}`)
  if (!ok) finding('UNEXPECTED_REFUSAL', `${label}: ${err}`, 'حجم')
  const limit = kind === 'daily' ? 1000 : 15000
  if (med > limit) finding('SLOW_OPERATION', `${label}: ${med} میلی‌ثانیه (سقف ${limit})`, 'حجم')
  if (kind === 'daily') dailyScanFindings(label, scans)
  return { med, scans }
}
const someV = () => pick(V)
await measure('POS sale (cash, 2 lines)', 'daily', async () => {
  const a = someV(), b = someV()
  const lines = [{ variantId: a.id, qty: 1, unitPrice: a.price, discount: 0, tax: 0 }, ...(b.id !== a.id ? [{ variantId: b.id, qty: 1, unitPrice: b.price, discount: 0, tax: 0 }] : [])]
  const total = lines.reduce((s, l) => s + l.unitPrice, 0)
  const r = await invoke(IPC.saleCreate, { lines, payments: [{ methodId: cashM, amount: total, destination: 'CASH' }], saleRequestIdempotencyKey: `vol-sale-${++keySeq}` })
  if (r.ok) drawer += total
  return r
})
await measure('barcode scan (variant by barcode)', 'daily', () => invoke(IPC.variantByBarcode, { barcode: someV().barcode }))
await measure('product search by name (30 results)', 'daily', () => invoke(IPC.variantSearch, { search: 'کالای ۱۲۳' }))
unlock(PANEL_KEYS.products)
await measure('product list (first page)', 'daily', () => invoke(IPC.productList, { take: 50 }))
unlock(PANEL_KEYS.salesReports, PANEL_KEYS.salesCredit)
await measure('sales report: today (summary)', 'daily', () => invoke(IPC.saleReportSummary, { fromJalali: TODAY, toJalali: TODAY }))
await measure('sales report: today (rows)', 'daily', () => invoke(IPC.saleReportRows, { fromJalali: TODAY, toJalali: TODAY }))
await measure('sales report: yesterday (summary)', 'daily', () => invoke(IPC.saleReportSummary, { fromJalali: jalaliAddDays(TODAY, -1), toJalali: jalaliAddDays(TODAY, -1) }))
await measure('sales report: this month (summary)', 'report', () => invoke(IPC.saleReportSummary, { fromJalali: monthStart, toJalali: TODAY }))
await measure('sales report: last 365 days (summary)', 'report', () => invoke(IPC.saleReportSummary, { fromJalali: yearAgo, toJalali: TODAY }), 1)
await measure('sales report: whole history (summary)', 'report', () => invoke(IPC.saleReportSummary, { fromJalali: START, toJalali: TODAY }), 1)
await measure('نسیه list (debtors)', 'daily', () => invoke(IPC.saleCreditList, {}))
await measure('cheque list (due this year)', 'report', () => invoke(IPC.saleChequeList, { fromJalali: yearAgo, toJalali: TODAY }))
await measure('receipt-number gaps report', 'report', () => invoke(IPC.saleReceiptGaps, {}), 1)
unlock(PANEL_KEYS.managementReports, PANEL_KEYS.managementProfit)
await measure('management report: today', 'daily', () => invoke(IPC.mgmtSnapshot, { fromJalali: TODAY, toJalali: TODAY }))
await measure('management report: last 30 days', 'report', () => invoke(IPC.mgmtSnapshot, { fromJalali: jalaliAddDays(TODAY, -30), toJalali: TODAY }))
await measure('management report: last 365 days', 'report', () => invoke(IPC.mgmtSnapshot, { fromJalali: yearAgo, toJalali: TODAY }), 1)
await measure('management trend: 12 months by month', 'report', () => invoke(IPC.mgmtTrend, { fromJalali: jalaliAddDays(TODAY, -364), toJalali: TODAY, grain: 'month' }), 1)
await measure('management profit: last 30 days', 'report', () => invoke(IPC.mgmtProfit, { fromJalali: jalaliAddDays(TODAY, -30), toJalali: TODAY }))
await measure('management stock (slow movers)', 'report', () => invoke(IPC.mgmtStock, {}), 1)
unlock(PANEL_KEYS.consolidation)
await measure('consolidation page: this month', 'daily', () => invoke(IPC.consolidationDays, { fromJalali: monthStart, toJalali: TODAY }))
await measure('custody status', 'daily', () => invoke(IPC.custodyStatus, {}))
await measure('database statistics (settings → maintenance)', 'report', () => invoke(IPC.dbStats, {}), 1)
await measure('archive preview: older than 730 days', 'report', () => invoke(IPC.maintenancePreview, { beforeJalali: jalaliAddDays(TODAY, -730) }), 1)
{
  const t = performance.now()
  const b = await call('backup now (manager password)', 'ok', IPC.backupNow, { managerPassword: PW }, 'بکاپ')
  const list = await invoke(IPC.backupList, {})
  const size = list.ok ? Math.max(0, ...list.data.filter((x) => x.source === 'auto').map((x) => n(x.size))) : 0
  ops.push({ label: 'backup now', kind: 'report', ok: b.ok, medianMs: ms(performance.now() - t), scans: [] })
  timing('backup', { ms: ms(performance.now() - t), sizeMB: Math.round(size / 1048576) })
}
go(TODAY, '21:30')
await once('«بستن نهایی» (today)', 'daily', () => invoke(IPC.custodyFinalClose, { password: SELLER_PIN, operationalTotal: drawer }))
timing('operations (median ms)', ops.map((o) => [o.label, o.medianMs]))
obs('operations: kind, ok and full scans of big tables', ops.map((o) => [o.label, o.kind, o.ok ? 'OK' : 'REFUSED', o.scans]))

// =================================================================== V3
begin('V3', 'درستی در حجم بالا: جمع ماه‌ها = ۳۶۵ روز، شماره‌ها پیوسته، کالا = دفتر کالا، روزهای گذشته تجمیع‌شده')
{
  unlock(PANEL_KEYS.salesReports)
  const y = await invoke(IPC.saleReportSummary, { fromJalali: yearAgo, toJalali: jalaliAddDays(TODAY, -1) })
  let cur = yearAgo, sumCount = 0, sumGrand = 0, months = 0
  while (cur <= jalaliAddDays(TODAY, -1)) {
    const [yy, mm] = cur.split('/')
    let end = jalaliAddDays(`${mm === '12' ? Number(yy) + 1 : yy}/${mm === '12' ? '01' : String(Number(mm) + 1).padStart(2, '0')}/01`, -1)
    if (end > jalaliAddDays(TODAY, -1)) end = jalaliAddDays(TODAY, -1)
    const r = await invoke(IPC.saleReportSummary, { fromJalali: cur, toJalali: end })
    if (r.ok) { sumCount += n(r.data.count); sumGrand += n(r.data.grandTotal) }
    months++
    cur = jalaliAddDays(end, 1)
  }
  obs('last 365 days vs the sum of its months', { months, year: y.ok ? [n(y.data.count), n(y.data.grandTotal)] : null, sumOfMonths: [sumCount, sumGrand] })
  if (y.ok && (n(y.data.count) !== sumCount || n(y.data.grandTotal) !== sumGrand)) finding('REPORT_SUM_MISMATCH', 'گزارش ۳۶۵ روز ≠ جمع ماه‌ها', 'گزارش')
}
{
  const r = seed.one('SELECT COUNT(*) c, MIN(receiptNo) a, MAX(receiptNo) b FROM "SaleInvoice"')
  obs('receipt numbers', { count: n(r.c), first: n(r.a), last: n(r.b) })
  if (n(r.c) !== n(r.b) - n(r.a) + 1) finding('RECEIPT_GAP', `شمارهٔ فاکتورها پیوسته نیست: ${n(r.c)} فاکتور، ${n(r.a)} تا ${n(r.b)}`, 'شماره')
  const bad = seed.one('SELECT COUNT(*) c FROM "ProductVariant" v WHERE v.stock <> (SELECT COALESCE(SUM(delta),0) FROM "StockMovement" m WHERE m.variantId=v.id)')
  obs('variants whose stock ≠ the stock ledger', n(bad.c))
  if (n(bad.c)) finding('STOCK_LEDGER_MISMATCH', `${n(bad.c)} کالا موجودی ≠ دفتر کالا`, 'انبار')
  const pend = seed.one(`SELECT COUNT(*) c FROM "SaleInvoice" WHERE consolidationId IS NULL AND voidedAt IS NULL AND issuedAtJalali < ?`, TODAY)
  obs('unconsolidated invoices of past days', n(pend.c))
  if (n(pend.c)) finding('NOT_CONSOLIDATED', `${n(pend.c)} فاکتور روزهای گذشته تجمیع نشده`, '4-111')
  obs('consolidations', countOf('Consolidation'))
}

// =================================================================== V4
begin('V4', 'سقف‌ها و برآورد با همین آهنگ فروش')
{
  const dbFile = process.env.HARNESS_DB
  sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const pageBytes = n(seed.one('PRAGMA page_count').page_count) * n(seed.one('PRAGMA page_size').page_size)
  const fileBytes = statSync(dbFile).size
  const inv = countOf('SaleInvoice')
  const tables = ['SaleInvoice', 'SaleInvoiceItem', 'Payment', 'StockMovement', 'AuditLog', 'SaleReturn', 'CashMovement', 'Consolidation', 'Shift', 'CashSession', 'ProductVariant']
  const rows = Object.fromEntries(tables.map((t) => { try { return [t, countOf(t)] } catch { return [t, null] } }))
  obs('rows per table', rows)
  const bytesPerInvoice = Math.round(fileBytes / Math.max(1, inv))
  const perYear = PER_DAY * 365
  const gbPerYear = (bytesPerInvoice * perYear) / 1073741824
  timing('database size', { fileMB: Math.round(fileBytes / 1048576), pagesMB: Math.round(pageBytes / 1048576), invoices: inv, bytesPerInvoice })
  timing('projection at this rate (no archive cleanup)', { perYearInvoices: perYear, gbPerYear: ms(gbPerYear), gb10y: ms(gbPerYear * 10), gb100y: ms(gbPerYear * 100), backups30xAt10yGB: ms(gbPerYear * 10 * 30) })
  const maxIds = {}
  for (const t of ['SaleInvoice', 'SaleInvoiceItem', 'Payment', 'StockMovement', 'AuditLog', 'CashMovement']) {
    try { maxIds[t] = n(seed.one(`SELECT MAX(id) m FROM "${t}"`).m) } catch { maxIds[t] = null }
  }
  const INT32 = 2147483647
  const headroom = Object.fromEntries(Object.entries(maxIds).map(([t, m]) => [t, m ? Math.floor((INT32 / Math.max(1, m)) * (DAYS / 365)) : null]))
  obs('years until the 32-bit id limit at this rate (per table)', headroom)
  for (const [t, y] of Object.entries(headroom)) if (y != null && y < 100) finding('HEADROOM', `${t}: شناسهٔ ۳۲ بیتی با همین آهنگ ${y} سال جا دارد`, 'سقف')
  const yearTotal = n(seed.one(`SELECT COALESCE(SUM(grandTotal),0) s FROM "SaleInvoice" WHERE issuedAtJalali >= ?`, yearAgo).s)
  const maxInv = n(seed.one('SELECT MAX(grandTotal) m FROM "SaleInvoice"').m)
  obs('money: biggest invoice and the last 365 days total vs the exact-number limit (9,007,199,254,740,991 rial)', { maxInvoice: maxInv, yearTotal, timesUnderLimitForAYear: Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, yearTotal)) })
}

// =================================================================== V5
begin('V5', 'بکاپ هم‌زمان با نوشتن سند: کپی فایل پایگاه وسط ثبت، سالم درمی‌آید؟ (۵ بار، با همان «بکاپ الان»)')
{
  const { DatabaseSync } = await import('node:sqlite')
  const bdir = join(dir, 'backups')
  const results = []
  for (let k = 0; k < 5; k++) {
    go(TODAY, `22:${String(10 + k).padStart(2, '0')}`)
    let done = false, writes = 0
    const before = new Set(existsSync(bdir) ? readdirSync(bdir) : [])
    const p = invoke(IPC.backupNow, { managerPassword: PW }).finally(() => { done = true })
    while (!done) {
      sql.exec(`UPDATE "AuditLog" SET note = COALESCE(note,'') || 'x' WHERE id % 61 = ${writes % 61}`)
      writes++
      await new Promise((r) => setImmediate(r))
    }
    const r = await p
    const fresh = (existsSync(bdir) ? readdirSync(bdir) : []).filter((f) => f.startsWith('shop-') && f.endsWith('.db') && !before.has(f))
    let check = 'no file'
    if (fresh.length) {
      try {
        const c = new DatabaseSync(join(bdir, fresh[0]), { readOnly: true })
        const rows = c.prepare('PRAGMA quick_check').all()
        c.close()
        check = rows.length === 1 && Object.values(rows[0])[0] === 'ok' ? 'ok' : `broken: ${String(Object.values(rows[0] ?? {})[0] ?? '').slice(0, 80)}`
      } catch (e) { check = `broken: ${String(e?.message ?? e).slice(0, 80)}` }
    }
    results.push({ ok: !!r.ok, writesDuringCopy: writes > 0, check })
  }
  timing('backups taken while documents were being written', results.map((x) => [x.ok ? 'OK' : 'REFUSED', x.writesDuringCopy, x.check.replace(/[0-9]+/g, '#')]))
  const broken = results.filter((x) => x.check !== 'ok').length
  if (broken) finding('BACKUP_TORN', `${broken} بکاپ از ۵ بکاپی که هم‌زمان با نوشتن سند گرفته شد سالم نیست (بکاپ خودکار پس از کپی سنجیده نمی‌شود)`, '۴-۱۳۵')
}

// =================================================================== خلاصه، نتیجهٔ فشرده و مقایسه
const byType = {}
for (const f of allFindings) byType[f.type] = (byType[f.type] ?? 0) + 1
const summary = { days: DAYS, perDay: PER_DAY, variants: VARIANTS, extraSkus: EXTRA_SKUS, costEvery: COST_EVERY, start: START, invoices: countOf('SaleInvoice'), findings: allFindings.length, findingTypes: byType, ipcErrors: ipcErrors.length }
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, stories, ipcErrors }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))
const snapshot = stories.map((s) => ({ id: s.id, title: s.title, findings: [...new Set(s.findings.map((f) => `${f.type} | ${f.label} | ${f.plan}`))].sort(), obs: s.obs, timings: s.timings }))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/volume-scenarios.mjs', programCommit: head, summary }, stories: snapshot }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify(snapshotDoc, null, 1) + '\n')
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
if (ipcErrors.length) console.log('first console errors:', ipcErrors.slice(0, 5))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)
if (COMPARE) {
  // زمان، حافظه و بکاپ هم‌زمان به سرعت دیسک و پردازندهٔ همان رایانه بسته‌اند؛ سنجیده نمی‌شوند
  const envDependent = (f) => /^(SLOW_OPERATION|SLOWDOWN|MEMORY_GROWTH|BACKUP_TORN)/.test(f)
  const base = JSON.parse(readFileSync(COMPARE, 'utf8')).stories
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const bb = byId.get(s.id)
    if (!bb) { diffs.push(`+ داستان تازه: ${s.id}`); continue }
    byId.delete(s.id)
    const olen = Math.max(s.obs.length, (bb.obs ?? []).length)
    for (let i = 0; i < olen; i++) {
      const x = JSON.stringify(s.obs[i] ?? null), y = JSON.stringify((bb.obs ?? [])[i] ?? null)
      if (x !== y && !/operations: kind/.test(x)) diffs.push(`${s.id} · دیدهٔ ${i + 1}\n    پیش: ${y.slice(0, 600)}\n    پس:  ${x.slice(0, 600)}`)
    }
    const x = JSON.stringify(s.findings.filter((f) => !envDependent(f))), y = JSON.stringify((bb.findings ?? []).filter((f) => !envDependent(f)))
    if (x !== y) diffs.push(`${s.id} · یافته‌ها\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- داستان نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 200)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
