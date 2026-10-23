import assert from 'node:assert/strict'
import {
  allocateExchangeFundingByLine,
  allocateExchangeFundingCashFirst,
  allocateExchangeFundingGiftFirst,
  allocateExchangeFundingGiftFirstBySource,
  allocateExchangeFundingProportionalFloor,
  allocateExchangeFundingProRata
} from '../../src/shared/exchangeFundingAllocation.ts'
import { allocateExchangeFundingLineReturn } from '../../src/shared/exchangeFundingLineReturn.ts'

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

// Historical proportional-floor arithmetic remains covered for immutable
// version-2 rows only. New S1 uses cash-first below and issues one successor
// barcode for a gift-root remainder instead of splitting B/N.
const s1Floor = allocateExchangeFundingProportionalFloor({
  replacementTotal: 15_000_000,
  sources: [
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 },
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 }
  ]
})
assert.deepEqual(s1Floor, {
  giftCarry: 1_877_346,
  cashCarry: 13_122_654,
  allocations: [
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', carry: 1_877_346, remainder: 122_654 },
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', carry: 13_122_654, remainder: 857_346 }
  ]
})
assert.deepEqual(allocateExchangeFundingProportionalFloor({
  replacementTotal: 15_000_000,
  sources: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
  ]
}), s1Floor, 'S1 allocation is independent of source input ordering')
assert.equal(s1Floor.allocations.reduce((sum, row) => sum + row.carry + row.remainder, 0), 15_980_000)
assert.equal(s1Floor.allocations.reduce((sum, row) => sum + row.carry, 0), 15_000_000)
assert.equal(s1Floor.allocations.reduce((sum, row) => sum + row.remainder, 0), 980_000)
assert.throws(() => allocateExchangeFundingProportionalFloor({
  replacementTotal: 15_980_001,
  sources: [
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 },
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 }
  ]
}), /proven/i, 'unfunded replacement value cannot be classified as gift or cash')

// Accepted S1 policy: carry actual cash/card/cleared-cheque shares first;
// only the remaining replacement value consumes non-cash barcode shares.
const s1CashFirst = allocateExchangeFundingCashFirst({
  replacementTotal: 15_000_000,
  sources: [
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 },
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 }
  ]
})
assert.deepEqual(s1CashFirst, {
  cashCarry: 13_980_000,
  creditCarry: 1_020_000,
  giftCarry: 1_020_000,
  allocations: [
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', carry: 1_020_000, remainder: 980_000 },
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', carry: 13_980_000, remainder: 0 }
  ]
})
assert.equal(allocateExchangeFundingCashFirst({
  replacementTotal: 15_000_000,
  sources: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
  ]
}).allocations.map((row) => row.carry).join(','), '13980000,1020000',
  'cash-first results are stable under input permutation and map back to source order')
assert.throws(() => allocateExchangeFundingCashFirst({ replacementTotal: 15_980_001, sources: [
  { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 },
  { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_980_000 }
]}), /proven/i)
const s1MultipleRoots = allocateExchangeFundingProportionalFloor({
  replacementTotal: 7,
  sources: [
    { sourceEventId: 1, sourceKind: 'SOURCE_GIFT', available: 1 },
    { sourceEventId: 2, sourceKind: 'SOURCE_GIFT', available: 2 },
    { sourceEventId: 3, sourceKind: 'SOURCE_CASH', available: 7 }
  ]
})
assert.deepEqual(s1MultipleRoots, {
  giftCarry: 2,
  cashCarry: 5,
  allocations: [
    { sourceEventId: 1, sourceKind: 'SOURCE_GIFT', carry: 0, remainder: 1 },
    { sourceEventId: 2, sourceKind: 'SOURCE_GIFT', carry: 2, remainder: 0 },
    { sourceEventId: 3, sourceKind: 'SOURCE_CASH', carry: 5, remainder: 2 }
  ]
}, 'cumulative floors partition a source kind across multiple immutable roots')

