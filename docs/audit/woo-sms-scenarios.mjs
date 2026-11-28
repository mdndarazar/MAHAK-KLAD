/**
 * آزمون «موجودی سایت (ووکامرس) و پنل پیامکی» — آزمون ۲۰۲۶-۱۱-۲۶ (دفتر آزمون مالک، پس از پاسخ ۱۳).
 *
 * خواستهٔ مالک: «…مثلا پنل پیامکی و موجودی سایت … تا باگی ازش دربیاری» و دربارهٔ سایت: «سیستم سود وزیان رو فقط برای
 * فروشگاه حساب کنه نه برای سایت … سایت فقط و فقط و فقط برای فروش سایت است و سود و زیان رو در خود سایت حساب میکنیم
 * نمیخام با مغازه قاطی بشه».
 *
 * همه‌چیز از همان کانال‌های IPC صفحه‌ها می‌رود، با همان قفل‌ها و رمزها. سایت وردپرس و سرویس‌دهندهٔ پیامک با دو
 * سرور کوچکِ همین ابزار روی 127.0.0.1 شبیه‌سازی می‌شوند (همان قرارداد افزونهٔ `mahak-stock/v1` و همان قرارداد sms.ir)؛
 * برنامه همان کد واقعی خودش را اجرا می‌کند و فقط نشانی سایت و سرویس‌دهنده به این دو سرور اشاره دارد.
 *
 * سناریوها:
 *   W0   راه‌اندازی: نشست، کالاها، فاکتورهای خرید، سایت آزمایشی
 *   W1   تنظیم اتصال سایت: نشانی امن، کلید، تست، کاتالوگ
 *   W2   اتصال کالاها: «فروشگاه مرجع» و «سایت مرجع»؛ اتصال‌های نادرست
 *   W3   فروش مغازه ⇐ موجودی سایت کم می‌شود
 *   W4   فروش سایت ⇐ موجودی مغازه کم می‌شود؛ سود و زیان و گزارش‌های مغازه دست نمی‌خورند
 *   W5   فروش مغازه پس از فروش سایت (ترتیب لات‌های خرید)
 *   W6   لغو سفارش سایت ⇐ جنس با همان بهای خرید به قفسه برمی‌گردد
 *   W7   برگشت جزئی سفارش سایت
 *   W8   رویداد تکراری سایت
 *   W9   سفارش کالای وصل‌نشده
 *   W10  قطع موقت، سفارش سایت در زمان قطع، وصل دوباره «مغازه + سفارش‌های سایت»
 *   W11  اختلاف هم‌زمان (ویرایش دستی سایت پیش از نوشتن برنامه)
 *   W12  سایت یا اینترنت قطع ⇐ فروش مغازه می‌ماند و بعداً فرستاده می‌شود
 *   W13  فروش هم‌زمان مغازه و سایت روی آخرین عددها (بیش‌فروش) و خرید بعدی
 *   W14  ورود جنس از پنل سایت (بی فاکتور خرید)
 *   W15  «سایت مرجع» با عدد کمتر از مغازه
 *   W15b خرابی اتصال (مدیریت موجودی در سایت خاموش شد) و حذف کالا در مغازه
 *   W17  انبارگردانی هم‌زمان با سفارش سایت
 *   W16  خاموش کردن اتصال سایت
 *   S0   پنل پیامکی: سرویس‌دهنده، تست اتصال
 *   S1   ارسال دستی، شمار بخش‌ها، دو کلیک
 *   S2   «تشکر از خرید» پس از فروش؛ عددهای فروش دست نمی‌خورند
 *   S3   پیامک انبوه: «لغو ۱۱»، متغیر داخل متن، لغو پس از صف
 *   S4   قالب‌های پیامک: کدام قالب واقعاً به کار می‌رود
 *   S5   خطاهای سرویس‌دهنده: اعتبار کم، ۵۰۳، ۵۰۰، مهلت
 *   S6   سرویس‌دهندهٔ «آزمایشی»
 *
 * «یافته»ها (ستون plan):
 *   منطق (باید همیشه صفر بماند): UNEXPECTED_REFUSAL، ACCEPTED_BUT_SHOULD_REFUSE، STOCK_LEDGER_MISMATCH (موجودی هر کالا =
 *   جمع دفتر گردش انبار)، LOT_LEDGER_MISMATCH (جمع مانده‌ی لات‌های خرید = موجودی)، SITE_IN_SHOP_NUMBERS (فروش/برگشت سایت
 *   فروش، سود، زیان، صندوق یا فاکتور مغازه را عوض کرد)، SITE_NOT_SYNCED (عدد سایت ≠ عدد مغازه پس از همگام‌سازی)،
 *   SALE_BLOCKED_BY_SITE (فروش مغازه به خاطر سایت رد شد)، SMS_CHANGED_SALE، SMS_DOUBLE_SEND
 *   پیشنهاد (هنوز ثبت نشده): ACCUMULATION_INCLUDES_SITE، REORDER_IGNORES_SITE، SITE_ALIGN_DECREASE_SILENT،
 *   SITE_ADMIN_STOCK_IN، STOCKTAKE_SITE_ORDER، PLACEHOLDER_LITERAL، TEMPLATE_UNUSED، TEST_PROVIDER_SENT_LABEL
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده، پوشهٔ موقت و دو سرور محلی؛ به برنامه، پایگاه واقعی،
 * سایت واقعی یا آزمون‌های مخزن دست نمی‌زند و در پوشهٔ docs است تا هیچ اجراکنندهٔ آزمونی آن را برندارد.
 *
 * اجرا از ریشهٔ مخزن:
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/woo-sms-scenarios.mjs
 *   ... --out <file.json>        نتیجهٔ فشرده (بی تاریخ، ساعت و شمارهٔ درگاه) برای مقایسه
 *   ... --compare docs/audit/woo-sms-scenarios-2026-11-26.json
 *                                مقایسه با نتیجهٔ ثبت‌شده؛ هر تفاوت چاپ می‌شود (خروج ۱)
 *   AUD_VERBOSE=1  ریز هر گام · AUD_SKIP_SLOW=1  بی سناریوی «مهلت» پیامک (۱۵ ثانیه)
 */
import { register } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import http from 'node:http'

