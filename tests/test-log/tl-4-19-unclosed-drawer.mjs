/**
 * دفتر آزمون ۴-۱۹ — پیام «⚠️ صندوق بسته نشد و به روز بعد رفت» نام مسئول صندوق و زمان بستن خودکار را دارد؛
 * اگر بستن دیرتر (با روشن شدن برنامه) انجام شده باشد همین را می‌گوید. پیام «مسئول صندوق بایگانی شد …» هم نام
 * همان مسئول را دارد. مثل امروز مهم (⚠️) است؛ «دلیل» آزاد بایگانی هرگز خوانده نمی‌شود. پایگاه موقت.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-19-unclosed-drawer.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-19-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { custodyEventToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { fmtAt } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const noIds = () => ({ users: new Set(), shifts: new Set(), invoices: new Set(), customers: new Set(), payments: new Set(), credits: new Set(), redemptions: [], handovers: new Set() })

const manager = seed.user('مدیر آزمون ۴-۱۹')
const night = seed.user('مسئول شب ۴-۱۹')
await custodyService.setPin({ userId: manager, newPassword: 'Manager419!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager419!' })
await custodyService.setPin({ userId: night, newPassword: 'NightTemp419!', managerUserId: manager, managerPassword: 'Manager419!', reason: 'راه‌اندازی آزمون ۴-۱۹' })
await custodyService.setPin({ userId: night, currentPassword: 'NightTemp419!', newPassword: 'Night419!!' })

const opened = await custodyService.open({ userId: night, password: 'Night419!!', countedCash: 0 })
// برنامه در زمان بستن ثبت‌شده خاموش بود: زمان بستن دو ساعت پیش است و بستن همین حالا با روشن شدن انجام می‌شود.
const effectiveAt = new Date(Date.now() - 2 * 3600_000)
await db.custodyShiftMeta.update({ where: { shiftId: opened.shiftId }, data: { rolloverAt: effectiveAt } })
const rolled = await custodyService.ensureRolledOver(new Date())
assert.ok(rolled?.resolutionId, 'the drawer rolled over unresolved')

async function messages() {
  const mdb = createMessengerDb(db)
  const events = await mdb.custodyEventPage(0, 500)
  const data = await mdb.fetchLookups(noIds(), { events, counts: [] })
  const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data }
  return { events, out: events.flatMap((e) => custodyEventToEvents(e, ctx)) }
}

test('rollover message: custodian name, the recorded automatic close time, and «program was off»', async () => {
  const { events, out } = await messages()
  const ev = events.find((e) => e.type === 'ROLLOVER_UNRESOLVED')
  assert.ok(ev, 'a ROLLOVER_UNRESOLVED event exists')
  const message = out.find((m) => m.code === `E-${ev.id}`)
  assert.ok(message, 'the rollover has a message')
  assert.match(message.title, /^⚠️ صندوق بسته نشد و به روز بعد رفت · /)
  assert.ok(message.lines.includes('مسئول صندوق: مسئول شب ۴-۱۹'), message.lines.join(' | '))
  assert.ok(message.lines.includes(`زمان بستن خودکار: ${fmtAt(effectiveAt.getTime(), 0)}`), message.lines.join(' | '))
  assert.ok(message.lines.includes('برنامه در آن ساعت خاموش بود؛ بستن با روشن شدن انجام شد'), message.lines.join(' | '))
  assert.equal(message.lines.some((l) => l.startsWith('کاربر:')), false, 'no more «کاربر: نامشخص»')
  assert.equal(message.important, true)
})

test('a rollover done on time does not say the program was off', () => {
  const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }
  ctx.data.users.set(9, 'مسئول عصر')
  ctx.data.shifts.set(5, { name: 'عصر', number: 1, userId: 9 })
  const at = Date.UTC(2026, 10, 27, 20, 31)
  const [message] = custodyEventToEvents({ id: 501, type: 'ROLLOVER_UNRESOLVED', shiftId: 5, handoverId: null, actorUserId: null, managerUserId: null, payloadJson: JSON.stringify({ resolutionId: 1, effectiveAt: new Date(at - 60_000).toISOString(), expiryKind: 'CUTOVER_FALLBACK' }), at }, ctx)
  assert.deepEqual(message.lines, ['شیفت: عصر', 'مسئول صندوق: مسئول عصر', `زمان بستن خودکار: ${fmtAt(at - 60_000, 0)}`])
})

test('archived custodian: the message names the same custodian; the free reason is never read', async () => {
  const mdb = createMessengerDb(db)
  const ev = { id: 502, type: 'CUSTODIAN_ARCHIVED_UNRESOLVED', shiftId: null, handoverId: null, actorUserId: null, managerUserId: null, payloadJson: JSON.stringify({ targetUserId: night, reason: 'ترک کار؛ تماس ۰۹۱۲۱۲۳۴۵۶۷', expectedCash: 0 }), at: Date.now() }
  const data = await mdb.fetchLookups(noIds(), { events: [ev], counts: [] })
  assert.equal(data.users.get(night), 'مسئول شب ۴-۱۹', 'messengerDb loads the archived custodian name')
  const [message] = custodyEventToEvents(ev, { offsetHours: 0, threshold: 0, includeCustomerName: false, data })
  assert.match(message.title, /^⚠️ مسئول صندوق بایگانی شد و صندوقش بسته نشده است · /)
  assert.ok(message.lines.includes('مسئول صندوق: مسئول شب ۴-۱۹'), message.lines.join(' | '))
  assert.equal(message.important, true)
  assert.equal(JSON.stringify(message).includes('۰۹۱۲'), false)
  assert.equal(JSON.stringify(message).includes('ترک کار'), false)
})
