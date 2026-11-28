/**
 * دفتر آزمون ۴-۳۳ — فهرست «/» و گزارش‌ها در ربات تلگرام و بله، روی سرور ساختگی Bot API (loopback) با موتور واقعی
 * پیام‌رسان، پایگاه موقت، سرویس‌های واقعی فروش و خوانندهٔ واقعی گزارش گوشی:
 *  - تیک «می‌تواند گزارش‌ها را ببیند»: پیش‌فرض خاموش (گاوصندوق قدیمی بی این کلید)، جدا از اجازهٔ تأیید؛
 *  - فهرست «/» یک بار برای هر کلید ربات؛ پیام‌رسانی که پشتیبانی نکند همان «منو» را دارد؛
 *  - منو به اندازهٔ اجازه؛ منوی گیرندهٔ فقط‌تأیید همان سه دکمهٔ امروز؛ ردیف نخست هرگز دو دکمه نیست؛
 *  - هر گزارش با «امروز»، «دیروز» و «وارد کردن تاریخ» (رقم فارسی، بازه)، تاریخ نادرست و بازهٔ بیش از ۳۱ روز؛
 *  - گیرندهٔ بی‌اجازه، صفحه‌بندی با «صفحهٔ بعد»، سقف یک فرمان در ۵ ثانیه؛
 *  - عددها همان خواننده‌های برنامه و گوشی؛ نبودن کد برگشت، کد اعتبار، بارکد، تلفن، شمارهٔ پیگیری و یادداشت؛
 *    نام مشتری فقط با تیک خودش.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-33-bot-reports.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-33-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { registerPhoneReports } = await import('../../src/main/services/cloud/phoneReports.ts')
const { readPhoneReport } = await import('../../src/main/services/cloud/phoneReportSource.ts')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { createMessengerStore } = await import('../../src/main/services/cloud/messenger/messengerVault.ts')
const { parseMessengerSettings } = await import('../../src/main/services/cloud/messenger/messengerTypes.ts')
const { BOT_COMMANDS, parseBotDates } = await import('../../src/main/services/cloud/messenger/messengerBot.ts')
const { createBotRemoteBridge } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const { faDigits, jalaliAddDays, money, toJalaliDate } = await import('@shared/jalali')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// ---------------------------------------------------------------- داده‌های واقعی روی پایگاه موقت
const seller = seed.user('فروشندهٔ ۴-۳۳')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('پوشاک')
const BARCODES = []
const mk = (name, size, color, price) => {
  const id = seed.variant(seed.product(name, cat), size)
  const barcode = `880433${String(id).padStart(5, '0')}`
  sql.prepare('UPDATE "ProductVariant" SET stock = 1000, salePrice = ?, color = ?, barcode = ? WHERE id = ?').run(price, color, barcode, id)
  BARCODES.push(barcode)
  return id
}
const vCoat = mk('کت', '50', 'مشکی', 4_000_000), vPants = mk('شلوار بگ', '31', 'ذغالی', 1_500_000), vShirt = mk('پیراهن', 'L', 'آبی', 700_000)
const PHONE = '09120000433'
const debtor = { firstName: 'مشتری', lastName: 'نسیه‌ای', phone: PHONE }
const today = toJalaliDate(new Date())
const yesterday = jalaliAddDays(today, -1)
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const L = (v, unitPrice, qty = 1) => ({ variantId: v, qty, unitPrice, discount: 0, tax: 0 })
const sale = (lines, payments, extra = {}) => salesService.create({ userId: seller, shiftId, lines, payments, ...extra })
const itemOf = (invoiceId, variantId) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? AND variantId = ? ORDER BY id LIMIT 1', invoiceId, variantId).id
const receipt = (id) => seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', id).receiptNo
const rialText = (n) => `${money(Number(n))} ریال`
/** دفتر آزمون ۴-۳۵: خط زیر سرتیتر؛ قلم‌ها و ردیف‌ها فهرست شماره‌دار «  ۱) …» */
const DIV = '━━━━━━━━━━━━'
const numbered = (text, body) => new RegExp(`^ {2}[۰-۹]+\\) ${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text)

const sCash = await sale([L(vCoat, 4_000_000), L(vPants, 1_500_000, 2)], [{ methodId: cash, amount: 7_000_000, destination: 'CASH' }])
const sCredit = await sale([L(vShirt, 700_000, 2)], [{ methodId: cash, amount: 400_000, destination: 'CASH' }], { debtor })
const sReturn = await sale([L(vPants, 1_500_000)], [{ methodId: card, amount: 1_500_000, destination: 'CARD' }])
await salesService.createReturn({ invoiceId: sReturn.id, full: true, lines: [{ saleItemId: itemOf(sReturn.id, vPants), qty: 1 }], refundMethod: 'CASH', userId: seller })
const sEx = await sale([L(vCoat, 4_000_000)], [{ methodId: cash, amount: 4_000_000, destination: 'CASH' }])
await salesService.createExchange({ userId: seller, shiftId, invoiceId: sEx.id, lines: [{ saleItemId: itemOf(sEx.id, vCoat), qty: 1 }], replacements: [L(vShirt, 700_000)], refundMode: 'STORE_CREDIT', idempotencyKey: 'tl-4-33-exchange' })
for (let i = 0; i < 5; i++) await sale([L(vShirt, 700_000)], [{ methodId: cash, amount: 700_000, destination: 'CASH' }])
const sOld = await sale([L(vPants, 1_500_000)], [{ methodId: cash, amount: 1_500_000, destination: 'CASH' }])
await db.saleInvoice.update({ where: { id: sOld.id }, data: { issuedAt: new Date(Date.now() - 86_400_000), issuedAtJalali: yesterday } })
// کارت‌به‌کارت مدیر: در انتظار امروز، پرداخت‌شدهٔ امروز و در انتظارِ سه روز پیش (قلم‌ها با کد و بارکد، یادداشت با شمارهٔ کارت)
const ctcItems = JSON.stringify([{ name: 'شلوار بگ سایز ۳۱ - ذغالی', qty: 1, unitPrice: 1_500_000, code: 'SKU-SECRET-1', barcode: BARCODES[1] }])
const ctcPending = await db.cardTransferRequest.create({ data: {
  kind: 'REQUEST', status: 'PENDING', operationKind: 'RETURN', returnId: 9001, sourceInvoiceId: sReturn.id, sourceReceiptNo: receipt(sReturn.id),
  invoiceTotal: 1_500_000, returnTotal: 1_500_000, amount: 1_500_000, itemsJson: ctcItems, userId: seller, userName: 'فروشندهٔ ۴-۳۳',
  createdAt: new Date(), createdAtJalali: today, createdAtTime: '10:15', note: 'کارت مشتری 6037991234567890'
} })
const ctcPaid = await db.cardTransferRequest.create({ data: {
  kind: 'REQUEST', status: 'PAID', operationKind: 'EXCHANGE', returnId: 9002, sourceInvoiceId: sEx.id, sourceReceiptNo: receipt(sEx.id), exchangeReceiptNo: 77,
  invoiceTotal: 700_000, returnTotal: 900_000, amount: 200_000, itemsJson: ctcItems, userId: seller, userName: 'فروشندهٔ ۴-۳۳',
  createdAt: new Date(), createdAtJalali: today, createdAtTime: '10:40', paidAmount: 200_000, paidAt: new Date(), paidAtJalali: today, paidAtTime: '11:05',
  paidMethod: 'CARD', trackingNo: 'TRK-SECRET-77', paidByUserName: 'مدیر فروشگاه', cancelReason: null
} })
await db.cardTransferRequest.create({ data: {
  kind: 'REQUEST', status: 'PENDING', operationKind: 'RETURN', returnId: 9003, amount: 300_000, userName: 'فروشندهٔ ۴-۳۳',
  createdAt: new Date(Date.now() - 3 * 86_400_000), createdAtJalali: jalaliAddDays(today, -3), createdAtTime: '09:00'
} })
const expected = await cashboxService.expected({ shiftId }).then((r) => Number(r?.expectedCash ?? 0))
await cashboxService.close({ shiftId, explicitShift: true, userId: seller, countedCash: expected - 50_000, closeShift: false, note: `کسری ${PHONE}` })

const secrets = () => {
  const out = [PHONE, 'SKU-SECRET-1', 'TRK-SECRET-77', '6037991234567890', ...BARCODES]
  for (const r of sql.prepare('SELECT code, legacyCode FROM "StoreCredit"').all()) { if (r.code) out.push(r.code); if (r.legacyCode) out.push(r.legacyCode) }
  for (const r of sql.prepare('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').all()) out.push(r.returnCode)
  return out.filter((v) => typeof v === 'string' && v.length >= 4)
}
assert.ok(secrets().length >= 8, 'the scenario has credit codes, return codes, barcodes and a phone to hide')

// ---------------------------------------------------------------- ذخیره‌ساز امن ساختگی و سرور ساختگی Bot API
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
const mock = { log: [], updates: { tg: [], bale: [] }, nextId: 1, port: 0, server: null }
await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const m = /^\/(tg|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      if (!m) return send(404, { ok: false, description: 'Not Found' })
      const [, prefix, , method] = m
      let params = {}
      try { params = JSON.parse(body || '{}') } catch {}
      mock.log.push({ prefix, method, params })
      if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: `${prefix}_shop_bot` } })
      if (method === 'getUpdates') {
        const offset = Number(params.offset) || 0
        mock.updates[prefix] = mock.updates[prefix].filter((u) => u.update_id >= offset)
        return send(200, { ok: true, result: mock.updates[prefix] })
      }
      if (method === 'sendMessage') {
        if (String(params.text ?? '').length > 4096) return send(400, { ok: false, description: 'Bad Request: message is too long' })
        return send(200, { ok: true, result: { message_id: mock.nextId++ } })
      }
      if (method === 'answerCallbackQuery' || method === 'editMessageText') return send(200, { ok: true, result: true })
      // تلگرام فهرست «/» را می‌پذیرد؛ بلهٔ ساختگی آن را نمی‌شناسد
      if (method === 'setMyCommands' && prefix === 'tg') return send(200, { ok: true, result: true })
      return send(404, { ok: false, description: 'Not Found' })
    })
  })
  server.listen(0, '127.0.0.1', () => { mock.server = server; mock.port = server.address().port; resolve() })
})

// ---------------------------------------------------------------- گیرنده‌ها، موتور و خوانندهٔ گزارش گوشی
const V = { id: 'aaaaaaaa4331', provider: 'telegram', chatId: 4331, name: 'مدیر گزارش‌خوان', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: false, canViewReports: true }
// گاوصندوق قدیمی: کلید canViewReports ندارد
const A = { id: 'bbbbbbbb4332', provider: 'telegram', chatId: 4332, name: 'تأییدکننده', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: true }
const B = { id: 'cccccccc4333', provider: 'bale', chatId: 4333, name: 'مالک بله', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: true, canViewReports: true }
const STRANGER = 4339
const dir = join(ROOT, 'userdata'); mkdirSync(dir, { recursive: true })
const store = createMessengerStore(dir, storage)
store.writeSettings({
  version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: true,
  bots: { telegram: { token: TOKENS.telegram, username: 'tg_shop_bot', proxy: '' }, bale: { token: TOKENS.bale, username: 'bale_shop_bot', proxy: '' } },
  recipients: [V, A, B]
})
registerPhoneReports()
let clock = Date.now()
const remote = createBotRemoteBridge({ available: async () => true, closeAll: () => {}, note: () => {} })
const engine = createMessengerEngine({
  dir, storage, db: createMessengerDb(),
  summary: {
    salesSummary: (f) => salesService.summary(f),
    staffPerformance: (f) => staffReportService.performance(f),
    abnormalDiscounts: (f) => staffReportService.abnormalDiscounts(f),
    lastBackupAt: async () => null
  },
  fetchFor: () => (url, init) => fetch(url, init),
  baseUrls: { telegram: `http://127.0.0.1:${mock.port}/tg`, bale: `http://127.0.0.1:${mock.port}/bale` },
  now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0, botPollSeconds: 0, remote
})
await engine.start()

