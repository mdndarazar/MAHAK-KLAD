/** Persisted OUT deadline, V2 fallback, equal-time rollover precedence and
 * uninterrupted sales ownership when only a handover attempt expires.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s461-persistent-handover-deadline.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-handover-deadline-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { parseCustodyConfig } = await import('@shared/receipt')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر مهلت S461'), giver = seed.user('صندوقدار S461'), receiver = seed.user('گیرنده S461')
for (const id of [giver, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
let checks = 0
const eq = (label, got, expected) => { assert.deepEqual(got, expected, label); checks++; console.log(`  ✓ ${label}`) }
const fail = async (label, fn) => { await assert.rejects(fn, (e) => Boolean(e?.code), label); checks++; console.log(`  ✓ ${label}`) }
const RealDate = Date
const atTime = async (at, run) => {
  const instant = Number(at)
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])) }
    static now() { return instant }
  }
  try { return await run() } finally { globalThis.Date = RealDate }
}
for (const raw of [0, -1, 31, 3.5, 'corrupt', null, {}])
  eq(`malformed TTL ${String(raw)} defaults to exactly ten`, parseCustodyConfig({ handoverTtlMinutes: raw }).handoverTtlMinutes, 10)
eq('valid one and thirty minute policy values are preserved', [1, 30].map((n) => parseCustodyConfig({ handoverTtlMinutes: n }).handoverTtlMinutes), [1, 30])
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager461!' })
await custodyService.setConfig({ config: { enabled: true, handoverTtlMinutes: 1 }, managerUserId: manager, managerPassword: 'Manager461!' })
for (const [id, temp, pin] of [[giver, 'Giver461Temp!', 'Giver461Final!'], [receiver, 'Recv461Temp!', 'Recv461Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager461!', reason: 'رمز آزمون مهلت پایدار' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: giver, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager461!', reason: 'مجوز مستقل تحویل برای سنجش انقضای تلاش' })
const opened = await custodyService.open({ userId: giver, password: 'Giver461Final!', operationalTotal: 1000 })
const farFuture = new RealDate(RealDate.now() + 5 * 3600_000)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(farFuture.toISOString(), opened.shiftId)
const start = (key) => custodyService.handoverStart({ password: 'Giver461Final!',
  operationalTotal: 1000, toUserId: receiver, blueReference: true, idempotencyKey: key })
const first = await start('s461-first-v3')
const row = seed.one('SELECT startedAt,deadlineAt,deadlinePolicyMinutes,protocolVersion FROM "CustodyHandover" WHERE id=?', first.id)
const deadline = new RealDate(row.deadlineAt).getTime()
eq('V3 stores exact Main TTL with OUT in a single row', [row.protocolVersion, row.deadlinePolicyMinutes, deadline - new RealDate(row.startedAt).getTime()], [3, 1, 60_000])
await custodyService.setConfig({ config: { enabled: true, handoverTtlMinutes: 30 }, managerUserId: manager, managerPassword: 'Manager461!' })
await custodyService.handoverCountBlue({ handoverId: first.id, password: 'Recv461Final!', operationalTotal: 1000 })
eq('IN is recorded without extending the persisted deadline',
  [seed.one('SELECT deadlineAt FROM "CustodyHandover" WHERE id=?', first.id).deadlineAt, seed.count('CustodyBlueSnapshot', 'handoverId=?', first.id)], [row.deadlineAt, 2])
const epochBefore = seed.one('SELECT epoch FROM "CustodyState" WHERE key=?', 'MAIN').epoch
// An explicit instant at the deadline behaves like a confirmation that
// happened at that instant, including after a process restart: only DB fields
// (not an in-memory timer or the current setting) govern the outcome.
await atTime(deadline, async () => {
  await fail('confirmation at the exact deadline cannot complete', () => custodyService.handoverConfirmBlue({ handoverId: first.id, password: 'Recv461Final!' }))
})
const state = seed.one('SELECT state,activeShiftId,pendingHandoverId,epoch FROM "CustodyState" WHERE key=?', 'MAIN')
eq('expired ATTEMPT restores ACTIVE with same Shift and epoch CAS', [state.state, state.activeShiftId, state.pendingHandoverId, state.epoch], ['ACTIVE', opened.shiftId, null, epochBefore + 1])
eq('OUT and IN remain immutable while no fabricated handover is completed',
  [seed.one('SELECT status,toShiftId,resolutionKind FROM "CustodyHandover" WHERE id=?', first.id).status,
    seed.count('CustodyBlueSnapshot', 'handoverId=?', first.id), seed.count('Shift'), seed.count('CustodyResolution')], ['EXPIRED', 2, 1, 0])
eq('expiration records exactly one append-only attempt event', seed.count('CustodyEvent', 'type=? AND handoverId=?', 'HANDOVER_ATTEMPT_EXPIRED', first.id), 1)
eq('sales remain attributed to the old worker until actual rollover', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
await fail('old receiver retry cannot resurrect the expired IN', () => custodyService.handoverConfirmBlue({ handoverId: first.id, password: 'Recv461Final!' }))
// Fresh attempt is allowed with NEW OUT and count; neither old OUT nor IN is reused.
const second = await start('s461-second-v3')
eq('fresh OUT uses updated policy without mutating first deadline',
  [seed.one('SELECT deadlinePolicyMinutes FROM "CustodyHandover" WHERE id=?', second.id).deadlinePolicyMinutes,
    seed.one('SELECT deadlineAt FROM "CustodyHandover" WHERE id=?', first.id).deadlineAt], [30, row.deadlineAt])
// A prior V2 pending row has no deadline columns: original startedAt + ten.
const oldStart = new RealDate(RealDate.now() - 9 * 60_000)
sql.prepare('UPDATE "CustodyHandover" SET startedAt=?, deadlineAt=NULL, deadlinePolicyMinutes=NULL, protocolVersion=NULL WHERE id=?').run(oldStart.toISOString(), second.id)
const legacyDeadline = new RealDate(oldStart.getTime() + 10 * 60_000)
await custodyService.ensureRolledOver(new RealDate(legacyDeadline.getTime() - 1))
eq('old V2 attempt remains before startedAt plus ten, not current 30', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', second.id).status, 'PENDING')
await custodyService.ensureRolledOver(legacyDeadline)
eq('old V2 attempt expires exactly at its own original ten-minute boundary', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', second.id).status, 'EXPIRED')
eq('V2 expiry did not close the valid underlying Shift', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt, null)
const third = await start('s461-equal-rollover')
const thirdDeadline = new RealDate(seed.one('SELECT deadlineAt FROM "CustodyHandover" WHERE id=?', third.id).deadlineAt)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(thirdDeadline.toISOString(), opened.shiftId)
await custodyService.ensureRolledOver(thirdDeadline)
eq('at equal deadlines the true Shift rollover wins', [seed.one('SELECT state FROM "CustodyState" WHERE key=?', 'MAIN').state,
  seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', third.id).status,
  seed.count('CustodyEvent', 'type=? AND handoverId=?', 'HANDOVER_ATTEMPT_EXPIRED', third.id)], ['NO_SESSION', 'EXPIRED_UNRESOLVED', 0])
eq('real end is at the stored cutover, not when a later user opened',
  new RealDate(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt).getTime(), thirdDeadline.getTime())
console.log(`\n✓ ${checks} persistent deadline checks passed`)
