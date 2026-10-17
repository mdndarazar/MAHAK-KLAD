import { createHash } from 'node:crypto'
import { CUSTODY_REFERENCE_LEGACY_VERSION, CUSTODY_REFERENCE_PREVIOUS_VERSION, CUSTODY_REFERENCE_VERSION, custodyReferenceWarnings } from '@shared/custodyReference'
import { isValidJalaliDate } from '@shared/jalali'

const versions = [CUSTODY_REFERENCE_LEGACY_VERSION, CUSTODY_REFERENCE_PREVIOUS_VERSION, CUSTODY_REFERENCE_VERSION]
const money = (raw: unknown): number | null => {
  if (raw == null || !['number', 'bigint', 'string'].includes(typeof raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}
const serial = (raw: any) => raw == null ? null : typeof raw === 'bigint' ? raw.toString() : raw
const monetaryFields = new Set(['humanAmount', 'arithmeticAmount', 'referenceAmount', 'knownSubtotal',
  'destinationUnknownReceived', 'ambiguousLegacyCredit', 'rawDifference', 'inheritedDifference', 'freshDifference'])

/** Seal values that must never be borrowed from a different source or handover.
 * No database-generated ID/time is needed: identical retries yield identical
 * evidence, and V1/V2 rows with no digest remain readable with structural checks. */
export function blueEvidenceDigest(row: any): string {
  const fields = ['handoverId', 'shiftId', 'role', 'actorUserId', 'authMethod', 'countOrigin',
    'humanAmount', 'arithmeticAmount', 'referenceFromDay', 'referenceToDay', 'scopeKind',
    'referenceStatus', 'referenceAmount', 'knownSubtotal', 'destinationUnknownReceived',
    'ambiguousLegacyCredit', 'calculationVersion', 'sourceScope', 'sourceHash',
    'financialRevision', 'epochAtCount', 'priorSnapshotId', 'rawDifference',
    'inheritedDifference', 'freshDifference', 'freshStatus', 'operationalDay', 'idempotencyKey']
  // Prisma reads BIGINT as bigint; the SQLite harness and some import readers
  // may return safe integers as number. The digest must seal the SAME amount
  // independent of the runtime representation, including an explicit zero.
  return createHash('sha256').update(JSON.stringify(fields.map((key) =>
    monetaryFields.has(key) && row[key] != null ? String(row[key]) : serial(row[key])
  ))).digest('hex')
}

/** A NULL amount is a pending reference only if the version, calendar scope,
 * source and physical/link evidence are otherwise sound. V1 lacked an unknown-
 * destination column; do not reinterpret or rewrite it as V3. */
export function blueEvidenceFault(row: any): string | null {
  if (!row || !versions.includes(row.calculationVersion)) return 'BLUE_VERSION_INVALID'
  if (!['OUT', 'IN', 'OPENING', 'FINAL_CLOSE', 'RECOVERY'].includes(row.role)) return 'BLUE_ROLE_INVALID'
  if (!isValidJalaliDate(row.referenceFromDay) || !isValidJalaliDate(row.referenceToDay) ||
      row.referenceFromDay > row.referenceToDay || row.referenceToDay !== row.operationalDay ||
      !['TODAY', 'PRIOR_AND_TODAY'].includes(row.scopeKind) ||
      (row.scopeKind === 'TODAY' && row.referenceFromDay !== row.referenceToDay) ||
      (row.scopeKind === 'PRIOR_AND_TODAY' && row.referenceFromDay === row.referenceToDay)) return 'BLUE_SCOPE_INVALID'
  const amount = money(row.referenceAmount)
  if (row.referenceStatus === 'AVAILABLE' ? amount == null :
      row.referenceStatus !== 'PENDING_RECONCILIATION' || row.referenceAmount != null) return 'BLUE_AMOUNT_STATUS_INVALID'
  if ([row.knownSubtotal, row.destinationUnknownReceived, row.ambiguousLegacyCredit,
    row.rawDifference, row.inheritedDifference, row.freshDifference]
    .some((value) => value != null && money(value) == null)) return 'BLUE_AMOUNT_UNSAFE'
  if ([row.destinationUnknownReceived, row.ambiguousLegacyCredit].some((v) => v != null && money(v)! < 0))
    return 'BLUE_COMPONENT_INVALID'
  const versionWithDestination = row.calculationVersion !== CUSTODY_REFERENCE_LEGACY_VERSION
  if (versionWithDestination && row.knownSubtotal != null &&
      (row.destinationUnknownReceived == null || row.ambiguousLegacyCredit == null)) return 'BLUE_COMPONENT_MISSING'
  if (versionWithDestination && row.referenceStatus === 'AVAILABLE' && row.knownSubtotal != null &&
      (amount !== money(row.knownSubtotal) || money(row.destinationUnknownReceived) !== 0 ||
       money(row.ambiguousLegacyCredit) !== 0)) return 'BLUE_REFERENCE_INCONSISTENT'
  if (row.calculationVersion === CUSTODY_REFERENCE_VERSION) {
    if (row.referenceStatus === 'AVAILABLE' && row.knownSubtotal == null ||
        row.knownSubtotal == null && (row.destinationUnknownReceived != null || row.ambiguousLegacyCredit != null) ||
        row.referenceStatus === 'PENDING_RECONCILIATION' && row.knownSubtotal != null &&
          money(row.destinationUnknownReceived) === 0 && money(row.ambiguousLegacyCredit) === 0)
      return 'BLUE_REFERENCE_INCONSISTENT'
    if (!['CALCULATED', 'NO_NEW_DIFFERENCE', 'UNKNOWN_REFERENCE_PENDING', 'UNKNOWN_SCOPE_CHANGE',
      'UNKNOWN_NO_REAL_PRIOR_COUNT', 'UNKNOWN_NO_REAL_END_COUNT'].includes(row.freshStatus) ||
        row.freshStatus === 'NO_NEW_DIFFERENCE' && money(row.freshDifference) !== 0 ||
        row.freshStatus === 'CALCULATED' && row.freshDifference == null ||
        !['NO_NEW_DIFFERENCE', 'CALCULATED'].includes(row.freshStatus) && row.freshDifference != null ||
        row.referenceStatus === 'PENDING_RECONCILIATION' && row.freshStatus !== 'UNKNOWN_REFERENCE_PENDING' ||
        row.priorSnapshotId == null &&
          (row.inheritedDifference != null || row.freshDifference != null ||
            !['UNKNOWN_NO_REAL_PRIOR_COUNT', 'UNKNOWN_REFERENCE_PENDING'].includes(row.freshStatus)))
      return 'BLUE_DIFFERENCE_STATUS_INVALID'
  }
  const absent = ['ABSENT_UNCOUNTED', 'SYSTEM_ABSENCE_ZERO'].includes(row.countOrigin)
  if (absent) {
    if (row.role !== 'OUT' || row.humanAmount != null || row.arithmeticAmount != null ||
        !['SYSTEM_ABSENCE', 'SYSTEM_ABSENCE_ZERO'].includes(row.authMethod) ||
        row.calculationVersion === CUSTODY_REFERENCE_VERSION &&
          (row.countOrigin !== 'ABSENT_UNCOUNTED' || row.authMethod !== 'SYSTEM_ABSENCE'))
      return 'BLUE_ABSENCE_INVALID'
  } else if (row.countOrigin === 'EMPTY_OPTIONAL') {
    if (row.humanAmount != null || row.arithmeticAmount != null || row.role !== 'OPENING') return 'BLUE_COUNT_INVALID'
  } else {
    const physical = money(row.humanAmount)
    if (physical == null || physical < 0 || physical !== money(row.arithmeticAmount) ||
        row.countOrigin !== (physical === 0 ? 'EXPLICIT_ZERO' : 'EXPLICIT_AMOUNT')) return 'BLUE_COUNT_INVALID'
  }
  if (!Number.isSafeInteger(row.financialRevision) || row.financialRevision < 0 ||
      !Number.isSafeInteger(row.epochAtCount) || row.epochAtCount < 0) return 'BLUE_REVISION_INVALID'
  if (row.calculationVersion === CUSTODY_REFERENCE_VERSION) {
    const human = money(row.humanAmount)
    const expectedRaw = human == null || amount == null ? null : human - amount
    if (expectedRaw != null && !Number.isSafeInteger(expectedRaw) ||
        money(row.rawDifference) !== expectedRaw) return 'BLUE_RAW_DIFFERENCE_INVALID'
    if (row.evidenceDigest !== blueEvidenceDigest(row)) return 'BLUE_DIGEST_INVALID'
    if (row.sourceScope != null || row.sourceHash != null) {
      if (typeof row.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceHash) ||
          typeof row.sourceScope !== 'string' || row.sourceScope.length > 10_000) return 'BLUE_SOURCE_INVALID'
      try {
        const source = JSON.parse(row.sourceScope)
        if (!source?.filter || source.filter.fromJalali !== row.referenceFromDay ||
            source.filter.toJalali !== row.referenceToDay) return 'BLUE_SOURCE_SCOPE_INVALID'
      } catch { return 'BLUE_SOURCE_SCOPE_INVALID' }
      // SalesService sealed { scope, reference } when it finished the full
      // accounting report. Validate that the SAVED known/ambiguous components
      // still correspond to that hash, even when someone recomputes the outer
      // snapshot digest. Never re-read mutable sales to rewrite a frozen amount.
      if (row.knownSubtotal != null) {
        const sourceReference = {
          status: row.referenceStatus, referenceAmount: amount,
          knownSubtotal: money(row.knownSubtotal),
          destinationUnknownReceived: money(row.destinationUnknownReceived),
          ambiguousLegacyCredit: money(row.ambiguousLegacyCredit),
          calculationVersion: CUSTODY_REFERENCE_VERSION,
          warnings: custodyReferenceWarnings(Number(row.ambiguousLegacyCredit), Number(row.destinationUnknownReceived))
        }
        if (row.sourceHash !== createHash('sha256').update(JSON.stringify({
          scope: row.sourceScope, reference: sourceReference
        })).digest('hex')) return 'BLUE_SOURCE_HASH_INVALID'
      }
    } else if (row.referenceStatus === 'AVAILABLE' || row.knownSubtotal != null)
      return 'BLUE_SOURCE_MISSING'
  }
  return null
}

/** All OUT/IN links must match in identity, period, report-source, revision and
 * frozen money. A mismatched pair cannot be passed to referenceFromBlueSnapshot
 * or displayed as a completed F10 outcome. */
export function bluePairFault(out: any, incoming: any, handover: any): string | null {
  if (!out || !incoming || !handover) return 'BLUE_PAIR_MISSING'
  const badOut = blueEvidenceFault(out), badIn = blueEvidenceFault(incoming)
  if (badOut || badIn) return badOut ?? badIn
  const absent = ['ABSENT_UNCOUNTED', 'SYSTEM_ABSENCE_ZERO'].includes(out.countOrigin)
  if (out.role !== 'OUT' || incoming.role !== 'IN' || out.handoverId !== handover.id ||
      incoming.handoverId !== handover.id || out.shiftId !== handover.fromShiftId ||
      incoming.shiftId !== (absent ? handover.toShiftId : handover.fromShiftId) &&
        // Frozen V1 normal IN evidence could live on the incoming Shift.
        !(incoming.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION && incoming.shiftId === handover.toShiftId) ||
      incoming.priorSnapshotId !== out.id || out.actorUserId !== (absent ? handover.selectedRecipientUserId : handover.fromUserId) ||
      incoming.actorUserId !== handover.selectedRecipientUserId) return 'BLUE_PAIR_LINK_INVALID'
  for (const key of ['calculationVersion', 'referenceFromDay', 'referenceToDay', 'scopeKind',
    'referenceStatus', 'sourceScope', 'sourceHash', 'financialRevision', 'referenceAmount',
    'knownSubtotal', 'destinationUnknownReceived', 'ambiguousLegacyCredit']) {
    const left = monetaryFields.has(key) && out[key] != null ? String(out[key]) : serial(out[key])
    const right = monetaryFields.has(key) && incoming[key] != null ? String(incoming[key]) : serial(incoming[key])
    if (left !== right) return 'BLUE_PAIR_SCOPE_AMOUNT_INVALID'
  }
  if (incoming.calculationVersion === CUSTODY_REFERENCE_VERSION &&
      (money(incoming.inheritedDifference) !== money(out.rawDifference) ||
        incoming.referenceStatus === 'PENDING_RECONCILIATION' &&
          incoming.freshStatus !== 'UNKNOWN_REFERENCE_PENDING')) return 'BLUE_PAIR_DIFFERENCE_INVALID'
  return null
}