let uid = 1000
const queuePress = (provider, chatId, data) =>
  mock.updates[PREFIX[provider]].push({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: 'private' }, text: 'پیام' }, data } })
const press = async (provider, chatId, data) => { clock += 6000; queuePress(provider, chatId, data); return engine.botPollOnce(provider, 0) }
const say = async (provider, chatId, text) => {
  clock += 6000
  mock.updates[PREFIX[provider]].push({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' }, text, date: Math.floor(clock / 1000) } })
  return engine.botPollOnce(provider, 0)
}
const sendsSince = (mark, provider, chatId) => mock.log.slice(mark).filter((e) => e.method === 'sendMessage' && e.prefix === PREFIX[provider] && e.params.chat_id === chatId)
const textSince = (mark, provider, chatId) => sendsSince(mark, provider, chatId).map((e) => e.params.text).join('\n')
const answersSince = (mark, provider) => mock.log.slice(mark).filter((e) => e.method === 'answerCallbackQuery' && e.prefix === PREFIX[provider]).map((e) => e.params.text ?? '')
const buttonsOf = (entry) => (entry?.params.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data)
/** یک گزارش: دکمهٔ گزارش، سپس «امروز» یا «دیروز»؛ متن همهٔ پیام‌های گزارش برمی‌گردد. */
async function report(provider, chatId, key, which = 't') {
  await press(provider, chatId, `p:${key}`)
  const mark = mock.log.length
  await press(provider, chatId, `q:${key}:${which}`)
  return { mark, text: textSince(mark, provider, chatId), sends: sendsSince(mark, provider, chatId) }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

test('vault: «can view reports» is off by default (old vaults) and separate from approval; the settings channel and page carry it', async () => {
  const base = { version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: false, bots: {} }
  const old = { ...A }
  assert.equal(parseMessengerSettings({ ...base, recipients: [old] }).recipients[0].canViewReports, false, 'missing key ⇒ off')
  assert.equal(parseMessengerSettings({ ...base, recipients: [{ ...old, canViewReports: true }] }).recipients[0].canViewReports, true)
  assert.equal(parseMessengerSettings({ ...base, recipients: [{ ...old, canViewReports: 'yes' }] }), null, 'a wrong type is a broken vault')
  const status = engine.status().recipients
  assert.deepEqual(status.map((r) => [r.id, r.canApprove, r.canViewReports]), [[V.id, false, true], [A.id, true, false], [B.id, true, true]])
  const mark = mock.log.length
  await engine.setRecipientReports(A.id, true)
  assert.equal(store.readSettings().settings.recipients.find((r) => r.id === A.id).canViewReports, true)
  assert.equal(store.readSettings().settings.recipients.find((r) => r.id === A.id).canApprove, true, 'approval untouched')
  await engine.setRecipientReports(A.id, false)
  assert.equal(store.readSettings().settings.recipients.find((r) => r.id === A.id).canViewReports, false)
  clock += 1100; await engine.runOnce({})
  assert.ok(mock.log.slice(mark).some((e) => e.method === 'sendMessage' && String(e.params.text).includes('🤖 اجازهٔ دیدن گزارش‌ها با ربات به یک گیرنده داده شد')), 'the change is announced to everyone')
  const ipc = read('src/main/services/cloud/messenger/messengerIpc.ts')
  const handler = ipc.slice(ipc.indexOf('handle(IPC.messengerRecipientUpdate, ACTION,'), ipc.indexOf('handle(IPC.messengerRecipientRemove'))
  assert.match(handler, /setRecipientReports\(input\.id, input\.canViewReports\)/, 'the existing «recipient settings» channel, behind the typed manager password')
  const page = read('src/renderer/src/components/MessengerSettings.tsx')
  assert.match(page, /CH\.messengerRecipientUpdate, \{ id: r\.id, canViewReports: e\.target\.checked \}/)
  assert.ok(page.includes('می‌تواند گزارش‌ها را با ربات ببیند'))
})

test('the «/» list is registered once per bot key; a messenger without it keeps «منو»', async () => {
  const mark = mock.log.length
  clock += 1100; await engine.runOnce({}); await settle()
  const sent = (prefix) => mock.log.slice(mark).filter((e) => e.method === 'setMyCommands' && e.prefix === prefix)
  assert.equal(sent('tg').length, 1)
  assert.deepEqual(sent('tg')[0].params.commands, BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })))
  for (const c of BOT_COMMANDS) assert.match(c.command, /^[a-z]{1,32}$/, 'a valid Bot API command name')
  assert.deepEqual(BOT_COMMANDS.map((c) => c.command), ['menu', 'sales', 'returns', 'exchanges', 'credit', 'cardtransfer', 'cashbox', 'status', 'today', 'grants', 'closeall'])
  assert.equal(sent('bale').length, 1, 'bale is tried once')
  clock += 1100; await engine.runOnce({}); await settle()
  assert.equal(sent('tg').length, 1, 'telegram accepted it: not sent again')
  assert.equal(sent('bale').length, 1, 'bale refused it: not retried within the hour')
  clock += 61 * 60_000; await engine.runOnce({}); await settle()
  assert.equal(sent('tg').length, 1)
  assert.equal(sent('bale').length, 2, 'bale is retried after an hour')
  const before = mock.log.length
  await say('bale', B.chatId, 'منو')
  assert.equal(sendsSince(before, 'bale', B.chatId).at(-1)?.params.text, '🤖 منوی ربات فروشگاه', 'bale still has the menu word')
})

