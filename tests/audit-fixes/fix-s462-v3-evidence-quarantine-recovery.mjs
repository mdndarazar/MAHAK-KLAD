/** V3 seals the real writer, fences corrupt evidence, documents a fresh manager
 * count independently of resetShift, and never turns a rollover into a fake
 * close. Corruption is injected ONLY into this disposable harness database.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s462-v3-evidence-quarantine-recovery.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-v3-quarantine-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { blueEvidenceFault } = await import('../../src/main/services/CustodyBlueIntegrity.ts')
const { cashClosingHistoryService } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { notePanelUnlocked, runWithPanelSessionOwner } = await import('../../src/main/services/panelSession.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر سند V3'), first = seed.user('مسئول قبلی V3'), second = seed.user('مسئول بعدی V3')
for (const id of [first, second]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
let checks = 0
const eq = (label, got, want) => { assert.deepEqual(got, want, label); checks++; console.log(`  ✓ ${label}`) }
const fails = async (label, code, fn) => { await assert.rejects(fn, (err) => err?.code === code, label); checks++; console.log(`  ✓ ${label}`) }
const owner = (fn) => runWithPanelSessionOwner(462, fn)
const state = () => seed.one('SELECT state, activeShiftId, pendingHandoverId, epoch FROM "CustodyState" WHERE key=?', 'MAIN')
// Only disposable test DBs drop this trigger for fault injection; live V3 rows
// remain append-only and the original corruption itself is evidence.
const trigger = sql.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'custody_blue_snapshot_no_update').sql
const corrupt = (id, column, value) => {
  sql.exec('DROP TRIGGER custody_blue_snapshot_no_update')
  try { sql.prepare(`UPDATE "CustodyBlueSnapshot" SET "${column}"=? WHERE id=?`).run(value, id) }
  finally { sql.exec(trigger) }
}
const recover = (caseId, epoch, amount, key = `s462:case:${caseId}:manager-count`) => custodyService.managerEvidenceRecovery({
  caseId, managerUserId: manager, password: 'Manager462!', operationalTotal: amount,
  reason: 'بازیابی مستقل مدیر با شمارش تازه و حفظ کامل سند اصلی', seenEpoch: epoch, idempotencyKey: key
})
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager462!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager462!' })
for (const [id, temp, pin] of [[first, 'First462Temp!', 'First462Final!'], [second, 'Second462Temp!', 'Second462Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager462!', reason: 'تنظیم PIN برای آزمون شاهد v3' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager462!', reason: 'مجوز تحویل میان‌روز در آزمایش سند V3' })
const opened = await custodyService.open({ userId: first, password: 'First462Final!', operationalTotal: 1200 })
const opening = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING')
eq('healthy real opening is V3 with a valid digest', [opening.calculationVersion, blueEvidenceFault(opening)], ['sales-blue-v3', null])
const started = await custodyService.handoverStart({ password: 'First462Final!', operationalTotal: 1200,
  toUserId: second, blueReference: true, idempotencyKey: 's462:healthy-handover' })
await custodyService.handoverCountBlue({ handoverId: started.id, password: 'Second462Final!', operationalTotal: 1200 })
const committed = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'Second462Final!' })
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN')
eq('the completed IN still carries its own sealed original amount', [incoming.calculationVersion, blueEvidenceFault(incoming), incoming.priorSnapshotId != null], ['sales-blue-v3', null, true])
eq('healthy new owner is allowed financial writes', (await custodyService.actorForFinancialOperation()).expectedShiftId, committed.shiftId)
owner(() => notePanelUnlocked('__manager__', 'MANAGER'))
const day = toJalaliDate(new Date())
const history = () => owner(() => cashClosingHistoryService.query({ fromJalali: day, toJalali: day }))
const before = await history()
eq('F10 classifies genuine signed V3 as V3, not V2', [before.rows.find((row) => row.handoverId === started.id)?.reference.state, before.totals.amountKnownV3], ['KNOWN_V3', 1])

corrupt(incoming.id, 'referenceToDay', '1400/13/99')
eq('an invalid calendar/domain cannot be called pending money', blueEvidenceFault(await db.custodyBlueSnapshot.findUnique({ where: { id: incoming.id } })), 'BLUE_SCOPE_INVALID')
const eventBeforeF10 = seed.count('CustodyEvent')
const invalid = await history()
eq('F10 skips forged completion amount and flags its preserved witness', [invalid.rows.some((row) => row.handoverId === started.id), invalid.totals.amountInconsistent, invalid.totals.handovers], [false, 1, 0])
eq('F10 reads no status and makes no rollover/quarantine event', seed.count('CustodyEvent'), eventBeforeF10)
await fails('a financial writer must fail closed and first record a durable case', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.actorForFinancialOperation())
const quarantined = state()
eq('the SAME real Shift is quarantined, with one new epoch', [quarantined.state, quarantined.activeShiftId, quarantined.epoch], ['EVIDENCE_QUARANTINED', committed.shiftId, 4])
const firstCase = seed.one('SELECT * FROM "CustodyEvidenceQuarantine" ORDER BY id DESC LIMIT 1')
eq('case stays linked to its original IN and current Shift', [firstCase.shiftId, firstCase.handoverId, firstCase.snapshotId, firstCase.reasonCode],
  [committed.shiftId, started.id, incoming.id, 'BLUE_SCOPE_INVALID'])
const timeline = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager462!',
  from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })
const red = timeline.handovers.find((row) => row.id === started.id)?.blue
eq('manager report masks EVERY claim from the corrupt OUT/IN pair and counts quarantine separately',
  [red?.status, red?.originalReferenceAmount, red?.outgoing?.referenceAmount,
    red?.incoming?.referenceAmount, red?.rawDifference,
    timeline.summary.blueHandoversAwaitingReference, timeline.summary.blueHandoversQuarantined],
  ['EVIDENCE_QUARANTINED', null, null, null, null, 0, 1])
await fails('resetShift cannot bypass a broken V3 witness', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.resetShift({ managerUserId: manager, password: 'Manager462!', confirmed: true, reason: 'تلاش برای ریست سند ناسازگار' }))
await fails('new open cannot bypass an active corrupt Shift', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.open({ userId: first, password: 'First462Final!', operationalTotal: 1000 }))
const noSession = owner(() => custodyService.evidenceCases())
const inventory = await noSession
eq('manager case list keeps an untrusted original claim', [inventory.rows[0].id, inventory.rows[0].originalClaim.referenceAmount, inventory.rows[0].active], [firstCase.id, String(incoming.referenceAmount), true])
// Exercise the actual manager IPC boundary, not just the service: a different
// renderer window must authenticate its own manager session. The same PIN
// proof is required again for the individual chosen manager.
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 465, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload = {}) => handlers.get(channel)({ sender }, payload)
const financialBefore = [seed.count('SaleInvoice'), seed.count('Payment'), seed.count('CashMovement')]
const blockedSale = await invoke(IPC.saleCreate, { userId: second, shiftId: committed.shiftId, lines: [], payments: [] })
eq('actual IPC sale writer rejects corrupt evidence, even with a forged owner',
  [blockedSale.ok, blockedSale.code], [false, 'CUSTODY_EVIDENCE_QUARANTINED'])
const request = { caseId: firstCase.id, managerUserId: manager, password: 'Manager462!',
  operationalTotal: 1300, reason: 'بازیابی مستقل مدیر با شمارش تازه و حفظ کامل سند اصلی',
  seenEpoch: quarantined.epoch, idempotencyKey: `s462:case:${firstCase.id}:manager-count` }
eq('a second window cannot list manager evidence without its own session', (await invoke(IPC.custodyEvidenceCases, { skip: 0 })).ok, false)
eq('a second window cannot recover with a PIN but no manager session', (await invoke(IPC.custodyManagerEvidenceRecovery, request)).ok, false)
eq('manager authenticates the second window explicitly', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
const blockedCash = await invoke(IPC.cashboxMovementAdd, { userId: second, shiftId: committed.shiftId,
  type: 'DEPOSIT', amount: 100, description: 'نباید روی سند خراب وارد شود' })
eq('unlocked manual cash writer ALSO rejects the quarantined Shift',
  [blockedCash.ok, blockedCash.code], [false, 'CUSTODY_EVIDENCE_QUARANTINED'])
eq('rejected money operations write no sale, payment or cash movement',
  [seed.count('SaleInvoice'), seed.count('Payment'), seed.count('CashMovement')], financialBefore)
const viaIpc = await invoke(IPC.custodyEvidenceCases, { skip: 0 })
eq('authenticated IPC inventory is the same durable case and epoch', [viaIpc.ok, viaIpc.data.rows[0].id, viaIpc.data.seenEpoch], [true, firstCase.id, quarantined.epoch])
eq('wrong personal manager PIN is still rejected after manager login',
  (await invoke(IPC.custodyManagerEvidenceRecovery, { ...request, password: 'wrong' })).ok, false)
await fails('wrong manager PIN never recovers the broken chain', 'PIN_WRONG', () => custodyService.managerEvidenceRecovery({ ...request, password: 'wrong', idempotencyKey: 's462:bad-pin-recovery' }))
await fails('stale epoch cannot revive a corrupted chain', 'CUSTODY_STALE', () => recover(firstCase.id, quarantined.epoch - 1, 1300, 's462-stale-epoch'))
const recoveredViaIpc = await invoke(IPC.custodyManagerEvidenceRecovery, request)
eq('IPC dispatch commits the manager decision with a real count', [recoveredViaIpc.ok, recoveredViaIpc.data?.outcome], [true, 'ACTIVE_FRESH_WITNESS'])
const restored = recoveredViaIpc.data
eq('manager recovery stays on same Shift, not a fake transfer/close', [restored.outcome, state().state, state().activeShiftId, seed.count('Shift')], ['ACTIVE_FRESH_WITNESS', 'ACTIVE', committed.shiftId, 2])
const recovery = seed.one('SELECT * FROM "CustodyEvidenceRecovery" WHERE quarantineId=?', firstCase.id)
const fresh = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE id=?', recovery.recoverySnapshotId)
eq('fresh manager RECOVERY has its own count, no corrupt prior link', [fresh.actorUserId, fresh.authMethod, fresh.handoverId, fresh.priorSnapshotId, Number(fresh.humanAmount), blueEvidenceFault(fresh)], [manager, 'MANAGER_CUSTODY_PIN', null, null, 1300, null])
eq('the original corrupted IN is not rewritten during recovery', seed.one('SELECT referenceToDay FROM "CustodyBlueSnapshot" WHERE id=?', incoming.id).referenceToDay, '1400/13/99')
eq('sale can resume only after a new independent witness', (await custodyService.actorForFinancialOperation()).expectedShiftId, committed.shiftId)
eq('same request replays exactly one append-only recovery', [(await recover(firstCase.id, quarantined.epoch, 1300)).replayed, seed.count('CustodyEvidenceRecovery')], [true, 1])
await fails('same idempotency key with a different count is rejected', 'CUSTODY_EVIDENCE_KEY_REUSED', () => recover(firstCase.id, quarantined.epoch, 1400))
for (const table of ['CustodyEvidenceQuarantine', 'CustodyEvidenceRecovery']) {
  assert.throws(() => sql.exec(`DELETE FROM "${table}" WHERE id=1`), /append-only/); checks++
}
eq('both case and decision are append-only', seed.count('CustodyEvidenceRecovery'), 1)

// A second fault AFTER documented recovery must create a fresh case, not reuse
// the settled source key. The real day boundary still wins and closes only the
// current actual Shift at its stored cutoff.
corrupt(fresh.id, 'sourceHash', 'f'.repeat(64))
const cutoff = new Date(Date.now() + 3 * 60_000)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(cutoff.toISOString(), committed.shiftId)
const result = await custodyService.ensureRolledOver(cutoff)
const secondCase = seed.one('SELECT * FROM "CustodyEvidenceQuarantine" ORDER BY id DESC LIMIT 1')
eq('new epoch produces a distinct case for subsequent corruption', [seed.count('CustodyEvidenceQuarantine'), secondCase.shiftId, secondCase.snapshotId, secondCase.reasonCode], [2, committed.shiftId, fresh.id, 'BLUE_DIGEST_INVALID'])
eq('actual cutoff is not delayed by an open case', [state().state, state().activeShiftId, result.shiftId,
  new Date(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', committed.shiftId).closedAt).getTime()],
  ['NO_SESSION', null, committed.shiftId, cutoff.getTime()])
const night = seed.one('SELECT * FROM "CustodyResolution" WHERE shiftId=?', committed.shiftId)
eq('night remains unresolved without a synthetic F10/final close or expected amount', [night.status, night.evidence, night.nightExpectedCash, seed.count('CashSession')], ['OPEN', 'EVIDENCE_QUARANTINED', null, 0])
await fails('open after rollover waits for the separate manager case', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.open({ userId: first, password: 'First462Final!', operationalTotal: 900 }))
await fails('the old night cannot be resolved via a fake final close', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.resolveUnresolved({ resolutionId: night.id, managerUserId: manager, managerPassword: 'Manager462!', reason: 'ثبت شب با سند ناسازگار ممنوع است' }))
await fails('reset cannot silently clear the post-rollover case', 'CUSTODY_EVIDENCE_QUARANTINED', () => custodyService.resetShift({ managerUserId: manager, password: 'Manager462!', confirmed: true, reason: 'ریست اشتباه پرونده قرنطینه' }))
const closedBefore = { shifts: seed.count('Shift'), blue: seed.count('CustodyBlueSnapshot'), counts: seed.count('CustodyCount') }
const documented = await recover(secondCase.id, state().epoch, 1550)
eq('post-rollover manager only documents a present count, leaving NO_SESSION', [documented.outcome, state().state, seed.count('Shift')], ['CLOSED_SHIFT_DOCUMENTED', 'NO_SESSION', closedBefore.shifts])
eq('closed old Shift got no fabricated count or blue snapshot', [seed.count('CustodyBlueSnapshot'), seed.count('CustodyCount'), seed.one('SELECT recoverySnapshotId FROM "CustodyEvidenceRecovery" WHERE quarantineId=?', secondCase.id).recoverySnapshotId], [closedBefore.blue, closedBefore.counts, null])
eq('night is recorded as evidence recovered, not FINAL_CLOSE', [seed.one('SELECT status, cashSessionId, nightExpectedCash FROM "CustodyResolution" WHERE id=?', night.id).status,
  seed.one('SELECT endKind FROM "CustodyShiftMeta" WHERE shiftId=?', committed.shiftId).endKind], ['EVIDENCE_RECOVERED', 'EVIDENCE_QUARANTINED_ROLLOVER'])
const next = await custodyService.open({ userId: first, password: 'First462Final!', operationalTotal: 1600 })
eq('new worker independently opens a distinct Shift with personal PIN/count', [next.shiftId > committed.shiftId, seed.one('SELECT role, actorUserId, humanAmount, priorSnapshotId FROM "CustodyBlueSnapshot" WHERE shiftId=?', next.shiftId).role], [true, 'OPENING'])
eq('new Shift did not inherit the manager case count', seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', next.shiftId, 'OPENING').humanAmount, 1600)
console.log(`\n✓ ${checks} V3 quarantine and recovery checks passed`)
