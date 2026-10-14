import { CUSTODY_REFERENCE_VERSION, type CustodyReference } from './custodyReference'
import type { CustodyObservation } from './custodyPeriod'
import { reconcileCustodyPeriod, type CustodyPeriodResult } from './custodyPeriod'

export type CustodyBlueDecision = 'RECEIVED_CASH' | 'RECEIVED_CARD' | 'NOT_RECEIVED'
export type CustodyCreditDecision = CustodyBlueDecision | 'NO_LEGACY_CREDIT'

/** Apply documented proof to every ambiguous component of ONE frozen snapshot
 * in memory. CREDIT/null and UNKNOWN destination are different questions: no
 * partial decision may turn the whole reference AVAILABLE. Persistence MUST
 * append a separate resolution; never edit a payment, count or responsibility. */
export function resolvedCustodySnapshot(input: {
  reference: CustodyReference
  count: CustodyObservation
  scopeKey: string
  start: { reference: CustodyReference; count: CustodyObservation; scopeKey: string } | null
  /** Historical CREDIT/null outcome, or NO_LEGACY_CREDIT if its amount is 0. */
  decision?: CustodyCreditDecision
  /** Independent proof of where the destination-less receipt went. */
  destinationDecision?: CustodyBlueDecision
}): { effectiveReferenceAmount: number; comparison: CustodyPeriodResult } {
  const { reference, count, start, scopeKey, decision, destinationDecision } = input
  const known = reference.knownSubtotal
  const credit = reference.ambiguousLegacyCredit
  const destination = reference.destinationUnknownReceived
  if (reference.calculationVersion !== CUSTODY_REFERENCE_VERSION)
    throw new RangeError('سند نسخهٔ قدیمی مقصد نامشخص را ثبت نکرده است و با فرمول جدید قابل حل خودکار نیست.')
  if (reference.status !== 'PENDING_RECONCILIATION' || known == null || credit == null || destination == null ||
      !Number.isSafeInteger(known) || !Number.isSafeInteger(credit) || credit < 0 ||
      !Number.isSafeInteger(destination) || destination < 0 || (credit === 0 && destination === 0))
    throw new RangeError('فقط سند مرجعِ مبهمِ دارای بخش معلوم و مبلغ مبهم مشخص با شاهد مدیر قابل حل است.')
  const allowed = ['RECEIVED_CASH', 'RECEIVED_CARD', 'NOT_RECEIVED']
  if (credit > 0 ? !decision || !allowed.includes(decision)
    : decision != null && decision !== 'NO_LEGACY_CREDIT')
    throw new RangeError('نوع تصمیم پرداخت اعتباری نامعتبر است؛ هر جزء مبهم شاهد مستقل می‌خواهد.')
  if (destination > 0 ? !destinationDecision || !allowed.includes(destinationDecision)
    : destinationDecision != null)
    throw new RangeError('نوع تصمیم مقصد نامشخص نامعتبر است؛ این وجه جداگانه باید ثابت شود.')
  const effectiveReferenceAmount = known +
    (credit > 0 && decision !== 'NOT_RECEIVED' ? credit : 0) +
    (destination > 0 && destinationDecision !== 'NOT_RECEIVED' ? destination : 0)
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
