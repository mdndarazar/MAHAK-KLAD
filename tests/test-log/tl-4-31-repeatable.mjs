/**
 * دفتر آزمون ۴-۳۱ — «تأیید برای چند بار» برای کارهای یک‌بارهٔ قابل تکرار (معماری §۶ خط ۵۶۵، بخش ۵؛ TL-D12):
 *  - نُه کار برگشت‌ناپذیر هرگز قابل تکرار نمی‌شوند؛ ۴۴ کار دیگرِ ۵۳ کار کاتالوگ می‌توانند؛
 *  - `lock-durations.json`: «حداکثر دفعات هر مجوز» (۱ تا ۱۰۰۰، پیش‌فرض ۱) و فهرست «قابل تکرار» (پیش‌فرض هیچ)؛ پروندهٔ
 *    قدیمی سالم؛ هر کلید نادرست ⇒ همه پیش‌فرض؛ نوشتن مدت‌ها تنظیم تکرار را نگه می‌دارد؛ تغییر با رمز تایپی مدیر؛
 *  - تأیید گوشی کار علامت‌خورده: بلیت چندباره با تعداد رایانه، تا مدت «پولی و حساس» (بیش از ۶۰ دقیقه)؛ هر بار خبر
 *    «بار n از m»؛ بار بعد از آخر مجوز تازه می‌خواهد؛ کار علامت‌نخورده همان یک بار و ۶۰ دقیقه؛
 *  - ربات: «✅ تأیید · همان تنظیمات رایانه (۳ بار)» و «🔢 وارد کردن تعداد»؛ کار دیگر «✅ تأیید (یک بار)»؛ تعداد رایانه،
 *    تعداد دلخواه، تعداد نادرست و دیررس؛ «مجوزهای باز» دفعات باقی را نشان می‌دهد؛ پل تعداد را برای کار دیگر نمی‌پذیرد؛
 *  - «بستن همه»، P1/P2 و برداشتن گیرندهٔ ربات دفعات باقی را می‌بندند؛ کد یک‌بارمصرف همان یک بار؛
 *  - پیام‌ها: «مجوز باز شد» با دفعات، «🔁 … · بار ۲ از ۳» و «⚙️ کارهای قابل تکرار عوض شد»؛ صفحه و سیم‌کشی میزبان.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-31-repeatable.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance as perfHooksPerformance } from 'node:perf_hooks'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-31-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const durations = await import('../../src/main/services/locks/durations.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction } = await import('../../src/main/services/locks/gate.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { noteAccessEvent, setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { createBotRemoteBridge, takeBotUses } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const { createBotController, parseUses } = await import('../../src/main/services/cloud/messenger/messengerBot.ts')
const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { GATE_ACTION_IDS, GATE_CATALOG, GATE_IRREVERSIBLE_ACTIONS, gateEntry } = await import('../../src/shared/gateCatalog.ts')
const { LOCK_KIND_TITLES } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { faDigits } = await import('@shared/jalali')

harnessClient()
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const MIN = 60_000
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const FILE = join(DIR, 'lock-durations.json')
const TENS = { sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 10, remoteSensitiveGrantMinutes: 10 }
const DUR = { sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 35, remoteSensitiveGrantMinutes: 120 }
const REFUND = 'return.refund-card', CHEQUE = 'cheque.replace', VOID = 'credit.void'

// ساعت ساختگی (یکنواخت و دیواری با هم)
assert.equal(perfHooksPerformance, globalThis.performance)
const realNow = performance.now.bind(performance), realDateNow = Date.now
let shift = 0
performance.now = () => realNow() + shift
Date.now = () => realDateNow() + shift
const advance = (ms) => { shift += ms }

const events = []
setAccessEventWriter((after) => { events.push(after) })
const eventsOf = (kind) => events.filter((e) => e.kind === kind)
const handlers = new Map()
lockIpc.registerLockHandlers((channel, fn) => handlers.set(channel, fn), {
  unlock: 'u', closeAll: 'ca', durationsGet: 'dg', durationsSet: 'ds', redeemCode: 'rc', codesStatus: 'cs', codesCreate: 'cc',
  codesRevoke: 'cr', codesUnlock: 'cu', scheduledList: 'sl', scheduledCreate: 'sc', scheduledCancel: 'sx'
})

// ---------------------------------------------------------------- همان سیم‌کشی میزبان در CloudSyncService (آزمون آخر عبارت را در خود پرونده می‌سنجد)
const hostTicket = (actionId, owner, ttlMs, memberId) => {
  const max = durations.repeatUsesOf(actionId), uses = max === null ? 1 : takeBotUses(owner, actionId, memberId) ?? max, ttl = uses > 1 ? durations.partDurationMs('remoteSensitiveGrantMinutes') : ttlMs
  const made = tickets.addGateTicket(owner, actionId, ttl, 'REMOTE_GRANT', { memberId, ...(uses > 1 ? { uses } : {}) })
  if (made) noteAccessEvent('REMOTE_GRANT_OPENED', { titleFa: gateEntry(actionId)?.titleFa, windowNo: owner, decision: LOCK_KIND_TITLES.action, minutes: Math.round(ttl / 60_000), ...(uses > 1 ? { count: uses } : {}) })
  return made
}
reg.initRemoteGrantRegistry({
  notePanelUnlocked: () => () => {},
  clearPanelScope: sessions.clearPanelScope, clearPanelSessions: sessions.clearPanelSessions,
  addOneShotTicket: hostTicket,
  clearOneShotTickets: (memberId) => tickets.clearGateTickets(memberId === undefined ? {} : { memberId }),
  grantDurationMs: (panel) => GATE_ACTION_IDS.includes(panel) ? durations.lockDurationMs('remoteSensitiveGrantMinutes') : durations.partDurationMs('remoteGrantMinutes')
})
const lease = reg.acquireRemoteAdmissionLease()
lease.installClaimGuard(async (claim) => claim())
lease.open()
/** تأیید «گوشی» (همان createGrant هاب با عضو هاب) و فعال‌سازی روی رایانه */
async function phoneGrant(actionId, owner) {
  const p = reg.requestCode(actionId, owner)
  assert.ok(reg.createGrant({ panel: actionId, ownerWindowId: owner, tier: 'SENSITIVE_MONEY', mode: 'ONE_SHOT', memberId: 'member1', requestId: p.requestId, ttlMs: 1000 * MIN }))
  assert.equal(await reg.claimRemotePanel(owner, actionId, p.requestId, p.gt.slice(3)), true)
}
const inCall = (owner, fn) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, fn))
const voidEntry = GATE_CATALOG[VOID]
const useVoid = (owner) => inCall(owner, () => gateAction(VOID, () => auth.assertPanelPasswordStrict(voidEntry.parentPanel, '', voidEntry.titleFa)))
const outcome = async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } }

