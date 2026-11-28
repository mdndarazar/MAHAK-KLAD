/**
 * دفتر آزمون ۴-۲۶ — پیام به مدیر برای تحویلِ دیر و صندوقِ باز ماندهٔ شیفت آخر، روی سرور ساختگی Bot API (loopback) با
 * موتور واقعی پیام‌رسان و خوانندهٔ واقعی پایگاه موقت:
 *  - «⏰ تحویل شیفت انجام نشده» سر ۱۵ دقیقه پس از پایان شیفتی که بعدش شیفت دیگری هست؛ «🌙 صندوق شیفت آخر هنوز باز
 *    است» سر ۳۰ دقیقه پس از پایان شیفت آخر روز؛ هر کدام فقط یک بار، حتی پس از بستن و باز کردن برنامه؛
 *  - تحویل به‌موقع ⇐ هیچ پیامی؛ تک‌شیفت ⇐ هیچ پیامی؛ برنامه‌ای که آن لحظه خاموش بود ⇐ با روشن شدن، فقط اگر هنوز صادق است؛
 *  - فقط گیرنده‌های «همه موارد» و «تحویل شیفت»؛ هیچ مبلغ، کد یا تلفنی؛ نشانهٔ یک‌بار در `messenger-cursor.json`
 *    (پروندهٔ قدیمی بی آن هم خوانده می‌شود)، بی نوشتن در پایگاه داده.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-26-shift-end-reminders.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-26-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { createMessengerStore } = await import('../../src/main/services/cloud/messenger/messengerVault.ts')
const { isLastShiftOfDay, shiftEndReminder, SHIFT_HANDOVER_REMINDER_MIN, LAST_SHIFT_REMINDER_MIN } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { faDigits, toJalaliDate } = await import('@shared/jalali')
const { SEPARATOR } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const db = harnessClient()
const seed = makeSeeder(db)
const MIN = 60_000
/** امروز، ساعت hh:mm به وقت محلی (تهران) */
const at = (hh, mm = 0) => { const d = new Date(); d.setHours(hh, mm, 0, 0); return d.getTime() }
const today = toJalaliDate(new Date(at(12)))

// ---------------------------------------------------------------- واحد: «شیفت آخر» و سازندهٔ پیام (تابع خالص)
const plan = (start, end, daysMask = 127) => {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
  return { startMinute: m(start), durationMinutes: ((m(end) - m(start) + 1440) % 1440) || 1440, daysMask }
}
const TWO = [plan('08:00', '14:00'), plan('14:00', '22:00')]
const segment = (over = {}) => ({ shiftId: 7, shiftName: 'صبح', custodianName: 'علی', scheduledEndAt: at(14), dayCutoverMinutes: 300, mode: 'MULTI_SHIFT', handoverPending: false, plans: TWO, ...over })

test('the last shift of the day: no other active shift of the same working day ends later', () => {
  assert.equal(isLastShiftOfDay(segment()), false, 'the evening shift follows the morning one')
  assert.equal(isLastShiftOfDay(segment({ scheduledEndAt: at(22) })), true, 'nothing ends after 22:00')
  const night = [...TWO, plan('22:00', '02:00')]
  assert.equal(isLastShiftOfDay(segment({ scheduledEndAt: at(22), plans: night })), false, 'a night shift past midnight is still the same working day')
  assert.equal(isLastShiftOfDay(segment({ scheduledEndAt: at(26), plans: night })), true, 'the night shift (ends 02:00, before the 05:00 day start) is the last')
  assert.equal(isLastShiftOfDay(segment({ plans: [plan('08:00', '14:00'), plan('13:30', '22:00')] })), false, 'an overlapping later shift counts')
  const notToday = 127 & ~(1 << new Date(at(14)).getDay())
  assert.equal(isLastShiftOfDay(segment({ plans: [plan('08:00', '14:00'), plan('14:00', '22:00', notToday)] })), true, 'a shift that does not work on this weekday does not count')
  assert.equal(isLastShiftOfDay(segment({ plans: [plan('08:00', '14:00')] })), true, 'a single defined shift is the last')
  assert.equal(isLastShiftOfDay(segment({ plans: [] })), true)
})

