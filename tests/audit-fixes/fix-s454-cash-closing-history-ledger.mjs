/**
 * Cash Closing history: committed-only rows, historical blue amount, strict
 * read-only snapshot, full-range counts, independent paging and login binding.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s454-cash-closing-history-ledger.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-cash-history-s454-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { cashClosingHistoryService } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { toJalaliDate, jalaliStartOfDay } = await import('@shared/jalali')
const { notePanelUnlocked, runWithPanelSessionOwner, clearPanelSessions, applyPanelSessionTtlMs } = await import('../../src/main/services/panelSession.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
const eq = (label, got, want) => { assert.deepEqual(got, want, label); checks++; console.log(`  ✓ ${label}`) }
const failCode = async (label, code, fn) => {
  await assert.rejects(fn, (err) => err?.code === code, label); checks++; console.log(`  ✓ ${label}`)
}
const owner = (id, fn) => runWithPanelSessionOwner(id, fn)
const manager = seed.user('مدیر گزارش')
const outgoing = seed.user('تحویل‌دهنده')
const receiver = seed.user('تحویل‌گیرنده')
const day = toJalaliDate(new Date())
const midnight = jalaliStartOfDay(day).getTime()
const time = (minute) => new Date(midnight + minute * 60_000)
const range = { fromJalali: day, toJalali: day }
const query = (input = range) => owner(454, () => cashClosingHistoryService.query(input))
const exportData = (input) => owner(454, () => cashClosingHistoryService.exportData(input))
const tables = ['Setting', 'AuditLog', 'Shift', 'CustodyState', 'CustodyResolution', 'CustodyHandover', 'CustodyEvent', 'CustodyCount', 'CustodyBlueSnapshot', 'CustodyBlueResolution', 'CashSession', 'CashMovement']
const fingerprint = () => ({ counts: tables.map((name) => seed.count(name)), state: seed.rows('SELECT * FROM "CustodyState" ORDER BY key') })
const auth = (id = 454) => owner(id, () => notePanelUnlocked('__manager__', 'MANAGER'))

// An expired shift exists; viewing a report must not call custody.status,
// create a system close, add settings/audit rows, or materialize a rollover.
const expired = seed.insert('Shift', { userId: outgoing, openedAt: time(-1440), closedAt: null })
seed.insert('CustodyShiftMeta', { shiftId: expired, custodianUserId: outgoing,
  endKind: null, rolloverAt: time(-60), operationalDay: day, openAuth: 'CUSTODY_PIN', openEpoch: 0 })
sql.prepare('UPDATE "CustodyState" SET state=?, activeShiftId=?, pendingHandoverId=?, epoch=?, financialRevision=? WHERE key=?')
  .run('ACTIVE', expired, null, 3, 7, 'MAIN')
seed.invoice({ grandTotal: 500_000 }) // Sales and an open shift are NOT a completed close.
await assert.rejects(query(), /فقط نشست فعال مدیر/); checks++
auth()
const beforeEmpty = fingerprint()
const empty = await query()
eq('no genuinely completed event means no history row', [empty.rows.length, empty.legacy.rows.length], [0, 0])
eq('both independent counters are zero on empty period', [empty.totals.handovers, empty.totals.finalClosings], [0, 0])
eq('no settings/audit/custody or other DB write while querying expired shift', fingerprint(), beforeEmpty)
eq('no status-created rollover event', seed.count('CustodyEvent', 'type = ?', 'ROLLOVER_UNRESOLVED'), 0)
eq('Main returns a server-owned opaque token', /^[A-Za-z0-9_-]{43}$/.test(empty.snapshotToken), true)
await failCode('invalid Jalali range fails without falling back to today', 'REPORT_INVALID', () => query({ fromJalali: '1405/13/01', toJalali: day }))
await failCode('renderer cannot supply a manager identity', 'REPORT_INVALID', () => query({ ...range, managerId: manager }))
await failCode('renderer cannot supply totals or rows', 'REPORT_INVALID', () => query({ ...range, totals: { handovers: 42 }, rows: [] }))

let suffix = 0
const shift = (user) => seed.insert('Shift', { userId: user, openedAt: time(20 + ++suffix), closedAt: time(100 + suffix) })
const meta = (shiftId, user, endKind, sessionId = null) => seed.insert('CustodyShiftMeta', {
  shiftId, custodianUserId: user, endKind, cashSessionId: sessionId, planTitle: 'صبح',
  rolloverAt: time(120), openAuth: 'CUSTODY_PIN', openEpoch: 0, operationalDay: day
})
const event = (type, props = {}) => seed.insert('CustodyEvent', {
  type, shiftId: null, handoverId: null, actorKind: 'CUSTODIAN', at: time(100 + ++suffix),
  operationalDay: day, payloadJson: '{}', ...props
})
const snapshot = (handoverId, shiftId, role, version, status, amount, extra = {}) => seed.insert('CustodyBlueSnapshot', {
  handoverId, shiftId, role, actorUserId: role === 'OUT' || role === 'FINAL_CLOSE' ? outgoing : receiver, authMethod: 'CUSTODY_PIN',
  countOrigin: role === 'OUT' ? 'EXPLICIT_AMOUNT' : 'EXPLICIT_ZERO',
  humanAmount: role === 'OUT' ? 1000 : 0, arithmeticAmount: role === 'OUT' ? 1000 : 0,
  referenceStatus: status, referenceAmount: amount, knownSubtotal: status === 'AVAILABLE' ? amount : 245,
  referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY', calculationVersion: version,
  sourceHash: `source:${handoverId ?? shiftId}`, sourceScope: 'test', operationalDay: day,
  epochAtCount: 1, financialRevision: 7, idempotencyKey: `history-${++suffix}`,
  freshStatus: 'UNKNOWN_NO_REAL_PRIOR_COUNT', ...extra
})
const handover = (type, kind, amount, { status = 'AVAILABLE', version = 'sales-blue-v2', absent = false, committed = true } = {}) => {
  const from = shift(outgoing), to = shift(receiver)
  meta(from, outgoing, 'BLUE_HANDOVER'); meta(to, receiver, null)
  const id = seed.insert('CustodyHandover', { fromShiftId: from, fromUserId: outgoing,
    selectedRecipientUserId: receiver, finalCustodianUserId: receiver,
    status: committed ? 'COMPLETED' : 'RECEIVER_COUNTED',
    resolutionKind: committed ? kind : null, toShiftId: committed ? to : null,
    startedAt: time(-60), finishedAt: committed ? time(100 + suffix) : null,
    idempotencyKey: `history-handover-${++suffix}` })
  const out = snapshot(id, from, 'OUT', version, status, amount, absent ? {
    actorUserId: receiver, authMethod: 'SYSTEM_ABSENCE', countOrigin: 'ABSENT_UNCOUNTED', humanAmount: null, arithmeticAmount: null
  } : {})
  // The real normal V2 writer records IN on the still-open *source* Shift;
  // immutable historical V1 fixtures retain the former destination layout.
  const incoming = snapshot(id, absent || version === 'sales-blue-v1' ? to : from, 'IN', version, status, amount, { priorSnapshotId: out })
  const idEvent = committed ? event(type, { shiftId: to, handoverId: id,
    payloadJson: JSON.stringify({ fromShiftId: from, toShiftId: to, outSnapshotId: out, inSnapshotId: incoming }) }) : null
  return { id, out, incoming, eventId: idEvent, from, to }
}
// Opening, start-only, receiver-counted, canceled, stale and system rollover
// must never appear even though some carry rows/snapshots.
event('ROLLOVER_UNRESOLVED', { shiftId: expired })
event('HANDOVER_START', { shiftId: expired })
handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', 999, { committed: false })
const first = handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', 0)
const pending = handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', null, { status: 'PENDING_RECONCILIATION' })
const cover = handover('BLUE_EMERGENCY_COVER_COMMITTED', 'BLUE_EMERGENCY_COVER', 330, { absent: true })
const override = handover('BLUE_MASTER_OVERRIDE_COMMITTED', 'BLUE_MASTER_OVERRIDE', 450, { absent: true })
const v1 = handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', 650, { version: 'sales-blue-v1' })
const negative = handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', -11)
const managerDecision = seed.insert('CustodyBlueResolution', { snapshotId: pending.incoming, managerUserId: manager,
  decisionKind: 'RECEIVED_CASH', effectiveReferenceAmount: 257, idempotencyKey: 'history-decision-1',
  ambiguousAmount: 12, evidenceDay: day, evidenceReference: 'مدرک مدیر', reason: 'مدرک ثبت شد', at: time(420) })
const closedShift = shift(outgoing)
meta(closedShift, outgoing, 'BLUE_FINAL_CLOSE')
const finalSnapshot = snapshot(null, closedShift, 'FINAL_CLOSE', 'sales-blue-v2', 'AVAILABLE', 992)
const finalId = event('BLUE_FINAL_CLOSE_COMMITTED', { shiftId: closedShift, payloadJson: JSON.stringify({ snapshotId: finalSnapshot }) })
// A legacy committed custody handover has no blue snapshot, not a zero amount.
const oldFrom = shift(outgoing), oldTo = shift(receiver)
meta(oldFrom, outgoing, 'HANDED_OVER'); meta(oldTo, receiver, null)
const oldHand = seed.insert('CustodyHandover', { fromShiftId: oldFrom, fromUserId: outgoing,
  selectedRecipientUserId: receiver, finalCustodianUserId: receiver,
  status: 'COMPLETED', resolutionKind: 'RECEIVER_ACCEPTED', toShiftId: oldTo,
  startedAt: time(-40), finishedAt: time(110), idempotencyKey: `history-legacy-${++suffix}` })
const oldEvent = event('HANDOVER_ACCEPT', { shiftId: oldTo, handoverId: oldHand, at: time(110) })
const oldCloseShift = shift(outgoing)
const oldSession = seed.insert('CashSession', { shiftId: oldCloseShift, closedAt: time(111), createdAt: time(111) })
meta(oldCloseShift, outgoing, 'FINAL_CLOSE', oldSession)
const oldFinalId = event('FINAL_CLOSE', { shiftId: oldCloseShift, at: time(112), payloadJson: JSON.stringify({ cashSessionId: oldSession }) })
// A standalone old Cash Close is a distinct source; a confirmed repeat stays
// visible separately but cannot inflate the genuine legacy-close count.
const plainShift = shift(outgoing)
const plain = seed.insert('CashSession', { shiftId: plainShift, closedAt: time(150), createdAt: time(150) })
const repeated = seed.insert('CashSession', { shiftId: plainShift, closedAt: time(151), createdAt: time(151) })
// Recovery after expiry may create a CashSession: it is not a real close.
const recovered = shift(outgoing)
const recoverySession = seed.insert('CashSession', { shiftId: recovered, closedAt: time(160), createdAt: time(160) })
seed.insert('CustodyResolution', { shiftId: recovered, cashSessionId: recoverySession, status: 'RESOLVED' })
// Inconsistent amount/linkage cannot borrow a current value or appear as a
// valid closing. Original immutable evidence survives for manager review.
const broken = handover('BLUE_HANDOVER_COMMITTED', 'BLUE_RECEIVER_ACCEPTED', 800)
// Immutable snapshot cannot be altered. Commit a second event referring to a non-existent id.
const brokenHand = seed.insert('CustodyHandover', { fromShiftId: broken.from, fromUserId: outgoing,
  selectedRecipientUserId: receiver, finalCustodianUserId: receiver, status: 'COMPLETED',
  resolutionKind: 'BLUE_RECEIVER_ACCEPTED', toShiftId: broken.to, idempotencyKey: 'history-broken-1' })
const brokenEvent = event('BLUE_HANDOVER_COMMITTED', { shiftId: broken.to, handoverId: brokenHand,
  payloadJson: JSON.stringify({ outSnapshotId: 90000001, inSnapshotId: 90000002 }) })
// Exact duplicate event for the same handover must not duplicate totals.
event('BLUE_HANDOVER_COMMITTED', { shiftId: first.to, handoverId: first.id,
  payloadJson: JSON.stringify({ fromShiftId: first.from, toShiftId: first.to, outSnapshotId: first.out, inSnapshotId: first.incoming }) })
// A newer tampered duplicate must NOT hide the earlier verified handover.
const forgedDuplicate = event('BLUE_HANDOVER_COMMITTED', { shiftId: first.to, handoverId: first.id,
  payloadJson: JSON.stringify({ fromShiftId: first.from, toShiftId: first.to, outSnapshotId: first.out, inSnapshotId: 90000004 }) })

const before = fingerprint()
const full = await query({ ...range, take: 1 })
eq('one visible row but complete handover total', [full.rows.length, full.totals.handovers], [1, 8])
eq('one visible legacy row but complete legacy total', [full.legacy.rows.length, full.totals.legacyCloses, full.totals.legacyCorrections], [1, 1, 1])
eq('both custody and real old-system closes count in the complete closing total', [full.totals.finalClosings, full.totals.custodyFinalClosings], [3, 2])
eq('no system status/rollover adds a close', full.rows.some((row) => row.kind === 'LEGACY_CLOSE' || row.sourceId === oldEvent && row.kind === 'FINAL_CLOSE'), false)
eq('Main-only report reads leave all financial/custody/settings rows untouched', fingerprint(), before)
const all = [...full.rows], allOld = [...full.legacy.rows]
let cursor = full.page.nextCursor, oldCursor = full.legacy.page.nextCursor
while (cursor) {
  const p = await query({ ...range, take: 1, snapshotToken: full.snapshotToken, cursor })
  all.push(...p.rows); cursor = p.page.nextCursor
  eq('main total does not depend on page', p.totals.handovers, 8)
}
while (oldCursor) {
  const p = await query({ ...range, take: 1, snapshotToken: full.snapshotToken, cursor: oldCursor })
  allOld.push(...p.legacy.rows); oldCursor = p.legacy.page.nextCursor
  eq('legacy count independent of page', p.totals.legacyCloses, 1)
}
eq('ten verified completed custody events materialized once', all.length, 10)
eq('legacy CashSessions are separate without double-counting linked custody/recovery', allOld.map((r) => r.sourceId).sort((a, b) => a - b), [plain, repeated])
eq('duplicate commit event for first handover deduped', all.filter((r) => r.handoverId === first.id).length, 1)
eq('real stored zero is known zero', all.find((r) => r.handoverId === first.id).reference, { ...all.find((r) => r.handoverId === first.id).reference, state: 'KNOWN_V2', amount: 0 })
eq('pending blue has no fabricated reference', [all.find((r) => r.handoverId === pending.id).reference.amount, all.find((r) => r.handoverId === pending.id).reference.knownSubtotal], [null, 245])
eq('later manager decision does not overwrite original pending value', [all.find((r) => r.handoverId === pending.id).reference.state, all.find((r) => r.handoverId === pending.id).laterDecision.amount], ['PENDING_V2', 257])
eq('V1 explicitly separate from V2', all.find((r) => r.handoverId === v1.id).reference.state, 'KNOWN_V1')
eq('legitimate negative stored reference survives', all.find((r) => r.handoverId === negative.id).reference.amount, -11)
eq('preblue committed handover has unknown original reference', all.find((r) => r.handoverId === oldHand).reference.state, 'NOT_RECORDED')
eq('blue emergency has absent outgoing, without invented count', all.find((r) => r.handoverId === cover.id).from.presence, 'ABSENT_UNCOUNTED')
eq('Master Override is a completed handover', all.find((r) => r.handoverId === override.id).kind, 'MASTER_OVERRIDE')
eq('genuine final close uses stored FINAL_CLOSE snapshot', all.find((r) => r.sourceId === finalId).reference.amount, 992)
eq('broken and forged evidence do not produce F10 rows', [all.some((r) => r.sourceId === brokenEvent || r.sourceId === forgedDuplicate), full.totals.amountInconsistent], [false, 2])
eq('a valid handover survives a newer forged duplicate', all.filter((r) => r.handoverId === first.id).length, 1)
eq('quarantine is explicit but never counted as a completed handover', full.warnings.some((warning) => warning.includes('کنار گذاشته شد')), true)
eq('old handover starting yesterday appears on the completion day', all.find((r) => r.sourceId === oldEvent).occurredDayJalali, day)
eq('original cash session linked to custody close not repeated in legacy section', allOld.some((r) => r.sourceId === oldSession), false)
eq('second old-system close is correction not another genuine close', [allOld.find((r) => r.sourceId === plain).legacyRepeat, allOld.find((r) => r.sourceId === repeated).legacyRepeat], [false, true])
eq('pagination and export made no database writes', fingerprint(), before)
const file = exportData({ snapshotToken: full.snapshotToken, format: 'csv' })
eq('CSV rows are exactly the full frozen custody+legacy set', file.rows.length, all.length + allOld.length)
eq('CSV never replaces pending by later decision in amount column', file.rows.find((r) => r[1] === pending.eventId)?.[11], '')
eq('CSV distinguishes later decision in its own column', file.rows.find((r) => r[1] === pending.eventId)?.[14], 257)
// A writer can commit AFTER the first read with a completion timestamp BEFORE
// the frozen report's creation time. Neither page two nor export may admit it.
const lateShift = seed.insert('Shift', { userId: outgoing, openedAt: time(-300) })
const lateClose = seed.insert('CashSession', { shiftId: lateShift,
  closedAt: new Date(new Date(full.snapshotAt).getTime() - 1), createdAt: new Date() })
const crossDay = seed.insert('Shift', { userId: outgoing, openedAt: time(-2000) })
seed.insert('CashSession', { shiftId: crossDay, closedAt: time(-30), createdAt: time(-30) })
const crossDayRepeat = seed.insert('CashSession', { shiftId: crossDay, closedAt: time(180), createdAt: time(180) })
const frozen = await query({ ...range, take: 1, snapshotToken: full.snapshotToken })
eq('newly committed old-timestamp close cannot appear in frozen page one', frozen.totals.legacyCloses, 1)
eq('old snapshot export cannot pick up later commit', exportData({ snapshotToken: full.snapshotToken, format: 'csv' }).rows.length, file.rows.length)
const fresh = await query({ ...range, take: 20 })
eq('newly requested report sees the completed close', fresh.totals.legacyCloses, 2)
eq('repeat whose original close was before this range is NOT a new genuine close', fresh.totals.legacyCorrections, 2)
eq('cross-day correction still appears as an actual historical record', fresh.legacy.rows.find((r) => r.sourceId === crossDayRepeat)?.legacyRepeat, true)
eq('fresh report shows the late committed CashSession separately', fresh.legacy.rows.some((r) => r.sourceId === lateClose), true)
// A no-shift old range close stores the same range start but a different end
// timestamp on each confirmed repeat. toDate cannot be its deduplication key.
const noShiftStart = time(-200)
const noShiftClose = seed.insert('CashSession', { shiftId: null, closedBy: manager, fromDate: noShiftStart, dayJalali: day,
  toDate: time(200), closedAt: time(200), createdAt: time(200) })
const noShiftRepeat = seed.insert('CashSession', { shiftId: null, fromDate: noShiftStart, dayJalali: day,
  toDate: time(201), closedAt: time(201), createdAt: time(201) })
const fullWithRange = await query({ ...range, take: 20 })
eq('no-shift repeated range close does not inflate the complete closing count',
  [fullWithRange.totals.finalClosings, fullWithRange.totals.legacyCloses, fullWithRange.totals.legacyCorrections], [5, 3, 3])
eq('no-shift correction is still visible as a record', fullWithRange.legacy.rows.find((r) => r.sourceId === noShiftRepeat)?.legacyRepeat, true)
eq('range-only old close shows its STORED closer, not the current shift owner',
  fullWithRange.legacy.rows.find((r) => r.sourceId === noShiftClose)?.from?.userId, manager)
const afterCommits = fingerprint()
await failCode('renderer cannot inject export rows', 'REPORT_INVALID', () => Promise.resolve().then(() => exportData({ snapshotToken: full.snapshotToken, format: 'csv', rows: [{ amount: 999999 }] })))
await failCode('renderer cannot forge cursor', 'REPORT_INVALID', () => query({ ...range, take: 1, snapshotToken: full.snapshotToken, cursor: 'CUSTODY.1.invalid' }))
await failCode('changing report range cannot reuse old token', 'REPORT_SNAPSHOT_EXPIRED', () => query({ ...range, fromJalali: '1400/01/01', take: 1, snapshotToken: full.snapshotToken }))
await failCode('renderer-supplied total rejected', 'REPORT_INVALID', () => query({ ...range, take: 1, snapshotToken: full.snapshotToken, total: 333 }))
await assert.rejects(owner(455, () => cashClosingHistoryService.query({ ...range, take: 1, snapshotToken: full.snapshotToken })), /فقط نشست فعال مدیر/); checks++
auth(455)
await failCode('other window with its own manager cannot steal token', 'REPORT_SNAPSHOT_EXPIRED', () => owner(455, () => cashClosingHistoryService.query({ ...range, take: 1, snapshotToken: full.snapshotToken })))
auth() // same sender successfully re-enters: fresh nonce, not the same login instance
await failCode('re-login with the same generation cannot reuse prior token', 'REPORT_SNAPSHOT_EXPIRED', () => query({ ...range, take: 1, snapshotToken: full.snapshotToken }))
const noOldCustody = await query({ ...range, take: 20, includeLegacyCustody: false })
eq('source filter excludes BOTH old custody handover and old custody final-close',
  [noOldCustody.rows.some((r) => r.sourceId === oldEvent || r.sourceId === oldFinalId), noOldCustody.totals.custodyFinalClosings], [false, 1])
clearPanelSessions(454)
await assert.rejects(query({ ...range, take: 1, snapshotToken: full.snapshotToken }), /فقط نشست فعال مدیر/); checks++
auth()
applyPanelSessionTtlMs(1)
await new Promise((resolve) => setTimeout(resolve, 4))
await assert.rejects(query(), /فقط نشست فعال مدیر/); checks++
applyPanelSessionTtlMs(300_000)
eq('auth denial/logout/expiry have not written to cash or settings', fingerprint(), afterCommits)
console.log(`\n✓ ${checks} Cash Closing history ledger checks passed`)
