/**
 * Deterministic allocation for the approved gift-first exchange policy.
 *
 * This is intentionally a pure planning primitive: callers must provide only
 * source amounts already proven by the funding ledger, and must persist the
 * resulting allocations atomically with the exchange. It does not infer cash,
 * restore a credit, issue a credit, or authorize a refund.
 * All amounts are integer rials.
 */
export type ExchangeFundingPlan = {
  giftCarry: number
  realMoneyCarry: number
  giftRemainder: number
  realMoneyRemainder: number
  unfundedReplacement: number
}

export function allocateExchangeFundingGiftFirst(input: {
  giftAvailable: number
  realMoneyAvailable: number
  replacementTotal: number
}): ExchangeFundingPlan {
  const values = [input.giftAvailable, input.realMoneyAvailable, input.replacementTotal]
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError('Exchange funding amounts must be non-negative safe integer rials')
  }

  const giftCarry = Math.min(input.giftAvailable, input.replacementTotal)
  const remainingReplacement = input.replacementTotal - giftCarry
  const realMoneyCarry = Math.min(input.realMoneyAvailable, remainingReplacement)

  return {
    giftCarry,
    realMoneyCarry,
    giftRemainder: input.giftAvailable - giftCarry,
    realMoneyRemainder: input.realMoneyAvailable - realMoneyCarry,
    unfundedReplacement: remainingReplacement - realMoneyCarry
  }
}
