/**
 * دفتر آزمون ۴-۲۹ — دکمه‌های تلگرام و بله با انتخاب زمان (معماری §۶ خط ۵۶۳؛ TL-D11)، با کنترلر واقعی ربات، پل واقعی
 * `botRemoteBridge`، رجیستری واقعی و همان سیم‌کشی میزبان (`openRenewingPanel` ۴-۲۸):
 *  - ماژول: ردیف اول «✅ تأیید · همان تنظیمات رایانه (۳۵ دقیقه)» و «❌ رد» (هنوز دو دکمه)، ردیف دوم «⏱ وارد کردن زمان»؛
 *    قفل کار همان دو دکمهٔ امروز، بی دکمهٔ زمان؛ همهٔ دکمه‌ها نشانهٔ تصادفی، نه شناسهٔ درخواست؛
 *  - زمان رایانه: همان مدت رایانه و ردیف تصمیم مثل امروز؛
 *  - عدد دلخواه (رقم فارسی هم) یا دکمهٔ آماده: همان یک مجوز با همان زمان، حتی بیشتر از زمان رایانه، پس از ۶۰ دقیقه با
 *    همان تمدید ۴-۲۸؛ تنظیم رایانه عوض نمی‌شود؛ پیام بقیه، خبر همه و ردیف تصمیم زمان را دارند؛
 *  - عدد نادرست، عدد دیررس (پس از ۲ دقیقه)، دکمهٔ آمادهٔ کهنه: چیزی تأیید نمی‌شود و درخواست در انتظار می‌ماند؛
 *  - دو گیرنده هم‌زمان: اولین تصمیم برنده است؛
 *  - ایمنی‌ها: کنترل از راه دور خاموش یا P2، گفت‌وگوی بی‌اجازه، زمان برای قفل کار حتی از راه پل، نشانهٔ «زمان دقیق» فقط
 *    برای مجوز قسمت؛ نویسندهٔ ردیف تصمیم دقیقه را رد می‌کند.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-29-custom-time.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance as perfHooksPerformance } from 'node:perf_hooks'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-29-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const durations = await import('../../src/main/services/locks/durations.ts')
const { createBotRemoteBridge } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const { botLockTitle, createBotController, parseMinutes } = await import('../../src/main/services/cloud/messenger/messengerBot.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_ACTION_IDS, gateEntry } = await import('../../src/shared/gateCatalog.ts')
const { codeSectionOfPanel } = await import('../../src/shared/panels.ts')
const { faDigits } = await import('@shared/jalali')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const MIN = 60_000
durations.writeLockDurations({ sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 35, remoteSensitiveGrantMinutes: 20 })

// ساعت ساختگی (یکنواخت و دیواری با هم، مثل tl-4-28)
assert.equal(perfHooksPerformance, globalThis.performance)
const realNow = performance.now.bind(performance), realDateNow = Date.now
let shift = 0
performance.now = () => realNow() + shift
Date.now = () => realDateNow() + shift
const advance = (ms) => { shift += ms }

// ---------------------------------------------------------------- همان سیم‌کشی میزبان در CloudSyncService
const opened = [], ticketTtls = []
reg.initRemoteGrantRegistry({
  notePanelUnlocked: (panel, _scope, owner, allowed, ttlMs) => { opened.push({ panel, owner, ttlMs }); return unlocks.openRenewingPanel(panel, owner, allowed, ttlMs) },
  clearPanelScope: sessions.clearPanelScope, clearPanelSessions: sessions.clearPanelSessions,
  addOneShotTicket: (id, owner, ttl, memberId) => { ticketTtls.push({ id, owner, ttl }); return tickets.addGateTicket(owner, id, ttl, 'REMOTE_GRANT', { memberId }) },
  clearOneShotTickets: (memberId) => tickets.clearGateTickets(memberId === undefined ? {} : { memberId }),
  grantDurationMs: (panel) => GATE_ACTION_IDS.includes(panel) ? durations.lockDurationMs('remoteSensitiveGrantMinutes') : durations.partDurationMs(durations.remoteDurationKey(codeSectionOfPanel(panel)))
})
const lease = reg.acquireRemoteAdmissionLease()
lease.installClaimGuard(async (claim) => claim())
lease.open()
const lastTtl = (panel, owner) => opened.filter((x) => x.panel === panel && x.owner === owner).at(-1)?.ttlMs
const status = (owner, panel, req) => reg.getRequestStatus(owner, panel, req.requestId)
const claim = (owner, panel, req) => reg.claimRemotePanel(owner, panel, req.requestId, req.gt.slice(3))
/** گام‌های ۵ دقیقه‌ای با کار واقعی، مثل tl-4-28 (بی‌کاری ۱۰ دقیقه است) */
function walk(totalMin, panel, owner, untilMin) {
  let renewed = 0
  for (let t = 5; t <= totalMin; t += 5) {
    advance(5 * MIN)
    renewed += unlocks.runDueRenewalsForTests()
    assert.equal(sessions.isPanelUnlocked(panel, owner), t < untilMin, `${panel} for window ${owner} at minute ${t}`)
  }
  return renewed
}

