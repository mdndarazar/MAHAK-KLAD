/**
 * An old interrupted manager-override witness can itself expire while no
 * previous operator is present. System rollover retires the unfinished Shift
 * at its real cutover, preserving the override's historic kind/count/reason.
 * The next cashier has to open anew with their own PIN and actual observation.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s440-expired-master-recount-evidence.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-expired-override-s440-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
import { grantMiddayFixture } from './grant-midday-fixture.mjs'
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر پروندهٔ S440')
const oldOwner = seed.user('مسئول قدیمی S440')
const intended = seed.user('گیرندهٔ ناموفق S440')
const present = seed.user('مسئول حاضر S440')
for (const id of [oldOwner, intended, present]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager440!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager440!' })
await grantMiddayFixture({ manager, password: 'Manager440!', custodian: oldOwner })
for (const [id, temporary, permanent] of [
  [oldOwner, 'OldTemp440!', 'OldFinal440!'], [intended, 'IntendedTemp440!', 'IntendedFinal440!'],
  [present, 'PresentTemp440!', 'PresentFinal440!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager440!', reason: 'PIN جداگانه برای پروندهٔ قدیمی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
const old = await custodyService.open({ userId: oldOwner, password: 'OldFinal440!', countedCash: 500 })
const firstHandover = await custodyService.handoverStart({ password: 'OldFinal440!', operationalTotal: 500,
  toUserId: intended, idempotencyKey: 's440-pre-blue-override' })
const countId = seed.insert('CustodyCount', { shiftId: old.shiftId, handoverId: firstHandover.id,
  kind: 'HANDOVER_RECOUNT_DIFFERENCE_PENDING', countedCash: 490, expectedCash: 500,
  differenceCash: -10, countedByUserId: intended, authMethod: 'CUSTODY_PIN',
  operationalDay: toJalaliDate(new Date()), idempotencyKey: 's440-override-old-count' })
const oldReason = 'مدیر قدیمی شمارش را آغاز کرد ولی ارتباط برنامه قطع شد؛ سند محفوظ است.'
sql.prepare('UPDATE "CustodyHandover" SET status=?, resolutionKind=?, resolutionReason=? WHERE id=?')
  .run('MASTER_OVERRIDE_RECOUNT', 'MASTER_OVERRIDE', oldReason, firstHandover.id)
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
eq('old master override is a live frozen historical attempt', (await custodyService.status()).state, 'HANDOVER_RECOUNT')
const past = new Date(Date.now() - 180 * 86400_000)
const cutover = new Date(past.getTime() + 2 * 3600_000)
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(past.toISOString(), old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?')
  .run(toJalaliDate(past), cutover.toISOString(), old.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=?').run(toJalaliDate(past), old.shiftId)
// Simulate a restart: next ordinary open invokes rollover itself. No scheduled
// polling, acceptance by the old receiver, or old manager PIN is available.
const opened = await custodyService.open({ userId: present, password: 'PresentFinal440!',
  operationalTotal: 0, note: 'مسئول قدیمی نیست؛ امروز صندوق را شخصاً شمردم.' })
eq('new worker gets only new Shift after expiry', seed.one('SELECT userId FROM "Shift" WHERE id=?', opened.shiftId)?.userId, present)
eq('old Shift closed at pre-outage cutover', Number(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt), cutover.getTime())
const retired = seed.one('SELECT * FROM "CustodyHandover" WHERE id=?', firstHandover.id)
eq('unfinished master attempt remains unresolved', retired?.status, 'EXPIRED_UNRESOLVED')
eq('old master-override origin survives rollover', retired?.resolutionKind, 'MASTER_OVERRIDE')
eq('old master reason survives rollover', retired?.resolutionReason, oldReason)
eq('old count stays an independent old Shift witness', seed.one('SELECT shiftId FROM "CustodyCount" WHERE id=?', countId)?.shiftId, old.shiftId)
eq('old 490 count is not rewritten by new zero', seed.one('SELECT countedCash FROM "CustodyCount" WHERE id=?', countId)?.countedCash, 490)
const event = seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE handoverId=? AND type=?', firstHandover.id, 'ROLLOVER_UNRESOLVED')
eq('system audit retains frozen override state', JSON.parse(event?.payloadJson ?? '{}').previousState, 'HANDOVER_RECOUNT')
eq('system audit retains previous override workflow', JSON.parse(event?.payloadJson ?? '{}').priorHandoverStatus, 'MASTER_OVERRIDE_RECOUNT')
eq('system audit retains previous override kind', JSON.parse(event?.payloadJson ?? '{}').priorResolutionKind, 'MASTER_OVERRIDE')
eq('no earlier pending count is turned into blame', seed.count('CustodyDiscrepancyCase'), 0)
eq('only new worker observed explicitly zero today', seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING')?.humanAmount, 0)
console.log(`\n✓ ${checks} expired override audit checks passed`)
