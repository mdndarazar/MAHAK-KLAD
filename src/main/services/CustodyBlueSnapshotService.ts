import { BusinessError } from '../errors'
import { CUSTODY_REFERENCE_VERSION, CUSTODY_REFERENCE_LEGACY_VERSION, type CustodyReference } from '@shared/custodyReference'
import { observationOf, systemAbsenceZero, reconcileCustodyPeriod, type CustodyObservation } from '@shared/custodyPeriod'
import { isValidJalaliDate } from '@shared/jalali'

function safeMoney(raw: unknown): number | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new BusinessError('مبلغ سند مرجع از محدودهٔ امن ریال خارج است.', 'BLUE_MONEY_UNSAFE')
  return n
}
export function referenceFromBlueSnapshot(row: any): CustodyReference {
  if (row.calculationVersion !== CUSTODY_REFERENCE_VERSION && row.calculationVersion !== CUSTODY_REFERENCE_LEGACY_VERSION)
    throw new BusinessError('نسخهٔ سند مرجع تحویل با نسخهٔ برنامه متفاوت است.', 'BLUE_VERSION_MISMATCH')
  return {
    status: row.referenceStatus,
    referenceAmount: safeMoney(row.referenceAmount),
    knownSubtotal: safeMoney(row.knownSubtotal),
    // V1 never measured this component; even a default 0 in an intermediate
    // database means "not recorded", not proof of no unknown-destination cash.
    destinationUnknownReceived: row.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : safeMoney(row.destinationUnknownReceived),
    ambiguousLegacyCredit: safeMoney(row.ambiguousLegacyCredit),
    calculationVersion: row.calculationVersion,
    sourceScope: row.sourceScope ?? undefined,
    sourceHash: row.sourceHash ?? undefined,
    warnings: []
  }
}
export function countFromBlueSnapshot(row: any): CustodyObservation {
  if (row.countOrigin === 'SYSTEM_ABSENCE_ZERO') return systemAbsenceZero()
  if (row.countOrigin === 'EMPTY_OPTIONAL') return observationOf(null, true)
  const amount = safeMoney(row.humanAmount)
  if (amount == null) throw new BusinessError('شمارش واقعی در سند مرجع مبلغ ندارد.', 'BLUE_COUNT_INVALID')
  const count = observationOf(amount, false)
  if (count.origin !== row.countOrigin) throw new BusinessError('منشأ شمارش واقعی با مبلغ ثبت‌شده سازگار نیست.', 'BLUE_COUNT_INVALID')
  return count
}
export function blueScopeKey(row: { referenceFromDay: string; referenceToDay: string; scopeKind: string; calculationVersion: string }) {
  return `${row.referenceFromDay}:${row.referenceToDay}:${row.scopeKind}:${row.calculationVersion}`
}

/** One transactional, append-only observation of the SAME report scope/version
 * used for the visible blue number. It never modifies cash-only/aggregate-v2
 * history and never claims a new discrepancy without a real comparable start. */
export async function recordBlueSnapshot(tx: any, input: {
  handoverId?: number | null
  shiftId: number
  role: 'OUT' | 'IN' | 'OPENING' | 'RECOVERY' | 'FINAL_CLOSE'
  actorUserId: number
  /** Absent outgoing party is SYSTEM provenance, never their unentered PIN. */
  authMethod?: 'CUSTODY_PIN' | 'MANAGER_CUSTODY_PIN' | 'SYSTEM_ABSENCE_ZERO'
  count: CustodyObservation
  reference: CustodyReference
  referenceFromDay: string
  referenceToDay: string
  scopeKind: 'PRIOR_AND_TODAY' | 'TODAY'
  financialRevision: number
  epochAtCount: number
  prior: any | null
  idempotencyKey: string
}) {
  const { reference, count } = input
  const authMethod = input.authMethod ?? 'CUSTODY_PIN'
  if ((count.origin === 'SYSTEM_ABSENCE_ZERO') !== (authMethod === 'SYSTEM_ABSENCE_ZERO') ||
      (count.origin === 'SYSTEM_ABSENCE_ZERO' && input.role !== 'OUT'))
    throw new BusinessError('صفر سیستمی فقط شاهد غیبتِ خروجی است، نه شمارش انسانی یا PIN فرد غایب.', 'BLUE_ABSENCE_ORIGIN_INVALID')
  if (!isValidJalaliDate(input.referenceFromDay) || !isValidJalaliDate(input.referenceToDay) || input.referenceFromDay > input.referenceToDay)
    throw new BusinessError('دامنهٔ سند مرجع حضانت نامعتبر است.', 'BLUE_SCOPE_INVALID')
  if (reference.calculationVersion !== CUSTODY_REFERENCE_VERSION ||
      (reference.status === 'AVAILABLE' && reference.referenceAmount == null) ||
      (reference.status === 'PENDING_RECONCILIATION' && reference.referenceAmount != null))
    throw new BusinessError('مبلغ و وضعیت مرجع با یکدیگر سازگار نیستند.', 'BLUE_REFERENCE_INVALID')
  if (!Number.isSafeInteger(input.financialRevision) || input.financialRevision < 0 ||
      !Number.isSafeInteger(input.epochAtCount) || input.epochAtCount < 0)
    throw new BusinessError('نسخهٔ مالی سند شمارش نامعتبر است.', 'BLUE_REVISION_INVALID')
  const scopeKey = blueScopeKey({ ...input, calculationVersion: reference.calculationVersion })
  const result = reconcileCustodyPeriod({
    start: input.prior ? {
      count: countFromBlueSnapshot(input.prior),
      reference: referenceFromBlueSnapshot(input.prior),
      scopeKey: blueScopeKey(input.prior)
    } : null,
    end: { count, reference, scopeKey }
  })
  const toBigInt = (value: number | null) => value == null ? null : BigInt(value)
  return tx.custodyBlueSnapshot.create({ data: {
    handoverId: input.handoverId ?? null,
    shiftId: input.shiftId, role: input.role,
    actorUserId: input.actorUserId, authMethod,
    countOrigin: count.origin,
    humanAmount: toBigInt(count.humanAmount), arithmeticAmount: toBigInt(count.arithmeticAmount),
    referenceFromDay: input.referenceFromDay, referenceToDay: input.referenceToDay,
    scopeKind: input.scopeKind,
    referenceStatus: reference.status,
    referenceAmount: toBigInt(reference.referenceAmount),
    knownSubtotal: toBigInt(reference.knownSubtotal),
    destinationUnknownReceived: toBigInt(reference.destinationUnknownReceived),
    ambiguousLegacyCredit: toBigInt(reference.ambiguousLegacyCredit),
    calculationVersion: CUSTODY_REFERENCE_VERSION,
    sourceScope: reference.sourceScope ?? null,
    sourceHash: reference.sourceHash ?? null,
    financialRevision: input.financialRevision,
    epochAtCount: input.epochAtCount,
    priorSnapshotId: input.prior?.id ?? null,
    rawDifference: toBigInt(result.rawDifference),
    inheritedDifference: toBigInt(result.inheritedDifference),
    freshDifference: toBigInt(result.freshDifference),
    freshStatus: result.freshStatus,
    idempotencyKey: input.idempotencyKey,
    operationalDay: input.referenceToDay
  } })
}
