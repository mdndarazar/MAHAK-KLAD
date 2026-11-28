/**
 * دفتر آزمون ۴-۳۰ — نوع قفل در پیام درخواست مجوز ربات تلگرام و بله (معماری §۶ خط ۵۶۴):
 *  - `lockKindOf`: هر کلید قفل و هر شناسهٔ کار دقیقاً یک نوع دارد، با همان مرز کدها و مدت‌ها (`codeSectionOfPanel`، ۴-۲۸):
 *    «کار یک‌باره»، «ماژول معمولی» یا «ماژول پولی و حساس»؛ نشانهٔ رنگی هر نوع جداست؛
 *  - پیام درخواست (کنترلر واقعی ربات، پل واقعی و رجیستری واقعی): زیر «قفل» خط «نوع»، و برای ماژول «زمان رایانه برای این
 *    نوع» از پروندهٔ مدت‌ها؛ قسمت تازهٔ طرح ۱۴۰۵ که امروز برچسب ندارد «ماژول پولی و حساس» است؛ قفل کار «زمان ندارد»؛
 *  - عدد پیام همان مدتی است که فعال‌سازی مجوز با سیم‌کشی میزبان می‌گیرد؛
 *  - نتیجه برای گیرندهٔ دیگر و خبر همه نوع و زمان را می‌گویند؛ رد هم نوع را؛
 *  - خبر «مجوز باز شد» (ردیف `REMOTE_GRANT_OPENED`) نوع و زمان را دارد؛ ردیف قدیمی بی نوع همان دو خط قبلی را؛
 *  - هیچ مبلغ، تلفن یا رمز در پیام‌ها نیست.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-30-lock-kind.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-30-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
const durations = await import('../../src/main/services/locks/durations.ts')
const { createBotRemoteBridge } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const { createBotController, botKindLine, botLockTitle } = await import('../../src/main/services/cloud/messenger/messengerBot.ts')
const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { renderItem } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_ACTION_IDS, gateEntry } = await import('../../src/shared/gateCatalog.ts')
const { LOCKED_PANELS, LOCK_KIND_SIGNS, LOCK_KIND_TITLES, codeSectionOfPanel, lockKindOf } = await import('../../src/shared/panels.ts')
const { faDigits } = await import('@shared/jalali')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const MIN = 60_000
durations.writeLockDurations({ sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 90, remoteSensitiveGrantMinutes: 20 })

// ---------------------------------------------------------------- میزبان ساختگی رجیستری، با همان سیم‌کشی مدت `CloudSyncService`
const opened = []
reg.initRemoteGrantRegistry({
  notePanelUnlocked: (panel, _scope, owner, _allowed, ttlMs) => { opened.push({ panel, owner, ttlMs }); return () => {} },
  clearPanelScope: () => {}, clearPanelSessions: () => {},
  addOneShotTicket: (panel, owner, ttlMs) => { opened.push({ panel, owner, ttlMs }); return true },
  clearOneShotTickets: () => {},
  grantDurationMs: (panel) => GATE_ACTION_IDS.includes(panel) ? durations.lockDurationMs('remoteSensitiveGrantMinutes') : durations.partDurationMs(durations.remoteDurationKey(codeSectionOfPanel(panel)))
})

// ---------------------------------------------------------------- ربات با Bot API ساختگی (هر پیام‌رسان جدا)
let clock = Date.UTC(2026, 10, 24, 10, 50)
const advance = (ms) => { clock += ms }
const R1 = { id: 'aaaaaaaaaaa1', provider: 'telegram', chatId: 501, name: 'مالک تلگرام', mode: 'all', active: true, inactiveReason: null, addedAt: 0, canApprove: true, canViewReports: false }
const R2 = { id: 'aaaaaaaaaaa2', provider: 'bale', chatId: 502, name: 'مالک بله', mode: 'all', active: true, inactiveReason: null, addedAt: 0, canApprove: true, canViewReports: false }
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
const remote = createBotRemoteBridge({ available: async () => true, closeAll: () => {}, note: (f) => notes.push(f) })
const bot = createBotController({
  settings: () => ({ recipients: [R1, R2] }),
  active: () => true,
  remote,
  api: (provider) => apis[provider],
  pairingProvider: () => null,
  exclusive: (fn) => fn(),
  notifyAll: async (title, lines, important) => { notices.push({ title, lines, important }) },
  conflict: async () => {},
  summary: async () => ({ title: '', lines: [] }),
  offsetHours: async () => 3.5,
  now: () => clock,
  log: () => {},
  schedule: false,
  pollSeconds: 0,
  reports: null
})
const sentTo = (provider, chatId) => apis[provider].calls.filter((c) => c.m === 'send' && c.chatId === chatId && c.keyboard?.inline_keyboard?.[0]?.length === 2)
const lastEdit = (provider, chatId) => apis[provider].calls.filter((c) => c.m === 'edit' && c.chatId === chatId).at(-1)
const lastAnswer = (provider) => apis[provider].calls.filter((c) => c.m === 'answer').at(-1)?.text
async function press(provider, r, data, messageId) {
  advance(6000)
  const api = apis[provider]
  api.queue.push({ update_id: api.nextUpdate(), callback_query: { id: `cq-${api.calls.length}`, data, from: { id: r.chatId }, message: { message_id: messageId, chat: { id: r.chatId, type: 'private' }, text: 'x' } } })
  assert.equal(await bot.pollOnce(provider, 0), 'ok')
}
/** آخرین پیام درخواستِ همان قفل برای یک گیرنده و دکمه‌های ردیف اولش */
function requestFor(provider, r, title) {
  const sent = sentTo(provider, r.chatId).filter((c) => c.text.includes(`قفل: ${title}`)).at(-1)
  assert.ok(sent, `${r.name} got the request for ${title}`)
  return { text: sent.text, id: sent.id, approve: sent.keyboard.inline_keyboard[0][0].callback_data, reject: sent.keyboard.inline_keyboard[0][1].callback_data }
}
const linesOf = (text) => text.split('\n').map((l) => l.replace(/^\u200F/, ''))
const NO_SECRETS = /ریال|مبلغ|09\d{9}|تلفن|رمز|PIN/

