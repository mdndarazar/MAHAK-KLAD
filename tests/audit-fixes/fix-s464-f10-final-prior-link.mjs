/** A real V3 FINAL_CLOSE can only use its own valid earlier OPENING or the
 * completed IN from which this Shift came. F10 reads saved amounts, never
 * invents a close, and must fetch a prior outside the selected event window.
 * Deliberate tampering below is confined to the disposable harness DB.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s464-f10-final-prior-link.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-f10-prior-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { blueEvidenceFault, blueEvidenceDigest } = await import('../../src/main/services/CustodyBlueIntegrity.ts')
const { cashClosingHistoryService } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { toJalaliDate, jalaliStartOfDay } = await import('@shared/jalali')
const { notePanelUnlocked, runWithPanelSessionOwner } = await import('../../src/main/services/panelSession.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر F10 prior'), first = seed.user('اول F10'), second = seed.user('دوم F10')
for (const id of [first, second]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
let checks = 0
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log(`  ✓ ${name}`) }
const view = (fn) => runWithPanelSessionOwner(464, fn)
const trigger = sql.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'custody_blue_snapshot_no_update').sql
const alter = (id, patch) => {
  sql.exec('DROP TRIGGER custody_blue_snapshot_no_update')
  try {
    for (const [column, value] of Object.entries(patch)) {
      if (!/^[a-zA-Z]+$/.test(column)) throw new Error('unsafe test column')
      sql.prepare(`UPDATE "CustodyBlueSnapshot" SET "${column}"=? WHERE id=?`).run(value, id)
    }
  } finally { sql.exec(trigger) }
}
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager464!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager464!' })
for (const [id, tmp, pin] of [[first, 'First464Temp!', 'First464Final!'], [second, 'Second464Temp!', 'Second464Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: tmp, managerUserId: manager, managerPassword: 'Manager464!', reason: 'آزمون F10 پیوند prior' })
  await custodyService.setPin({ userId: id, currentPassword: tmp, newPassword: pin })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager464!', reason: 'اجازهٔ تحویل میان‌روز برای آزمون prior F10' })
const startedDay = toJalaliDate(new Date())
const firstShift = await custodyService.open({ userId: first, password: 'First464Final!', operationalTotal: 1000 })
const attempt = await custodyService.handoverStart({ password: 'First464Final!', operationalTotal: 1000,
  toUserId: second, blueReference: true, idempotencyKey: 's464:real-handover' })
await custodyService.handoverCountBlue({ handoverId: attempt.id, password: 'Second464Final!', operationalTotal: 1000 })
const secondShift = await custodyService.handoverConfirmBlue({ handoverId: attempt.id, password: 'Second464Final!' })
const outgoing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', attempt.id, 'OUT')
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', attempt.id, 'IN')
await custodyService.finalClose({ password: 'Second464Final!', operationalTotal: 900 })
const final = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', secondShift.shiftId, 'FINAL_CLOSE')
eq('real final close inherits actual completed IN, not a fabricated baseline',
  [final.priorSnapshotId, Number(final.referenceAmount), Number(final.freshDifference), blueEvidenceFault(final)],
  [incoming.id, 0, -100, null])
view(() => notePanelUnlocked('__manager__', 'MANAGER'))
const history = () => view(() => cashClosingHistoryService.query({ fromJalali: startedDay, toJalali: startedDay }))
const intact = await history()
eq('two genuine signed V3 outcomes appear, with the frozen close amount',
  [intact.totals.handovers, intact.totals.custodyFinalClosings, intact.rows.find((row) => row.kind === 'FINAL_CLOSE')?.reference.amount],
  [1, 1, 0])
const eventCount = seed.count('CustodyEvent')
// Preserve the value and v3 signature of FINAL_CLOSE itself. Break ONLY the
// OUT underpinning its linked IN, so validating FINAL_CLOSE must traverse the
// actual completed handover chain instead of accepting an isolated IN digest.
alter(outgoing.id, { sourceHash: 'f'.repeat(64) })
const invalidPair = await history()
eq('corrupt OUT hides both transfer and dependent final close',
  [invalidPair.totals.handovers, invalidPair.totals.custodyFinalClosings, invalidPair.totals.amountInconsistent],
  [0, 0, 2])
const restoredOut = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE id=?', outgoing.id)
alter(outgoing.id, { sourceHash: outgoing.sourceHash })
eq('restoring unchanged original witness returns both genuine events',
  [(await history()).totals.handovers, (await history()).totals.custodyFinalClosings], [1, 1])
// Now change FINAL_CLOSE's pointer to a healthy V3 OPENING on an UNRELATED
// later Shift, and reseal its digest. Digest integrity alone must not permit
// cross-Shift borrowing of a prior count or laundering a fresh difference.
const next = await custodyService.open({ userId: first, password: 'First464Final!', operationalTotal: 1100 })
const unrelated = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', next.shiftId, 'OPENING')
const forged = { ...final, priorSnapshotId: unrelated.id }
alter(final.id, { priorSnapshotId: unrelated.id, evidenceDigest: blueEvidenceDigest(forged) })
const afterIndependentOpen = seed.count('CustodyEvent')
eq('recomputed digest alone cannot prove a prior from a foreign Shift', blueEvidenceFault(await db.custodyBlueSnapshot.findUnique({ where: { id: final.id } })), null)
const badLink = await history()
eq('F10 preserves real handover but never displays foreign-prior final close',
  [badLink.totals.handovers, badLink.totals.custodyFinalClosings, badLink.totals.amountInconsistent, badLink.rows.some((row) => row.reference.snapshotId === final.id)],
  [1, 0, 1, false])
eq('F10 validation makes no fake close/count/rollover event', seed.count('CustodyEvent'), afterIndependentOpen)
eq('only the independent OPEN added an actual event before this F10 read', afterIndependentOpen > eventCount, true)
// An isolated valid FINAL_CLOSE outside the handover event's F10 date range
// still needs the original IN and OUT fetched within the same read snapshot.
alter(final.id, { priorSnapshotId: incoming.id, evidenceDigest: final.evidenceDigest })
const handoverEvent = seed.one('SELECT id FROM "CustodyEvent" WHERE type=? AND handoverId=?', 'BLUE_HANDOVER_COMMITTED', attempt.id)
const previousDay = new Date(jalaliStartOfDay(startedDay).getTime() - 60_000)
sql.prepare('UPDATE "CustodyEvent" SET at=? WHERE id=?').run(previousDay.toISOString(), handoverEvent.id)
const finalOnly = await history()
eq('F10 validates an older IN/OUT pair even when its event is outside the filtered day',
  [finalOnly.totals.handovers, finalOnly.totals.custodyFinalClosings, finalOnly.rows.find((row) => row.kind === 'FINAL_CLOSE')?.reference.state],
  [0, 1, 'KNOWN_V3'])
alter(outgoing.id, { sourceHash: 'e'.repeat(64) })
const invalidOutOfRange = await history()
eq('off-page prior corruption hides FINAL_CLOSE amount rather than guessing zero',
  [invalidOutOfRange.totals.handovers, invalidOutOfRange.totals.custodyFinalClosings, invalidOutOfRange.totals.amountInconsistent],
  [0, 0, 1])
eq('original OUT and old responsibility remain independently inspectable',
  [restoredOut.id, seed.one('SELECT userId FROM "Shift" WHERE id=?', firstShift.shiftId).userId],
  [outgoing.id, first])
console.log(`\n✓ ${checks} F10 final-prior checks passed`)