test('menu by permission: approval-only keeps today\'s three buttons; reports only with their own tick; never two buttons in the first row', async () => {
  let mark = mock.log.length
  await say('telegram', A.chatId, 'منو')
  const approverMenu = sendsSince(mark, 'telegram', A.chatId).at(-1)
  assert.deepEqual(buttonsOf(approverMenu), ['m:close', 'm:list', 'm:sum'])
  mark = mock.log.length
  await say('telegram', V.chatId, '/menu@tg_shop_bot')
  const viewerMenu = sendsSince(mark, 'telegram', V.chatId).at(-1)
  assert.deepEqual(buttonsOf(viewerMenu), ['p:s', 'p:r', 'p:x', 'p:c', 'p:k', 'p:b', 'm:now', 'm:sum'])
  assert.equal(viewerMenu.params.reply_markup.inline_keyboard[0].length, 1)
  mark = mock.log.length
  await say('bale', B.chatId, '/start')
  const bothMenu = sendsSince(mark, 'bale', B.chatId).at(-1)
  assert.deepEqual(buttonsOf(bothMenu), ['m:close', 'p:s', 'p:r', 'p:x', 'p:c', 'p:k', 'p:b', 'm:now', 'm:list', 'm:sum'])
  assert.equal(bothMenu.params.reply_markup.inline_keyboard[0].length, 1)
  const labels = bothMenu.params.reply_markup.inline_keyboard.flat().map((b) => b.text)
  for (const t of ['🧾 فروش', '↩️ برگشت از فروش', '🔁 تعویض', '📒 نسیه', '💳 کارت به کارت مدیر', '🧮 صندوق و مغایرت‌ها', '👤 وضعیت الان', '📋 مجوزهای باز', '📊 خلاصهٔ امروز']) assert.ok(labels.includes(t), t)
  mark = mock.log.length
  await press('telegram', V.chatId, 'm:sum')
  assert.match(textSince(mark, 'telegram', V.chatId), /^📊 خلاصهٔ امروز/, 'the day summary is a report too')
})