test('builder: fixed 15 and 30 minutes, once per key, multi-shift only, no amount, code or phone', () => {
  assert.equal(SHIFT_HANDOVER_REMINDER_MIN, 15)
  assert.equal(LAST_SHIFT_REMINDER_MIN, 30)
  const none = new Set()
  assert.equal(shiftEndReminder(segment(), at(14, 14), none, 0), null, '14 minutes: not yet')
  const h = shiftEndReminder(segment(), at(14, 15), none, 0)
  assert.equal(h.key, 'h:7')
  assert.equal(h.event.code, 'R-7-15')
  assert.equal(h.event.title, `⏰ تحویل شیفت انجام نشده · «صبح» · ${faDigits(today)} ساعت ۱۴:۱۵`)
  assert.deepEqual(h.event.lines, ['۱۵ دقیقه از پایان شیفت گذشته (پایان برنامه: ساعت ۱۴:۰۰)', 'مسئول صندوق: علی'])
  assert.deepEqual([h.event.handover, h.event.important, h.event.system], [true, false, false], 'a shift-handover message, not an important one')
  assert.equal(shiftEndReminder(segment(), at(14, 40), new Set(['h:7']), 0), null, 'once')
  const pending = shiftEndReminder(segment({ handoverPending: true }), at(14, 20), none, 0)
  assert.ok(pending.event.lines.includes('تحویل شروع شده ولی هنوز پذیرفته نشده است.'))
  const last = segment({ shiftId: 8, shiftName: 'عصر', custodianName: 'رضا', scheduledEndAt: at(22) })
  assert.equal(shiftEndReminder(last, at(22, 29), none, 0), null, 'the last shift gets no handover reminder; 29 minutes: not yet')
  const n = shiftEndReminder(last, at(22, 30), none, 0)
  assert.equal(n.key, 'n:8')
  assert.equal(n.event.code, 'R-8-30')
  assert.equal(n.event.title, `🌙 صندوق شیفت آخر هنوز باز است · ${faDigits(today)} ساعت ۲۲:۳۰`)
  assert.deepEqual(n.event.lines, ['۳۰ دقیقه از پایان «عصر» گذشته (پایان برنامه: ساعت ۲۲:۰۰)', 'مسئول صندوق: رضا'])
  assert.equal(shiftEndReminder(last, at(23), new Set(['n:8']), 0), null, 'once')
  assert.equal(shiftEndReminder(segment({ mode: 'SINGLE_SHIFT' }), at(16), none, 0), null, 'single shift: the 24:00 close message does this job')
  assert.equal(shiftEndReminder(null, at(16), none, 0), null, 'no open drawer')
  for (const ev of [h.event, n.event, pending.event]) {
    const text = [ev.title, ...ev.lines].join('\n')
    assert.ok(!text.includes('ریال') && !/09\d{9}/.test(text), 'no amount and no phone')
  }
})

