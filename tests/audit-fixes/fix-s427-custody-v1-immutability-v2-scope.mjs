/**
 * A shop already holding V1 snapshots receives a nullable, additive V2 field.
 * Old evidence must NOT acquire an invented zero for a component V1 never
 * measured. Even matching days/shift types are not comparable across formula
 * versions. No historical row is edited to upgrade a manager decision.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s427-custody-v1-immutability-v2-scope.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-version-s427-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'harness.db')
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
const migrations = join(process.cwd(), 'prisma/migrations')
const upgrade = '20271020510000_custody_blue_unknown_destination'
const legacy = new DatabaseSync(join(dir, 'existing-shop.db'))
legacy.exec('PRAGMA foreign_keys = OFF')
for (const name of readdirSync(migrations).filter((name) => /^\d/.test(name) && name < upgrade).sort()) {
  legacy.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
}
legacy.prepare(`INSERT INTO "CustodyBlueSnapshot" (
  "shiftId", "role", "actorUserId", "authMethod", "countOrigin", "humanAmount", "arithmeticAmount",
  "referenceFromDay", "referenceToDay", "scopeKind", "referenceStatus", "referenceAmount",
  "knownSubtotal", "ambiguousLegacyCredit", "calculationVersion", "financialRevision",
  "epochAtCount", "freshStatus", "idempotencyKey", "operationalDay"
) VALUES (12, 'OPENING', 7, 'CUSTODY_PIN', 'EXPLICIT_AMOUNT', 500, 500,
  '1405/07/22', '1405/07/22', 'TODAY', 'AVAILABLE', 500,
  500, 0, 'sales-blue-v1', 1, 1, 'UNKNOWN_NO_REAL_PRIOR_COUNT', 'snapshot:s427:v1', '1405/07/22')`).run()
const before = legacy.prepare('SELECT * FROM "CustodyBlueSnapshot"').get()
legacy.exec(readFileSync(join(migrations, upgrade, 'migration.sql'), 'utf8'))
const after = legacy.prepare('SELECT * FROM "CustodyBlueSnapshot"').get()
const { destinationUnknownReceived, ...originalFields } = after
eq('additive migration leaves every V1 field byte-for-byte unchanged', JSON.stringify(originalFields), JSON.stringify(before))
eq('V1 destination was unrecorded, NOT proven zero', destinationUnknownReceived, null)
let immutable = false
try { legacy.prepare('UPDATE "CustodyBlueSnapshot" SET "referenceAmount"=600 WHERE id=?').run(before.id) } catch { immutable = true }
eq('upgrade does not weaken frozen V1 evidence', immutable, true)

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { recordBlueSnapshot, referenceFromBlueSnapshot } = await import('../../src/main/services/CustodyBlueSnapshotService.ts')
const { calculateCustodyReference } = await import('../../src/shared/custodyReference.ts')
const { observationOf } = await import('../../src/shared/custodyPeriod.ts')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const manager = seed.user('مدیر S427')
const shiftId = seed.insert('Shift', { userId: manager })
const today = toJalaliDate(new Date())
const base = {
  shiftId, role: 'OPENING', actorUserId: manager, authMethod: 'CUSTODY_PIN', countOrigin: 'EXPLICIT_AMOUNT',
  humanAmount: 500, arithmeticAmount: 500, referenceFromDay: today, referenceToDay: today, scopeKind: 'TODAY',
  referenceStatus: 'AVAILABLE', referenceAmount: 500, knownSubtotal: 500, ambiguousLegacyCredit: 0,
  calculationVersion: 'sales-blue-v1', financialRevision: 0, epochAtCount: 1,
  freshStatus: 'UNKNOWN_NO_REAL_PRIOR_COUNT', idempotencyKey: 's427:v1:opening', operationalDay: today,
  at: new Date()
}
const priorId = seed.insert('CustodyBlueSnapshot', base)
const prior = await db.custodyBlueSnapshot.findUnique({ where: { id: priorId } })
eq('V1 frozen row is still readable by Main', referenceFromBlueSnapshot(prior).referenceAmount, 500)
eq('V1 has no destination evidence', referenceFromBlueSnapshot(prior).destinationUnknownReceived, null)
const oldWithDefaultId = seed.insert('CustodyBlueSnapshot', {
  ...base, role: 'RECOVERY', destinationUnknownReceived: 0, idempotencyKey: 's427:v1:default-zero'
})
const oldWithDefault = await db.custodyBlueSnapshot.findUnique({ where: { id: oldWithDefaultId } })
eq('V1 decoder does not mistake a historical default 0 for proof', referenceFromBlueSnapshot(oldWithDefault).destinationUnknownReceived, null)
const v2 = calculateCustodyReference({ cashReceived: 550, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 0, ambiguousLegacyCredit: 0, refundCash: 0, refundCard: 0 })
const next = await recordBlueSnapshot(db, {
  shiftId, role: 'FINAL_CLOSE', actorUserId: manager, count: observationOf(600, false), reference: v2,
  referenceFromDay: today, referenceToDay: today, scopeKind: 'TODAY', financialRevision: 0, epochAtCount: 1,
  prior, idempotencyKey: 's427:v2:close'
})
eq('V2 reference and raw difference remain available', Number(next.rawDifference), 50)
eq('V1 and V2 versions have different comparison scopes', next.freshStatus, 'UNKNOWN_SCOPE_CHANGE')
eq('V2 cannot attribute a made-up fresh difference to the next owner', next.freshDifference, null)
eq('historic V1 amount remains intact after new snapshot', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', priorId).referenceAmount, 500)

await custodyService.setPin({ userId: manager, newPassword: 'Manager427!', currentPassword: '1111' })
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager427!',
  from: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  to: new Date(Date.now() + 24 * 60 * 60_000).toISOString() })
const oldView = report.blueBoundaries.find((row) => row.snapshotId === oldWithDefaultId)
eq('manager report labels old calculation version', oldView?.calculationVersion, 'sales-blue-v1')
eq('manager report does not claim V1 destination is known zero', oldView?.destinationUnknownReceived, null)
const oldPending = seed.insert('CustodyBlueSnapshot', {
  ...base, role: 'RECOVERY', referenceStatus: 'PENDING_RECONCILIATION', referenceAmount: null,
  knownSubtotal: 500, ambiguousLegacyCredit: 20, idempotencyKey: 's427:v1:pending'
})
let code = ''
try {
  await custodyBlueResolutionService.resolve({ snapshotId: oldPending, managerUserId: manager, password: 'Manager427!',
    decisionKind: 'RECEIVED_CASH', evidenceDay: today, evidenceReference: 'old receipt from same day',
    reason: 'Checking a frozen legacy version', idempotencyKey: 's427:v1:decision:blocked' })
} catch (error) { code = error?.code }
eq('new manager decision on V1 requires special manual review', code, 'BLUE_LEGACY_REFERENCE_REVIEW')
eq('rejected decision did not modify old evidence', seed.count('CustodyBlueResolution', 'snapshotId=?', oldPending), 0)
const originalDecision = { snapshotId: oldPending, managerUserId: manager, password: 'Manager427!',
  decisionKind: 'RECEIVED_CARD', evidenceDay: today,
  evidenceReference: 'existing card receipt from old version',
  reason: 'Historical decision from before the upgrade', idempotencyKey: 's427:v1:historic:decision' }
seed.insert('CustodyBlueResolution', {
  snapshotId: oldPending, managerUserId: manager, authMethod: 'MANAGER_CUSTODY_PIN',
  decisionKind: originalDecision.decisionKind, evidenceDay: today,
  evidenceReference: originalDecision.evidenceReference, reason: originalDecision.reason,
  ambiguousAmount: 20, effectiveReferenceAmount: 520, resolvedRawDifference: 20,
  freshStatus: 'UNKNOWN_NO_REAL_PRIOR_COUNT', idempotencyKey: originalDecision.idempotencyKey,
  at: new Date()
})
const replay = await custodyBlueResolutionService.resolve(originalDecision)
eq('an existing V1 decision still replays idempotently after upgrade', replay.replayed, true)
eq('replay does not add a new V1 decision', seed.count('CustodyBlueResolution', 'snapshotId=?', oldPending), 1)
console.log(`\n✓ ${checks} checks passed`)
