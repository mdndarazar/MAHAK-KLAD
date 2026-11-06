import assert from 'node:assert/strict'

const { posMultiCreditPlan } = await import('../../src/shared/posMultiCreditPlan.ts')
const {
  normalizeSaleCreditTenders,
  saleRequestFingerprint,
  creditTenderIdempotencyKey
} = await import('../../src/main/services/saleIdempotency.ts')

const preview = (applied, eligibleVariantIds = []) => ({
  ok: true, applied, error: null, notes: [], eligibleVariantIds, excludedVariantIds: []
})

const planned = posMultiCreditPlan({
  payable: 100,
  requestedInput: null,
  lines: [
    { variantId: 1, lineTotal: 30 },
    { variantId: 2, lineTotal: 70 }
  ],
  rows: [
    { id: 'later-restricted', code: 'C-LATE', expiresAt: '1405/03/01', restrictScope: 'VARIANTS', preview: preview(80, [1]) },
    { id: 'pool', code: 'C-POOL', expiresAt: null, restrictScope: 'ALL', preview: preview(100) },
    { id: 'first-restricted', code: 'C-EARLY', expiresAt: '1405/01/01', restrictScope: 'VARIANTS', preview: preview(80, [1]) }
  ]
})
assert.equal(planned.appliedById['first-restricted'], 30, 'restricted credit uses only matching line capacity')
assert.equal(planned.appliedById['later-restricted'], 0, 'restricted capacity is cumulative across barcodes')
assert.equal(planned.appliedById.pool, 70, 'ordinary credit pools at invoice level after FEFO restricted credit')
assert.equal(planned.applied, 100)
assert.deepEqual(planned.excludedVariantIds, [], 'ordinary invoice pool covers the invoice without item allocation')

const capped = posMultiCreditPlan({
  payable: 100,
  requestedInput: 45,
  lines: [{ variantId: 1, lineTotal: 100 }],
  rows: [
    { id: 'expiry-later', code: 'Z', expiresAt: '1405/02/01', restrictScope: 'ALL', preview: preview(100) },
    { id: 'expiry-first', code: 'A', expiresAt: '1405/01/01', restrictScope: 'ALL', preview: preview(100) }
  ]
})
assert.equal(capped.applied, 45)
assert.equal(capped.appliedById['expiry-first'], 45, 'FEFO orders Jalali expiry dates, independent of input order')
assert.equal(capped.appliedById['expiry-later'], 0)

// E100-021: two expiring 25k successors are consumed before a 150k money-backed code.
// On an 180k POS basket the final code must be planned for 130k, not rejected as a 150k request.
const e100021 = posMultiCreditPlan({
  payable: 180_000,
  requestedInput: null,
  lines: [{ variantId: 1, lineTotal: 180_000 }],
  rows: [
    { id: 'money-150', code: 'MONEY150', expiresAt: null, restrictScope: 'ALL', preview: preview(150_000) },
    { id: 'source-25-b', code: 'SOURCE25B', expiresAt: '1405/09/05', restrictScope: 'VARIANTS', preview: preview(25_000, [1]) },
    { id: 'source-25-a', code: 'SOURCE25A', expiresAt: '1405/09/05', restrictScope: 'VARIANTS', preview: preview(25_000, [1]) }
  ]
})
assert.equal(e100021.appliedById['source-25-a'] + e100021.appliedById['source-25-b'], 50_000)
assert.equal(e100021.appliedById['money-150'], 130_000, 'planner must cap the last barcode at remaining invoice value')
assert.equal(e100021.applied, 180_000)
assert.equal(e100021.requestedById['money-150'], null, 'automatic POS mode lets the server consume only the remaining 130k')
const e100021Explicit = posMultiCreditPlan({
  payable: 180_000,
  requestedInput: 180_000,
  lines: [{ variantId: 1, lineTotal: 180_000 }],
  rows: [
    { id: 'money-150', code: 'MONEY150', expiresAt: null, restrictScope: 'ALL', preview: preview(150_000) },
    { id: 'source-25-b', code: 'SOURCE25B', expiresAt: '1405/09/05', restrictScope: 'VARIANTS', preview: preview(25_000, [1]) },
    { id: 'source-25-a', code: 'SOURCE25A', expiresAt: '1405/09/05', restrictScope: 'VARIANTS', preview: preview(25_000, [1]) }
  ]
})
assert.equal(e100021Explicit.appliedById['money-150'], 130_000)
assert.equal(e100021Explicit.requestedById['money-150'], 130_000, 'explicit combined POS request is split to the remaining amount per barcode')
assert.equal(e100021Explicit.applied, 180_000)

const duplicate = posMultiCreditPlan({
  payable: 100,
  requestedInput: null,
  lines: [{ variantId: 1, lineTotal: 100 }],
  rows: [
    { id: 'dup-a', code: 'SAME', restrictScope: 'ALL', preview: preview(100) },
    { id: 'dup-b', code: 'same', restrictScope: 'ALL', preview: preview(100) }
  ]
})
assert.equal(duplicate.applied, 0, 'duplicate barcode is rejected as a group')
assert.ok(duplicate.notes.some((note) => note.includes('تکراری')))

const internalEight = normalizeSaleCreditTenders({
  storeCredits: Array.from({ length: 8 }, (_, index) => ({ code: `C${index + 1}` }))
}, 'INTERNAL')
assert.equal(internalEight.length, 8, 'daily POS accepts up to eight distinct barcode rows')
assert.throws(() => normalizeSaleCreditTenders({
  storeCredits: [{ code: 'A' }, { code: 'B' }]
}, 'WHOLESALE'), /فقط یک بارکد/)
assert.throws(() => normalizeSaleCreditTenders({
  storeCredits: Array.from({ length: 9 }, (_, index) => ({ code: `C${index + 1}` }))
}, 'INTERNAL'), /حداکثر 8/)

const request = { lines: [{ variantId: 9, qty: 1 }], payments: [{ methodId: 1, amount: 500 }] }
const first = normalizeSaleCreditTenders({ ...request, storeCredits: [{ code: 'AB-123' }, { code: 'CD-456' }] }, 'INTERNAL')
const reordered = normalizeSaleCreditTenders({ ...request, storeCredits: [{ code: 'CD-456' }, { code: 'AB-123' }] }, 'INTERNAL')
assert.equal(saleRequestFingerprint(request, first), saleRequestFingerprint(request, reordered),
  'reordering barcodes cannot change the invoice-level idempotency fingerprint')
assert.notEqual(
  creditTenderIdempotencyKey('retry-key-123', 25, 'AB-123'),
  creditTenderIdempotencyKey('retry-key-123', 25, 'CD-456'),
  'barcode order does not attach one tender idempotency key to a different code'
)
console.log('✓ POS multi-credit: FEFO, invoice pooling, cumulative restricted capacity, duplicates, wholesale cap, and idempotency')