// ---------------------------------------------------------------- یک روز سه‌شیفتی روی پایگاه موقت و موتور واقعی
const ali = seed.user('علی ۴-۲۶'), reza = seed.user('رضا ۴-۲۶'), sara = seed.user('سارا ۴-۲۶')
const TEMPLATES = [
  { id: 'tl426-morning', name: 'صبح', startTime: '06:00', endTime: '10:00', staffIds: [ali] },
  { id: 'tl426-noon', name: 'ظهر', startTime: '10:00', endTime: '16:00', staffIds: [reza] },
  { id: 'tl426-evening', name: 'عصر', startTime: '16:00', endTime: '22:00', staffIds: [sara] }
].map((t) => ({ ...t, isActive: true, daysMask: 127, reminderRepeatMin: 15, allowMidDayHandover: false }))
await db.setting.upsert({
  where: { key: 'shift.config' }, update: {},
  create: { key: 'shift.config', value: JSON.stringify({ names: TEMPLATES.map((t) => t.name), byTime: false, custodyMode: 'MULTI_SHIFT', custodyModeConfigured: true, singleShiftCustodianUserId: null, reminderEnabled: true, overrunGraceMinutes: 0, templates: TEMPLATES, clockFormat: '24', overtimeMaxMinutes: 120 }) }
})
let epoch = 0
/** یک بخش صندوق با عکس برنامه، همان شکلی که `CustodyService` هنگام باز کردن می‌نویسد؛ صندوق به همین بخش سپرده می‌شود. */
async function openSegment(template, userId, openedAt, endAt, mode = 'MULTI_SHIFT') {
  const shiftId = seed.insert('Shift', { name: template.name, number: TEMPLATES.indexOf(template) + 1, dayJalali: today, openedAt, userId, staffConfirmed: 1 })
  const snapshot = { templateId: template.id, planId: null, title: template.name, scheduledEndAt: new Date(endAt).toISOString(), reminderRepeatMin: 15, allowMidDayHandover: false, staffIds: template.staffIds, overrunGraceMinutes: 0, overtimeMaxMinutes: 120, reminderEnabled: true, mode }
  await db.custodyShiftMeta.create({ data: { shiftId, custodianUserId: userId, openAuth: 'CUSTODY_PIN', templateId: template.id, scheduledEndAt: new Date(endAt), scheduleSnapshotJson: JSON.stringify(snapshot), rolloverAt: new Date(endAt + 120 * MIN), dayCutoverSnapshot: 300, operationalDay: today, openEpoch: ++epoch } })
  await db.custodyState.upsert({ where: { key: 'MAIN' }, update: { state: 'ACTIVE', activeShiftId: shiftId, pendingHandoverId: null, epoch }, create: { key: 'MAIN', state: 'ACTIVE', activeShiftId: shiftId, epoch } })
  return shiftId
}
/** تحویل یا بستن: بخش تمام می‌شود و صندوق دیگر دست آن نیست */
async function endSegment(shiftId, endedAt) {
  await db.shift.update({ where: { id: shiftId }, data: { closedAt: new Date(endedAt) } })
  await db.custodyShiftMeta.update({ where: { shiftId }, data: { endKind: 'HANDOVER', endedAt: new Date(endedAt) } })
  await db.custodyState.update({ where: { key: 'MAIN' }, data: { state: 'NO_SESSION', activeShiftId: null, epoch: ++epoch } })
}

const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}
const TOKEN = '123456789:AAHtelegramTOKENsecretVALUE0123456789'
const mock = { log: [], nextId: 1, port: 0, server: null }
await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const m = /^\/tg\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      if (!m) return send(404, { ok: false, description: 'Not Found' })
      let params = {}
      try { params = JSON.parse(body || '{}') } catch {}
      mock.log.push({ method: m[2], params })
      if (m[2] === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: 'tg_shop_bot' } })
      if (m[2] === 'sendMessage') return send(200, { ok: true, result: { message_id: mock.nextId++ } })
      return send(404, { ok: false, description: 'Not Found' })
    })
  })
  server.listen(0, '127.0.0.1', () => { mock.server = server; mock.port = server.address().port; resolve() })
})

const ALL = 4261, HANDOVER = 4262, IMPORTANT = 4263
const recipient = (id, chatId, mode) => ({ id, provider: 'telegram', chatId, name: `گیرندهٔ ${mode}`, mode, active: true, inactiveReason: null, addedAt: 1, canApprove: false, canViewReports: false })
const dir = join(ROOT, 'userdata'); mkdirSync(dir, { recursive: true })
const store = createMessengerStore(dir, storage)
store.writeSettings({
  version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: false,
  bots: { telegram: { token: TOKEN, username: 'tg_shop_bot', proxy: '' } },
  recipients: [recipient('aaaaaaaa4261', ALL, 'all'), recipient('bbbbbbbb4262', HANDOVER, 'handover'), recipient('cccccccc4263', IMPORTANT, 'important')]
})
let clock = at(5, 30)
const makeEngine = () => createMessengerEngine({
  dir, storage, db: createMessengerDb(), summary: {},
  fetchFor: () => (url, init) => fetch(url, init),
  baseUrls: { telegram: `http://127.0.0.1:${mock.port}/tg`, bale: `http://127.0.0.1:${mock.port}/bale` },
  now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0, botPollSeconds: 0
})
let engine = makeEngine()
/** ساعت را به `t` می‌برد، یک دور زمان‌سنج و چند دور فرستادن */
async function minute(t) {
  clock = t
  await engine.runOnce({})
  for (let i = 0; i < 4; i++) { clock += 1100; await engine.runOnce({}) }
}
const textsTo = (chatId, mark = 0) => mock.log.slice(mark).filter((e) => e.method === 'sendMessage' && e.params.chat_id === chatId).map((e) => String(e.params.text))
/** پیام‌های صف یک گیرنده با هم در یک پیام می‌روند (`SEPARATOR` در `messengerFormat.ts`)؛ هر تکه جدا شمرده می‌شود */
const parts = (chatId, mark = 0) => textsTo(chatId, mark).flatMap((t) => t.split(SEPARATOR))
const reminders = (chatId, mark = 0) => parts(chatId, mark).filter((t) => t.startsWith('⏰') || t.startsWith('🌙'))
const cursorKeys = () => JSON.parse(readFileSync(join(dir, 'messenger-cursor.json'), 'utf8')).reminderKeys
const [morning, noon, evening] = TEMPLATES

