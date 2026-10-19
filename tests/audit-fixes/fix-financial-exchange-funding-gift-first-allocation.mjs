import assert from 'node:assert/strict'
import {
  allocateExchangeFundingByLine,
  allocateExchangeFundingGiftFirst,
  allocateExchangeFundingProRata
} from '../../src/shared/exchangeFundingAllocation.ts'

const ownerExample = allocateExchangeFundingGiftFirst({
  giftAvailable: 2_000_000,
  realMoneyAvailable: 13_980_000,
  replacementTotal: 15_000_000
})
assert.deepEqual(ownerExample, {
  giftCarry: 2_000_000,
  realMoneyCarry: 13_000_000,
  giftRemainder: 0,
  realMoneyRemainder: 980_000,
  unfundedReplacement: 0
})
assert.equal(
  ownerExample.giftCarry + ownerExample.realMoneyCarry + ownerExample.unfundedReplacement,
  15_000_000,
  'carried sources plus any unfunded balance reconcile exactly to replacement value'
)
assert.equal(
  ownerExample.realMoneyCarry + ownerExample.realMoneyRemainder,
  13_980_000,
  'real-money source is partitioned exactly; the 980,000 remainder is not gift'
)

const lineFunding = allocateExchangeFundingByLine(
  [
    { saleItemId: 22, amount: 14_000_000 },
    { saleItemId: 23, amount: 1_000_000 }
  ],
  [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', amount: ownerExample.realMoneyCarry },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', amount: ownerExample.giftCarry }
  ]
)
assert.deepEqual(lineFunding, [
  { sourceEventId: 101, saleItemId: 22, sourceKind: 'SOURCE_GIFT', amount: 1_866_667 },
  { sourceEventId: 101, saleItemId: 23, sourceKind: 'SOURCE_GIFT', amount: 133_333 },
  { sourceEventId: 202, saleItemId: 22, sourceKind: 'SOURCE_CASH', amount: 12_133_333 },
  { sourceEventId: 202, saleItemId: 23, sourceKind: 'SOURCE_CASH', amount: 866_667 }
], 'gift-first carried value is then partitioned by exact replacement line value')
assert.deepEqual(
  allocateExchangeFundingByLine(
    [{ saleItemId: 23, amount: 1_000_000 }, { saleItemId: 22, amount: 14_000_000 }],
    [
      { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', amount: ownerExample.giftCarry },
      { sourceEventId: 202, sourceKind: 'SOURCE_CASH', amount: ownerExample.realMoneyCarry }
    ]
  ),
  lineFunding,
  'line and source input order do not change the stable per-item attribution'
)
const balancedRialTie = allocateExchangeFundingByLine(
  [{ saleItemId: 2, amount: 1 }, { saleItemId: 1, amount: 1 }],
  [
    { sourceEventId: 20, sourceKind: 'SOURCE_CASH', amount: 1 },
    { sourceEventId: 10, sourceKind: 'SOURCE_GIFT', amount: 1 }
  ]
)
assert.deepEqual(balancedRialTie, [
  { sourceEventId: 10, saleItemId: 1, sourceKind: 'SOURCE_GIFT', amount: 1 },
  { sourceEventId: 20, saleItemId: 2, sourceKind: 'SOURCE_CASH', amount: 1 }
], 'largest-remainder ties reconcile both source and item totals, even at one rial')

function compositions(total, slots) {
  if (slots === 1) return [[total]]
  const result = []
  for (let first = 0; first <= total; first++)
    for (const tail of compositions(total - first, slots - 1)) result.push([first, ...tail])
  return result
}
let roundingMatricesChecked = 0
for (let sourceCount = 1; sourceCount <= 3; sourceCount++) {
  for (let lineCount = 1; lineCount <= 3; lineCount++) {
    for (let total = 1; total <= 6; total++) {
      for (const sourceAmounts of compositions(total, sourceCount)) {
        for (const lineAmounts of compositions(total, lineCount)) {
          const allocations = allocateExchangeFundingByLine(
            lineAmounts.map((amount, index) => ({ saleItemId: 100 + index, amount })),
            sourceAmounts.map((amount, index) => ({
              sourceEventId: 200 + index, sourceKind: 'SOURCE_CASH', amount
            }))
          )
          for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex++) {
            const sourceId = 200 + sourceIndex
            const actual = allocations.filter((row) => row.sourceEventId === sourceId)
              .reduce((sum, row) => sum + row.amount, 0)
            assert.equal(actual, sourceAmounts[sourceIndex], 'every source margin must be exact')
            for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
              const lineId = 100 + lineIndex
              const allocation = allocations.find((row) => row.sourceEventId === sourceId && row.saleItemId === lineId)
              const actual = BigInt(allocation?.amount ?? 0)
              const numerator = BigInt(sourceAmounts[sourceIndex]) * BigInt(lineAmounts[lineIndex])
              const floor = numerator / BigInt(total)
              assert.ok(actual === floor || actual === floor + 1n,
                'each cell must stay at the floor or ceiling of its exact proportional share')
            }
          }
          for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const lineId = 100 + lineIndex
            const actual = allocations.filter((row) => row.saleItemId === lineId)
              .reduce((sum, row) => sum + row.amount, 0)
            assert.equal(actual, lineAmounts[lineIndex], 'every item margin must be exact')
          }
          roundingMatricesChecked++
        }
      }
    }
  }
}
assert.ok(roundingMatricesChecked > 1_000, 'exercise a broad range of small exact rounding matrices')
assert.throws(() => allocateExchangeFundingByLine(
  [{ saleItemId: 1, amount: 1_000 }],
  [{ sourceEventId: 1, sourceKind: 'SOURCE_CASH', amount: 999 }]
), RangeError, 'unfunded or unknown value is not silently assigned to a replacement item')
assert.throws(() => allocateExchangeFundingByLine(
  [{ saleItemId: 1, amount: 1 }],
  [{ sourceEventId: 1, sourceKind: 'SOURCE_UNKNOWN', amount: 1 }]
), RangeError, 'unknown origins never become line-level cash or gift')

