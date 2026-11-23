/**
 * طرح ۱۴۰۵ · مرحلهٔ ۶ — دکمه‌های ربات تلگرام و بله روی سرور ساختگی loopback (مورد ۱۵؛ معماری §۴-۱-ب؛ §۸-۲ بند ۱۸).
 *
 * با موتور واقعی پیام‌رسان، پل واقعی `botRemoteBridge` و رجیستری واقعی مجوز راه دور، برای هر دو آداپتور:
 *   خاموش یعنی بی خواندن پیام و بی پاسخ؛ تأیید درست (همان `createGrant`، عضو `bot-<گیرنده>`)؛ دکمهٔ منقضی، تکراری،
 *   از گفت‌وگوی جفت‌نشده و از گیرندهٔ بی اجازه رد؛ درخواست لغوشده؛ دو گیرندهٔ هم‌زمان (اولی برنده، پیام بقیه ویرایش)؛
 *   رد (پنجرهٔ فروشنده «مدیر رد کرد»)؛ «بستن همه» با «مطمئنم»؛ «مجوزهای باز» و «خلاصهٔ امروز»؛ P2 تأیید با ربات را
 *   می‌بندد؛ سقف یک فرمان در ۵ ثانیه؛ نبود مبلغ و دادهٔ ممنوع در پیام درخواست؛ شمارهٔ پنجره در پیام؛ دکمهٔ کهنه
 *   «منقضی شد»؛ ۴۰۹ هنگام خواندن پیوسته خواندن را متوقف می‌کند؛ برداشتن اجازه مجوز همان گیرنده را می‌بندد.
 * Electron و Prisma استاب هارنس‌اند؛ فقط 127.0.0.1.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-bot-buttons-loopback.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-plan1405-bot-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

await import('../../test/harness/stubs/prismaClient.mjs')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { createMessengerStore } = await import('../../src/main/services/cloud/messenger/messengerVault.ts')
const { createBotRemoteBridge } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const registry = await import('../../src/main/services/RemoteGrantRegistry.ts')

// ---------------------------------------------------------------- ذخیره‌ساز امن ساختگی
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}

// ---------------------------------------------------------------- سرور ساختگی Bot API
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
const mock = { log: [], rules: [], updates: { tg: [], bale: [] }, nextId: 1, port: 0, server: null }
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
      mock.log.push({ prefix, method, params })
      const ruleAt = mock.rules.findIndex((r) => r.prefix === prefix && r.method === method)
      if (ruleAt >= 0) { const rule = mock.rules.splice(ruleAt, 1)[0]; return send(rule.status, { ok: false, error_code: rule.status, description: `Error ${rule.status}` }) }
      if (token !== (prefix === 'tg' ? TOKENS.telegram : TOKENS.bale)) return send(401, { ok: false, description: 'Unauthorized' })
      if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: `${prefix}_shop_bot` } })
      if (method === 'getUpdates') {
        const offset = Number(params.offset) || 0
        mock.updates[prefix] = mock.updates[prefix].filter((u) => u.update_id >= offset)
        return send(200, { ok: true, result: mock.updates[prefix] })
      }
      if (method === 'sendMessage') return send(200, { ok: true, result: { message_id: mock.nextId++ } })
      if (method === 'answerCallbackQuery' || method === 'editMessageText') return send(200, { ok: true, result: true })
      return send(404, { ok: false, description: 'Not Found' })
    })
  })
  server.listen(0, '127.0.0.1', () => { mock.server = server; mock.port = server.address().port; resolve() })
})
const base = () => `http://127.0.0.1:${mock.port}`
const calls = (method, prefix) => mock.log.filter((e) => e.method === method && (!prefix || e.prefix === prefix))
const lastOf = (method, prefix, chat) => calls(method, prefix).filter((e) => chat === undefined || e.params.chat_id === chat).at(-1)

// ---------------------------------------------------------------- گیرنده‌ها، موتور و پل
const R1 = { id: 'aaaaaaaaaaa1', provider: 'telegram', chatId: 5101, name: 'مالک تلگرام', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const R2 = { id: 'bbbbbbbbbbb2', provider: 'bale', chatId: 6202, name: 'مالک بله', mode: 'all', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const R3 = { id: 'ccccccccccc3', provider: 'telegram', chatId: 5303, name: 'حسابدار', mode: 'handover', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const dir = join(ROOT, 'userdata'); mkdirSync(dir, { recursive: true })
createMessengerStore(dir, storage).writeSettings({
  version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: false,
  bots: { telegram: { token: TOKENS.telegram, username: 'tg_shop_bot', proxy: '' }, bale: { token: TOKENS.bale, username: 'bale_shop_bot', proxy: '' } },
  recipients: [R1, R2, R3]
})
let clock = Date.now()
const advance = (ms) => { clock += ms }
let available = true, closeAllCount = 0
const notes = []
const remote = createBotRemoteBridge({ available: async () => available, closeAll: () => { closeAllCount++ }, note: (f) => notes.push(f) })
const engine = createMessengerEngine({
  dir, storage, db: createMessengerDb(),
  summary: {
    salesSummary: async () => ({ count: 3, grandTotal: 4_500_000, cashTotal: 3_000_000, cardTotal: 1_500_000, otherTotal: 0, managerAccountTotal: 0, creditTotal: 0, returnedTotal: 0 }),
    staffPerformance: async () => ({ rows: [] }), abnormalDiscounts: async () => ({ rows: [], disabled: true }), lastBackupAt: async () => null
  },
  fetchFor: () => (url, init) => fetch(url, init),
  baseUrls: { telegram: `${base()}/tg`, bale: `${base()}/bale` },
  now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0, botPollSeconds: 0, remote
})
const tick = async () => { advance(1100); await engine.runOnce({}) }
let uid = 1000
const press = async (provider, chatId, data, message = { message_id: 1, chat: { id: chatId, type: 'private' }, text: 'پیام' }) => {
  mock.updates[PREFIX[provider]].push({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: chatId }, message, data } })
  return engine.botPollOnce(provider, 0)
}
const say = async (provider, chatId, text) => {
  mock.updates[PREFIX[provider]].push({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' }, text, date: Math.floor(clock / 1000) } })
  return engine.botPollOnce(provider, 0)
}
/** دکمه‌های پیام درخواستِ یک گیرنده: [تأیید، رد] */
const buttons = (provider, chat) => {
  const entry = calls('sendMessage', PREFIX[provider]).filter((e) => e.params.chat_id === chat && e.params.reply_markup?.inline_keyboard?.[0]?.length === 2).at(-1)
  return entry ? entry.params.reply_markup.inline_keyboard[0].map((b) => b.callback_data) : null
}
const answers = (prefix) => calls('answerCallbackQuery', prefix).map((e) => e.params.text ?? '')
const W = 7301