const REPO = (process.env.AUD_REPO || fileURLToPath(new URL('../../', import.meta.url))).replace(/\/$/, '')
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const OUT = argOf('--out')
const COMPARE = argOf('--compare')
const VERBOSE = process.env.AUD_VERBOSE === '1'
const SKIP_SLOW = process.env.AUD_SKIP_SLOW === '1'
register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)
const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
const dir = mock.state.userData
mkdirSync(join(dir, 'data'), { recursive: true })
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'data', 'shop.db')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 777150, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)
const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { wooSyncService } = await imp('/src/main/services/WooSyncService.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await imp('/src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await imp('/src/shared/credit.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { CHEQUE_METHOD_KEY } = await imp('/src/shared/enums.ts')
const { toJalaliDate } = await imp('/src/shared/jalali.ts')
const { smsSegments } = await imp('/src/shared/sms.ts')
const { smsTemplateService } = await imp('/src/main/services/sms/SmsTemplates.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const db = harnessClient()
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
seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.setting('receipt.storeName', 'ارکاجین')
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const custA = seed.customer('خانم رضایی', '09121111111')
registerIpcHandlers()
/** همان کاری که `smsService.start()` هنگام بالا آمدن برنامه می‌کند (بی روشن کردن زمان‌بندها): ساخت قالب‌های پیش‌فرض. */
await smsTemplateService.ensureDefaults()
const ipcErrors = []
console.error = (...a) => ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
console.warn = (...a) => ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
console.info = () => {}
const invoke = async (ch, p) => { const fn = handlers.get(ch); if (!fn) throw new Error('no handler ' + ch); return fn({ sender }, p) }
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }
const msgOf = (s) => String(s ?? '').split('\n')[0].slice(0, 400)
const normStr = (s) => String(s ?? '')
  .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<درگاه>')
  .replace(/[0-9۰-۹]{4}\/[0-9۰-۹]{1,2}\/[0-9۰-۹]{1,2}/g, '<تاریخ>')
  .replace(/(^|[^0-9۰-۹])[0-9۰-۹]{1,2}:[0-9۰-۹]{2}(?![0-9۰-۹])/g, '$1<ساعت>')
  .replace(/mahak:\d+:[^\s"]+/g, 'mahak:<کلید>')
const PLAN = {
  ACCUMULATION_INCLUDES_SITE: 'پیشنهاد', REORDER_IGNORES_SITE: 'پیشنهاد', SITE_ALIGN_DECREASE_SILENT: 'پیشنهاد', SITE_ADMIN_STOCK_IN: 'پیشنهاد',
  PLACEHOLDER_LITERAL: 'پیشنهاد', TEMPLATE_UNUSED: 'پیشنهاد', TEST_PROVIDER_SENT_LABEL: 'پیشنهاد', STOCKTAKE_SITE_ORDER: 'پیشنهاد'
}
let keySeq = 0
const scenarios = []
let cur = null
function scenario(id, title) { cur = { id, title, steps: [], obs: [], findings: [] }; scenarios.push(cur); console.log(`\n== ${id} — ${title}`); return cur }
function obs(k, v) { cur.obs.push({ k, v }); if (VERBOSE) console.log(`   · ${k}: ${JSON.stringify(v)}`) }
function finding(type, text, data) {
  const plan = PLAN[type] ?? 'منطق'
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
const movSum = (vid) => n(seed.one('SELECT COALESCE(SUM(delta),0) s FROM "StockMovement" WHERE variantId=?', vid)?.s)
const lotSum = (vid) => n(seed.one('SELECT COALESCE(SUM(qtyLeft),0) s FROM "PurchaseLot" WHERE variantId=?', vid)?.s)
const countOf = (table, where = '1=1', ...p) => n(seed.one(`SELECT COUNT(*) c FROM "${table}" WHERE ${where}`, ...p)?.c)
const salePay = (amount) => [{ methodId: cashM, amount, destination: 'CASH' }]
const L = (vid, qty, unitPrice, name = null) => ({ variantId: vid, qty, unitPrice, discount: 0, tax: 0, ...(name ? { name } : {}) })
const posSale = (label, expect, lines, amount, extra = {}) =>
  call(label, expect, IPC.saleCreate, { lines, payments: salePay(amount), saleRequestIdempotencyKey: `ws-sale-${++keySeq}-xxxx`, ...extra })
const fa = (x) => Number(x).toLocaleString('en-US')

// ============================================================ سایت آزمایشی (همان قرارداد افزونهٔ mahak-stock/v1)
const SITE_TOKEN = 'site-token-0123456789-abcdef'
const site = (() => {
  const st = { seq: 0, journal: [], products: new Map(), applied: new Map(), down: false, requests: [] }
  const holderOf = (pid, vid) => (vid ? `v:${vid}` : `p:${pid}`)
  const add = (pid, vid, name, sku, stock, manage = 'yes') => st.products.set(holderOf(pid, vid), { pid, vid, name, sku, stock, manage })
  const item = (h) => {
    const p = st.products.get(h)
    return { holder_key: h, product_id: p.pid, variation_id: p.vid ?? null, sku: p.sku, name: p.name, type: p.vid ? 'variation' : 'simple',
      manage_stock: p.manage === 'yes', manage_stock_mode: p.manage, stock_quantity: p.manage === 'yes' ? p.stock : null,
      stock_status: p.stock > 0 ? 'instock' : 'outofstock', backorders: 'no', status: 'publish' }
  }
  const record = (h, oldQ, newQ, source, extra = {}) => {
    const p = st.products.get(h)
    st.seq++
    const row = { seq: st.seq, event_uuid: `site-ev-${st.seq}`, holder_key: h, product_id: p.pid, variation_id: p.vid ?? null, old_qty: oldQ, new_qty: newQ,
      delta: newQ - oldQ, source, order_id: extra.order_id ?? null, order_item_id: extra.order_item_id ?? null, request_id: extra.request_id ?? null,
      payload: extra.payload ?? null, created_at: '2026-01-01 00:00:00' }
    st.journal.push(row)
    return row
  }
  const ops = {
    stockOf: (h) => st.products.get(h)?.stock ?? null,
    order(h, qty, orderId, itemId) { const p = st.products.get(h); const o = p.stock; p.stock -= qty; return record(h, o, p.stock, 'order_reduce', { order_id: orderId, order_item_id: itemId, payload: { order_item_qty: qty } }) },
    restore(h, qty, orderId, itemId, source = 'order_restore') { const p = st.products.get(h); const o = p.stock; p.stock += qty; return record(h, o, p.stock, source, { order_id: orderId, order_item_id: itemId, payload: { order_item_qty: qty } }) },
    adminSet(h, qty) { const p = st.products.get(h); const o = p.stock; p.stock = qty; return record(h, o, qty, 'admin_edit') },
    manage(h, mode) { st.products.get(h).manage = mode },
    add,
    state: st
  }
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const route = url.pathname.replace(/^\/wp-json\/mahak-stock\/v1/, '')
      st.requests.push(`${req.method} ${route}`)
      if (st.down) { req.socket.destroy(); return }
      if (String(req.headers['x-mahak-token'] ?? '') !== SITE_TOKEN) return send(res, 403, { code: 'mahak_forbidden', message: 'MAHAK stock sync token is invalid.' })
      const body = raw ? JSON.parse(raw) : null
      if (route === '/ping') return send(res, 200, { ok: true, plugin: '1.1.0', site: 'https://shop.example', time: '2026-01-01T00:00:00Z' })
      if (route === '/catalog') return send(res, 200, { ok: true, items: [...st.products.keys()].map(item), page: 1, has_more: false })
      if (route === '/stock') {
        const items = []
        for (const h of body?.holders ?? []) {
          const key = h.holder_key ?? holderOf(h.product_id, h.variation_id)
          if (!st.products.has(key)) continue
          const last = st.journal.filter((r) => r.holder_key === key).reduce((m, r) => Math.max(m, r.seq), 0)
          items.push({ ...item(key), last_seq: last })
        }
        return send(res, 200, { ok: true, items })
      }
      if (route === '/stock/apply') {
        const key = body.holder_key ?? holderOf(body.product_id, body.variation_id)
        const p = st.products.get(key)
        if (!p) return send(res, 404, { code: 'mahak_not_found', message: 'Product/variation not found.' })
        if (p.manage !== 'yes') return send(res, 409, { code: 'mahak_manage_stock_off', message: 'manage_stock is disabled for this holder.' })
        const idem = `${body.request_id}|${key}`
        if (st.applied.has(idem)) {
          const prev = st.applied.get(idem)
          if (prev.expected !== body.expected || prev.target !== body.target) return send(res, 409, { code: 'mahak_request_mismatch', message: 'request_id reused with different payload' })
          return send(res, 200, { ...prev.response, idempotent: true })
        }
        if (p.stock !== body.expected) return send(res, 409, { ok: false, code: 'mahak_stock_conflict', conflict: true, current: p.stock, expected: body.expected, message: 'Stock changed on WooCommerce before MAHAK apply.' })
        const old = p.stock
        p.stock = body.target
        const row = record(key, old, body.target, 'mahak_apply', { request_id: body.request_id, payload: { expected: body.expected, target: body.target } })
        const response = { ok: true, old_qty: old, new_qty: body.target, holder_key: key, ...(old === body.target ? { noop: true } : { journal_seq: row.seq }) }
        st.applied.set(idem, { expected: body.expected, target: body.target, response })
        return send(res, 200, response)
      }
      if (route === '/journal') {
        const after = Number(url.searchParams.get('after_seq') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        return send(res, 200, { ok: true, events: st.journal.filter((r) => r.seq > after).slice(0, limit) })
      }
      return send(res, 404, { code: 'rest_no_route' })
    })
  })
  return { ...ops, server }
})()

// ============================================================ سرویس‌دهندهٔ پیامک آزمایشی (همان قرارداد sms.ir)
const smsSrv = (() => {
  const st = { mode: 'ok', received: [], hung: [] }
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname
      if (String(req.headers['x-api-key'] ?? '') !== 'SMS-TEST-KEY') return send(res, 401, { status: 0, message: 'کلید نامعتبر' })
      if (path === '/credit') return send(res, 200, { status: 1, message: 'موفق', data: 250000 })
      const body = raw ? JSON.parse(raw) : {}
      st.received.push({ path, mode: st.mode, text: body.messageText ?? null, mobiles: body.mobiles ?? (body.mobile ? [body.mobile] : []), templateId: body.templateId ?? null, parameters: body.parameters ?? null })
      if (st.mode === 'hang') { st.hung.push(res); return }
      if (st.mode === 'credit') return send(res, 200, { status: 102, message: 'اعتبار کافی نیست' })
      if (st.mode === 'http503') return send(res, 503, { status: 0, message: 'سرویس در دسترس نیست' })
      if (st.mode === 'http500') return send(res, 500, { status: 0, message: 'خطای داخلی' })
      return send(res, 200, { status: 1, message: 'موفق', data: { packId: 'pk-' + st.received.length, messageIds: [st.received.length], cost: 1 } })
    })
  })
  return { st, server }
})()
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)))
const sitePort = await listen(site.server)
const smsPort = await listen(smsSrv.server)
const SITE_URL = `http://127.0.0.1:${sitePort}`