test('a recipient without the permission gets a refusal; a stranger gets nothing new', async () => {
  let mark = mock.log.length
  await press('telegram', A.chatId, 'p:s')
  assert.deepEqual(answersSince(mark, 'telegram'), ['این گفت‌وگو اجازهٔ دیدن گزارش‌ها را ندارد.'])
  assert.equal(sendsSince(mark, 'telegram', A.chatId).length, 0)
  mark = mock.log.length
  await say('telegram', A.chatId, '/sales')
  assert.equal(textSince(mark, 'telegram', A.chatId), 'این گفت‌وگو اجازهٔ دیدن گزارش‌ها را ندارد.')
  mark = mock.log.length
  await press('telegram', V.chatId, 'm:close')
  await press('telegram', V.chatId, 'm:list')
  assert.deepEqual(answersSince(mark, 'telegram'), ['این گفت‌وگو اجازهٔ تأیید ندارد.', 'این گفت‌وگو اجازهٔ تأیید ندارد.'])
  mark = mock.log.length
  await say('telegram', V.chatId, '/closeall')
  assert.equal(textSince(mark, 'telegram', V.chatId), 'این گفت‌وگو اجازهٔ تأیید ندارد.')
  mark = mock.log.length
  await press('telegram', STRANGER, 'p:s')
  await say('telegram', STRANGER, '/sales')
  await say('telegram', STRANGER, 'منو')
  assert.deepEqual(answersSince(mark, 'telegram'), ['این گفت‌وگو اجازهٔ تأیید ندارد.'], 'the same answer as before 4-33')
  assert.equal(sendsSince(mark, 'telegram', STRANGER).length, 0)
})

