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

/** Split an integer-rial target across source shares by largest remainder.
 * IDs provide a stable tie-break, so replaying the same snapshot yields the
 * same allocations without converting Rial values to floating point.
 */
export function allocateExchangeFundingProRata(
  target: number,
  shares: Array<{ id: number; available: number }>
): Array<{ id: number; amount: number }> {
  if (!Number.isSafeInteger(target) || target < 0 || !Array.isArray(shares)) {
    throw new RangeError('Exchange funding allocation must use non-negative safe integer rials')
  }
  const seen = new Set<number>()
  let denominator = 0n
  for (const share of shares) {
    if (!share || !Number.isSafeInteger(share.id) || share.id <= 0 || seen.has(share.id) ||
        !Number.isSafeInteger(share.available) || share.available < 0) {
      throw new RangeError('Exchange funding shares must have unique IDs and non-negative safe integer rials')
    }
    seen.add(share.id)
    denominator += BigInt(share.available)
  }
  if (denominator > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(target) > denominator) {
    throw new RangeError('Exchange funding target exceeds the proven source shares')
  }
  if (target === 0) return shares.map(({ id }) => ({ id, amount: 0 }))
  if (denominator === 0n) throw new RangeError('Exchange funding target has no proven source shares')

  const rows = shares.map((share, index) => {
    const numerator = BigInt(target) * BigInt(share.available)
    return {
      index,
      id: share.id,
      amount: Number(numerator / denominator),
      remainder: numerator % denominator
    }
  })
  const allocated = rows.reduce((sum, row) => sum + row.amount, 0)
  let remaining = target - allocated
  const remainderOrder = [...rows].sort((left, right) =>
    left.remainder === right.remainder
      ? left.id - right.id
      : left.remainder > right.remainder ? -1 : 1
  )
  for (const row of remainderOrder) {
    if (remaining <= 0) break
    row.amount += 1
    remaining -= 1
  }
  if (remaining !== 0) throw new RangeError('Exchange funding allocation did not reconcile exactly')

  return rows.sort((left, right) => left.index - right.index)
    .map(({ id, amount }) => ({ id, amount }))
}
