/** Single-shift MIDDAY permission is default-deny and comes only from a
 * durable snapshot or a manager-PIN workflow grant, not a UI checkbox alone.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s460-single-shift-midday-permission.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-midday-permission-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log(`  ✓ ${name}`) }
const fails = async (name, code, fn) => {
  await assert.rejects(fn, (error) => error?.code === code, name); checks++; console.log(`  ✓ ${name}`)
}
const manager = seed.user('مدیر مجوز S460'), giver = seed.user('تحویل‌دهنده S460'), receiver = seed.user('گیرنده S460')
for (const id of [giver, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager460!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager460!' })
for (const [id, temp, final] of [[giver, 'GiverTemp460!', 'GiverFinal460!'], [receiver, 'RecvTemp460!', 'RecvFinal460!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager460!', reason: 'صدور رمز برای مجوز تحویل میان‌روز' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
const workflow = async (enabled) => settingsService.saveCustodySchedulingWorkflow({
  shift: { ...await settingsService.shiftConfig(), custodyMode: 'SINGLE_SHIFT',
    singleShiftCustodianUserId: giver, singleShiftAllowMidDayHandover: enabled },
  reason: 'تصمیم مستند مدیر دربارهٔ مجوز تحویل میان‌روز تک‌شیفت',
  managerUserId: manager, managerPassword: 'Manager460!'
})
await workflow(false)
const shift = await custodyService.open({ userId: giver, password: 'GiverFinal460!', operationalTotal: 7_000 })
const start = (id, pin, key, to = receiver) => custodyService.handoverStart({
  password: pin, operationalTotal: 7_000, toUserId: to,
  blueReference: true, idempotencyKey: key
})
await fails('default-deny single shift refuses midday', 'MIDDAY_HANDOVER_DISABLED', () => start(giver, 'GiverFinal460!', 's460-denied'))
await fails('same-person blue cannot bypass the single-shift policy', 'MIDDAY_HANDOVER_DISABLED', () => start(giver, 'GiverFinal460!', 's460-self', giver))
eq('denied handover writes no count/event/Shift', [seed.count('CustodyHandover'), seed.count('Shift')], [0, 1])
const beforeEpoch = seed.one('SELECT epoch FROM "CustodyState" WHERE key=?', 'MAIN').epoch
await workflow(true)
eq('manager PIN workflow keeps actual custodian and freezes/resumes the state',
  [seed.one('SELECT state,activeShiftId,epoch FROM "CustodyState" WHERE key=?', 'MAIN').state,
    seed.one('SELECT activeShiftId FROM "CustodyState" WHERE key=?', 'MAIN').activeShiftId,
    seed.one('SELECT epoch FROM "CustodyState" WHERE key=?', 'MAIN').epoch], ['ACTIVE', shift.shiftId, beforeEpoch + 2])
eq('single-shift grant event is scoped to this live Shift',
  seed.one('SELECT shiftId FROM "CustodyEvent" WHERE type=?', 'CUSTODY_SINGLE_MIDDAY_GRANTED')?.shiftId, shift.shiftId)
await workflow(false)
eq('switching future policy off cannot delete the append-only active grant',
  seed.count('CustodyEvent', 'type=?', 'CUSTODY_SINGLE_MIDDAY_GRANTED'), 1)
const started = await start(giver, 'GiverFinal460!', 's460-granted')
eq('MIDDAY start records specific manager workflow source', JSON.parse(seed.one('SELECT ledgerWatermark FROM "CustodyHandover" WHERE id=?', started.id).ledgerWatermark).midDayPolicySource, 'MANAGER_WORKFLOW')
await custodyService.handoverCountBlue({ handoverId: started.id, password: 'RecvFinal460!', operationalTotal: 7_000 })
const finished = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'RecvFinal460!' })
eq('receiver, not the manager, now owns the next segment', seed.one('SELECT custodianUserId FROM "CustodyShiftMeta" WHERE shiftId=?', finished.shiftId)?.custodianUserId, receiver)
eq('original snapshot was not rewritten by workflow or receipt', JSON.parse(seed.one('SELECT scheduleSnapshotJson FROM "CustodyShiftMeta" WHERE shiftId=?', shift.shiftId).scheduleSnapshotJson).allowMidDayHandover, false)
// The already-granted ongoing permission must survive the transfer even though
// future settings are off; a new independent opening after final close will not.
const repeat = await start(receiver, 'RecvFinal460!', 's460-inherited', giver)
eq('continued MIDDAY segment inherits its durable positive grant', JSON.parse(seed.one('SELECT ledgerWatermark FROM "CustodyHandover" WHERE id=?', repeat.id).ledgerWatermark).midDayPolicySource, 'SEGMENT_SNAPSHOT')
console.log(`\n✓ ${checks} single-shift MIDDAY permission checks passed`)