await engine.start()

test('off by default: no continuous reading, no request messages, no replies', async () => {
  const before = mock.log.length
  const req = registry.requestCode('products', W)
  await tick()
  assert.equal(await engine.botPollOnce('telegram', 0), 'idle')
  assert.equal(await engine.botPollOnce('bale', 0), 'idle')
  assert.equal(calls('getUpdates').length, 0, 'getUpdates is never called while bot buttons are off')
  assert.equal(mock.log.slice(before).filter((e) => e.params.reply_markup).length, 0)
  registry.cancelForWindow(W)
  assert.equal(engine.status().botButtons, false); assert.equal(engine.status().botAvailable, true)
  void req
})

test('turning on is announced first; approvers only; a request message has the window number and no money or private data', async () => {
  await engine.setRecipientApprove(R1.id, true); await engine.setRecipientApprove(R2.id, true)
  await engine.setBotButtons(true)
  assert.equal(engine.status().botButtons, true)
  assert.ok(engine.status().recipients.find((r) => r.id === R1.id).canApprove)
  const req = registry.requestCode('cash-close', W)
  await tick()
  const tg = buttons('telegram', R1.chatId), bl = buttons('bale', R2.chatId)
  assert.ok(tg && bl, 'both approvers got the two buttons'); assert.equal(buttons('telegram', R3.chatId), null, 'a recipient without permission gets no buttons')
  for (const data of [...tg, ...bl]) { assert.ok(/^[ar]:[A-Za-z0-9_-]{22}$/.test(data)); assert.ok(Buffer.byteLength(data) <= 64); assert.ok(!data.includes(req.requestId)) }
  const text = lastOf('sendMessage', 'tg', R1.chatId).params.text
  assert.match(text, /بستن صندوق \(پولی\)/); assert.match(text, new RegExp(req.code)); assert.match(text, /پنجرهٔ ۷۳۰۱/)
  assert.doesNotMatch(text, /ریال|مبلغ|09\d{9}|تلفن|رمز|PIN/)
  // کد ۶ رقمی همان کد مقایسهٔ فروشنده است، نه کد اعتبار.
  registry.cancelForWindow(W)
  await tick()
  assert.match(lastOf('editMessageText', 'tg', R1.chatId).params.text, /دیگر در انتظار نیست/)
  advance(6000)
  await press('telegram', R1.chatId, tg[0])
  assert.equal(answers('tg').at(-1), 'منقضی شد', 'a cancelled request: the button is expired')
})