// ---------------------------------------------------------------- ربات با Bot API ساختگی
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
const notices = []
const remote = createBotRemoteBridge({ available: async () => true, closeAll: () => lockIpc.closeAllUnlocks(), note: () => {} })
const bot = createBotController({
  settings: () => ({ recipients: [R1, R2] }), active: () => true, remote, api: (provider) => apis[provider], pairingProvider: () => null,
  exclusive: (fn) => fn(), notifyAll: async (title, lines, important) => { notices.push({ title, lines, important }) }, conflict: async () => {},
  summary: async () => ({ title: '', lines: [] }), offsetHours: async () => 3.5, now: () => Date.now(), log: () => {}, schedule: false, pollSeconds: 0, reports: null
})
const calls = (r) => apis[r.provider].calls.filter((c) => c.chatId === r.chatId)
const lastSend = (r) => calls(r).filter((c) => c.m === 'send').at(-1)
const lastEdit = (r) => calls(r).filter((c) => c.m === 'edit').at(-1)
const lastAnswer = (r) => apis[r.provider].calls.filter((c) => c.m === 'answer').at(-1)?.text
async function press(r, data) {
  advance(6000)
  const api = apis[r.provider]
  api.queue.push({ update_id: api.nextUpdate(), callback_query: { id: `cq-${api.calls.length}`, data, from: { id: r.chatId }, message: { message_id: 1, chat: { id: r.chatId, type: 'private' }, text: 'x' } } })
  assert.equal(await bot.pollOnce(r.provider, 0), 'ok')
}
async function say(r, text) {
  advance(1000)
  const api = apis[r.provider]
  api.queue.push({ update_id: api.nextUpdate(), message: { message_id: 9000 + api.calls.length, date: Math.floor(Date.now() / 1000), chat: { id: r.chatId, type: 'private' }, from: { id: r.chatId }, text } })
  assert.equal(await bot.pollOnce(r.provider, 0), 'ok')
}
function request(r, title) {
  const sent = calls(r).filter((c) => c.m === 'send' && c.keyboard?.inline_keyboard?.[0]?.length === 2 && c.text.includes(`قفل: ${title}\n`)).at(-1)
  assert.ok(sent, `${r.name} got the request for ${title}`)
  const rows = sent.keyboard.inline_keyboard
  return { text: sent.text, rows, approve: rows[0][0].callback_data, count: rows[1]?.[0]?.callback_data ?? null }
}
const textRows = (rows) => rows.map((row) => row.map((b) => b.text))
const markOnly = async (actions, usesMax = 3) => lockIpc.setLockDurations({ managerPassword: PW, repeatUsesMax: usesMax, repeatableActions: actions })

