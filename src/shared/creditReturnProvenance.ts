/* Immutable, cumulative integer allocation of returned purchased value.
 * Debt is removed first by the caller. Only the part originally paid by
 * non-cash store credit can be restored as a credit opportunity. The rest is
 * a *real-money right*, never inferred from the face value of a gift code.
 */
import { allocateRialSharesWebster, type RialApportionmentWeight } from './integerRialApportionment'

type RedemptionShare = RialApportionmentWeight

function allocateWebster(weights: readonly RedemptionShare[], seats: number): number[] {
  try {
    return allocateRialSharesWebster(weights, seats)
  } catch {
    throw new Error('INVALID_CREDIT_RETURN_BASIS')
  }
}

export function allocateCreditReturn(input: {
  fundedPurchase: number
  fundedPreviouslyReturned: number
  fundedReturning: number
  redemptions: { id: number; amount: number }[]
  /** Cumulative per-redemption amounts already persisted. They must match the
   * deterministic cumulative basis; legacy mismatches fail closed, never rewrite. */
  priorShares?: { redemptionId: number; amount: number }[]
  /** Fully spent, one-use gift barcodes are returned before actual-money rights.
   * Ordinary/partial redemptions keep the historical whole-invoice proportion. */
  giftFirst?: boolean
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

  const giftAt = (fundedValue: number) => input.giftFirst
    ? Math.min(giftTotal, fundedValue)
    : fundedPurchase === 0
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
