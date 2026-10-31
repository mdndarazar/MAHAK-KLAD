/** Pure allocation planner for the exchange residual rights B and N.
 *
 * S1 spends N before B. B is spendable only before its source/root expiry;
 * N is a real-money claim and never expires. This function plans a single
 * tender only: callers must reserve and commit it atomically in the persistent
 * rights ledger and must not treat either amount as cash received today.
 */
export interface ExchangeResidualTenderInput {
  amount: number
  nAvailable: number
  bAvailable: number
  bExpiresAt: Date | null
  at: Date
}

export interface ExchangeResidualTenderPlan {
  nAmount: number
  bAmount: number
  nAvailableAfter: number
  bSpendableAfter: number
  bExpired: boolean
}

const invalid = () => new RangeError('Exchange residual rights require a positive tender, non-negative balances, and valid dates')

export function planS1ExchangeResidualTender(input: ExchangeResidualTenderInput): ExchangeResidualTenderPlan {
  if (!input || !Number.isSafeInteger(input.amount) || input.amount < 1 ||
      ![input.nAvailable, input.bAvailable].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !(input.at instanceof Date) || !Number.isFinite(input.at.getTime()) ||
      (input.bExpiresAt !== null && (!(input.bExpiresAt instanceof Date) || !Number.isFinite(input.bExpiresAt.getTime()))))
    throw invalid()

  const bExpired = input.bExpiresAt !== null && input.bExpiresAt.getTime() <= input.at.getTime()
  const usableB = bExpired ? 0 : input.bAvailable
  const usableTotal = BigInt(input.nAvailable) + BigInt(usableB)
  if (BigInt(input.amount) > usableTotal)
    throw new Error('INSUFFICIENT_EXCHANGE_RESIDUAL_RIGHTS')

  // S1's two later sales use the still-open N claim first, then B. This order
  // is distinct from B→N, which applies to partial-return attribution only.
  const nAmount = Math.min(input.amount, input.nAvailable)
  const bAmount = input.amount - nAmount
  return {
    nAmount,
    bAmount,
    nAvailableAfter: input.nAvailable - nAmount,
    bSpendableAfter: bExpired ? 0 : input.bAvailable - bAmount,
    bExpired
  }
}
