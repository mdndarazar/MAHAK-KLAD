/**
 * Manager PIN and same-period evidence add decisions to the SAME handover
 * snapshot, without rewriting it or attributing a fresh/guilty shortage.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s403-custody-blue-manager-decision.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-manager-s403-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const manager = seed.user('مدیر شخصی S403')
const cashier = seed.user('صندوقدار S403')
db.$harness.db.prepare('UPDATE "User" SET "role"=? WHERE id=?').run('CASHIER', cashier)
const day = toJalaliDate(new Date())
await custodyService.setPin({ userId: manager, newPassword: 'Manager403!', currentPassword: '1111' })
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function reject(label, action, code) {
  try { await action() }
  catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
function frozenHandover(suffix) {
  const shiftId = seed.insert('Shift', { name: `Frozen S403 ${suffix}`, userId: cashier })
  const outCountId = seed.insert('CustodyCount', { shiftId, kind: 'HANDOVER_OUT', countedCash: 501_000_000, countedByUserId: cashier, authMethod: 'CUSTODY_PIN', epochAtCount: 2, idempotencyKey: `s403:out:${suffix}`, operationalDay: day })
  const handoverId = seed.insert('CustodyHandover', {
    fromShiftId: shiftId, fromUserId: cashier, selectedRecipientUserId: cashier,
    acceptedByUserId: cashier, status: 'COMPLETED', outCountId,
    expectedAtStart: 0, countedAtStart: 501_000_000, differenceCash: 0,
    ledgerWatermark: '{}', fenceEpochAtStart: 2, idempotencyKey: `s403:handover:${suffix}`, operationalDay: day
  })
  const snapshotId = seed.insert('CustodyBlueSnapshot', {
    handoverId, shiftId, role: 'IN', actorUserId: cashier, authMethod: 'CUSTODY_PIN',
    countOrigin: 'EXPLICIT_AMOUNT', humanAmount: 501_000_000, arithmeticAmount: 501_000_000,
    referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY',
    referenceStatus: 'PENDING_RECONCILIATION', referenceAmount: null, knownSubtotal: 500_000_000,
    ambiguousLegacyCredit: 1_000_000, calculationVersion: 'sales-blue-v1',
    financialRevision: 0, epochAtCount: 2,
    rawDifference: null, freshDifference: null, freshStatus: 'UNKNOWN_REFERENCE_PENDING',
    idempotencyKey: `s403:snapshot:${suffix}`, operationalDay: day
  })
  return { snapshotId, handoverId }
}
const base = (snapshotId, decisionKind, suffix) => ({
  snapshotId, managerUserId: manager, password: 'Manager403!', decisionKind,
  evidenceDay: day, evidenceReference: 'رسید فیزیکی مربوط به همین بازهٔ تحویل',
  reason: 'سند صندوق با گزارش همان روز مطابقت داده شد',
  idempotencyKey: `s403:decision:${suffix}:abcdefgh`
})

console.log('\n[1] CASH/CARD proof in the original period: 501M, raw zero')
const received = frozenHandover('received')
const cash = await custodyBlueResolutionService.resolve(base(received.snapshotId, 'RECEIVED_CASH', 'received'))
eq('CASH result 501M', cash.referenceAmount, 501_000_000)
eq('CASH raw zero', cash.rawDifference, 0)
eq('CASH fresh not manufactured', cash.freshDifference, null)
eq('CASH decision on SAME frozen handover', seed.one('SELECT "handoverId" FROM "CustodyBlueSnapshot" WHERE id=?', received.snapshotId).handoverId, received.handoverId)
eq('original snapshot remains pending', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', received.snapshotId).referenceAmount, null)
const replay = await custodyBlueResolutionService.resolve(base(received.snapshotId, 'RECEIVED_CASH', 'received'))
eq('idempotent replay has same event', replay.id, cash.id)
eq('idempotent replay flag', replay.replayed, true)
eq('one resolution row only', seed.count('CustodyBlueResolution', 'snapshotId=?', received.snapshotId), 1)
await reject('contradictory later decision refused', () => custodyBlueResolutionService.resolve(base(received.snapshotId, 'NOT_RECEIVED', 'second')), 'BLUE_ALREADY_RESOLVED')

console.log('\n[2] Evidence of no receipt: 500M, real +1M raw, no guilty verdict')
const noReceipt = frozenHandover('no-receipt')
const denied = await custodyBlueResolutionService.resolve(base(noReceipt.snapshotId, 'NOT_RECEIVED', 'no-receipt'))
eq('NOT_RECEIVED reference 500M', denied.referenceAmount, 500_000_000)
eq('NOT_RECEIVED raw +1M', denied.rawDifference, 1_000_000)
eq('NOT_RECEIVED fresh remains unknown', denied.freshDifference, null)
eq('historic day retained', seed.one('SELECT operationalDay FROM "CustodyBlueSnapshot" WHERE id=?', noReceipt.snapshotId).operationalDay, day)
eq('no blame assigned by decision', seed.one('SELECT freshStatus FROM "CustodyBlueResolution" WHERE id=?', denied.id).freshStatus, 'UNKNOWN_NO_REAL_PRIOR_COUNT')

console.log('\n[3] Neither a wrong PIN nor proof from another date can resolve a snapshot')
const untouched = frozenHandover('untouched')
await reject('wrong personal PIN rejected', () => custodyBlueResolutionService.resolve({ ...base(untouched.snapshotId, 'RECEIVED_CARD', 'wrong-pin'), password: 'WRONG403!' }), 'PIN_WRONG')
const otherDay = '1401/01/01' === day ? '1401/01/02' : '1401/01/01'
await reject('proof from different day rejected', () => custodyBlueResolutionService.resolve({ ...base(untouched.snapshotId, 'RECEIVED_CARD', 'wrong-day'), evidenceDay: otherDay }), 'BLUE_EVIDENCE_OUT_OF_SCOPE')
eq('no event persisted after rejected proof', seed.count('CustodyBlueResolution', 'snapshotId=?', untouched.snapshotId), 0)

const managerList = await custodyBlueResolutionService.pendingList()
const firstDecision = managerList.rows.find((row) => row.snapshotId === received.snapshotId)
const unresolved = managerList.rows.find((row) => row.snapshotId === untouched.snapshotId)
eq('resolved item remains attached to original handover in manager history', firstDecision.handoverId, received.handoverId)
eq('resolved item shows derived 501M', firstDecision.referenceAmount, 501_000_000)
eq('resolved item does not rewrite original null', firstDecision.originalReferenceAmount, null)
eq('unresolved item has null official reference', unresolved.referenceAmount, null)
eq('unresolved status remains explicit', unresolved.status, 'PENDING_RECONCILIATION')
console.log(`\n✓ ${checks} checks passed`)
