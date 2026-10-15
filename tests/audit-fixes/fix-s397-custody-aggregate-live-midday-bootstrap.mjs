/**
 * s397 — historical aggregate-v2 compatibility + live blue custody policy.
 *
 *  • Sections 1–4 preserve the old cash-only→aggregate migration evidence.
 *    A canceled old attempt leaves no accepted baseline; rollback is atomic.
 *  • New exception/close routes record blue snapshots, never new aggregate-v2
 *    cases or an OPENING_FLOAT from the combined drawer/POS amount.
 *  • The manager's live mid-day permission admits an independently PIN-verified
 *    receiver not on the schedule roster; inactive/temporary PINs are denied.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s397-custody-aggregate-live-midday-bootstrap.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-custody-s397-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { SETTING_KEYS } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const rejectsWith = async (label, code, work) => {
  try { await work(); eq(label, 'no-error', code) }
  catch (error) { eq(label, error?.code ?? error?.message, code) }
}
const count = (sql, ...params) => Number(seed.one(sql, ...params)?.n ?? 0)
const hm = (minute) => `${String(Math.floor(((minute % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((minute % 60) + 60) % 60).padStart(2, '0')}`

const manager = seed.user('مدیر S397')
const makeStaff = (name, temporary, permanent) => {
  const id = seed.user(name)
  db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
  return { id, temporary, permanent }
}
const staff = {
  a: makeStaff('الف S397', 'Alef397!', 'Alef3974!'),
  b: makeStaff('ب S397', 'Bee397!', 'Bee3974!'),
  c: makeStaff('ج S397', 'Jim397!', 'Jim3974!'),
  d: makeStaff('د S397', 'Dal397!', 'Dal3974!'),
  e: makeStaff('ه S397', 'He397!', 'He3974!'),
  f: makeStaff('و S397', 'Vav397!', 'Vav3974!')
}
await custodyService.setPin({ userId: manager, newPassword: 'Manager397!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager397!' })
for (const person of Object.values(staff)) {
  await custodyService.setPin({ userId: person.id, newPassword: person.temporary, managerUserId: manager, managerPassword: 'Manager397!', reason: 'راه‌اندازی آزمون s397' })
  await custodyService.setPin({ userId: person.id, currentPassword: person.temporary, newPassword: person.permanent })
}
const SHIFT_BOUNDARY_NOTE = 'مرز نهایی را با مبلغ واقعی ببندید.'
void SHIFT_BOUNDARY_NOTE

/** Reset to NO_SESSION with the authenticated blue final count. */
async function resetWith(person, total) {
  const status = await custodyService.status()
  if (status.state !== 'ACTIVE') return
  await custodyService.finalClose({ password: person.permanent, operationalTotal: total })
}
const boundariesFor = (shiftId) => count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE toShiftId=?', shiftId)