const W = 7301
const NORMAL = 'products', MONEY = 'cash-close', FRESH = 'staff'
const ACTION = GATE_ACTION_IDS.find((id) => REMOTE_PANELS.includes(id) && gateEntry(id)?.category === 3)

// ---------------------------------------------------------------- واحد: نوع هر قفل
test('every lock key and every action id has exactly one kind, on the same border as codes and durations (4-28)', () => {
  assert.deepEqual(Object.keys(LOCK_KIND_TITLES).sort(), ['action', 'normal', 'sensitive'])
  assert.equal(new Set(Object.values(LOCK_KIND_SIGNS)).size, 3, 'a separate colour sign for each kind')
  const keys = [...new Set([...LOCKED_PANELS.map((p) => p.key), ...GATE_ACTION_IDS, ...REMOTE_PANELS])]
  const count = { action: 0, normal: 0, sensitive: 0 }
  for (const key of keys) {
    const kind = lockKindOf(key)
    assert.ok(kind in count, key)
    count[kind]++
    const def = LOCKED_PANELS.find((p) => p.key === key)
    const isAction = gateEntry(key)?.category === 3 || def?.kind === 'action'
    assert.equal(kind === 'action', isAction, `${key}: an action lock ⇔ «کار یک‌باره»`)
    if (!isAction) assert.equal(kind === 'normal', codeSectionOfPanel(key) === 'other', `${key}: normal ⇔ the «other modules» code section`)
    if (!isAction) assert.equal(durations.remoteDurationKey(codeSectionOfPanel(key)), kind === 'normal' ? 'remoteGrantMinutes' : 'remoteSensitiveGrantMinutes', `${key}: the same duration key`)
  }
  assert.ok(count.action >= GATE_ACTION_IDS.length && count.normal > 0 && count.sensitive > 0, JSON.stringify(count))
  // قسمت‌های تازهٔ طرح ۱۴۰۵ (رده «حساس»، امروز بی برچسب کنار نام) «ماژول پولی و حساس» هستند
  const fresh = LOCKED_PANELS.filter((p) => p.kind === 'part' && p.tier === 'sensitive')
  assert.ok(fresh.length >= 7 && fresh.some((p) => p.key === FRESH))
  for (const p of fresh) { assert.equal(lockKindOf(p.key), 'sensitive', p.key); assert.equal(botLockTitle(p.key), p.title, `${p.key}: no label next to the name today`) }
  for (const p of LOCKED_PANELS.filter((x) => x.kind === 'part' && x.tier === 'money')) assert.equal(lockKindOf(p.key), 'sensitive', p.key)
  assert.equal(lockKindOf('no-such-panel'), 'sensitive', 'an unknown key is never shown as normal')
  assert.equal(botKindLine(NORMAL), '🟢 نوع: ماژول معمولی')
  assert.equal(botKindLine(MONEY), '🟠 نوع: ماژول پولی و حساس')
  assert.equal(botKindLine(ACTION), '🔴 نوع: کار یک‌باره (فقط یک بار؛ زمان ندارد)')
})

