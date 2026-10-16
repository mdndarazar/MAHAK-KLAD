/** A corrupt frozen legacy pointer is NOT a normal interruption eligible
 * for resetShift/emergency cover. Quarantine it on its own Shift, honor the
 * actual cutover, then let the manager document a separate fresh count. The
 * old handover (and its fake status injected in this temporary test DB) is
 * never promoted into a real accepted transfer or a Cash Closing event.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s441-corrupt-frozen-pointer-manager-fallback.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-corrupt-frozen-s441-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, code, action) {
  await assert.rejects(action, (error) => error?.code === code, label)
  checks++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر بررسی S441'), old = seed.user('صندوقدار قدیمی S441'), replacement = seed.user('صندوقدار تازه S441')
for (const id of [old, replacement]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager441!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager441!' })
for (const [id, temp, final] of [[old, 'OldTemp441!', 'OldFinal441!'], [replacement, 'NewTemp441!', 'NewFinal441!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager441!', reason: 'PIN واقعی برای آزمون pointer خراب' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: old, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager441!', reason: 'اجازهٔ تحویل آزمون اشاره‌گر قدیمیِ خراب' })
const originalShift = await custodyService.open({ userId: old, password: 'OldFinal441!', countedCash: 10 })
const handover = await custodyService.handoverStart({ password: 'OldFinal441!', operationalTotal: 10,
  toUserId: replacement, idempotencyKey: 's441-original' })
const originalOut = seed.one('SELECT id,countedCash FROM "CustodyCount" WHERE id=?', seed.one('SELECT outCountId FROM "CustodyHandover" WHERE id=?', handover.id).outCountId)
// The pointer claims an unfinished frozen acceptance, but the attempt claims
// completion without its actual receiver count, new Shift or commit event.
sql.prepare('UPDATE "CustodyHandover" SET status=? WHERE id=?').run('COMPLETED', handover.id)
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
const cutoff = new Date(Date.now() + 60_000)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(cutoff.toISOString(), originalShift.shiftId)
const status = await custodyService.status()
const bad = seed.one('SELECT * FROM "CustodyEvidenceQuarantine" ORDER BY id DESC LIMIT 1')
eq('corrupt linked pointer is quarantined on the valid underlying Shift',
  [status.state, status.evidenceQuarantined, bad.reasonCode, bad.shiftId, bad.handoverId],
  ['EVIDENCE_QUARANTINED', true, 'PENDING_HANDOVER_LINK_INVALID', originalShift.shiftId, handover.id])
await rejects('cashier cannot take over a corrupt pointer', 'CUSTODY_EVIDENCE_QUARANTINED',
  () => custodyService.emergencyCover({ userId: replacement, password: 'NewFinal441!', operationalTotal: 10,
    reason: 'شمارش تازه هست ولی سند پیوند قدیمی خراب است.' }))
await rejects('the old resetShift is NOT a recovery route for corrupt evidence', 'CUSTODY_EVIDENCE_QUARANTINED',
  () => custodyService.resetShift({ managerUserId: manager, password: 'Manager441!', confirmed: true,
    reason: 'نباید سند قدیمی با ریست پنهان شود' }))
eq('failed attempts never rewrite count, owner or completed row',
  [seed.count('Shift'), seed.one('SELECT id,countedCash FROM "CustodyCount" WHERE id=?', originalOut.id), seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', handover.id).status],
  [1, originalOut, 'COMPLETED'])
await custodyService.ensureRolledOver(cutoff)
const state = seed.one('SELECT state,activeShiftId,epoch FROM "CustodyState" WHERE key=?', 'MAIN')
eq('cutover closes precisely the actual Shift; quarantine remains linked to it',
  [state.state, state.activeShiftId, bad.shiftId, new Date(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', originalShift.shiftId).closedAt).getTime()],
  ['NO_SESSION', null, originalShift.shiftId, cutoff.getTime()])
await rejects('new independent opening waits for manager evidence review', 'CUSTODY_EVIDENCE_QUARANTINED',
  () => custodyService.open({ userId: replacement, password: 'NewFinal441!', operationalTotal: 0,
    note: 'صندوق را پس از تعیین تکلیف مدیر خودم شمارش کردم.' }))
const recovery = await custodyService.managerEvidenceRecovery({ caseId: bad.id,
  managerUserId: manager, password: 'Manager441!', operationalTotal: 0,
  reason: 'سند پیوند خراب جدا بررسی و کشو دوباره شخصاً شمرده شد', seenEpoch: state.epoch,
  idempotencyKey: 's441:manager-evidence-recovery' })
eq('manager documents fresh physical zero without a fake night close',
  [recovery.outcome, seed.one('SELECT state FROM "CustodyState" WHERE key=?', 'MAIN').state,
    seed.count('CustodyBlueSnapshot', 'shiftId=?', originalShift.shiftId), seed.count('CashSession')],
  ['CLOSED_SHIFT_DOCUMENTED', 'NO_SESSION', 0, 0])
eq('original aggregate attempt remains an untrustworthy, unchanged claim',
  [seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', handover.id).status,
    seed.count('CustodyEvent', 'type=? AND handoverId=?', 'HANDOVER_ACCEPT', handover.id)], ['COMPLETED', 0])
const next = await custodyService.open({ userId: replacement, password: 'NewFinal441!', operationalTotal: 0,
  note: 'پس از بررسی مدیر، صندوق امروز را مستقلاً شمردم.' })
eq('new cashier independently opens a different Shift with their own PIN/count',
  [seed.one('SELECT userId FROM "Shift" WHERE id=?', next.shiftId).userId, seed.count('Shift'),
    seed.count('CustodyEvidenceRecovery', 'quarantineId=?', bad.id)],
  [replacement, 2, 1])
console.log(`\n✓ ${checks} corrupt-pointer quarantine checks passed`)
