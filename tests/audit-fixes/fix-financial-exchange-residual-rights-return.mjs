import assert from 'node:assert/strict'
import { allocateS1ResidualRightReturn } from '../../src/shared/exchangeResidualRightReturn.ts'

const B = 122_654
const N = 457_346
const TOTAL = B + N
const one = allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
  previouslyReturned: 0, returningAmount: 1_000 })
assert.deepEqual(one, { returnedBefore: 0, returningAmount: 1_000, returnedAfter: 1_000,
  b: { prior: 0, amount: 211, cumulative: 211 },
  n: { prior: 0, amount: 789, cumulative: 789 } })

const full = allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
  previouslyReturned: 0, returningAmount: TOTAL })
assert.deepEqual(full.b, { prior: 0, amount: B, cumulative: B })
assert.deepEqual(full.n, { prior: 0, amount: N, cumulative: N })

function chunks(parts) {
  let returned = 0
  let b = 0
  let n = 0
  const rows = []
  for (const amount of parts) {
    const result = allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
      previouslyReturned: returned, returningAmount: amount,
      ...(returned ? { priorAllocations: { b, n } } : {}) })
    rows.push(result)
    returned += amount
    b = result.b.cumulative
    n = result.n.cumulative
  }
  return { returned, b, n, rows }
}
const reverseOrder = chunks([14_000, 186_000, 380_000])
assert.deepEqual([reverseOrder.returned, reverseOrder.b, reverseOrder.n], [580_000, B, N],
  'partial returns restore the same two rights exactly, independent of chunking')
const singleRial = chunks(Array(580_000).fill(1))
assert.deepEqual([singleRial.returned, singleRial.b, singleRial.n], [580_000, B, N],
  'a one-Rial-at-a-time return sequence cannot lose or create residual-right value')
assert.equal(singleRial.rows.reduce((sum, row) => sum + row.b.amount + row.n.amount, 0), TOTAL)
assert.equal(singleRial.rows[0].b.amount, 0)
assert.equal(singleRial.rows[0].n.amount, 1)

assert.throws(() => allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
  previouslyReturned: 0, returningAmount: TOTAL + 1 }), /INVALID_S1_RESIDUAL_RIGHT_RETURN/)
assert.throws(() => allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
  previouslyReturned: 1_000, returningAmount: 1_000,
  priorAllocations: { b: 210, n: 790 } }), /MISMATCHED_S1_RESIDUAL_RIGHT_RETURN_HISTORY/)
assert.throws(() => allocateS1ResidualRightReturn({ bAmount: B, nAmount: N,
  previouslyReturned: 0, returningAmount: 0 }), /INVALID_S1_RESIDUAL_RIGHT_RETURN/)
assert.throws(() => allocateS1ResidualRightReturn({ bAmount: 0, nAmount: 0,
  previouslyReturned: 0, returningAmount: 1 }), /INVALID_S1_RESIDUAL_RIGHT_RETURN/)

console.log('✓ S1 sale-2 return apportionment: B-first floor, one-Rial delta, chunk-invariance, exact full restoration')
