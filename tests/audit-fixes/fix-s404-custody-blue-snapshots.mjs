/** Append-only snapshot persistence and daily/inherited reconciliation. */
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-snapshots-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { calculateCustodyReference, pendingCustodyReference } = await import('../../src/shared/custodyReference.ts')
const { observationOf } = await import('../../src/shared/custodyPeriod.ts')
const { recordBlueSnapshot } = await import('../../src/main/services/CustodyBlueSnapshotService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const day = toJalaliDate(new Date())
let checked = 0
const eq = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checked++; console.log(`  ✓ ${label}`)
}
const ref = (amount) => {
  const reference = calculateCustodyReference({ cashReceived: amount, cardReceived: 0, otherReceived: 0,
    destinationUnknownReceived: 0, ambiguousLegacyCredit: 0, refundCash: 0, refundCard: 0 })
  const sourceScope = JSON.stringify({ filter: { fromJalali: day, toJalali: day } })
  return { ...reference, sourceScope,
    sourceHash: createHash('sha256').update(JSON.stringify({ scope: sourceScope, reference })).digest('hex') }
}
const make = (shiftId, amount, report, prior, role) => recordBlueSnapshot(db, {
  shiftId, role, actorUserId: 1, count: observationOf(amount, false),
  reference: report, referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY',
  financialRevision: 1, epochAtCount: 2, prior, idempotencyKey: `s404:${shiftId}:${role}`
})
const morning = await make(1, 18_481_000, ref(19_481_000), null, 'OPENING')
const noon = await make(1, 18_481_000, ref(19_481_000), morning, 'OUT')
eq('prior shortage is still visible as raw', Number(noon.rawDifference), -1_000_000)
eq('the inherited shortage is separate', Number(noon.inheritedDifference), -1_000_000)
eq('no new shortage when nothing changed', Number(noon.freshDifference), 0)
eq('neutral fresh status', noon.freshStatus, 'NO_NEW_DIFFERENCE')
const evening = await make(2, 27_481_000, ref(29_481_000), noon, 'IN')
eq('evening raw -2M', Number(evening.rawDifference), -2_000_000)
eq('evening fresh only -1M', Number(evening.freshDifference), -1_000_000)
eq('evening snapshot retains prior id', evening.priorSnapshotId, noon.id)
const pending = await make(3, 501_000_000, pendingCustodyReference('missing financial source'), null, 'RECOVERY')
eq('unavailable reference persisted as null', pending.referenceAmount, null)
eq('unknown raw persisted as null', pending.rawDifference, null)
eq('unknown fresh persisted as null', pending.freshDifference, null)
try { db.$harness.db.prepare('UPDATE "CustodyBlueSnapshot" SET humanAmount=500000000 WHERE id=?').run(pending.id); throw new Error('mutation accepted') }
catch (error) { eq('physical count cannot be silently rewritten', String(error.message).includes('append-only'), true) }
console.log(`\n✓ ${checked} checks passed`)