console.log('\n[1] رفتن از cash-only به handover تجمیعی: بدون مبلغ جعلی، بدون پرونده تکراری')
{
  const giver = staff.a
  const receiver = staff.b
  const opened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  eq('segment cash-only بدون baseline باز شد', count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE toShiftId=?', opened.shiftId), 0)
  const started = await custodyService.handoverStart({ password: giver.permanent, operationalTotal: 5_000_000, toUserId: receiver.id, idempotencyKey: 's397-bootstrap-clean' })
  eq('شروع تحویل بدون baseline ثبت شد', started.state, 'HANDOVER_PENDING')
  eq('شروع تحویل هیچ baseline فعالی نمی‌سازد (فقط candidate روی watermark)', count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary"'), 0)
  eq('شروع تحویل مبلغ انتظار را برنمی‌گرداند', Object.hasOwn(started, 'expectedCash'), false)
  const accepted = await custodyService.handoverAccept({ handoverId: started.id, password: receiver.permanent, operationalTotal: 5_000_000 })
  eq('پذیرش تحویل مبلغ انتظار را برنمی‌گرداند', Object.hasOwn(accepted, 'expectedCash'), false)
  const adoption = seed.one('SELECT * FROM "CustodyAggregateBoundary" WHERE baselineSource=? AND toShiftId=?', 'ADOPTION', opened.shiftId)
  eq('شمارش واقعی giver، baseline ADOPTION همان segment است', Number(adoption?.observedOperationalTotal), 5_000_000)
  eq('ADOPTION هیچ اختلافی ثبت نمی‌کند', Number(adoption?.newDifference), 0)
  const handover = seed.one('SELECT * FROM "CustodyAggregateBoundary" WHERE boundaryKind=?', 'HANDOVER')
  eq('مرز تحویل با baseline زنجیره‌ای (CHAINED) ثبت شد', handover?.baselineSource, 'CHAINED')
  eq('مرز تحویل به adoption متصل است', Number(handover?.previousBoundaryId), Number(adoption?.id))
  eq('تحویل بدون تفاوت، اختلاف تازه ندارد', Number(handover?.newDifference), 0)
  eq('هیچ پروندهٔ مغایرت ساخته نشد', count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"'), 0)
  eq('مبلغ POS به OPENING_FLOAT نقدی تبدیل نشد', count('SELECT COUNT(*) AS n FROM "CashMovement" WHERE type=? AND shiftId IN (?, ?)', 'OPENING_FLOAT', opened.shiftId, accepted.shiftId), 0)
  eq('شمارش پذیرش، expected واقعی شمارش پایهٔ تحویل‌دهنده را دارد (نه صفر و نه جعلی)', Number(seed.one('SELECT expectedCash FROM "CustodyCount" WHERE kind=? AND handoverId=?', 'HANDOVER_AGGREGATE_RECOUNT', started.id)?.expectedCash), 5_000_000)
  eq('مسئولیت به گیرنده منتقل شد', (await custodyService.status()).custodian?.id, receiver.id)
}

console.log('\n[2] cash-only بدون baseline، شمارش تحویل‌دهنده و گیرنده متفاوت: فقط اختلاف تازهٔ همان مرز')
{
  await resetWith(staff.b, 5_000_000)
  const giver = staff.c
  const receiver = staff.d
  await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  const started = await custodyService.handoverStart({ password: giver.permanent, operationalTotal: 5_000_000, toUserId: receiver.id, idempotencyKey: 's397-bootstrap-diff' })
  await custodyService.handoverAccept({ handoverId: started.id, password: receiver.permanent, operationalTotal: 4_000_000 })
  const handover = seed.one('SELECT newDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1', 'HANDOVER')
  eq('اختلاف تازه = شمارش گیرنده − (شمارش پایه + حرکت)', Number(handover?.newDifference), -1_000_000)
  eq('دقیقاً یک پروندهٔ تازه برای همین مرز', count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase" WHERE boundaryKind=?', 'HANDOVER'), 1)
}

console.log('\n[3] تحویل شروع‌شده و لغوشده: baseline فعال نمی‌سازد؛ شمارش دوباره ممکن است')
{
  await resetWith(staff.d, 4_000_000)
  const giver = staff.e
  const receiver = staff.f
  const opened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  const beforeCases = count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')
  const started = await custodyService.handoverStart({ password: giver.permanent, operationalTotal: 7_000_000, toUserId: receiver.id, idempotencyKey: 's397-cancel-1' })
  await custodyService.handoverCancel({ handoverId: started.id, password: giver.permanent })
  eq('لغو تحویل هیچ ADOPTION فعالی باقی نمی‌گذارد', count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE baselineSource=? AND toShiftId=?', 'ADOPTION', opened.shiftId), 0)
  eq('لغو تحویل هیچ پروندهٔ جدیدی نمی‌سازد', count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"'), beforeCases)
  eq('segment پس از لغو همچنان فعال و نزد همان مسئول است', (await custodyService.status()).custodian?.id, giver.id)
  const restarted = await custodyService.handoverStart({ password: giver.permanent, operationalTotal: 9_000_000, toUserId: receiver.id, idempotencyKey: 's397-cancel-2' })
  await custodyService.handoverAccept({ handoverId: restarted.id, password: receiver.permanent, operationalTotal: 9_000_000 })
  const adoptions = seed.rows('SELECT observedOperationalTotal FROM "CustodyAggregateBoundary" WHERE baselineSource=? AND toShiftId=?', 'ADOPTION', opened.shiftId)
  eq('فقط شمارش پذیرفته‌شده baseline می‌شود (نه شمارش لغوشده)', adoptions.length === 1 && Number(adoptions[0].observedOperationalTotal) === 9_000_000, true)
}

console.log('\n[4] خطای ثبت هنگام پذیرش: rollback کامل، تحویل PENDING می‌ماند، baseline ساخته نمی‌شود')
{
  await resetWith(staff.f, 9_000_000)
  const giver = staff.a
  const receiver = staff.b
  const faultOpened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  const started = await custodyService.handoverStart({ password: giver.permanent, operationalTotal: 2_000_000, toUserId: receiver.id, idempotencyKey: 's397-fault' })
  db.$harness.breakNext('CustodyAggregateBoundary', 'create')
  let failure = ''
  try { await custodyService.handoverAccept({ handoverId: started.id, password: receiver.permanent, operationalTotal: 2_000_000 }) } catch (error) { failure = error?.message ?? '' }
  eq('خطای ثبت مرز به فراخواننده برمی‌گردد', failure.includes('HARNESS-FAULT'), true)
  eq('پس از خطا تحویل در انتظار می‌ماند', (await custodyService.status()).state, 'HANDOVER_PENDING')
  eq('پس از خطا adoption نیمه‌کاره نمی‌ماند', count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE toShiftId=?', faultOpened.shiftId), 0)
  const retry = await custodyService.handoverAccept({ handoverId: started.id, password: receiver.permanent, operationalTotal: 2_000_000 })
  eq('تلاش دوباره همان تحویل را احراز می‌کند', retry.state, 'ACTIVE')
  eq('تلاش دوباره دقیقاً یک baseline ADOPTION برای همین segment می‌سازد', count('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE baselineSource=? AND toShiftId=?', 'ADOPTION', faultOpened.shiftId), 1)
}

console.log('\n[5] پوشش اضطراری و بستن نهایی روی segment بدون baseline: یک شمارش، بدون expected جعلی')
{
  await resetWith(staff.b, 2_000_000)
  const giver = staff.c
  const cover = staff.d
  const opened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  const emergency = await custodyService.emergencyCover({ userId: cover.id, password: cover.permanent, operationalTotal: 3_000_000, reason: 'مسئول قبلی حاضر نیست و باید پوشش داده شود.' })
  const emergencyBoundary = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=? ORDER BY id DESC LIMIT 1', emergency.shiftId, 'IN')
  eq('پوشش اضطراری فقط سند آبی با شمارش واقعی می‌سازد', Number(emergencyBoundary?.humanAmount), 3_000_000)
  eq('شمارش جدید در نشست قبلی ثبت نمی‌شود', count('SELECT COUNT(*) AS n FROM "CustodyCount" WHERE shiftId=? AND kind=?', opened.shiftId, 'BLUE_EMERGENCY_IN'), 0)
  eq('پوشش اضطراری بدون شمارش واقعی قبلی، اختلاف تازهٔ ساختگی ندارد', emergencyBoundary?.freshDifference, null)
  eq('پوشش اضطراری پروندهٔ مغایرت قدیمی نمی‌سازد', count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase" WHERE boundaryKind=?', 'EMERGENCY_COVER'), 0)
  eq('پوشش اضطراری expected جعلی روی شمارش نمی‌نشاند', count('SELECT COUNT(*) AS n FROM "CustodyCount" WHERE shiftId=? AND kind=? AND expectedCash IS NOT NULL', emergency.shiftId, 'BLUE_EMERGENCY_IN'), 0)
  eq('مسئولیت به پوشش‌دهنده منتقل شد', (await custodyService.status()).custodian?.id, cover.id)
  await resetWith(cover, 3_000_000)
  eq('بستن نهایی با segment تازه بی‌خطر است', (await custodyService.status()).state, 'NO_SESSION')
}

console.log('\n[6] Master Override روی segment بدون سابقهٔ آبی: PIN شخصی و سند واقعی، بدون expected جعلی')
{
  const giver = staff.e
  const opened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  const override = await custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager397!', operationalTotal: 1_500_000, reason: 'مسئول غایب است و مدیر مسئولیت صندوق را می‌گیرد.' })
  const witness = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=? ORDER BY id DESC LIMIT 1', override.shiftId, 'IN')
  eq('Master Override به جای aggregate-v2 سند مستقل آبی دارد', Number(witness?.humanAmount), 1_500_000)
  eq('شمارش مدیر برای شیفت قبلی ثبت نمی‌شود', count('SELECT COUNT(*) AS n FROM "CustodyCount" WHERE shiftId=? AND kind=?', opened.shiftId, 'BLUE_MASTER_OVERRIDE_IN'), 0)
  eq('سند Master Override PIN شخصی مدیر را ثبت می‌کند', witness?.authMethod, 'MANAGER_CUSTODY_PIN')
  eq('بدون شمارش انسانی قبلی، اختلاف تازه نامعلوم می‌ماند', witness?.freshDifference, null)
  eq('مدیر منتخب مسئول شد', (await custodyService.status()).custodian?.id, manager)
  eq('Master Override پرونده نمی‌سازد', count('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase" WHERE boundaryKind=?', 'MASTER_OVERRIDE'), 0)
}

console.log('\n[7] بستن نهایی بدون مبنای آبی: rollback کاملِ snapshot، بدون اختلاف تازهٔ جعلی')
{
  await resetWith({ id: manager, permanent: 'Manager397!' }, 1_500_000)
  const giver = staff.f
  const opened = await custodyService.open({ userId: giver.id, password: giver.permanent, countedCash: 0 })
  db.$harness.breakNext('CustodyBlueSnapshot', 'create')
  let fault = ''
  try { await custodyService.finalClose({ password: giver.permanent, operationalTotal: 800_000 }) }
  catch (error) { fault = error?.message ?? '' }
  eq('خطای ثبت سند نهایی به فراخواننده برمی‌گردد', fault.includes('HARNESS-FAULT'), true)
  eq('خطای بستن نهایی segment را نیمه‌بسته نمی‌گذارد', (await custodyService.status()).state, 'ACTIVE')
  eq('ثبت شکست‌خورده سند ناقص نمی‌گذارد', count('SELECT COUNT(*) AS n FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'FINAL_CLOSE', opened.shiftId), 0)
  await custodyService.finalClose({ password: giver.permanent, operationalTotal: 800_000 })
  const final = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=? ORDER BY id DESC LIMIT 1', 'FINAL_CLOSE', opened.shiftId)
  eq('تلاش تازه شمارش واقعی را در سند نهایی ثبت می‌کند', Number(final?.humanAmount), 800_000)
  eq('مرجع صفر واقعی، اختلاف خام مثبت را نگه می‌دارد', Number(final?.rawDifference), 800_000)
  eq('بدون مبنای انسانی آبی، اختلاف تازه قابل انتساب نیست', final?.freshDifference, null)
  eq('بستن نهایی segment را NO_SESSION می‌کند', (await custodyService.status()).state, 'NO_SESSION')
}

console.log('\n[8] سیاست میان‌روز زنده: گیرندهٔ خارج از roster، و رد وقتی سیاست خاموش است')
{
  const now = new Date()
  const minute = now.getHours() * 60 + now.getMinutes()
  const midGiver = staff.a
  const outsider = staff.c
  const setTemplate = (allow) => seed.setting(SETTING_KEYS.shiftConfig, {
    byTime: true, custodyMode: 'MULTI_SHIFT', reminderEnabled: true, overrunGraceMinutes: 0,
    templates: [{ id: 's397-mid', name: 'شیفت میان‌روز', startTime: hm(minute - 20), endTime: hm(minute + 120), isActive: true, daysMask: 1 << now.getDay(), staffIds: [midGiver.id], reminderRepeatMin: 15, allowMidDayHandover: allow }]
  })
  await resetWith(staff.d, 0).catch(() => {})
  setTemplate(false)
  await custodyService.open({ userId: midGiver.id, password: midGiver.permanent, countedCash: 0 })
  await rejectsWith('سیاست خاموش: گیرندهٔ غیرroster رد می‌شود', 'MIDDAY_HANDOVER_DISABLED', () => custodyService.handoverStart({ password: midGiver.permanent, operationalTotal: 0, blueReference: true, toUserId: outsider.id, idempotencyKey: 's397-mid-off' }))
  setTemplate(true)
  const started = await custodyService.handoverStart({ password: midGiver.permanent, operationalTotal: 0, blueReference: true, toUserId: outsider.id, idempotencyKey: 's397-mid-on' })
  eq('سیاست زنده روشن: تحویل میان‌روز به گیرندهٔ غیرroster شروع شد', started.state, 'HANDOVER_PENDING')
  const watermark = JSON.parse(seed.one('SELECT ledgerWatermark FROM "CustodyHandover" WHERE id=?', started.id)?.ledgerWatermark ?? '{}')
  eq('منبع مجوز در evidence ثبت شد (CURRENT_SETTINGS)', watermark.midDayPolicySource, 'CURRENT_SETTINGS')
  eq('رویداد زندهٔ سیاست ثبت شد', count('SELECT COUNT(*) AS n FROM "CustodyEvent" WHERE type=?', 'MIDDAY_POLICY_LIVE_APPLIED'), 1)
  eq('snapshot افتتاح دست‌نخورده است', JSON.parse(seed.one('SELECT scheduleSnapshotJson FROM "CustodyShiftMeta" WHERE shiftId=?', (await custodyService.status()).shift?.id ?? 0)?.scheduleSnapshotJson ?? '{}').allowMidDayHandover, false)
  await custodyService.handoverCountBlue({ handoverId: started.id, password: outsider.permanent, operationalTotal: 0 })
  const accepted = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: outsider.permanent })
  eq('گیرندهٔ خارج از roster با شمارش مستقل پذیرفته شد', accepted.state, 'ACTIVE')
  eq('مسئولیت به گیرندهٔ میان‌روز رفت', (await custodyService.status()).custodian?.id, outsider.id)
  setTemplate(false)
  await resetWith(outsider, 0)
}

console.log('\n[9] گیرندهٔ نامعتبر: غیرفعال، PIN موقت، بدون PIN')
{
  const now = new Date()
  const minute = now.getHours() * 60 + now.getMinutes()
  seed.setting(SETTING_KEYS.shiftConfig, { byTime: true, custodyMode: 'MULTI_SHIFT', reminderEnabled: true, overrunGraceMinutes: 0, templates: [{ id: 's397-mid2', name: 'شیفت دو', startTime: hm(minute - 20), endTime: hm(minute + 120), isActive: true, daysMask: 1 << now.getDay(), staffIds: [staff.e.id], reminderRepeatMin: 15, allowMidDayHandover: true }] })
  await custodyService.open({ userId: staff.e.id, password: staff.e.permanent, countedCash: 0 })
  const tempUser = seed.user('موقت S397')
  db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', tempUser)
  await custodyService.setPin({ userId: tempUser, newPassword: 'Temp397!', managerUserId: manager, managerPassword: 'Manager397!', reason: 'آزمون گیرندهٔ موقت' })
  await rejectsWith('PIN موقت گیرنده رد می‌شود', 'RECEIVER_NO_PIN', () => custodyService.handoverStart({ password: staff.e.permanent, operationalTotal: 0, blueReference: true, toUserId: tempUser, idempotencyKey: 's397-temp' }))
  const noPin = seed.user('بی‌PIN S397')
  db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', noPin)
  await rejectsWith('گیرندهٔ بدون PIN رد می‌شود', 'RECEIVER_NO_PIN', () => custodyService.handoverStart({ password: staff.e.permanent, operationalTotal: 0, blueReference: true, toUserId: noPin, idempotencyKey: 's397-nopin' }))
  await resetWith(staff.e, 0)
}

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