// ============================================================ گزارش‌های مغازه در هر ایستگاه
async function shopReport() {
  const range = { fromJalali: today, toJalali: today }
  const sum = (await invoke(IPC.saleReportSummary, range)).data ?? {}
  const prof = (await invoke(IPC.mgmtProfit, range)).data ?? {}
  const pvs = (await invoke(IPC.mgmtPurchaseVsSale, range)).data ?? {}
  const stk = (await invoke(IPC.mgmtStock, {})).data ?? {}
  const row = (vid) => (stk.rows ?? []).find((r) => n(r.variantId) === vid) ?? {}
  return {
    sales: { count: n(sum.count), goods: n(sum.goodsTotal), grand: n(sum.grandTotal), cash: n(sum.cashTotal) },
    profit: { revenue: n(prof.revenue), fifoCost: n(prof.fifoCost), realProfit: n(prof.realProfit), lossCost: n(prof.losses?.cost), damageCost: n(prof.losses?.damageCost), profitAfterLoss: n(prof.profitAfterLoss) },
    stockValue: { qty: n(prof.stock?.qty), fifoValue: n(prof.stock?.fifoValue) },
    purchaseVsSale: { purchaseTotal: n(pvs.purchaseTotal), fifoSoldCost: n(pvs.fifoSoldCost), accumulation: n(pvs.accumulation) },
    insight: Object.fromEntries(Object.entries(V).map(([code, vid]) => [code, { stock: n(row(vid).stock), netSold30: n(row(vid).netSold30), reorder: (stk.reorder ?? []).some((r) => n(r.variantId) === vid) }])),
    rows: { invoices: countOf('SaleInvoice'), payments: countOf('Payment'), cashMovements: countOf('CashMovement') }
  }
}
const shopKey = (r) => JSON.stringify({ sales: r.sales, profit: r.profit, rows: r.rows })
let lastShop = null
async function checkpoint(label, { siteOnly = false } = {}) {
  const r = await shopReport()
  obs(`${label} · گزارش مغازه`, { sales: r.sales, profit: r.profit, stockValue: r.stockValue, purchaseVsSale: r.purchaseVsSale })
  if (siteOnly && lastShop && shopKey(lastShop) !== shopKey(r))
    finding('SITE_IN_SHOP_NUMBERS', `${label}: رویداد سایت عددهای مغازه را عوض کرد`, { before: JSON.parse(shopKey(lastShop)), after: JSON.parse(shopKey(r)) })
  for (const [code, vid] of Object.entries(V)) {
    const st = stockOf(vid), mv = movSum(vid), lots = lotSum(vid)
    if (st !== mv) finding('STOCK_LEDGER_MISMATCH', `${label}: ${code} موجودی ${st} ≠ دفتر گردش ${mv}`)
    if (st !== lots) finding('LOT_LEDGER_MISMATCH', `${label}: ${code} موجودی ${st} ≠ جمع لات‌های خرید ${lots}`)
  }
  lastShop = r
  return r
}
const links = () => seed.rows('SELECT id, variantId, holderKey, status, lastWooQty, lastMahakQty FROM "WooProductLink" ORDER BY id')
function checkSynced(label) {
  for (const l of links()) {
    if (l.status !== 'ACTIVE') continue
    const shop = stockOf(n(l.variantId)), web = site.stockOf(l.holderKey)
    if (web !== Math.max(0, shop)) finding('SITE_NOT_SYNCED', `${label}: ${l.holderKey} سایت ${web} ≠ مغازه ${shop}`)
  }
}
const sync = (label) => call(label, 'ok', IPC.wooSyncNow, {})
const lastMoves = (vid, k = 1) => seed.rows('SELECT reason, delta, refType FROM "StockMovement" WHERE variantId=? ORDER BY id DESC LIMIT ?', vid, k).reverse()
const consumptionOf = (vid) => seed.rows(`SELECT c.kind, c.qty, c.unitCost FROM "CostConsumption" c JOIN "StockMovement" m ON m.id = c.movementId WHERE m.variantId=? AND m.reason LIKE 'WOO_SYNC%' ORDER BY c.id`, vid)
  .map((r) => [r.kind, n(r.qty), n(r.unitCost)])

// ============================================================ W0 setup
scenario('W0', 'راه‌اندازی: نشست، کالاها، فاکتورهای خرید، سایت آزمایشی')
await call('open session (owner)', 'ok', IPC.shiftSessionOpen, { staffId: owner, handover: false, idempotencyKey: `ws-open-${++keySeq}xxxx` })
unlock(PANEL_KEYS.products, PANEL_KEYS.purchase, PANEL_KEYS.salesReports, PANEL_KEYS.managementReports, PANEL_KEYS.managementProfit, PANEL_KEYS.settings,
  PANEL_KEYS.wooSync, PANEL_KEYS.smsPanel, PANEL_KEYS.smsProvider, PANEL_KEYS.smsDanger, PANEL_KEYS.pos, PANEL_KEYS.stocktake)
const cat = n((await call('category «کفش و کیف»', 'ok', IPC.categoryUpsert, { name: 'کفش و کیف' })).data?.id)
await call('product «کفش اسپرت» size 40', 'ok', IPC.productUpsert, { name: 'کفش اسپرت', categoryId: cat, unit: 'جفت', note: null,
  variants: [{ code: 'K-40', barcode: '6260002000401', size: '40', color: 'سفید', salePrice: 18_000_000, purchasePrice: 10_000_000, stock: 0 }] })
await call('product «کیف دستی» (shop only)', 'ok', IPC.productUpsert, { name: 'کیف دستی', categoryId: cat, unit: 'عدد', note: null,
  variants: [{ code: 'B-1', barcode: '6260002000011', size: null, color: 'قهوه‌ای', salePrice: 7_000_000, purchasePrice: 4_000_000, stock: 0 }] })
await call('product «شال»', 'ok', IPC.productUpsert, { name: 'شال', categoryId: cat, unit: 'عدد', note: null,
  variants: [{ code: 'S-1', barcode: '6260002000101', size: null, color: 'طوسی', salePrice: 3_500_000, purchasePrice: 2_000_000, stock: 0 }] })
const V = Object.fromEntries(seed.rows('SELECT id, code FROM "ProductVariant" ORDER BY id').map((r) => [r.code, n(r.id)]))
await call('purchase 1: K-40×6@10,000,000, B-1×5@4,000,000, S-1×3@2,000,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH',
  paidTotal: 86_000_000, lines: [{ variantId: V['K-40'], qty: 6, unitPrice: 10_000_000 }, { variantId: V['B-1'], qty: 5, unitPrice: 4_000_000 }, { variantId: V['S-1'], qty: 3, unitPrice: 2_000_000 }] })
await call('purchase 2 (newer, pricier): K-40×4@12,000,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH',
  paidTotal: 48_000_000, lines: [{ variantId: V['K-40'], qty: 4, unitPrice: 12_000_000 }] })
