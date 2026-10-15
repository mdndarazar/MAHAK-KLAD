/**
 * Independent real counts, inherited variance and fresh variance must remain
 * distinct even with blank optional counts or daily reference-scope changes.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s399-custody-blue-fresh-period.mjs
 */
import { calculateCustodyReference, pendingCustodyReference } from '../../src/shared/custodyReference.ts'
import { observationOf, reconcileCustodyPeriod, systemAbsenceZero, absenceUncounted, isAbsentUncounted } from '../../src/shared/custodyPeriod.ts'

let checked = 0
const eq = (name, got, want) => {
  if (got !== want) throw new Error(`${name}: expected ${String(want)}, got ${String(got)}`)
  checked++
  console.log(`  ✓ ${name}`)
}
const ref = (amount) => calculateCustodyReference({
  cashReceived: amount, cardReceived: 0, otherReceived: 0, destinationUnknownReceived: 0,
  ambiguousLegacyCredit: 0, refundCash: 0, refundCard: 0
})
const at = (count, amount, scopeKey = 'TODAY') => ({ count, reference: ref(amount), scopeKey })
const start = at(observationOf(18_481_000, false), 19_481_000)

console.log('\n[1] No sale in the afternoon: the morning shortage is NOT a new afternoon case')
{
  const result = reconcileCustodyPeriod({ start, end: at(observationOf(18_481_000, false), 19_481_000) })
  eq('raw remains -1M', result.rawDifference, -1_000_000)
  eq('inherited remains -1M', result.inheritedDifference, -1_000_000)
  eq('fresh is zero', result.freshDifference, 0)
  eq('no new discrepancy case status', result.freshStatus, 'NO_NEW_DIFFERENCE')
}

console.log('\n[2] Noon +10M sales, observed only +9M: noon newly lost 1M, not 2M')
{
  const result = reconcileCustodyPeriod({ start, end: at(observationOf(27_481_000, false), 29_481_000) })
  eq('raw end -2M', result.rawDifference, -2_000_000)
  eq('morning inherited -1M', result.inheritedDifference, -1_000_000)
  eq('fresh noon -1M', result.freshDifference, -1_000_000)
}

console.log('\n[3] Optional empty input is arithmetic zero, not a genuine opening count')
{
  const blank = observationOf('', true)
  eq('blank arithmetic zero', blank.arithmeticAmount, 0)
  eq('blank has no human observation', blank.humanAmount, null)
  const result = reconcileCustodyPeriod({ start: at(blank, 100_000_000), end: at(observationOf(110_000_000, false), 110_000_000) })
  eq('end raw can be zero', result.rawDifference, 0)
  eq('fresh is unknown, not +100M', result.freshDifference, null)
  eq('missing baseline explicitly tagged', result.freshStatus, 'UNKNOWN_NO_REAL_PRIOR_COUNT')
  const explicit = reconcileCustodyPeriod({ start: at(observationOf('0', true), 100_000_000), end: at(observationOf(110_000_000, false), 110_000_000) })
  eq('an explicit zero is an actual count', explicit.freshDifference, 100_000_000)
  eq('historical absence provenance remains readable, not a witness', systemAbsenceZero().humanAmount, null)
  eq('new absence means no human count', absenceUncounted().humanAmount, null)
  eq('new absence has no zero for arithmetic either', absenceUncounted().arithmeticAmount, null)
  eq('old origin remains recognized without rewriting stored history', isAbsentUncounted(systemAbsenceZero().origin), true)
  eq('new origin is an uncounted absence', isAbsentUncounted(absenceUncounted().origin), true)
  const noOldCount = reconcileCustodyPeriod({
    start: at(absenceUncounted(), 100_000_000), end: at(observationOf(110_000_000, false), 110_000_000)
  })
  eq('new physical count never proves an old departure difference', noOldCount.freshDifference, null)
  try { observationOf('', false); throw new Error('blank unexpectedly accepted') }
  catch (error) { eq('mandatory blank rejected', String(error.message).includes('وارد کنید'), true) }
}

console.log('\n[4] First morning combines yesterday+today, noon is today alone: do not subtract scopes')
{
  const result = reconcileCustodyPeriod({
    start: at(observationOf(5_500_000, false), 5_500_000, 'PRIOR+TODAY'),
    end: at(observationOf(5_500_000, false), 500_000, 'TODAY')
  })
  eq('noon raw +5M still visible', result.rawDifference, 5_000_000)
  eq('new variance not attributed', result.freshDifference, null)
  eq('scope change explicit', result.freshStatus, 'UNKNOWN_SCOPE_CHANGE')
}

console.log('\n[5] Unavailable report is not a fabricated zero reference')
{
  const pending = pendingCustodyReference('fallback ناقص')
  const result = reconcileCustodyPeriod({ start, end: { count: observationOf(19_000_000, false), reference: pending, scopeKey: 'TODAY' } })
  eq('raw unknown', result.rawDifference, null)
  eq('fresh unknown', result.freshDifference, null)
  eq('pending status explicit', result.freshStatus, 'UNKNOWN_REFERENCE_PENDING')
}

console.log(`\n✓ ${checked} checks passed`)
