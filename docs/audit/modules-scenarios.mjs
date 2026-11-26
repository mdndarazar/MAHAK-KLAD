/**
 * آزمون «بخش‌های باقی‌مانده» — آزمون ۲۰۲۶-۱۱-۲۶ (دفتر آزمون مالک: ۴-۹۱ بند ۷، ۴-۱۱۴ تا ۴-۱۲۴ و بند ۱۵).
 *
 * خواستهٔ مالک: «…قدم بعدی تست کردن ماژولها و یا بخشهای باقی مانده هست…»، پیشنهادها «بدونه اینکه منطق مالی بخاد
 * خراب بشه»؛ و پس از گزارش: «بله موافقم به شرطی که منطق مالی خراب نشود پس در دفتر ازمون ثبت کن».
 *
 * همه‌چیز از همان کانال‌های IPC صفحه‌ها می‌رود، با همان قفل‌ها و رمزها (باز شدن هر صفحه شبیه همان رمزی است که کاربر
 * برای ورودش می‌زند). دوازده سناریو:
 *   M0   نشست مالک و باز کردن صفحه‌ها
 *   M1   کالاها و دسته‌ها (بارکد و کد تکراری)
 *   M2   فاکتور خرید: شماره، ثبت، ویرایش، «قیمت خرید» کارت کالا، پرداخت بعدی، پرداخت بیش از جمع، ابطال، تاریخ آینده
 *   M3   انبارگردانی: شمارش، مغایرت، کسری و مازاد، یادآوری
 *   M4   انبار مرکزی: انبار، کالا، انتقال، انتقال به فروشگاه
 *   M5   تغییر قیمت گروهی: فوری، بازگردانی، کف قیمت، «قیمت خرید» بسته، حراج زمان‌بندی‌شده و سبد باز
 *   M6   عوارض و مالیات و حق سرویس: نصب تازه، فروش تکی، فاکتور عمده
 *   M7   گزارش مدیریت در برابر گزارشات فروش، و یادداشت نمودار «روند»
 *   M8   پنل پیامکی: قالب‌ها، برآورد، «لغو ۱۱»، ارسال دستی بی سرویس‌دهنده
 *   M9   موجودی سایت بی تنظیم
 *   M10  پیش‌فرض‌های «سیاست حسابداری» و «سیاست تخفیف»
 *   M11  متن راهنمای قفل‌ها در «تنظیمات»
 *
 * «یافته»ها با بند دفتر (ستون plan):
 *   STALE_CART_MANAGER_PROMPT / STALE_CART_OVERCHARGE   ۴-۱۱۴  (سرور عمداً همان می‌ماند؛ پس از اجرا هم این‌جا می‌مانند و
 *                                                               سنجش ۴-۱۱۴ با آزمون صفحه است)
 *   STALE_LAST_PURCHASE_PRICE / PAYMENT_EDIT_REWRITES_COST  ۴-۱۱۵
 *   DEAD_END_MESSAGE                                     ۴-۱۱۶
 *   ODD_DEFAULT / SILENT_NEGATIVE_STOCK / OVERPAID_ACCEPTED / FUTURE_DATE_ACCEPTED  ۴-۱۱۷
 *   NO_VOID_PATH                                         ۴-۱۱۸
 *   LATIN_DIGITS_IRRELEVANT_NOTE                         ۴-۱۱۹
 *   NO_PROVIDER_NOTICE                                   ۴-۱۲۰
 *   LOCK_HINT_TEXT / LATIN_DIGITS / VAGUE_MESSAGE / REGISTER_MIX / ENGLISH_MESSAGE  ۴-۱۲۱ («Master Override»: ۴-۵۵)
 *   منطق (باید همیشه صفر بماند): UNEXPECTED_REFUSAL، ACCEPTED_BUT_SHOULD_REFUSE، STOCK_LEDGER_MISMATCH (موجودی هر
 *   کالا = جمع دفتر گردش انبار)، REPORT_MISMATCH (گزارشات فروش = گزارش مدیریت)، STOCK_NOT_MOVED
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده و پوشهٔ موقت؛ به برنامه، پایگاه واقعی یا آزمون‌های
 * مخزن دست نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/modules-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی تاریخ و ساعت) برای مقایسه
 *   ... --compare docs/audit/modules-scenarios-2026-11-26.json
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_VERBOSE=1  ریز هر گام
 */
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
const sender = { id: 777140, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)
const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { priceAdjustService } = await imp('/src/main/services/PriceAdjustService.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS, LOCKED_PANELS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const { toJalaliDate, jalaliAddDays } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const db = harnessClient()
/**
 * هارنس ساختار نهایی جدول‌ها را یک‌جا می‌سازد ولی دفتر `_prisma_migrations` ندارد؛ مثل ابزار بستن صندوق، دفتر با
 * همان checksum برنامه پر می‌شود تا پایگاه آزمون شبیه پایگاه واقعی باشد.
 */
{
  const migDir = findMigrationsDir()
  db.$harness.db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`)
  const { createHash, randomUUID } = await import('node:crypto')
  for (const name of readdirSync(migDir).filter((x) => existsSync(join(migDir, x, 'migration.sql'))).sort()) {
    const raw = readFileSync(join(migDir, name, 'migration.sql'))
    db.$harness.db.prepare(`INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count") VALUES (?,?,current_timestamp,?,1)`).run(randomUUID(), createHash('sha256').update(raw).digest('hex'), name)
  }
}
const seed = makeSeeder(db)
const n = (x) => Number(x ?? 0)
const today = toJalaliDate(new Date())
const owner = seed.user('مالک فروشگاه')
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
// قفل ماژول‌ها عمداً ثبت نمی‌شود: همان پیش‌فرض نصب تازه. هر صفحه با notePanelUnlocked باز می‌شود.
registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
console.warn = (...a) => ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
const invoke = async (ch, p) => { const fn = handlers.get(ch); if (!fn) throw new Error('no handler ' + ch); return fn({ sender }, p) }
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }
const normFa = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
const msgOf = (s) => String(s ?? '').split('\n')[0].slice(0, 400)
/** تاریخ و ساعت روز اجرا از متن‌ها برداشته می‌شود تا نتیجه هر روز یکی باشد. */
const normStr = (s) => String(s ?? '')
  .replace(/[0-9۰-۹]{4}\/[0-9۰-۹]{1,2}\/[0-9۰-۹]{1,2}/g, '<تاریخ>')
  .replace(/(^|[^0-9۰-۹])[0-9۰-۹]{1,2}:[0-9۰-۹]{2}(?![0-9۰-۹])/g, '$1<ساعت>')
