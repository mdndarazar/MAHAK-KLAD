/**
 * طرح ۱۴۰۵ · مرحلهٔ ۳ — پیام‌رسان تلگرام و بله روی سرور ساختگی loopback (معماری §۸-۲ بند ۱۳).
 *
 * برای هر دو آداپتور، با موتور واقعی، پایگاه دادهٔ موقت و سرویس‌های واقعی فروش، برگشت، اعتبار و بستن صندوق:
 * خاموش یعنی بی اتصال؛ سه گزینه؛ صف پس از قطع و وصل؛ انقضای ۲۴ ساعته و پیام «منقضی شد»؛ ۴۲۹ و ۴۰۳؛ برچسب
 * تکرار؛ فیلدهای ممنوع؛ انقضای جفت‌سازی؛ خبر تغییر تنظیمات؛ عددهای پیام برابر عددهای ثبت‌شده؛ یک پیام برای
 * هر `cashSessionId`؛ نشانگر پس از بازگردانی، ادغام و صفر کردن؛ فروش در قطعی کامل متوقف نمی‌شود؛ `note` هرگز
 * عیناً؛ خبر «کار با مجوز یا کد» با عدد ثبت خود کار؛ خط شمار مجوز و کد در خلاصهٔ ساعت ۲۴.
 *
 * Electron (session، safeStorage) و Prisma استاب هارنس‌اند؛ هیچ اتصال بیرونی ساخته نمی‌شود (فقط 127.0.0.1).
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-messenger-loopback.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-plan1405-messenger-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { setDesktopBackupHooks, withDesktopBackupCoordination } = await import('../../src/main/services/cloud/desktopBackupCoordination.ts')
const { gateMethodNoteLine } = await import('@shared/gateCatalog')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { faDigits, money, toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// ---------------------------------------------------------------- داده‌های پایه
const seller = seed.user('علی فروشنده')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('پوشاک')
const mk = (name, price) => {
  const id = seed.variant(seed.product(name, cat), name)
  sql.prepare('UPDATE "ProductVariant" SET stock = ?, salePrice = ? WHERE id = ?').run(1000, price, id)
  return id
}
const vA = mk('کت', 1_000_000), vB = mk('شلوار', 700_000), vC = mk('پیراهن', 400_000)
const today = toJalaliDate(new Date())
const PHONE = '09120000001'
const debtor = { firstName: 'مشتری', lastName: 'آزمون', phone: PHONE }
const customerId = seed.insert('Customer', { code: 'C-T1', name: 'مشتری آزمون', phone: PHONE, isDefault: 0 })
const L = (v, unitPrice, qty = 1) => ({ variantId: v, qty, unitPrice, discount: 0, tax: 0 })
const payC = (x) => [{ methodId: cash, amount: x, destination: 'CASH' }]
let shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const sale = (lines, payments, extra = {}) => salesService.create({ debtor, userId: seller, shiftId, lines, payments, ...extra })
const itemOf = (invoiceId) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id LIMIT 1', invoiceId).id

// ---------------------------------------------------------------- ذخیره‌ساز امن ساختگی (AES-GCM)
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}

// ---------------------------------------------------------------- سرور ساختگی Bot API روی loopback
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
const mock = { log: [], rules: [], updates: { tg: [], bale: [] }, nextId: 1, port: 0, server: null }
function startMock(port = 0) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const m = /^\/(tg|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
        const send = (status, obj, entry) => { if (entry) entry.result = status === 200 ? 'ok' : String(status); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
        if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' })
        const [, prefix, token, method] = m
        let params = {}
        try { params = JSON.parse(body || '{}') } catch {}
        const entry = { prefix, token, method, params, result: null }
        mock.log.push(entry)
        const ruleAt = mock.rules.findIndex((r) => r.prefix === prefix && r.method === method && (r.chat === undefined || r.chat === params.chat_id))
        const rule = ruleAt >= 0 ? mock.rules.splice(ruleAt, 1)[0] : null
        if (rule?.directive === 'drop') { entry.result = 'drop'; req.socket.destroy(); return }
        if (rule) return send(rule.directive.status, { ok: false, error_code: rule.directive.status, description: rule.directive.description ?? `Error ${rule.directive.status}`, ...(rule.directive.retry_after ? { parameters: { retry_after: rule.directive.retry_after } } : {}) }, entry)
        const expected = prefix === 'tg' ? TOKENS.telegram : TOKENS.bale
        if (token !== expected) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' }, entry)
        if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, first_name: 'Shop', username: `${prefix}_shop_bot` } }, entry)
        if (method === 'getUpdates') {
          const offset = Number(params.offset) || 0
          mock.updates[prefix] = mock.updates[prefix].filter((u) => u.update_id >= offset)
          return send(200, { ok: true, result: mock.updates[prefix] }, entry)
        }
        if (method === 'sendMessage') return send(200, { ok: true, result: { message_id: mock.nextId++ } }, entry)
        return send(404, { ok: false, error_code: 404, description: 'Not Found' }, entry)
      })
    })
    server.listen(port, '127.0.0.1', () => { mock.server = server; mock.port = server.address().port; resolve() })
  })
}
const serverDown = () => new Promise((resolve) => { mock.server.close(() => resolve()); mock.server.closeAllConnections() })
const serverUp = () => startMock(mock.port)
await startMock()
const base = () => `http://127.0.0.1:${mock.port}`

let clock = Date.now()
const advance = (ms) => { clock += ms }
const texts = (prefix, chat) => mock.log.filter((e) => e.prefix === prefix && e.method === 'sendMessage' && e.result === 'ok' && (chat === undefined || e.params.chat_id === chat)).map((e) => e.params.text)
const requestCount = () => mock.log.length

function makeEngine(dir, opts = {}) {
  return createMessengerEngine({
    dir, storage, db: createMessengerDb(),
    summary: {
      salesSummary: (f) => salesService.summary(f),
      staffPerformance: (f) => staffReportService.performance(f),
      abnormalDiscounts: (f) => staffReportService.abnormalDiscounts(f),
      lastBackupAt: async () => opts.lastBackupAt ?? null
    },
    fetchFor: () => (url, init) => fetch(url, init),
    baseUrls: { telegram: `${base()}/tg`, bale: `${base()}/bale` },
    now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0
  })
}
/** چند دور حلقه؛ هر دور ۱.۱ ثانیهٔ ساختگی (سقف ۱ پیام در ثانیه برای هر گفت‌وگو). */
async function pump(engine, rounds = 4) {
  for (let i = 0; i < rounds; i++) { advance(1100); await engine.runOnce({ read: true }) }
}
async function pair(engine, provider, chatId, name, mode, chatType = 'private') {
  const prefix = PREFIX[provider]
  const p = await engine.pairStart(provider)
  const text = provider === 'telegram' ? `/start ${p.code}` : p.code
  const [first, ...last] = name.split(' ')
  mock.updates[prefix].push({ update_id: mock.nextId++, message: { message_id: 1, chat: { id: chatId, type: chatType, first_name: first, last_name: last.join(' ') }, text } })
  await engine.pairPollOnce(0)
  return { pairing: engine.status().pairing, confirm: () => engine.pairConfirm(mode), code: p.code }
}
const forbiddenValues = () => {
  const out = [PHONE, faDigits(PHONE), PW, TOKENS.telegram, TOKENS.bale]
  for (const r of sql.prepare('SELECT code, legacyCode FROM "StoreCredit"').all()) { if (r.code) out.push(r.code); if (r.legacyCode) out.push(r.legacyCode) }
  for (const r of sql.prepare('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').all()) out.push(r.returnCode)
  return out.filter((v) => typeof v === 'string' && v.length >= 4)
}
const audit = (action, after, note = null, extra = {}) => db.auditLog.create({ data: { action, entity: extra.entity ?? 'Test', entityId: extra.entityId ?? null, userId: extra.userId ?? seller, after: after == null ? null : JSON.stringify(after), note } })