// ---------------------------------------------------------------- ربات با Bot API ساختگی
const R1 = { id: 'aaaaaaaaaaa1', provider: 'telegram', chatId: 501, name: 'مالک تلگرام', mode: 'all', active: true, inactiveReason: null, addedAt: 0, canApprove: true, canViewReports: false }
const R2 = { id: 'aaaaaaaaaaa2', provider: 'bale', chatId: 502, name: 'مالک بله', mode: 'all', active: true, inactiveReason: null, addedAt: 0, canApprove: true, canViewReports: false }
const R3 = { id: 'aaaaaaaaaaa3', provider: 'telegram', chatId: 503, name: 'فقط گزارش', mode: 'all', active: true, inactiveReason: null, addedAt: 0, canApprove: false, canViewReports: true }
function fakeApi() {
  let mid = 100, uid = 1
  const calls = [], queue = []
  return {
    calls, queue, nextUpdate: () => uid++,
    async sendMessage(chatId, text, keyboard) { calls.push({ m: 'send', chatId, text, keyboard, id: ++mid }); return { kind: 'ok', result: { message_id: mid } } },
    async editMessageText(chatId, messageId, text, keyboard) { calls.push({ m: 'edit', chatId, messageId, text, keyboard }); return { kind: 'ok', result: true } },
    async answerCallbackQuery(id, text) { calls.push({ m: 'answer', id, text }); return { kind: 'ok', result: true } },
    async getUpdates() { return { kind: 'ok', result: queue.splice(0) } },
    async setMyCommands() { return { kind: 'ok', result: true } }
  }
}
const apis = { telegram: fakeApi(), bale: fakeApi() }
const notes = [], notices = []
let available = true
const remote = createBotRemoteBridge({ available: async () => available, closeAll: () => {}, note: (f) => notes.push(f) })
const bot = createBotController({
  settings: () => ({ recipients: [R1, R2, R3] }),
  active: () => true,
  remote,
  api: (provider) => apis[provider],
  pairingProvider: () => null,
  exclusive: (fn) => fn(),
  notifyAll: async (title, lines, important) => { notices.push({ title, lines, important }) },
  conflict: async () => {},
  summary: async () => ({ title: '', lines: [] }),
  offsetHours: async () => 3.5,
  now: () => Date.now(),
  log: () => {},
  schedule: false,
  pollSeconds: 0,
  reports: null
})
const calls = (r) => apis[r.provider].calls.filter((c) => c.chatId === r.chatId)
const lastSend = (r) => calls(r).filter((c) => c.m === 'send').at(-1)
const lastEdit = (r) => calls(r).filter((c) => c.m === 'edit').at(-1)
const lastAnswer = (r) => apis[r.provider].calls.filter((c) => c.m === 'answer').at(-1)?.text
async function press(r, data, messageId = 1) {
  advance(6000)
  const api = apis[r.provider]
  api.queue.push({ update_id: api.nextUpdate(), callback_query: { id: `cq-${api.calls.length}`, data, from: { id: r.chatId }, message: { message_id: messageId, chat: { id: r.chatId, type: 'private' }, text: 'x' } } })
  assert.equal(await bot.pollOnce(r.provider, 0), 'ok')
}
async function say(r, text) {
  advance(1000)
  const api = apis[r.provider]
  api.queue.push({ update_id: api.nextUpdate(), message: { message_id: 9000 + api.calls.length, date: Math.floor(Date.now() / 1000), chat: { id: r.chatId, type: 'private' }, from: { id: r.chatId }, text } })
  assert.equal(await bot.pollOnce(r.provider, 0), 'ok')
}
/** پیام درخواست یک قلم برای یک گیرنده: متن، شناسهٔ پیام و دکمه‌ها */
function request(r, title) {
  const sent = calls(r).filter((c) => c.m === 'send' && c.keyboard?.inline_keyboard?.[0]?.length === 2 && c.text.includes(`قفل: ${title}`)).at(-1)
  assert.ok(sent, `${r.name} got the request for ${title}`)
  const rows = sent.keyboard.inline_keyboard
  return { sent, rows, approve: rows[0][0].callback_data, reject: rows[0][1].callback_data, time: rows[1]?.[0]?.callback_data ?? null }
}
async function ask(panel, owner) {
  const req = reg.requestCode(panel, owner)
  await bot.tick()
  return req
}
const ACTION = GATE_ACTION_IDS.find((id) => REMOTE_PANELS.includes(id) && gateEntry(id)?.category === 3)
const ACTION_TITLE = `${gateEntry(ACTION).titleFa} (یک بار)`

