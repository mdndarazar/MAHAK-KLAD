/** Browser-side return idempotency identity: same-intent retry/reload keeps
 * its opaque key, changed payload rotates it, and completion only clears itself.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-return-idempotency-client.mjs
 */
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  resolveReturnRequestIdentity, clearStoredReturnRequestIdentity,
  resolveExchangeRequestIdentity, clearStoredExchangeRequestIdentity
} from '../../src/renderer/src/lib/returnIdempotency.ts'

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

const exchangeValues = new Map()
const exchangeStorage = {
  getItem: (key) => exchangeValues.get(key) ?? null,
  setItem: (key, value) => exchangeValues.set(key, String(value)),
  removeItem: (key) => exchangeValues.delete(key)
}
const exchangeIntent = JSON.stringify({ invoiceId: 84, lines: [{ saleItemId: 12, qty: 1 }], replacements: [{ variantId: 31 }] })
const firstExchange = await resolveExchangeRequestIdentity(exchangeIntent, null, exchangeStorage, webcrypto)
assert.match(firstExchange.key, /^exchange-request:[A-Za-z0-9-]{36}$/)
assert.match(firstExchange.fingerprint, /^[a-f0-9]{64}$/)
assert.equal(exchangeValues.has('mahak.sales-exchange.idempotency.v1'), true)
assert.equal(exchangeValues.has('mahak.sales-return.idempotency.v1'), false,
  'exchange retries use a separate session identity namespace from ordinary returns')
assert.equal(exchangeValues.values().next().value.includes('replacements'), false,
  'exchange session storage keeps only the opaque key and digest, never the business payload')
await assert.rejects(() => resolveExchangeRequestIdentity(exchangeIntent, null, null, webcrypto),
  /ذخیره|storage|persist/i, 'exchange IPC must not run if same-tab retry persistence cannot be verified')
const sameExchangeAfterReload = await resolveExchangeRequestIdentity(exchangeIntent, null, exchangeStorage, webcrypto)
assert.equal(sameExchangeAfterReload.key, firstExchange.key)
const changedExchange = await resolveExchangeRequestIdentity(`${exchangeIntent} `, firstExchange, exchangeStorage, webcrypto)
assert.notEqual(changedExchange.key, firstExchange.key, 'changed exchange intent rotates the key')
clearStoredExchangeRequestIdentity(firstExchange.key, exchangeStorage)
assert.equal(exchangeValues.size, 1, 'completion of an old exchange cannot clear the newer pending identity')
clearStoredExchangeRequestIdentity(changedExchange.key, exchangeStorage)
assert.equal(exchangeValues.size, 0)

const salesReturnPage = readFileSync(new URL('../../src/renderer/src/pages/SalesReturn.tsx', import.meta.url), 'utf8')
const submitStart = salesReturnPage.indexOf('const doSubmit = useCallback(')
const exchangeStart = salesReturnPage.indexOf('const doExchange = useCallback(', submitStart)
assert.ok(submitStart >= 0 && exchangeStart > submitStart, 'find the return submit handler')
const submitHandler = salesReturnPage.slice(submitStart, exchangeStart)
const persistenceIndex = submitHandler.indexOf('await resolveReturnRequestIdentity(')
const ipcIndex = submitHandler.indexOf('call<any>(CH.saleReturn,')
assert.ok(persistenceIndex >= 0 && ipcIndex > persistenceIndex,
  'verified session persistence and key resolution must happen before the return IPC')
assert.ok(submitHandler.indexOf('returnIdempotencyRef.current = requestIdentity') > persistenceIndex &&
  submitHandler.indexOf('returnIdempotencyRef.current = requestIdentity') < ipcIndex,
'a retry key is retained in memory before IPC starts')
assert.ok(submitHandler.indexOf('clearStoredReturnRequestIdentity(idempotencyKey)') > ipcIndex,
'only a completed return request clears its persisted identity')

const exchangeHandlerEnd = salesReturnPage.indexOf('/**\n   * ---------------------- بند ۱۳', exchangeStart)
assert.ok(exchangeHandlerEnd > exchangeStart, 'find the end of the exchange submit handler')
const exchangeHandler = salesReturnPage.slice(exchangeStart, exchangeHandlerEnd)
const exchangePersistenceIndex = exchangeHandler.indexOf('await resolveExchangeRequestIdentity(')
const exchangeIpcIndex = exchangeHandler.indexOf('CH.saleExchangeCreate')
assert.ok(exchangePersistenceIndex >= 0 && exchangeIpcIndex > exchangePersistenceIndex,
  'verified exchange identity persistence must happen before the exchange IPC')
assert.ok(exchangeHandler.includes('idempotencyKey: requestIdentity.key'),
  'the caller-held exchange key is sent to the service')
assert.ok(exchangeHandler.indexOf('clearStoredExchangeRequestIdentity(requestIdentity.key)') > exchangeIpcIndex,
  'only a completed exchange clears its persisted identity')
const ipcSource = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
const exchangeIpc = ipcSource.slice(ipcSource.indexOf('handle(IPC.saleExchangeCreate'), ipcSource.indexOf('handle(IPC.saleExchangeList'))
assert.match(exchangeIpc, /requireIdempotencyKey:\s*true/)
assert.match(exchangeIpc, /result\.replayed\s*!==\s*true/,
  'replay cannot mint another first-print grant')

console.log('✓ renderer return/exchange identity: storage is verified before IPC; same-intent retry survives reload, payload changes rotate key, completion clears exact key')
