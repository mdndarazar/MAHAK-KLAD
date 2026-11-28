/**
 * دفتر آزمون ۴-۲۷ — فاصلهٔ تحویل یا بستن با پایان برنامهٔ شیفت (فقط پیگیری مدیر؛ مغایرت نیست):
 * «به‌موقع» در ۱۵ دقیقهٔ آخر، «… دقیقه دیرتر» پس از پایان، «… دقیقه زودتر» پیش از آن؛ در پیام «🔁 تحویل صندوق ·
 * تکمیل‌شده»، پیام بستن نهایی و پیام بستن صندوق. خلاصهٔ ساعت ۲۴: «تحویل‌های دیر» و «صندوق‌های بسته‌نشده».
 * «اضافه‌کاری … دقیقه» با ۴-۱۷ (دستهٔ ۶) می‌آید. پایگاه موقت.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-27-shift-end-gap.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-27-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { custodyEventToEvents, auditPageToEvents, emptyLookups, shiftEndGap } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { buildDailySummary } = await import('../../src/main/services/cloud/messenger/messengerSummary.ts')
const { toJalaliDate, jalaliAddDays } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const noIds = () => ({ users: new Set(), shifts: new Set(), invoices: new Set(), customers: new Set(), payments: new Set(), credits: new Set(), redemptions: [], handovers: new Set() })
const MIN = 60_000

test('gap wording: on time in the last 15 minutes, later, earlier; no schedule ⇒ no line', () => {
  const end = Date.UTC(2026, 10, 28, 12, 30)
  assert.equal(shiftEndGap(end - 15 * MIN, end), 'به‌موقع')
  assert.equal(shiftEndGap(end, end), 'به‌موقع')
  assert.equal(shiftEndGap(end + 59_000, end), 'به‌موقع')
  assert.equal(shiftEndGap(end + 12 * MIN + 30_000, end), '۱۲ دقیقه دیرتر از پایان شیفت')
  assert.equal(shiftEndGap(end - 40 * MIN, end), '۴۰ دقیقه زودتر از پایان شیفت')
  assert.equal(shiftEndGap(end, null), '')
})

const manager = seed.user('مدیر ۴-۲۷', { role: 'MANAGER' })
const giver = seed.user('تحویل‌دهندهٔ ۴-۲۷', { role: 'CASHIER' })
const receiver = seed.user('تحویل‌گیرندهٔ ۴-۲۷', { role: 'CASHIER' })
await custodyService.setPin({ userId: manager, newPassword: 'Manager427!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager427!' })
for (const [id, temporary, permanent] of [[giver, 'GiverTmp427!', 'Giver427!!'], [receiver, 'RecvTmp427!', 'Recv427!!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager427!', reason: 'راه‌اندازی آزمون ۴-۲۷' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
// ۱) تحویل ۲۰ دقیقه پس از پایان برنامهٔ شیفت تحویل‌دهنده
const first = await custodyService.open({ userId: giver, password: 'Giver427!!', operationalTotal: 1_000_000 })
await db.custodyShiftMeta.update({ where: { shiftId: first.shiftId }, data: { scheduledEndAt: new Date(Date.now() - 20 * MIN - 5_000) } })
const started = await custodyService.handoverStart({ password: 'Giver427!!', operationalTotal: 1_000_000, toUserId: receiver, idempotencyKey: 'tl-4-27' })
const accepted = await custodyService.handoverAccept({ handoverId: started.id, password: 'Recv427!!', operationalTotal: 1_000_000 })
// ۲) بستن نهایی ۴۰ دقیقه پیش از پایان برنامهٔ شیفت تحویل‌گیرنده
await db.custodyShiftMeta.update({ where: { shiftId: accepted.shiftId }, data: { scheduledEndAt: new Date(Date.now() + 40 * MIN + 30_000) } })
await custodyService.finalClose({ password: 'Recv427!!', operationalTotal: 1_000_000 })
// ۳) صندوقی که بسته نشد و برنامه خودکار بست
const third = await custodyService.open({ userId: giver, password: 'Giver427!!', operationalTotal: 1_000_000 })
await db.custodyShiftMeta.update({ where: { shiftId: third.shiftId }, data: { rolloverAt: new Date(Date.now() - 5 * MIN) } })
assert.ok((await custodyService.ensureRolledOver(new Date()))?.resolutionId, 'the third drawer rolled over unresolved')

async function messages() {
  const mdb = createMessengerDb(db)
  const events = await mdb.custodyEventPage(0, 500)
  const data = await mdb.fetchLookups(noIds(), { events, counts: [] })
  const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data }
  return { events, out: events.flatMap((e) => custodyEventToEvents(e, ctx)) }
}

test('handover message: «زمان تحویل: ۲۰ دقیقه دیرتر از پایان شیفت» (the giver\'s schedule)', async () => {
  const { events, out } = await messages()
  const ev = events.find((e) => e.type === 'HANDOVER_ACCEPT' || e.type === 'HANDOVER_ACCEPT_WITH_DIFFERENCE')
  assert.ok(ev, 'a completed handover event exists')
  const message = out.find((m) => m.code === `E-${ev.id}`)
  assert.match(message.title, /^🔁 تحویل صندوق · تکمیل‌شده · /)
  assert.ok(message.lines.includes('زمان تحویل: ۲۰ دقیقه دیرتر از پایان شیفت'), message.lines.join(' | '))
})

test('final close message: «زمان بستن: ۴۰ دقیقه زودتر از پایان شیفت»', async () => {
  const { events, out } = await messages()
  const ev = events.find((e) => e.type === 'FINAL_AGGREGATE_CLOSE')
  assert.ok(ev, 'a final aggregate close event exists')
  const message = out.find((m) => m.code === `E-${ev.id}`)
  assert.ok(message.lines.includes('زمان بستن: ۴۰ دقیقه زودتر از پایان شیفت'), message.lines.join(' | '))
})

test('cash-close message of a scheduled segment: on time; an unscheduled segment has no line', () => {
  const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }
  const at = Date.UTC(2026, 10, 28, 16, 0)
  ctx.data.segments.set(7, { scheduledEndAt: at + 5 * MIN })
  ctx.data.segments.set(8, { scheduledEndAt: null })
  const close = (id, shiftId) => auditPageToEvents([{ id, at, userId: null, action: 'CASH_CLOSE', entity: 'CashSession', entityId: id, after: JSON.stringify({ shiftId, expectedCash: 0, countedCash: 0, cashDifference: 0 }), note: null }], ctx, { closeShiftIds: [] })[0]
  assert.ok(close(1, 7).lines.includes('زمان بستن: به‌موقع'), close(1, 7).lines.join(' | '))
  assert.equal(close(2, 8).lines.some((l) => l.startsWith('زمان بستن')), false)
})

const summaryDeps = () => ({
  db: createMessengerDb(db),
  salesSummary: async () => ({ count: 0, grandTotal: 0, cashTotal: 0, cardTotal: 0, otherTotal: 0, managerAccountTotal: 0, creditTotal: 0 }),
  staffPerformance: async () => ({ rows: [] }),
  abnormalDiscounts: async () => ({ rows: [], disabled: true }),
  lastBackupAt: async () => null
})

test('24:00 summary: late handovers (name and minutes) and unclosed drawers (name)', async () => {
  const today = toJalaliDate(new Date())
  const summary = await buildDailySummary(today, summaryDeps(), { offsetHours: 0, now: Date.now() })
  assert.ok(summary.lines.includes('تحویل‌های دیر: تحویل‌دهندهٔ ۴-۲۷ (۲۰ دقیقه)'), summary.lines.join(' | '))
  assert.ok(summary.lines.includes('صندوق‌های بسته‌نشده: تحویل‌دهندهٔ ۴-۲۷'), summary.lines.join(' | '))
  // روزی که رویداد حضانتی ندارد این دو خط را ندارد (فروشگاه بی حضانت هم همین)
  const quiet = await buildDailySummary(jalaliAddDays(today, -3), summaryDeps(), { offsetHours: 0, now: Date.now() })
  assert.equal(quiet.lines.some((l) => l.startsWith('تحویل‌های دیر') || l.startsWith('صندوق‌های بسته‌نشده')), false, quiet.lines.join(' | '))
})
