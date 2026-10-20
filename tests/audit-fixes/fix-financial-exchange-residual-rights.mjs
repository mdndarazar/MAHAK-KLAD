import assert from 'node:assert/strict'
import { planS1ExchangeResidualTender } from '../../src/shared/exchangeResidualRights.ts'

const at = new Date('2026-10-21T12:00:00.000Z')
const rootExpiry = new Date('2026-11-20T00:00:00.000Z')

// FINAL-DESIGN S1: residual rights are not a new payment or cash movement.
const firstSale = planS1ExchangeResidualTender({
  amount: 400_000, nAvailable: 857_346, bAvailable: 122_654,
  bExpiresAt: rootExpiry, at
})
assert.deepEqual(firstSale, {
  nAmount: 400_000, bAmount: 0,
  nAvailableAfter: 457_346, bSpendableAfter: 122_654, bExpired: false
})
const secondSale = planS1ExchangeResidualTender({
  amount: 580_000, nAvailable: firstSale.nAvailableAfter, bAvailable: firstSale.bSpendableAfter,
  bExpiresAt: rootExpiry, at
})
assert.deepEqual(secondSale, {
  nAmount: 457_346, bAmount: 122_654,
  nAvailableAfter: 0, bSpendableAfter: 0, bExpired: false
}, 'S1 second sale consumes the remaining N and B exactly')
assert.throws(() => planS1ExchangeResidualTender({
  amount: 1, nAvailable: secondSale.nAvailableAfter, bAvailable: secondSale.bSpendableAfter,
  bExpiresAt: rootExpiry, at
}), /INSUFFICIENT_EXCHANGE_RESIDUAL_RIGHTS/,
'one Rial after both rights are depleted rejects before any balance is changed')

// B expires at the root's exact timestamp, while N remains spendable.
const atExpiry = new Date(rootExpiry)
assert.deepEqual(planS1ExchangeResidualTender({
  amount: 1, nAvailable: 1, bAvailable: 122_654, bExpiresAt: rootExpiry, at: atExpiry
}), {
  nAmount: 1, bAmount: 0, nAvailableAfter: 0, bSpendableAfter: 0, bExpired: true
})
assert.throws(() => planS1ExchangeResidualTender({
  amount: 2, nAvailable: 1, bAvailable: 122_654, bExpiresAt: rootExpiry, at: atExpiry
}), /INSUFFICIENT_EXCHANGE_RESIDUAL_RIGHTS/,
'expired B cannot be converted into N or silently consumed')
assert.deepEqual(planS1ExchangeResidualTender({
  amount: 1, nAvailable: 2, bAvailable: 122_654, bExpiresAt: rootExpiry, at: atExpiry
}), {
  nAmount: 1, bAmount: 0, nAvailableAfter: 1, bSpendableAfter: 0, bExpired: true
}, 'N remains available after B expiry')

let cases = 0
for (let nAvailable = 0; nAvailable <= 5; nAvailable++) {
  for (let bAvailable = 0; bAvailable <= 5; bAvailable++) {
    for (const expired of [false, true]) {
      const expiry = expired ? at : rootExpiry
      const usable = nAvailable + (expired ? 0 : bAvailable)
      for (let amount = 1; amount <= usable + 1; amount++) {
        if (amount > usable) {
          assert.throws(() => planS1ExchangeResidualTender({
            amount, nAvailable, bAvailable, bExpiresAt: expiry, at
          }), /INSUFFICIENT_EXCHANGE_RESIDUAL_RIGHTS/)
        } else {
          const plan = planS1ExchangeResidualTender({ amount, nAvailable, bAvailable, bExpiresAt: expiry, at })
          assert.equal(plan.nAmount + plan.bAmount, amount)
          assert.equal(plan.nAvailableAfter + plan.nAmount, nAvailable)
          if (expired) assert.equal(plan.bSpendableAfter, 0)
          else assert.equal(plan.bSpendableAfter + plan.bAmount, bAvailable)
          assert.ok(plan.nAmount <= nAvailable)
          assert.ok(plan.bAmount <= (expired ? 0 : bAvailable))
          assert.equal(plan.bExpired, expired)
        }
        cases++
      }
    }
  }
}
assert.equal(cases, 342, 'all bounded balances, requests, and expiry states are checked')

for (const invalid of [
  { amount: 0, nAvailable: 1, bAvailable: 1, bExpiresAt: rootExpiry, at },
  { amount: 1.5, nAvailable: 1, bAvailable: 1, bExpiresAt: rootExpiry, at },
  { amount: 1, nAvailable: -1, bAvailable: 1, bExpiresAt: rootExpiry, at },
  { amount: 1, nAvailable: 1, bAvailable: 1, bExpiresAt: new Date(Number.NaN), at },
  { amount: 1, nAvailable: 1, bAvailable: 1, bExpiresAt: rootExpiry, at: new Date(Number.NaN) }
]) assert.throws(() => planS1ExchangeResidualTender(invalid), RangeError)

console.log(`✓ exchange residual tender planner: S1 N/B sales, exact depletion, expired-B hold, and ${cases} bounded cases`)
