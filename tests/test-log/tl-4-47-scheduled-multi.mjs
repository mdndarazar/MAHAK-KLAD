/**
 * دفتر آزمون ۴-۴۷ (با ۴-۱۳؛ TL-D13) — مجوز زمان‌بندی‌شدهٔ چندماژولی، از تاریخ تا تاریخ، ساعت روزانه، «همه» یا یک کارمند.
 *
 * با زمان‌بند واقعی، panelSession و دروازهٔ واقعی و ساعت ساختگی (یکنواخت و دیواری با هم)، روی پوشهٔ موقت:
 *  - ساخت: چند قسمت و قفل کار؛ «کلیدسازی» و نُه کار برگشت‌ناپذیر نه؛ روز اول تا ۷ روز بعد؛ کل بازه حداکثر ۳۱ روز؛
 *    ساعت روزانه حداکثر ۱۰۰۰ دقیقه و بی گذر از ساعت ۲۴؛ کارمند فقط با حضانت روشن؛ هر برنامهٔ چندروزه یک مجوز فعال؛
 *  - بیرون از ساعت بسته؛ سر ساعت همهٔ قسمت‌ها برای همهٔ پنجره‌ها و قفل کارِ تیک‌خورده هر چند بار (بی بلیت)؛ قفل داخلیِ
 *    تیک‌نخورده بسته؛ هر روز سر ساعت دوباره باز و خبر؛ «بستن همه» فقط همان روز؛ P2 همه؛ جهش ساعت همه؛
 *  - ساعت روزانهٔ چندساعته بی وقفه (تازه‌سازی نشست پیش از سقف ۶۰ دقیقه) و پس از بستن و باز کردن برنامه؛
 *  - کارمند دیگر صندوق را بگیرد ⇒ بسته (سنجش هر ۵ ثانیه)، برگردد ⇒ باز، حضانت خاموش ⇒ بسته؛
 *  - پنجره‌ای که در خواب رایانه تمام شد: روز بعد از نو باز و خبر؛
 *  - خواب از میان پنجره تا پس از پایانش (ساعت یکنواخت ایستاده): هنگام بیدار شدن همه همان دم بسته؛
 *  - پروندهٔ قدیمی (نسخهٔ ۱) خوانده می‌شود؛ پیام‌های تلگرام و بله؛ صفحه و سیم‌کشی.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-47-scheduled-multi.mjs
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance as perfHooksPerformance } from 'node:perf_hooks'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-47-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const sessions = await import('../../src/main/services/panelSession.ts')
const sched = await import('../../src/main/services/locks/scheduledGrants.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction } = await import('../../src/main/services/locks/gate.ts')
const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { GATE_CATALOG, GATE_IRREVERSIBLE_ACTIONS } = await import('../../src/shared/gateCatalog.ts')
const { LOCKED_PANELS, PANEL_KEYS, lockKindLists, panelTitle } = await import('../../src/shared/panels.ts')
const { jalaliAddDays, jalaliAtClock, toJalaliDate } = await import('../../src/shared/jalali.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

harnessClient()
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const MIN = 60_000
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: '58204716' })

// ساعت ساختگی: یکنواخت و دیواری با هم جلو می‌روند (جهش نیست)؛ `wallExtra` فقط دیواری (جهش ساعت ویندوز)
assert.equal(perfHooksPerformance, globalThis.performance)
const realNow = performance.now.bind(performance), realDateNow = Date.now
let shift = 0, wallExtra = 0
performance.now = () => realNow() + shift
Date.now = () => realDateNow() + shift + wallExtra
const advance = (ms) => { shift += ms }
const setWall = (ms) => { shift += ms - Date.now() }
const today = toJalaliDate(new Date())
const day = (n) => jalaliAddDays(today, n)
const at = (d, clock) => jalaliAtClock(d, clock).getTime()

const W1 = 9201, W2 = 9202
const P = 'sales-credit', Q = PANEL_KEYS.cashClose, ACT = 'cheque.status-change', INNER = 'cheque.void-pending'
let custody = { enabled: false, holder: null }
const staff = [{ id: 7, name: 'علی' }, { id: 8, name: 'رضا' }]
const events = []
const deps = { dir: DIR, offsetMinutes: () => 0, windows: () => [W1, W2], event: (kind, fields) => events.push({ kind, ...fields }), custody: () => custody, staff: () => staff, schedule: false }
const configure = () => sched.configureScheduledGrants(deps)
configure()
const kinds = (k) => events.filter((e) => e.kind === k)
const open = (panel, owner) => sessions.isPanelUnlocked(panel, owner)
const outcome = async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } }
const create = (input) => sched.createScheduledGrant(input)
const rejected = async (input, re) => { const r = await outcome(() => create(input)); assert.equal(r.ok, false, JSON.stringify(input)); if (re) assert.match(r.err.message, re); return r }
const stateOf = async (id) => (await sched.listScheduledGrants()).grants.find((g) => g.id === id)
const inCall = (owner, fn) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, fn))
const useAction = (id, owner) => inCall(owner, () => gateAction(id, () => auth.assertPanelPasswordStrict(GATE_CATALOG[id].parentPanel, '', GATE_CATALOG[id].titleFa)))
const lastDays = (from, to) => to.slice(0, 4) === from.slice(0, 4) ? `${from} تا ${to.slice(5)}` : `${from.slice(5)} تا ${to}`

after(() => {
  performance.now = realNow
  Date.now = realDateNow
  sched.stopScheduledGrants()
})

let G
test('create: modules and action locks together; never «کلیدسازی» or the irreversible nine; first day ≤7 days; ≤31 days; daily ≤1000 min within the day; employee only with custody', async () => {
  assert.ok(LOCKED_PANELS.some((p) => p.key === P && p.kind === 'part'), 'P is a module')
  assert.equal(GATE_CATALOG[ACT].parentPanel, P)
  assert.equal(GATE_CATALOG[INNER].parentPanel, P)
  setWall(at(today, '15:00'))
  const base = { fromDay: today, toDay: today, start: '16:00', end: '16:30' }
  await rejected({ ...base, panels: [] }, /دست‌کم یک/)
  await rejected({ ...base, panels: ['keys.panel-locks'] }, /کلیدسازی/)
  for (const id of GATE_IRREVERSIBLE_ACTIONS) await rejected({ ...base, panels: [P, id] }, /برگشت‌ناپذیر/)
  await rejected({ ...base, panels: ['act-cheque-status'] }, /در فهرست مجوز زمان‌بندی‌شده نیست/)
  await rejected({ ...base, panels: [P], fromDay: day(8), toDay: day(8) }, /۷ روز/)
  await rejected({ ...base, panels: [P], toDay: day(31) }, /۳۱ روز/)
  await rejected({ ...base, panels: [P], fromDay: day(2), toDay: day(1) }, /۳۱ روز/)
  await rejected({ ...base, panels: [P], start: '06:00', end: '22:41' }, /۱۰۰۰ دقیقه/)
  await rejected({ ...base, panels: [P], start: '22:00', end: '02:00' }, /بعد از ساعت شروع/)
  await rejected({ ...base, panels: [P], userId: 7 }, /حضانت صندوق خاموش/)
  custody = { enabled: true, holder: null }
  await rejected({ ...base, panels: [P], userId: 99 }, /پیدا نشد/)
  custody = { enabled: false, holder: null }

  const longest = await create({ ...base, panels: [P], start: '06:00', end: '22:40' })
  assert.equal(longest.windows[0][1] - longest.windows[0][0], 1000 * MIN, '1000 minutes accepted')
  const month = await create({ ...base, panels: [Q], toDay: day(30) })
  assert.equal(month.windows.length, 31, '31 days accepted')
  G = await create({ panels: [P, Q, ACT, P], fromDay: today, toDay: day(2), start: '۱۶:۰۰', end: '17:00', note: 'عصرها' })
  assert.deepEqual(G.panels, [P, Q, ACT], 'one entry per key')
  assert.deepEqual(G.windows, [0, 1, 2].map((n) => [at(day(n), '16:00'), at(day(n), '17:00')]))
  assert.equal(G.startAt, at(today, '16:00'))
  assert.equal(G.endAt, at(day(2), '17:00'))
  assert.equal(G.userId, null)
  const made = kinds('SCHEDULED_GRANT_CREATED').at(-1)
  assert.equal(made.decision, `16:00 تا 17:00 · ${lastDays(today, day(2))}`)
  assert.equal(made.count, 3)
  assert.equal(made.titleFa, `${panelTitle(P)}، ${panelTitle(Q)}، ${GATE_CATALOG[ACT].titleFa}`)
  assert.equal(made.recipientName, undefined)

  // هر برنامهٔ چندروزه یک مجوز فعال: ۳ تا الان، ۷ تای دیگر، یازدهمی رد
  const extra = []
  for (let i = 0; i < 7; i++) extra.push(await create({ panels: [Q], fromDay: day(3), toDay: day(3), start: `1${i}:00`, end: `1${i}:30` }))
  await rejected({ panels: [Q], fromDay: day(4), toDay: day(4), start: '10:00', end: '10:30' }, /۱۰/)
  for (const g of [longest, month, ...extra]) await sched.cancelScheduledGrant(g.id)
  assert.equal((await sched.listScheduledGrants()).grants.filter((g) => g.state === 'PENDING').length, 1)

  // همهٔ فهرست صفحه (۴-۳۲ بی نُه کار) پذیرفته می‌شود
  const lists = lockKindLists()
  const all = [...lists.normal, ...lists.sensitive, ...lists.actions.flatMap((g) => g.items)].map((i) => i.id).filter((id) => !GATE_IRREVERSIBLE_ACTIONS.includes(id))
  assert.equal(all.length, 25 + 19 + 53 - 9)
  const everything = await create({ panels: all, fromDay: day(5), toDay: day(5), start: '09:00', end: '09:30' })
  assert.equal(everything.panels.length, all.length)
  await sched.cancelScheduledGrant(everything.id)
})

test('outside the hours closed; at the start every module for every window and the ticked action as often as needed, without tickets; an unticked inner lock stays locked', async () => {
  await sched.tick()
  assert.ok(!open(P, W1) && !open(Q, W2) && !unlocks.scheduledActionOpen(ACT), 'closed before 16:00')
  assert.equal((await outcome(() => useAction(ACT, W1))).ok, false, 'action locked before 16:00')
  setWall(at(today, '16:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && open(P, W2) && open(Q, W1) && open(Q, W2), 'both modules, both windows')
  assert.equal(unlocks.scheduledActionOpen(ACT), true)
  const gTitle = `${panelTitle(P)}، ${panelTitle(Q)}، ${GATE_CATALOG[ACT].titleFa}`
  const opened = kinds('SCHEDULED_GRANT_OPENED').filter((e) => e.titleFa === gTitle)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].decision, 'برای همهٔ پنجره‌های برنامه')
  assert.equal(opened[0].minutes, 17 * 60, 'closing time 17:00')
  assert.equal(tickets.gateTicketCount(), 0)
  for (let i = 1; i <= 4; i++) assert.equal((await outcome(() => useAction(ACT, W1))).ok, true, `use ${i}`)
  assert.equal((await outcome(() => useAction(ACT, W2))).ok, true, 'other window too')
  assert.equal((await outcome(() => useAction(INNER, W1))).ok, false, 'inner lock of the same module is separate')
  assert.equal((await stateOf(G.id)).state, 'OPEN')
  setWall(at(today, '17:00') + 1000)
  assert.ok(!unlocks.scheduledActionOpen(ACT) && !open(P, W1), 'closes on time by itself, before the next round')
  await sched.tick()
  assert.ok(!open(P, W1) && !open(Q, W2) && !unlocks.scheduledActionOpen(ACT), 'closed at 17:00')
  assert.equal((await outcome(() => useAction(ACT, W1))).ok, false)
  assert.equal((await stateOf(G.id)).state, 'PENDING', 'waits for tomorrow')
  assert.equal(kinds('SCHEDULED_GRANT_CLOSED').at(-1).decision, 'پایان ساعت امروز؛ روزهای بعد طبق برنامه')
})

test('every day at the start it opens again and says so; «بستن همه» closes only that day; P2 cancels everything', async () => {
  setWall(at(day(1), '16:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && unlocks.scheduledActionOpen(ACT), 'day 2 open')
  const gOpened = () => kinds('SCHEDULED_GRANT_OPENED').filter((e) => e.titleFa === `${panelTitle(P)}، ${panelTitle(Q)}، ${GATE_CATALOG[ACT].titleFa}`).length
  assert.equal(gOpened(), 2)
  sched.closeScheduledGrants({})
  assert.ok(!open(P, W1) && !open(Q, W2) && !unlocks.scheduledActionOpen(ACT), '«بستن همه» closed it')
  assert.equal(kinds('SCHEDULED_GRANT_CLOSED').at(-1).decision, 'بستن همه؛ روزهای بعد طبق برنامه')
  const g = await stateOf(G.id)
  assert.equal(g.state, 'PENDING')
  assert.equal(g.closedUntil, at(day(1), '17:00'))
  advance(MIN); await sched.tick()
  assert.ok(!open(P, W1) && !unlocks.scheduledActionOpen(ACT), 'not again the same day')
  setWall(at(day(2), '16:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && open(Q, W2) && unlocks.scheduledActionOpen(ACT), 'day 3 open per schedule')
  assert.equal(gOpened(), 3)
  setWall(at(day(2), '17:00'))
  await sched.tick()
  assert.equal((await stateOf(G.id)).state, 'DONE')
  assert.equal((await stateOf(G.id)).reason, 'پایان بازه')

  setWall(at(day(3), '07:00'))
  const a = await create({ panels: [P], fromDay: day(3), toDay: day(5), start: '07:00', end: '08:00' })
  const b = await create({ panels: [Q], fromDay: day(4), toDay: day(6), start: '09:00', end: '10:00' })
  await sched.tick()
  assert.ok(open(P, W1))
  sched.closeScheduledGrants({ cancelFuture: true, reason: 'توقف اضطراری کامل' })
  assert.equal((await stateOf(a.id)).state, 'CANCELED', 'open multi-day grant canceled, not kept for later days')
  assert.equal((await stateOf(b.id)).state, 'CANCELED')
  assert.ok(!open(P, W1))
})

test('a multi-hour daily window stays open with no gap (renewal before the 60-minute cap), also after closing and reopening the program; closes on time', async () => {
  setWall(at(day(7), '07:00'))
  const h = await create({ panels: [P, ACT], fromDay: day(7), toDay: day(7), start: '08:00', end: '16:20' })
  setWall(at(day(7), '08:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && open(P, W2))
  for (let step = 1; step <= 9; step++) {
    advance(55 * MIN)
    unlocks.runDueRenewalsForTests()
    if (step === 4) { configure(); sessions.clearPanelSessions() } // بستن و باز کردن برنامه
    await sched.tick()
    assert.ok(open(P, W1) && open(P, W2) && unlocks.scheduledActionOpen(ACT), `still open after ${step * 55} min`)
  }
  assert.equal(kinds('SCHEDULED_GRANT_OPENED').filter((e) => e.minutes === 16 * 60 + 20).length, 1, 'restart does not announce again')
  setWall(at(day(7), '16:20'))
  await sched.tick()
  assert.ok(!open(P, W1) && !unlocks.scheduledActionOpen(ACT))
  assert.equal((await stateOf(h.id)).state, 'DONE')
})

test('one employee: open only while the register is in their hands; another custodian ⇒ closed (checked every 5 s), back ⇒ open, custody off ⇒ closed', async () => {
  custody = { enabled: true, holder: 7 }
  setWall(at(day(7), '17:00'))
  const e = await create({ panels: [Q, ACT], fromDay: day(7), toDay: day(8), start: '18:00', end: '20:00', userId: '۷' })
  assert.equal(e.userId, 7)
  assert.equal(e.userName, 'علی')
  assert.equal(kinds('SCHEDULED_GRANT_CREATED').at(-1).recipientName, 'علی')
  setWall(at(day(7), '18:00') + 1000)
  await sched.tick()
  assert.ok(open(Q, W1) && open(Q, W2) && unlocks.scheduledActionOpen(ACT), 'custodian 7 ⇒ open')
  const opened = kinds('SCHEDULED_GRANT_OPENED').at(-1)
  assert.equal(opened.decision, 'فقط وقتی صندوق دست این کارمند است')
  assert.equal(opened.recipientName, 'علی')
  assert.equal(opened.minutes, 20 * 60)

  // زمان‌بند واقعی: در پنجرهٔ بازِ مجوز کارمندی دور بعد ۵ ثانیه است
  const realSetTimeout = globalThis.setTimeout, delays = []
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0) }
  try {
    sched.startScheduledGrants({ ...deps, schedule: true })
    await sched.tick()
  } finally {
    globalThis.setTimeout = realSetTimeout
    sched.stopScheduledGrants()
    configure()
  }
  assert.equal(delays.at(-1), sched.SCHEDULED_CUSTODY_TICK_MS)
  assert.equal(sched.SCHEDULED_CUSTODY_TICK_MS, 5000)

  custody = { enabled: true, holder: 8 }
  advance(5000); await sched.tick()
  assert.ok(!open(Q, W1) && !open(Q, W2) && !unlocks.scheduledActionOpen(ACT), 'another custodian ⇒ closed')
  assert.equal((await outcome(() => useAction(ACT, W1))).ok, false)
  assert.equal((await stateOf(e.id)).state, 'OPEN', 'the grant itself stays')
  custody = { enabled: true, holder: 7 }
  advance(5000); await sched.tick()
  assert.ok(open(Q, W1) && unlocks.scheduledActionOpen(ACT), 'back ⇒ open')
  custody = { enabled: false, holder: null }
  advance(5000); await sched.tick()
  assert.ok(!open(Q, W1) && !unlocks.scheduledActionOpen(ACT), 'custody off ⇒ closed')
  custody = { enabled: true, holder: 7 }
  await sched.cancelScheduledGrant(e.id)
  assert.ok(!open(Q, W1) && !unlocks.scheduledActionOpen(ACT))
  assert.equal(kinds('SCHEDULED_GRANT_CANCELED').at(-1).recipientName, 'علی')
  custody = { enabled: false, holder: null }
})

test('a Windows clock jump cancels every grant (multi-day too); the old file (version 1) is still read; a broken new row means no grant', async () => {
  setWall(at(day(9), '07:00'))
  const j = await create({ panels: [P], fromDay: day(9), toDay: day(12), start: '07:00', end: '09:00' })
  await sched.tick()
  assert.ok(open(P, W1))
  wallExtra += 3 * MIN
  await sched.tick()
  assert.equal((await stateOf(j.id)).state, 'CANCELED')
  assert.equal((await stateOf(j.id)).reason, 'ساعت سیستم عوض شد')
  assert.ok(!open(P, W1))
  wallExtra -= 3 * MIN
  sched.scheduledGrantsResumed(); await sched.tick()

  const file = join(DIR, sched.SCHEDULED_GRANTS_FILE)
  const old = { id: 'abcdefabcdef', panel: P, startAt: at(day(10), '09:00'), endAt: at(day(10), '11:00'), note: 'قدیمی', createdAt: Date.now(), state: 'PENDING', reason: null }
  writeFileSync(file, JSON.stringify({ version: 1, grants: [old] }))
  configure()
  const listed = (await sched.listScheduledGrants()).grants
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].panels, [P])
  assert.equal(listed[0].days, 1)
  assert.equal(listed[0].span, `09:00 تا 11:00 · ${day(10)}`, 'a 120-minute old row is valid (cap raised with the file check)')
  setWall(at(day(10), '09:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1), 'old row opens on time')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(Object.keys(saved.grants[0]).sort(), ['closedUntil', 'createdAt', 'endAt', 'id', 'note', 'openedFor', 'panels', 'reason', 'startAt', 'state', 'userId', 'userName', 'windows'])
  assert.notEqual(sched.parseScheduledGrants(JSON.stringify(saved)), null)
  const broken = (patch) => sched.parseScheduledGrants(JSON.stringify({ version: 2, grants: [{ ...saved.grants[0], ...patch }] }))
  assert.equal(broken({ panels: [P, 'backup.restore'] }), null, 'an irreversible action in the file')
  assert.equal(broken({ panels: ['keys.panel-locks'] }), null)
  assert.equal(broken({ windows: [[old.startAt, old.startAt + 1001 * MIN]], endAt: old.startAt + 1001 * MIN }), null, 'a window over 1000 minutes')
  assert.equal(broken({ userId: 7, userName: null }), null)
  assert.equal(sched.parseScheduledGrants(JSON.stringify({ version: 1, grants: [saved.grants[0]] })), null, 'version 1 holds only old rows')
  sched.closeScheduledGrants({ cancelFuture: true })
})

test('a window that ended while the computer slept (no round at the boundary): the next day opens fresh for every window and announces again', async () => {
  setWall(at(day(13), '06:00'))
  const g = await create({ panels: [P], fromDay: day(13), toDay: day(14), start: '07:00', end: '08:00' })
  setWall(at(day(13), '07:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && open(P, W2))
  const before = kinds('SCHEDULED_GRANT_OPENED').length
  setWall(at(day(14), '07:00') + 1000)
  await sched.tick()
  assert.equal(unlocks.guardedEntryFor(W1, P)?.grantId, g.id, 'the stale session of yesterday did not block today')
  assert.ok(open(P, W1) && open(P, W2), 'open on day 2')
  assert.equal(kinds('SCHEDULED_GRANT_OPENED').length, before + 1, 'announced again')
  assert.equal((await stateOf(g.id)).openedFor, at(day(14), '07:00'))
  sched.closeScheduledGrants({ cancelFuture: true })
})

test('sleep across the window end (only the wall clock moved): on waking every module and the action are closed at once, not later by the stopped clock', async () => {
  setWall(at(day(15), '06:00'))
  const g = await create({ panels: [P, ACT], fromDay: day(15), toDay: day(16), start: '07:00', end: '08:00' })
  setWall(at(day(15), '07:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && open(P, W2) && unlocks.scheduledActionOpen(ACT))
  setWall(at(day(15), '07:30'))
  wallExtra += 60 * MIN
  sched.scheduledGrantsResumed(); await sched.tick()
  assert.ok(!open(P, W1) && !open(P, W2) && !unlocks.scheduledActionOpen(ACT), 'closed on waking at 08:30, although the stopped clock still says 07:30')
  assert.equal((await stateOf(g.id)).state, 'PENDING', 'the next day still follows the plan')
  setWall(at(day(16), '07:00') + 1000)
  await sched.tick()
  assert.ok(open(P, W1) && unlocks.scheduledActionOpen(ACT), 'day 2 opens')
  sched.closeScheduledGrants({ cancelFuture: true })
  wallExtra -= 60 * MIN
  sched.scheduledGrantsResumed(); await sched.tick()
})

test('Telegram and Bale: created, opened (custodian and closing time), closed, canceled', () => {
  const AT = Date.UTC(2026, 10, 24, 12, 30)
  const row = (id, after) => ({ id, at: AT, userId: null, action: 'ACCESS_EVENT', entity: 'Access', entityId: null, after: JSON.stringify(after), note: null })
  const where = 'قفل: انبار مرکزی، بستن صندوق'
  const [made, openedOne, openedAll, closed, canceled] = auditPageToEvents([
    row(1, { kind: 'SCHEDULED_GRANT_CREATED', titleFa: 'انبار مرکزی، بستن صندوق', decision: '16:00 تا 17:00 · 1405/09/02 تا 09/04', count: 3, recipientName: 'علی' }),
    row(2, { kind: 'SCHEDULED_GRANT_OPENED', titleFa: 'انبار مرکزی، بستن صندوق', decision: 'فقط وقتی صندوق دست این کارمند است', recipientName: 'علی', minutes: 1020 }),
    row(3, { kind: 'SCHEDULED_GRANT_OPENED', titleFa: 'انبار مرکزی، بستن صندوق', decision: 'برای همهٔ پنجره‌های برنامه', minutes: 545 }),
    row(4, { kind: 'SCHEDULED_GRANT_CLOSED', titleFa: 'انبار مرکزی، بستن صندوق', decision: 'بستن همه؛ روزهای بعد طبق برنامه' }),
    row(5, { kind: 'SCHEDULED_GRANT_CANCELED', titleFa: 'انبار مرکزی، بستن صندوق', decision: 'لغو به دست مدیر', recipientName: 'علی' })
  ], { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }, { closeShiftIds: [] })
  assert.match(made.title, /^🗓️ مجوز زمان‌بندی‌شده ساخته شد · /)
  assert.deepEqual(made.lines, [where, 'بازه: 16:00 تا 17:00 · 1405/09/02 تا 09/04', 'روز: هر روز همین ساعت، ۳ روز', 'مسئول صندوق: علی', 'کاربر: نامشخص'])
  assert.equal(made.important, true)
  assert.match(openedOne.title, /^🗓️ مجوز زمان‌بندی‌شده باز شد · /)
  assert.deepEqual(openedOne.lines, [where, 'فقط وقتی صندوق دست این کارمند است', 'مسئول صندوق: علی', 'زمان بستن: ساعت ۱۷:۰۰'])
  assert.deepEqual(openedAll.lines, [where, 'برای همهٔ پنجره‌های برنامه', 'زمان بستن: ساعت ۰۹:۰۵'])
  assert.deepEqual(closed.lines, [where, 'بستن همه؛ روزهای بعد طبق برنامه'])
  assert.deepEqual(canceled.lines, [where, 'دلیل: لغو به دست مدیر', 'مسئول صندوق: علی', 'کاربر: نامشخص'])
})

test('screen and wiring: the 4-32 lists without the nine, two dates, two times, «همه» or an employee, one password field; the gate and the custody reader', () => {
  const ui = read('src/renderer/src/components/ScheduledGrantsBox.tsx')
  assert.match(ui, /const lists = lockKindLists\(\)/)
  assert.match(ui, /const NEVER = new Set<string>\(GATE_IRREVERSIBLE_ACTIONS\)/)
  assert.match(ui, /g\.items\.filter\(\(i\) => !NEVER\.has\(i\.id\)\)/)
  assert.equal((ui.match(/<JalaliDateInput /g) ?? []).length, 2)
  assert.match(ui, /\{ panels: picked, fromDay, toDay, start, end, userId: userId \|\| null, note, managerPassword: password \}/)
  assert.match(ui, /<option value="">همه<\/option>/)
  assert.match(ui, /disabled=\{busy \|\| !list\?\.custody\}/)
  assert.equal((ui.match(/type="password"/g) ?? []).length, 1)
  const gate = read('src/main/services/locks/gate.ts')
  assert.equal((gate.match(/scheduledActionOpen\(e\.id\)/g) ?? []).length, 3)
  assert.match(gate, /scheduledActionOpen\(e\.id\) \? \{ method: 'SCHEDULED_GRANT' as const, number: undefined \} : takeGateTicket\(call\.owner, e\.id\)/)
  const runtime = read('src/main/services/locks/scheduledGrantsRuntime.ts')
  assert.match(runtime, /if \(!\(await custodyService\.enabled\(\)\)\) return \{ enabled: false, holder: null \}/)
  assert.match(runtime, /state\.state !== 'ACTIVE' && state\.state !== 'HANDOVER_PENDING'/)
  assert.match(runtime, /meta\?\.custodianUserId === shift\.userId \? shift\.userId : null/)
  assert.match(runtime, /staff: async \(\) => \(await custodyService\.staffList\(\)\)\.filter\(\(u\) => u\.isActive\)/)
  assert.equal(sched.SCHEDULED_MAX_SPAN_MS, 1000 * MIN)
  assert.equal(sched.SCHEDULED_MAX_DAYS, 31)
})
