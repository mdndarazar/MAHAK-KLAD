/** Old V2 attempts with an invalid startedAt are NOT granted a fresh ten
 * minutes, and a foreign pending pointer cannot retire another Shift's
 * handover on real rollover. Disposable harness DB only.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s463-old-deadline-and-foreign-pointer-quarantine.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-v2-foreign-quarantine-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر V2 ناقص'), first = seed.user('اول'), second = seed.user('دوم')
for (const id of [first, second]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
let checks = 0
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log(`  ✓ ${name}`) }
const fail = async (name, code, fn) => { await assert.rejects(fn, (e) => e?.code === code, name); checks++; console.log(`  ✓ ${name}`) }
const live = () => seed.one('SELECT state, activeShiftId, pendingHandoverId, epoch FROM "CustodyState" WHERE key=?', 'MAIN')
const recover = (id, key) => custodyService.managerEvidenceRecovery({ caseId: id,
  managerUserId: manager, password: 'Manager463!', operationalTotal: 2020,
  reason: 'بازیابی مستقل و شمارش واقعی مدیر بدون شاهد خراب پیشین', seenEpoch: live().epoch,
  idempotencyKey: key })
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager463!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager463!' })
for (const [id, temp, pin] of [[first, 'First463Temp!', 'First463Final!'], [second, 'Second463Temp!', 'Second463Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager463!', reason: 'PIN سنجش شروع نامعتبر' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager463!', reason: 'مجوز تحویل میان‌روز برای آزمون pointer' })
const opened = await custodyService.open({ userId: first, password: 'First463Final!', operationalTotal: 2000 })
const old = await custodyService.handoverStart({ password: 'First463Final!', operationalTotal: 2000,
  toUserId: second, blueReference: true, idempotencyKey: 's463-old-v2-invalid-startedAt' })
// A pre-deadline attempt must use original startedAt + 10, never today's
// policy. Here it is not a date at all: there is no lawful deadline to derive.
sql.prepare('UPDATE "CustodyHandover" SET startedAt=?, protocolVersion=NULL, deadlineAt=NULL, deadlinePolicyMinutes=NULL WHERE id=?').run('not-a-date', old.id)
await custodyService.ensureRolledOver()
const bad = seed.one('SELECT * FROM "CustodyEvidenceQuarantine" ORDER BY id DESC LIMIT 1')
eq('invalid V2 startedAt creates a durable case without expiring or closing Shift',
  [bad.reasonCode, bad.shiftId, bad.handoverId, live().state,
    seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', old.id).status,
    seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt],
  ['HANDOVER_STARTED_AT_INVALID', opened.shiftId, old.id, 'EVIDENCE_QUARANTINED', 'PENDING', null])
await fail('old handover cannot be confirmed, regardless of clock or PIN', 'BLUE_NOT_COUNTED', () => custodyService.handoverConfirmBlue({ handoverId: old.id, password: 'Second463Final!' }))
const status = await custodyService.status()
eq('public status contains no corrupted pending amount/deadline', [status.evidenceQuarantined, status.pendingHandover], [true, null])
const result = await recover(bad.id, 's463-manager-recovery-old-v2')
eq('active recovery retires ONLY its own incomplete handover with CAS', [result.outcome, live().state,
  live().pendingHandoverId, seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', old.id).status,
  seed.count('CustodyBlueSnapshot', 'handoverId=?', old.id)],
  ['ACTIVE_FRESH_WITNESS', 'ACTIVE', null, 'EVIDENCE_QUARANTINED', 1])
const transfer = await custodyService.handoverStart({ password: 'First463Final!', operationalTotal: 2000,
  toUserId: second, blueReference: true, idempotencyKey: 's463-genuine-next-shift' })
await custodyService.handoverCountBlue({ handoverId: transfer.id, password: 'Second463Final!', operationalTotal: 2000 })
const next = await custodyService.handoverConfirmBlue({ handoverId: transfer.id, password: 'Second463Final!' })
eq('fresh unrelated transfer makes a real new Shift', [live().state, live().activeShiftId, next.shiftId > opened.shiftId], ['ACTIVE', next.shiftId, true])
// Deliberately corrupt ONLY the state pointer; it now points to a handover
// from another Shift. The foreign row must not be modified by recovery/expiry.
const foreignBefore = seed.one('SELECT status,version,fromShiftId FROM "CustodyHandover" WHERE id=?', old.id)
sql.prepare('UPDATE "CustodyState" SET state=?, pendingHandoverId=? WHERE key=?').run('HANDOVER_PENDING', old.id, 'MAIN')
await fail('foreign pointer fences sales and records the correct Shift case', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.actorForFinancialOperation())
const case2 = seed.one('SELECT * FROM "CustodyEvidenceQuarantine" ORDER BY id DESC LIMIT 1')
eq('case remains anchored to Shift AFTER transfer, not the foreign source', [case2.reasonCode, case2.shiftId, case2.handoverId, case2.snapshotId], ['PENDING_HANDOVER_LINK_INVALID', next.shiftId, old.id, null])
const cutoff = new Date(Date.now() + 60_000)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(cutoff.toISOString(), next.shiftId)
await custodyService.ensureRolledOver(cutoff)
eq('real rollover closes the current Shift while preserving foreign handover bytes',
  [live().state, live().activeShiftId,
    seed.one('SELECT status,version,fromShiftId FROM "CustodyHandover" WHERE id=?', old.id),
    new Date(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', next.shiftId).closedAt).getTime()],
  ['NO_SESSION', null, foreignBefore, cutoff.getTime()])
eq('rollover makes no fake completed transfer or final close', [seed.count('CustodyEvent', 'type=? AND shiftId=?', 'BLUE_FINAL_CLOSE_COMMITTED', next.shiftId), seed.count('CashSession')], [0, 0])
const proof = await recover(case2.id, 's463-manager-recovery-foreign-pointer')
eq('closed foreign pointer case is documented without editing either Shift', [proof.outcome, live().state, seed.count('CustodyBlueSnapshot', 'shiftId=? AND role=?', next.shiftId, 'RECOVERY')], ['CLOSED_SHIFT_DOCUMENTED', 'NO_SESSION', 0])
console.log(`\n✓ ${checks} V2 deadline and foreign-pointer checks passed`)