test('approve: first decision wins (both adapters), the grant uses the same createGrant; duplicate and stale buttons expire', async () => {
  const req = registry.requestCode('products', W)
  await tick()
  const tg = buttons('telegram', R1.chatId), bl = buttons('bale', R2.chatId)
  advance(6000)
  await press('bale', R2.chatId, bl[0])
  assert.equal(answers('bale').at(-1), 'تأیید شد')
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'APPROVED')
  const grant = registry.listActiveGrants().find((g) => g.panel === 'products' && g.ownerWindowId === W)
  assert.ok(grant && grant.claimed === false)
  assert.match(lastOf('editMessageText', 'tg', R1.chatId).params.text, /تأیید شد \(مالک بله\)/, 'the other recipient sees the result')
  assert.deepEqual(notes.at(-1), { decision: 'تأیید', recipientName: 'مالک بله', titleFa: 'کالاها', windowNo: W })
  advance(6000)
  await press('telegram', R1.chatId, tg[0])
  assert.equal(answers('tg').at(-1), 'منقضی شد', 'the second decision loses')
  advance(6000)
  await press('bale', R2.chatId, bl[0])
  assert.equal(answers('bale').at(-1), 'منقضی شد', 'a duplicate press expires')
  advance(6000)
  await press('telegram', R1.chatId, 'a:AAAAAAAAAAAAAAAAAAAAAA', { message_id: 77, chat: { id: R1.chatId, type: 'private' }, text: '🔐 درخواست قدیمی' })
  assert.equal(answers('tg').at(-1), 'منقضی شد', 'an old button (e.g. after a night off) expires')
  assert.match(lastOf('editMessageText', 'tg', R1.chatId).params.text, /⌛ منقضی شد/)
  registry.cancelForWindow(W)
})

test('unpaired chat and a recipient without permission are refused; one command per 5 seconds', async () => {
  const req = registry.requestCode('products', W)
  await tick()
  const tg = buttons('telegram', R1.chatId)
  advance(6000)
  await press('telegram', 9999, tg[0], { message_id: 1, chat: { id: 9999, type: 'private' }, text: 'x' })
  assert.match(answers('tg').at(-1), /اجازهٔ تأیید ندارد/)
  await press('telegram', R3.chatId, tg[0], { message_id: 1, chat: { id: R3.chatId, type: 'private' }, text: 'x' })
  assert.match(answers('tg').at(-1), /اجازهٔ تأیید ندارد/)
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'PENDING')
  await press('telegram', R1.chatId, 'm:list')
  const listed = calls('sendMessage', 'tg').filter((e) => e.params.chat_id === R1.chatId && /مجوزهای باز/.test(e.params.text)).length
  await press('telegram', R1.chatId, tg[1])
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'PENDING', 'a second command within 5 s is ignored')
  assert.equal(calls('sendMessage', 'tg').filter((e) => e.params.chat_id === R1.chatId && /مجوزهای باز/.test(e.params.text)).length, listed)
  advance(6000)
  await press('telegram', R1.chatId, tg[1])
  assert.equal(answers('tg').at(-1), 'رد شد')
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'UNAVAILABLE')
  assert.equal(registry.requestRejected(W, 'products', req.requestId), true, 'the seller window sees «مدیر رد کرد»')
  assert.equal(notes.at(-1).decision, 'رد')
  assert.match(lastOf('editMessageText', 'bale', R2.chatId).params.text, /رد شد \(مالک تلگرام\)/)
})