// ---------------------------------------------------------------- فهرست کارها
test('the nine irreversible actions never repeat; the other 44 of the 53 catalog actions can be marked', () => {
  assert.deepEqual(GATE_IRREVERSIBLE_ACTIONS.map((id) => gateEntry(id)?.titleFa), [
    'صفر کردن برنامه', 'بازگردانی کامل بکاپ', 'ادغام بکاپ', 'حذف بکاپ از فهرست', 'پاک‌سازی گزارشات فروش',
    'آرشیو و پاک‌سازی داده‌های قدیمی', 'بازسازی دفتر هزینهٔ گزارش مدیریت', 'قطع دائم اتصال موجودی سایت', 'حذف اعتبار'])
  for (const id of GATE_IRREVERSIBLE_ACTIONS) assert.equal(gateEntry(id).category, 3, id)
  assert.equal(GATE_ACTION_IDS.length, 53)
  assert.equal(durations.REPEATABLE_ACTION_IDS.length, 44)
  assert.deepEqual([...durations.REPEATABLE_ACTION_IDS], GATE_ACTION_IDS.filter((id) => !GATE_IRREVERSIBLE_ACTIONS.includes(id)))
})

// ---------------------------------------------------------------- پرونده
test('the settings file: one use and nothing marked by default; the old file is fine; any wrong repeat key => all defaults; durations writes keep the settings; defaults are not written', () => {
  assert.deepEqual(durations.readRepeatSettings(), { usesMax: 1, actions: [] }, 'no file')
  writeFileSync(FILE, JSON.stringify({ sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25, remoteSensitiveGrantMinutes: 30 }))
  assert.deepEqual(durations.readRepeatSettings(), { usesMax: 1, actions: [] }, 'old four-key file')
  assert.deepEqual(durations.readLockDurations(), { sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25, remoteSensitiveGrantMinutes: 30 })
  durations.writeLockSettings(DUR, { usesMax: 3, actions: [REFUND, VOID] })
  const raw = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(raw, { ...DUR, repeatUsesMax: 3, repeatableActions: [VOID, REFUND] }, 'catalog order')
  durations.writeLockDurations({ ...DUR, remoteGrantMinutes: 40 })
  assert.deepEqual(durations.readRepeatSettings(), { usesMax: 3, actions: [VOID, REFUND] }, 'a durations write keeps the repeat settings')
  assert.equal(durations.readLockDurations().remoteGrantMinutes, 40)
  const good = JSON.parse(readFileSync(FILE, 'utf8'))
  for (const bad of [{ repeatUsesMax: 0 }, { repeatUsesMax: 1001 }, { repeatUsesMax: '3' }, { repeatUsesMax: 1.5 }, { repeatableActions: VOID }, { repeatableActions: ['no.such'] },
    { repeatableActions: ['credit.delete'] }, { repeatableActions: [VOID, VOID] }, { repeatableActions: [7] }, { other: 1 }]) {
    writeFileSync(FILE, JSON.stringify({ ...good, ...bad }))
    assert.deepEqual(durations.readLockDurations(), TENS, `${JSON.stringify(bad)}: all four 10`)
    assert.deepEqual(durations.readRepeatSettings(), { usesMax: 1, actions: [] }, `${JSON.stringify(bad)}: one use, nothing marked`)
  }
  writeFileSync(FILE, JSON.stringify(good))
  assert.throws(() => durations.writeLockSettings(DUR, { usesMax: 3, actions: ['credit.delete'] }), /Invalid lock durations/)
  assert.throws(() => durations.writeLockSettings(DUR, { usesMax: 1001, actions: [] }), /Invalid lock durations/)
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), good, 'a refused write leaves the file')
  durations.writeLockSettings(DUR, { usesMax: 1000, actions: [...durations.REPEATABLE_ACTION_IDS] })
  assert.ok(statSync(FILE).size < 4096, 'all 44 fit the 4 KB file limit')
  assert.equal(durations.readRepeatSettings().actions.length, 44)
  durations.writeLockSettings(DUR, { usesMax: 1, actions: [] })
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), DUR, 'default repeat settings keep the old file shape')
  assert.equal(durations.repeatUsesOf(VOID), null)
})