test('the bridge gives the computer time of each module kind (= the duration the activation reads); none for an action', () => {
  for (const panel of REMOTE_PANELS) {
    const m = remote.minutesFor(panel)
    if (lockKindOf(panel) === 'action') { assert.equal(m, null, panel); continue }
    assert.equal(m, lockKindOf(panel) === 'normal' ? 90 : 20, panel)
  }
  assert.equal(remote.minutesFor('no-such-panel'), null)
})

// ---------------------------------------------------------------- پیام درخواست برای هر سه نوع
test('the request message: «نوع» right under «قفل», and the computer time for modules only', async () => {
  for (const panel of [NORMAL, MONEY, FRESH, ACTION]) reg.requestCode(panel, W)
  await bot.tick()
  const expect = [
    [NORMAL, 'کالاها', '🟢 نوع: ماژول معمولی', 90],
    [MONEY, 'بستن صندوق (پولی)', '🟠 نوع: ماژول پولی و حساس', 20],
    [FRESH, 'کارمندان', '🟠 نوع: ماژول پولی و حساس', 20],
    [ACTION, `${gateEntry(ACTION).titleFa} (یک بار)`, '🔴 نوع: کار یک‌باره (فقط یک بار؛ زمان ندارد)', null]
  ]
  for (const [provider, r] of [['telegram', R1], ['bale', R2]]) {
    for (const [panel, title, kindLine, minutes] of expect) {
      const { text } = requestFor(provider, r, title)
      const lines = linesOf(text)
      const at = lines.indexOf(`🔒 قفل: ${title}`)
      assert.ok(at > 0, text)
      assert.equal(lines[at + 1], kindLine, `${panel}: the kind line comes right after the lock line`)
      if (minutes === null) {
        assert.equal(lines.some((l) => l.includes('زمان رایانه')), false, `${panel}: an action has no time line`)
        assert.match(lines[at + 2], /^🔎 کد مقایسه: /)
      } else {
        assert.equal(lines[at + 2], `⏱ زمان رایانه برای این نوع: ${faDigits(minutes)} دقیقه`, panel)
        assert.match(lines[at + 3], /^🔎 کد مقایسه: /)
      }
      assert.equal(lines.filter((l) => /^\S+ نوع: /u.test(l)).length, 1, `${panel}: one kind line`)
      assert.doesNotMatch(text, NO_SECRETS)
    }
  }
})