let s1FloorCases = 0
for (let giftAvailable = 0; giftAvailable <= 6; giftAvailable++) {
  for (let cashAvailable = 0; cashAvailable <= 6; cashAvailable++) {
    const totalAvailable = giftAvailable + cashAvailable
    for (let target = 0; target <= totalAvailable; target++) {
      const sources = [
        { sourceEventId: 10, sourceKind: 'SOURCE_GIFT', available: giftAvailable },
        { sourceEventId: 20, sourceKind: 'SOURCE_CASH', available: cashAvailable }
      ]
      const plan = allocateExchangeFundingProportionalFloor({ replacementTotal: target, sources })
      const expectedGift = totalAvailable === 0 ? 0 : Math.floor(giftAvailable * target / totalAvailable)
      assert.equal(plan.giftCarry, expectedGift)
      assert.equal(plan.cashCarry, target - expectedGift)
      assert.equal(plan.allocations.reduce((sum, row) => sum + row.carry, 0), target)
      assert.equal(plan.allocations.reduce((sum, row) => sum + row.remainder, 0), totalAvailable - target)
      assert.ok(plan.allocations.every((row) => row.carry >= 0 && row.remainder >= 0))
      assert.deepEqual(allocateExchangeFundingProportionalFloor({
        replacementTotal: target, sources: [...sources].reverse()
      }), plan, 'input order cannot alter a fixed source-ID allocation')
      s1FloorCases++
    }
  }
}
assert.equal(s1FloorCases, 343, 'all bounded gift/cash/target combinations are checked')
assert.throws(() => allocateExchangeFundingProportionalFloor({
  replacementTotal: 1,
  sources: [{ sourceEventId: 1, sourceKind: 'SOURCE_UNKNOWN', available: 1 }]
}), /proven/i, 'unknown sources cannot enter the S1 gift/cash planner')
assert.throws(() => allocateExchangeFundingProportionalFloor({
  replacementTotal: 1,
  sources: [
    { sourceEventId: 1, sourceKind: 'SOURCE_GIFT', available: 1 },
    { sourceEventId: 1, sourceKind: 'SOURCE_CASH', available: 1 }
  ]
}), /unique/i, 'a duplicate source event cannot be allocated twice')

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
// FINAL-DESIGN S4 exact fixture: 5M gift + 20M cash apportioned across
// 10M / 10M / 5M replacement lines. Then return one unit of the 5M line.
const s4LineFunding = allocateExchangeFundingByLine(
  [
    { saleItemId: 41, amount: 10_000_000 },
    { saleItemId: 42, amount: 10_000_000 },
    { saleItemId: 43, amount: 5_000_000 }
  ],
  [
    { sourceEventId: 301, sourceKind: 'SOURCE_GIFT', amount: 5_000_000 },
    { sourceEventId: 302, sourceKind: 'SOURCE_CASH', amount: 20_000_000 }
  ]
)
assert.deepEqual(s4LineFunding, [
  { sourceEventId: 301, saleItemId: 41, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { sourceEventId: 301, saleItemId: 42, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { sourceEventId: 301, saleItemId: 43, sourceKind: 'SOURCE_GIFT', amount: 1_000_000 },
  { sourceEventId: 302, saleItemId: 41, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { sourceEventId: 302, saleItemId: 42, sourceKind: 'SOURCE_CASH', amount: 8_000_000 },
  { sourceEventId: 302, saleItemId: 43, sourceKind: 'SOURCE_CASH', amount: 4_000_000 }
], 'S4 source and item margins match exactly; gift is never relabelled as cash')
const s4ThirdLineSources = [
  { sourceEventId: 301, sourceKind: 'SOURCE_GIFT', amount: 1_000_000 },
  { sourceEventId: 302, sourceKind: 'SOURCE_CASH', amount: 4_000_000 }
]
const s4OneUnitReturn = allocateExchangeFundingLineReturn({
  saleItemId: 43, saleItemQty: 5, saleItemValue: 5_000_000,
  previouslyReturnedQty: 0, returningQty: 1, sources: s4ThirdLineSources
})
assert.deepEqual(s4OneUnitReturn.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 200_000 },
  { sourceKind: 'SOURCE_CASH', amount: 800_000 }
], 'S4 one-unit partial return preserves 20% gift / 80% cash attribution exactly')
let s4ReturnedQty = 1
let s4Prior = s4OneUnitReturn.shares.map(({ sourceEventId, cumulative }) => ({ sourceEventId, amount: cumulative }))
const s4RestReturn = allocateExchangeFundingLineReturn({
  saleItemId: 43, saleItemQty: 5, saleItemValue: 5_000_000,
  previouslyReturnedQty: s4ReturnedQty, returningQty: 4,
  sources: s4ThirdLineSources, priorAllocations: s4Prior
})
assert.deepEqual(s4RestReturn.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 800_000 },
  { sourceKind: 'SOURCE_CASH', amount: 3_200_000 }
], 'S4 later return chunk completes the exact 1M gift / 4M cash line totals')
assert.deepEqual(s4RestReturn.shares.map(({ sourceKind, cumulative }) => ({ sourceKind, cumulative })), [
  { sourceKind: 'SOURCE_GIFT', cumulative: 1_000_000 },
  { sourceKind: 'SOURCE_CASH', cumulative: 4_000_000 }
])

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

const chainedGiftFirst = allocateExchangeFundingGiftFirstBySource({
  replacementTotal: 14_000_000,
  sources: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_000_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
  ]
})
assert.deepEqual(chainedGiftFirst, {
  giftCarry: 2_000_000,
  realMoneyCarry: 12_000_000,
  allocations: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', carry: 12_000_000, remainder: 1_000_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', carry: 2_000_000, remainder: 0 }
  ]
}, 'chained cheaper exchange carries the rooted barcode first and leaves a separately identifiable real-money remainder')
const chainGiftRemainder = allocateExchangeFundingGiftFirstBySource({
  replacementTotal: 1_000_000,
  sources: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', available: 13_000_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', available: 2_000_000 }
  ]
})
assert.deepEqual(chainGiftRemainder, {
  giftCarry: 1_000_000,
  realMoneyCarry: 0,
  allocations: [
    { sourceEventId: 202, sourceKind: 'SOURCE_CASH', carry: 0, remainder: 13_000_000 },
    { sourceEventId: 101, sourceKind: 'SOURCE_GIFT', carry: 1_000_000, remainder: 1_000_000 }
  ]
}, 'unused rooted credit and actual cash remain separate for their distinct return choices')
assert.throws(() => allocateExchangeFundingGiftFirstBySource({
  replacementTotal: 1, sources: [{ sourceEventId: 1, sourceKind: 'SOURCE_B', available: 1 }]
}), RangeError, 'B/N rights cannot be guessed into the generic gift/cash chain policy')

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

console.log(`✓ exchange funding allocation: legacy proportional replay, ${s1FloorCases} exhaustive bounded cases, multi-root cumulative floors, exact per-item attribution and invalid-input rejection`)
