export type PooledExchangeReturnSourceKind =
  | 'SOURCE_GIFT'
  | 'SOURCE_CASH'
  | 'SOURCE_CARD'
  | 'SOURCE_CHEQUE'

export interface PooledExchangeReturnSource {
  sourceEventId: number
  sourceKind: PooledExchangeReturnSourceKind
  amount: number
}

export interface PooledExchangeReturnItem {
  returnId: number
  returnItemId: number
  saleItemId: number
  amount: number
}

export interface PooledExchangeReturnAllocation {
  returnId: number
  returnItemId: number
  saleItemId: number
  sourceEventId: number
  sourceKind: PooledExchangeReturnSourceKind
  amount: number
  priorAmount: number
  cumulativeAmount: number
  priorReturnValue: number
  cumulativeReturnValue: number
}

const INVALID = 'INVALID_POOLED_EXCHANGE_RETURN'
const MONEY_KINDS = new Set<PooledExchangeReturnSourceKind>([
  'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'
])

/**
 * Return allocation for the customer's pooled-credit policy.
 *
 * It does not apportion invoice sources by replacement item price. Across the
 * full child invoice's active return history, proven general gift value is
 * consumed first, up to the returned value; only the remainder is attributed
 * to real-money sources. Event order is used solely to keep the append-only
 * source ledger deterministic when one kind has multiple roots.
 */
export function allocatePooledExchangeReturn(
  sourcesInput: readonly PooledExchangeReturnSource[],
  returnItemsInput: readonly PooledExchangeReturnItem[]
): PooledExchangeReturnAllocation[] {
  if (!Array.isArray(sourcesInput) || !Array.isArray(returnItemsInput) || sourcesInput.length === 0)
    throw new RangeError(INVALID)

  const sourceIds = new Set<number>()
  const sources = sourcesInput.slice().sort((a, b) => a.sourceEventId - b.sourceEventId)
  for (const source of sources) {
    if (!Number.isSafeInteger(source.sourceEventId) || source.sourceEventId <= 0 || sourceIds.has(source.sourceEventId) ||
        !Number.isSafeInteger(source.amount) || source.amount < 0 ||
        (source.sourceKind !== 'SOURCE_GIFT' && !MONEY_KINDS.has(source.sourceKind)))
      throw new RangeError(INVALID)
    sourceIds.add(source.sourceEventId)
  }
  const items = returnItemsInput.slice().sort((a, b) =>
    a.returnId - b.returnId || a.returnItemId - b.returnItemId)
  const itemIds = new Set<number>()
  for (const item of items) {
    if (!Number.isSafeInteger(item.returnId) || item.returnId <= 0 ||
        !Number.isSafeInteger(item.returnItemId) || item.returnItemId <= 0 || itemIds.has(item.returnItemId) ||
        !Number.isSafeInteger(item.saleItemId) || item.saleItemId <= 0 ||
        !Number.isSafeInteger(item.amount) || item.amount < 0)
      throw new RangeError(INVALID)
    itemIds.add(item.returnItemId)
  }

  const totalSource = sources.reduce((sum, source) => sum + BigInt(source.amount), 0n)
  const totalGift = sources.filter((source) => source.sourceKind === 'SOURCE_GIFT')
    .reduce((sum, source) => sum + BigInt(source.amount), 0n)
  const totalMoney = sources.filter((source) => MONEY_KINDS.has(source.sourceKind))
    .reduce((sum, source) => sum + BigInt(source.amount), 0n)
  if (totalSource > BigInt(Number.MAX_SAFE_INTEGER) || totalGift + totalMoney !== totalSource)
    throw new RangeError(INVALID)

  const cumulativeTargets = (returned: bigint): Map<number, bigint> => {
    if (returned < 0n || returned > totalSource) throw new RangeError(INVALID)
    const giftTarget = returned < totalGift ? returned : totalGift
    const moneyTarget = returned - giftTarget
    const targets = new Map<number, bigint>()
    const assign = (kindSources: readonly PooledExchangeReturnSource[], target: bigint) => {
      let left = target
      for (const source of kindSources) {
        const capacity = BigInt(source.amount)
        const assigned = left < capacity ? left : capacity
        targets.set(source.sourceEventId, assigned)
        left -= assigned
      }
      if (left !== 0n) throw new RangeError(INVALID)
    }
    assign(sources.filter((source) => source.sourceKind === 'SOURCE_GIFT'), giftTarget)
    assign(sources.filter((source) => MONEY_KINDS.has(source.sourceKind)), moneyTarget)
    return targets
  }

  let previousValue = 0n
  let previousTargets = cumulativeTargets(0n)
  const allocations: PooledExchangeReturnAllocation[] = []
  const cumulativeBySource = new Map<number, bigint>()
  for (const item of items) {
    const nextValue = previousValue + BigInt(item.amount)
    if (nextValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(INVALID)
    const nextTargets = cumulativeTargets(nextValue)
    for (const source of sources) {
      const prior = previousTargets.get(source.sourceEventId) ?? 0n
      const cumulative = nextTargets.get(source.sourceEventId) ?? 0n
      const delta = cumulative - prior
      if (delta < 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(INVALID)
      if (delta > 0n) {
        const priorSourceCumulative = cumulativeBySource.get(source.sourceEventId) ?? 0n
        allocations.push({
          returnId: item.returnId,
          returnItemId: item.returnItemId,
          saleItemId: item.saleItemId,
          sourceEventId: source.sourceEventId,
          sourceKind: source.sourceKind,
          amount: Number(delta),
          priorAmount: Number(priorSourceCumulative),
          cumulativeAmount: Number(priorSourceCumulative + delta),
          priorReturnValue: Number(previousValue),
          cumulativeReturnValue: Number(nextValue)
        })
        cumulativeBySource.set(source.sourceEventId, priorSourceCumulative + delta)
      }
    }
    previousValue = nextValue
    previousTargets = nextTargets
  }
  return allocations
}