let sMorning, sNoon, sEvening
test('on time: the morning drawer is handed over five minutes after the shift end ⇒ no reminder', async () => {
  sMorning = await openSegment(morning, ali, at(6), at(10))
  await engine.start()
  await minute(at(9, 59))
  await minute(at(10, 5))
  await endSegment(sMorning, at(10, 5))
  sNoon = await openSegment(noon, reza, at(10, 5), at(16))
  await minute(at(10, 15))
  await minute(at(10, 30))
  for (const chat of [ALL, HANDOVER, IMPORTANT]) assert.deepEqual(reminders(chat), [], 'nothing for an on-time handover, nothing before the next shift ends')
  assert.ok(textsTo(ALL).some((t) => t.includes('برنامه روشن شد')), 'the engine really delivers to this chat')
})

test('late handover: «⏰» at 15 minutes, once, only to «all» and «shift handover» recipients', async () => {
  const mark = mock.log.length
  await minute(at(16, 14))
  assert.deepEqual(reminders(ALL, mark), [], '14 minutes: not yet')
  await minute(at(16, 15))
  for (const chat of [ALL, HANDOVER]) {
    const sent = reminders(chat, mark)
    assert.equal(sent.length, 1, `one reminder for chat ${chat}`)
    assert.ok(sent[0].startsWith(`⏰ تحویل شیفت انجام نشده · «ظهر» · ${faDigits(today)} ساعت ۱۶:۱۵`), sent[0])
    assert.ok(sent[0].includes('۱۵ دقیقه از پایان شیفت گذشته (پایان برنامه: ساعت ۱۶:۰۰)'), sent[0])
    assert.ok(sent[0].includes('مسئول صندوق: رضا ۴-۲۶'), sent[0])
    assert.ok(sent[0].includes(`R-${sNoon}-15`), 'the fixed event code')
  }
  assert.deepEqual(reminders(IMPORTANT, mark), [], 'not an «important only» message')
  await minute(at(16, 16))
  await minute(at(16, 20))
  assert.equal(reminders(ALL, mark).length, 1, 'once')
  assert.deepEqual(cursorKeys(), [`h:${sNoon}`], 'the once-marker is in messenger-cursor.json')
})

test('closing and reopening the program does not send the same reminder again', async () => {
  const mark = mock.log.length
  clock = at(16, 24)
  await engine.stop()
  engine = makeEngine()
  clock = at(16, 25)
  await engine.start()
  await minute(at(16, 26))
  await minute(at(16, 30))
  assert.ok(textsTo(ALL, mark).some((t) => t.includes('برنامه روشن شد')), 'the program really started again')
  assert.deepEqual(reminders(ALL, mark), [], 'no second «⏰» for the same drawer section')
  assert.deepEqual(reminders(HANDOVER, mark), [])
})