test('P2 closes bot approvals until recovery; a one-time action gets a SENSITIVE_MONEY one-shot grant', async () => {
  const req = registry.requestCode('credit.void', W)
  await tick()
  const bl = buttons('bale', R2.chatId)
  assert.match(lastOf('sendMessage', 'bale', R2.chatId).params.text, /ابطال اعتبار \(یک بار\)/)
  available = false
  advance(6000)
  await press('bale', R2.chatId, bl[0])
  assert.match(answers('bale').at(-1), /توقف اضطراری/)
  assert.equal(registry.getRequestStatus(W, 'credit.void', req.requestId), 'PENDING', 'nothing approved while P2 is latched')
  available = true
  advance(6000)
  await press('bale', R2.chatId, bl[0])
  assert.equal(answers('bale').at(-1), 'تأیید شد')
  assert.equal(registry.getRequestStatus(W, 'credit.void', req.requestId), 'APPROVED')
  registry.cancelForWindow(W)
})

test('menu: close all with «مطمئنم», open grants and today\'s summary', async () => {
  advance(6000)
  await say('telegram', R1.chatId, 'منو')
  const menu = lastOf('sendMessage', 'tg', R1.chatId).params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepEqual(menu, ['m:close', 'm:list', 'm:sum'])
  advance(6000)
  await press('telegram', R1.chatId, 'm:close')
  assert.equal(closeAllCount, 0, 'the first press only asks «مطمئنم»')
  const confirm = lastOf('sendMessage', 'tg', R1.chatId).params.reply_markup.inline_keyboard[0][0].callback_data
  assert.match(confirm, /^c:/)
  advance(6000)
  await press('bale', R2.chatId, confirm)
  assert.equal(closeAllCount, 0, 'another recipient cannot use this confirmation')
  advance(6000)
  await press('telegram', R1.chatId, confirm)
  assert.equal(closeAllCount, 1)
  assert.equal(notes.at(-1).decision, 'بستن همه')
  advance(6000)
  await press('telegram', R1.chatId, confirm)
  assert.equal(closeAllCount, 1, 'the confirmation is one-time')
  advance(6000)
  await press('telegram', R1.chatId, 'm:sum')
  assert.match(lastOf('sendMessage', 'tg', R1.chatId).params.text, /📊 خلاصهٔ امروز/)
  advance(6000)
  await press('telegram', R1.chatId, 'm:list')
  assert.match(lastOf('sendMessage', 'tg', R1.chatId).params.text, /📋 مجوزهای باز/)
})

test('removing permission revokes that recipient\'s bot grants; 409 stops continuous reading and turns the buttons off', async () => {
  const req = registry.requestCode('products', W)
  await tick()
  const tg = buttons('telegram', R1.chatId)
  advance(6000)
  await press('telegram', R1.chatId, tg[0])
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'APPROVED')
  await engine.setRecipientApprove(R1.id, false)
  assert.equal(registry.getRequestStatus(W, 'products', req.requestId), 'UNAVAILABLE', 'the grant of bot-<R1> is revoked')
  assert.equal(await engine.botPollOnce('telegram', 0), 'idle', 'no approver left on telegram ⇒ no reading')
  mock.rules.push({ prefix: 'bale', method: 'getUpdates', status: 409 })
  assert.equal(await engine.botPollOnce('bale', 0), 'conflict')
  assert.equal(engine.status().botButtons, false)
  assert.match(engine.status().botConflict, /جای دیگری/)
  const before = calls('getUpdates').length
  assert.equal(await engine.botPollOnce('bale', 0), 'idle')
  assert.equal(calls('getUpdates').length, before, 'reading stopped')
  await tick(); await tick()
  assert.ok(calls('sendMessage').some((e) => /جای دیگری در حال استفاده است/.test(e.params.text)), 'recipients are told')
})

test.after(async () => { await engine.stop(); await new Promise((r) => { mock.server.close(() => r()); mock.server.closeAllConnections() }) })