test('sales: summary from the sales report, every line with name, size, colour, qty and price, today and yesterday', async () => {
  const mark0 = mock.log.length
  await press('telegram', V.chatId, 'p:s')
  const picker = sendsSince(mark0, 'telegram', V.chatId).at(-1)
  assert.equal(picker.params.text, '🧾 فروش\nکدام روز؟')
  assert.deepEqual(picker.params.reply_markup.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data])), [[['امروز', 'q:s:t'], ['دیروز', 'q:s:y'], ['وارد کردن تاریخ', 'q:s:d']]])
  const mark = mock.log.length
  await press('telegram', V.chatId, 'q:s:t')
  const text = textSince(mark, 'telegram', V.chatId)
  const sum = await salesService.summary({ fromJalali: today, toJalali: today })
  assert.ok(text.startsWith(`🧾 فروش · ${faDigits(today)}\n${DIV}\n🕘 زمان گزارش: `), text.slice(0, 120))
  assert.ok(text.includes(`شمار فاکتور: ${faDigits(sum.count)} · جمع فروش: ${rialText(sum.grandTotal)}`), 'the same numbers as the sales report')
  assert.ok(text.includes(`نقد: ${rialText(sum.cashTotal)} · کارتخوان: ${rialText(sum.cardTotal)} · حساب مدیر: ${rialText(sum.managerAccountTotal)}`))
  assert.ok(text.includes(`سایر (چک و…): ${rialText(sum.otherTotal)} · نسیه: ${rialText(sum.creditTotal)}`))
  assert.ok(text.includes(`🧾 فاکتور ${faDigits(receipt(sCash.id))} · ${faDigits(today)} ساعت `))
  assert.ok(numbered(text, `شلوار بگ سایز ۳۱ - ذغالی — ۲ × ${money(1_500_000)} = ${rialText(3_000_000)}`), text)
  assert.ok(numbered(text, `کت سایز ۵۰ - مشکی — ۱ × ${money(4_000_000)}`))
  assert.ok(text.includes('فروشنده: فروشندهٔ ۴-۳۳'))
  assert.equal(text.includes('مشتری: '), false, 'no customer name without its tick')
  assert.equal(text.includes(`فاکتور ${faDigits(receipt(sOld.id))} ·`), false, 'yesterday\'s invoice is not today')
  const y = await report('telegram', V.chatId, 's', 'y')
  const ySum = await salesService.summary({ fromJalali: yesterday, toJalali: yesterday })
  assert.ok(y.text.startsWith(`🧾 فروش · ${faDigits(yesterday)}`))
  assert.ok(y.text.includes(`شمار فاکتور: ${faDigits(ySum.count)} ·`))
  assert.ok(y.text.includes(`🧾 فاکتور ${faDigits(receipt(sOld.id))} · ${faDigits(yesterday)}`))
})

