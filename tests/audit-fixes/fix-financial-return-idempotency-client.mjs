/** Browser-side return idempotency identity: same-intent retry/reload keeps
 * its opaque key, changed payload rotates it, and completion only clears itself.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-return-idempotency-client.mjs
 */
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { resolveReturnRequestIdentity, clearStoredReturnRequestIdentity } from '../../src/renderer/src/lib/returnIdempotency.ts'

const values = new Map()
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key)
}
const intent = JSON.stringify({ invoiceId: 42, lines: [{ saleItemId: 7, qty: 1 }], note: 'same intent' })
const first = await resolveReturnRequestIdentity(intent, null, storage, webcrypto)
assert.match(first.key, /^return-request:[A-Za-z0-9-]{36}$/)
assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
assert.equal(values.size, 1)
assert.equal(values.values().next().value.includes('same intent'), false,
  'session storage contains only an opaque key and SHA-256 digest, not the return payload')
await assert.rejects(() => resolveReturnRequestIdentity(intent, null, null, webcrypto),
  /ذخیره|storage|persist/i,
  'a request must not be submitted with an identity that cannot survive a same-tab reload')
const failingStorage = {
  getItem: () => null,
  setItem: () => { throw new Error('storage quota unavailable') },
  removeItem: () => {}
}
await assert.rejects(() => resolveReturnRequestIdentity(intent, null, failingStorage, webcrypto),
  /ذخیره|storage|persist/i,
  'a failed session persistence must be detected before IPC')

const concurrentValues = new Map()
const concurrentStorage = {
  getItem: (key) => concurrentValues.get(key) ?? null,
  setItem: (key, value) => concurrentValues.set(key, String(value)),
  removeItem: (key) => concurrentValues.delete(key)
}
const [simultaneousA, simultaneousB] = await Promise.all([
  resolveReturnRequestIdentity(intent, null, concurrentStorage, webcrypto),
  resolveReturnRequestIdentity(intent, null, concurrentStorage, webcrypto)
])
assert.equal(simultaneousA.key, simultaneousB.key,
  'overlapping same-intent submit handlers converge on one persisted key before IPC')

const sameInMemory = await resolveReturnRequestIdentity(intent, first, storage, webcrypto)
assert.equal(sameInMemory.key, first.key)
values.clear()
const restoredFromMemory = await resolveReturnRequestIdentity(intent, sameInMemory, storage, webcrypto)
assert.equal(restoredFromMemory.key, first.key)
assert.equal(values.size, 1, 'a retry re-persists the matching key before submitting')
const sameAfterReload = await resolveReturnRequestIdentity(intent, null, storage, webcrypto)
assert.equal(sameAfterReload.key, first.key, 'same intent recovers the key after a renderer reload')

const changedIntent = JSON.stringify({ invoiceId: 42, lines: [{ saleItemId: 7, qty: 2 }], note: 'same intent' })
const changed = await resolveReturnRequestIdentity(changedIntent, first, storage, webcrypto)
assert.notEqual(changed.key, first.key, 'a changed quantity gets a fresh idempotency key')
const changedAfterReload = await resolveReturnRequestIdentity(changedIntent, null, storage, webcrypto)
assert.equal(changedAfterReload.key, changed.key)

clearStoredReturnRequestIdentity(first.key, storage)
assert.equal(values.size, 1, 'completion of an older request cannot clear a newer pending key')
clearStoredReturnRequestIdentity(changed.key, storage)
assert.equal(values.size, 0, 'completion clears only the matching pending intent')

console.log('✓ renderer return identity: same-intent retry survives reload, payload changes rotate key, completion clears exact key')