test('the number on the message is the duration the grant really gets on activation (host wiring)', async () => {
  const pending = remote.pending().find((p) => p.panel === NORMAL && p.ownerWindowId === W)
  assert.ok(pending)
  const { gt, requestId } = reg.requestCode(NORMAL, W + 1)
  assert.equal(await remote.approve({ requestId, code: '0', panel: NORMAL, ownerWindowId: W + 1 }, 'bot-aaaaaaaaaaa1'), 'OK')
  assert.equal(reg.consumeOneShot(W + 1, NORMAL, gt.slice(3)), true)
  const got = opened.find((o) => o.panel === NORMAL && o.owner === W + 1)
  assert.equal(got.ttlMs, remote.minutesFor(NORMAL) * MIN, '90 minutes, as on the message')
  const fresh = reg.requestCode(FRESH, W + 1)
  assert.equal(await remote.approve({ requestId: fresh.requestId, code: '0', panel: FRESH, ownerWindowId: W + 1 }, 'bot-aaaaaaaaaaa1'), 'OK')
  assert.equal(reg.consumeOneShot(W + 1, FRESH, fresh.gt.slice(3)), true)
  assert.equal(opened.find((o) => o.panel === FRESH && o.owner === W + 1).ttlMs, 20 * MIN)
  reg.revokeBy('bot-aaaaaaaaaaa1')
})

// ---------------------------------------------------------------- نتیجه برای بقیه و خبر همه
test('approve and reject: the other recipient and the notice to everyone see the kind and the time', async () => {
  const normal = requestFor('bale', R2, 'کالاها')
  await press('bale', R2, normal.approve, normal.id)
  assert.equal(lastAnswer('bale'), 'تأیید شد')
  const edited = lastEdit('telegram', R1.chatId).text
  assert.match(edited, /✅ تأیید شد \(مالک بله\) · ۹۰ دقیقه · /, 'the other recipient sees the result and the time')
  let n = notices.at(-1)
  assert.equal(n.title, '🤖 درخواست مجوز با ربات تأیید شد')
  assert.deepEqual(n.lines, ['قفل: کالاها', '🟢 نوع: ماژول معمولی', '⏱ زمان: ۹۰ دقیقه (همان تنظیمات رایانه)', `پنجرهٔ ${faDigits(W)}`, 'گیرنده: مالک بله'])
  assert.deepEqual(notes.at(-1), { decision: 'تأیید', recipientName: 'مالک بله', titleFa: 'کالاها', windowNo: W }, 'the decision row keeps its fields')

  const action = requestFor('telegram', R1, `${gateEntry(ACTION).titleFa} (یک بار)`)
  await press('telegram', R1, action.approve, action.id)
  assert.match(lastEdit('bale', R2.chatId).text, /✅ تأیید شد \(مالک تلگرام\) · یک بار · /)
  n = notices.at(-1)
  assert.deepEqual(n.lines.slice(1, 3), ['🔴 نوع: کار یک‌باره (فقط یک بار؛ زمان ندارد)', '⏱ زمان: یک بار'])

  const money = requestFor('telegram', R1, 'بستن صندوق (پولی)')
  await press('telegram', R1, money.reject, money.id)
  assert.equal(lastAnswer('telegram'), 'رد شد')
  n = notices.at(-1)
  assert.equal(n.title, '🤖 درخواست مجوز با ربات رد شد')
  assert.deepEqual(n.lines, ['قفل: بستن صندوق (پولی)', '🟠 نوع: ماژول پولی و حساس', `پنجرهٔ ${faDigits(W)}`, 'گیرنده: مالک تلگرام'])

  const fresh = requestFor('bale', R2, 'کارمندان')
  await press('bale', R2, fresh.approve, fresh.id)
  assert.match(lastEdit('telegram', R1.chatId).text, /✅ تأیید شد \(مالک بله\) · ۲۰ دقیقه · /)
  assert.deepEqual(notices.at(-1).lines.slice(1, 3), ['🟠 نوع: ماژول پولی و حساس', '⏱ زمان: ۲۰ دقیقه (همان تنظیمات رایانه)'])
  for (const c of [...apis.telegram.calls, ...apis.bale.calls]) if (c.text) assert.doesNotMatch(c.text, NO_SECRETS)
  for (const x of notices) assert.doesNotMatch(x.lines.join('\n'), NO_SECRETS)
  reg.revokeBy('bot-aaaaaaaaaaa1'); reg.revokeBy('bot-aaaaaaaaaaa2')
})