test('typed date: Persian digits, a range, a wrong date and a range over 31 days', async () => {
  assert.deepEqual(parseBotDates('۱۴۰۵/۰۹/۰۳'), { ok: true, from: '1405/09/03', to: '1405/09/03' })
  assert.deepEqual(parseBotDates('1405/9/3'), { ok: true, from: '1405/09/03', to: '1405/09/03' })
  assert.deepEqual(parseBotDates('۱۴۰۵/۰۹/۰۱ تا ۱۴۰۵/۰۹/۰۳'), { ok: true, from: '1405/09/01', to: '1405/09/03' })
  assert.deepEqual(parseBotDates('از 1405/09/03 تا 1405/09/01'), { ok: true, from: '1405/09/01', to: '1405/09/03' })
  assert.deepEqual(parseBotDates('1405-09-01 - 1405-09-03'), { ok: true, from: '1405/09/01', to: '1405/09/03' })
  assert.deepEqual(parseBotDates('1405/13/01'), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseBotDates('فردا'), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseBotDates('1405/01/01 تا 1405/01/02 تا 1405/01/03'), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseBotDates('1405/01/01 تا 1405/03/01'), { ok: false, reason: 'long' })
  assert.deepEqual(parseBotDates('1405/01/01 تا 1405/01/31'), { ok: true, from: '1405/01/01', to: '1405/01/31' }, '31 days like the phone')
  await press('telegram', V.chatId, 'p:s')
  let mark = mock.log.length
  await press('telegram', V.chatId, 'q:s:d')
  assert.equal(textSince(mark, 'telegram', V.chatId), '🧾 فروش\nتاریخ را بنویسید، مثل ۱۴۰۵/۰۹/۰۳؛ برای بازه: ۱۴۰۵/۰۹/۰۱ تا ۱۴۰۵/۰۹/۰۳ (حداکثر ۳۱ روز).')
  mark = mock.log.length
  await say('telegram', V.chatId, 'فردا')
  assert.match(textSince(mark, 'telegram', V.chatId), /^تاریخ درست نیست\. تاریخ را بنویسید/)
  mark = mock.log.length
  await say('telegram', V.chatId, `${faDigits(jalaliAddDays(today, -40))} تا ${faDigits(today)}`)
  assert.match(textSince(mark, 'telegram', V.chatId), /^بازه بیشتر از ۳۱ روز است\./)
  mark = mock.log.length
  await say('telegram', V.chatId, `${faDigits(yesterday)} تا ${faDigits(today)}`)
  const text = textSince(mark, 'telegram', V.chatId)
  const sum = await salesService.summary({ fromJalali: yesterday, toJalali: today })
  assert.ok(text.startsWith(`🧾 فروش · از ${faDigits(yesterday)} تا ${faDigits(today)}`), text.slice(0, 200))
  assert.ok(text.includes(`شمار فاکتور: ${faDigits(sum.count)} ·`))
  mark = mock.log.length
  await say('telegram', V.chatId, faDigits(today))
  assert.equal(sendsSince(mark, 'telegram', V.chatId).length, 0, 'the waiting state is used once')
  // سه بار تاریخ نادرست ⇐ پایان حالت انتظار
  await press('telegram', V.chatId, 'p:c'); await press('telegram', V.chatId, 'q:c:d')
  await say('telegram', V.chatId, 'x'); await say('telegram', V.chatId, 'y')
  mark = mock.log.length
  await say('telegram', V.chatId, 'z')
  assert.match(textSince(mark, 'telegram', V.chatId), /دوباره از منو شروع کنید\.$/)
  mark = mock.log.length
  await say('telegram', V.chatId, faDigits(today))
  assert.equal(sendsSince(mark, 'telegram', V.chatId).length, 0)
})

test('long list: page by page with «صفحهٔ بعد», every invoice once; a tampered page button is expired; five-second limit', async () => {
  const sum = await salesService.summary({ fromJalali: today, toJalali: today, take: 100 })
  assert.ok(sum.count > 8, 'more than one page')
  const first = await report('telegram', V.chatId, 's', 't')
  const last = first.sends.at(-1)
  const next = `g:s:${today.replace(/\//g, '')}:${today.replace(/\//g, '')}:1`
  assert.deepEqual(buttonsOf(last), [next])
  assert.equal(last.params.reply_markup.inline_keyboard[0][0].text, 'صفحهٔ بعد ◀️')
  assert.ok(first.text.includes(`صفحهٔ ۱ از ${faDigits(Math.ceil(sum.count / 8))}`))
  const mark = mock.log.length
  await press('telegram', V.chatId, next)
  const second = sendsSince(mark, 'telegram', V.chatId)
  const secondText = second.map((e) => e.params.text).join('\n')
  assert.ok(secondText.startsWith(`🧾 فروش · ${faDigits(today)}\n${DIV}\nصفحهٔ ۲ از ${faDigits(Math.ceil(sum.count / 8))}`), secondText.slice(0, 120))
  assert.equal(buttonsOf(second.at(-1)).length, 0, 'no button on the last page')
  const seen = [...`${first.text}\n${secondText}`.matchAll(/🧾 فاکتور ([۰-۹]+)/g)].map((m) => m[1])
  const inTimeOrder = [...sum.rows].sort((a, b) => `${a.dateJalali} ${a.time}`.localeCompare(`${b.dateJalali} ${b.time}`) || a.receiptNo - b.receiptNo)
  assert.deepEqual(seen, inTimeOrder.map((r) => faDigits(r.receiptNo)), 'every invoice of the day once, oldest first across pages')
  for (const e of [...first.sends, ...second]) assert.ok(e.params.text.length <= 3900)
  let m2 = mock.log.length
  await press('telegram', V.chatId, `g:s:${jalaliAddDays(today, -40).replace(/\//g, '')}:${today.replace(/\//g, '')}:1`)
  assert.deepEqual(answersSince(m2, 'telegram'), ['منقضی شد'])
  m2 = mock.log.length
  clock += 6000
  queuePress('telegram', V.chatId, 'p:s'); queuePress('telegram', V.chatId, 'p:r')
  await engine.botPollOnce('telegram', 0)
  assert.deepEqual(answersSince(m2, 'telegram'), ['', 'کمی صبر کنید؛ هر ۵ ثانیه یک فرمان.'])
})