obs('shop stock', { K40: stockOf(V['K-40']), B1: stockOf(V['B-1']), S1: stockOf(V['S-1']) })
site.add(101, null, 'Sport shoe 40', 'K-40', 3)
site.add(300, 301, 'Shawl grey', 'S-1', 5)
site.add(999, null, 'Hat (not linked)', 'H-1', 7)
site.add(500, null, 'Belt (stock not managed)', 'BL-1', 0, 'no')
await checkpoint('W0 پایان')

// ============================================================ W1 settings
scenario('W1', 'تنظیم اتصال سایت: نشانی امن، کلید، تست، کاتالوگ')
await call('save site settings with http://example.com (not secure)', 'refuse', IPC.wooSettingsSave, { siteUrl: 'http://example.com', token: SITE_TOKEN, enabled: true, autoSync: false, intervalSeconds: 120 })
await call('save site settings (local test site) + key, enabled, auto off', 'ok', IPC.wooSettingsSave, { siteUrl: SITE_URL, token: SITE_TOKEN, enabled: true, autoSync: false, intervalSeconds: 120 })
const tc = await call('test connection', 'ok', IPC.wooTest, {})
obs('test', tc.data)
const cg = await call('read catalog', 'ok', IPC.wooCatalog, {})
obs('catalog', (cg.data?.items ?? []).map((i) => [i.holderKey, i.name, i.manageStock, i.stockQuantity]))

// ============================================================ W2 links
scenario('W2', 'اتصال کالاها: «فروشگاه مرجع» و «سایت مرجع»')
const linkK = { variantId: V['K-40'], productId: 101, variationId: null, sku: 'K-40', remoteName: 'Sport shoe 40', manageStock: true, wooQty: 3, decision: 'MAHAK_WINS' }
await call('link K-40 ↔ site shoe, shop is the reference, no password', 'refuse', IPC.wooLinkCreate, linkK)
await call('link K-40 ↔ site shoe, shop is the reference (10 → site)', 'ok', IPC.wooLinkCreate, { ...linkK, managerPassword: PW })
await sync('sync now')
obs('site shoe after link', site.stockOf('p:101'))
await call('link B-1 to the same site shoe (already linked)', 'refuse', IPC.wooLinkCreate, { ...linkK, variantId: V['B-1'], managerPassword: PW })
await call('link B-1 to the belt (site stock not managed)', 'refuse', IPC.wooLinkCreate, { variantId: V['B-1'], productId: 500, variationId: null, sku: 'BL-1', remoteName: 'Belt', manageStock: false, wooQty: null, decision: 'MAHAK_WINS', managerPassword: PW })
const s1Before = stockOf(V['S-1'])
await call('link S-1 ↔ site shawl, site is the reference (site 5, shop 3)', 'ok', IPC.wooLinkCreate, { variantId: V['S-1'], productId: 300, variationId: 301, sku: 'S-1', remoteName: 'Shawl grey', manageStock: true, wooQty: 5, decision: 'WOO_WINS', managerPassword: PW })
obs('S-1 shop stock after «site is the reference»', [s1Before, stockOf(V['S-1'])])
obs('S-1 movement', lastMoves(V['S-1']))
await sync('sync now')
checkSynced('W2')
obs('links', links().map((l) => [l.holderKey, l.status, n(l.lastWooQty), n(l.lastMahakQty)]))
const r2 = await checkpoint('W2 پایان')
obs('S-1 site alignment (+2) cost lots', seed.rows('SELECT qtyIn, qtyLeft, unitCost, source FROM "PurchaseLot" WHERE variantId=? ORDER BY id', V['S-1']).map((r) => [n(r.qtyIn), n(r.qtyLeft), n(r.unitCost), r.source]))

// ============================================================ W3 shop sale
scenario('W3', 'فروش مغازه ⇐ موجودی سایت کم می‌شود')
const sale1 = await posSale('POS sale K-40×2 @18,000,000 cash', 'ok', [L(V['K-40'], 2, 18_000_000, 'کفش اسپرت')], 36_000_000)
obs('outbox after the sale', seed.rows('SELECT kind, status, expectedWooQty, targetQty FROM "WooSyncOutbox" ORDER BY id DESC LIMIT 1').map((r) => [r.kind, r.status, n(r.expectedWooQty), n(r.targetQty)]))
await sync('sync now')
obs('site shoe / shop', [site.stockOf('p:101'), stockOf(V['K-40'])])
checkSynced('W3')
const r3 = await checkpoint('W3 پایان')

// ============================================================ W4 site sale
scenario('W4', 'فروش سایت ⇐ موجودی مغازه کم می‌شود؛ عددهای مغازه دست نمی‌خورند')
site.order('p:101', 3, '5001', '9001')
await sync('sync now (site order #5001: shoe ×3)')
obs('shop K-40 stock', stockOf(V['K-40']))
obs('K-40 last movement', lastMoves(V['K-40']))
const r4 = await checkpoint('W4 پایان', { siteOnly: true })
obs('site movement cost rows (kind, qty, unit cost)', consumptionOf(V['K-40']))
obs('stock value change by the site order', r4.stockValue.fifoValue - r3.stockValue.fifoValue)
obs('«انباشت در کالا» change by the site order', r4.purchaseVsSale.accumulation - r3.purchaseVsSale.accumulation)
if (r4.purchaseVsSale.accumulation === r3.purchaseVsSale.accumulation && r4.stockValue.fifoValue < r3.stockValue.fifoValue)
  finding('ACCUMULATION_INCLUDES_SITE', `کارت «انباشت در کالا» (خرید منهای بهای فروخته‌شدهٔ مغازه) پس از فروش ۳ جفت در سایت همان ${fa(r4.purchaseVsSale.accumulation)} ماند، در حالی که ارزش موجودی ${fa(r3.stockValue.fifoValue - r4.stockValue.fifoValue)} ریال کم شد؛ یعنی جنسِ رفته به سایت هنوز «سرمایهٔ خوابیده در کالا» شمرده می‌شود`)
obs('K-40 «فروش ۳۰ روز» in the stock report (shop only)', r4.insight['K-40'])
checkSynced('W4')

// ============================================================ W5 shop sale after the site sale
scenario('W5', 'فروش مغازه پس از فروش سایت (ترتیب لات‌های خرید)')
const sale2 = await posSale('POS sale K-40×2 @18,000,000 cash', 'ok', [L(V['K-40'], 2, 18_000_000, 'کفش اسپرت')], 36_000_000)
await sync('sync now')
const r5 = await checkpoint('W5 پایان')
obs('cost of this shop sale (FIFO)', r5.profit.fifoCost - r4.profit.fifoCost)
obs('profit of this shop sale', r5.profit.realProfit - r4.profit.realProfit)
checkSynced('W5')

// ============================================================ W6 site order canceled
scenario('W6', 'لغو سفارش سایت ⇐ جنس با همان بهای خرید به قفسه برمی‌گردد')
site.restore('p:101', 3, '5001', '9001', 'order_restore')
await sync('sync now (order #5001 canceled: +3)')
obs('shop K-40 stock', stockOf(V['K-40']))
obs('K-40 last movement', lastMoves(V['K-40']))
const r6 = await checkpoint('W6 پایان', { siteOnly: true })
obs('site movement cost rows (kind, qty, unit cost)', consumptionOf(V['K-40']))
obs('stock value change by the cancel', r6.stockValue.fifoValue - r5.stockValue.fifoValue)
checkSynced('W6')

// ============================================================ W7 partial refund
scenario('W7', 'برگشت جزئی سفارش سایت')
site.order('p:101', 2, '5002', '9002')
await sync('sync now (order #5002: shoe ×2)')
site.restore('p:101', 1, '5002', '9002', 'refund_restock')
await sync('sync now (order #5002 refund ×1)')
obs('shop K-40 stock', stockOf(V['K-40']))
obs('K-40 last 2 movements', lastMoves(V['K-40'], 2))
await checkpoint('W7 پایان', { siteOnly: true })
checkSynced('W7')

