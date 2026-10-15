// A warning about two independently attested physical totals, NOT a blue
// reference, a newly attributable discrepancy, or a verdict against a worker.
// The old ZERO-named origin stays readable but is never a human count.
export type CustodyPeerCount = { countOrigin: unknown; humanAmount: unknown }
export type CustodyPeerComparison = {
  status: 'NOT_APPLICABLE' | 'EQUAL' | 'DIFFERENT'
  direction: 'MORE' | 'LESS' | null
  /** Exact decimal rial string: no lossy BigInt -> Number conversion over IPC. */
  absoluteDifferenceRial: string | null
  selfCount: boolean
}

function realAmount(row: CustodyPeerCount | null | undefined): bigint | null {
  if (row?.countOrigin !== 'EXPLICIT_AMOUNT' && row?.countOrigin !== 'EXPLICIT_ZERO') return null
  const amount = row.humanAmount
  const exact = typeof amount === 'bigint' ? amount
    : typeof amount === 'number' && Number.isSafeInteger(amount) ? BigInt(amount) : null
  if (exact == null || exact < 0n || (exact === 0n) !== (row.countOrigin === 'EXPLICIT_ZERO')) return null
  return exact
}

/** Compare ONLY the OUT and IN human counts of this same handover. Missing or
 * system-absence witnesses never become a monetary zero or a comparison. */
export function compareCustodyPeerCounts(
  outgoing: CustodyPeerCount | null | undefined,
  incoming: CustodyPeerCount | null | undefined,
  selfCount = false
): CustodyPeerComparison {
  const from = realAmount(outgoing)
  const to = realAmount(incoming)
  const common = { selfCount: selfCount === true }
  if (from == null || to == null)
    return { ...common, status: 'NOT_APPLICABLE', direction: null, absoluteDifferenceRial: null }
  const change = to - from
  if (change === 0n)
    return { ...common, status: 'EQUAL', direction: null, absoluteDifferenceRial: '0' }
  return {
    ...common, status: 'DIFFERENT', direction: change > 0n ? 'MORE' : 'LESS',
    absoluteDifferenceRial: (change < 0n ? -change : change).toString()
  }
}
