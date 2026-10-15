import type { CustodyReference } from './custodyReference'

/** Absence has NO monetary value. The old ZERO-named provenance is read only
 * for append-only historical rows; new absences use ABSENT_UNCOUNTED. */
export type CustodyCountOrigin = 'EXPLICIT_AMOUNT' | 'EXPLICIT_ZERO' | 'EMPTY_OPTIONAL' | 'ABSENT_UNCOUNTED' | 'SYSTEM_ABSENCE_ZERO'
export function isAbsentUncounted(origin: unknown): boolean {
  return origin === 'ABSENT_UNCOUNTED' || origin === 'SYSTEM_ABSENCE_ZERO'
}
export type CustodyObservation = {
  origin: CustodyCountOrigin
  /** Nullable for an empty optional input or system absence; zero may be explicit. */
  humanAmount: number | null
  /** A blank optional field uses zero in legacy-compatible arithmetic only. */
  arithmeticAmount: number | null
}

export function observationOf(raw: unknown, optional: boolean): CustodyObservation {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    if (!optional) throw new RangeError('مبلغ واقعیِ شمارش را وارد کنید؛ صفر را باید صریحاً بنویسید.')
    return { origin: 'EMPTY_OPTIONAL', humanAmount: null, arithmeticAmount: 0 }
  }
  if (typeof raw !== 'number' && typeof raw !== 'string')
    throw new RangeError('مبلغ شمارش باید عدد صحیح ریالی باشد.')
  const text = typeof raw === 'string' ? raw.trim() : raw
  const amount = Number(text)
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('مبلغ شمارش باید عدد صحیحِ صفر یا بیشتر باشد.')
  return { origin: amount === 0 ? 'EXPLICIT_ZERO' : 'EXPLICIT_AMOUNT', humanAmount: amount, arithmeticAmount: amount }
}

/** No previous person's PIN or count; even arithmetic stays unknown. */
export function absenceUncounted(): CustodyObservation {
  return { origin: 'ABSENT_UNCOUNTED', humanAmount: null, arithmeticAmount: null }
}

/** Historic append-only V1 provenance; never emit on a NEW absence. */
export function systemAbsenceZero(): CustodyObservation {
  return { origin: 'SYSTEM_ABSENCE_ZERO', humanAmount: null, arithmeticAmount: null }
}

export type FreshDifferenceStatus =
  | 'CALCULATED'
  | 'NO_NEW_DIFFERENCE'
  | 'UNKNOWN_REFERENCE_PENDING'
  | 'UNKNOWN_SCOPE_CHANGE'
  | 'UNKNOWN_NO_REAL_PRIOR_COUNT'
  | 'UNKNOWN_NO_REAL_END_COUNT'

export type CustodyPeriodResult = {
  rawDifference: number | null
  priorRawDifference: number | null
  inheritedDifference: number | null
  freshDifference: number | null
  freshStatus: FreshDifferenceStatus
}

/**
 * Compare official blue snapshots, never manager cash movements or a guessed
 * previous shortage. Scope keys identify a comparable daily report lineage,
 * not the evolving `toAt` timestamp. A combined prior-day+today morning
 * snapshot and a today-only noon snapshot cannot be subtracted.
 */
export function reconcileCustodyPeriod(input: {
  start: { count: CustodyObservation; reference: CustodyReference; scopeKey: string } | null
  end: { count: CustodyObservation; reference: CustodyReference; scopeKey: string }
}): CustodyPeriodResult {
  const { start, end } = input
  const rawDifference = end.count.humanAmount == null || end.reference.referenceAmount == null
    ? null : end.count.humanAmount - end.reference.referenceAmount
  const priorRawDifference = start?.count.humanAmount == null || start.reference.referenceAmount == null
    ? null : start.count.humanAmount - start.reference.referenceAmount
  const inheritedDifference = priorRawDifference
  let freshStatus: FreshDifferenceStatus = 'CALCULATED'
  if (end.reference.referenceAmount == null || (start && start.reference.referenceAmount == null))
    freshStatus = 'UNKNOWN_REFERENCE_PENDING'
  else if (start && start.scopeKey !== end.scopeKey)
    freshStatus = 'UNKNOWN_SCOPE_CHANGE'
  else if (!start || start.count.humanAmount == null)
    freshStatus = 'UNKNOWN_NO_REAL_PRIOR_COUNT'
  else if (end.count.humanAmount == null)
    freshStatus = 'UNKNOWN_NO_REAL_END_COUNT'
  const freshDifference = freshStatus !== 'CALCULATED' || rawDifference == null || priorRawDifference == null
    ? null : rawDifference - priorRawDifference
  if (freshDifference === 0) freshStatus = 'NO_NEW_DIFFERENCE'
  return { rawDifference, priorRawDifference, inheritedDifference, freshDifference, freshStatus }
}