// ============================================================ W8 duplicate event
scenario('W8', 'رویداد تکراری سایت')
const evBefore = countOf('WooInboundEvent'), stBefore = stockOf(V['K-40'])
await sync('sync now again (the program re-reads the last 50 events)')
site.state.journal.push({ ...site.state.journal.find((r) => r.order_id === '5002' && r.delta < 0), seq: ++site.state.seq })
await sync('sync now (the site sends order #5002 again with the same event id)')
obs('events / K-40 stock before → after', [[evBefore, stBefore], [countOf('WooInboundEvent'), stockOf(V['K-40'])]])
if (stockOf(V['K-40']) !== stBefore) finding('STOCK_LEDGER_MISMATCH', 'رویداد تکراری سایت دوباره از موجودی مغازه کم شد')
await checkpoint('W8 پایان', { siteOnly: true })

// ============================================================ W9 unlinked product
scenario('W9', 'سفارش کالای وصل‌نشده')
site.order('p:999', 2, '5003', '9003')
await sync('sync now (order on an unlinked site product)')
obs('event status', seed.rows(`SELECT status FROM "WooInboundEvent" WHERE holderKey='p:999'`).map((r) => r.status))
await checkpoint('W9 پایان', { siteOnly: true })

// ============================================================ W10 pause / resume
scenario('W10', 'قطع موقت، سفارش سایت در زمان قطع، وصل دوباره «مغازه + سفارش‌های سایت»')
const linkKId = n(links().find((l) => l.holderKey === 'p:101')?.id)
await call('pause the shoe link', 'ok', IPC.wooLinksPause, { linkIds: [linkKId], note: 'آزمون' })
site.order('p:101', 1, '5004', '9004')
await sync('sync now (site order #5004 during the pause)')
obs('event status / shop stock', [seed.rows(`SELECT status FROM "WooInboundEvent" WHERE orderId='5004'`).map((r) => r.status), stockOf(V['K-40'])])
const outboxBefore = countOf('WooSyncOutbox')
const s3 = await posSale('POS sale K-40×1 during the pause', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
if (!s3.ok) finding('SALE_BLOCKED_BY_SITE', 'فروش مغازه در زمان قطع موقت سایت رد شد')
obs('new outbox rows during the pause', countOf('WooSyncOutbox') - outboxBefore)
const pv = await call('resume preview', 'ok', IPC.wooLinksResumePreview, { linkId: linkKId })
obs('preview', pv.data ? { mahakStock: pv.data.mahakStock, wooQty: pv.data.wooQty, orderEvents: pv.data.orderEvents, orderDelta: pv.data.orderDelta } : null)
const resumeP = (decision, extra = {}) => ({ linkId: linkKId, decision, expectedMahakStock: pv.data?.mahakStock, expectedWooQty: pv.data?.wooQty, expectedLastSeq: pv.data?.lastSeq ?? null,
  expectedPausedEventCount: (pv.data?.pausedEvents ?? []).length, expectedPausedEventHash: pv.data?.heldEventHash ?? '', ...extra })
await call('resume «shop is the reference» while a real site order is held', 'refuse', IPC.wooLinksResumeApply, resumeP('MAHAK_WINS', { managerPassword: PW }))
await call('resume «shop + site orders» without password', 'refuse', IPC.wooLinksResumeApply, resumeP('MAHAK_PLUS_ORDERS'))
await call('resume «shop + site orders»', 'ok', IPC.wooLinksResumeApply, resumeP('MAHAK_PLUS_ORDERS', { managerPassword: PW }))
await sync('sync now')
obs('shop / site after resume', [stockOf(V['K-40']), site.stockOf('p:101')])
await checkpoint('W10 پایان')
checkSynced('W10')

// ============================================================ W11 conflict
scenario('W11', 'اختلاف هم‌زمان: ویرایش دستی سایت درست پیش از نوشتن برنامه')
await posSale('POS sale K-40×1', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
site.adminSet('p:101', site.stockOf('p:101') + 2)
const pushed = await wooSyncService.processOutbox(50)
obs('push result', pushed)
obs('link / approvals', [links().find((l) => l.holderKey === 'p:101')?.status, seed.rows(`SELECT action, reason FROM "WooApproval" WHERE status='PENDING'`).map((r) => [r.action, r.reason])])
const s4 = await posSale('POS sale K-40×1 while the link is in conflict', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
if (!s4.ok) finding('SALE_BLOCKED_BY_SITE', 'فروش مغازه در زمان اختلاف سایت رد شد')
const pv2 = await call('conflict: preview', 'ok', IPC.wooLinksResumePreview, { linkId: linkKId })
obs('conflict preview', pv2.data ? { mahakStock: pv2.data.mahakStock, wooQty: pv2.data.wooQty, orderEvents: pv2.data.orderEvents, nonOrderEvents: pv2.data.nonOrderEvents, nonOrderDelta: pv2.data.nonOrderDelta } : null)
await call('conflict: «shop is the reference» (site admin edit dropped)', 'ok', IPC.wooLinksResumeApply, { linkId: linkKId, decision: 'MAHAK_WINS', managerPassword: PW,
  expectedMahakStock: pv2.data?.mahakStock, expectedWooQty: pv2.data?.wooQty, expectedLastSeq: pv2.data?.lastSeq ?? null, expectedPausedEventCount: (pv2.data?.pausedEvents ?? []).length, expectedPausedEventHash: pv2.data?.heldEventHash ?? '' })
await sync('sync now')
obs('shop / site / pending approvals', [stockOf(V['K-40']), site.stockOf('p:101'), countOf('WooApproval', `status='PENDING'`)])
await checkpoint('W11 پایان')
checkSynced('W11')

// ============================================================ W12 site down
scenario('W12', 'سایت یا اینترنت قطع ⇐ فروش مغازه می‌ماند و بعداً فرستاده می‌شود')
site.state.down = true
const s5 = await posSale('POS sale K-40×1 while the site is unreachable', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
if (!s5.ok) finding('SALE_BLOCKED_BY_SITE', 'فروش مغازه وقتی سایت در دسترس نبود رد شد')
const down = await call('sync now (site down)', 'ok', IPC.wooSyncNow, {})
obs('sync errors (phases)', (down.data?.errors ?? []).map((e) => e.phase))
obs('outbox status', seed.rows('SELECT status, attemptCount FROM "WooSyncOutbox" ORDER BY id DESC LIMIT 1').map((r) => [r.status, n(r.attemptCount)]))
site.state.down = false
await sync('sync now (site back)')
obs('shop / site', [stockOf(V['K-40']), site.stockOf('p:101')])
await checkpoint('W12 پایان')
checkSynced('W12')

// ============================================================ W13 race / oversell
scenario('W13', 'فروش هم‌زمان مغازه و سایت روی آخرین عددها (بیش‌فروش) و خرید بعدی')
await call('purchase 3: K-40×3@12,500,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH', paidTotal: 37_500_000, lines: [{ variantId: V['K-40'], qty: 3, unitPrice: 12_500_000 }] })
await sync('sync now')
obs('shop / site before the race', [stockOf(V['K-40']), site.stockOf('p:101')])
await posSale('POS sale K-40×1 (its push to the site has not gone yet)', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
site.order('p:101', site.stockOf('p:101'), '5005', '9005')
await sync('sync now (meanwhile the site sold all 3 pairs it was showing)')
obs('shop / site', [stockOf(V['K-40']), site.stockOf('p:101')])
const r13 = await checkpoint('W13 بیش‌فروش')
obs('cost lots of K-40 (qtyIn, qtyLeft, unitCost, source)', seed.rows('SELECT qtyIn, qtyLeft, unitCost, source FROM "PurchaseLot" WHERE variantId=? ORDER BY id', V['K-40']).map((r) => [n(r.qtyIn), n(r.qtyLeft), n(r.unitCost), r.source]))
obs('cost status of the last shop sale (EXACT = real purchase cost)', seed.rows('SELECT costStatus, fifoCost FROM "SaleItemCost" ORDER BY saleItemId DESC LIMIT 1').map((r) => [r.costStatus, n(r.fifoCost)]))
obs('K-40 negative stock is visible in the stock report', r13.insight['K-40'])
await call('purchase 4: K-40×2@13,000,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH', paidTotal: 26_000_000, lines: [{ variantId: V['K-40'], qty: 2, unitPrice: 13_000_000 }] })
await sync('sync now')
obs('shop / site after the purchase', [stockOf(V['K-40']), site.stockOf('p:101')])
await checkpoint('W13 پایان')
checkSynced('W13')

// ============================================================ W14 stock added on the site admin
scenario('W14', 'ورود جنس از پنل سایت (بی فاکتور خرید)')
const pre14 = lastShop
site.adminSet('v:301', site.stockOf('v:301') + 4)
await sync('sync now (site admin adds 4 shawls)')
obs('S-1 shop stock / last movement', [stockOf(V['S-1']), lastMoves(V['S-1'])])
const r14 = await checkpoint('W14 پایان', { siteOnly: true })
obs('stock value change / purchases change', [r14.stockValue.fifoValue - pre14.stockValue.fifoValue, r14.purchaseVsSale.purchaseTotal - pre14.purchaseVsSale.purchaseTotal])
if (r14.stockValue.fifoValue > pre14.stockValue.fifoValue && r14.purchaseVsSale.purchaseTotal === pre14.purchaseVsSale.purchaseTotal)
  finding('SITE_ADMIN_STOCK_IN', `۴ شالی که در پنل سایت اضافه شد، بی فاکتور خرید با بهای آخرین خرید (${fa(r14.stockValue.fifoValue - pre14.stockValue.fifoValue)} ریال) به ارزش موجودی مغازه اضافه شد؛ جنس تازه باید از فاکتور خرید مغازه وارد شود`)
const s1Insight = r14.insight['S-1']
obs('S-1 in the stock report (sold only on the site)', s1Insight)
checkSynced('W14')

// ============================================================ W15 «site is the reference» with fewer units
scenario('W15', '«سایت مرجع» با عدد کمتر از مغازه')
const pre15 = lastShop
await call('unlink the shawl', 'ok', IPC.wooLinksUnlink, { linkId: n(links().find((l) => l.holderKey === 'v:301')?.id), managerPassword: PW })
site.adminSet('v:301', 2)
const s1Shop = stockOf(V['S-1'])
await call(`relink S-1, site is the reference (site 2, shop ${s1Shop})`, 'ok', IPC.wooLinkCreate, { variantId: V['S-1'], productId: 300, variationId: 301, sku: 'S-1', remoteName: 'Shawl grey', manageStock: true, wooQty: 2, decision: 'WOO_WINS', managerPassword: PW })
obs('S-1 shop stock / movement', [stockOf(V['S-1']), lastMoves(V['S-1'])])
const r15 = await checkpoint('W15 پایان', { siteOnly: true })
obs('loss card / stock value change', [r15.profit.lossCost - pre15.profit.lossCost, r15.stockValue.fifoValue - pre15.stockValue.fifoValue])
if (r15.profit.lossCost === pre15.profit.lossCost && r15.stockValue.fifoValue < pre15.stockValue.fifoValue)
  finding('SITE_ALIGN_DECREASE_SILENT', `«سایت مرجع» ${s1Shop - stockOf(V['S-1'])} شال را از موجودی مغازه کم کرد (${fa(pre15.stockValue.fifoValue - r15.stockValue.fifoValue)} ریال)؛ نه کسری مغازه شمرده شد و نه پیش از تأیید گفته می‌شود که این تعداد از مغازه کم می‌شود`)
await sync('sync now')
checkSynced('W15')

// ============================================================ W15b broken site link, product deleted in the shop
scenario('W15b', 'خرابی اتصال: مدیریت موجودی در سایت خاموش شد؛ حذف کالا در مغازه')
site.order('v:301', 2, '5007', '9007')
await sync('sync now (site order #5007: shawl ×2 — the shawl sells only on the site)')
site.manage('p:101', 'no')
const s6 = await posSale('POS sale K-40×1 after the site turned off stock management for the shoe', 'ok', [L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 18_000_000)
if (!s6.ok) finding('SALE_BLOCKED_BY_SITE', 'فروش مغازه پس از خرابی اتصال سایت رد شد')
await sync('sync now')
obs('shoe link status', links().find((l) => l.holderKey === 'p:101')?.status)
site.manage('p:101', 'yes')
const pv3 = await call('broken link: preview after the site is fixed', 'ok', IPC.wooLinksResumePreview, { linkId: linkKId })
await call('broken link: «shop is the reference»', 'ok', IPC.wooLinksResumeApply, { linkId: linkKId, decision: 'MAHAK_WINS', managerPassword: PW,
  expectedMahakStock: pv3.data?.mahakStock, expectedWooQty: pv3.data?.wooQty, expectedLastSeq: pv3.data?.lastSeq ?? null, expectedPausedEventCount: (pv3.data?.pausedEvents ?? []).length, expectedPausedEventHash: pv3.data?.heldEventHash ?? '' })
await sync('sync now')
obs('shop / site / link', [stockOf(V['K-40']), site.stockOf('p:101'), links().find((l) => l.holderKey === 'p:101')?.status])
checkSynced('W15b')
await call('product «کلاه» (H-1)', 'ok', IPC.productUpsert, { name: 'کلاه', categoryId: cat, unit: 'عدد', note: null,
  variants: [{ code: 'H-1', barcode: '6260002000201', size: null, color: 'مشکی', salePrice: 1_500_000, purchasePrice: 800_000, stock: 0 }] })
V['H-1'] = n(seed.one(`SELECT id FROM "ProductVariant" WHERE code='H-1'`)?.id)
await call('purchase 5: H-1×2@800,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH', paidTotal: 1_600_000, lines: [{ variantId: V['H-1'], qty: 2, unitPrice: 800_000 }] })
await call('link H-1 ↔ site hat, shop is the reference', 'ok', IPC.wooLinkCreate, { variantId: V['H-1'], productId: 999, variationId: null, sku: 'H-1', remoteName: 'Hat', manageStock: true, wooQty: site.stockOf('p:999'), decision: 'MAHAK_WINS', managerPassword: PW })
await sync('sync now')
obs('hat: shop / site', [stockOf(V['H-1']), site.stockOf('p:999')])
const del = await call('delete product «کلاه» in the shop (to the trash)', 'either', IPC.productDelete, { variantIds: [V['H-1']] })
obs('delete result', del.ok ? 'ok' : msgOf(del.error))
await sync('sync now')
obs('hat: link status / site stock after the delete', [links().find((l) => l.holderKey === 'p:999')?.status, site.stockOf('p:999')])
await checkpoint('W15b پایان')

// ============================================================ W17 stocktake while a site order arrives
scenario('W17', 'انبارگردانی هم‌زمان با سفارش سایت')
await call('purchase 6: K-40×3@13,000,000', 'ok', IPC.purchaseCreate, { panelPassword: PW, supplierName: 'پخش نمونه', settlementType: 'CASH', paidTotal: 39_000_000, lines: [{ variantId: V['K-40'], qty: 3, unitPrice: 13_000_000 }] })
await sync('sync now')
const sysK = stockOf(V['K-40'])
obs('K-40 on the shelf when counting starts', sysK)
site.order('p:101', 1, '5008', '9008')
await sync('sync now (site order #5008 arrives while the clerk is counting; the pair is still on the shelf)')
const sc = await call(`submit count: K-40 = ${sysK} (what is on the shelf)`, 'ok', IPC.stockCountSubmit, { items: [{ variantId: V['K-40'], countedQty: sysK }], note: 'انبارگردانی هم‌زمان با سفارش سایت' })
const scId = n(sc.data?.id ?? sc.data?.sessionId)
const sg = scId ? await call('count detail', 'ok', IPC.stockCountGet, { id: scId }) : null
const scItem = (sg?.data?.items ?? []).find((i) => n(i.variantId) === V['K-40'])
obs('count: system / counted / difference', scItem ? [n(scItem.systemQty), n(scItem.countedQty), n(scItem.diffQty)] : sc.data)
if (scItem && n(scItem.diffQty) > 0) finding('STOCKTAKE_SITE_ORDER', `سفارش سایتی که وسط شمارش رسید و جنسش هنوز روی قفسه بود، در انبارگردانی «${n(scItem.diffQty)} عدد مازاد» نشان داده شد؛ صفحهٔ شمارش نمی‌گوید که در همین فاصله سایت از این کالا فروخته است`)
await checkpoint('W17 پایان', { siteOnly: true })

// ============================================================ W16 disable
scenario('W16', 'خاموش کردن اتصال سایت')
await call('turn the site connection off', 'ok', IPC.wooSettingsSave, { enabled: false })
const ob16 = countOf('WooSyncOutbox')
await posSale('POS sale B-1×1 and K-40×1 with the site off', 'ok', [L(V['B-1'], 1, 7_000_000, 'کیف دستی'), L(V['K-40'], 1, 18_000_000, 'کفش اسپرت')], 25_000_000)
obs('new outbox rows with the site off', countOf('WooSyncOutbox') - ob16)
const off = await call('sync now (off)', 'ok', IPC.wooSyncNow, {})
obs('sync result when off', { pulled: off.data?.pulled, pushed: off.data?.pushed })
await checkpoint('W16 پایان')
{
  // پیشنهاد سفارش و «فروش ۳۰ روز»: کالایی که در سایت فروش رفته
  const soldOnSite = seed.rows(`SELECT m.variantId vid, -SUM(m.delta) q FROM "StockMovement" m WHERE m.reason='WOO_SYNC_OUT' GROUP BY m.variantId`)
  for (const r of soldOnSite) {
    const code = Object.keys(V).find((k) => V[k] === n(r.vid))
    obs(`${code}: sold on the site (gross) / «فروش ۳۰ روز» of the stock report / in «پیشنهاد سفارش» / shop stock`, [n(r.q), lastShop.insight[code]?.netSold30, lastShop.insight[code]?.reorder, stockOf(n(r.vid))])
  }
  const s1 = lastShop.insight['S-1']
  const s1Site = n(soldOnSite.find((r) => n(r.vid) === V['S-1'])?.q)
  if (s1Site > 0 && s1.netSold30 === 0 && !s1.reorder)
    finding('REORDER_IGNORES_SITE', `گزارش «مانده و کم‌فروش» فقط فروش مغازه را می‌شمارد: شال با ${s1Site} عدد فروش سایت و ${stockOf(V['S-1'])} عدد مانده، «فروش ۳۰ روز» را صفر نشان می‌دهد و هرگز به «پیشنهاد سفارش» نمی‌آید (از روی کد: اگر ۲ عدد یا بیشتر مانده باشد، پس از ۹۰ روز برچسب «بدون فروش — حراج» هم می‌گیرد)`)
}

// ============================================================ S0 SMS provider
scenario('S0', 'پنل پیامکی: سرویس‌دهنده و تست اتصال')
const SMS_BASE = `http://127.0.0.1:${smsPort}`
const provIn = { name: 'خط آزمایشی sms.ir', providerKey: 'SMS_IR', baseUrl: SMS_BASE, senderNumber: '30005006', purpose: 'BOTH', secrets: { apiKey: 'SMS-TEST-KEY' }, isActive: true }
await call('save sms.ir line with API key, no password', 'refuse', IPC.smsProviderSave, provIn)
const pv0 = await call('save sms.ir line with API key + password (active)', 'ok', IPC.smsProviderSave, { ...provIn, managerPassword: PW })
const provId = n(pv0.data?.id)
const pt = await call('provider test', 'ok', IPC.smsProviderTest, { id: provId })
obs('provider test', pt.data)
const runQ = async (label) => { const r = await call(label, 'ok', IPC.smsRunNow, {}); return r.data }
const outbox = (where = '1=1', ...p) => seed.rows(`SELECT id, eventType, status, attemptCount, segments, bodySnapshot, lastErrorCode FROM "SmsOutbox" WHERE ${where} ORDER BY id`, ...p)

// ============================================================ S1 manual send
scenario('S1', 'ارسال دستی، شمار بخش‌ها، دو کلیک')
const t69 = 'سفارش شما آماده است؛ لطفاً تا پایان هفته تحویل بگیرید. ارکاجین'
const t71 = t69 + ' — با سپاس'
obs('characters / parts', [[t69.length, smsSegments(t69)], [t71.length, smsSegments(t71)]])
await call(`manual send (${t69.length} characters)`, 'ok', IPC.smsSendManual, { phone: '09121111111', body: t69 })
const dup = await call('manual send the same text again (double click)', 'ok', IPC.smsSendManual, { phone: '09121111111', body: t69 })
obs('double click → duplicate', dup.data?.duplicate === true)
await call(`manual send (${t71.length} characters)`, 'ok', IPC.smsSendManual, { phone: '۰۹۱۲ ۲۲۲ ۲۲۲۲', body: t71 })
const q1 = await runQ('run queue')
obs('queue run', { sent: q1?.sent, failed: q1?.failed, blocked: q1?.blocked })
obs('provider received', smsSrv.st.received.map((r) => [r.path, r.mobiles, r.text === t69 ? 't69' : r.text === t71 ? 't71' : r.text]))
if (smsSrv.st.received.filter((r) => r.text === t69).length > 1) finding('SMS_DOUBLE_SEND', 'یک پیام دستی دو بار به سرویس‌دهنده رفت')
obs('outbox', outbox().map((r) => [r.eventType, r.status, n(r.segments)]))

// ============================================================ S2 thank-you
scenario('S2', '«تشکر از خرید» پس از فروش؛ عددهای فروش دست نمی‌خورند')
await call('turn «thank you» on', 'ok', IPC.smsSettingsSet, { thankYou: true })
const preS2 = await shopReport()
const ty = await posSale('POS sale B-1×1 @7,000,000 for خانم رضایی (has a phone)', 'ok', [L(V['B-1'], 1, 7_000_000, 'کیف دستی')], 7_000_000, { customerId: custA })
let tyRow = null
for (let i = 0; i < 40 && !tyRow; i++) { await new Promise((r) => setTimeout(r, 50)); tyRow = outbox(`relatedEntity='SaleInvoice' AND relatedEntityId=?`, n(ty.data?.id))[0] ?? null }
obs('thank-you queued', tyRow ? [tyRow.eventType, tyRow.status, tyRow.bodySnapshot] : null)
await runQ('run queue')
obs('thank-you status', outbox(`relatedEntity='SaleInvoice'`).map((r) => [r.status]))
const postS2 = await shopReport()
const dSales = postS2.sales.grand - preS2.sales.grand, dRev = postS2.profit.revenue - preS2.profit.revenue
obs('sale effect (grand / revenue)', [dSales, dRev])
if (dSales !== 7_000_000 || dRev !== 7_000_000) finding('SMS_CHANGED_SALE', `پیامک تشکر عدد فروش را عوض کرد (${dSales} / ${dRev})`)
await call('turn «thank you» off', 'ok', IPC.smsSettingsSet, { thankYou: false })
lastShop = postS2

// ============================================================ S3 campaign
scenario('S3', 'پیامک انبوه: «لغو ۱۱»، متغیر داخل متن، لغو پس از صف')
await call('opt-out 09123333333', 'ok', IPC.smsOptOutAdd, { phone: '09123333333', note: 'لغو ۱۱' })
const campBody = '{customer_name} عزیز، حراج پاییزه از فردا شروع می‌شود.'
const cpv = await call('campaign preview (3 numbers, one opted out, text with {customer_name})', 'ok', IPC.smsCampaignPreview, { body: campBody, phones: '09124444444, 09123333333, 09125555555' })
obs('preview', cpv.data ? { sendable: cpv.data.sendable, optOutSkipped: cpv.data.optOutSkipped, finalBody: cpv.data.finalBody, segments: cpv.data.segments } : null)
const cc = await call('create campaign', 'ok', IPC.smsCampaignCreate, { name: 'حراج پاییزه', body: campBody, phones: '09124444444, 09123333333, 09125555555' })
obs('campaign', cc.data ? { queued: cc.data.queued, failed: cc.data.failed } : null)
await call('opt-out 09125555555 after the campaign was queued', 'ok', IPC.smsOptOutAdd, { phone: '09125555555', note: 'لغو ۱۱' })
const rcv0 = smsSrv.st.received.length
await runQ('run queue')
const campRcv = smsSrv.st.received.slice(rcv0)
obs('provider received (campaign)', campRcv.map((r) => [r.mobiles, r.text]))
obs('campaign rows', outbox(`eventType='CAMPAIGN'`).map((r) => [r.status, r.lastErrorCode]))
if (campRcv.some((r) => /\{customer_name\}/.test(String(r.text))))
  finding('PLACEHOLDER_LITERAL', 'پیامک انبوه با «{customer_name}» در متن پذیرفته شد و همان «{customer_name}» عیناً برای مشتری رفت (نام جای‌گذاری نمی‌شود و خطا هم نمی‌دهد)')
const mm = await call('manual send with {store_name} in the text', 'ok', IPC.smsSendManual, { phone: '09126666666', body: 'از خرید شما در {store_name} ممنونیم.' })
const rcv1 = smsSrv.st.received.length
await runQ('run queue')
const manRcv = smsSrv.st.received.slice(rcv1)
obs('provider received (manual with {store_name})', manRcv.map((r) => r.text))
if (mm.ok && manRcv.some((r) => /\{store_name\}/.test(String(r.text))))
  finding('PLACEHOLDER_LITERAL', 'ارسال دستی با «{store_name}» در متن پذیرفته شد و «{store_name}» عیناً رفت')

// ============================================================ S4 templates
scenario('S4', 'قالب‌های پیامک: کدام قالب واقعاً به کار می‌رود')
const tl = await call('templates list', 'ok', IPC.smsTemplates, {})
obs('templates', (tl.data ?? []).map((t) => [t.code, t.title]))
const te = await call('edit the «پیامک تبلیغاتی (انبوه)» template', 'ok', IPC.smsTemplateSave, { code: 'CAMPAIGN', body: 'مشتری گرامی، {campaign_text} — {store_name} · {opt_out_note}' })
const cpv2 = await call('campaign preview after editing the template', 'ok', IPC.smsCampaignPreview, { body: 'تخفیف ۳۰٪ کفش', phones: '09127777777' })
obs('campaign final text after the template edit', cpv2.data?.finalBody)
if (te.ok && cpv2.data && !/مشتری گرامی/.test(String(cpv2.data.finalBody))) finding('TEMPLATE_UNUSED', 'قالب «پیامک تبلیغاتی (انبوه)» ویرایش شد ولی پیامک انبوه از آن استفاده نمی‌کند (متن همان چیزی است که در کادر کمپین نوشته شده + «لغو ۱۱»)')
{
  const src = ['src/main/services/sms', 'src/main/services/StoreCreditService.ts'].map((p) => {
    const abs = join(REPO, p)
    return existsSync(abs) && !p.endsWith('.ts') ? readdirSync(abs).map((f) => readFileSync(join(abs, f), 'utf8')).join('\n') : readFileSync(abs, 'utf8')
  }).join('\n')
  const used = (code) => new RegExp(`bodyOf\\(['"]${code}['"]\\)|THANK_YOU_TEMPLATES[\\s\\S]{0,400}['"]${code}['"]`).test(src)
  const unused = ['CREDIT_REMINDER', 'CREDIT_REMINDER_NO_EXPIRY', 'TEST'].filter((c) => !used(c))
  obs('templates with no sending path (code scan)', unused)
  if (unused.length) finding('TEMPLATE_UNUSED', `قالب‌های ${unused.map((c) => `«${c}»`).join('، ')} در صفحهٔ قالب‌ها ویرایش‌پذیرند ولی هیچ ارسالی از آن‌ها استفاده نمی‌کند؛ متن یادآوری اعتبار از تنظیمات اعتبار خرید می‌آید و «تست اتصال» فقط اعتبار حساب را می‌پرسد`)
}

// ============================================================ S5 provider failures
scenario('S5', 'خطاهای سرویس‌دهنده: اعتبار کم، ۵۰۳، ۵۰۰، مهلت')
const failCase = async (mode, label, phone) => {
  smsSrv.st.mode = mode
  await call(`manual send (${label})`, 'ok', IPC.smsSendManual, { phone, body: `آزمون ${label}` })
  await runQ(`run queue (${label})`)
  const row = outbox(`phoneSnapshot=?`, phone).pop()
  obs(`${label}: status / attempts used / error`, row ? [row.status, n(row.attemptCount), row.lastErrorCode] : null)
  return row
}
const credit = await failCase('credit', 'اعتبار کم', '09128000001')
await failCase('http503', '۵۰۳', '09128000002')
const h500 = await failCase('http500', '۵۰۰', '09128000003')
smsSrv.st.mode = 'ok'
const rcv2 = smsSrv.st.received.length
await runQ('run queue again (provider fine now; the 500 one must not go by itself)')
obs('auto resend of the 500 message', smsSrv.st.received.slice(rcv2).some((r) => r.mobiles.includes('09128000003')))
if (smsSrv.st.received.slice(rcv2).some((r) => r.mobiles.includes('09128000003'))) finding('SMS_DOUBLE_SEND', 'پیام «نتیجه نامعلوم» (۵۰۰) خودکار دوباره رفت')
await call('retry now the «low credit» message', 'ok', IPC.smsRetryNow, { id: n(credit?.id) })
await runQ('run queue')
obs('«low credit» message after retry', outbox(`id=?`, n(credit?.id)).map((r) => [r.status, n(r.attemptCount)]))
if (!SKIP_SLOW) {
  const hang = await failCase('hang', 'مهلت ۱۵ ثانیه', '09128000004')
  for (const res of smsSrv.st.hung) { try { res.end('{}') } catch {} }
  smsSrv.st.hung = []
  smsSrv.st.mode = 'ok'
  const rcv3 = smsSrv.st.received.length
  await runQ('run queue again (the timed-out one must not go by itself)')
  if (smsSrv.st.received.slice(rcv3).some((r) => r.mobiles.includes('09128000004'))) finding('SMS_DOUBLE_SEND', 'پیام «مهلت» خودکار دوباره رفت')
  obs('timed-out message', hang ? [hang.status] : null)
}
void h500

// ============================================================ S6 test provider
scenario('S6', 'سرویس‌دهندهٔ «آزمایشی»')
const lo = await call('save and activate the test (log only) line', 'ok', IPC.smsProviderSave, { name: 'آزمایشی', providerKey: 'LOG_ONLY', purpose: 'BOTH', isActive: true })
obs('active line', lo.data ? [lo.data.providerKey, lo.data.isActive] : null)
const rcv4 = smsSrv.st.received.length
await call('manual send through the test line', 'ok', IPC.smsSendManual, { phone: '09129000001', body: 'پیام از خط آزمایشی' })
await runQ('run queue')
const lr = await call('message list', 'ok', IPC.smsList, {})
const loRow = (lr.data?.rows ?? lr.data ?? []).find((r) => r.phone === '09129000001')
obs('test line message: status label / provider note / reached the provider', loRow ? [loRow.statusLabel, loRow.providerStatus, smsSrv.st.received.length > rcv4] : null)
if (loRow && loRow.statusLabel === 'ارسال شد') finding('TEST_PROVIDER_SENT_LABEL', 'با سرویس‌دهندهٔ «آزمایشی» پیامی به هیچ گوشی نمی‌رود ولی در فهرست پیام‌ها «ارسال شد» می‌خورد (توضیح فقط در ریز پیام است)')

// ============================================================ خلاصه، نتیجهٔ فشرده و مقایسه
site.server.close(); smsSrv.server.close()
const allFindings = scenarios.flatMap((c) => c.findings.map((f) => ({ sc: c.id, ...f })))
const byPlan = {}
const byType = {}
for (const f of allFindings) { byPlan[f.plan] = (byPlan[f.plan] ?? 0) + 1; byType[f.type] = (byType[f.type] ?? 0) + 1 }
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
const snapshotDoc = { meta: { tool: 'docs/audit/woo-sms-scenarios.mjs', programCommit: head, summary }, scenarios: snapshot }
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
