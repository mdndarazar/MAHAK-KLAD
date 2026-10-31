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

/** Ordinary, unrestricted credit is pooled across the invoice, never assigned
 * proportionally to goods. On any return, restore the unreturned gift pool
 * first; only the residual can be a real-money right. */
export function pooledCreditFirstReturn(
  basis: { purchaseTotal: number; giftTotal: number; previouslyReturned: number; returning: number }
): { gift: number; cash: number } {
  const { purchaseTotal, giftTotal, previouslyReturned, returning } = basis
  if (![purchaseTotal, giftTotal, previouslyReturned, returning].every(Number.isSafeInteger) ||
      purchaseTotal <= 0 || giftTotal < 0 || giftTotal > purchaseTotal ||
      previouslyReturned < 0 || returning < 0 || previouslyReturned + returning > purchaseTotal)
    throw new Error('INVALID_PROVENANCE')
  const giftBefore = Math.min(giftTotal, previouslyReturned)
  const giftAfter = Math.min(giftTotal, previouslyReturned + returning)
  const gift = giftAfter - giftBefore
  return { gift, cash: returning - gift }
}
