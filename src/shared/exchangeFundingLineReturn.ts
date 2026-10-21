import { allocateRialSharesWebster } from './integerRialApportionment'
import { returnValueOf } from './returnValue'

export type ExchangeReturnSourceKind = 'SOURCE_GIFT' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE'

/** Provenance attribution for one source's share of one replacement line.
 * It is descriptive accounting lineage only; never a settlement right. */
export interface ExchangeReturnLineSource {
  sourceEventId: number
  sourceKind: ExchangeReturnSourceKind
  amount: number
}

export interface PriorExchangeReturnLineAllocation {
  sourceEventId: number
  amount: number
}

export interface ExchangeFundingLineReturnInput {
  saleItemId: number
  saleItemQty: number
  saleItemValue: number
  previouslyReturnedQty: number
  returningQty: number
  sources: readonly ExchangeReturnLineSource[]
  /** Persisted cumulative allocations for earlier active returns on this item.
   * Required once any quantity was previously returned, even if every source
   * allocation is zero. Missing or conflicting history fails closed. */
  priorAllocations?: readonly PriorExchangeReturnLineAllocation[]
}

export interface ExchangeFundingLineReturnShare {
  sourceEventId: number
  sourceKind: ExchangeReturnSourceKind
  prior: number
  amount: number
  cumulative: number
}

export interface ExchangeFundingLineReturnResult {
  saleItemId: number
  previouslyReturnedQty: number
  returningQty: number
  returnedQtyAfter: number
  returnValue: number
  cumulativeReturnValue: number
  shares: ExchangeFundingLineReturnShare[]
}

const INVALID_BASIS = 'INVALID_EXCHANGE_RETURN_ALLOCATION_BASIS'

function webster(weights: readonly { id: number; amount: number }[], seats: number): number[] {
  try {
    return allocateRialSharesWebster(weights, seats)
  } catch {
    throw new Error(INVALID_BASIS)
  }
}

/** The exact 15M / 1,877,346-gift S1 matrix uses cumulative gift-floor,
 * with cash absorbing the Rial remainder. Other source matrices retain their
 * existing Webster apportionment; S1's exception is intentionally not general.
 */
function cumulativeSourceShares(weights: readonly { id: number; amount: number; sourceKind?: string }[], seats: number): number[] {
  const kinds = new Set(weights.map((weight) => weight.sourceKind))
  if (kinds.size === 2 && kinds.has('SOURCE_GIFT') && kinds.has('SOURCE_CASH')) {
    const total = weights.reduce((sum, weight) => sum + BigInt(weight.amount), 0n)
    const giftTotal = weights.filter((weight) => weight.sourceKind === 'SOURCE_GIFT')
      .reduce((sum, weight) => sum + BigInt(weight.amount), 0n)
    // This exact matrix is the owner's approved S1 mixed exchange scenario.
    // Do not generalize its gift-floor rule to other product/source domains.
    if (total === 15_000_000n && giftTotal === 1_877_346n) {
      if (BigInt(seats) > total) throw new Error(INVALID_BASIS)
      const giftSeats = Number(giftTotal * BigInt(seats) / total)
      const cashSeats = seats - giftSeats
      const gifts = weights.filter((weight) => weight.sourceKind === 'SOURCE_GIFT')
      const cash = weights.filter((weight) => weight.sourceKind === 'SOURCE_CASH')
      const giftAllocation = webster(gifts, giftSeats)
      const cashAllocation = webster(cash, cashSeats)
      let giftIndex = 0
      let cashIndex = 0
      return weights.map((weight) => weight.sourceKind === 'SOURCE_GIFT'
        ? giftAllocation[giftIndex++] : cashAllocation[cashIndex++])
    }
  }
  return webster(weights, seats)
}

/**
 * Allocate a partial replacement-item return back to its immutable, original
 * funding sources. Both the line value and source shares are snapshots; the
 * returned Rial value is cumulative by returned quantity. The exact approved
 * 15M S1 carry matrix uses cumulative gift-floor with the Rial remainder assigned
 * to cash; other matrices use a fixed Webster schedule. Return chunk size cannot
 * change the result, shares never decline, and a full return restores the exact
 * original source-to-line matrix.
 *
 * This function only labels accounting origin. In particular, SOURCE_GIFT
 * output is not cash, an active gift, or a right to receive replacement credit.
 * Settlement must separately establish tender evidence, remaining entitlement,
 * expiry, prior consumption, and reversal state.
 */