// ---------------------------------------------------------------- دکمه‌ها
test('buttons: a module has «✅ تأیید · همان تنظیمات رایانه (… دقیقه)» and «❌ رد» on the first row and «⏱ وارد کردن زمان» on the second; an action keeps today\'s two buttons', async () => {
  const W = 301
  const reqs = [await ask('products', W), await ask('cash-close', W), await ask(ACTION, W)]
  const seen = new Set()
  for (const r of [R1, R2]) {
    const normal = request(r, 'کالاها'), money = request(r, 'بستن صندوق (پولی)'), action = request(r, ACTION_TITLE)
    assert.deepEqual(normal.rows.map((row) => row.map((b) => b.text)), [['✅ تأیید · همان تنظیمات رایانه (۳۵ دقیقه)', '❌ رد'], ['⏱ وارد کردن زمان']])
    assert.deepEqual(money.rows.map((row) => row.map((b) => b.text)), [['✅ تأیید · همان تنظیمات رایانه (۲۰ دقیقه)', '❌ رد'], ['⏱ وارد کردن زمان']])
    assert.deepEqual(action.rows.map((row) => row.map((b) => b.text)), [['✅ تأیید', '❌ رد']], 'an action: the same two buttons as today, no time button')
    assert.match(normal.sent.text, /⏱ زمان رایانه برای این نوع: ۳۵ دقیقه/, 'the same number as the 4-30 line')
    for (const data of [normal, money, action].flatMap((x) => x.rows.flat().map((b) => b.callback_data))) {
      assert.match(data, /^[art]:[A-Za-z0-9_-]{22}$/)
      assert.ok(Buffer.byteLength(data) <= 64)
      for (const q of reqs) assert.ok(!data.includes(q.requestId), 'a random token, never the request id')
      assert.ok(!seen.has(data), 'every button of every recipient has its own token')
      seen.add(data)
    }
  }
  reg.cancelForWindow(W)
  await bot.tick()
})

// ---------------------------------------------------------------- زمان رایانه
test('«همان تنظیمات رایانه»: the module opens for the computer duration; the decision row stays as today', async () => {
  const W = 302, req = await ask('products', W)
  const b = request(R2, 'کالاها')
  await press(R2, b.approve)
  assert.equal(lastAnswer(R2), 'تأیید شد')
  assert.equal(status(W, 'products', req), 'APPROVED')
  assert.deepEqual(notes.at(-1), { decision: 'تأیید', recipientName: 'مالک بله', titleFa: 'کالاها', windowNo: W })
  assert.match(lastEdit(R1).text, /✅ تأیید شد \(مالک بله\) · ۳۵ دقیقه · /)
  assert.equal(await claim(W, 'products', req), true)
  assert.equal(lastTtl('products', W), 35 * MIN)
  reg.revokeBy('bot-aaaaaaaaaaa2')
})

