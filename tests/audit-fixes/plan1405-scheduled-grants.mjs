/**
 * طرح ۱۴۰۵ · مرحلهٔ ۶ — مجوز زمان‌بندی‌شده (معماری §۳-۱۶؛ §۸-۲ بندهای ۹ و ۱۰).
 *
 * با زمان‌بند واقعی، panelSession واقعی و ساعت‌های ساختگی (دیواری و یکنواخت)، روی پوشهٔ موقت:
 *   باز و بسته شدن سر ساعت برای همهٔ پنجره‌ها (و پنجرهٔ تازه در دور بعد)؛ بی‌کاری (حتی بی‌کاری عمومی پنل) آن را
 *   نمی‌بندد؛ رد کارها، کلید ناشناس، بازهٔ بیش از ۶۰ دقیقه، روز بیرون از امروز تا ۷ روز بعد و بیش از ۱۰ مجوز فعال؛
 *   ساعت رسمی (افست)؛ لغو همه با جهش ساعت و ⚠️؛ رویداد `resume` (خواب رایانه) لغو نمی‌کند؛ P1 مجوز باز را می‌بندد
 *   و آینده را نه؛ P2 (cancelFuture) آینده را هم لغو می‌کند؛ ماندن پس از شروع دوباره؛ پنجره‌ای که همان قسمت را باز
 *   دارد پس از بسته شدن آن نشست مجوز را می‌گیرد؛ پروندهٔ خراب یعنی هیچ مجوزی.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-scheduled-grants.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const DIR = mkdtempSync(join(tmpdir(), 'plan1405-scheduled-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

await import('../../test/harness/stubs/prismaClient.mjs')
const sessions = await import('../../src/main/services/panelSession.ts')
const sched = await import('../../src/main/services/locks/scheduledGrants.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const { jalaliAddDays, jalaliAtClock, toJalaliDate } = await import('../../src/shared/jalali.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}
const outcome = async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } }

// ساعت‌ها: روز ثابت، ساعت ۱۵:۰۰ تهران
const today = toJalaliDate(new Date())
let wall = jalaliAtClock(today, '15:00').getTime()
let mono = 5_000_000
let offsetMinutes = 0
let windows = [9101, 9102]
const events = []
const W1 = 9101, W2 = 9102, W3 = 9103
const advance = (ms) => { wall += ms; mono += ms }
unlocks.setUnlockClockForTests(() => mono)
const configure = () => sched.configureScheduledGrants({ dir: DIR, now: () => wall, mono: () => mono, offsetMinutes: () => offsetMinutes, windows: () => windows, event: (kind, fields) => events.push({ kind, ...fields }), schedule: false })
configure()
const P = PANEL_KEYS.secondaryStock, Q = PANEL_KEYS.cashClose
const open = (panel, owner) => sessions.isPanelUnlocked(panel, owner)
const kinds = (k) => events.filter((e) => e.kind === k)

try {
  console.log('\n— ۱) ساخت: فقط قسمت‌ها، بازهٔ حداکثر ۶۰ دقیقه، امروز تا ۷ روز بعد، حداکثر ۱۰ فعال')
  for (const [label, input] of [
    ['قفل کار', { panel: 'credit.void', day: today, start: '16:00', end: '16:30' }],
    ['کلید `act-*`', { panel: 'act-backup-restore', day: today, start: '16:00', end: '16:30' }],
    ['کلید ناشناس', { panel: 'nope', day: today, start: '16:00', end: '16:30' }],
    ['بیش از ۶۰ دقیقه', { panel: P, day: today, start: '16:00', end: '17:01' }],
    ['پایان پیش از شروع', { panel: P, day: today, start: '16:00', end: '15:59' }],
    ['۸ روز بعد', { panel: P, day: jalaliAddDays(today, 8), start: '16:00', end: '16:30' }],
    ['دیروز', { panel: P, day: jalaliAddDays(today, -1), start: '16:00', end: '16:30' }],
    ['بازهٔ گذشته', { panel: P, day: today, start: '10:00', end: '10:30' }],
    ['ساعت نامعتبر', { panel: P, day: today, start: '25:00', end: '26:00' }]
  ]) {
    const r = await outcome(() => sched.createScheduledGrant(input))
    ok(`رد: ${label}`, !r.ok, r.ok ? 'ساخته شد' : '')
  }
  const g = await sched.createScheduledGrant({ panel: P, day: today, start: '۱۶:۰۰', end: '17:00', note: 'انبار عصر' })
  ok('ساخت «انبار مرکزی، امروز، ۱۶:۰۰ تا ۱۷:۰۰» (رقم فارسی هم)', g.state === 'PENDING' && g.endAt - g.startAt === 3_600_000 && g.startAt === jalaliAtClock(today, '16:00').getTime())
  ok('ردیف SCHEDULED_GRANT_CREATED با بازه', kinds('SCHEDULED_GRANT_CREATED').length === 1 && /16:00 تا 17:00/.test(kinds('SCHEDULED_GRANT_CREATED')[0].decision))
  const seventh = await outcome(() => sched.createScheduledGrant({ panel: Q, day: jalaliAddDays(today, 7), start: '09:00', end: '09:30' }))
  ok('قسمت پولی و تازه هم پذیرفته (۷ روز بعد)', seventh.ok)
  const staff = await outcome(() => sched.createScheduledGrant({ panel: 'staff', day: jalaliAddDays(today, 2), start: '09:00', end: '09:30' }))
  ok('قسمت تازهٔ «کارمندان» پذیرفته', staff.ok)
  for (let i = 0; i < 7; i++) await sched.createScheduledGrant({ panel: PANEL_KEYS.products, day: jalaliAddDays(today, 3), start: `1${i}:00`, end: `1${i}:30` })
  const eleventh = await outcome(() => sched.createScheduledGrant({ panel: PANEL_KEYS.products, day: jalaliAddDays(today, 4), start: '10:00', end: '10:30' }))
  ok('یازدهمین مجوز فعال رد', !eleventh.ok && /۱۰/.test(eleventh.err?.message ?? ''))
  const list0 = await sched.listScheduledGrants()
  for (const x of list0.grants) if (x.id !== g.id) await sched.cancelScheduledGrant(x.id)
  ok('لغو به دست مدیر (و ردیف لغو)', (await sched.listScheduledGrants()).grants.filter((x) => x.state === 'PENDING').length === 1 && kinds('SCHEDULED_GRANT_CANCELED').length === 9)

  console.log('\n— ۲) باز شدن سر ساعت برای همهٔ پنجره‌ها؛ پنجرهٔ تازه در دور بعد؛ بی‌کاری نمی‌بندد؛ بسته شدن سر ساعت')
  await sched.tick()
  ok('پیش از ۱۶:۰۰ بسته', !open(P, W1) && !open(P, W2))
  advance(60 * 60_000)
  await sched.tick()
  ok('سر ۱۶:۰۰ برای هر دو پنجره باز', open(P, W1) && open(P, W2))
  ok('خبر «برای همهٔ پنجره‌های برنامه»', kinds('SCHEDULED_GRANT_OPENED').length === 1 && kinds('SCHEDULED_GRANT_OPENED')[0].decision === 'برای همهٔ پنجره‌های برنامه')
  windows = [W1, W2, W3]
  ok('پنجرهٔ تازه پیش از دور بعد بسته', !open(P, W3))
  advance(30_000); await sched.tick()
  ok('پنجرهٔ تازه در دور بعدی ۳۰ ثانیه‌ای گرفت', open(P, W3))
  ok('فقط همین قسمت، نه قسمت دیگر', !open(Q, W1))
  sessions.applyPanelSessionTtlMinutes(1)
  advance(40 * 60_000)
  ok('۴۰ دقیقه بی‌کاری (با بی‌کاری عمومی ۱ دقیقه) نمی‌بندد', open(P, W2))
  sessions.applyPanelSessionTtlMinutes(5)
  advance(19 * 60_000 + 20_000); await sched.tick()
  ok('یک دقیقه پیش از پایان هنوز باز', open(P, W1))
  advance(60_000); await sched.tick()
  ok('سر ۱۷:۰۰ برای همه بسته', !open(P, W1) && !open(P, W2) && !open(P, W3))
  ok('خبر بسته شدن و وضعیت «پایان»', kinds('SCHEDULED_GRANT_CLOSED').some((e) => e.decision === 'پایان بازه') && (await sched.listScheduledGrants()).grants.find((x) => x.id === g.id).state === 'DONE')

  console.log('\n— ۳) جهش ساعت ⇒ لغو همه و ⚠️؛ `resume` (خواب رایانه) لغو نمی‌کند')
  const a = await sched.createScheduledGrant({ panel: P, day: today, start: '17:30', end: '18:00' })
  const b = await sched.createScheduledGrant({ panel: Q, day: today, start: '17:10', end: '17:40' })
  await sched.tick()
  advance(10 * 60_000 + 5_000); await sched.tick()
  ok('مجوز ۱۷:۱۰ باز شد', open(Q, W1))
  wall += 5 * 60_000 // خواب ۵ دقیقه‌ای: ساعت دیواری جلو رفت، یکنواخت نه
  sched.scheduledGrantsResumed()
  await sched.tick()
  const afterResume = (await sched.listScheduledGrants()).grants
  ok('پس از بیدار شدن هیچ لغوی رخ نداد', !afterResume.some((x) => x.reason === 'ساعت سیستم عوض شد') && afterResume.find((x) => x.id === b.id).state === 'OPEN' && open(Q, W1))
  wall -= 5 * 60_000
  sched.scheduledGrantsResumed(); await sched.tick()
  wall += 2 * 60_000 + 5_000 // جهش بیش از ۲ دقیقه بی خواب
  await sched.tick()
  const jumped = (await sched.listScheduledGrants()).grants
  ok('جهش بیش از ۲ دقیقه: همهٔ مجوزهای فعال لغو', [a.id, b.id].every((id) => jumped.find((x) => x.id === id).state === 'CANCELED'))
  ok('⚠️ «ساعت سیستم عوض شد» برای هر کدام', kinds('SCHEDULED_GRANT_CANCELED').filter((e) => e.decision === 'ساعت سیستم عوض شد').length === 2)
  ok('مجوز باز همان لحظه بسته شد', !open(Q, W1))
  wall -= 2 * 60_000 + 5_000
  sched.scheduledGrantsResumed(); await sched.tick()

  console.log('\n— ۴) P1 مجوز باز را می‌بندد و آینده را نه؛ P2 آینده را هم لغو می‌کند')
  wall = jalaliAtClock(today, '18:00').getTime(); sched.scheduledGrantsResumed()
  const c = await sched.createScheduledGrant({ panel: P, day: today, start: '18:00', end: '18:30' })
  const d = await sched.createScheduledGrant({ panel: Q, day: today, start: '19:00', end: '19:30' })
  await sched.tick()
  ok('مجوز ۱۸:۰۰ باز', open(P, W1))
  sched.closeScheduledGrants({})
  ok('P1: مجوز باز بسته شد', !open(P, W1) && (await sched.listScheduledGrants()).grants.find((x) => x.id === c.id).state === 'DONE')
  advance(60_000); await sched.tick()
  ok('P1: در همان بازه دوباره باز نمی‌شود', !open(P, W1))
  ok('P1: مجوز آینده ماند', (await sched.listScheduledGrants()).grants.find((x) => x.id === d.id).state === 'PENDING')
  sched.closeScheduledGrants({ cancelFuture: true })
  ok('P2: مجوز آینده هم لغو شد', (await sched.listScheduledGrants()).grants.find((x) => x.id === d.id).state === 'CANCELED')

  console.log('\n— ۵) ماندن پس از شروع دوباره؛ پنجره‌ای که همان قسمت را باز دارد؛ ساعت رسمی؛ پروندهٔ خراب')
  wall = jalaliAtClock(today, '19:00').getTime(); sched.scheduledGrantsResumed()
  const e = await sched.createScheduledGrant({ panel: P, day: today, start: '19:05', end: '19:35' })
  sessions.notePanelUnlocked(P, 'PANEL', W2)
  advance(5 * 60_000); await sched.tick()
  ok('پنجرهٔ ۱ باز شد', open(P, W1) && unlocks.guardedEntryFor(W1, P)?.grantId === e.id)
  ok('پنجرهٔ ۲ (همان قسمت از قبل باز با رمز دوم) مجوز را نگرفت', unlocks.guardedEntryFor(W2, P) === null)
  sessions.clearPanelScope(P, W2)
  advance(30_000); await sched.tick()
  ok('پس از بسته شدن نشست قبلی، پنجرهٔ ۲ در دور بعد گرفت', unlocks.guardedEntryFor(W2, P)?.grantId === e.id)
  configure() // شروع دوباره: حافظهٔ زمان‌بند پاک؛ پرونده می‌ماند
  sessions.clearPanelSessions()
  await sched.tick()
  ok('پس از شروع دوباره، مجوز باز از پرونده دوباره نصب شد', open(P, W1) && open(P, W2))
  sched.closeScheduledGrants({ cancelFuture: true })
  offsetMinutes = 60
  wall = jalaliAtClock(today, '19:50').getTime(); sched.scheduledGrantsResumed()
  const f = await sched.createScheduledGrant({ panel: P, day: today, start: '21:00', end: '21:30' })
  ok('ساعت رسمی (افست ۱ ساعت): ۲۱:۰۰ رسمی = ۲۰:۰۰ ویندوز', f.startAt === jalaliAtClock(today, '20:00').getTime())
  offsetMinutes = 0
  writeFileSync(join(DIR, 'scheduled-grants.json'), '{"version":1,"grants":[{"id":"zz"}]}')
  configure()
  ok('پروندهٔ خراب: هیچ مجوزی', (await sched.listScheduledGrants()).grants.length === 0)
} finally {
  unlocks.setUnlockClockForTests(null)
  sched.stopScheduledGrants()
}

console.log(`\nplan1405-scheduled-grants: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
