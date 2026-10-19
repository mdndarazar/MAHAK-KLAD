import assert from 'node:assert/strict'
import {
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

console.log('✓ exchange funding allocation: gift-first source separation, exact pro-rata rial reconciliation, deterministic rounding, shortfall quarantine, invalid rial rejection')