test('last shift: «🌙» 30 minutes after its end; the program was off at that moment ⇒ sent on start because it is still true, once', async () => {
  await minute(at(16, 40))
  await endSegment(sNoon, at(16, 40))
  sEvening = await openSegment(evening, sara, at(16, 40), at(22))
  const mark = mock.log.length
  await minute(at(22, 10))
  await minute(at(22, 20))
  assert.deepEqual(reminders(ALL, mark), [], 'the last shift gets no «⏰»; 20 minutes: not yet')
  clock = at(22, 25)
  await engine.stop()
  engine = makeEngine()
  clock = at(22, 45)
  await engine.start()
  await minute(at(22, 46))
  for (const chat of [ALL, HANDOVER]) {
    const sent = reminders(chat, mark)
    assert.equal(sent.length, 1, `one reminder for chat ${chat}`)
    assert.ok(sent[0].startsWith(`🌙 صندوق شیفت آخر هنوز باز است · ${faDigits(today)} ساعت ۲۲:۴۶`), sent[0])
    assert.ok(sent[0].includes('۴۶ دقیقه از پایان «عصر» گذشته (پایان برنامه: ساعت ۲۲:۰۰)'), 'the real minutes, since the program was off at 22:30')
    assert.ok(sent[0].includes('مسئول صندوق: سارا ۴-۲۶'), sent[0])
  }
  assert.deepEqual(reminders(IMPORTANT, mark), [])
  await minute(at(22, 50))
  await minute(at(23, 10))
  assert.equal(reminders(ALL, mark).length, 1, 'once')
  assert.deepEqual(cursorKeys(), [`h:${sNoon}`, `n:${sEvening}`])
})

test('a drawer closed before the time, or a single-shift segment, gets nothing', async () => {
  // تک‌شیفت: همان بخش با عکس برنامهٔ تک‌شیفت؛ خواننده حالت را از عکس همان بخش می‌گیرد
  await endSegment(sEvening, at(23, 15))
  const single = await openSegment(evening, sara, at(23, 16), at(23, 20), 'SINGLE_SHIFT')
  const reader = createMessengerDb()
  assert.equal((await reader.shiftReminderSegment()).mode, 'SINGLE_SHIFT')
  const mark = mock.log.length
  await minute(at(23, 55))
  assert.deepEqual(reminders(ALL, mark), [], 'single shift: nothing')
  await endSegment(single, at(23, 56))
  assert.equal(await reader.shiftReminderSegment(), null, 'no open drawer: nothing to remind')
  await minute(at(23, 58))
  assert.deepEqual(reminders(ALL, mark), [])
})

test('cursor file: an old file without the list still reads (empty list); stray entries are dropped', () => {
  const dir2 = join(ROOT, 'old-cursor'); mkdirSync(dir2, { recursive: true })
  const store2 = createMessengerStore(dir2, storage)
  const old = { version: 1, auditId: 5, auditHash: 'x', counter: null, custodyEventId: 0, custodyCountId: 0, closeShiftIds: [], summaryDay: '1405/09/07', pendingBackupAt: null, pendingKind: null, resetOnStart: false }
  writeFileSync(join(dir2, 'messenger-cursor.json'), JSON.stringify(old))
  assert.deepEqual(store2.readCursor(), { ...old, reminderKeys: [] })
  writeFileSync(join(dir2, 'messenger-cursor.json'), JSON.stringify({ ...old, reminderKeys: ['h:12', 'n:13', 'x:1', 7, 'h:abc', ...Array.from({ length: 45 }, (_, i) => `h:${100 + i}`)] }))
  const keys = store2.readCursor().reminderKeys
  assert.equal(keys.length, 40, 'only the last 40')
  assert.ok(keys.every((k) => /^[hn]:\d+$/.test(k)))
  assert.equal(keys.at(-1), 'h:144')
})

test('no database write, and the reader selects no amount, code or phone column', () => {
  const src = read('src/main/services/cloud/messenger/messengerDb.ts')
  const fn = src.slice(src.indexOf('async function shiftReminderSegment'), src.indexOf('async function userNames'))
  assert.ok(fn.length > 200, 'the reader was found')
  assert.doesNotMatch(fn, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/, 'read only')
  assert.doesNotMatch(fn, /phone|code: true|amount|cash|reference/i, 'no phone, code or money column')
  for (const chat of [ALL, HANDOVER, IMPORTANT]) {
    for (const t of reminders(chat)) assert.ok(!t.includes('ریال') && !/09\d{9}/.test(t), 'no amount and no phone in what was sent')
  }
  mock.server.close()
})
