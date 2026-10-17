/**
 * Exact, non-financial warning from two human counts of the SAME handover.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s446-custody-peer-count-comparison.mjs
 */
import assert from 'node:assert/strict'
import { compareCustodyPeerCounts as compare } from '../../src/shared/custodyPeerCount.ts'
import { custodyPeerWarningText } from '../../src/shared/custodyPeerWarningText.ts'
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const explicit = (humanAmount) => ({ countOrigin: humanAmount === 0n ? 'EXPLICIT_ZERO' : 'EXPLICIT_AMOUNT', humanAmount })
const result = (status, direction, absoluteDifferenceRial, selfCount = false) => ({ status, direction, absoluteDifferenceRial, selfCount })
eq('receiver counted MORE: 10m → 15m means +5m in rial', compare(explicit(10_000_000n), explicit(15_000_000n)), result('DIFFERENT', 'MORE', '5000000'))
eq('receiver counted LESS: 15m → 10m means -5m in rial', compare(explicit(15_000_000n), explicit(10_000_000n)), result('DIFFERENT', 'LESS', '5000000'))
eq('equal counts show no warning', compare(explicit(10_000_000n), explicit(10_000_000n)), result('EQUAL', null, '0'))
eq('explicit human zero is a real matching count', compare(explicit(0n), explicit(0n)), result('EQUAL', null, '0'))
eq('zero first and five million second warns MORE', compare(explicit(0n), explicit(5_000_000n)), result('DIFFERENT', 'MORE', '5000000'))
eq('five million first and zero second warns LESS', compare(explicit(5_000_000n), explicit(0n)), result('DIFFERENT', 'LESS', '5000000'))
eq('two independently attested counts may be by the SAME person', compare(explicit(1_000n), explicit(1_200n), true), result('DIFFERENT', 'MORE', '200', true))
eq('old system absence is not an outgoing human count', compare({ countOrigin: 'SYSTEM_ABSENCE_ZERO', humanAmount: null }, explicit(5_000_000n)), result('NOT_APPLICABLE', null, null))
eq('new absence is not a synthetic human zero', compare({ countOrigin: 'ABSENT_UNCOUNTED', humanAmount: null }, explicit(5_000_000n)), result('NOT_APPLICABLE', null, null))
eq('optional blank is not a real zero', compare({ countOrigin: 'EMPTY_OPTIONAL', humanAmount: null }, explicit(0n)), result('NOT_APPLICABLE', null, null))
eq('missing older count is not treated as zero', compare(null, explicit(10_000_000n)), result('NOT_APPLICABLE', null, null))
eq('missing receiver count is not treated as zero', compare(explicit(10_000_000n), null), result('NOT_APPLICABLE', null, null))
eq('a mismatched zero origin is not comparable', compare({ countOrigin: 'EXPLICIT_AMOUNT', humanAmount: 0n }, explicit(1n)), result('NOT_APPLICABLE', null, null))
eq('a missing explicit amount is not comparable', compare({ countOrigin: 'EXPLICIT_AMOUNT', humanAmount: null }, explicit(1n)), result('NOT_APPLICABLE', null, null))
eq('unsafe Number is not rounded into a warning', compare({ countOrigin: 'EXPLICIT_AMOUNT', humanAmount: Number.MAX_SAFE_INTEGER + 1 }, explicit(1n)), result('NOT_APPLICABLE', null, null))
eq('negative amount is not trusted as a human witness', compare({ countOrigin: 'EXPLICIT_AMOUNT', humanAmount: -2n }, explicit(1n)), result('NOT_APPLICABLE', null, null))
eq('a large positive difference stays EXACT on the wire', compare(explicit(0n), explicit(9_223_372_036_854_775_807n)), result('DIFFERENT', 'MORE', '9223372036854775807'))
eq('a large negative difference stays EXACT on the wire', compare(explicit(9_223_372_036_854_775_807n), explicit(0n)), result('DIFFERENT', 'LESS', '9223372036854775807'))
eq('comparison does not need a blue reference at all', compare(explicit(1_000n), explicit(920n)), result('DIFFERENT', 'LESS', '80'))
eq('MORE is an exact Persian rial warning', custodyPeerWarningText(compare(explicit(10_000_000n), explicit(15_000_000n))),
  'شمارش شما ۵٬۰۰۰٬۰۰۰ ریال بیشتر از شمارش مسئول قبلی است.')
eq('LESS is an exact Persian rial warning', custodyPeerWarningText(compare(explicit(15_000_000n), explicit(10_000_000n))),
  'شمارش شما ۵٬۰۰۰٬۰۰۰ ریال کمتر از شمارش مسئول قبلی است.')
eq('self boundary does not call the same worker the previous worker', custodyPeerWarningText(compare(explicit(0n), explicit(2_000n), true)),
  'شمارش دوم شما ۲٬۰۰۰ ریال بیشتر از شمارش اول خودتان است.')
eq('equal counts do not produce an alert', custodyPeerWarningText(compare(explicit(0n), explicit(0n))), null)
eq('absence has no two-human alert', custodyPeerWarningText(compare({ countOrigin: 'ABSENT_UNCOUNTED', humanAmount: null }, explicit(0n))), null)
eq('large amounts are formatted without Number rounding', custodyPeerWarningText(compare(explicit(0n), explicit(9_223_372_036_854_775_807n))),
  'شمارش شما ۹٬۲۲۳٬۳۷۲٬۰۳۶٬۸۵۴٬۷۷۵٬۸۰۷ ریال بیشتر از شمارش مسئول قبلی است.')
console.log(`\n✓ ${checks} exact peer-warning comparison and copy checks passed`)