test('lockDurations:set takes the count and the list with the typed manager password; an irreversible action, 1001 or no password => refused, nothing changes; the reply keeps its four durations; lockDurations:get shows them', async () => {
  events.length = 0
  const d = await markOnly([REFUND, VOID], 3)
  assert.deepEqual(d, DUR, 'the reply is the same four durations')
  assert.deepEqual(durations.readRepeatSettings(), { usesMax: 3, actions: [VOID, REFUND] })
  assert.deepEqual(eventsOf('REPEAT_SETTINGS_CHANGED').map((e) => [e.number, e.count]), [[3, 2]])
  assert.deepEqual(eventsOf('DURATIONS_CHANGED'), [])
  await assert.rejects(() => markOnly([VOID, 'credit.delete']), (err) => err.message.includes('«حذف اعتبار» برگشت‌ناپذیر است و هرگز قابل تکرار نمی‌شود'))
  await assert.rejects(() => markOnly([VOID], 1001), (err) => err.message.includes('«حداکثر دفعات هر مجوز» باید عددی صحیح بین ۱ تا ۱۰۰۰ باشد'))
  await assert.rejects(() => markOnly(['no.such']), /نامعتبر/)
  await assert.rejects(() => lockIpc.setLockDurations({ managerPassword: '', repeatUsesMax: 5 }))
  assert.deepEqual(durations.readRepeatSettings(), { usesMax: 3, actions: [VOID, REFUND] }, 'nothing changed')
  assert.equal(eventsOf('REPEAT_SETTINGS_CHANGED').length, 1)
  const view = await handlers.get('dg')()
  assert.deepEqual({ ...view, openRepeats: undefined }, { ...DUR, repeatUsesMax: 3, repeatableActions: [VOID, REFUND], openRepeats: undefined })
  assert.deepEqual(view.openRepeats, [])
})

