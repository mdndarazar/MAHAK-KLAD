/* Immutable, cumulative integer allocation of returned purchased value.
 * Debt is removed first by the caller. Only the part originally paid by
 * non-cash store credit can be restored as a credit opportunity. The rest is
 * a *real-money right*, never inferred from the face value of a gift code.
 */

type RedemptionShare = { id: number; amount: number }

/** Webster/Sainte-Lague apportionment over integer Rial units. The priorities
 * amount / (2 * seat - 1) form one fixed sequence per redemption. Selecting the
 * top `seats` priorities makes allocations house-monotone; the finite sequence
 * also guarantees no source can exceed its original amount at full return.
 * Webster denominators are below 2 * MAX_SAFE_INTEGER, so distinct rational
 * priorities differ by at least 1/(4 * MAX_SAFE_INTEGER^2); a 128-bit threshold
 * separates them exactly. Runtime depends on source count and log(amount).
 */
function allocateWebster(weights: readonly RedemptionShare[], seats: number): number[] {
  if (!Number.isSafeInteger(seats) || seats < 0) throw new Error('INVALID_CREDIT_RETURN_BASIS')
  let capacity = 0
  let maxWeight = 0
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight.id) || weight.id <= 0 ||
        !Number.isSafeInteger(weight.amount) || weight.amount < 0)
      throw new Error('INVALID_CREDIT_RETURN_BASIS')
    capacity += weight.amount
    if (!Number.isSafeInteger(capacity)) throw new Error('INVALID_CREDIT_RETURN_BASIS')
    maxWeight = Math.max(maxWeight, weight.amount)
  }
  if (seats > capacity) throw new Error('INVALID_CREDIT_RETURN_BASIS')
  const counts = weights.map(() => 0)
  if (seats === 0) return counts

  const scale = 1n << 128n
  const countPrioritiesAbove = (threshold: bigint) => {
    const allocated = weights.map((weight) => {
      if (weight.amount === 0) return 0
      if (threshold === 0n) return weight.amount
      const scaledWeight = BigInt(weight.amount) * scale
      // amount / (2k-1) > threshold / scale
      const maxOddDenominator = (scaledWeight - 1n) / threshold
      const count = (maxOddDenominator + 1n) / 2n
      return count >= BigInt(weight.amount) ? weight.amount : Number(count)
    })
    return { allocated, total: allocated.reduce((sum, amount) => sum + amount, 0) }
  }

  let low = 0n
  let high = BigInt(maxWeight) * scale + 1n
  while (low + 1n < high) {
    const middle = (low + high) >> 1n
    if (countPrioritiesAbove(middle).total >= seats) low = middle
    else high = middle
  }

  const boundary = countPrioritiesAbove(high)
  for (let index = 0; index < counts.length; index++) counts[index] = boundary.allocated[index]
  let remaining = seats - boundary.total
  const candidates = weights.map((weight, index) => ({ weight, index }))
    .filter(({ weight, index }) => counts[index] < weight.amount)
    .sort((left, right) => {
      const leftDenominator = 2n * BigInt(counts[left.index]) + 1n
      const rightDenominator = 2n * BigInt(counts[right.index]) + 1n
      const leftPriority = BigInt(left.weight.amount) * rightDenominator
      const rightPriority = BigInt(right.weight.amount) * leftDenominator
      if (leftPriority !== rightPriority) return leftPriority > rightPriority ? -1 : 1
      return left.weight.id < right.weight.id ? -1 : left.weight.id > right.weight.id ? 1 : 0
    })
  if (remaining < 0 || remaining > candidates.length)
    throw new Error('INVALID_CREDIT_RETURN_BASIS')
  for (let index = 0; index < remaining; index++) counts[candidates[index].index]++
  return counts
}

export function allocateCreditReturn(input: {
  fundedPurchase: number
  fundedPreviouslyReturned: number
  fundedReturning: number
  redemptions: { id: number; amount: number }[]
  /** Cumulative per-redemption amounts already persisted. They must match the
   * deterministic cumulative basis; legacy mismatches fail closed, never rewrite. */
  priorShares?: { redemptionId: number; amount: number }[]
}): { credit: number; cash: number; shares: { redemptionId: number; amount: number; prior: number }[] } {
  const { fundedPurchase, fundedPreviouslyReturned: prior, fundedReturning: current, redemptions } = input
  if (![fundedPurchase, prior, current, ...redemptions.map((redemption) => redemption.amount)].every(
    (amount) => Number.isSafeInteger(amount) && amount >= 0
  ) || !Number.isSafeInteger(prior + current) || prior + current > fundedPurchase ||
      (redemptions.length > 0 && fundedPurchase === 0))
    throw new Error('INVALID_CREDIT_RETURN_BASIS')

  const seenIds = new Set<number>()
  let giftTotal = 0
  for (const redemption of redemptions) {
    if (!Number.isSafeInteger(redemption.id) || redemption.id <= 0 || seenIds.has(redemption.id))
      throw new Error('INVALID_REDEMPTION_ID')
    seenIds.add(redemption.id)
    giftTotal += redemption.amount
    if (!Number.isSafeInteger(giftTotal) || giftTotal > fundedPurchase)
      throw new Error('REDEMPTIONS_EXCEED_FUNDED_PURCHASE')
  }

  const giftAt = (fundedValue: number) => fundedPurchase === 0
    ? 0
    : Number(BigInt(giftTotal) * BigInt(fundedValue) / BigInt(fundedPurchase))
  const giftBefore = giftAt(prior)
  const giftAfter = giftAt(prior + current)
  const credit = giftAfter - giftBefore
  const cash = current - credit
  if (!Number.isSafeInteger(credit) || credit < 0 || !Number.isSafeInteger(cash) || cash < 0)
    throw new Error('INVALID_CREDIT_RETURN_BASIS')

  const expectedPrevious = allocateWebster(redemptions, giftBefore)
  let previous = expectedPrevious
  if (input.priorShares !== undefined) {
    if (input.priorShares.length !== redemptions.length) throw new Error('INVALID_CREDIT_RETURN_BASIS')
    const priorById = new Map<number, number>()
    for (const share of input.priorShares) {
      if (!Number.isSafeInteger(share.redemptionId) || share.redemptionId <= 0 || priorById.has(share.redemptionId) ||
          !Number.isSafeInteger(share.amount) || share.amount < 0)
        throw new Error('INVALID_CREDIT_RETURN_BASIS')
      priorById.set(share.redemptionId, share.amount)
    }
    previous = redemptions.map((redemption) => {
      const amount = priorById.get(redemption.id)
      if (amount === undefined || amount > redemption.amount) throw new Error('INVALID_CREDIT_RETURN_BASIS')
      return amount
    })
    if (previous.some((amount, index) => amount !== expectedPrevious[index]))
      throw new Error('INVALID_CREDIT_RETURN_BASIS')
  }
  const previousTotal = previous.reduce((sum, amount) => sum + amount, 0)
  if (!Number.isSafeInteger(previousTotal) || previousTotal !== giftBefore)
    throw new Error('INVALID_CREDIT_RETURN_BASIS')

  const targetAfter = allocateWebster(redemptions, giftAfter)
  const shares = redemptions.map((redemption, index) => ({
    redemptionId: redemption.id,
    amount: targetAfter[index] - previous[index],
    prior: previous[index]
  }))
  if (shares.some((share, index) => share.amount < 0 || share.prior + share.amount > redemptions[index].amount) ||
      shares.reduce((sum, share) => sum + share.amount, 0) !== credit)
    throw new Error('INVALID_CREDIT_RETURN_BASIS')
  return { credit, cash, shares }
}
