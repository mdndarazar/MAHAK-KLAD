/**
 * آزمون «ربات تلگرام و بله»: متن پیام‌ها، دکمه‌ها و سرعت رسیدن پیام — آزمون ۲۰۲۶-۱۱-۲۷ (دفتر آزمون مالک: ۴-۱۴۰).
 *
 * خواستهٔ مالک: «…بعداز تغییرات که در دفتر ازمونثبت کردیم باید دوباره تست های ربات روهم انجام بدی»؛ و دربارهٔ همین
 * ابزار: «اگر سرعت رسوندن پیام روبه بله وربات کم نمیکنه مشکلی نیس چون الان خیلی سریع وعالی پیام به ربات بله و تلگرام
 * فرستاده میشه من نمیخام که این سرعت رسیدن پیام خراب بشه».
 *
 * با موتور واقعی پیام‌رسان، پل واقعی دکمه‌های ربات و یک سرور ساختگی Bot API برای تلگرام و بله روی 127.0.0.1، و کارهای
 * واقعی فروشگاه از راه همان کانال‌های صفحه‌ها (حضانت صندوق روشن، مثل فروشگاه مالک):
 *   B0  روشن شدن دکمه‌های ربات (پیام آگاهی) — یک گیرنده در تلگرام و یکی در بله، هر دو «همه»، با اجازهٔ تأیید
 *   B1  تحویل صندوق · B2 فروش نقد دوقلمی · B3 فروش کارت با تخفیف · B4 نسیه · B5 فاکتور عمده · B6 برگشت · B7 تعویض
 *   B8  چک روی نسیه · B9 درخواست مجوز راه دور با دکمه‌های ✅/❌ و تأیید از بله · B10 منو و «خلاصهٔ امروز»
 *   B11 «بستن نهایی» با مغایرت · B12 «تجمیع و انتقال» (امروز پس از «بستن نهایی» رد؛ ۴-۱۰۲ ج) · B13 ده فروش پشت سر هم
 *   B14 فروشی درست پس از خواندن رویدادها (بیشترین زمان رسیدن امروز)
 *   B15 پرداخت بخشی از نسیه با کارت و با نقد (پیام «💰 پرداخت»؛ ۴-۱۴۴: فقط جای پول، نه «نقد · کارت»)
 * برای هر کار: متن پیام‌ها و دکمه‌ها (عددها «#») و «سرعت رسیدن»: چند ثانیه پس از کار، پیام به تلگرام و بله فرستاده شد.
 * ساعت ساختگی است و حلقهٔ موتور مثل برنامه هر ۱ ثانیه یک دور می‌زند (خواندن رویدادها هر ۵ ثانیه، `READ_GAP_MS`)؛ پس
 * عددها به سرعت رایانه بسته نیستند و مقایسه دقیق است. زمان شبکه تا سرور تلگرام و بله جزو آن نیست.
 *
 * پیش و پس از اجرای هر دستهٔ بندها (برنامهٔ بستن): فقط تفاوت‌های خواسته‌شدهٔ همان بندها در متن پیام‌ها پذیرفته است؛
 * «سرعت رسیدن» هیچ کاری نباید بیشتر شود (یافتهٔ `DELIVERY_SLOWER` در مقایسه).
 *
 * فقط ابزار آزمون است: پایگاه دادهٔ موقت، Electron شبیه‌سازی‌شده و سرور ساختگی؛ به برنامه، ربات واقعی یا اینترنت دست نمی‌زند.
 *   TZ=Asia/Tehran node --import ./test/harness/register.mjs docs/audit/bot-scenarios.mjs
 *   ... --out <file.json> · ... --compare docs/audit/bot-scenarios-2026-11-27.json · AUD_VERBOSE=1
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
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

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
const sender = { id: 7301, isDestroyed: () => false, once: () => {} }
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
const { jalaliStartOfDay, toJalaliDate } = await imp('/src/shared/jalali.ts')
const { findMigrationsDir } = await imp('/src/main/db/migrator.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')
const { salesService } = await imp('/src/main/services/SalesService.ts')
const { staffReportService } = await imp('/src/main/services/StaffReportService.ts')
const { createMessengerEngine } = await imp('/src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await imp('/src/main/services/cloud/messenger/messengerDb.ts')
const { createMessengerStore } = await imp('/src/main/services/cloud/messenger/messengerVault.ts')
const { createBotRemoteBridge } = await imp('/src/main/services/cloud/botRemoteBridge.ts')
const registry = await imp('/src/main/services/RemoteGrantRegistry.ts')
const { READ_GAP_MS } = await imp('/src/main/services/cloud/messenger/messengerTypes.ts')

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

// ---------------------------------------------------------------- سرور ساختگی Bot API (تلگرام و بله) روی loopback
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
const bot = { log: [], updates: { tg: [], bale: [] }, nextId: 1, port: 0 }
await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const m = /^\/(tg|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (!m) return send(404, { ok: false, description: 'Not Found' })
      const [, prefix, token, method] = m
      let params = {}
      try { params = JSON.parse(body || '{}') } catch {}
      bot.log.push({ prefix, method, params, at: Date.now() })
      if (token !== (prefix === 'tg' ? TOKENS.telegram : TOKENS.bale)) return send(401, { ok: false, description: 'Unauthorized' })
      if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: `${prefix}_shop_bot` } })
      if (method === 'getUpdates') {
        const offset = Number(params.offset) || 0
        bot.updates[prefix] = bot.updates[prefix].filter((u) => u.update_id >= offset)
        return send(200, { ok: true, result: bot.updates[prefix] })
      }
      if (method === 'sendMessage') return send(200, { ok: true, result: { message_id: bot.nextId++ } })
      if (method === 'answerCallbackQuery' || method === 'editMessageText') return send(200, { ok: true, result: true })
      return send(404, { ok: false, description: 'Not Found' })
    })
  })
  server.listen(0, '127.0.0.1', () => { bot.port = server.address().port; resolve() })
})
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}

// ---------------------------------------------------------------- نتیجه‌ها
const stories = []
const allFindings = []
let story = null
let keySeq = 0
const firstLine = (t) => String(t ?? '').split('\n')[0]
function begin(id, title) { story = { id, title, steps: [], findings: [], findingKeys: new Set(), obs: [] }; stories.push(story); if (VERBOSE) console.log(`\n=== ${id} ${title}`) }
function finding(type, label, plan) {
  const key = `${type}|${label}`
  if (story.findingKeys.has(key)) return
  story.findingKeys.add(key)
  const f = { story: story.id, type, label, plan: plan ?? '' }
  story.findings.push(f)
  allFindings.push(f)
  if (VERBOSE) console.log(`    ⚠ ${type} [${plan ?? ''}] ${label}`)
}
function obs(key, value) { story.obs.push({ k: key, v: value }); if (VERBOSE) console.log(`    · ${key}: ${JSON.stringify(value).slice(0, 400)}`) }
async function call(label, expect, channel, payload, plan) {
  let r
  try { r = await handlers.get(channel)({ sender }, payload) } catch (e) { r = { ok: false, error: String(e?.message ?? e), code: 'THROWN' } }
  if (!r.ok && expect === 'ok') finding('UNEXPECTED_REFUSAL', `${label}: ${firstLine(r.error).slice(0, 120)}`, plan)
  story.steps.push({ label, ok: !!r.ok, expect, plan: plan ?? '', msg: r.ok ? null : firstLine(r.error).slice(0, 200) })
  if (VERBOSE) console.log(`   ${r.ok ? '✓' : '✗'} ${label}${r.ok ? '' : ' :: ' + firstLine(r.error).slice(0, 150)}`)
  return r
}
const unlock = (...keys) => { for (const k of keys) notePanelUnlocked(k, 'PANEL', sender.id) }
const go = (jday, hhmm) => { const [h, m] = hhmm.split(':').map(Number); setNow(jalaliStartOfDay(jday).getTime() + h * 3600000 + m * 60000) }
const DAY = '1405/09/06'

// ---------------------------------------------------------------- فروشگاه آزمایشی
go(DAY, '08:00')
const owner = seed.user('مالک')
const custodian = seed.user('مسئول صندوق')
sql.prepare(`UPDATE "User" SET role='CASHIER' WHERE id=?`).run(custodian)
const cashM = seed.insert('PaymentMethod', { key: 'AUD-CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cardM = seed.insert('PaymentMethod', { key: 'AUD-CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
seed.insert('PaymentMethod', { key: CHEQUE_METHOD_KEY, label: 'چک', kind: 'CUSTOM', isActive: 0, sortOrder: 90 })
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
const cat = seed.category('ممیزی ربات')
const V = (name, code, price) => { const id = seed.variant(seed.product(name, cat), name); sql.prepare('UPDATE "ProductVariant" SET stock=500, salePrice=?, code=?, barcode=? WHERE id=?').run(price, code, `B-${code}`, id); return { id, price } }
const vA = V('کت', 'BOT-A', 1_000_000), vB = V('شلوار', 'BOT-B', 700_000), vC = V('پیراهن', 'BOT-C', 400_000)
registerIpcHandlers()
const ipcErrors = []
console.error = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
console.warn = (...a) => { ipcErrors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)) }
const OWNER_PIN = 'Owner-Pin-7391!', TMP = 'Tmp-Pin-4821!', CUST = 'Cust-Pin-5527!'
await custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN })
await custodyService.setPin({ userId: custodian, newPassword: TMP, managerUserId: owner, managerPassword: OWNER_PIN, reason: 'آزمون ربات' })
await custodyService.setPin({ userId: custodian, currentPassword: TMP, newPassword: CUST })
const DEBTOR = { firstName: 'رضا', lastName: 'ممیزی', phone: '09121234567', nationalId: null }
const L = (v, qty = 1, discount = 0) => ({ variantId: v.id, qty, unitPrice: v.price, discount, tax: 0 })

// ---------------------------------------------------------------- موتور پیام‌رسان (همان کد برنامه)
const R1 = { id: 'aaaaaaaaaaa1', provider: 'telegram', chatId: 5101, name: 'مالک تلگرام', mode: 'all', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const R2 = { id: 'bbbbbbbbbbb2', provider: 'bale', chatId: 6202, name: 'مالک بله', mode: 'all', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const mdir = join(dir, 'messenger'); mkdirSync(mdir, { recursive: true })
createMessengerStore(mdir, storage).writeSettings({
  version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: false,
  bots: { telegram: { token: TOKENS.telegram, username: 'tg_shop_bot', proxy: '' }, bale: { token: TOKENS.bale, username: 'bale_shop_bot', proxy: '' } },
  recipients: [R1, R2]
})
const notes = []
const remote = createBotRemoteBridge({ available: async () => true, closeAll: () => {}, note: (f) => notes.push(f) })
const engine = createMessengerEngine({
  dir: mdir, storage, db: createMessengerDb(),
  summary: {
    salesSummary: (f) => salesService.summary(f),
    staffPerformance: (f) => staffReportService.performance(f),
    abnormalDiscounts: (f) => staffReportService.abnormalDiscounts(f),
    lastBackupAt: async () => null
  },
  fetchFor: () => (url, init) => fetch(url, init),
  baseUrls: { telegram: `http://127.0.0.1:${bot.port}/tg`, bale: `http://127.0.0.1:${bot.port}/bale` },
  now: () => Date.now(), schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0, botPollSeconds: 0, remote
})

// ---------------------------------------------------------------- ثبت پیام‌ها و سرعت رسیدن
const norm = (t) => String(t ?? '').replace(/\b([A-Z])-[0-9a-z]+/g, '$1-#').replace(/[۰-۹٠-٩0-9]+/g, '#').replace(/[ \t]+\n/g, '\n').trim()
const normData = (d) => String(d ?? '').replace(/^([a-z]):[A-Za-z0-9_-]{8,}$/, '$1:<id>').replace(/[0-9]+/g, '#')
const btns = (p) => (p.reply_markup?.inline_keyboard ?? []).map((row) => row.map((b) => `${norm(b.text)} [${normData(b.callback_data)}]`))
let mark = 0
const latencies = []
let auditMark = 0
/** «تنظیمات برنامه عوض شد» از کجا آمد (نصب تازه: نخستین فروش هر نوع مشتری پیش‌فرض را می‌سازد) */
const settingRowsSince = () => { const rows = seed.rows(`SELECT id, entity FROM "AuditLog" WHERE action='SETTINGS_UPDATE' AND id > ? ORDER BY id`, auditMark); auditMark = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "AuditLog"').m); return rows.map((r) => r.entity) }
/**
 * حلقهٔ موتور مثل برنامه: هر دور ۱ ثانیهٔ ساختگی. تا وقتی پیام تازه می‌رسد ادامه می‌دهد (سقف ۴۰ دور).
 * سرعت رسیدن = ثانیه‌های ساختگی از لحظهٔ کار تا نخستین sendMessage به هر پیام‌رسان.
 */
async function deliver(label, expectMessage = true, plan = '') {
  const t0 = Date.now()
  const first = { tg: null, bale: null }
  let quiet = 0
  for (let i = 1; i <= 40; i++) {
    setNow(Date.now() + 1000)
    await engine.runOnce({})
    const fresh = bot.log.slice(mark).filter((e) => e.method === 'sendMessage')
    for (const p of ['tg', 'bale']) if (first[p] == null && fresh.some((e) => e.prefix === p)) first[p] = Math.round((fresh.find((e) => e.prefix === p).at - t0) / 1000)
    const before = fresh.length
    if (first.tg != null && first.bale != null) { quiet++; if (quiet >= 3) break }
    else if (!expectMessage && i >= 12) break
    void before
  }
  const entries = bot.log.slice(mark).filter((e) => e.method === 'sendMessage' || e.method === 'editMessageText' || e.method === 'answerCallbackQuery')
  mark = bot.log.length
  const view = (p) => entries.filter((e) => e.prefix === p).map((e) => (e.method === 'sendMessage' ? { send: norm(e.params.text), buttons: btns(e.params) } : e.method === 'editMessageText' ? { edit: norm(e.params.text) } : { answer: norm(e.params.text) }))
  obs(`${label}: telegram`, view('tg'))
  obs(`${label}: bale`, view('bale'))
  obs(`${label}: seconds until sent (telegram, bale)`, [first.tg, first.bale])
  latencies.push({ label, tg: first.tg, bale: first.bale })
  if (expectMessage && (first.tg == null || first.bale == null)) finding('NO_MESSAGE', `${label}: پیامی به ${first.tg == null ? 'تلگرام' : 'بله'} نرسید`, plan)
  return first
}
let uid = 1000
const press = async (provider, chatId, data) => {
  bot.updates[PREFIX[provider]].push({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: 'private' }, text: 'پیام' }, data } })
  return engine.botPollOnce(provider, 0)
}
const say = async (provider, chatId, text) => {
  bot.updates[PREFIX[provider]].push({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' }, text, date: Math.floor(Date.now() / 1000) } })
  return engine.botPollOnce(provider, 0)
}
const lastButtons = (prefix, chatId) => {
  const e = bot.log.filter((x) => x.prefix === prefix && x.method === 'sendMessage' && x.params.chat_id === chatId && x.params.reply_markup?.inline_keyboard).at(-1)
  return e ? e.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data) : []
}

// =================================================================== B0
begin('B0', 'روشن شدن پیام‌رسان و دکمه‌های ربات: یک گیرنده در تلگرام و یکی در بله (هر دو «همه»، با اجازهٔ تأیید)')
go(DAY, '08:30')
auditMark = n(seed.one('SELECT COALESCE(MAX(id),0) m FROM "AuditLog"').m)
await engine.start()
await engine.setRecipientApprove(R1.id, true); await engine.setRecipientApprove(R2.id, true)
await engine.setBotButtons(true)
await deliver('turning on the bot buttons')
obs('engine read gap (ms) and loop (ms)', [READ_GAP_MS, 1000])

// =================================================================== B1 … B8
begin('B1', 'تحویل صندوق (مسئول صندوق، رمز شخصی و شمارش)')
go(DAY, '09:00')
await call('custodian takes over the drawer (count 0)', 'ok', IPC.custodyOpen, { userId: custodian, password: CUST, operationalTotal: 0 }, 'حضانت')
await deliver('drawer taken over', false)

begin('B2', 'فروش نقد دوقلمی (کت ۱٬۰۰۰٬۰۰۰ + شلوار ۷۰۰٬۰۰۰)')
go(DAY, '10:00')
const s2 = await call('POS sale cash 1,700,000', 'ok', IPC.saleCreate, { lines: [L(vA), L(vB)], payments: [{ methodId: cashM, amount: 1_700_000, destination: 'CASH' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹، ۴-۳۵، ۴-۳۶')
await deliver('cash sale', true, '۴-۹')
obs('SETTINGS_UPDATE rows written since B0 (entity)', settingRowsSince())

begin('B3', 'فروش کارت با تخفیف قلم (پیراهن ۴۰۰٬۰۰۰، تخفیف ۴۰٬۰۰۰)')
go(DAY, '10:30')
await call('POS sale card 360,000 with a 40,000 line discount', 'either', IPC.saleCreate, { lines: [L(vC, 1, 40_000)], payments: [{ methodId: cardM, amount: 360_000, destination: 'CARD' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۳۶')
await deliver('card sale with discount', true, '۴-۳۶')

begin('B4', 'فروش نسیه (شلوار ۷۰۰٬۰۰۰؛ نام مشتری در پیام نمی‌آید)')
go(DAY, '11:00')
const s4 = await call('POS sale نسیه 700,000', 'ok', IPC.saleCreate, { lines: [L(vB)], payments: [], debtor: DEBTOR, saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹')
await deliver('نسیه sale', true, '۴-۹')

begin('B5', 'فاکتور عمده (کت ۱٬۰۰۰٬۰۰۰ نقد)')
go(DAY, '11:30')
unlock(PANEL_KEYS.salesInvoice ?? 'salesInvoice')
await call('wholesale invoice cash 1,000,000', 'ok', IPC.saleCreate, { orderType: 'WHOLESALE', issuedAtJalali: DAY, lines: [L(vA)], payments: [{ methodId: cashM, amount: 1_000_000, destination: 'CASH' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹')
await deliver('wholesale invoice', true, '۴-۹')
obs('SETTINGS_UPDATE rows written since B2 (entity)', settingRowsSince())

begin('B6', 'برگشت کامل فروش نقد B2 (بازپرداخت نقد)')
go(DAY, '12:00')
unlock(PANEL_KEYS.salesReturn)
await call('full return of the cash sale (cash refund)', 'ok', IPC.saleReturn, { invoiceId: n(s2.data?.id), full: true, refundDecision: 'METHOD', refundMethod: 'CASH' }, '۴-۹')
await deliver('full return', true, '۴-۹')

begin('B7', 'تعویض: شلوار فاکتور نسیه با پیراهن (تفاوت به نفع مشتری)')
go(DAY, '12:30')
{
  unlock(PANEL_KEYS.salesReturn)
  const invoiceId = n(s4.data?.id)
  const itemId = n(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)?.id)
  const lines = [{ saleItemId: itemId, qty: 1 }], replacements = [L(vC)]
  const pv = await handlers.get(IPC.saleExchangePreview)({ sender }, { invoiceId, lines, replacements, full: false })
  if (pv.ok && pv.data?.ok) {
    const diff = n(pv.data.effectiveDiff)
    const input = { invoiceId, lines, full: false, replacements, expectedSettlementDiff: diff, requestIdempotencyKey: `bot-ex-${++keySeq}xx` }
    if (pv.data.discountTransfer) input.discountTransferOption = 'NO'
    if (diff > 0) input.methodId = cashM
    else if (diff < 0) { input.exchangeSettlementDecision = 'METHOD'; input.refundMode = 'CASH' }
    await call(`exchange (diff ${diff})`, 'either', IPC.saleExchangeCreate, input, '۴-۹')
  } else story.steps.push({ label: 'exchange preview', ok: false, expect: 'either', plan: '۴-۹', msg: firstLine(pv.ok ? pv.data?.error : pv.error).slice(0, 200) })
}
await deliver('exchange', false, '۴-۹')

begin('B8', 'چک ۳۰۰٬۰۰۰ روی فاکتور نسیه (سررسید ۱۴۰۵/۱۰/۰۶)')
go(DAY, '13:00')
await call('cheque 300,000 for the نسیه sale', 'either', IPC.salePaymentAdd, { invoiceId: n(s4.data?.id), kind: 'CHEQUE', amount: 300_000, chequeNo: 'BOT-Q-1', bankName: 'ملت', dueDateJalali: '1405/10/06' }, 'چک')
await deliver('cheque', false, 'چک')

// =================================================================== B9
begin('B9', 'درخواست مجوز راه دور (بخش «کالاها») با دکمه‌های ✅/❌ و تأیید از بله')
go(DAY, '14:00')
const req = registry.requestCode('products', sender.id)
await deliver('remote approval request', true, '۴-۲۹، ۴-۳۰')
{
  const bl = lastButtons('bale', R2.chatId)
  setNow(Date.now() + 6000)
  if (bl[0]) await press('bale', R2.chatId, bl[0])
  obs('request status after ✅ in Bale', registry.getRequestStatus(sender.id, 'products', req.requestId))
  await deliver('after approving in Bale', false, '۴-۲۹')
  registry.revokeAll?.()
}

// =================================================================== B10
begin('B10', 'منوی ربات و «📊 خلاصهٔ امروز»')
go(DAY, '15:00')
await say('telegram', R1.chatId, 'منو')
await deliver('menu', false, '۴-۳۳')
setNow(Date.now() + 6000)
await press('telegram', R1.chatId, 'm:sum')
await deliver('today summary', false, '۴-۱۴، ۴-۳۳')

// =================================================================== B11
begin('B11', '«بستن نهایی» با شمارش ۱۰۰٬۰۰۰ بیشتر از انتظار')
go(DAY, '21:00')
{
  const st = await handlers.get(IPC.custodyStatus)({ sender }, {})
  obs('custody state before the final close', st.ok ? st.data.state : 'refused')
}
const expectedTotal = 360_000 + 1_000_000
await call(`«بستن نهایی» with count ${(expectedTotal + 100_000).toLocaleString('en')}`, 'either', IPC.custodyFinalClose, { password: CUST, operationalTotal: expectedTotal + 100_000, note: 'شمارش آزمایشی' }, '۴-۱، ۴-۱۴، ۴-۱۶')
await deliver('final close', true, '۴-۱، ۴-۱۴')

// =================================================================== B12
begin('B12', '«تجمیع و انتقال» امروز (F11)')
go(DAY, '21:10')
unlock(PANEL_KEYS.consolidation)
await call('consolidation of today after the final close (today refused until the drawer is reopened; ۴-۱۰۲ ج)', 'either', IPC.consolidationFinalizeDays, { days: [DAY] }, '۴-۱۰۲ ج، ۴-۴۲')
await deliver('consolidation', false, '۴-۴۲')

// =================================================================== B13
begin('B13', 'روز بعد: ده فروش پشت سر هم (سقف یک پیام در ثانیه برای هر گفت‌وگو)')
go('1405/09/07', '09:00')
await call('custodian takes over the drawer', 'ok', IPC.custodyOpen, { userId: custodian, password: CUST, operationalTotal: expectedTotal + 100_000 }, 'حضانت')
await deliver('drawer taken over (day 2)', false)
go('1405/09/07', '10:00')
for (let i = 0; i < 10; i++) await call(`POS sale cash 400,000 (#${i + 1})`, 'ok', IPC.saleCreate, { lines: [L(vC)], payments: [{ methodId: cashM, amount: 400_000, destination: 'CASH' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹')
{
  const t0 = Date.now()
  const counts = () => ({ tg: bot.log.slice(mark).filter((e) => e.prefix === 'tg' && e.method === 'sendMessage').length, bale: bot.log.slice(mark).filter((e) => e.prefix === 'bale' && e.method === 'sendMessage').length })
  let all = { tg: null, bale: null }
  for (let i = 1; i <= 60; i++) {
    setNow(Date.now() + 1000)
    await engine.runOnce({})
    const c = counts()
    const msgs = (p) => bot.log.slice(mark).filter((e) => e.prefix === p && e.method === 'sendMessage').map((e) => e.params.text).join('\n')
    for (const p of ['tg', 'bale']) if (all[p] == null && (msgs(p).match(/🧾 فروش · فاکتور/g) ?? []).length >= 10) all[p] = i
    if (all.tg != null && all.bale != null) break
    void c
  }
  const c = counts()
  obs('ten sales: messages sent (telegram, bale) — the engine groups several events in one message', [c.tg, c.bale])
  obs('ten sales: sale lines in those messages (telegram, bale)', ['tg', 'bale'].map((p) => (bot.log.slice(mark).filter((e) => e.prefix === p && e.method === 'sendMessage').map((e) => e.params.text).join('\n').match(/🧾 فروش · فاکتور/g) ?? []).length))
  obs('ten sales: seconds until all ten were mentioned (telegram, bale)', [all.tg, all.bale])
  latencies.push({ label: 'ten sales (all)', tg: all.tg, bale: all.bale })
  mark = bot.log.length
  void t0
}

// =================================================================== B14
begin('B14', 'فروشی درست پس از خواندن رویدادها: بیشترین زمان رسیدن امروز (خواندن هر ۵ ثانیه)')
go('1405/09/07', '11:00')
await call('POS sale cash 400,000 (X)', 'ok', IPC.saleCreate, { lines: [L(vC)], payments: [{ methodId: cashM, amount: 400_000, destination: 'CASH' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹')
setNow(Date.now() + 1000)
await engine.runOnce({})
mark = bot.log.length
await call('POS sale cash 400,000 (Y) right after the engine read', 'ok', IPC.saleCreate, { lines: [L(vC)], payments: [{ methodId: cashM, amount: 400_000, destination: 'CASH' }], saleRequestIdempotencyKey: `bot-sale-${++keySeq}xx` }, '۴-۹')
await deliver('a sale right after the engine read', true, '۴-۹')

// =================================================================== B15
begin('B15', 'پرداخت بخشی از نسیهٔ B4 با کارت و با نقد (پیام «💰 پرداخت»؛ ۴-۱۴۴)')
go('1405/09/07', '11:30')
await call('نسیه payment 60,000 by card', 'ok', IPC.salePaymentAdd, { invoiceId: n(s4.data?.id), kind: 'CASH', amount: 60_000, destination: 'CARD', methodId: cardM }, '۴-۱۴۴')
await deliver('نسیه payment by card', true, '۴-۱۴۴')
go('1405/09/07', '11:40')
await call('نسیه payment 40,000 in cash', 'ok', IPC.salePaymentAdd, { invoiceId: n(s4.data?.id), kind: 'CASH', amount: 40_000, destination: 'CASH', methodId: cashM }, '۴-۱۴۴')
await deliver('نسیه payment in cash', true, '۴-۱۴۴')

// =================================================================== خلاصه، نتیجهٔ فشرده و مقایسه
const byType = {}
for (const f of allFindings) byType[f.type] = (byType[f.type] ?? 0) + 1
const summary = {
  stories: stories.length,
  steps: stories.reduce((s, x) => s + x.steps.length, 0),
  refusals: stories.reduce((s, x) => s + x.steps.filter((st) => !st.ok).length, 0),
  messages: { telegram: bot.log.filter((e) => e.prefix === 'tg' && e.method === 'sendMessage').length, bale: bot.log.filter((e) => e.prefix === 'bale' && e.method === 'sendMessage').length },
  slowestSeconds: Math.max(0, ...latencies.flatMap((x) => [x.tg ?? 0, x.bale ?? 0]).filter((x) => x != null)),
  findings: allFindings.length,
  findingTypes: byType
}
const fullPath = join(dir, 'full.json')
writeFileSync(fullPath, JSON.stringify({ summary, stories, latencies, ipcErrors }, (k, x) => (typeof x === 'bigint' ? Number(x) : x), 2))
const snapshot = stories.map((s) => ({
  id: s.id,
  title: s.title,
  steps: s.steps.map((st) => [st.label, st.ok ? 'OK' : 'REFUSED', st.expect, st.ok ? null : String(st.msg ?? '').replace(/[۰-۹٠-٩0-9]+/g, '#'), st.plan]),
  findings: [...new Set(s.findings.map((f) => `${f.type} | ${f.label} | ${f.plan}`))].sort(),
  obs: s.obs
}))
let head = null
try { head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
const snapPath = OUT ?? join(dir, 'snapshot.json')
writeFileSync(snapPath, JSON.stringify({ meta: { tool: 'docs/audit/bot-scenarios.mjs', programCommit: head, summary, latencies }, stories: snapshot }, null, 1) + '\n')
for (const s of stories) {
  console.log(`\n${s.id} — ${s.title}`)
  for (const st of s.steps) console.log(`  ${st.ok ? '✓' : '✗'} ${st.label}${st.ok ? '' : `  :: ${st.msg}`}`)
  for (const o of s.obs) console.log(`  · ${o.k}: ${JSON.stringify(o.v).slice(0, 500)}`)
  for (const f of s.findings) console.log(`  ⚠ ${f.type} [${f.plan}] ${f.label}`)
}
console.log('\nLATENCY (seconds until sent: telegram, bale)')
for (const x of latencies) console.log(`  ${x.label}: ${x.tg}, ${x.bale}`)
console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
console.log(`full result: ${fullPath}\nnormalised result: ${snapPath}`)
if (COMPARE) {
  const baseDoc = JSON.parse(readFileSync(COMPARE, 'utf8'))
  const base = baseDoc.stories
  const diffs = []
  const byId = new Map(base.map((s) => [s.id, s]))
  for (const s of snapshot) {
    const bb = byId.get(s.id)
    if (!bb) { diffs.push(`+ داستان تازه: ${s.id}`); continue }
    byId.delete(s.id)
    for (const [kind, xs, ys] of [['گام', s.steps, bb.steps], ['دیده', s.obs, bb.obs ?? []]]) {
      const len = Math.max(xs.length, ys.length)
      for (let i = 0; i < len; i++) { const x = JSON.stringify(xs[i] ?? null), y = JSON.stringify(ys[i] ?? null); if (x !== y) diffs.push(`${s.id} · ${kind} ${i + 1}\n    پیش: ${y.slice(0, 700)}\n    پس:  ${x.slice(0, 700)}`) }
    }
    const x = JSON.stringify(s.findings), y = JSON.stringify(bb.findings)
    if (x !== y) diffs.push(`${s.id} · یافته‌ها\n    پیش: ${y}\n    پس:  ${x}`)
  }
  for (const id of byId.keys()) diffs.push(`- داستان نیست: ${id}`)
  // سرعت رسیدن: هیچ کاری نباید کندتر شود (خواست مالک)
  const baseLat = new Map((baseDoc.meta?.latencies ?? []).map((x) => [x.label, x]))
  for (const x of latencies) {
    const b = baseLat.get(x.label)
    if (!b) continue
    for (const p of ['tg', 'bale']) if (x[p] != null && b[p] != null && x[p] > b[p]) diffs.push(`DELIVERY_SLOWER · ${x.label} · ${p === 'tg' ? 'تلگرام' : 'بله'}: ${b[p]} ⇐ ${x[p]} ثانیه`)
  }
  console.log(`\nمقایسه با ${COMPARE}: ${diffs.length} تفاوت`)
  for (const d of diffs.slice(0, 300)) console.log(d)
  process.exit(diffs.length ? 1 : 0)
}
process.exit(0)
