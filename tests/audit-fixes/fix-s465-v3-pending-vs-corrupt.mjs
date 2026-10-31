/** Only missing MONEY with a sound V3 chain may use the manager's ordinary
 * blue-resolution path. A damaged domain/source/digest is a separate manager
 * quarantine problem: do not show a known subtotal, zero, or decision form.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s465-v3-pending-vs-corrupt.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-v3-pending-'))
process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { recordBlueSnapshot } = await import('../../src/main/services/CustodyBlueSnapshotService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { calculateCustodyReference } = await import('../../src/shared/custodyReference.ts')
const { observationOf } = await import('../../src/shared/custodyPeriod.ts')
const { blueEvidenceDigest, blueEvidenceFault } = await import('../../src/main/services/CustodyBlueIntegrity.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر شاهد معلق'), shiftId = seed.insert('Shift', { userId: manager })
const day = toJalaliDate(new Date())
let checks = 0
const eq = (label, got, expected) => { assert.deepEqual(got, expected, label); checks++; console.log(`  ✓ ${label}`) }
const rejects = async (label, code, fn) => { await assert.rejects(fn, (error) => error?.code === code, label); checks++; console.log(`  ✓ ${label}`) }
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager465!' })
const amount = calculateCustodyReference({ cashReceived: 500, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 0, ambiguousLegacyCredit: 10, refundCash: 0, refundCard: 0 })
const sourceScope = JSON.stringify({ filter: { fromJalali: day, toJalali: day, channels: ['RETAIL', 'WHOLESALE'] } })
const reference = { ...amount, sourceScope,
  sourceHash: createHash('sha256').update(JSON.stringify({ scope: sourceScope, reference: amount })).digest('hex') }
const make = (key) => recordBlueSnapshot(db, { shiftId, role: 'OPENING', actorUserId: manager,
  count: observationOf(520, false), reference, referenceFromDay: day, referenceToDay: day,
  scopeKind: 'TODAY', financialRevision: 0, epochAtCount: 1, prior: null, idempotencyKey: key })
const good = await make('s465:valid-pending-opening')
const broken = await make('s465:bad-domain-opening')
const sourceChanged = await make('s465:bad-source-hash-opening')
eq('all witnesses start as V3 pending money with a sound chain',
  [good.referenceStatus, good.referenceAmount, blueEvidenceFault(good), blueEvidenceFault(broken), blueEvidenceFault(sourceChanged)],
  ['PENDING_RECONCILIATION', null, null, null, null])
const baseline = await custodyBlueResolutionService.pendingList()
const pending = baseline.rows.find((row) => row.snapshotId === good.id)
eq('a healthy missing amount exposes only its named ambiguous component for documented proof',
  [pending.status, pending.knownSubtotal, pending.ambiguousLegacyCredit, pending.referenceAmount],
  ['PENDING_RECONCILIATION', 500, 10, null])
const decision = { snapshotId: good.id, managerUserId: manager, password: 'Manager465!',
  decisionKind: 'RECEIVED_CASH', evidenceDay: day, evidenceReference: 'رسید واقعی همان روز برای اعتبار مبهم',
  reason: 'مدیر سند واقعی بخش مبهمِ همان بازه را بررسی کرد', idempotencyKey: 's465:decision:healthy-pending' }
const resolved = await custodyBlueResolutionService.resolve(decision)
eq('documented manager proof resolves ONLY the healthy pending amount',
  [resolved.referenceAmount, resolved.rawDifference, seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', good.id).referenceAmount],
  [510, 10, null])
const trigger = sql.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'custody_blue_snapshot_no_update').sql
const falseScope = JSON.stringify({ filter: { fromJalali: '1400/01/01', toJalali: day } })
const changedScope = JSON.stringify({ filter: { fromJalali: day, toJalali: day, channels: ['RETAIL'] } })
sql.exec('DROP TRIGGER custody_blue_snapshot_no_update')
try {
  sql.prepare('UPDATE "CustodyBlueSnapshot" SET sourceScope=?, evidenceDigest=? WHERE id=?')
    .run(falseScope, blueEvidenceDigest({ ...broken, sourceScope: falseScope }), broken.id)
  sql.prepare('UPDATE "CustodyBlueSnapshot" SET sourceScope=?, evidenceDigest=? WHERE id=?')
    .run(changedScope, blueEvidenceDigest({ ...sourceChanged, sourceScope: changedScope }), sourceChanged.id)
} finally { sql.exec(trigger) }
const invalid = await db.custodyBlueSnapshot.findUnique({ where: { id: broken.id } })
eq('even a recomputed digest does not make a mismatched calendar source valid', blueEvidenceFault(invalid), 'BLUE_SOURCE_SCOPE_INVALID')
eq('same-day filter alteration cannot borrow another report sourceHash',
  blueEvidenceFault(await db.custodyBlueSnapshot.findUnique({ where: { id: sourceChanged.id } })), 'BLUE_SOURCE_HASH_INVALID')
const inventory = await custodyBlueResolutionService.pendingList()
const suspect = inventory.rows.find((row) => row.snapshotId === broken.id)
const changed = inventory.rows.find((row) => row.snapshotId === sourceChanged.id)
eq('ordinary manager queue labels and MASKS corrupt V3 evidence rather than calling it pending',
  [suspect.status, suspect.integrityFault, suspect.countedAmount, suspect.knownSubtotal,
    suspect.ambiguousLegacyCredit, suspect.originalReferenceAmount, suspect.referenceAmount, suspect.decision,
    changed.status, changed.integrityFault, changed.knownSubtotal],
  ['EVIDENCE_QUARANTINED', 'BLUE_SOURCE_SCOPE_INVALID', null, null, null, null, null, null,
    'EVIDENCE_QUARANTINED', 'BLUE_SOURCE_HASH_INVALID', null])
await rejects('old manager money decision cannot consume the corrupt case', 'CUSTODY_EVIDENCE_QUARANTINED',
  () => custodyBlueResolutionService.resolve({ ...decision, snapshotId: broken.id,
    idempotencyKey: 's465:decision:invalid-domain' }))
eq('no second resolution, artificial zero, or fake quarantine event was made by this read',
  [seed.count('CustodyBlueResolution'), seed.count('CustodyEvidenceQuarantine')], [1, 0])
console.log(`\n✓ ${checks} pending-vs-corrupt V3 checks passed`)
