/* Immutable, cumulative integer allocation of returned purchased value.
 * Debt is removed first by the caller. Only the part originally paid by
 * non-cash store credit can be restored as a credit opportunity. The rest is
 * a *real-money right*, never inferred from the face value of a gift code.
 */
export function allocateCreditReturn(input: {
  fundedPurchase: number
  fundedPreviouslyReturned: number
  fundedReturning: number
  redemptions: { id: number; amount: number }[]
}): { credit: number; cash: number; shares: { redemptionId: number; amount: number; prior: number }[] } {
  const { fundedPurchase, fundedPreviouslyReturned: prior, fundedReturning: current, redemptions } = input
  if (![fundedPurchase, prior, current, ...redemptions.map((r) => r.amount)].every(
    (n) => Number.isSafeInteger(n) && n >= 0
  ) || !Number.isSafeInteger(prior + current) || prior + current > fundedPurchase ||
      (redemptions.length > 0 && fundedPurchase === 0))
    throw new Error('INVALID_CREDIT_RETURN_BASIS')
  let cumulative = 0
  let credit = 0
  const shares: { redemptionId: number; amount: number; prior: number }[] = []
  const floor = (n: number, numerator: number) => Number(BigInt(n) * BigInt(numerator) / BigInt(fundedPurchase))
  for (const r of redemptions) {
    if (!Number.isSafeInteger(r.id) || r.id <= 0) throw new Error('INVALID_REDEMPTION_ID')
    const from = cumulative
    cumulative += r.amount
    if (!Number.isSafeInteger(cumulative) || cumulative > fundedPurchase)
      throw new Error('REDEMPTIONS_EXCEED_FUNDED_PURCHASE')
    const shareAt = (n: number) => floor(n, cumulative) - floor(n, from)
    const prevShare = shareAt(prior)
    const share = shareAt(prior + current) - prevShare
    credit += share
    shares.push({ redemptionId: r.id, amount: share, prior: prevShare })
  }
  return { credit, cash: current - credit, shares }
}