const PLAN = {
  STALE_CART_MANAGER_PROMPT: '۴-۱۱۴', STALE_CART_OVERCHARGE: '۴-۱۱۴',
  STALE_LAST_PURCHASE_PRICE: '۴-۱۱۵', PAYMENT_EDIT_REWRITES_COST: '۴-۱۱۵',
  DEAD_END_MESSAGE: '۴-۱۱۶',
  ODD_DEFAULT: '۴-۱۱۷', SILENT_NEGATIVE_STOCK: '۴-۱۱۷', OVERPAID_ACCEPTED: '۴-۱۱۷', FUTURE_DATE_ACCEPTED: '۴-۱۱۷',
  NO_VOID_PATH: '۴-۱۱۸',
  LATIN_DIGITS_IRRELEVANT_NOTE: '۴-۱۱۹',
  NO_PROVIDER_NOTICE: '۴-۱۲۰',
  LOCK_HINT_TEXT: '۴-۱۲۱', LATIN_DIGITS: '۴-۱۲۱', VAGUE_MESSAGE: '۴-۱۲۱', REGISTER_MIX: '۴-۱۲۱', ENGLISH_MESSAGE: '۴-۱۲۱'
}
let keySeq = 0
const scenarios = []
let cur = null
function scenario(id, title) { cur = { id, title, steps: [], obs: [], findings: [] }; scenarios.push(cur); console.log(`\n== ${id} — ${title}`); return cur }
function obs(k, v) { cur.obs.push({ k, v }); if (VERBOSE) console.log(`   · ${k}: ${JSON.stringify(v)}`) }
function finding(type, text, data) {
  const plan = type === 'LOCK_HINT_TEXT' && /Master Override/.test(text) ? '۴-۵۵' : PLAN[type] ?? 'منطق'
  cur.findings.push({ type, plan, text, ...(data ? { data } : {}) })
  console.log(`   ⚑ ${type} [${plan}]: ${text}`)
}
async function call(label, expect, ch, payload) {
  let r
  try { r = await invoke(ch, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  const ok = !!r.ok
  const step = { label, expect, ok, ...(ok ? {} : { code: r.code ?? null, msg: msgOf(r.error) }) }
  cur.steps.push(step)
  if (expect === 'ok' && !ok) finding('UNEXPECTED_REFUSAL', `${label} :: ${msgOf(r.error)}`)
  if (expect === 'refuse' && ok) finding('ACCEPTED_BUT_SHOULD_REFUSE', label)
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && (VERBOSE || expect === 'ok') ? '  :: ' + msgOf(r.error) : ''}`)
  return { ok, data: r.data, error: r.error, code: r.code }
}
const stockOf = (vid) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', vid)?.stock)
const variantOf = (vid) => seed.one('SELECT salePrice, purchasePrice, stock FROM "ProductVariant" WHERE id=?', vid)
const movSum = (vid) => n(seed.one('SELECT COALESCE(SUM(delta),0) s FROM "StockMovement" WHERE variantId=?', vid)?.s)
function ledgerCheck(vids, label) {
  for (const [code, vid] of Object.entries(vids)) {
    const st = stockOf(vid), mv = movSum(vid)
    if (st !== mv) finding('STOCK_LEDGER_MISMATCH', `${label}: ${code} stock ${st} ≠ movements ${mv}`)
  }
}
const salePay = (amount, kind = 'CASH') => [{ methodId: kind === 'CARD' ? cardM : cashM, amount, destination: kind }]
const posSale = (label, expect, lines, amount, kind = 'CASH', extra = {}) =>
  call(label, expect, IPC.saleCreate, { lines, payments: salePay(amount, kind), saleRequestIdempotencyKey: `mod-sale-${++keySeq}-xxxx`, ...extra })
const L = (vid, qty, unitPrice, tax = 0, name = null) => ({ variantId: vid, qty, unitPrice, discount: 0, tax, ...(name ? { name } : {}) })

// ============================================================ M0 setup
scenario('M0', 'راه‌اندازی: نشست مالک و باز کردن صفحه‌ها با رمز همان صفحه')
await call('open session (owner)', 'ok', IPC.shiftSessionOpen, { staffId: owner, handover: false, idempotencyKey: `mod-open-${++keySeq}xxxx` })
unlock(PANEL_KEYS.products, PANEL_KEYS.purchase, PANEL_KEYS.stocktake, PANEL_KEYS.priceAdjust, PANEL_KEYS.chargesTaxPos, PANEL_KEYS.chargesServicePos,
  PANEL_KEYS.chargesTaxWholesale, PANEL_KEYS.chargesServiceWholesale, PANEL_KEYS.salesReports, PANEL_KEYS.managementReports, PANEL_KEYS.managementProfit,
  PANEL_KEYS.wholesaleInvoiceModule, PANEL_KEYS.settings, PANEL_KEYS.secondaryStock, PANEL_KEYS.smsPanel, PANEL_KEYS.wooSync, PANEL_KEYS.pos)

// ============================================================ M1 products
scenario('M1', 'کالاها و دسته‌ها')
const cMen = await call('category «مردانه»', 'ok', IPC.categoryUpsert, { name: 'مردانه' })
const catMen = n(cMen.data?.id)
const cPants = await call('category «شلوار» under «مردانه»', 'ok', IPC.categoryUpsert, { name: 'شلوار', parentId: catMen })
const catPants = n(cPants.data?.id)
const cWomen = await call('category «زنانه»', 'ok', IPC.categoryUpsert, { name: 'زنانه' })
const catWomen = n(cWomen.data?.id)
await call('product «شلوار جین» (32, 34) stock 0', 'ok', IPC.productUpsert, { name: 'شلوار جین', categoryId: catPants, unit: 'عدد', note: null,
  variants: [{ code: 'J-32', barcode: '6260001000321', size: '32', color: 'آبی', salePrice: 1_000_000, purchasePrice: 600_000, stock: 0 },
    { code: 'J-34', barcode: '6260001000345', size: '34', color: 'آبی', salePrice: 1_000_000, purchasePrice: 600_000, stock: 0 }] })
await call('product «پیراهن» L stock 0', 'ok', IPC.productUpsert, { name: 'پیراهن', categoryId: catMen, unit: 'عدد', note: null,
  variants: [{ code: 'S-L', barcode: '6260001000505', size: 'L', color: 'سفید', salePrice: 800_000, purchasePrice: 500_000, stock: 0 }] })
await call('product «مانتو» M stock 0', 'ok', IPC.productUpsert, { name: 'مانتو', categoryId: catWomen, unit: 'عدد', note: null,
  variants: [{ code: 'M-M', barcode: '6260001000901', size: 'M', color: 'مشکی', salePrice: 2_500_000, purchasePrice: 1_500_000, stock: 0 }] })
const V = Object.fromEntries(seed.rows('SELECT id, code FROM "ProductVariant" ORDER BY id').map((r) => [r.code, n(r.id)]))
obs('variants', Object.keys(V))
const dupB = await call('duplicate barcode on another product', 'refuse', IPC.productUpsert, { name: 'کالای تکراری', categoryId: catMen, unit: 'عدد', note: null,
  variants: [{ code: 'DUP-1', barcode: '6260001000321', size: null, color: null, salePrice: 100_000, purchasePrice: 50_000, stock: 0 }] })
obs('duplicate barcode message', msgOf(dupB.error))
const dupC = await call('duplicate code on another product', 'refuse', IPC.productUpsert, { name: 'کالای کد تکراری', categoryId: catMen, unit: 'عدد', note: null,
  variants: [{ code: 'J-32', barcode: '6260009999999', size: null, color: null, salePrice: 100_000, purchasePrice: 50_000, stock: 0 }] })
obs('duplicate code message', msgOf(dupC.error))
{
  const dupBName = /بارکد/.test(String(dupB.error)) && !/6260001000321|۶۲۶۰۰۰۱۰۰۰۳۲۱|شلوار جین/.test(String(dupB.error))
  if (dupBName) finding('VAGUE_MESSAGE', 'بارکد تکراری: پیام نمی‌گوید بارکد مال کدام کالاست («بارکد تکراری است؛ یک مقدار دیگر وارد کنید.»)')
}

// ============================================================ M2 purchase
scenario('M2', 'فاکتور خرید: شماره، ثبت، ویرایش، قیمت خرید کارت کالا، ابطال')
const nn = await call('next purchase number on an empty shop', 'ok', IPC.purchaseNextNo, {})
obs('first purchase number', n(nn.data))
if (n(nn.data) !== 1) finding('ODD_DEFAULT', `شمارهٔ نخستین فاکتور خرید در فروشگاه تازه ${n(nn.data)} است، نه ۱`)
await call('purchase without the purchase password', 'refuse', IPC.purchaseCreate, { supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 0,
  lines: [{ variantId: V['J-32'], qty: 1, unitPrice: 600_000 }] })
const pu1 = await call('purchase A: J-32×5@600k, J-34×5@600k, S-L×4@500k, M-M×3@1.5m; discount 200k; paid 3m; ACCOUNT', 'ok', IPC.purchaseCreate, { panelPassword: PW,
  supplierName: 'تولیدی نمونه', settlementType: 'ACCOUNT', discountTotal: 200_000, paidTotal: 3_000_000, note: 'خرید آزمایشی',
  lines: [{ variantId: V['J-32'], qty: 5, unitPrice: 600_000 }, { variantId: V['J-34'], qty: 5, unitPrice: 600_000 }, { variantId: V['S-L'], qty: 4, unitPrice: 500_000 }, { variantId: V['M-M'], qty: 3, unitPrice: 1_500_000 }] })
obs('purchase A', { goods: n(pu1.data?.goodsTotal), discount: n(pu1.data?.discountTotal), grand: n(pu1.data?.grandTotal), paid: n(pu1.data?.paidTotal) })
const pu2 = await call('purchase B (newer): J-32×2@650k CASH paid', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 1_300_000,
  lines: [{ variantId: V['J-32'], qty: 2, unitPrice: 650_000 }] })
obs('J-32 card after B', variantOf(V['J-32']))
const linesA = (j32price, withJ32 = true) => [
  ...(withJ32 ? [{ variantId: V['J-32'], qty: 5, unitPrice: j32price }] : []),
  { variantId: V['J-34'], qty: 5, unitPrice: 600_000 }, { variantId: V['S-L'], qty: 4, unitPrice: 500_000 }, { variantId: V['M-M'], qty: 3, unitPrice: 1_500_000 }]
await call('edit OLDER purchase A: J-32 price 600k→610k (typo fix)', 'ok', IPC.purchaseUpdate, { panelPassword: PW, id: n(pu1.data?.id), supplierName: 'تولیدی نمونه', settlementType: 'ACCOUNT', discountTotal: 200_000, paidTotal: 3_000_000, lines: linesA(610_000) })
{
  const pp = n(variantOf(V['J-32']).purchasePrice)
  obs('J-32 card purchase price after editing older A', pp)
  if (pp !== 650_000) finding('STALE_LAST_PURCHASE_PRICE', `ویرایش فاکتور خرید قدیمی‌تر، «قیمت خرید» کارت کالا را از ${pp === 610_000 ? '۶۵۰٬۰۰۰ (فاکتور تازه‌تر)' : '؟'} به ${pp} برگرداند`)
}
const s1 = await posSale('POS sale J-32×3 cash', 'ok', [L(V['J-32'], 3, 1_000_000)], 3_000_000)
const r1 = await call('edit purchase A: remove J-32 line (stock 4, line 5)', 'ok', IPC.purchaseUpdate, { panelPassword: PW, id: n(pu1.data?.id), supplierName: 'تولیدی نمونه', settlementType: 'ACCOUNT', discountTotal: 200_000, paidTotal: 3_000_000, lines: linesA(610_000, false) })
obs('J-32 stock after removing the line', stockOf(V['J-32']))
obs('edit result has a warning about negative stock', JSON.stringify(r1.data ?? {}).includes('منفی'))
if (stockOf(V['J-32']) < 0 && !JSON.stringify(r1.data ?? {}).includes('منفی')) finding('SILENT_NEGATIVE_STOCK', `ویرایش فاکتور خرید موجودی J-32 را بی هیچ هشداری ${stockOf(V['J-32'])} کرد`)
await call('restore J-32 line in A (undo)', 'ok', IPC.purchaseUpdate, { panelPassword: PW, id: n(pu1.data?.id), supplierName: 'تولیدی نمونه', settlementType: 'ACCOUNT', discountTotal: 200_000, paidTotal: 3_000_000, lines: linesA(610_000) })
const pu3 = await call('purchase C (newest): J-32×1@660k CASH', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 660_000,
  lines: [{ variantId: V['J-32'], qty: 1, unitPrice: 660_000 }] })
obs('J-32 card after C', n(variantOf(V['J-32']).purchasePrice))
await call('pay the supplier later: edit OLDER A, only «paid» 3,000,000 → 5,000,000 (lines unchanged)', 'ok', IPC.purchaseUpdate, { panelPassword: PW, id: n(pu1.data?.id), supplierName: 'تولیدی نمونه', settlementType: 'ACCOUNT', discountTotal: 200_000, paidTotal: 5_000_000, lines: linesA(610_000) })
{
  const pp = n(variantOf(V['J-32']).purchasePrice)
  obs('J-32 card after a payment-only edit of A', pp)
  if (pp !== 660_000) finding('PAYMENT_EDIT_REWRITES_COST', `ثبت پرداخت بعدی روی فاکتور خرید قدیمی، «قیمت خرید» کارت کالا را از ۶۶۰٬۰۰۰ (تازه‌ترین خرید) به ${pp} برگرداند`)
}
const over = await call('purchase paid more than its total: 1 × 500,000, paid 5,000,000', 'either', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 5_000_000,
  lines: [{ variantId: V['S-L'], qty: 1, unitPrice: 500_000 }] })
obs('overpaid purchase accepted', over.ok)
if (over.ok) finding('OVERPAID_ACCEPTED', 'فاکتور خرید ۵۰۰٬۰۰۰ ریالی با «پرداخت‌شده» ۵٬۰۰۰٬۰۰۰ بی هشدار ثبت شد؛ صفحه فقط «تسویه کامل» نشان می‌دهد')
const vB = await call('void purchase B entirely (all lines 0) — wrong invoice entered', 'either', IPC.purchaseUpdate, { panelPassword: PW, id: n(pu2.data?.id), supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 0, lines: [{ variantId: V['J-32'], qty: 0, unitPrice: 650_000 }] })
if (!vB.ok) finding('NO_VOID_PATH', `فاکتور خرید اشتباه را نمی‌شود باطل کرد: «${msgOf(vB.error)}»؛ کانال حذف/ابطال هم نیست`)
const pl = await call('purchase list', 'ok', IPC.purchaseList, {})
obs('purchase list', [...(Array.isArray(pl.data) ? pl.data : Object.values(pl.data ?? {}).filter((x) => x && typeof x === 'object' && 'invoiceNo' in x))].map((r) => [r.invoiceNo, n(r.grandTotal), n(r.paidTotal), r.settlementType]))
obs('purchase list totals', pl.data?.totals ?? null)
const future = jalaliAddDays(today, 3)
const pf = await call('purchase dated 3 days in the future', 'either', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی نمونه', settlementType: 'CASH', paidTotal: 0, issuedAtJalali: future,
  lines: [{ variantId: V['S-L'], qty: 1, unitPrice: 500_000 }] })
obs('future-dated purchase accepted', pf.ok)
if (pf.ok) finding('FUTURE_DATE_ACCEPTED', 'فاکتور خرید با تاریخ سه روز بعد بی هشدار ثبت شد (شمارش انبار تاریخ آینده را رد می‌کند)')
ledgerCheck(V, 'after purchases')

// ============================================================ M3 stocktake & stock adjust
scenario('M3', 'انبارگردانی، مغایرت و اصلاح موجودی')
obs('stock now', Object.fromEntries(Object.entries(V).map(([c, v]) => [c, stockOf(v)])))
const sysJ = stockOf(V['J-34']), sysS = stockOf(V['S-L'])
const sc = await call('count: J-34 one short, S-L one extra (surplus)', 'ok', IPC.stockCountSubmit, { items: [{ variantId: V['J-34'], countedQty: sysJ - 1 }, { variantId: V['S-L'], countedQty: sysS + 1 }], note: 'انبارگردانی آزمایشی' })
obs('count result', { mismatched: sc.data?.mismatchedCount, items: sc.data?.itemCount })
obs('stock unchanged by count', [stockOf(V['J-34']) === sysJ, stockOf(V['S-L']) === sysS])
await call('count dated tomorrow', 'refuse', IPC.stockCountSubmit, { dateJalali: jalaliAddDays(today, 1), items: [{ variantId: V['J-34'], countedQty: sysJ - 1 }] })
const dis = await call('discrepancy (only mismatched)', 'ok', IPC.stockCountDiscrepancy, { onlyMismatched: true })
obs('discrepancy rows', (Array.isArray(dis.data) ? dis.data : dis.data?.rows ?? []).length)
await call('shortage fix: J-34 −1 (DAMAGE) without password', 'refuse', IPC.stockAdjust, { variantId: V['J-34'], newQty: sysJ - 1, kind: 'DAMAGE', note: 'طبق انبارگردانی' })
await call('shortage fix: J-34 −1 (DAMAGE) with password', 'ok', IPC.stockAdjust, { variantId: V['J-34'], newQty: sysJ - 1, kind: 'DAMAGE', note: 'طبق انبارگردانی', managerPassword: PW })
const sur = await call('surplus fix: S-L +1 with password', 'either', IPC.stockAdjust, { variantId: V['S-L'], newQty: sysS + 1, kind: 'CORRECTION', note: 'طبق انبارگردانی', managerPassword: PW })
obs('surplus message', msgOf(sur.error).replace(/[۰-۹]+/g, '#'))
{
  const chans = Object.values(IPC).filter((c) => /stockCount|stocktake/i.test(c))
  const hasSurplusPath = chans.some((c) => /surplus|gain|apply|adjust/i.test(c))
  obs('stocktake channels', chans)
  if (!sur.ok && /انبارگردانی/.test(String(sur.error)) && !hasSurplusPath)
    finding('DEAD_END_MESSAGE', 'افزایش دستی رد می‌شود و پیام به «مسیر انبارگردانی» می‌فرستد، ولی انبارگردانی چنین راهی ندارد (صفحهٔ انبارگردانی هم می‌گوید اصلاح از پنل کالاها)')
}
const sch = await call('reminder: every 30 days', 'either', IPC.stocktakeScheduleSet, { schedule: { enabled: true, intervalDays: 30, dates: [] }, panelPassword: PW })
const due = await call('reminder due', 'ok', IPC.stocktakeDue, {})
obs('reminder due', due.data ? { enabled: due.data.enabled, due: due.data.due ?? due.data.isDue ?? null } : null)
ledgerCheck(V, 'after stocktake')

// ============================================================ M4 central warehouse
scenario('M4', 'انبار مرکزی: انبار، کالا، انتقال و انتقال به فروشگاه')
const wh = await call('warehouse «انبار پشت مغازه»', 'ok', IPC.secondaryWarehouseUpsert, { name: 'انبار پشت مغازه', location: 'زیرزمین' })
const whId = n(wh.data?.id)
const it1 = await call('central item «مانتو مشکی M» qty 10 (default warehouse)', 'ok', IPC.secondaryStockUpsert, { name: 'مانتو مشکی M', code: 'M-M', qty: 10 })
const itemId = n(it1.data?.id)
await call('transfer 4 to «انبار پشت مغازه»', 'ok', IPC.secondaryStockTransfer, { itemId, toWarehouseId: whId, qty: 4, note: 'جابجایی' })
const rows = await call('central list', 'ok', IPC.secondaryStockList, {})
obs('central rows', (rows.data ?? []).map((r) => [r.name, r.warehouseName ?? r.warehouseId ?? null, n(r.qty)]))
const mmBefore = stockOf(V['M-M'])
await call('to store 3 → variant M-M without the to-store password', 'refuse', IPC.secondaryStockToStore, { itemId, variantId: V['M-M'], qty: 3 })
const ts = await call('to store 3 → variant M-M with password', 'ok', IPC.secondaryStockToStore, { itemId, variantId: V['M-M'], qty: 3, toStorePassword: PW })
obs('M-M store stock before/after', [mmBefore, stockOf(V['M-M'])])
if (stockOf(V['M-M']) !== mmBefore + 3) finding('STOCK_NOT_MOVED', 'انتقال به فروشگاه موجودی فروشگاه را ۳ بالا نبرد')
const rows2 = await call('central list after', 'ok', IPC.secondaryStockList, {})
obs('central rows after', (rows2.data ?? []).map((r) => [r.name, n(r.qty)]))
const hist = await call('central history', 'ok', IPC.secondaryStockHistory, {})
obs('history rows', (hist.data?.rows ?? hist.data ?? []).length)
ledgerCheck(V, 'after central')

// ============================================================ M5 price adjust
scenario('M5', 'تغییر قیمت گروهی: فوری، کف قیمت، زمان‌بندی، سبد باز')
const base = { kind: 'INCREASE', mode: 'PERCENT', value: 10, scope: 'CATEGORY', categoryId: catMen, target: 'SALE', round: 1000 }
const prev = await call('preview +10% «مردانه» (includes sub-category «شلوار»)', 'ok', IPC.priceAdjustPreview, base)
obs('preview', (prev.data?.lines ?? []).map((l) => [l.code ?? l.variantId, n(l.oldPrice), n(l.newPrice)]))
await call('apply without password', 'refuse', IPC.priceAdjustApply, { ...base, note: 'گرانی' })
const ap = await call('apply with password', 'ok', IPC.priceAdjustApply, { ...base, note: 'گرانی', password: PW })
obs('prices after +10%', { J32: n(variantOf(V['J-32']).salePrice), SL: n(variantOf(V['S-L']).salePrice), MM: n(variantOf(V['M-M']).salePrice) })
const stale = await posSale('POS sale S-L at the price shown before the change (800,000; cart opened earlier)', 'either', [L(V['S-L'], 1, 800_000, 0, 'پیراهن')], 800_000, 'CARD')
if (!stale.ok && /GATE_REQUIRED|تایید مدیر|تأیید مدیر/.test(String(stale.code) + String(stale.error)))
  finding('STALE_CART_MANAGER_PROMPT', `سبدی که پیش از تغییر قیمت باز بود، هنگام پرداخت رمز مدیر می‌خواهد: «${msgOf(stale.error)}»`)
await call('revert with password', 'ok', IPC.priceAdjustRevert, { batchId: n(ap.data?.batchId), password: PW })
obs('prices after revert', { J32: n(variantOf(V['J-32']).salePrice), SL: n(variantOf(V['S-L']).salePrice) })
const floor = await call('preview −500,000 AMOUNT on «پیراهن» with min price 400,000', 'ok', IPC.priceAdjustPreview, { kind: 'DECREASE', mode: 'AMOUNT', value: 500_000, scope: 'VARIANTS', variantIds: [V['S-L']], target: 'SALE', round: 1, minPrice: 400_000 })
obs('floor preview', (floor.data?.lines ?? []).map((l) => [n(l.oldPrice), n(l.newPrice)]))
const pur = await call('preview change of PURCHASE price (closed target)', 'either', IPC.priceAdjustPreview, { ...base, target: 'PURCHASE' })
obs('purchase target', pur.ok ? 'accepted' : msgOf(pur.error))
// scheduled discount: start in 1 hour, end in 3 hours (scheduler driven by an explicit "now")
const startAt = new Date(Date.now() + 3600_000), endAt = new Date(Date.now() + 3 * 3600_000)
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const schedP = { kind: 'DISCOUNT', mode: 'PERCENT', value: 20, scope: 'VARIANTS', variantIds: [V['M-M']], target: 'SALE', round: 1000,
  startDate: toJalaliDate(startAt), startTime: hm(startAt), endDate: toJalaliDate(endAt), endTime: hm(endAt), note: 'حراج آزمایشی', password: PW }
const sp = await call('schedule −20% on «مانتو» from +1h to +3h', 'ok', IPC.priceAdjustApply, schedP)
obs('M-M price right after scheduling', n(variantOf(V['M-M']).salePrice))
const t1 = await priceAdjustService.runDueSchedules(new Date(startAt.getTime() + 60_000))
obs('scheduler at start+1m', { ...t1, price: n(variantOf(V['M-M']).salePrice) })
const early = await posSale('POS sale «مانتو» from a cart filled before the sale started, paid during the sale (old price 2,500,000)', 'either', [L(V['M-M'], 1, 2_500_000, 0, 'مانتو')], 2_500_000)
if (early.ok) finding('STALE_CART_OVERCHARGE', 'سبدی که پیش از شروع حراج پر شده بود، با قیمت قدیمی ۲٬۵۰۰٬۰۰۰ (به‌جای ۲٬۰۰۰٬۰۰۰ حراج) بی هیچ هشداری ثبت شد')
const saleDisc = await posSale('POS sale «مانتو» at the discounted price 2,000,000 (during the sale)', 'ok', [L(V['M-M'], 1, 2_000_000, 0, 'مانتو')], 2_000_000)
const t2 = await priceAdjustService.runDueSchedules(new Date(endAt.getTime() + 60_000))
obs('scheduler at end+1m', { ...t2, price: n(variantOf(V['M-M']).salePrice) })
const stale2 = await posSale('POS sale «مانتو» from a cart filled during the sale, paid after the sale ended (2,000,000)', 'either', [L(V['M-M'], 1, 2_000_000, 0, 'مانتو')], 2_000_000)
if (!stale2.ok && /GATE_REQUIRED|تایید مدیر|تأیید مدیر/.test(String(stale2.code) + String(stale2.error)))
  finding('STALE_CART_MANAGER_PROMPT', `پایان حراج زمان‌بندی‌شده وسط فروش: سبد باز رمز مدیر می‌خواهد: «${msgOf(stale2.error)}»`)
const batches = await call('price change history', 'ok', IPC.priceAdjustBatches, {})
obs('history', (batches.data ?? []).map((b) => [b.title, b.state ?? b.stateLabel]))
for (const b of batches.data ?? []) if (/[0-9]/.test(String(b.title ?? ''))) finding('LATIN_DIGITS', `عنوان تاریخچهٔ تغییر قیمت با رقم انگلیسی: «${b.title}»`)
ledgerCheck(V, 'after price adjust')

// ============================================================ M6 charges
scenario('M6', 'عوارض و مالیات و حق سرویس: پیش‌فرض، فروش تکی، فاکتور عمده')
const cg0 = await call('charges (fresh install)', 'ok', IPC.chargesGet, {})
obs('charges fresh', cg0.data)
await call('save POS tax without password', 'refuse', IPC.chargesSave, { kind: 'tax', scope: 'pos', config: { enabled: true, fallback: null, rules: [{ categoryId: catMen, mode: 'PERCENT', value: 9 }] } })
await call('save POS tax 9% «مردانه», 0% «شلوار»', 'ok', IPC.chargesSave, { kind: 'tax', scope: 'pos', config: { enabled: true, fallback: null, rules: [{ categoryId: catMen, mode: 'PERCENT', value: 9 }, { categoryId: catPants, mode: 'PERCENT', value: 0 }] }, panelPassword: PW })
await call('save POS service fixed 20,000 per line (fallback)', 'ok', IPC.chargesSave, { kind: 'service', scope: 'pos', config: { enabled: true, fallback: { mode: 'FIXED', value: 20_000 }, rules: [] }, panelPassword: PW })
const bad = await posSale('POS sale «پیراهن» with tax 0 (page computed before the change)', 'either', [L(V['S-L'], 1, 800_000, 0, 'پیراهن')], 800_000)
obs('server message for wrong tax', msgOf(bad.error))
const m = /باید ([0-9۰-۹٬,]+) ریال/.exec(String(bad.error ?? ''))
const want = m ? Number(normFa(m[1]).replace(/[٬,]/g, '')) : 0
obs('server-required tax', want)
const good = await posSale(`POS sale «پیراهن» with tax ${want} + service 20,000`, 'either', [L(V['S-L'], 1, 800_000, want, 'پیراهن')], 800_000 + want + 20_000, 'CASH', { serviceCharge: 20_000 })
obs('POS invoice', good.ok ? { grand: n(good.data?.grandTotal), tax: n(good.data?.taxTotal), service: n(good.data?.serviceCharge) } : msgOf(good.error))
const jeans = await posSale('POS sale «شلوار جین» (0% child rule) tax 0 + service', 'either', [L(V['J-34'], 1, 1_000_000, 0, 'شلوار جین')], 1_020_000, 'CASH', { serviceCharge: 20_000 })
obs('jeans', jeans.ok ? { grand: n(jeans.data?.grandTotal), tax: n(jeans.data?.taxTotal), service: n(jeans.data?.serviceCharge) } : msgOf(jeans.error))
await call('save WHOLESALE tax 9% «مردانه»', 'ok', IPC.chargesSave, { kind: 'tax', scope: 'wholesale', config: { enabled: true, fallback: null, rules: [{ categoryId: catMen, mode: 'PERCENT', value: 9 }] }, panelPassword: PW })
const wsBase = { orderType: 'WHOLESALE', issuedAtJalali: today, deductInventory: true, wholesaleDiscountPercent: null, invoiceDiscount: 0, invoiceTax: 0, serviceCharge: 0, remoteCustomer: false, autoCentralWithdraw: false }
const w0 = await call('wholesale «پیراهن» with tax 0 (below the automatic 72,000)', 'either', IPC.saleCreate, { ...wsBase, lines: [L(V['S-L'], 1, 800_000, 0, 'پیراهن')], payments: salePay(800_000), saleRequestIdempotencyKey: `mod-ws-${++keySeq}-xxxx` })
obs('wholesale tax 0', w0.ok ? { grand: n(w0.data?.grandTotal), tax: n(w0.data?.taxTotal) } : `${w0.code ?? ''} ${msgOf(w0.error)}`)
const w1 = await call('wholesale «پیراهن» with tax 72,000', 'either', IPC.saleCreate, { ...wsBase, lines: [L(V['S-L'], 1, 800_000, 72_000, 'پیراهن')], payments: salePay(872_000), saleRequestIdempotencyKey: `mod-ws-${++keySeq}-xxxx` })
obs('wholesale tax 72,000', w1.ok ? { grand: n(w1.data?.grandTotal), tax: n(w1.data?.taxTotal) } : `${w1.code ?? ''} ${msgOf(w1.error)}`)
ledgerCheck(V, 'after charges')

// ============================================================ M7 management vs sales reports
scenario('M7', 'گزارش مدیریت در برابر گزارشات فروش (امروز)')
const sum = await call('sales report summary today', 'ok', IPC.saleReportSummary, { fromJalali: today, toJalali: today })
const snap = await call('management snapshot today', 'ok', IPC.mgmtSnapshot, { fromJalali: today, toJalali: today })
const prof = await call('management profit today', 'ok', IPC.mgmtProfit, { fromJalali: today, toJalali: today })
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, n(o?.[k])]))
obs('sales summary', pick(sum.data, ['count', 'goodsTotal', 'taxTotal', 'serviceTotal', 'discountTotal', 'grandTotal', 'cashTotal', 'cardTotal', 'returnedTotal']))
const acc = snap.data?.accounting ?? {}
obs('mgmt snapshot keys', Object.keys(acc).slice(0, 30))
obs('mgmt profit', pick(prof.data, ['revenue', 'fifoCost', 'realProfit', 'soldQty']))
const tr = await call('management trend (روند) today', 'ok', IPC.mgmtTrend, { fromJalali: today, toJalali: today })
obs('trend warnings', tr.data?.warnings ?? [])
for (const w of tr.data?.warnings ?? []) if (/[0-9]/.test(w)) finding('LATIN_DIGITS_IRRELEVANT_NOTE', `زیر نمودار «روند» گزارش مدیریت: «${w}»`)
{
  const a = sum.data ?? {}, b = acc.invoice ?? {}
  const pairs = [['goodsTotal', 'grossSales'], ['taxTotal', 'taxes'], ['serviceTotal', 'serviceCharges'], ['grandTotal', 'netAccrualSales'], ['count', 'invoiceCount']]
  for (const [x, y] of pairs) if (n(a[x]) !== n(b[y])) finding('REPORT_MISMATCH', `${x} ${n(a[x])} ≠ مدیریت ${y} ${n(b[y])}`)
  obs('sales vs management agree', pairs.every(([x, y]) => n(a[x]) === n(b[y])))
}

// ============================================================ M8 SMS
scenario('M8', 'پنل پیامکی: قالب‌ها، برآورد، لغو ۱۱، ارسال بی سرویس‌دهنده')
const dash = await call('sms dashboard', 'ok', IPC.smsDashboard, {})
obs('sms dashboard keys', Object.keys(dash.data ?? {}).slice(0, 20))
const { DEFAULT_SMS_TEMPLATES } = await imp('/src/main/services/sms/SmsTemplates.ts')
const tpls = DEFAULT_SMS_TEMPLATES
obs('templates', tpls.map((t) => [t.code, t.title]))
for (const t of tpls) {
  const b = String(t.body ?? '')
  if (/شما/.test(b) && /(یادت|دیدی|داری|بیا)(?=[\s؟?،.!]|$)/.test(b)) finding('REGISTER_MIX', `قالب «${t.title}»: «شما» با فعل خودمانی آمده: ${b.slice(0, 120)}`)
}
const est = await call('estimate a Persian text to 3 recipients', 'either', IPC.smsEstimate, { body: 'سلام؛ حراج پاییزه فروشگاه از فردا شروع می‌شود. '.repeat(3), recipients: 3 })
obs('estimate', est.ok ? est.data : msgOf(est.error))
const oo = await call('opt-out add 09121234567', 'either', IPC.smsOptOutAdd, { phone: '09121234567', note: 'درخواست مشتری' })
obs('opt-out add', oo.ok ? 'ok' : msgOf(oo.error))
const sm = await call('manual send without any provider', 'either', IPC.smsSendManual, { phone: '09121234567', body: 'پیام آزمایشی' })
obs('manual send', sm.ok ? sm.data : msgOf(sm.error))
if (sm.ok && !dash.data?.provider && !/سرویس/.test(String(sm.data?.detail ?? ''))) finding('NO_PROVIDER_NOTICE', `ارسال دستی بی سرویس‌دهندهٔ فعال فقط می‌گوید «${sm.data?.detail}»`)
const ss = await call('sms settings', 'ok', IPC.smsSettingsGet, {})
obs('sms settings', ss.data)

// ============================================================ M9 messenger, site, remote
scenario('M9', 'موجودی سایت (بی تنظیم)')
const ws = await call('site stock status', 'either', IPC.wooStatus, {})
obs('woo status', ws.ok ? Object.fromEntries(Object.entries(ws.data ?? {}).filter(([k, v]) => typeof v !== 'object').slice(0, 20)) : msgOf(ws.error))
const wt = await call('site connection test without settings', 'either', IPC.wooTest, {})
obs('woo test', wt.ok ? wt.data : msgOf(wt.error))
if (!wt.ok && /[A-Za-z]{4,}/.test(msgOf(wt.error)) && !/[\u0600-\u06FF]/.test(msgOf(wt.error))) finding('ENGLISH_MESSAGE', `پیام آزمون اتصال سایت انگلیسی است: ${msgOf(wt.error)}`)

// ============================================================ M10 settings defaults
scenario('M10', 'پیش‌فرض‌های تنظیمات در نصب تازه')
const ap0 = await call('accounting policy', 'ok', IPC.settingsAccountingPolicy, {})
obs('accounting policy', ap0.data)
const dp0 = await call('discount policy', 'ok', IPC.discountPolicyGet, {})
obs('discount policy', dp0.data)

// ============================================================ M11 visible texts (static)
scenario('M11', 'متن‌های دیدنی: راهنمای قفل‌ها در تنظیمات')
for (const p of LOCKED_PANELS) {
  const t = `${p.title} — ${p.hint ?? ''}`
  const issues = []
  if (/\*\*/.test(t)) issues.push('ستاره‌های **')
  if (/(بند|جلسه|نشست|مورد)\s*[۰-۹0-9]/.test(t)) issues.push('شمارهٔ داخلی')
  const lat = (t.match(/[A-Za-z][A-Za-z:_.-]{2,}/g) || []).map((w) => w.replace(/[.:]+$/, '')).filter((w) => !['SMS', 'PIN', 'POS', 'API', 'USB', 'Excel', 'WooCommerce', 'sms.ir'].includes(w))
  if (lat.length) issues.push('انگلیسی: ' + [...new Set(lat)].join('، '))
  if (issues.length) finding('LOCK_HINT_TEXT', `«${p.title}»: ${issues.join(' · ')}`)
}

// ============================================================ خلاصه، نتیجهٔ فشرده و مقایسه
const allFindings = scenarios.flatMap((c) => c.findings.map((f) => ({ sc: c.id, ...f })))
const byPlan = {}
const byType = {}
for (const f of allFindings) {
  byPlan[f.plan] = (byPlan[f.plan] ?? 0) + 1
  byType[f.type] = (byType[f.type] ?? 0) + 1
}
const summary = {
  scenarios: scenarios.length,
  steps: scenarios.reduce((s, c) => s + c.steps.length, 0),
  refused: scenarios.reduce((s, c) => s + c.steps.filter((x) => !x.ok).length, 0),
  findings: allFindings.length,
  logicFindings: byPlan['منطق'] ?? 0,
  byPlan,
  byType
}
const normDeep = (v) => {
  if (typeof v === 'string') return normStr(v)
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(normDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normDeep(x)]))
  return v ?? null
}
const snapshot = scenarios.map((c) => ({
  id: c.id,
  title: c.title,
  steps: c.steps.map((st) => [st.label, st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? null : `${st.code ? '[' + st.code + '] ' : ''}${normStr(st.msg)}`]),
  findings: [...new Set(c.findings.map((f) => `${f.type} | ${f.plan} | ${normStr(f.text)}`))].sort(),
  obs: normDeep(c.obs)
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapshotDoc = { meta: { tool: 'docs/audit/modules-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify(snapshotDoc, null, 1) + '\n')
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify(normDeep({ scenarios, ipcErrors }), null, 1) + '\n')

console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)

if (COMPARE) {
  const base = JSON.parse(readFileSync(COMPARE, 'utf8')).scenarios
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const b = byId.get(s.id)
    if (!b) { diffs.push(`+ سناریوی تازه: ${s.id}`); continue }
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
  for (const id of byId.keys()) diffs.push(`- سناریو نیست: ${id}`)
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 500)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
