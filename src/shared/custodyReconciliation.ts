/**
 * Canonical, side-effect-free arithmetic for custody reconciliation.
 *
 * This is intentionally different from a cash-close calculation.  A custody
 * boundary compares one blind observation of the combined operational money
 * (cash drawer + the store POS terminal) with the movement since the previous
 * accepted observation.
 *
 * Only confirmed physical cash/POS legs belong here.  Store credit issue/use,
 * unpaid debt, a manager account, and an unknown destination are deliberately
 * not inputs: the caller must classify them before this pure calculation is
 * used.  All values are whole Iranian rials.
 */

export type CustodyPhysicalMovementInput = {
  cashReceived?: number | bigint | null
  posReceived?: number | bigint | null
  cashRefunded?: number | bigint | null
  posRefunded?: number | bigint | null
}

export type CustodyBoundaryInput = {
  /** The actual combined total accepted at the preceding custody boundary. */
  priorAcceptedObservedTotal: number | bigint
  /**
   * The ledger/theoretical total at that same preceding boundary.  Keeping it
   * separate lets manager reporting show a still-open historical discrepancy
   * without creating it again at every subsequent handover.
   */
  priorTheoreticalTotal: number | bigint
  movement: CustodyPhysicalMovementInput
  /** The incoming custodian's mandatory blind combined count. */
  observedTotal: number | bigint
}

export type CustodyBoundaryReconciliation = {
  physicalMovement: number
  operationalExpectedTotal: number
  theoreticalExpectedTotal: number
  observedTotal: number
  /** Difference newly detected at this boundary; zero means no new case. */
  newDifference: number
  /** The cumulative manager-visible gap against the theoretical ledger. */
  totalTheoreticalDifference: number
}

function wholeRial(value: unknown, label: string, allowNegative = false): number {
  const raw = typeof value === 'bigint' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || (!allowNegative && raw < 0))
    throw new RangeError(`${label} باید مبلغ صحیح ریالی${allowNegative ? '' : 'ِ صفر یا مثبت'} باشد.`)
  return raw
}

/**
 * Net physical flow for a period.  It is the audited arithmetic behind the
 * manager's drawer/POS reference, once a caller has supplied only classified
 * drawer/POS legs.
 */
export function custodyPhysicalMovement(input: CustodyPhysicalMovementInput = {}): number {
  const cashReceived = wholeRial(input.cashReceived ?? 0, 'دریافت نقدی')
  const posReceived = wholeRial(input.posReceived ?? 0, 'دریافت کارت‌خوان')
  const cashRefunded = wholeRial(input.cashRefunded ?? 0, 'بازپرداخت نقدی')
  const posRefunded = wholeRial(input.posRefunded ?? 0, 'بازپرداخت کارت‌خوان')
  const total = cashReceived + posReceived - cashRefunded - posRefunded
  if (!Number.isSafeInteger(total)) throw new RangeError('جمع حرکت فیزیکی از سقف امن مبلغ ریالی خارج است.')
  return total
}

/**
 * Reconcile a single immutable custody boundary.
 *
 * `newDifference` deliberately uses the accepted operational baseline, while
 * `totalTheoreticalDifference` keeps the manager's end-to-end blue-reference
 * comparison visible.  This is what makes 20 / 18 / 28 produce one old case,
 * not a duplicate old case at the second handover.
 */
export function reconcileCustodyBoundary(input: CustodyBoundaryInput): CustodyBoundaryReconciliation {
  const priorAcceptedObservedTotal = wholeRial(input.priorAcceptedObservedTotal, 'شمارش پذیرفته‌شدهٔ قبلی')
  const priorTheoreticalTotal = wholeRial(input.priorTheoreticalTotal, 'مبلغ نظری قبلی')
  const observedTotal = wholeRial(input.observedTotal, 'شمارش مجموع کشو و کارت‌خوان')
  const physicalMovement = custodyPhysicalMovement(input.movement)
  const operationalExpectedTotal = priorAcceptedObservedTotal + physicalMovement
  const theoreticalExpectedTotal = priorTheoreticalTotal + physicalMovement
  if (!Number.isSafeInteger(operationalExpectedTotal) || !Number.isSafeInteger(theoreticalExpectedTotal))
    throw new RangeError('مبلغ مورد انتظار مرز حضانت از سقف امن مبلغ ریالی خارج است.')
  return {
    physicalMovement,
    operationalExpectedTotal,
    theoreticalExpectedTotal,
    observedTotal,
    newDifference: observedTotal - operationalExpectedTotal,
    totalTheoreticalDifference: observedTotal - theoreticalExpectedTotal
  }
}