const giftExceedsReplacement = allocateExchangeFundingGiftFirst({
  giftAvailable: 2_000_000,
  realMoneyAvailable: 13_980_000,
  replacementTotal: 1_500_000
})
assert.deepEqual(giftExceedsReplacement, {
  giftCarry: 1_500_000,
  realMoneyCarry: 0,
  giftRemainder: 500_000,
  realMoneyRemainder: 13_980_000,
  unfundedReplacement: 0
}, 'unused gift remains a separately identified gift share, never relabelled as real-money right')

const insufficientProvenFunds = allocateExchangeFundingGiftFirst({
  giftAvailable: 300_000,
  realMoneyAvailable: 400_000,
  replacementTotal: 1_000_000
})
assert.deepEqual(insufficientProvenFunds, {
  giftCarry: 300_000,
  realMoneyCarry: 400_000,
  giftRemainder: 0,
  realMoneyRemainder: 0,
  unfundedReplacement: 300_000
}, 'missing proven sources stay explicit; the planner does not silently invent new money or debt')

for (const invalid of [
  { giftAvailable: -1, realMoneyAvailable: 0, replacementTotal: 0 },
  { giftAvailable: 0.5, realMoneyAvailable: 0, replacementTotal: 0 },
  { giftAvailable: Number.MAX_SAFE_INTEGER + 1, realMoneyAvailable: 0, replacementTotal: 0 },
  { giftAvailable: 0, realMoneyAvailable: 0, replacementTotal: NaN }
]) {
  assert.throws(() => allocateExchangeFundingGiftFirst(invalid), RangeError)
}

const proRata = allocateExchangeFundingProRata(300, [
  { id: 20, available: 300 },
  { id: 10, available: 100 }
])
assert.deepEqual(proRata, [
  { id: 20, amount: 225 },
  { id: 10, amount: 75 }
], 'each proven share is partitioned proportionally with exact integer-rial totals')
assert.equal(proRata.reduce((sum, row) => sum + row.amount, 0), 300)
const tiedRemainder = allocateExchangeFundingProRata(1, [
  { id: 20, available: 1 },
  { id: 10, available: 1 }
])
assert.deepEqual(tiedRemainder, [
  { id: 20, amount: 0 },
  { id: 10, amount: 1 }
], 'equal fractional remainders are broken by stable event ID, not row order')
assert.throws(() => allocateExchangeFundingProRata(2, [{ id: 1, available: 1 }]), RangeError)
assert.throws(() => allocateExchangeFundingProRata(1, [
  { id: 1, available: 1 }, { id: 1, available: 1 }
]), RangeError)

console.log('✓ exchange funding allocation: gift-first carry, exact per-item gift/cash attribution, deterministic rial rounding, shortfall/unknown quarantine, invalid-input rejection')
