/**
 * Existing append-only SYSTEM_ABSENCE_ZERO snapshots stay byte-for-byte frozen.
 * They still decode as NO departing count, while every current manager surface
 * displays "absent; not counted" rather than a human zero or substitute PIN.
 * New writes cannot emit the obsolete provenance.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s443-historical-system-absence-readonly.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-old-absence-s443-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { countFromBlueSnapshot, recordBlueSnapshot } = await import('../../src/main/services/CustodyBlueSnapshotService.ts')
const { systemAbsenceZero, absenceUncounted } = await import('../../src/shared/custodyPeriod.ts')
const { calculateCustodyReference } = await import('../../src/shared/custodyReference.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر S443')
const oldOwner = seed.user('مسئول تاریخی S443')
const receiver = seed.user('شاهد تاریخی S443')
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager443!' })
const from = seed.insert('Shift', { userId: oldOwner })
const next = seed.insert('Shift', { userId: receiver })
const day = toJalaliDate(new Date())
// Frozen V1-style database fixture: a previous binary already committed the
// old ambiguous label, an OUT attributed to the initiator, and a bridge count
// pointing at the arriving worker. Never rewrite any of these original facts.
const bridge = seed.insert('CustodyCount', { shiftId: from, kind: 'BLUE_EMERGENCY_IN',
  at: new Date(), countedCash: 700, countedByUserId: receiver, authMethod: 'CUSTODY_PIN',
  epochAtCount: 1, idempotencyKey: 's443-old-receiver-bridge', operationalDay: day })
const handover = seed.insert('CustodyHandover', { fromShiftId: from, fromUserId: oldOwner,
  selectedRecipientUserId: receiver, finalCustodianUserId: receiver, acceptedByUserId: receiver,
  status: 'COMPLETED', outCountId: bridge, expectedAtStart: 0, countedAtStart: 700,
  differenceCash: 0, ledgerWatermark: JSON.stringify({ blueV1: true, emergency: true,
    outCountOrigin: 'SYSTEM_ABSENCE_ZERO', outCountIdIsReceiverWitness: true }),
  toShiftId: next, fenceEpochAtStart: 1, idempotencyKey: 's443-old-handover',
  stateKey: 'MAIN', operationalDay: day, startedAt: new Date(), finishedAt: new Date() })
const common = { handoverId: handover, referenceFromDay: day, referenceToDay: day,
  scopeKind: 'TODAY', referenceStatus: 'AVAILABLE', referenceAmount: 0,
  knownSubtotal: 0, ambiguousLegacyCredit: 0, calculationVersion: 'sales-blue-v1',
  financialRevision: 0, epochAtCount: 1, operationalDay: day }
const outId = seed.insert('CustodyBlueSnapshot', { ...common, shiftId: from, role: 'OUT',
  actorUserId: receiver, authMethod: 'SYSTEM_ABSENCE_ZERO', countOrigin: 'SYSTEM_ABSENCE_ZERO',
  humanAmount: null, arithmeticAmount: null, freshStatus: 'UNKNOWN_NO_REAL_END_COUNT',
  idempotencyKey: 's443-old-out' })
const inId = seed.insert('CustodyBlueSnapshot', { ...common, shiftId: from, role: 'IN',
  actorUserId: receiver, authMethod: 'CUSTODY_PIN', countOrigin: 'EXPLICIT_AMOUNT',
  humanAmount: 700, arithmeticAmount: 700, priorSnapshotId: outId,
  freshStatus: 'UNKNOWN_NO_REAL_PRIOR_COUNT', idempotencyKey: 's443-old-in' })
const original = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE id=?', outId)
const observed = countFromBlueSnapshot(await db.custodyBlueSnapshot.findUnique({ where: { id: outId } }))
eq('frozen legacy origin still reads as absence', observed.origin, 'SYSTEM_ABSENCE_ZERO')
eq('frozen legacy origin never gains a human amount', observed.humanAmount, null)
eq('frozen legacy origin never gains an arithmetic zero', observed.arithmeticAmount, null)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager443!', take: 100 })
const row = report.handovers.find((item) => item.id === handover)
eq('manager report recognizes frozen old absence', row?.blue?.outgoing?.countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('manager report never claims receiver signed the outgoing side', row?.blue?.outgoing?.actorUserId, null)
eq('manager report hides old cash-era bridge as a departure count', row?.countedAtStart, null)
eq('manager report keeps the real incoming observation', row?.blue?.incoming?.humanAmount, 700)
eq('opening snapshots remain immutable after report', JSON.stringify(seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE id=?', outId)), JSON.stringify(original))
await assert.rejects(() => recordBlueSnapshot(db, {
  shiftId: from, role: 'OUT', actorUserId: receiver, authMethod: 'SYSTEM_ABSENCE_ZERO',
  count: systemAbsenceZero(), reference: calculateCustodyReference({ cashReceived: 0,
    cardReceived: 0, otherReceived: 0, refundCash: 0, refundCard: 0,
    destinationUnknownReceived: 0, ambiguousLegacyCredit: 0 }),
  referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY',
  financialRevision: 0, epochAtCount: 1, prior: null, idempotencyKey: 's443-block-old-write'
}), (error) => error?.code === 'BLUE_ABSENCE_ORIGIN_INVALID')
checks++; console.log('  ✓ new writes refuse old zero-named absence origin')
await assert.rejects(() => recordBlueSnapshot(db, {
  shiftId: from, role: 'IN', actorUserId: receiver, authMethod: 'SYSTEM_ABSENCE',
  count: absenceUncounted(), reference: calculateCustodyReference({ cashReceived: 0,
    cardReceived: 0, otherReceived: 0, refundCash: 0, refundCard: 0,
    destinationUnknownReceived: 0, ambiguousLegacyCredit: 0 }),
  referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY',
  financialRevision: 0, epochAtCount: 1, prior: null, idempotencyKey: 's443-block-incoming-absence'
}), (error) => error?.code === 'BLUE_ABSENCE_ORIGIN_INVALID')
checks++; console.log('  ✓ cannot use an absent marker as a new worker physical count')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 443, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
eq('manager session allows read-only audit export', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
const filePath = join(dir, 'old-absence-report.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
eq('CSV export succeeds without changing original documents', (await invoke(IPC.custodyReportExport, {})).ok, true)
const csv = readFileSync(filePath, 'utf8')
eq('old zero-named origin is NOT repeated as a money count in CSV', csv.includes('SYSTEM_ABSENCE_ZERO'), false)
eq('old zero-named origin is NOT shown as a system zero', csv.includes('صفر سیستمی'), false)
eq('old absence is explicitly uncounted in CSV', csv.includes('غیبت تحویل‌دهنده؛ شمارش خروجی انجام نشده'), true)
eq('previous manager export omits legacy bridge count on old side', csv.includes('پوشش غیبت؛ خروج بدون شمارش'), true)
eq('old bridge row is explicitly attributed to arriving worker, never absent worker', csv.includes('شمارش ورودی فرد حاضر است، نه خروج فرد غایب؛ در برخی اسناد قدیمی'), true)
eq('the old stored origin has not been rewritten', seed.one('SELECT countOrigin FROM "CustodyBlueSnapshot" WHERE id=?', outId)?.countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('the old stored IN count has not been rewritten', seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE id=?', inId)?.humanAmount, 700)
const renderer = readFileSync(new URL('../../src/renderer/src/components/CustodyBlueEvidence.tsx', import.meta.url), 'utf8')
eq('desktop explicitly interprets both old and new absent origins', renderer.includes("origin === 'ABSENT_UNCOUNTED' || origin === 'SYSTEM_ABSENCE_ZERO'"), true)
eq('desktop does not call absence a system zero', renderer.includes('صفر سیستمی'), false)
eq('desktop summary distinguishes absence cover from signed normal handover', renderer.includes("? 'پوشش غیبت؛ خروج بدون شمارش' : 'تحویل'"), true)
const admin = readFileSync(new URL('../../src/renderer/src/components/CustodyAdminChip.tsx', import.meta.url), 'utf8')
eq('manager counts tab says incoming count is not absent worker OUT', admin.includes('شمارش آغاز مسئولیت فرد حاضر؛ نه خروج مسئول غایب'), true)
const chip = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
eq('cashier form says absent worker has no OUT count or zero', chip.includes('برای فرد غایب شمارش خروجی یا صفر ثبت نمی‌شود'), true)
eq('cashier form never offers a fake zero for the missing worker', chip.includes('صفرِ فرد غایب فقط شاهد سیستمی'), false)
console.log(`\n✓ ${checks} historical-absence compatibility checks passed`)