// ---------------------------------------------------------------- تأیید گوشی و دروازه
test('a phone approval of a marked action: three uses with the computer count, a «use n of 3» notice each; the fourth needs a new grant; the window is the sensitive duration (above 60 minutes); an unmarked action stays one time', async () => {
  events.length = 0
  await phoneGrant(VOID, 401)
  const t = tickets.peekGateTicket(401, VOID)
  assert.deepEqual([t.uses, t.left], [3, 3])
  assert.ok(t.expiresAt - performance.now() > 119 * MIN, 'up to the 120-minute sensitive duration, past the one-time 60-minute window')
  assert.deepEqual(eventsOf('REMOTE_GRANT_OPENED').map((e) => [e.decision, e.minutes, e.count]), [['کار یک‌باره', 120, 3]])
  for (let i = 1; i <= 3; i++) assert.equal((await outcome(() => useVoid(401))).ok, true, `use ${i}`)
  assert.deepEqual(eventsOf('REPEAT_GRANT_USED').map((e) => [e.titleFa, e.windowNo, e.number, e.count]), [[voidEntry.titleFa, 401, 1, 3], [voidEntry.titleFa, 401, 2, 3], [voidEntry.titleFa, 401, 3, 3]])
  const fourth = await outcome(() => useVoid(401))
  assert.equal(fourth.ok, false)
  assert.equal(fourth.err?.code, `GATE_REQUIRED:${VOID}`, 'the fourth time asks for a new grant')
  // پایان مدت پیش از تمام شدن دفعات
  await phoneGrant(VOID, 402)
  assert.equal((await outcome(() => useVoid(402))).ok, true)
  advance(118 * MIN)
  assert.ok(tickets.peekGateTicket(402, VOID), 'still there at 118 minutes')
  advance(3 * MIN)
  assert.equal(tickets.peekGateTicket(402, VOID), null, 'gone at the end of the sensitive duration, uses left or not')
  // کار علامت‌نخورده: یک بار، حداکثر ۶۰ دقیقه
  await phoneGrant(CHEQUE, 403)
  const once = tickets.peekGateTicket(403, CHEQUE)
  assert.equal(once.uses, undefined)
  assert.ok(once.expiresAt - performance.now() <= 60 * MIN)
  assert.equal(tickets.takeGateTicket(403, CHEQUE) !== null && tickets.takeGateTicket(403, CHEQUE) === null, true, 'one time')
  lockIpc.closeAllUnlocks()
})