async function scenario(provider) {
  const prefix = PREFIX[provider]
  const dir = join(ROOT, `userdata-${provider}`)
  mkdirSync(dir, { recursive: true })
  clock = Date.now()
  // هر آداپتور شیفت خودش را دارد (بستن صندوق شیفت قبلی، «بستن دوباره» می‌شد)
  const shiftName = provider === 'telegram' ? 'صبح' : 'عصر'
  if (provider !== 'telegram') shiftId = seed.insert('Shift', { name: shiftName, number: 2, dayJalali: today, openedAt: Date.now() - 1_800_000, userId: seller, staffConfirmed: 1 })
  let engine = makeEngine(dir)
  const chatA = provider === 'telegram' ? 5001 : 6001, chatB = chatA + 1, chatC = chatA + 2, chatGroup = chatA + 50

  // ---- گاوصندوق و ربات
  await assert.rejects(engine.saveBot(provider, '123:short', ''), /کلید ربات درست نیست/)
  if (provider === 'bale') await assert.rejects(engine.saveBot(provider, TOKENS.bale, 'socks5://127.0.0.1:1080'), /پراکسی/, 'bale has no proxy')
  const saved = await engine.saveBot(provider, TOKENS[provider], provider === 'telegram' ? 'socks5://127.0.0.1:10808' : '')
  assert.equal(saved.username, `${prefix}_shop_bot`)
  const vaultPath = join(dir, 'messenger.vault')
  if (process.platform !== 'win32') assert.equal(statSync(vaultPath).mode & 0o777, 0o600, 'vault 0o600')
  assert.equal(readFileSync(vaultPath).includes(Buffer.from(TOKENS[provider])), false, 'token is encrypted at rest')
  assert.equal(JSON.stringify(engine.status()).includes(TOKENS[provider]), false, 'status never returns the token')

  // ---- خاموش یعنی بی اتصال (پیش از روشن شدن)
  const quiet = requestCount()
  await sale([L(vA, 1_000_000)], payC(1_000_000))
  for (let i = 0; i < 3; i++) { advance(6000); await engine.runOnce({ read: true }) }
  assert.equal(requestCount(), quiet, 'off: no connection at all')
  assert.equal(existsSync(join(dir, 'messenger-cursor.json')), false, 'off: no cursor file')

  // ---- جفت‌سازی: کد یک‌بارمصرف، فقط گفت‌وگوی خصوصی، انقضای ۱۰ دقیقه
  const group = await pair(engine, provider, chatGroup, 'گروه فروش', 'all', 'group')
  assert.equal(group.pairing.candidate, null, 'a group chat is never paired')
  engine.pairCancel()
  const stale = await engine.pairStart(provider)
  advance(11 * 60_000)
  mock.updates[prefix].push({ update_id: mock.nextId++, message: { message_id: 1, chat: { id: chatA, type: 'private', first_name: 'دیر' }, text: stale.code } })
  await engine.pairPollOnce(0)
  assert.equal(engine.status().pairing, null, 'pairing expires after ten minutes')
  await assert.rejects(engine.pairConfirm('all'), /جفت‌سازی فعالی نیست/)
  if (provider === 'telegram') {
    const p = await engine.pairStart(provider)
    assert.equal(engine.status().pairing.link, `https://t.me/${prefix}_shop_bot?start=${p.code}`)
    assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/)
    engine.pairCancel()
  } else {
    await engine.pairStart(provider)
    assert.equal(engine.status().pairing.link, null, 'bale: send the code (no ?start= link)')
    engine.pairCancel()
  }
  mock.rules.push({ prefix, method: 'getUpdates', directive: { status: 409, description: 'Conflict: terminated by other getUpdates request' } })
  await assert.rejects(engine.pairStart(provider), /webhook/, '409 guidance')
  for (const [chat, name, mode] of [[chatA, 'مدیر اصلی', 'all'], [chatB, 'شریک فروشگاه', 'handover'], [chatC, 'حسابدار', 'important']]) {
    const p = await pair(engine, provider, chat, name, mode)
    assert.equal(p.pairing.candidate.name, name)
    await p.confirm()
  }
  await assert.rejects((await pair(engine, provider, chatA, 'مدیر اصلی', 'all')).confirm(), /از قبل در فهرست/)
  engine.pairCancel()
  const ids = Object.fromEntries(engine.status().recipients.map((r) => [r.mode, r.id]))
  assert.equal(engine.status().recipients.length, 3)

  // ---- روشن کردن: از «اکنون»، و پیام «اعلان‌ها روشن شد» برای همه
  await engine.setEnabled(true)
  await pump(engine, 2)
  for (const chat of [chatA, chatB, chatC]) assert.ok(texts(prefix, chat).some((t) => t.includes('اعلان‌ها روشن شد')), `enable notice to ${chat}`)
  assert.equal(texts(prefix).some((t) => t.includes('🧾 فروش')), false, 'the sale made while off is never sent')

  // ---- رویدادهای واقعی
  const s1 = await sale([L(vA, 1_000_000), L(vB, 700_000)], payC(1_700_000))
  const s2 = await sale([L(vB, 700_000)], payC(700_000))
  await salesService.createReturn({ invoiceId: s2.id, full: true, lines: [{ saleItemId: itemOf(s2.id), qty: 1 }], refundMethod: 'STORE_CREDIT', userId: seller })
  const creditCode = seed.one('SELECT code FROM "StoreCredit" ORDER BY id DESC LIMIT 1').code
  await sale([L(vC, 400_000)], [], { storeCreditCode: creditCode })
  await storeCreditService.issueManual({ amount: 600_000, multiUse: true, maxUses: 3, days: 30, userId: seller, managerPassword: PW })
  const marker = `NOTE-MARKER-${provider}-${PHONE}`
  await audit('SALE_PRICE_OVERRIDE', [{ variantId: vA, code: 'SECRETCODE1', qty: 1, price: 1 }], `قیمت دستی ${marker}\n${gateMethodNoteLine('REMOTE_GRANT', { windowNo: 3 })}`, { entity: 'SaleInvoice', entityId: s1.id })
  await audit('STOCK_ADJUST', { amount: 250_000, code: 'SECRETCODE2' }, `اصلاح ${marker}\n${gateMethodNoteLine('SENSITIVE_CODE', { number: 2, windowNo: 1 })}`, { entity: 'ProductVariant', entityId: vA })
  await audit('CASH_MOVEMENT', { amount: 250_000, type: 'WITHDRAWAL', refType: null, code: 'SECRETCODE3' }, `برداشت ${marker}\n${gateMethodNoteLine('OTHER_CODE', { number: 4, windowNo: 2 })}`, { entity: 'CashMovement', entityId: 99 })
  const expected = await cashboxService.expected({ shiftId }).then((r) => Number(r?.expectedCash ?? 0))
  await cashboxService.close({ shiftId, explicitShift: true, userId: seller, countedCash: expected - 500_000, closeShift: false, note: `کسری ${marker}` })
  const closeRow = seed.one(`SELECT id, entityId, after FROM "AuditLog" WHERE action = 'CASH_CLOSE' ORDER BY id DESC LIMIT 1`)
  const closeAfter = JSON.parse(closeRow.after)
  // یک بستن، یک پیام: رویداد حضانت با همان cashSessionId پیام جدا نمی‌گیرد
  const custodyClose = await db.custodyEvent.create({ data: { type: 'FINAL_CLOSE', actorKind: 'CUSTODIAN', actorUserId: seller, payloadJson: JSON.stringify({ cashSessionId: closeRow.entityId }), operationalDay: today } })
  const custodyOpen = await db.custodyEvent.create({ data: { type: 'OPEN', actorKind: 'CUSTODIAN', actorUserId: seller, shiftId, operationalDay: today } })
  await pump(engine, 6)

  const A = texts(prefix, chatA).join('\n=====\n'), B = texts(prefix, chatB).join('\n=====\n'), C = texts(prefix, chatC).join('\n=====\n')
  // سه گزینه
  assert.match(A, /🧾 فروش · فاکتور/, 'all: sale'); assert.doesNotMatch(B, /🧾 فروش · فاکتور/, 'handover: no sale'); assert.doesNotMatch(C, /🧾 فروش · فاکتور/, 'important: no sale')
  assert.match(A, /↩️ برگشت از فروش/); assert.match(C, /↩️ برگشت از فروش/, 'important: return ⚠️'); assert.doesNotMatch(B, /↩️ برگشت از فروش/)
  assert.match(A, /🎫 صدور اعتبار/); assert.match(C, /🎫 صدور اعتبار/)
  for (const T of [A, B, C]) { assert.ok(T.includes(`🔁 تحویل شیفت · بستن صندوق ${shiftName}`), 'every mode sees this close'); assert.match(T, /🚨 مغایرت بزرگ در بستن صندوق/, 'big discrepancy to everyone') }
  assert.match(B, /🔓 افتتاح صندوق \(حضانت\)/, 'handover: custody OPEN'); assert.doesNotMatch(C, /🔓 افتتاح صندوق/)
  // عددها همان عددهای ثبت‌شده‌اند
  const inv = seed.one('SELECT receiptNo, grandTotal FROM "SaleInvoice" WHERE id = ?', s1.id)
  assert.ok(A.includes(`فاکتور ${faDigits(String(inv.receiptNo))}`) && A.includes(`جمع: ${money(Number(inv.grandTotal))} ریال`), 'sale total = recorded grandTotal')
  assert.ok(A.includes(`نقد مورد انتظار: ${money(closeAfter.expectedCash)} ریال · شمرده: ${money(closeAfter.countedCash)} ریال`), 'close numbers = recorded')
  assert.ok(A.includes(`مغایرت: ${money(Math.abs(closeAfter.cashDifference))} ریال کسری`), 'difference = recorded')
  assert.equal(A.split('🔁 تحویل شیفت · بستن صندوق').length - 1, 1, 'one message per cashSessionId')
  assert.equal(A.includes(`کد رویداد: E-${custodyClose.id}`), false, 'custody close with the same cashSessionId is not sent again')
  assert.ok(B.includes(`کد رویداد: E-${custodyOpen.id}`))
  // جزئیات «اعتبار مصرف شد»: مصرف‌کننده همان صادرکننده ⇒ ⚠️
  assert.match(A, /⚠️ 💳 اعتبار مصرف شد[\s\S]*مصرف‌کننده: علی فروشنده · صادرکننده: علی فروشنده[\s\S]*پس از صدور[\s\S]*مصرف‌کننده همان صادرکننده است/)
  // خبر «کار با مجوز یا کد»
  assert.match(A, /⚠️ ✍️ قیمت دستی · فاکتور [\s\S]*روش تأیید: مجوز راه دور · پنجرهٔ ۳/)
  const news = A.split('— — —').concat(A.split('=====')).find((m) => m.includes('🔑 کار با کد یک‌بارمصرف حساس انجام شد · اصلاح موجودی · ')) ?? ''
  assert.match(news, /⚠️ 🔑 کار با کد یک‌بارمصرف حساس انجام شد · اصلاح موجودی · [^\n]+\nسند: کالا [۰-۹]+\nروش تأیید: کد یک‌بارمصرف حساس شمارهٔ ۲ · پنجرهٔ ۱\nکاربر: علی فروشنده/, 'generic news for a row type without its own message')
  assert.equal(news.includes('مبلغ'), false, 'no amount: this row type has no allowed money field')
  assert.match(A, /⚠️ 💵 برداشت وسط شیفت · [^\n]+\nمبلغ: ۲۵۰٬۰۰۰ ریال\nکاربر: علی فروشنده\nروش تأیید: کد یک‌بارمصرف شمارهٔ ۴ · پنجرهٔ ۲/, 'amount from the row itself, with the method')
  // فیلدهای ممنوع و `note` هرگز عیناً
  const all = texts(prefix).join('\n')
  for (const value of forbiddenValues()) assert.equal(all.includes(value), false, `forbidden value never sent: ${value.slice(0, 3)}…`)
  for (const value of ['NOTE-MARKER', 'SECRETCODE1', 'SECRETCODE2', 'SECRETCODE3', 'مشتری آزمون']) assert.equal(all.includes(value), false, `never sent: ${value}`)
  for (const t of texts(prefix)) assert.ok(t.length <= 4096, 'each message within 4096')

  // نام مشتری فقط با تیک
  await sale([L(vC, 400_000)], payC(400_000), { customerId })
  await pump(engine, 3)
  assert.equal(texts(prefix, chatA).at(-1).includes('مشتری آزمون'), false, 'no customer name by default')
  await engine.setOptions({ includeCustomerName: true })
  await sale([L(vC, 400_000)], payC(400_000), { customerId })
  await pump(engine, 3)
  assert.match(texts(prefix, chatA).at(-1), /مشتری: مشتری آزمون/, 'customer name only when enabled')
  assert.equal(texts(prefix).join('\n').includes(PHONE), false)

  // ---- ۴۲۹ با retry_after، و ۴۰۳ یعنی گیرندهٔ غیرفعال
  mock.rules.push({ prefix, method: 'sendMessage', chat: chatA, directive: { status: 429, retry_after: 3 } })
  await sale([L(vC, 400_000)], payC(400_000))
  advance(1100); await engine.runOnce({ read: true })
  const after429 = mock.log.filter((e) => e.prefix === prefix && e.params?.chat_id === chatA).length
  advance(1500); await engine.runOnce()
  assert.equal(mock.log.filter((e) => e.prefix === prefix && e.params?.chat_id === chatA).length, after429, 'waits retry_after before the next attempt')
  advance(2000); await engine.runOnce()
  assert.match(texts(prefix, chatA).at(-1), /🧾 فروش/, 'delivered after retry_after')
  mock.rules.push({ prefix, method: 'sendMessage', chat: chatC, directive: { status: 403, description: 'Forbidden: bot was blocked by the user' } })
  await engine.sendTest(ids.important).catch(() => undefined)
  const blockedBefore = engine.status().recipients.find((r) => r.id === ids.important)
  assert.equal(blockedBefore.active, true, 'a failed test message does not deactivate')
  mock.rules.push({ prefix, method: 'sendMessage', chat: chatC, directive: { status: 403, description: 'Forbidden: bot was blocked by the user' } })
  await salesService.createReturn({ invoiceId: (await sale([L(vB, 700_000)], payC(700_000))).id, full: true, lines: [{ saleItemId: itemOf(seed.one('SELECT id FROM "SaleInvoice" ORDER BY id DESC LIMIT 1').id), qty: 1 }], refundMethod: 'CASH', userId: seller })
  await pump(engine, 3)
  const blocked = engine.status().recipients.find((r) => r.id === ids.important)
  assert.equal(blocked.active, false, '403 marks the recipient inactive'); assert.match(blocked.inactiveReason, /۴۰۳/)
  const cCount = mock.log.filter((e) => e.prefix === prefix && e.params?.chat_id === chatC).length
  await salesService.createReturn({ invoiceId: (await sale([L(vB, 700_000)], payC(700_000))).id, full: true, lines: [{ saleItemId: itemOf(seed.one('SELECT id FROM "SaleInvoice" ORDER BY id DESC LIMIT 1').id), qty: 1 }], refundMethod: 'CASH', userId: seller })
  await pump(engine, 3)
  assert.equal(mock.log.filter((e) => e.prefix === prefix && e.params?.chat_id === chatC).length, cCount, 'nothing is sent to an inactive recipient')

  // ---- نتیجهٔ نامعلوم ⇒ «ممکن است تکراری باشد» با همان کد رویداد
  mock.rules.push({ prefix, method: 'sendMessage', chat: chatA, directive: 'drop' })
  await sale([L(vA, 1_000_000)], payC(1_000_000))
  advance(1100); await engine.runOnce({ read: true })
  const dropped = mock.log.filter((e) => e.prefix === prefix && e.result === 'drop').at(-1)
  assert.ok(dropped, 'the server received the text, then the connection broke')
  const code = /کد رویداد: (A-\d+)/.exec(dropped.params.text)[1]
  advance(2000); await engine.runOnce()
  assert.equal(texts(prefix, chatA).some((t) => t.includes(`کد رویداد: ${code}`)), false, 'waits the 5 s backoff after an uncertain send')
  advance(3100); await engine.runOnce()
  await pump(engine, 2)
  const retried = texts(prefix, chatA).find((t) => t.includes(`کد رویداد: ${code}`))
  assert.ok(retried && retried.includes('ممکن است تکراری باشد'), 'retry carries the duplicate label and the same event code')

  // ---- صف پس از قطع و وصل؛ فروش در قطعی کامل متوقف نمی‌شود
  await serverDown()
  const outbox = join(dir, 'messenger-outbox')
  chmodSync(outbox, 0o500)
  const during = await sale([L(vB, 700_000)], payC(700_000))
  assert.ok(during?.id, 'sale works while the messenger cannot write or connect')
  await engine.runOnce({ read: true })
  chmodSync(outbox, 0o700)
  const offline = await sale([L(vC, 400_000), L(vC, 400_000, 2)], payC(1_200_000))
  advance(1100); await engine.runOnce({ read: true })
  advance(6000); await engine.runOnce({ read: true })
  const queued = engine.status().recipients.find((r) => r.id === ids.all)
  assert.ok(queued.queued >= 1 && /اتصال برقرار نشد/.test(queued.lastError ?? ''), 'queued while the network is down')
  await serverUp()
  advance(61_000); await engine.runOnce({ read: true })
  const offlineReceipt = faDigits(String(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', offline.id).receiptNo))
  assert.ok(texts(prefix, chatA).at(-1).includes(`فاکتور ${offlineReceipt}`), 'delivered after reconnect')
  const duringReceipt = faDigits(String(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', during.id).receiptNo))
  assert.ok(texts(prefix, chatA).join('\n').includes(`فاکتور ${duringReceipt}`), 'the event read while the queue folder was read-only is sent later')

  // ---- خبر تغییر تنظیمات پیش از اعمال
  const bBefore = texts(prefix, chatB).length
  await engine.updateRecipient(ids.handover, 'all')
  assert.ok(texts(prefix, chatB).slice(bBefore).some((t) => t.includes('تنظیم یک گیرنده عوض شد') && t.includes('از «تحویل شیفت» به «همه موارد»')), 'the change is announced first')
  await engine.updateRecipient(ids.handover, 'handover')
  const removedBefore = texts(prefix, chatB).length
  await engine.removeRecipient(ids.handover)
  assert.ok(texts(prefix, chatB).slice(removedBefore).some((t) => t.includes('یک گیرنده حذف شد')), 'the removed recipient hears it before removal')
  assert.equal(existsSync(join(outbox, `${ids.handover}.json`)), false, 'queue removed at once')
  assert.equal(engine.status().recipients.some((r) => r.id === ids.handover), false)

  // ---- نشانگر: ادغام، بازگردانی ناموفق، بازگردانی کامل و شروع دوباره
  setDesktopBackupHooks({ before: () => engine.beforeDatabaseOperation('backup'), after: (o) => engine.afterDatabaseOperation({ ok: o.ok, kind: 'backup', mode: o.result?.mode ?? null, willRestart: o.result?.willRestart === true }) })
  let merged = null
  await withDesktopBackupCoordination(async () => { advance(6000); await engine.runOnce({ read: true }); merged = await sale([L(vA, 1_000_000)], payC(1_000_000)); return { mode: 'merge' } })
  await engine.runOnce()
  await pump(engine, 3)
  const mergedReceipt = faDigits(String(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', merged.id).receiptNo))
  assert.ok(texts(prefix, chatA).some((t) => t.includes('ادغام بکاپ انجام شد')), 'merge notice')
  assert.equal(texts(prefix, chatA).join('\n').includes(`فاکتور ${mergedReceipt}\n`) || texts(prefix, chatA).join('\n').includes(`فاکتور ${mergedReceipt} `), false, 'rows written during the merge are not sent')
  const beforeFailed = texts(prefix, chatA).length
  await assert.rejects(withDesktopBackupCoordination(async () => { throw new Error('رمز اشتباه') }))
  await pump(engine, 2)
  assert.equal(texts(prefix, chatA).slice(beforeFailed).some((t) => t.includes('بکاپ')), false, 'a failed restore sends nothing')
  // نشانهٔ «در جریان» بیرون از پایگاه داده می‌ماند اگر برنامه وسط کار بسته شود
  engine.beforeDatabaseOperation('backup')
  engine = makeEngine(dir)
  await engine.start()
  await pump(engine, 2)
  assert.ok(texts(prefix, chatA).some((t) => t.includes('بازگردانی یا ادغام بکاپ آغاز شد ولی پایانش ثبت نشد')), 'unfinished restore is reported at the next start')
  assert.ok(texts(prefix, chatA).at(-1).includes('دفعهٔ قبل برنامه عادی بسته نشد') || texts(prefix, chatA).some((t) => t.includes('دفعهٔ قبل برنامه عادی بسته نشد')), 'unclean previous exit')
  setDesktopBackupHooks({ before: () => engine.beforeDatabaseOperation('backup'), after: (o) => engine.afterDatabaseOperation({ ok: o.ok, kind: 'backup', mode: o.result?.mode ?? null, willRestart: o.result?.willRestart === true }) })
  await withDesktopBackupCoordination(async () => ({ mode: 'replace', willRestart: true }))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(engine.isRunning(), false, 'stops after a full restore (the app relaunches)')
  const restoredNotice = texts(prefix, chatA).some((t) => t.includes('داده از بکاپ برگشت'))
  const oldSale = await sale([L(vB, 700_000)], payC(700_000))
  engine = makeEngine(dir)
  setDesktopBackupHooks(undefined)
  await engine.start()
  await pump(engine, 3)
  assert.ok(restoredNotice || texts(prefix, chatA).some((t) => t.includes('داده از بکاپ برگشت')), 'restore notice')
  assert.ok(texts(prefix, chatA).some((t) => t.includes('برنامه روشن شد') && t.includes('دفعهٔ قبل برنامه عادی بسته شد')), 'the intentional exit counts as normal')
  const oldReceipt = faDigits(String(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', oldSale.id).receiptNo))
  assert.equal(texts(prefix, chatA).some((t) => t.includes(`🧾 فروش · فاکتور ${oldReceipt}`)), false, 'after the relaunch the cursor starts from now')
  // جایگزینی پایگاه داده بیرون از برنامه: ردیف نشانگر عوض شود
  const cursorFile = JSON.parse(readFileSync(join(dir, 'messenger-cursor.json'), 'utf8'))
  sql.prepare('UPDATE "AuditLog" SET action = ? WHERE id = ?').run('SALE_UPDATE', cursorFile.auditId)
  const ghost = await sale([L(vC, 400_000)], payC(400_000))
  advance(6000); await engine.runOnce({ read: true })
  await pump(engine, 2)
  assert.ok(texts(prefix, chatA).some((t) => t.includes('پایگاه دادهٔ برنامه عوض شد')), 'database replacement detected')
  const ghostReceipt = faDigits(String(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', ghost.id).receiptNo))
  assert.equal(texts(prefix, chatA).some((t) => t.includes(`🧾 فروش · فاکتور ${ghostReceipt}`)), false, 'rows of a replaced database are not replayed')
  // صفر کردن (قلاب مرحلهٔ ۸)
  engine.beforeDatabaseOperation('reset')
  await engine.beforeFactoryReset()
  await sale([L(vA, 1_000_000)], payC(1_000_000))
  engine.afterDatabaseOperation({ ok: true, kind: 'reset' })
  await engine.runOnce()
  await pump(engine, 3)
  const resetTexts = texts(prefix, chatA).join('\n')
  assert.ok(resetTexts.includes('صفر کردن برنامه آغاز شد') && resetTexts.includes('♻️ برنامه صفر شد'), 'reset notices')

  // ---- خلاصهٔ ساعت ۲۴: به تفکیک فروشنده با عددهای گزارش رایانه، و خط شمار مجوز و کد
  await audit('ACCESS_EVENT', { kind: 'CODE_USED', titleFa: 'برگشت از فروش', number: 2, windowNo: 1 }, null, { entity: 'Access' })
  await audit('ACCESS_EVENT', { kind: 'CODE_USED', titleFa: 'تخفیف', number: 3, windowNo: 1 }, null, { entity: 'Access' })
  await audit('ACCESS_EVENT', { kind: 'REMOTE_GRANT_OPENED', titleFa: 'برگشت از فروش', windowNo: 2 }, null, { entity: 'Access' })
  await audit('ACCESS_EVENT', { kind: 'PHONE_REPORT_VIEW' }, null, { entity: 'Access' })
  await pump(engine, 3)
  assert.equal(texts(prefix).join('\n').includes('PHONE_REPORT_VIEW'), false)
  const perf = await staffReportService.performance({ fromJalali: today, toJalali: today })
  const mine = perf.rows.find((r) => r.userId === seller)
  const midnight = new Date(); midnight.setHours(24, 1, 0, 0)
  clock = Math.max(clock, midnight.getTime())
  await pump(engine, 4)
  const summary = texts(prefix, chatA).find((t) => t.includes(`📊 خلاصهٔ روز ${faDigits(today)}`))
  assert.ok(summary, 'daily summary at 24:00')
  const kinds = sql.prepare(`SELECT after FROM "AuditLog" WHERE action = 'ACCESS_EVENT'`).all().map((r) => JSON.parse(r.after).kind)
  const codes = kinds.filter((k) => k === 'CODE_USED').length, grants = kinds.filter((k) => k === 'REMOTE_GRANT_OPENED' || k === 'SCHEDULED_GRANT_OPENED').length
  assert.ok(codes >= 2 && grants >= 1)
  assert.ok(summary.includes(`امروز ${faDigits(String(grants))} مجوز و ${faDigits(String(codes))} کد مصرف شد.`), 'grants and codes line = recorded rows')
  assert.ok(summary.includes(`فاکتور ${faDigits(String(mine.invoiceCount))} · برگشت ${faDigits(String(mine.returnCount))}`), 'per-seller numbers = staff report')
  assert.match(summary, /فاکتورهای این روز در برنامه: [۰-۹]+ · پیام‌های فروش فرستاده‌شده به این گفت‌وگو: [۰-۹]+/, '«all» mode: invoices vs sent sale messages')
  assert.match(summary, /⚠️ دو روز است بکاپ موفقی گرفته نشده است/)

  // ---- انقضای ۲۴ ساعته و پیام «منقضی شد» (حذف بی‌صدا ممنوع)
  await serverDown()
  await sale([L(vA, 1_000_000)], payC(1_000_000))
  await sale([L(vB, 700_000)], payC(700_000))
  advance(6000); await engine.runOnce({ read: true })
  advance(25 * 3600_000); await engine.runOnce({ read: true })
  await serverUp()
  advance(61_000); await engine.runOnce({ read: true })
  const expiredText = texts(prefix, chatA).at(-1)
  assert.match(expiredText, /^⚠️ [۰-۹]+ پیام از .* چون بیش از ۲۴ ساعت در صف ماند فرستاده نشد/, 'expired notice')
  assert.ok(engine.status().recipients.find((r) => r.id === ids.all).expiredTotal >= 2)

  // ---- خاموش کردن: خبر پیش از اعمال، سپس هیچ اتصالی
  await engine.setEnabled(false)
  assert.ok(texts(prefix, chatA).at(-1).includes('اعلان‌ها به دست مدیر خاموش شد'), 'disable is announced first')
  const silent = requestCount()
  await sale([L(vA, 1_000_000)], payC(1_000_000))
  for (let i = 0; i < 3; i++) { advance(6000); await engine.runOnce({ read: true }) }
  engine = makeEngine(dir)
  await engine.start()
  for (let i = 0; i < 2; i++) { advance(6000); await engine.runOnce({ read: true }) }
  assert.equal(requestCount(), silent, 'off (also after a restart): no connection')
  assert.equal(engine.isRunning(), false)
  // برای بازبینی دستی متن پیام‌ها: PLAN1405_MESSENGER_DUMP=<پوشه>
  if (process.env.PLAN1405_MESSENGER_DUMP) writeFileSync(join(process.env.PLAN1405_MESSENGER_DUMP, `messenger-${provider}.txt`), mock.log.filter((e) => e.prefix === prefix && e.method === 'sendMessage').map((e) => `[chat ${e.params.chat_id} · ${e.result}]\n${e.params.text}`).join('\n\n##########\n\n') + '\n')
  return { provider, messages: texts(prefix).length }
}

test('telegram adapter: the full item-13 list on a loopback mock Bot API', { timeout: 240_000 }, async () => {
  const r = await scenario('telegram')
  console.log(`  telegram: ${r.messages} messages delivered to the mock`)
})

test('bale adapter: the same list on its own loopback path (no proxy, code pairing)', { timeout: 240_000 }, async () => {
  const r = await scenario('bale')
  console.log(`  bale: ${r.messages} messages delivered to the mock`)
})

test('a broken vault fails closed: messenger stays off and nothing is overwritten', { timeout: 60_000 }, async () => {
  const dir = join(ROOT, 'userdata-broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'messenger.vault'), Buffer.from('not-encrypted-garbage'))
  const engine = makeEngine(dir)
  const before = requestCount()
  await engine.start()
  assert.equal(engine.status().vault, 'broken')
  assert.equal(engine.isRunning(), false)
  await assert.rejects(engine.saveBot('telegram', TOKENS.telegram, ''), /خوانا نیست/)
  assert.equal(readFileSync(join(dir, 'messenger.vault'), 'utf8'), 'not-encrypted-garbage', 'never silently overwritten')
  await engine.resetVault()
  assert.equal(engine.status().vault, 'absent')
  assert.equal(requestCount(), before)
  const noStorage = createMessengerEngine({ dir: join(ROOT, 'userdata-nostorage'), storage: null, db: createMessengerDb(), summary: {}, fetchFor: () => fetch, now: () => clock, schedule: false, log: () => {} })
  await assert.rejects(noStorage.saveBot('telegram', TOKENS.telegram, ''), /ذخیره‌ساز امن/)
})

test.after(async () => { await serverDown().catch(() => undefined) })
