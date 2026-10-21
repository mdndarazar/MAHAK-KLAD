import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-credit-return-rounding-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'unused.db')
const { allocateCreditReturn } = await import('../../src/shared/creditReturnProvenance.ts')
const { planCreditReturn } = await import('../../src/main/services/CreditReturnService.ts')

const negativeRemainderCase = allocateCreditReturn({
  fundedPurchase: 7,
  fundedPreviouslyReturned: 2,
  fundedReturning: 1,
  redemptions: [{ id: 1, amount: 3 }, { id: 2, amount: 1 }]
})
assert.deepEqual(negativeRemainderCase, {
  credit: 0,
  cash: 1,
  shares: [
    { redemptionId: 1, amount: 0, prior: 1 },
    { redemptionId: 2, amount: 0, prior: 0 }
  ]
}, 'cumulative gift total stays fixed; source attribution must not move backward or go negative')

assert.throws(() => allocateCreditReturn({
  fundedPurchase: 7,
  fundedPreviouslyReturned: 2,
  fundedReturning: 1,
  redemptions: [{ id: 1, amount: 3 }, { id: 2, amount: 1 }],
  priorShares: [{ redemptionId: 1, amount: 0 }, { redemptionId: 2, amount: 1 }]
}), /INVALID_CREDIT_RETURN_BASIS/,
'legacy source shares that differ from the new cumulative basis are never rewritten; continuation fails closed')

const continuedWebster = allocateCreditReturn({
  fundedPurchase: 7,
  fundedPreviouslyReturned: 3,
  fundedReturning: 1,
  redemptions: [{ id: 1, amount: 3 }, { id: 2, amount: 1 }],
  priorShares: [{ redemptionId: 1, amount: 1 }, { redemptionId: 2, amount: 0 }]
})
assert.deepEqual(continuedWebster, {
  credit: 1,
  cash: 0,
  shares: [
    { redemptionId: 1, amount: 1, prior: 1 },
    { redemptionId: 2, amount: 0, prior: 0 }
  ]
}, 'new value follows the fixed cumulative Webster schedule')

const tiedSources = allocateCreditReturn({
  fundedPurchase: 4,
  fundedPreviouslyReturned: 0,
  fundedReturning: 2,
  redemptions: [{ id: 2, amount: 1 }, { id: 1, amount: 1 }]
})
assert.deepEqual(tiedSources, {
  credit: 1,
  cash: 1,
  shares: [
    { redemptionId: 2, amount: 0, prior: 0 },
    { redemptionId: 1, amount: 1, prior: 0 }
  ]
}, 'equal Webster priorities use redemption ID as the stable tie-break, independent of input order')
const fullReturn = allocateCreditReturn({
  fundedPurchase: 7,
  fundedPreviouslyReturned: 0,
  fundedReturning: 7,
  redemptions: [{ id: 1, amount: 3 }, { id: 2, amount: 1 }]
})
assert.deepEqual(fullReturn.shares.map(({ amount }) => amount), [3, 1],
  "full return restores every redemption's exact original source amount")

const floor = (numerator, denominator) => Number(BigInt(numerator) / BigInt(denominator))
const naiveWebster = (redemptions, seats) => {
  const allocated = redemptions.map(() => 0)
  for (let seat = 0; seat < seats; seat++) {
    let best = -1
    for (let index = 0; index < redemptions.length; index++) {
      if (allocated[index] >= redemptions[index].amount) continue
      if (best < 0) { best = index; continue }
      const priorityNumerator = redemptions[index].amount * (2 * allocated[best] + 1)
      const bestNumerator = redemptions[best].amount * (2 * allocated[index] + 1)
      if (priorityNumerator > bestNumerator ||
          (priorityNumerator === bestNumerator && redemptions[index].id < redemptions[best].id))
        best = index
    }
    assert.notEqual(best, -1, 'oracle must have capacity for every Rial seat')
    allocated[best]++
  }
  return allocated
}
let cases = 0
for (let count = 1; count <= 3; count++) {
  const enumerate = (weights) => {
    if (weights.length === count) {
      const sourceTotal = weights.reduce((sum, value) => sum + value, 0)
      if (sourceTotal === 0) return
      const redemptions = weights.map((amount, index) => ({ id: index + 1, amount }))
      for (let seats = 0; seats <= sourceTotal; seats++) {
        const result = allocateCreditReturn({
          fundedPurchase: sourceTotal, fundedPreviouslyReturned: 0,
          fundedReturning: seats, redemptions,
          priorShares: redemptions.map((redemption) => ({ redemptionId: redemption.id, amount: 0 }))
        })
        assert.deepEqual(result.shares.map((share) => share.amount), naiveWebster(redemptions, seats),
          `binary Webster threshold must match the exact highest-average oracle: ${JSON.stringify({ weights, seats })}`)
      }
      for (let fundedPurchase = sourceTotal; fundedPurchase <= sourceTotal + 2; fundedPurchase++) {
        let priorSourceShares = weights.map(() => 0)
        const oneRialHistory = [priorSourceShares.slice()]
        for (let prior = 0; prior < fundedPurchase; prior++) {
          const result = allocateCreditReturn({
            fundedPurchase,
            fundedPreviouslyReturned: prior,
            fundedReturning: 1,
            redemptions,
            priorShares: redemptions.map((redemption, index) => ({
              redemptionId: redemption.id, amount: priorSourceShares[index]
            }))
          })
          const expectedPriorGift = floor(sourceTotal * prior, fundedPurchase)
          assert.equal(result.credit + result.cash, 1)
          assert.ok(result.credit >= 0 && result.cash >= 0)
          assert.equal(result.shares.reduce((sum, share) => sum + share.amount, 0), result.credit)
          assert.equal(result.shares.reduce((sum, share) => sum + share.prior, 0), expectedPriorGift)
          for (let index = 0; index < weights.length; index++) {
            const share = result.shares[index]
            assert.ok(share.amount >= 0, `negative source share in ${JSON.stringify({ weights, fundedPurchase, prior })}`)
            assert.equal(share.prior, priorSourceShares[index],
              `source allocation must be cumulative/monotone in ${JSON.stringify({ weights, fundedPurchase, prior })}`)
            assert.ok(share.prior + share.amount <= weights[index])
            priorSourceShares[index] += share.amount
          }
          oneRialHistory.push(priorSourceShares.slice())
          cases++
        }
        assert.deepEqual(priorSourceShares, weights,
          'a sequence of one-rial returns must eventually restore each redemption exactly')
        for (let start = 0; start < fundedPurchase; start++) {
          for (let end = start + 1; end <= fundedPurchase; end++) {
            const priorShares = redemptions.map((redemption, index) => ({
              redemptionId: redemption.id, amount: oneRialHistory[start][index]
            }))
            const result = allocateCreditReturn({
              fundedPurchase, fundedPreviouslyReturned: start,
              fundedReturning: end - start, redemptions, priorShares
            })
            const combined = oneRialHistory[start].map((amount, index) => amount + result.shares[index].amount)
            assert.deepEqual(combined, oneRialHistory[end],
              `return chunking must not change source lineage in ${JSON.stringify({ weights, fundedPurchase, start, end })}`)
            cases++
          }
        }
      }
      return
    }
    for (let amount = 0; amount <= 4; amount++) enumerate([...weights, amount])
  }
  enumerate([])
}