// ---------------------------------------------------------------- ربات
test('bot: «✅ تأیید · همان تنظیمات رایانه (۳ بار)» and «🔢 وارد کردن تعداد» for a marked action, «✅ تأیید (یک بار)» otherwise; computer count, custom count, wrong and late counts; «مجوزهای باز» shows the uses left; the bridge refuses a count elsewhere', async () => {
  const W = 410
  const refundReq = reg.requestCode(REFUND, W), chequeReq = reg.requestCode(CHEQUE, W)
  await bot.tick()
  const marked = request(R1, gateEntry(REFUND).titleFa), plain = request(R1, `${gateEntry(CHEQUE).titleFa} (یک بار)`)
  assert.match(marked.text, /🔴 نوع: کار یک‌بارهٔ قابل تکرار \(تا ۳ بار\)/)
  assert.deepEqual(textRows(marked.rows), [['✅ تأیید · همان تنظیمات رایانه (۳ بار)', '❌ رد'], ['🔢 وارد کردن تعداد']])
  assert.match(marked.count, /^n:[A-Za-z0-9_-]{22}$/)
  assert.match(plain.text, /🔴 نوع: کار یک‌باره \(فقط یک بار؛ زمان ندارد\)/)
  assert.deepEqual(textRows(plain.rows), [['✅ تأیید (یک بار)', '❌ رد']])
  // تعداد دلخواه: نادرست، سپس «۵ بار»
  await press(R1, marked.count)
  assert.deepEqual(lastSend(R1).text.split('\n'), [`🔢 ${gateEntry(REFUND).titleFa} · پنجرهٔ ${faDigits(W)}`, 'تعداد را بفرستید (۱ تا ۱۰۰۰). تعداد رایانه: ۳ بار', 'فقط برای همین مجوز است و تنظیم رایانه عوض نمی‌شود. مهلت: ۲ دقیقه.'])
  assert.equal(lastSend(R1).keyboard, undefined, 'no preset buttons for a count')
  await say(R1, '0')
  assert.equal(lastSend(R1).text, 'تعداد باید عددی صحیح از ۱ تا ۱۰۰۰ باشد؛ چیزی تأیید نشد. دوباره بفرستید.')
  assert.equal(reg.getRequestStatus(W, REFUND, refundReq.requestId), 'PENDING')
  await say(R1, '۵ بار')
  assert.equal(lastSend(R1).text, '✅ تأیید شد.')
  assert.match(lastEdit(R2).text, /✅ تأیید شد \(مالک تلگرام\) · ۵ بار \(تعداد دلخواه\) · /)
  assert.deepEqual(notices.at(-1).lines, [`قفل: ${gateEntry(REFUND).titleFa}`, '🔴 نوع: کار یک‌بارهٔ قابل تکرار (تا ۵ بار)', '🔢 دفعات: ۵ بار (تعداد دلخواه)', `پنجرهٔ ${faDigits(W)}`, 'گیرنده: مالک تلگرام'])
  assert.equal(await reg.claimRemotePanel(W, REFUND, refundReq.requestId, refundReq.gt.slice(3)), true)
  assert.deepEqual([tickets.peekGateTicket(W, REFUND).uses, tickets.peekGateTicket(W, REFUND).memberId], [5, 'bot-aaaaaaaaaaa1'], 'the custom count for that one grant')
  assert.equal(durations.readRepeatSettings().usesMax, 3, 'the computer setting is unchanged')
  tickets.takeGateTicket(W, REFUND)
  await press(R1, 'm:list')
  assert.match(lastSend(R1).text, new RegExp(`${gateEntry(REFUND).titleFa} · پنجرهٔ ${faDigits(W)} · ۴ بار از ۵ باقی · [۰-۹]+ دقیقه`))
  // کار علامت‌نخورده با «✅ تأیید (یک بار)»
  await press(R2, request(R2, `${gateEntry(CHEQUE).titleFa} (یک بار)`).approve)
  assert.match(lastEdit(R1).text, /✅ تأیید شد \(مالک بله\) · یک بار · /)
  assert.deepEqual(notices.at(-1).lines.slice(1, 3), ['🔴 نوع: کار یک‌باره (فقط یک بار؛ زمان ندارد)', '⏱ زمان: یک بار'])
  assert.equal(await reg.claimRemotePanel(W, CHEQUE, chequeReq.requestId, chequeReq.gt.slice(3)), true)
  assert.equal(tickets.peekGateTicket(W, CHEQUE).uses, undefined)
  // تعداد رایانه
  const computer = reg.requestCode(REFUND, W + 1)
  await bot.tick()
  await press(R2, request(R2, gateEntry(REFUND).titleFa).approve)
  assert.match(lastEdit(R1).text, /✅ تأیید شد \(مالک بله\) · ۳ بار · /)
  assert.deepEqual(notices.at(-1).lines.slice(1, 3), ['🔴 نوع: کار یک‌بارهٔ قابل تکرار (تا ۳ بار)', '🔢 دفعات: ۳ بار (همان تنظیمات رایانه)'])
  assert.equal(await reg.claimRemotePanel(W + 1, REFUND, computer.requestId, computer.gt.slice(3)), true)
  assert.equal(tickets.peekGateTicket(W + 1, REFUND).uses, 3)
  // تعداد دیررس
  const late = reg.requestCode(REFUND, W + 2)
  await bot.tick()
  await press(R1, request(R1, gateEntry(REFUND).titleFa).count)
  advance(2 * MIN + 1000)
  await say(R1, '4')
  assert.equal(lastSend(R1).text, 'مهلت ۲ دقیقه‌ای فرستادن تعداد گذشت و چیزی تأیید نشد. اگر درخواست هنوز در انتظار است، دوباره «🔢 وارد کردن تعداد» را بزنید.')
  assert.equal(reg.getRequestStatus(W + 2, REFUND, late.requestId), 'PENDING')
  // پل: تعداد فقط برای کار علامت‌خورده، ۱ تا ۱۰۰۰، و نه همراه زمان
  const pendingOf = (panel, owner) => remote.pending().find((p) => p.panel === panel && p.ownerWindowId === owner)
  reg.requestCode(CHEQUE, W + 2)
  reg.requestCode('products', W + 2)
  assert.equal(await remote.approve(pendingOf(CHEQUE, W + 2), 'bot-aaaaaaaaaaa1', undefined, 3), 'BAD', 'an unmarked action')
  assert.equal(await remote.approve(pendingOf('products', W + 2), 'bot-aaaaaaaaaaa1', undefined, 3), 'BAD', 'a module')
  for (const bad of [0, 1001, 2.5]) assert.equal(await remote.approve(pendingOf(REFUND, W + 2), 'bot-aaaaaaaaaaa1', undefined, bad), 'BAD', String(bad))
  assert.equal(await remote.approve(pendingOf(REFUND, W + 2), 'bot-aaaaaaaaaaa1', 20), 'BAD', 'a time for an action')
  assert.equal(reg.getRequestStatus(W + 2, REFUND, late.requestId), 'PENDING')
  // تعداد دلخواه فقط برای همان عضو و تا ۱۰ دقیقه
  assert.equal(await remote.approve(pendingOf(REFUND, W + 2), 'bot-aaaaaaaaaaa1', undefined, 7), 'OK')
  assert.equal(takeBotUses(W + 2, REFUND, 'member1'), null, 'another member never gets it (and it is used up)')
  for (const [n, text] of [[5, '۵'], [5, '5 بار'], [1000, '1000']]) assert.equal(parseUses(text), n, text)
  for (const text of ['0', '1001', '2.5', 'پنج', '5 دقیقه']) assert.equal(parseUses(text), null, text)
  lockIpc.closeAllUnlocks()
  reg.cancelForWindow(W + 2)
  await bot.tick()
})