export function allocateExchangeFundingLineReturn(
  input: ExchangeFundingLineReturnInput
): ExchangeFundingLineReturnResult {
  const { saleItemId, saleItemQty, saleItemValue, previouslyReturnedQty: priorQty,
    returningQty, sources } = input
  if (!Number.isSafeInteger(saleItemId) || saleItemId <= 0 ||
      !Number.isSafeInteger(saleItemQty) || saleItemQty <= 0 ||
      !Number.isSafeInteger(saleItemValue) || saleItemValue < 0 ||
      !Number.isSafeInteger(priorQty) || priorQty < 0 || priorQty > saleItemQty ||
      !Number.isSafeInteger(returningQty) || returningQty <= 0 || returningQty > saleItemQty - priorQty ||
      !Array.isArray(sources))
    throw new Error(INVALID_BASIS)

  const seenSources = new Set<number>()
  let sourceTotal = 0
  const orderedSources = [...sources].sort((left, right) => left.sourceEventId - right.sourceEventId)
  for (const source of orderedSources) {
    if (!Number.isSafeInteger(source.sourceEventId) || source.sourceEventId <= 0 ||
        seenSources.has(source.sourceEventId) ||
        !['SOURCE_GIFT', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(source.sourceKind) ||
        !Number.isSafeInteger(source.amount) || source.amount <= 0)
      throw new Error(INVALID_BASIS)
    seenSources.add(source.sourceEventId)
    sourceTotal += source.amount
    if (!Number.isSafeInteger(sourceTotal)) throw new Error(INVALID_BASIS)
  }
  if (sourceTotal !== saleItemValue) throw new Error(INVALID_BASIS)
  if (saleItemValue === 0 && orderedSources.length !== 0) throw new Error(INVALID_BASIS)
  if (saleItemValue > 0 && orderedSources.length === 0) throw new Error(INVALID_BASIS)

  const priorValue = returnValueOf(saleItemValue, saleItemQty, 0, priorQty)
  const afterQty = priorQty + returningQty
  const cumulativeValue = returnValueOf(saleItemValue, saleItemQty, 0, afterQty)
  const currentValue = returnValueOf(saleItemValue, saleItemQty, priorQty, returningQty)
  if (![priorValue, cumulativeValue, currentValue].every((amount) => Number.isSafeInteger(amount) && amount >= 0) ||
      priorValue + currentValue !== cumulativeValue)
    throw new Error(INVALID_BASIS)

  const weights = orderedSources.map((source) => ({
    id: source.sourceEventId, amount: source.amount, sourceKind: source.sourceKind
  }))
  const expectedPrior = cumulativeSourceShares(weights, priorValue)
  let priorShares = expectedPrior
  if (input.priorAllocations !== undefined) {
    if (!Array.isArray(input.priorAllocations) || input.priorAllocations.length !== orderedSources.length)
      throw new Error('MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY')
    const persisted = new Map<number, number>()
    for (const allocation of input.priorAllocations) {
      if (!Number.isSafeInteger(allocation.sourceEventId) || allocation.sourceEventId <= 0 ||
          persisted.has(allocation.sourceEventId) || !Number.isSafeInteger(allocation.amount) || allocation.amount < 0)
        throw new Error('MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY')
      persisted.set(allocation.sourceEventId, allocation.amount)
    }
    priorShares = orderedSources.map((source) => {
      const amount = persisted.get(source.sourceEventId)
      if (amount === undefined || amount > source.amount)
        throw new Error('MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY')
      return amount
    })
    if (priorShares.some((amount, index) => amount !== expectedPrior[index]))
      throw new Error('MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY')
  } else if (priorQty > 0 && saleItemValue > 0) {
    throw new Error('MISSING_EXCHANGE_RETURN_ALLOCATION_HISTORY')
  }

  const targetCumulative = cumulativeSourceShares(weights, cumulativeValue)
  const shares = orderedSources.map((source, index) => {
    const prior = priorShares[index]
    const cumulative = targetCumulative[index]
    return { sourceEventId: source.sourceEventId, sourceKind: source.sourceKind,
      prior, amount: cumulative - prior, cumulative }
  })
  if (shares.some((share, index) => share.amount < 0 || share.cumulative > orderedSources[index].amount) ||
      shares.reduce((sum, share) => sum + share.amount, 0) !== currentValue)
    throw new Error(INVALID_BASIS)

  return { saleItemId, previouslyReturnedQty: priorQty, returningQty,
    returnedQtyAfter: afterQty, returnValue: currentValue,
    cumulativeReturnValue: cumulativeValue, shares }
}
