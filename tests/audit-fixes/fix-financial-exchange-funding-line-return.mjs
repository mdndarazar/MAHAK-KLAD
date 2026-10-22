import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-exchange-line-return-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'unused.db')
const { allocateExchangeFundingLineReturn } = await import('../../src/shared/exchangeFundingLineReturn.ts')
const { allocateLineNet, returnValueOf } = await import('../../src/shared/returnValue.ts')

const mixedSources = [
  { sourceEventId: 27, sourceKind: 'SOURCE_GIFT', amount: 5 },
  { sourceEventId: 11, sourceKind: 'SOURCE_CASH', amount: 6 }
]
const wholeReturn = allocateExchangeFundingLineReturn({
  saleItemId: 401, saleItemQty: 4, saleItemValue: 11,
  previouslyReturnedQty: 0, returningQty: 4, sources: mixedSources
})
assert.equal(wholeReturn.returnValue, 11)
assert.deepEqual(wholeReturn.shares.map(({ sourceEventId, sourceKind, amount, prior, cumulative }) =>
  ({ sourceEventId, sourceKind, amount, prior, cumulative })), [
  { sourceEventId: 11, sourceKind: 'SOURCE_CASH', amount: 6, prior: 0, cumulative: 6 },
  { sourceEventId: 27, sourceKind: 'SOURCE_GIFT', amount: 5, prior: 0, cumulative: 5 }
], 'full return restores each original source-to-item amount without changing its kind')
const channelReturn = allocateExchangeFundingLineReturn({
  saleItemId: 403, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 0, returningQty: 1,
  sources: [
    { sourceEventId: 32, sourceKind: 'SOURCE_CHEQUE', amount: 40 },
    { sourceEventId: 31, sourceKind: 'SOURCE_CARD', amount: 60 }
  ]
})
assert.deepEqual(channelReturn.shares.map(({ sourceKind }) => sourceKind), ['SOURCE_CARD', 'SOURCE_CHEQUE'],
  'partial source attribution retains card and cleared-cheque channels rather than relabelling them CASH')
assert.equal(channelReturn.shares.reduce((sum, share) => sum + share.amount, 0), 50)

const s8CashFirstSources = [
  { sourceEventId: 401, sourceKind: 'SOURCE_GIFT', amount: 2_000_000 },
  { sourceEventId: 402, sourceKind: 'SOURCE_CASH', amount: 13_000_000 }
]
const s8FirstReturn = allocateExchangeFundingLineReturn({
  saleItemId: 808, saleItemQty: 3, saleItemValue: 15_000_000,
  previouslyReturnedQty: 0, returningQty: 1, sources: s8CashFirstSources, allocationPolicy: 'CASH_FIRST'
})
assert.equal(s8FirstReturn.returnValue, 5_000_000)
assert.deepEqual(s8FirstReturn.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 0 },
  { sourceKind: 'SOURCE_CASH', amount: 5_000_000 }
], 'accepted S8 policy releases the paid cash share first and leaves the 2M barcode share intact')
const s8SecondReturn = allocateExchangeFundingLineReturn({
  saleItemId: 808, saleItemQty: 3, saleItemValue: 15_000_000,
  previouslyReturnedQty: 1, returningQty: 1, sources: s8CashFirstSources,
  allocationPolicy: 'CASH_FIRST',
  priorAllocations: s8FirstReturn.shares.map(({ sourceEventId, cumulative }) => ({ sourceEventId, amount: cumulative }))
})
assert.deepEqual(s8SecondReturn.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 0 },
  { sourceKind: 'SOURCE_CASH', amount: 5_000_000 }
], 'S8 remaining source after two 5M returns is 2M gift plus 3M cash')

const s1CarrySources = [
  { sourceEventId: 1, sourceKind: 'SOURCE_GIFT', amount: 1_877_346 },
  { sourceEventId: 2, sourceKind: 'SOURCE_CASH', amount: 13_122_654 }
]
const fourteenMillionFirst = allocateExchangeFundingLineReturn({
  saleItemId: 404, saleItemQty: 15_000, saleItemValue: 15_000_000,
  previouslyReturnedQty: 0, returningQty: 14_000, sources: s1CarrySources
})
assert.deepEqual(fourteenMillionFirst.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 1_752_189 },
  { sourceKind: 'SOURCE_CASH', amount: 12_247_811 }
], 'the 14M-first cumulative split preserves the exact documented floor allocation')
const finalMillion = allocateExchangeFundingLineReturn({
  saleItemId: 404, saleItemQty: 15_000, saleItemValue: 15_000_000,
  previouslyReturnedQty: 14_000, returningQty: 1_000, sources: s1CarrySources,
  priorAllocations: fourteenMillionFirst.shares.map(({ sourceEventId, cumulative }) =>
    ({ sourceEventId, amount: cumulative }))
})
assert.deepEqual(finalMillion.shares.map(({ sourceKind, amount }) => ({ sourceKind, amount })), [
  { sourceKind: 'SOURCE_GIFT', amount: 125_157 },
  { sourceKind: 'SOURCE_CASH', amount: 874_843 }
], 'the last 1M event receives the cumulative rounding delta and both chunks restore exact totals')

