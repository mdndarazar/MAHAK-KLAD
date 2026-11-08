import assert from 'node:assert/strict'

const { planReturnCreditSources, RETURN_CREDIT_POLICY_KEY } = await import('../../src/shared/returnCreditPolicy.ts')

assert.equal(RETURN_CREDIT_POLICY_KEY, 'POOLED_ALL_CREDIT_RESTRICTED_MANAGER_ONLY')
const ordinary = planReturnCreditSources({
  lines: [{ saleItemId: 10, variantId: 100, value: 20, categoryPath: [7] }],
  sources: [{ redemptionId: 1, creditId: 91, amount: 5, restrictScope: 'ALL' }]
})
assert.deepEqual(ordinary, {
  policyVersion: 1,
  fundedReturning: 20,
  credit: 5,
  realMoneyRight: 15,
  shares: [{ redemptionId: 1, creditId: 91, amount: 5, saleItemId: null }]
}, 'ALL credit is an invoice pool and has no item association; remainder is the actual-money right')

const managerCredit = { redemptionId: 2, creditId: 92, amount: 2, restrictScope: 'VARIANTS', restrictVariantIdsJson: '[100]' }
const returnedB = planReturnCreditSources({
  lines: [{ saleItemId: 11, variantId: 200, value: 20, categoryPath: [8] }],
  sources: [managerCredit]
})
assert.deepEqual([returnedB.credit, returnedB.realMoneyRight, returnedB.shares], [0, 20, []],
  'a manager credit restricted to A does not reduce the full money right when B is returned')

const returnedA = planReturnCreditSources({
  lines: [{ saleItemId: 10, variantId: 100, value: 20, categoryPath: [7] }],
  sources: [managerCredit]
})
assert.deepEqual([returnedA.credit, returnedA.realMoneyRight, returnedA.shares], [2, 18, [
  { redemptionId: 2, creditId: 92, amount: 2, saleItemId: 10 }
]], 'restricted manager credit returns only against a matching returned item')

const managerCategory = planReturnCreditSources({
  lines: [{ saleItemId: 12, variantId: 300, value: 30, categoryPath: [30, 7, 1] }],
  sources: [{ redemptionId: 3, creditId: 93, amount: 4, restrictScope: 'CATEGORY', restrictCategoryIdsJson: '[7]' }]
})
assert.equal(managerCategory.credit, 4, 'category-scoped credit matches the returned item category ancestry')
assert.equal(managerCategory.shares[0].saleItemId, 12)

const mixedLines = planReturnCreditSources({
  lines: [
    { saleItemId: 20, variantId: 200, value: 20, categoryPath: [8] },
    { saleItemId: 10, variantId: 100, value: 20, categoryPath: [7] }
  ],
  sources: [
    managerCredit,
    { redemptionId: 1, creditId: 91, amount: 5, restrictScope: 'ALL' }
  ]
})
assert.deepEqual(mixedLines.shares, [
  { redemptionId: 2, creditId: 92, amount: 2, saleItemId: 10 },
  { redemptionId: 1, creditId: 91, amount: 5, saleItemId: null }
], 'restricted value remains bound to A while ALL value is pooled across returned lines')
assert.equal(mixedLines.realMoneyRight, 33)

const chunk1 = planReturnCreditSources({
  lines: [{ saleItemId: 10, variantId: 100, value: 20, categoryPath: [7] }],
  sources: [{ redemptionId: 1, creditId: 91, amount: 5, restrictScope: 'ALL' }]
})
const chunk2 = planReturnCreditSources({
  lines: [{ saleItemId: 20, variantId: 200, value: 20, categoryPath: [8] }],
  sources: [{ redemptionId: 1, creditId: 91, amount: 5, priorAmount: chunk1.credit, restrictScope: 'ALL' }]
})
assert.deepEqual([chunk1.credit, chunk1.realMoneyRight, chunk2.credit, chunk2.realMoneyRight], [5, 15, 0, 20],
  'separate returns restore a pooled source once, then return only actual money')

const debt = planReturnCreditSources({
  lines: [
    { saleItemId: 10, variantId: 100, value: 10, categoryPath: [7] },
    { saleItemId: 20, variantId: 200, value: 10, categoryPath: [8] }
  ],
  sources: [managerCredit],
  debtReduction: 10
})
assert.deepEqual([debt.fundedReturning, debt.credit, debt.realMoneyRight], [10, 2, 8],
  'invoice debt is removed before entitlements while the restricted credit remains with matching A')

assert.throws(() => planReturnCreditSources({
  lines: [{ saleItemId: 10, variantId: 100, value: 1, categoryPath: [] }],
  sources: [{ redemptionId: 2, creditId: 92, amount: 2, restrictScope: 'VARIANTS', restrictVariantIdsJson: '[]' }]
}), /Restricted variant credit has no scope/)

console.log('✓ global credit-return policy: pooled ALL, restricted manager scope, category ancestry, debt-first and chunked returns')