// ---------------------------------------------------------------- بستن
test('«close all», P1/P2 and removing the bot recipient end the uses left; a one-time code for a marked action stays one use', async () => {
  await phoneGrant(VOID, 420)
  assert.equal(tickets.listRepeatTickets().length, 1)
  lockIpc.closeAllUnlocks()
  assert.deepEqual(tickets.listRepeatTickets(), [], '«close all» (and P1/P2 through the same hook) clears the uses left')
  await phoneGrant(VOID, 421)
  reg.revokeAll()
  assert.equal(tickets.peekGateTicket(421, VOID), null, 'revoking every remote grant clears them too')
  const p = reg.requestCode(REFUND, 422)
  await bot.tick()
  assert.equal(await remote.approve(remote.pending().find((x) => x.requestId === p.requestId), 'bot-aaaaaaaaaaa2'), 'OK')
  assert.equal(await reg.claimRemotePanel(422, REFUND, p.requestId, p.gt.slice(3)), true)
  assert.equal(tickets.peekGateTicket(422, REFUND).left, 3)
  remote.revokeMember('bot-aaaaaaaaaaa2')
  assert.equal(tickets.peekGateTicket(422, REFUND), null, 'removing the recipient ends its uses')
  const codes = await lockIpc.createCodes({ section: 'sensitive', managerPassword: PW })
  const r = await inCall(423, () => redeemOneTimeCode(VOID, codes.codes[0].code))
  assert.equal(r.kind, 'action')
  assert.equal(tickets.peekGateTicket(423, VOID).uses, undefined, 'a code is still one use')
  assert.equal((await outcome(() => useVoid(423))).ok, true)
  assert.equal((await outcome(() => useVoid(423))).ok, false)
  lockIpc.closeAllUnlocks()
})