let returnedQty = 0
let priorAllocations
const chunkTotals = new Map()
for (const chunk of [1, 2, 1]) {
  const part = allocateExchangeFundingLineReturn({
    saleItemId: 401, saleItemQty: 4, saleItemValue: 11,
    previouslyReturnedQty: returnedQty, returningQty: chunk, sources: mixedSources,
    ...(priorAllocations === undefined ? {} : { priorAllocations })
  })
  assert.equal(part.shares.reduce((sum, share) => sum + share.amount, 0), part.returnValue)
  for (const share of part.shares) {
    assert.ok(share.amount >= 0)
    assert.ok(share.cumulative >= share.prior)
    assert.ok(share.cumulative <= mixedSources.find((source) => source.sourceEventId === share.sourceEventId).amount)
    chunkTotals.set(share.sourceEventId, (chunkTotals.get(share.sourceEventId) ?? 0) + share.amount)
  }
  returnedQty += chunk
  priorAllocations = part.shares.map(({ sourceEventId, cumulative }) => ({ sourceEventId, amount: cumulative }))
}
assert.deepEqual([...chunkTotals.entries()].sort((a, b) => a[0] - b[0]), [[11, 6], [27, 5]],
  'partial-return chunking sums to exactly the same original source shares')
assert.deepEqual(priorAllocations, wholeReturn.shares.map(({ sourceEventId, amount }) => ({ sourceEventId, amount })))

// A return in any chunk must match the same active cumulative baseline. The
// tests below verify every contiguous quantity range against one-at-a-time
// allocation, independent of caller ordering or the chosen chunk size.
const oneAtATime = []
let oneAtATimePrior = undefined
for (let qty = 1; qty <= 4; qty++) {
  const result = allocateExchangeFundingLineReturn({
    saleItemId: 402, saleItemQty: 4, saleItemValue: 11,
    previouslyReturnedQty: qty - 1, returningQty: 1, sources: mixedSources,
    ...(oneAtATimePrior === undefined ? {} : { priorAllocations: oneAtATimePrior })
  })
  oneAtATime.push(result)
  oneAtATimePrior = result.shares.map(({ sourceEventId, cumulative }) => ({ sourceEventId, amount: cumulative }))
}
for (let start = 0; start < 4; start++) {
  for (let end = start + 1; end <= 4; end++) {
    const fromOneAtATime = oneAtATime[end - 1].shares.map((share) => share.cumulative)
    const startPrior = start === 0 ? undefined : oneAtATime[start - 1].shares.map(({ sourceEventId, cumulative }) =>
      ({ sourceEventId, amount: cumulative }))
    const chunk = allocateExchangeFundingLineReturn({
      saleItemId: 402, saleItemQty: 4, saleItemValue: 11,
      previouslyReturnedQty: start, returningQty: end - start, sources: mixedSources,
      ...(startPrior === undefined ? {} : { priorAllocations: startPrior })
    })
    assert.deepEqual(chunk.shares.map((share) => share.cumulative), fromOneAtATime,
      `return quantities ${start}..${end} must match one-at-a-time cumulative allocation`)
  }
}

let exhaustiveCases = 0
for (let soldQty = 1; soldQty <= 6; soldQty++) {
  for (let lineValue = 1; lineValue <= 16; lineValue++) {
    for (let giftAmount = 0; giftAmount <= lineValue; giftAmount++) {
      const sources = [
        ...(lineValue - giftAmount > 0 ? [{ sourceEventId: 7, sourceKind: 'SOURCE_CASH', amount: lineValue - giftAmount }] : []),
        ...(giftAmount > 0 ? [{ sourceEventId: 3, sourceKind: 'SOURCE_GIFT', amount: giftAmount }] : [])
      ]
      const history = [{ qty: 0, allocations: undefined, cumulative: [] }]
      for (let qty = 1; qty <= soldQty; qty++) {
        const prev = history[qty - 1]
        const result = allocateExchangeFundingLineReturn({
          saleItemId: 900 + soldQty, saleItemQty: soldQty, saleItemValue: lineValue,
          previouslyReturnedQty: prev.qty, returningQty: 1, sources,
          ...(prev.allocations === undefined ? {} : { priorAllocations: prev.allocations })
        })
        assert.equal(result.returnValue, returnValueOf(lineValue, soldQty, qty - 1, 1))
        assert.equal(result.shares.reduce((sum, share) => sum + share.amount, 0), result.returnValue)
        history.push({ qty, allocations: result.shares.map(({ sourceEventId, cumulative }) =>
          ({ sourceEventId, amount: cumulative })), cumulative: result.shares.map((share) => share.cumulative) })
      }
      assert.equal(history[soldQty].cumulative.reduce((sum, amount) => sum + amount, 0), lineValue)
      for (let start = 0; start < soldQty; start++) {
        for (let end = start + 1; end <= soldQty; end++) {
          const previous = history[start]
          const result = allocateExchangeFundingLineReturn({
            saleItemId: 900 + soldQty, saleItemQty: soldQty, saleItemValue: lineValue,
            previouslyReturnedQty: start, returningQty: end - start, sources,
            ...(previous.allocations === undefined ? {} : { priorAllocations: previous.allocations })
          })
          assert.deepEqual(result.shares.map((share) => share.cumulative), history[end].cumulative,
            `chunk-invariant source matrix ${JSON.stringify({ soldQty, lineValue, giftAmount, start, end })}`)
          exhaustiveCases++
        }
      }
    }
  }
}