test('returns and exchanges: the phone «returns» reader, refund method, both lists, prices, difference and store credit without its code', async () => {
  const phone = await readPhoneReport('returns', { fromDay: today, toDay: today, page: 0 }, 'آزمون ۴-۳۳')
  const ret = phone.rows.find((r) => r.kind === 'برگشت'), ex = phone.rows.find((r) => r.kind === 'تعویض')
  const r = await report('telegram', V.chatId, 'r')
  assert.ok(r.text.startsWith(`↩️ برگشت از فروش · ${faDigits(today)}`))
  assert.ok(r.text.includes(`شمار در این بازه: ${faDigits(phone.rows.filter((x) => x.kind === 'برگشت').length)}`))
  assert.ok(r.text.includes(`↩️ برگشت · سند ${faDigits(ret.id)} · فاکتور ${faDigits(receipt(sReturn.id))} · `))
  assert.ok(r.text.includes(`مبلغ برگشت: ${rialText(ret.total)} · بازپرداخت: ${ret.refundMethodLabel}`), r.text)
  assert.ok(numbered(r.text, `شلوار بگ سایز ۳۱ - ذغالی — ۱ × ${money(1_500_000)}`), r.text)
  assert.ok(r.text.includes('فروشندهٔ فاکتور: فروشندهٔ ۴-۳۳ · ثبت‌کننده: '))
  assert.equal(r.text.includes('🔁 تعویض ·'), false)
  const x = await report('telegram', V.chatId, 'x')
  const exInvoice = seed.one('SELECT receiptNo, grandTotal FROM "SaleInvoice" WHERE orderType = \'EXCHANGE\' ORDER BY id DESC LIMIT 1')
  assert.ok(x.text.includes(`🔁 تعویض · سند ${faDigits(ex.id)} · فاکتور ${faDigits(receipt(sEx.id))} · `))
  assert.ok(x.text.includes(`جمع کالای برگشتی: ${rialText(ex.total)} · مبلغ فاکتور جایگزین: ${rialText(exInvoice.grandTotal)}`), x.text)
  assert.ok(x.text.includes(`مابه‌التفاوت: ${rialText(ex.exchangeDiff)}`))
  assert.ok(x.text.includes(`اعتبار خرید: ${rialText(ex.storeCreditTotal)}`))
  assert.ok(x.text.includes(`↩️ کالای برگشتی:\n  ۱) کت سایز ۵۰ - مشکی — ۱ × ${money(4_000_000)}`), x.text)
  assert.ok(x.text.includes(`🛍 کالای جایگزین (فاکتور ${faDigits(exInvoice.receiptNo)}):\n  ۱) پیراهن سایز L - آبی — ۱ × ${money(700_000)}`))
  assert.equal(x.text.includes('↩️ برگشت ·'), false)
})

test('نسیه: invoices of the range that still owe, with the sales report\'s own remainder; customer name only with its tick', async () => {
  const sum = await salesService.summary({ fromJalali: today, toJalali: today, take: 100 })
  const owing = sum.rows.filter((row) => row.remaining > 0)
  const credit = owing.find((row) => row.id === sCredit.id)
  assert.ok(credit && credit.remaining > 0)
  const c = await report('telegram', V.chatId, 'c')
  assert.ok(c.text.includes(`فاکتورهای این بازه که هنوز مانده دارند: ${faDigits(owing.length)} · جمع مانده: ${rialText(owing.reduce((s, row) => s + row.remaining, 0))}`), c.text)
  assert.ok(c.text.includes(`📒 فاکتور ${faDigits(receipt(sCredit.id))} · ${faDigits(today)} ساعت `))
  assert.ok(c.text.includes(` · ${rialText(credit.grandTotal)} · مانده: ${rialText(credit.remaining)}`))
  assert.ok(numbered(c.text, `پیراهن سایز L - آبی — ۲ × ${money(700_000)}`), c.text)
  assert.equal(c.text.includes(`📒 فاکتور ${faDigits(receipt(sCash.id))} ·`), false, 'a paid invoice is not نسیه')
  assert.equal(c.text.includes('مشتری: '), false)
  await engine.setOptions({ includeCustomerName: true })
  const named = await report('telegram', V.chatId, 'c')
  assert.ok(named.text.includes('مشتری: مشتری نسیه‌ای · فروشنده:'), 'the person who took the credit (the debtor written on the invoice)')
  const reader = read('src/main/services/cloud/messenger/messengerDb.ts')
  const debtorReader = reader.slice(reader.indexOf('async function botDebtorNames'), reader.indexOf('async function botReturnDocs'))
  assert.match(debtorReader, /select: \{ id: true, debtorFirstName: true, debtorLastName: true \}/, 'name only, never the phone or national id')
  await engine.setOptions({ includeCustomerName: false })
})