// ---------------------------------------------------------------- عدد دلخواه
test('«⏱ وارد کردن زمان» then a Persian number: that one grant gets 120 minutes (more than the computer\'s 35), kept past 60 minutes by the 4-28 renewal; the computer setting is unchanged', async () => {
  const W = 303, req = await ask('products', W)
  const b = request(R1, 'کالاها')
  await press(R1, b.time)
  const prompt = lastSend(R1)
  assert.deepEqual(prompt.text.split('\n'), [`⏱ کالاها · پنجرهٔ ${faDigits(W)}`, 'زمان را به دقیقه بفرستید (۱ تا ۱۰۰۰). زمان رایانه: ۳۵ دقیقه', 'فقط برای همین مجوز است و تنظیم رایانه عوض نمی‌شود. مهلت: ۲ دقیقه.'])
  assert.deepEqual(prompt.keyboard.inline_keyboard.map((row) => row.map((x) => x.text)), [['۱۵ دقیقه', '۳۰ دقیقه', '۶۰ دقیقه', '۱۲۰ دقیقه']], 'four preset buttons on one row (never a two-button first row)')
  for (const x of prompt.keyboard.inline_keyboard[0]) assert.match(x.callback_data, /^d:[A-Za-z0-9_-]{22}$/)
  assert.equal(status(W, 'products', req), 'PENDING', 'asking for a time approves nothing yet')
  await say(R1, '۱۲۰')
  assert.equal(lastSend(R1).text, '✅ تأیید شد.')
  const sentSoFar = calls(R1).length
  await say(R1, '۳۰')
  assert.equal(calls(R1).length, sentSoFar, 'the wait ended with the approval: a second number is not taken')
  assert.equal(status(W, 'products', req), 'APPROVED')
  assert.deepEqual(notes.at(-1), { decision: 'تأیید', recipientName: 'مالک تلگرام', titleFa: 'کالاها', windowNo: W, minutes: 120 }, 'the decision row carries the chosen minutes')
  assert.match(lastEdit(R2).text, /✅ تأیید شد \(مالک تلگرام\) · ۱۲۰ دقیقه \(زمان دلخواه\) · /, 'the other recipient sees the result and the time')
  assert.deepEqual(notices.at(-1).lines, ['قفل: کالاها', '🟢 نوع: ماژول معمولی', '⏱ زمان: ۱۲۰ دقیقه (زمان دلخواه)', `پنجرهٔ ${faDigits(W)}`, 'گیرنده: مالک تلگرام'])
  assert.equal(await claim(W, 'products', req), true)
  assert.equal(lastTtl('products', W), 120 * MIN, 'exactly the chosen time, not min(chosen, computer)')
  assert.equal(durations.readLockDurations().remoteGrantMinutes, 35, 'the computer setting is unchanged')
  assert.ok(walk(130, 'products', W, 120) >= 1, 'reopened before the 60-minute cap; closed at 120 minutes')
  // مجوز بعدی همان قسمت با «همان تنظیمات رایانه» دوباره ۳۵ دقیقه است (زمان دلخواه به مجوز دیگری نمی‌چسبد)
  const next = await ask('products', W)
  await press(R2, request(R2, 'کالاها').approve)
  assert.equal(await claim(W, 'products', next), true)
  assert.equal(lastTtl('products', W), 35 * MIN)
  reg.revokeBy('bot-aaaaaaaaaaa1'); reg.revokeBy('bot-aaaaaaaaaaa2')
})