// ---------------------------------------------------------------- «مجوز باز شد»
test('«مجوز راه دور باز شد» says the kind and the time; an old row without a kind keeps its two lines', () => {
  const AT = Date.UTC(2026, 10, 24, 10, 50)
  const data = emptyLookups(); data.users.set(5, 'علی')
  const row = (id, after) => ({ id, at: AT, userId: 5, action: 'ACCESS_EVENT', entity: 'Access', entityId: null, after: JSON.stringify({ kind: 'REMOTE_GRANT_OPENED', ...after }), note: null })
  const [normal, action, money, old, odd] = auditPageToEvents([
    row(1, { titleFa: 'کالاها', windowNo: 3, decision: 'ماژول معمولی', minutes: 90 }),
    row(2, { titleFa: gateEntry(ACTION).titleFa, windowNo: 3, decision: 'کار یک‌باره', minutes: 60 }),
    row(3, { titleFa: 'بستن صندوق', windowNo: 2, decision: 'ماژول پولی و حساس', minutes: 20 }),
    row(4, { titleFa: 'برگشت از فروش', windowNo: 2 }),
    row(5, { titleFa: 'کالاها', windowNo: 2, decision: 'چیز دیگر', minutes: 5 })
  ], { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })
  assert.deepEqual(normal.lines, [`قفل: کالاها · پنجرهٔ ۳`, '🟢 نوع: ماژول معمولی', '⏱ زمان: ۹۰ دقیقه', 'کاربر: علی'])
  assert.deepEqual(action.lines, [`قفل: ${gateEntry(ACTION).titleFa} · پنجرهٔ ۳`, '🔴 نوع: کار یک‌باره', '⏱ زمان: یک بار', 'کاربر: علی'])
  assert.deepEqual(money.lines, ['قفل: بستن صندوق · پنجرهٔ ۲', '🟠 نوع: ماژول پولی و حساس', '⏱ زمان: ۲۰ دقیقه', 'کاربر: علی'])
  assert.deepEqual(old.lines, ['قفل: برگشت از فروش · پنجرهٔ ۲', 'کاربر: علی'], 'an old row: the same two lines as before')
  assert.deepEqual(odd.lines, ['قفل: کالاها · پنجرهٔ ۲', 'کاربر: علی'], 'only the three fixed kind labels count')
  for (const ev of [normal, action, money]) assert.ok(ev.important && ev.title.startsWith('📱 مجوز راه دور باز شد'))
  const text = renderItem({ code: normal.code, at: normal.at, title: normal.title, lines: normal.lines, important: true, maybeDup: false, sale: false, day: null }, normal.at)
  assert.deepEqual(linesOf(text).slice(2, 6), ['🔒 قفل: کالاها · پنجرهٔ ۳', '🟢 نوع: ماژول معمولی', '⏱ زمان: ۹۰ دقیقه', '👤 کاربر: علی'], 'one sign per line in the uniform format')
})

test('the host writes the kind label and the minutes into «REMOTE_GRANT_OPENED» (part and action), from the same border', () => {
  const host = read('src/main/services/CloudSyncService.ts')
  assert.match(host, /noteAccessEvent\('REMOTE_GRANT_OPENED',\{titleFa:panelTitle\(panel\),windowNo:owner,decision:LOCK_KIND_TITLES\[lockKindOf\(panel\)\],\.\.\.\(typeof ttlMs==='number' \? \{minutes:Math\.round\(ttlMs\/60_000\)\} : \{\}\)\}\)/)
  assert.match(host, /noteAccessEvent\('REMOTE_GRANT_OPENED',\{titleFa:gateEntry\(actionId\)\?\.titleFa,windowNo:owner,decision:LOCK_KIND_TITLES\.action,minutes:Math\.round\(ttl\/60_000\),\.\.\.\(uses>1 \? \{count:uses\} : \{\}\)\}\)/, '4-31: a repeatable action also writes its count')
  assert.match(host, /grantDurationMs:\(panel\)=>GATE_ACTION_IDS\.includes\(panel\) \? lockDurationMs\('remoteSensitiveGrantMinutes'\) : partDurationMs\(remoteDurationKey\(codeSectionOfPanel\(panel\)\)\)/, 'the same duration the bridge shows')
  for (const label of Object.values(LOCK_KIND_TITLES)) assert.ok(label.length <= 40, 'fits the 40-character decision label')
})
