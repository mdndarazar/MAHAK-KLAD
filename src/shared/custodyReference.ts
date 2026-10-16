/**
 * The blue sales-report figure is the *only* custody reference.  This pure
 * calculation is shared by Main and the renderer. A known subtotal is not an
 * official reference when a destination-less legacy CREDIT, a received amount
 * with UNKNOWN destination, or an incomplete accounting read could change it.
 * Never turn that into a zero difference or blame for the next custodian.
 */
import { physicalMoneyInDrawerAndCard } from './accounting'

/** V3 keeps V2's corrected accounting formula, but seals the new witness and
 * verifies its domain/links before it governs another operation. Frozen V1/V2
 * evidence stays readable on its original terms, never relabeled as V3. */
export const CUSTODY_REFERENCE_VERSION = 'sales-blue-v3' as const
export const CUSTODY_REFERENCE_PREVIOUS_VERSION = 'sales-blue-v2' as const
export const CUSTODY_REFERENCE_LEGACY_VERSION = 'sales-blue-v1' as const
export type CustodyReferenceVersion = typeof CUSTODY_REFERENCE_VERSION | typeof CUSTODY_REFERENCE_PREVIOUS_VERSION | typeof CUSTODY_REFERENCE_LEGACY_VERSION

export type CustodyReferenceStatus = 'AVAILABLE' | 'PENDING_RECONCILIATION'

export type CustodyReference = {
  status: CustodyReferenceStatus
  /** Null is an unknown reference, not zero. */
  referenceAmount: number | null
  /** Only complete accounting statements may supply a known subtotal. */
  knownSubtotal: number | null
  /** Destination-less received cash/cheque: not proved to be in the shop. This
   * is a DIFFERENT ambiguity from a historical CREDIT/null payment. */
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  calculationVersion: CustodyReferenceVersion
  /** Report filter/date scope; this fingerprint identifies aggregate values,
   * NOT a transaction revision. A future persisted handover must also fence
   * concurrent financial writes before treating the snapshot as frozen. */
  sourceScope?: string
  sourceHash?: string
  warnings: string[]
}

/** An absent or incomplete verdict cannot borrow a page subtotal as the blue
 * custody reference. Explicit official zero is different from missing data. */
export function availableCustodyReferenceAmount(reference?: CustodyReference | null): number | null {
  return reference?.status === 'AVAILABLE' && reference.referenceAmount != null && Number.isSafeInteger(reference.referenceAmount)
    ? reference.referenceAmount
    : null
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
  // Do not change the other terms of the established blue formula. Accounting
  // deliberately excludes UNKNOWN destination from realCash/expectedCash: it
  // could be drawer, store POS, or the manager's account. Only this disproven
  // term is removed from the KNOWN amount; the official reference stays null.
  const received = input.cashReceived + input.cardReceived + input.otherReceived
  if (!Number.isSafeInteger(received)) throw new RangeError('دریافتی معلوم از سقف امن ریالی خارج است.')
  const knownSubtotal = physicalMoneyInDrawerAndCard({
    receivedTotal: received,
    refundCashTotal: input.refundCash,
    refundCardTotal: input.refundCard
  })
  if (!Number.isSafeInteger(knownSubtotal)) throw new RangeError('مرجع از سقف امن ریالی خارج است.')
  const pending = input.ambiguousLegacyCredit > 0 || input.destinationUnknownReceived > 0
  return {
    status: pending ? 'PENDING_RECONCILIATION' : 'AVAILABLE',
    referenceAmount: pending ? null : knownSubtotal,
    knownSubtotal,
    destinationUnknownReceived: input.destinationUnknownReceived,
    ambiguousLegacyCredit: input.ambiguousLegacyCredit,
    calculationVersion: CUSTODY_REFERENCE_VERSION,
    warnings: custodyReferenceWarnings(input.ambiguousLegacyCredit, input.destinationUnknownReceived)
  }
}

/** Shared, deterministic part of the blue source fingerprint. Keeping these
 * exact warnings in one place lets V3 verify sourceHash against its saved
 * components without querying today's mutable report or recalculating money. */
export function custodyReferenceWarnings(ambiguousLegacyCredit: number, destinationUnknownReceived: number): string[] {
  return [
    ...(ambiguousLegacyCredit > 0
      ? ['پرداخت اعتباری قدیمی بدون مقصد روشن وجود دارد؛ بخش معلوم نمایش داده می‌شود اما مرجع و اختلاف قطعی تا بررسی آن در انتظار است.'] : []),
    ...(destinationUnknownReceived > 0
      ? ['وجه با مقصد نامشخص وجود دارد؛ معلوم نیست به کشو، کارت‌خوان یا حساب مدیر رسیده است. تا اثبات مقصد، مرجع و اختلاف قطعی نامعلوم‌اند و فروش ادامه دارد.'] : [])
  ]
}

export function pendingCustodyReference(reason: string): CustodyReference {
  return {
    status: 'PENDING_RECONCILIATION',
    referenceAmount: null,
    knownSubtotal: null,
    destinationUnknownReceived: null,
    ambiguousLegacyCredit: null,
    calculationVersion: CUSTODY_REFERENCE_VERSION,
    warnings: [reason]
  }
}