test('a shorter number with «دقیقه», and a preset button, work the same; a preset older than 2 minutes expires', async () => {
  const W = 304
  const a = await ask('products', W)
  await press(R1, request(R1, 'کالاها').time)
  await say(R1, '20 دقیقه')
  assert.equal(await claim(W, 'products', a), true)
  assert.equal(lastTtl('products', W), 20 * MIN)
  const m = await ask('cash-close', W)
  await press(R2, request(R2, 'بستن صندوق (پولی)').time)
  const preset = lastSend(R2).keyboard.inline_keyboard[0][2]
  assert.equal(preset.text, '۶۰ دقیقه')
  await press(R2, preset.callback_data)
  assert.equal(lastAnswer(R2), 'تأیید شد')
  assert.equal(notes.at(-1).minutes, 60)
  assert.equal(await claim(W, 'cash-close', m), true)
  assert.equal(lastTtl('cash-close', W), 60 * MIN, 'a money module too: the chosen time, above its 20-minute setting')
  const late = await ask('pos', W)
  await press(R1, request(R1, botLockTitle('pos')).time)
  const old = lastSend(R1).keyboard.inline_keyboard[0][0].callback_data
  advance(2 * MIN + 1000)
  await press(R1, old)
  assert.equal(lastAnswer(R1), 'منقضی شد')
  assert.equal(status(W, 'pos', late), 'PENDING')
  reg.revokeBy('bot-aaaaaaaaaaa1'); reg.revokeBy('bot-aaaaaaaaaaa2'); reg.cancelForWindow(W)
  await bot.tick()
})

// ---------------------------------------------------------------- عدد نادرست و دیررس
test('a wrong number approves nothing: 0, 1001, a fraction; after three tries the wait ends and a later number is ignored; the request stays pending', async () => {
  const W = 305, req = await ask('products', W)
  await press(R1, request(R1, 'کالاها').time)
  for (const [text, last] of [['0', false], ['۱۰۰۱', false], ['20.5', true]]) {
    await say(R1, text)
    assert.equal(status(W, 'products', req), 'PENDING', `${text}: nothing approved`)
    assert.ok(lastSend(R1).text.startsWith('زمان باید عددی صحیح از ۱ تا ۱۰۰۰ دقیقه باشد؛ چیزی تأیید نشد.'))
    assert.ok(lastSend(R1).text.endsWith(last ? 'برای زمان دلخواه دوباره «⏱ وارد کردن زمان» را بزنید.' : 'دوباره بفرستید.'), text)
  }
  const before = calls(R1).length
  await say(R1, '20')
  assert.equal(calls(R1).length, before, 'the wait is over: a later number is not taken')
  assert.equal(status(W, 'products', req), 'PENDING')
  for (const [text, n] of [['۲۰', 20], ['٣٠', 30], [' 1000 ', 1000], ['1', 1], ['۱۵ دقیقه', 15]]) assert.equal(parseMinutes(text), n, text)
  for (const text of ['0', '1001', '-5', '20.5', '۲۰٫۵', 'بیست', '20 ساعت', '', '10000', '1e2']) assert.equal(parseMinutes(text), null, text)
  reg.cancelForWindow(W)
  await bot.tick()
})

test('a late number (after 2 minutes) approves nothing and says so; the request stays pending and «✅» still works', async () => {
  const W = 306, req = await ask('products', W)
  const b = request(R1, 'کالاها')
  await press(R1, b.time)
  advance(2 * MIN + 1000)
  await say(R1, '۲۰')
  assert.equal(lastSend(R1).text, 'مهلت ۲ دقیقه‌ای فرستادن زمان گذشت و چیزی تأیید نشد. اگر درخواست هنوز در انتظار است، دوباره «⏱ وارد کردن زمان» را بزنید.')
  assert.equal(status(W, 'products', req), 'PENDING')
  await press(R1, b.approve)
  assert.equal(status(W, 'products', req), 'APPROVED')
  assert.equal(await claim(W, 'products', req), true)
  assert.equal(lastTtl('products', W), 35 * MIN)
  reg.revokeBy('bot-aaaaaaaaaaa1')
})

// ---------------------------------------------------------------- دو گیرنده هم‌زمان
test('two recipients at once: the first number wins; the second approves nothing and sees the result; stale presets expire', async () => {
  const W = 307, req = await ask('products', W)
  await press(R1, request(R1, 'کالاها').time)
  await press(R2, request(R2, 'کالاها').time)
  const r2Preset = lastSend(R2).keyboard.inline_keyboard[0][1].callback_data
  await say(R1, '۴۵')
  assert.equal(status(W, 'products', req), 'APPROVED')
  await say(R2, '50')
  assert.equal(lastSend(R2).text, 'این درخواست دیگر در انتظار نیست؛ چیزی تأیید نشد.')
  assert.match(lastEdit(R2).text, /✅ تأیید شد \(مالک تلگرام\) · ۴۵ دقیقه \(زمان دلخواه\) · /)
  await press(R2, r2Preset)
  assert.equal(lastAnswer(R2), 'منقضی شد')
  assert.equal(notes.filter((n) => n.windowNo === W).length, 1, 'one decision')
  assert.equal(await claim(W, 'products', req), true)
  assert.equal(lastTtl('products', W), 45 * MIN)
  reg.revokeBy('bot-aaaaaaaaaaa1')
})

