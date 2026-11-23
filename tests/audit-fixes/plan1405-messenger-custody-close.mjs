/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — پیام کامل «بستن نهایی صندوق تجمیعی (حضانت)» (آزمون مالک، ۲۰۲۶-۱۱-۲۳).
 *
 * مالک روی رایانهٔ واقعی صندوق تجمیعی را با ۲۰۰٬۰۰۰ ریال کسری بست، ولی پیام تلگرام فقط «کاربر» را داشت.
 * طرح §۲۱ بند ۴ می‌گوید سند تکمیل‌شده پیام کامل دارد (شمرده، مرجع، مغایرت)، مغایرت غیرصفر ⚠️ است و عدد
 * ثبت‌نشده «ثبت نشده» نوشته می‌شود، نه صفر. این آزمون مسیر واقعی `custodyService.open` و `finalClose` و
 * `emergencyCover` را روی پایگاه دادهٔ موقت می‌رود و پیام را با خود `messengerDb` و `custodyEventToEvents` می‌سازد.
 * هیچ پروندهٔ مالی و هیچ آزمون قدیمی تغییر نکرده است.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-messenger-custody-close.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-plan1405-messenger-custody-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { custodyEventToEvents, custodyBoundaryId, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { rial, renderItem } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const noIds = () => ({ users: new Set(), shifts: new Set(), invoices: new Set(), customers: new Set(), payments: new Set(), credits: new Set(), redemptions: [], handovers: new Set() })

const manager = seed.user('مدیر پیام حضانت')
const night = seed.user('مسئول شب پیام')
const morning = seed.user('مسئول صبح پیام')
const cover = seed.user('پوشش اضطراری پیام')
const later = seed.user('مسئول عصر پیام')
await custodyService.setPin({ userId: manager, newPassword: 'ManagerMsg1!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'ManagerMsg1!' })
for (const [id, temporary, permanent] of [[night, 'NightMsg1!', 'NightMsg12!'], [morning, 'MorningMsg1!', 'MorningMsg12!'], [cover, 'CoverMsg1!', 'CoverMsg12!'], [later, 'LaterMsg1!', 'LaterMsg12!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'ManagerMsg1!', reason: 'راه‌اندازی آزمون پیام بستن نهایی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}

// ۱) نشستی که با شمارش جمع کشو و کارت‌خوان باز شد و با کسری بسته شد (همان حالت مالک، با عددهای دیگر)
await custodyService.open({ userId: night, password: 'NightMsg12!', operationalTotal: 20_000_000 })
await custodyService.finalClose({ password: 'NightMsg12!', operationalTotal: 18_000_000 })
// ۲) پوشش اضطراری با کسری تازه
await custodyService.open({ userId: morning, password: 'MorningMsg12!', operationalTotal: 18_000_000 })
await custodyService.emergencyCover({ userId: cover, password: 'CoverMsg12!', operationalTotal: 16_000_000, reason: 'مسئول صبح ناگهان محل کار را ترک کرده و پوشش فوری لازم است.' })
await custodyService.finalClose({ password: 'CoverMsg12!', operationalTotal: 16_000_000 })
// ۳) نشستی که فقط با شمارش نقدی باز شد: بستن نهایی تجمیعی «شمارش پایه» است و مغایرت سنجیده نمی‌شود
await custodyService.open({ userId: later, password: 'LaterMsg12!', countedCash: 0 })
await custodyService.finalClose({ password: 'LaterMsg12!', operationalTotal: 7_000_000 })

async function messages(threshold) {
  const mdb = createMessengerDb(db)
  const events = await mdb.custodyEventPage(0, 500)
  const data = await mdb.fetchLookups(noIds(), { events, counts: [] })
  const ctx = { offsetHours: 0, threshold, includeCustomerName: false, data }
  return { events, data, out: events.flatMap((e) => custodyEventToEvents(e, ctx)) }
}
const finals = (events) => events.filter((e) => e.type === 'FINAL_AGGREGATE_CLOSE')

test('final aggregate close: the message carries counted, reference and the recorded difference, marked ⚠️', async () => {
  const { events, data, out } = await messages(0)
  const [first] = finals(events)
  assert.ok(first, 'a FINAL_AGGREGATE_CLOSE event exists')
  const boundaryId = custodyBoundaryId(first)
  assert.ok(Number.isSafeInteger(boundaryId) && boundaryId > 0, 'the event points at its aggregate boundary')
  assert.ok(data.boundaries.has(boundaryId), 'messengerDb loaded that boundary')
  const row = seed.one('SELECT observedOperationalTotal AS o, operationalExpectedTotal AS e, newDifference AS d FROM "CustodyAggregateBoundary" WHERE id=?', boundaryId)
  assert.deepEqual([Number(row.o), Number(row.e), Number(row.d)], [18_000_000, 20_000_000, -2_000_000], 'the boundary recorded the shortage')
  const message = out.find((m) => m.code === `E-${first.id}`)
  assert.ok(message, 'the close has a message')
  assert.match(message.title, /بستن نهایی صندوق تجمیعی/)
  assert.ok(message.lines.includes(`شمرده (کشو + کارت‌خوان): ${rial(18_000_000)} · مرجع: ${rial(20_000_000)}`), message.lines.join(' | '))
  assert.ok(message.lines.includes(`مغایرت: ${rial(2_000_000)} کسری`), message.lines.join(' | '))
  assert.equal(message.important, true, 'a non-zero difference is a sensitive (⚠️) event')
  assert.ok(renderItem({ ...message, maybeDup: false, sale: false, day: null }, message.at).startsWith('⚠️ '))
})

test('big-difference alert uses the same threshold as a normal cash close', async () => {
  const [first] = finals((await messages(0)).events)
  const alertCode = `E-${first.id}-D`
  const at1m = (await messages(1_000_000)).out.find((m) => m.code === alertCode)
  assert.ok(at1m, 'a 2,000,000 shortage above a 1,000,000 limit raises the 🚨 alert')
  assert.equal(at1m.system, true, 'the alert reaches every recipient, like the cash-close alert')
  assert.ok(at1m.lines.includes(`سقف مجاز مغایرت: ${rial(1_000_000)}`))
  assert.equal((await messages(5_000_000)).out.some((m) => m.code === alertCode), false, 'no alert under the limit')
  assert.equal((await messages(0)).out.some((m) => m.code === alertCode), false, 'no alert when the limit is off')
})

test('emergency cover: the message carries its own recorded amounts', async () => {
  const { events, out } = await messages(0)
  const ev = events.find((e) => e.type === 'EMERGENCY_COVER_COMPLETED')
  assert.ok(ev)
  const message = out.find((m) => m.code === `E-${ev.id}`)
  assert.ok(message.lines.includes(`شمرده: ${rial(16_000_000)} · مرجع: ${rial(18_000_000)} · مغایرت: ${rial(2_000_000)} کسری`), message.lines.join(' | '))
})

test('a matched close says «تطبیق کامل» and is not marked ⚠️', async () => {
  const { events, out } = await messages(1)
  const second = finals(events)[1]
  const message = out.find((m) => m.code === `E-${second.id}`)
  assert.ok(message.lines.includes(`مغایرت: تطبیق کامل (۰)`), message.lines.join(' | '))
  assert.equal(message.important, false)
  assert.equal(out.some((m) => m.code === `E-${second.id}-D`), false)
})

test('a session opened with a cash-only count: the difference is «not measured», never zero, and no alert', async () => {
  const { events, out } = await messages(1)
  const third = finals(events)[2]
  const row = seed.one('SELECT baselineSource AS s, newDifference AS d FROM "CustodyAggregateBoundary" WHERE id=?', custodyBoundaryId(third))
  assert.deepEqual([row.s, Number(row.d)], ['ADOPTION', 0], 'the custody service recorded a baseline count, not a difference')
  const message = out.find((m) => m.code === `E-${third.id}`)
  assert.ok(message.lines.includes(`شمرده (کشو + کارت‌خوان): ${rial(7_000_000)}`), message.lines.join(' | '))
  assert.ok(message.lines.some((l) => l.startsWith('مغایرت: سنجیده نشد')), message.lines.join(' | '))
  assert.equal(message.lines.some((l) => l.includes('تطبیق کامل')), false, 'never reported as a perfect match')
  assert.equal(message.important, false)
  assert.equal(out.some((m) => m.code === `E-${third.id}-D`), false)
})

test('a boundary that cannot be read is written «ثبت نشده», never zero', () => {
  const ctx = { offsetHours: 0, threshold: 1, includeCustomerName: false, data: emptyLookups() }
  const [message] = custodyEventToEvents({ id: 77, type: 'FINAL_AGGREGATE_CLOSE', shiftId: null, handoverId: null, actorUserId: null, managerUserId: null, payloadJson: JSON.stringify({ aggregateBoundaryId: 999 }), at: Date.now() }, ctx)
  assert.ok(message.lines.includes('شمرده و مرجع: ثبت نشده'), message.lines.join(' | '))
  assert.equal(message.important, false)
})
