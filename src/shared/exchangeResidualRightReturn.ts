/** S1-only cumulative return apportionment for the two residual rights issued
 * from its documented 15.98M -> 15.00M mixed exchange. This is accounting
 * attribution only: callers must separately validate redemption/return
 * provenance, expiry, and append the RESTORED ledger events atomically.
 */
export interface S1ResidualRightReturnInput {
  /** Original S1 B right face value (122,654 Rial in the canonical example). */
  bAmount: number
  /** Original S1 N right face value (857,346 Rial). */
  nAmount: number
  /** Amount of B+N funding previously returned from sale 2. */
  previouslyReturned: number
  /** Value of this newly returned sale-2 item/portion. */
  returningAmount: number
  /** Persisted cumulative amounts that prove earlier return history. */
  priorAllocations?: { b: number; n: number }
}

export interface S1ResidualRightReturnResult {
  returnedBefore: number
  returningAmount: number
  returnedAfter: number
  b: { prior: number; amount: number; cumulative: number }
  n: { prior: number; amount: number; cumulative: number }
}

const invalid = () => new Error('INVALID_S1_RESIDUAL_RIGHT_RETURN')

function assertRial(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid()
}

function cumulativeB(bAmount: number, total: number, returned: number): number {
  return Number((BigInt(bAmount) * BigInt(returned)) / BigInt(total))
}

/**
 * Allocate returned value back to the same S1 rights using the approved
 * B-before-N cumulative floor rule. Chunking/order cannot change the final
 * restoration: ΔB = floor(B*x_new/total)-floor(B*x_prev/total), ΔN=Δx-ΔB.
 */
export function allocateS1ResidualRightReturn(input: S1ResidualRightReturnInput): S1ResidualRightReturnResult {
  const { bAmount, nAmount, previouslyReturned, returningAmount } = input
  assertRial(bAmount)
  assertRial(nAmount)
  assertRial(previouslyReturned)
  if (!Number.isSafeInteger(returningAmount) || returningAmount <= 0) throw invalid()
  const total = bAmount + nAmount
  if (!Number.isSafeInteger(total) || total <= 0 ||
      previouslyReturned + returningAmount > total ||
      !Number.isSafeInteger(previouslyReturned + returningAmount)) throw invalid()

  const priorB = cumulativeB(bAmount, total, previouslyReturned)
  const after = previouslyReturned + returningAmount
  const cumulativeBAmount = cumulativeB(bAmount, total, after)
  const priorN = previouslyReturned - priorB
  const cumulativeNAmount = after - cumulativeBAmount

  if (input.priorAllocations !== undefined &&
      (input.priorAllocations.b !== priorB || input.priorAllocations.n !== priorN))
    throw new Error('MISMATCHED_S1_RESIDUAL_RIGHT_RETURN_HISTORY')

  const result = {
    returnedBefore: previouslyReturned,
    returningAmount,
    returnedAfter: after,
    b: { prior: priorB, amount: cumulativeBAmount - priorB, cumulative: cumulativeBAmount },
    n: { prior: priorN, amount: cumulativeNAmount - priorN, cumulative: cumulativeNAmount }
  }
  if (result.b.amount < 0 || result.n.amount < 0 ||
      result.b.amount + result.n.amount !== returningAmount ||
      result.b.cumulative + result.n.cumulative !== after)
    throw invalid()
  return result
}