const maxSafe = Number.MAX_SAFE_INTEGER
const maxSafeChunks = [
  returnValueOf(maxSafe, 3, 0, 1),
  returnValueOf(maxSafe, 3, 1, 1),
  returnValueOf(maxSafe, 3, 2, 1)
]
assert.deepEqual(maxSafeChunks, [3_002_399_751_580_330, 3_002_399_751_580_331, 3_002_399_751_580_330])
assert.equal(maxSafeChunks.reduce((sum, value) => sum + value, 0), maxSafe,
  'integer Rial apportionment remains exact near Number.MAX_SAFE_INTEGER')
const exactLargeLineNets = allocateLineNet({
  grandTotal: BigInt(maxSafe),
  items: [
    { id: 1, qty: 1, unitPrice: BigInt(maxSafe), lineTotal: BigInt(maxSafe) },
    { id: 2, qty: 1, unitPrice: BigInt(maxSafe), lineTotal: BigInt(maxSafe) }
  ]
})
assert.deepEqual([...exactLargeLineNets.entries()], [[1, 4_503_599_627_370_496], [2, 4_503_599_627_370_495]])
assert.equal([...exactLargeLineNets.values()].reduce((sum, value) => sum + value, 0), maxSafe,
  'line-net snapshot allocation uses exact BigInt products and deterministic tie-breaking')
const maxSafeSources = [
  { sourceEventId: 51, sourceKind: 'SOURCE_GIFT', amount: 1_000 },
  { sourceEventId: 52, sourceKind: 'SOURCE_CASH', amount: maxSafe - 1_000 }
]
const maxSafeReturn = allocateExchangeFundingLineReturn({
  saleItemId: 999, saleItemQty: 3, saleItemValue: maxSafe,
  previouslyReturnedQty: 0, returningQty: 1, sources: maxSafeSources
})
assert.equal(maxSafeReturn.returnValue, maxSafeChunks[0])
assert.equal(maxSafeReturn.shares.reduce((sum, share) => sum + share.amount, 0), maxSafeChunks[0])
assert.ok(maxSafeReturn.shares.every((share) => share.amount >= 0))

assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 0, returningQty: 1,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_GIFT', amount: 99 }]
}), /INVALID_EXCHANGE_RETURN_ALLOCATION_BASIS/, 'source-to-item snapshot mismatch fails closed')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 1, returningQty: 1,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_GIFT', amount: 100 }]
}), /MISSING_EXCHANGE_RETURN_ALLOCATION_HISTORY/, 'an earlier return without its source allocation fails closed')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 1, returningQty: 1,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_GIFT', amount: 100 }],
  priorAllocations: []
}), /MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY/, 'incomplete earlier source rows fail closed')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 1, returningQty: 1,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_GIFT', amount: 100 }],
  priorAllocations: [{ sourceEventId: 2, amount: 0 }]
}), /MISMATCHED_EXCHANGE_RETURN_ALLOCATION_HISTORY/, 'stale/contradictory persisted source amounts fail closed')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 0, returningQty: 1,
  sources: [
    { sourceEventId: 2, sourceKind: 'SOURCE_GIFT', amount: 50 },
    { sourceEventId: 2, sourceKind: 'SOURCE_CASH', amount: 50 }
  ]
}), /INVALID_EXCHANGE_RETURN_ALLOCATION_BASIS/, 'duplicate source event IDs fail closed')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 0, returningQty: 1,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_UNKNOWN', amount: 100 }]
}), /INVALID_EXCHANGE_RETURN_ALLOCATION_BASIS/, 'unknown source kind cannot be assigned to cash or gift')
assert.throws(() => allocateExchangeFundingLineReturn({
  saleItemId: 1, saleItemQty: 2, saleItemValue: 100,
  previouslyReturnedQty: 0, returningQty: 3,
  sources: [{ sourceEventId: 2, sourceKind: 'SOURCE_CASH', amount: 100 }]
}), /INVALID_EXCHANGE_RETURN_ALLOCATION_BASIS/, 'over-returning quantity fails closed')

console.log(`✓ exchange-line return provenance: mixed sources stay distinct, cumulative/chunk-invariant shares, exact MAX_SAFE_INTEGER, ${exhaustiveCases} exhaustive cases`)