test('card-to-card: pending and paid of the range, which return or exchange, items, seller, status; older pending counted; no card number or tracking', async () => {
  const k = await report('telegram', V.chatId, 'k')
  assert.ok(k.text.startsWith(`💳 کارت به کارت مدیر · ${faDigits(today)}`))
  assert.ok(k.text.includes('شمار ردیف‌ها در این بازه: ۲'))
  assert.ok(k.text.includes(`در انتظار پرداخت از روزهای قبل: ۱ درخواست · جمع ${rialText(300_000)}`))
  assert.ok(k.text.includes(`💳 درخواست ${faDigits(ctcPending.id)} · در انتظار پرداخت · ${faDigits(today)} ساعت ۱۰:۱۵`), k.text)
  assert.ok(k.text.includes(`برای برگشت سند ۹۰۰۱ · فاکتور ${faDigits(receipt(sReturn.id))}`))
  assert.ok(k.text.includes(`مبلغ: ${rialText(1_500_000)} · فروشنده: فروشندهٔ ۴-۳۳`))
  assert.ok(k.text.includes(`💳 درخواست ${faDigits(ctcPaid.id)} · پرداخت شد · `))
  assert.ok(k.text.includes(`برای تعویض سند ۹۰۰۲ · فاکتور ${faDigits(receipt(sEx.id))} · فاکتور تعویض ۷۷`))
  assert.ok(k.text.includes(`پرداخت: ${rialText(200_000)} · ${faDigits(today)} ساعت ۱۱:۰۵ · مدیر فروشگاه`))
  assert.ok(numbered(k.text, `شلوار بگ سایز ۳۱ - ذغالی — ۱ × ${money(1_500_000)}`), k.text)
  const src = read('src/main/services/cloud/messenger/messengerDb.ts')
  const reader = src.slice(src.indexOf('async function botCardTransfers'), src.indexOf('async function botCustodyNow'))
  for (const col of ['note', 'trackingNo', 'cancelReason', 'adjustReason', 'stockNote', 'paidMethod']) assert.equal(new RegExp(`[{ ,]${col}: true`).test(reader), false, `the card-to-card reader never selects ${col}`)
})

test('cashbox: the phone «cashbox closes» reader with its own labels; the close note never appears', async () => {
  const phone = await readPhoneReport('cashbox', { fromDay: today, toDay: today, page: 0 }, 'آزمون ۴-۳۳')
  assert.ok(phone.rows.length >= 1)
  const b = await report('telegram', V.chatId, 'b')
  assert.ok(b.text.startsWith(`🧮 صندوق و مغایرت‌ها · ${faDigits(today)}`))
  assert.ok(b.text.includes(`شمار در این بازه: ${faDigits(phone.totals.count)}`))
  const row = phone.rows[0]
  assert.ok(numbered(b.text, `روز: ${faDigits(row.dayJalali)} · شیفت: ${row.shiftName} · فاکتور: ${faDigits(row.invoiceCount)} · نقد: ${rialText(row.cashTotal)}`), b.text)
  assert.ok(b.text.includes(`اختلاف نقد: ${rialText(row.diff)}`))
  assert.equal(b.text.includes('کسری'), false, 'the free note of the close is not a report field')
})

test('status now: who holds the drawer, since when, which shift, and the open grants', async () => {
  let mark = mock.log.length
  await press('telegram', V.chatId, 'm:now')
  let text = textSince(mark, 'telegram', V.chatId)
  assert.match(text, /^👤 وضعیت الان · /)
  assert.ok(text.includes('الان صندوق دست کسی نیست.'))
  assert.ok(text.includes('شیفت‌های باز: صبح (فروشندهٔ ۴-۳۳) از '), text)
  assert.ok(text.includes('مجوزهای باز:\nالان هیچ مجوز راه دوری باز نیست.'))
  // وضعیت حضانت را خود سرویس‌ها ساخته‌اند (NO_SESSION)؛ این‌جا صندوق به همان شیفت سپرده می‌شود
  await db.custodyState.upsert({ where: { key: 'MAIN' }, update: { state: 'ACTIVE', activeShiftId: shiftId }, create: { key: 'MAIN', state: 'ACTIVE', activeShiftId: shiftId, epoch: 1 } })
  const meta = { custodianUserId: seller, openAuth: 'PIN', rolloverAt: new Date(clock + 86_400_000), operationalDay: today, openEpoch: 1, scheduledEndAt: new Date(clock + 2 * 3_600_000) }
  await db.custodyShiftMeta.upsert({ where: { shiftId }, update: meta, create: { shiftId, ...meta } })
  mark = mock.log.length
  await say('telegram', V.chatId, '/status')
  text = textSince(mark, 'telegram', V.chatId)
  assert.ok(text.includes('صندوق دست فروشندهٔ ۴-۳۳ است، از '), text)
  assert.ok(text.includes(' · شیفت: صبح · پایان برنامهٔ شیفت: ساعت '))
  assert.equal(text.includes('شیفت‌های باز:'), false)
  mark = mock.log.length
  await press('telegram', A.chatId, 'm:now')
  assert.deepEqual(answersSince(mark, 'telegram'), ['این گفت‌وگو اجازهٔ دیدن گزارش‌ها را ندارد.'])
})

test('privacy: no phone, credit code, return code, barcode, tracking number or card number in anything the bot sent', () => {
  const texts = mock.log.filter((e) => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(e.method)).map((e) => String(e.params.text ?? ''))
  assert.ok(texts.length > 40)
  const all = texts.join('\n')
  for (const s of secrets()) assert.equal(all.includes(s), false, `never «${s}»`)
  assert.equal(all.includes(faDigits(PHONE)), false)
  mock.server.close()
})
