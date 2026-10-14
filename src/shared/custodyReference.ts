/**
 * The blue sales-report figure is the *only* custody reference.  This pure
 * calculation is shared by Main and the renderer.  A known subtotal is not an
 * official reference when an old, destination-less CREDIT payment or an
 * incomplete accounting read could still change it.  Never turn that case into
 * either a zero difference or an accusation against the next custodian.
 */
import { physicalMoneyInDrawerAndCard } from './accounting'

export const CUSTODY_REFERENCE_VERSION = 'sales-blue-v1' as const

export type CustodyReferenceStatus = 'AVAILABLE' | 'PENDING_RECONCILIATION'

export type CustodyReference = {
  status: CustodyReferenceStatus
  /** Null is an unknown reference, not zero. */
  referenceAmount: number | null
  /** Only complete accounting statements may supply a known subtotal. */
  knownSubtotal: number | null
  ambiguousLegacyCredit: number | null
  calculationVersion: typeof CUSTODY_REFERENCE_VERSION
  /** Report filter/date scope; this fingerprint identifies aggregate values,
   * NOT a transaction revision. A future persisted handover must also fence
   * concurrent financial writes before treating the snapshot as frozen. */
  sourceScope?: string
  sourceHash?: string
  warnings: string[]
}

export function calculateCustodyReference(input: {
  cashReceived: number
  cardReceived: number
  otherReceived: number
  destinationUnknownReceived: number
  ambiguousLegacyCredit: number
  refundCash: number
  refundCard: number
}): CustodyReference {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`جزء ${name} در مرجع صندوق مبلغ صحیح ریالی نیست.`)
  }
  const received = input.cashReceived + input.cardReceived + input.otherReceived + input.destinationUnknownReceived
  if (!Number.isSafeInteger(received)) throw new RangeError('دریافتی مرجع از سقف امن ریالی خارج است.')
  const knownSubtotal = physicalMoneyInDrawerAndCard({
    receivedTotal: received,
    refundCashTotal: input.refundCash,
    refundCardTotal: input.refundCard
  })
  if (!Number.isSafeInteger(knownSubtotal)) throw new RangeError('مرجع از سقف امن ریالی خارج است.')
  const pending = input.ambiguousLegacyCredit > 0
  return {
    status: pending ? 'PENDING_RECONCILIATION' : 'AVAILABLE',
    referenceAmount: pending ? null : knownSubtotal,
    knownSubtotal,
    ambiguousLegacyCredit: input.ambiguousLegacyCredit,
    calculationVersion: CUSTODY_REFERENCE_VERSION,
    warnings: pending
      ? ['پرداخت اعتباری قدیمی بدون مقصد روشن وجود دارد؛ بخش معلوم نمایش داده می‌شود اما مرجع و اختلاف قطعی تا بررسی آن در انتظار است.']
      : []
  }
}

export function pendingCustodyReference(reason: string): CustodyReference {
  return {
    status: 'PENDING_RECONCILIATION',
    referenceAmount: null,
    knownSubtotal: null,
    ambiguousLegacyCredit: null,
    calculationVersion: CUSTODY_REFERENCE_VERSION,
    warnings: [reason]
  }
}