// ---------------------------------------------------------------- پیام‌ها
test('messages: «مجوز باز شد» with the count, «🔁 … · بار ۲ از ۳» for each use (⚠️) and «⚙️ کارهای قابل تکرار عوض شد»', () => {
  const AT = Date.UTC(2026, 10, 24, 10, 50)
  const data = emptyLookups(); data.users.set(5, 'علی')
  const row = (id, after, userId = null) => ({ id, at: AT, userId, action: 'ACCESS_EVENT', entity: 'Access', entityId: null, after: JSON.stringify(after), note: null })
  const [opened, single, used, changed] = auditPageToEvents([
    row(1, { kind: 'REMOTE_GRANT_OPENED', titleFa: gateEntry(REFUND).titleFa, windowNo: 2, decision: 'کار یک‌باره', minutes: 20, count: 3 }),
    row(2, { kind: 'REMOTE_GRANT_OPENED', titleFa: gateEntry(CHEQUE).titleFa, windowNo: 2, decision: 'کار یک‌باره', minutes: 20 }),
    row(3, { kind: 'REPEAT_GRANT_USED', titleFa: gateEntry(REFUND).titleFa, windowNo: 2, number: 2, count: 3 }),
    row(4, { kind: 'REPEAT_SETTINGS_CHANGED', number: 3, count: 2 }, 5)
  ], { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })
  assert.deepEqual(opened.lines, [`قفل: ${gateEntry(REFUND).titleFa} · پنجرهٔ ۲`, '🔴 نوع: کار یک‌بارهٔ قابل تکرار', '🔢 دفعات: ۳ بار (تا ۲۰ دقیقه)', 'کاربر: نامشخص'])
  assert.deepEqual(single.lines.slice(1, 3), ['🔴 نوع: کار یک‌باره', '⏱ زمان: یک بار'], 'a single-use action as in 4-30')
  assert.ok(used.title.startsWith(`🔁 ${gateEntry(REFUND).titleFa} · بار ۲ از ۳ · `))
  assert.equal(used.important, true)
  assert.deepEqual(used.lines, [`قفل: ${gateEntry(REFUND).titleFa} · پنجرهٔ ۲`])
  assert.ok(changed.title.startsWith('⚙️ کارهای قابل تکرار عوض شد'))
  assert.deepEqual(changed.lines, ['حداکثر دفعات هر مجوز: ۳ بار', 'کارهای قابل تکرار: ۲ کار', 'کاربر: علی'])
})

// ---------------------------------------------------------------- صفحه و سیم‌کشی
test('screen and wiring: the count box and the ticks by section on the remote-control page (one password field; irreversible ticks disabled); the host builds the ticket as in this test', () => {
  const ui = read('src/renderer/src/components/RemoteGrantControls.tsx')
  assert.equal((ui.match(/type="password"/g) ?? []).length, 1, 'still one typed password field')
  assert.match(ui, /حداکثر دفعات هر مجوز \(۱ تا ۱۰۰۰ بار\)/)
  assert.match(ui, /usesValue >= 1 && usesValue <= 1000/)
  assert.match(ui, /disabled=\{busy \|\| item\.never\}/)
  assert.match(ui, /'برگشت‌ناپذیر؛ همیشه یک بار'/)
  assert.match(ui, /repeatUsesMax: usesValue, repeatableActions: repeatable/)
  assert.match(ui, /مجوزهای چندبارهٔ باز/)
  const host = read('src/main/services/CloudSyncService.ts')
  assert.ok(host.includes("addOneShotTicket:(actionId,owner,ttlMs,memberId)=>{const max=repeatUsesOf(actionId),uses=max===null ? 1 : takeBotUses(owner,actionId,memberId) ?? max,ttl=uses>1 ? partDurationMs('remoteSensitiveGrantMinutes') : ttlMs"))
  assert.ok(host.includes("const made=addGateTicket(owner,actionId,ttl,'REMOTE_GRANT',{memberId,...(uses>1 ? {uses} : {})})"))
  assert.doesNotMatch(read('src/main/services/cloud/grantApprovalCoordinator.ts'), /uses|repeat/i, 'the hub policy shape is untouched')
  assert.doesNotMatch(read('src/main/services/cloud/signedCommandVerifier.ts'), /repeat/i)
  lease.release()
  performance.now = realNow; Date.now = realDateNow
})
