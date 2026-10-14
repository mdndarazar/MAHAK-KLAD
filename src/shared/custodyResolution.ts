import type { CustodyReference } from './custodyReference'
import type { CustodyObservation } from './custodyPeriod'
import { reconcileCustodyPeriod, type CustodyPeriodResult } from './custodyPeriod'

export type CustodyBlueDecision = 'RECEIVED_CASH' | 'RECEIVED_CARD' | 'NOT_RECEIVED'

/** Apply a manager's documented decision to a frozen snapshot in memory.
 * Persistence MUST append a new resolution, never edit the original reference,
 * count, payment, operational day, or custody responsibility. */
export function resolvedCustodySnapshot(input: {
  reference: CustodyReference
  count: CustodyObservation
  scopeKey: string
  start: { reference: CustodyReference; count: CustodyObservation; scopeKey: string } | null
  decision: CustodyBlueDecision
}): { effectiveReferenceAmount: number; comparison: CustodyPeriodResult } {
  const { reference, count, start, scopeKey, decision } = input
  const known = reference.knownSubtotal
  const ambiguous = reference.ambiguousLegacyCredit
  if (reference.status !== 'PENDING_RECONCILIATION' || known == null || ambiguous == null || ambiguous <= 0 ||
      !Number.isSafeInteger(known) || !Number.isSafeInteger(ambiguous))
    throw new RangeError('فقط سند مرجعِ مبهمِ دارای بخش معلوم با شاهد مدیر قابل حل است.')
  if (!['RECEIVED_CASH', 'RECEIVED_CARD', 'NOT_RECEIVED'].includes(decision))
    throw new RangeError('نوع سند رفع ابهام نامعتبر است.')
  const effectiveReferenceAmount = decision === 'NOT_RECEIVED' ? known : known + ambiguous
  if (!Number.isSafeInteger(effectiveReferenceAmount))
    throw new RangeError('جمع مرجعِ حل‌شده از سقف امن ریالی خارج است.')
  const effectiveReference: CustodyReference = {
    ...reference, status: 'AVAILABLE', referenceAmount: effectiveReferenceAmount,
    warnings: []
  }
  return {
    effectiveReferenceAmount,
    comparison: reconcileCustodyPeriod({ start, end: { reference: effectiveReference, count, scopeKey } })
  }
}
