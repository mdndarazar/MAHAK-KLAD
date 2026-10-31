/** Stable integer-Rial apportionment primitives shared by cumulative
 * provenance allocators. A tie always resolves by the persisted source ID,
 * never by caller array order. This is accounting attribution only: it does
 * not establish an entitlement, payment, or settlement method.
 */
export type RialApportionmentWeight = { id: number; amount: number }

/** Webster/Sainte-Lague apportionment over integer Rial units. The priorities
 * amount / (2 * seat - 1) form one fixed sequence per source. Selecting the
 * top `seats` priorities makes allocations house-monotone; finite capacity
 * guarantees no source can exceed its original amount at full allocation.
 * Webster denominators are below 2 * MAX_SAFE_INTEGER, so distinct rational
 * priorities differ by at least 1/(4 * MAX_SAFE_INTEGER^2); a 128-bit threshold
 * separates them exactly. Runtime depends on source count and log(amount).
 */
export function allocateRialSharesWebster(
  weights: readonly RialApportionmentWeight[],
  seats: number
): number[] {
  const invalid = () => new Error('INVALID_RIAL_APPORTIONMENT')
  if (!Number.isSafeInteger(seats) || seats < 0) throw invalid()
  let capacity = 0
  let maxWeight = 0
  const seenIds = new Set<number>()
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight.id) || weight.id <= 0 || seenIds.has(weight.id) ||
        !Number.isSafeInteger(weight.amount) || weight.amount < 0)
      throw invalid()
    seenIds.add(weight.id)
    capacity += weight.amount
    if (!Number.isSafeInteger(capacity)) throw invalid()
    maxWeight = Math.max(maxWeight, weight.amount)
  }
  if (seats > capacity) throw invalid()
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
  const remaining = seats - boundary.total
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
  if (remaining < 0 || remaining > candidates.length) throw invalid()
  for (let index = 0; index < remaining; index++) counts[candidates[index].index]++
  return counts
}