const large = allocateCreditReturn({
  fundedPurchase: 7_000_000,
  fundedPreviouslyReturned: 2_000_000,
  fundedReturning: 1_000_000,
  redemptions: [{ id: 1, amount: 3_000_000 }, { id: 2, amount: 1_000_000 }]
})
assert.equal(large.credit + large.cash, 1_000_000)
assert.ok(large.shares.every((share) => share.amount >= 0))
assert.equal(large.shares.reduce((sum, share) => sum + share.amount, 0), large.credit)
const maxSafe = Number.MAX_SAFE_INTEGER
const nearSafe = allocateCreditReturn({
  fundedPurchase: maxSafe,
  fundedPreviouslyReturned: 0,
  fundedReturning: Math.floor(maxSafe / 2),
  redemptions: [{ id: 1, amount: maxSafe - 1_000 }, { id: 2, amount: 1_000 }]
})
assert.equal(nearSafe.credit + nearSafe.cash, Math.floor(maxSafe / 2))
assert.equal(nearSafe.shares.reduce((sum, share) => sum + share.amount, 0), nearSafe.credit)
assert.ok(nearSafe.shares.every((share) => share.amount >= 0))

const paymentRows = [
  { id: 31, storeCreditId: 41, amount: 3, method: { kind: 'CASH' } },
  { id: 32, storeCreditId: 42, amount: 1, method: { kind: 'CASH' } }
]
const redemptionRows = [
  { id: 51, creditId: 41, amount: 3, paymentId: 31, compensatedAt: null },
  { id: 52, creditId: 42, amount: 1, paymentId: 32, compensatedAt: null }
]
const planForPrior = (persistedPrior) => planCreditReturn({
  saleInvoice: { findUnique: async () => ({ id: 77, orderType: 'INTERNAL', sourceInvoiceId: null, exchangeReturnId: null }) },
  saleReturn: { findFirst: async () => null },
  payment: { findMany: async () => paymentRows },
  storeCredit: { findMany: async () => [] },
  storeCreditRedemption: { findMany: async () => redemptionRows },
  creditReturnAllocation: { aggregate: async ({ where }) => ({
    _sum: { amount: persistedPrior.get(where.redemptionId) ?? 0 }
  }) }
}, {
  invoiceId: 77, grandTotal: 7, paidTotal: 7, returnedValue: 1,
  debtBefore: { remaining: 0, refundFromReceived: 2 }, activeReturns: []
})
const plan = await planForPrior(new Map([[51, 1], [52, 0]]))
assert.deepEqual(plan, {
  credit: 0,
  cash: 1,
  fundedReturning: 1,
  shares: [
    { redemptionId: 51, parentCreditId: 41, amount: 0, prior: 1 },
    { redemptionId: 52, parentCreditId: 42, amount: 0, prior: 0 }
  ]
}, 'the real return planner carries the matching persisted source baseline forward')
await assert.rejects(() => planForPrior(new Map([[51, 0], [52, 1]])), /منشأ اعتبار/,
  'legacy source attribution that conflicts with the new deterministic schedule fails closed')

assert.throws(() => allocateCreditReturn({
  fundedPurchase: 7,
  fundedPreviouslyReturned: 2,
  fundedReturning: 1,
  redemptions: [{ id: 1, amount: 3 }, { id: 2, amount: 1 }],
  priorShares: [{ redemptionId: 1, amount: 1 }, { redemptionId: 2, amount: 1 }]
}), /INVALID_CREDIT_RETURN_BASIS/)

console.log(`✓ cumulative credit-return rounding: no negative/declining/chunk-dependent source shares, legacy mismatches fail closed, ${cases} exhaustive small cases`)
