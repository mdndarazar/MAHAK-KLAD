/** Optional blue-document notes: personal PIN + window manager login,
 * append-only, replay-safe, no effect on source amounts or F10 counters.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s459-blue-optional-manager-notes.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-note-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { custodyBlueNoteService } = await import('../../src/main/services/CustodyBlueNoteService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { cashClosingHistoryService } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { notePanelUnlocked, runWithPanelSessionOwner, clearPanelSessions } = await import('../../src/main/services/panelSession.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر یادداشت'), first = seed.user('اول'), second = seed.user('دوم')
const owner = (fn) => runWithPanelSessionOwner(459, fn)
const auth = () => owner(() => notePanelUnlocked('__manager__', 'MANAGER'))
let checks = 0
const eq = (label, got, expected) => { assert.deepEqual(got, expected, label); checks++; console.log(`  ✓ ${label}`) }
const failCode = async (label, code, fn) => {
  await assert.rejects(fn, (err) => err?.code === code, label); checks++; console.log(`  ✓ ${label}`)
}
await custodyService.setPin({ userId: manager, newPassword: 'Manager459!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager459!' })
for (const [id, temp, pin] of [[first, 'First459!', 'First4594!'], [second, 'Second459!', 'Second4594!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager459!', reason: 'صدور PIN برای سند یادداشت اختیاری' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
// This fixture exercises optional notes, not the default-deny policy tested by s460.
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager459!', reason: 'اجازهٔ تحویل برای آزمون یادداشت اختیاری' })
const amount = 12_345_000, day = toJalaliDate(new Date())
const opened = await custodyService.open({ userId: first, password: 'First4594!', operationalTotal: amount })
const openingId = seed.one('SELECT id FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING').id
const method = seed.insert('PaymentMethod', { key: 'S459_CASH', label: 'نقدی', kind: 'CASH' })
const inv = seed.invoice({ receiptNo: 459001, grandTotal: amount, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
  .run(amount, amount, day, first, opened.shiftId, inv.id)
seed.insert('Payment', { invoiceId: inv.id, methodId: method, amount, seq: 1, kind: 'CASH', destination: 'CASH',
  paidAt: Date.now(), paidAtJalali: day, createdByUserId: first, createdShiftId: opened.shiftId })
const started = await custodyService.handoverStart({ password: 'First4594!', operationalTotal: amount,
  toUserId: second, idempotencyKey: 's459:real-blue-handover', blueReference: true })
await custodyService.handoverCountBlue({ handoverId: started.id, password: 'Second4594!', operationalTotal: amount })
await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'Second4594!' })
const outId = seed.one('SELECT id FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'OUT').id
const inId = seed.one('SELECT id FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN').id
const financialFingerprint = () => ({
  snapshots: seed.rows('SELECT id, role, humanAmount, referenceAmount, rawDifference, freshDifference, priorSnapshotId FROM "CustodyBlueSnapshot" ORDER BY id'),
  state: seed.rows('SELECT state, activeShiftId, epoch, financialRevision FROM "CustodyState" ORDER BY key'),
  payments: seed.count('Payment'), invoices: seed.count('SaleInvoice'), shifts: seed.count('Shift')
})
const before = financialFingerprint()
const note = (snapshotId, key, text = 'یادداشت اختیاری مدیر دربارهٔ شاهد آبی') => ({
  snapshotId, managerUserId: manager, password: 'Manager459!', text, idempotencyKey: key
})
await failCode('no manager login cannot add a note even with personal PIN', 'REPORT_MANAGER_REQUIRED',
  () => owner(() => custodyBlueNoteService.append(note(inId, 'note-no-session-459'))))
eq('no note is mandatory for a completed handover', seed.count('CustodyBlueNote'), 0)
auth()
await assert.rejects(owner(() => custodyBlueNoteService.append({ ...note(inId, 'note-wrong-pin-459'), password: 'wrong' }))); checks++
await failCode('blank note rejected; it is not a required case', 'BLUE_NOTE_INVALID',
  () => owner(() => custodyBlueNoteService.append(note(inId, 'note-blank-text-459', '  '))))
const saved = await owner(() => custodyBlueNoteService.append(note(inId, 'note-real-in-459')))
eq('first optional IN note committed once', [saved.replayed, seed.count('CustodyBlueNote')], [false, 1])
const replay = await owner(() => custodyBlueNoteService.append(note(inId, 'note-real-in-459')))
eq('same request returns original note without a second row', [replay.replayed, replay.id, seed.count('CustodyBlueNote')], [true, saved.id, 1])
await failCode('idempotency key cannot be reused with different content', 'BLUE_NOTE_IDEMPOTENCY_CONFLICT',
  () => owner(() => custodyBlueNoteService.append(note(inId, 'note-real-in-459', 'متن متفاوت برای همان کلید یکتا'))))
await owner(() => custodyBlueNoteService.append(note(outId, 'note-real-out-459', 'یادداشت جدا برای سند خروج تحویل')))
await owner(() => custodyBlueNoteService.append(note(openingId, 'note-opening-459', 'یادداشت اختیاری روی افتتاح مستقل')))
eq('notes for OUT/IN/OPENING never change the count, source or responsibility', financialFingerprint(), before)
for (const statement of [
  `UPDATE "CustodyBlueNote" SET text='changed' WHERE id=${saved.id}`,
  `DELETE FROM "CustodyBlueNote" WHERE id=${saved.id}`
]) {
  assert.throws(() => sql.exec(statement), /append-only/); checks++
}
eq('append-only triggers protect note UPDATE and DELETE', seed.count('CustodyBlueNote'), 3)
const notes = await owner(() => custodyBlueNoteService.list({ snapshotId: inId }))
eq('manager list returns the authentic note on just the requested snapshot', [notes.rows.length, notes.rows[0].id, notes.hasMore], [1, saved.id, false])
const managerReport = await owner(() => custodyService.report({ managerSession: true, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), take: 30 }))
const handover = managerReport.handovers.find((row) => row.id === started.id)
eq('report shows optional OUT and IN notes independently', [handover?.blue?.outgoing?.managerNotes?.length, handover?.blue?.incoming?.managerNotes?.length], [1, 1])
eq('manager report shows opening note without turning it into a case', managerReport.blueBoundaries.find((row) => row.snapshotId === openingId)?.managerNotes?.length, 1)
const f10 = await owner(() => cashClosingHistoryService.query({ fromJalali: day, toJalali: day }))
const f10Row = f10.rows.find((row) => row.handoverId === started.id)
eq('F10 preserves original reference and completed-event counts with two notes', [f10.totals.handovers, f10Row?.reference.amount, f10Row?.managerNotes?.length], [1, amount, 2])
const exportData = owner(() => cashClosingHistoryService.exportData({ snapshotToken: f10.snapshotToken, format: 'csv' }))
eq('F10 CSV includes notes in a separate column, not the amount column', [exportData.rows.find((row) => row[1] === f10Row.sourceId)?.[11], exportData.rows.find((row) => row[1] === f10Row.sourceId)?.at(-1)?.includes('یادداشت جدا')], [amount, true])
clearPanelSessions(459)
await failCode('logout revokes access to notes', 'REPORT_MANAGER_REQUIRED', () => owner(() => custodyBlueNoteService.list({ snapshotId: inId })))
eq('logout did not remove the immutable notes', seed.count('CustodyBlueNote'), 3)
console.log(`\n✓ ${checks} optional blue-note checks passed`)
