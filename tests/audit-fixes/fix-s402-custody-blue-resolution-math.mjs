/**
 * Manager evidence changes only a derived comparison, never the original
 * pending snapshot or the responsibility assigned at that handover.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s402-custody-blue-resolution-math.mjs
 */
import { calculateCustodyReference } from '../../src/shared/custodyReference.ts'
import { observationOf } from '../../src/shared/custodyPeriod.ts'
import { resolvedCustodySnapshot } from '../../src/shared/custodyResolution.ts'

const frozen = calculateCustodyReference({ cashReceived: 500_000_000, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 0, ambiguousLegacyCredit: 1_000_000, refundCash: 0, refundCard: 0 })
const count = observationOf(501_000_000, false)
let checked = 0
const eq = (name, actual, expected) => {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`)
  checked++; console.log(`  ✓ ${name}`)
}
const decide = (decision) => resolvedCustodySnapshot({ reference: frozen, count, scopeKey: '1405/07/22:TODAY', start: null, decision })
for (const kind of ['RECEIVED_CASH', 'RECEIVED_CARD']) {
  const value = decide(kind)
  eq(`${kind}: reference 501M`, value.effectiveReferenceAmount, 501_000_000)
  eq(`${kind}: raw difference 0`, value.comparison.rawDifference, 0)
  eq(`${kind}: no prior real count means no fresh verdict`, value.comparison.freshDifference, null)
}
const unpaid = decide('NOT_RECEIVED')
eq('no money received: reference 500M', unpaid.effectiveReferenceAmount, 500_000_000)
eq('no money received: actual excess 1M', unpaid.comparison.rawDifference, 1_000_000)
eq('no money received: still no guilt or fresh finding', unpaid.comparison.freshDifference, null)
eq('original snapshot stays pending', frozen.status, 'PENDING_RECONCILIATION')
eq('original reference is still null', frozen.referenceAmount, null)
try { decide('UNKNOWN'); throw new Error('unknown decision was accepted') }
catch (error) { eq('unknown decision rejected', String(error.message).includes('نامعتبر'), true) }
console.log(`\n✓ ${checked} checks passed`)