// ---------------------------------------------------------------- ایمنی‌ها
test('safeties: remote off or P2, a chat without permission, a time for an action even through the bridge, and the exact flag only on a panel grant', async () => {
  const W = 308, req = await ask('products', W)
  await press(R1, request(R1, 'کالاها').time)
  available = false
  await say(R1, '20')
  assert.equal(lastSend(R1).text, 'کنترل از راه دور خاموش است یا توقف اضطراری فعال است؛ تأیید ممکن نیست.')
  assert.equal(status(W, 'products', req), 'PENDING')
  available = true
  // گفت‌وگوی بی اجازهٔ تأیید (فقط گزارش): دکمهٔ زمان دیگری را نمی‌تواند بزند و عددش چیزی نمی‌کند
  await press(R3, request(R1, 'کالاها').time)
  assert.equal(lastAnswer(R3), 'این گفت‌وگو اجازهٔ تأیید ندارد.')
  await say(R3, '20')
  assert.equal(status(W, 'products', req), 'PENDING')
  // قفل کار: نه دکمهٔ زمان، نه زمان از راه پل
  const act = await ask(ACTION, W)
  const pending = remote.pending().find((p) => p.panel === ACTION && p.ownerWindowId === W)
  assert.equal(await remote.approve(pending, 'bot-aaaaaaaaaaa1', 20), 'BAD')
  assert.equal(status(W, ACTION, act), 'PENDING')
  const mod = remote.pending().find((p) => p.panel === 'products' && p.ownerWindowId === W)
  for (const bad of [0, 1001, 1.5, NaN]) assert.equal(await remote.approve(mod, 'bot-aaaaaaaaaaa1', bad), 'BAD', String(bad))
  assert.equal(status(W, 'products', req), 'PENDING')
  // نشانهٔ «زمان دقیق» روی مجوز یک‌بار نادیده است: پنجرهٔ بلیت همان کمترینِ سیاست و مدت رایانه
  reg.cancelForWindow(W)
  const one = reg.requestCode(ACTION, W)
  assert.ok(reg.createGrant({ panel: ACTION, ownerWindowId: W, tier: 'SENSITIVE_MONEY', mode: 'ONE_SHOT', memberId: 'member1', requestId: one.requestId, ttlMs: 30 * MIN, exact: true }))
  assert.equal(await claim(W, ACTION, one), true)
  assert.equal(ticketTtls.at(-1).ttl, 20 * MIN, 'ONE_SHOT: min(30, 20), the exact flag does not apply')
  tickets.clearGateTickets()
  await bot.tick()
})

test('the decision-row writer passes the minutes; only the bot\'s custom time sets the exact flag', () => {
  assert.ok(read('src/main/services/cloud/messenger/messengerRuntime.ts').includes("note: (f) => noteAccessEvent('BOT_DECISION', { decision: f.decision, recipientName: f.recipientName, titleFa: f.titleFa, windowNo: f.windowNo, minutes: f.minutes })"))
  assert.match(read('src/main/services/RemoteGrantRegistry.ts'), /exact: opts\.exact === true && mode === 'PANEL'/)
  assert.doesNotMatch(read('src/main/services/cloud/grantApprovalCoordinator.ts'), /exact/, 'the phone approval keeps the computer time')
  assert.match(read('src/main/services/cloud/botRemoteBridge.ts'), /\.\.\.\(custom \? \{ ttlMs: \(minutes as number\) \* 60_000, exact: true \} : \{ ttlMs: POLICY_TTL_MS \}\)/)
  lease.release()
  performance.now = realNow; Date.now = realDateNow
})
