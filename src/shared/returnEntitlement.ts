import { toNumberRial } from './money'

/** Distinct quantities: a refund can reduce debt, create a real-money claim,
 * or restore a gift opportunity. None of these alone means bank money left.
 * Never add OVERPAY from an invoice to this entitlement.
 */
export interface CashClaimAmounts {
  cashRight: number | bigint
  cashPaid: number | bigint
  cashReserved: number | bigint
  cashConverted: number | bigint
}

export function cashClaimBalance(row: CashClaimAmounts): {
  open: number
  allocated: number
  rawExcess: number
  overAllocated: boolean
} {
  const right = toNumberRial(row.cashRight)
  const paid = toNumberRial(row.cashPaid)
  const reserved = toNumberRial(row.cashReserved)
  const converted = toNumberRial(row.cashConverted)
  if ([right, paid, reserved, converted].some((x) => !Number.isSafeInteger(x) || x < 0))
    throw new Error('INVALID_ENTITLEMENT_AMOUNTS')
  const allocated = paid + reserved + converted
  if (!Number.isSafeInteger(allocated)) throw new Error('ENTITLEMENT_OVERFLOW')
  return {
    open: Math.max(0, right - allocated),
    allocated,
    rawExcess: Math.max(0, allocated - right),
    overAllocated: allocated > right
  }
}

/** A return first reduces the debt that existed *before* that return. The
 * excess may be eligible for cash or gift provenance, never the whole return.
 */
export function debtFirstReturn(value: number, debtBefore: number): { debtReduced: number; residual: number } {
  if (![value, debtBefore].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error('INVALID_RETURN_VALUE')
  const debtReduced = Math.min(value, debtBefore)
  return { debtReduced, residual: value - debtReduced }
}

/** Proportional provenance uses cumulative floors, so a sequence of partial
 * returns rounds exactly to the original gift/cash split (not N rounded parts).
 * Example: gift 300 + cash 200, return 100 => gift 60 and cash 40.
 */
export function proportionalReturn(
  basis: { purchaseTotal: number; giftTotal: number; previouslyReturned: number; returning: number }
): { gift: number; cash: number } {
  const { purchaseTotal, giftTotal, previouslyReturned, returning } = basis
  if (![purchaseTotal, giftTotal, previouslyReturned, returning].every(Number.isSafeInteger) ||
      purchaseTotal <= 0 || giftTotal < 0 || giftTotal > purchaseTotal ||
      previouslyReturned < 0 || returning < 0 || previouslyReturned + returning > purchaseTotal)
    throw new Error('INVALID_PROVENANCE')
  // Integer arithmetic avoids float rounding drift for large rial values.
  const giftCumulative = (n: number) => Number((BigInt(n) * BigInt(giftTotal)) / BigInt(purchaseTotal))
  const gift = giftCumulative(previouslyReturned + returning) - giftCumulative(previouslyReturned)
  return { gift, cash: returning - gift }
}
