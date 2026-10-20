export interface ReturnRequestIdentity {
  fingerprint: string
  key: string
}

const STORAGE_KEY = 'mahak.sales-return.idempotency.v1'
const KEY_PATTERN = /^return-request:[A-Za-z0-9-]{36}$/
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

type IdentityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): IdentityStorage | null {
  try { return globalThis.sessionStorage ?? null } catch { return null }
}

function readStored(storage: IdentityStorage | null): ReturnRequestIdentity | null {
  if (!storage) return null
  try {
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    return stored && typeof stored.fingerprint === 'string' && FINGERPRINT_PATTERN.test(stored.fingerprint) &&
      typeof stored.key === 'string' && KEY_PATTERN.test(stored.key)
      ? stored : null
  } catch { return null }
}

function store(identity: ReturnRequestIdentity, storage: IdentityStorage | null): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(identity)) } catch { /* browser storage is optional */ }
}

function newKey(cryptoApi: Crypto): string {
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const raw = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
  return `return-request:${uuid}`
}

/**
 * Reuse one caller-held key for exact payload retries, including after a page
 * reload in the same tab. Only a SHA-256 fingerprint and the opaque key are
 * stored; changing any intent field rotates the key before invoking IPC.
 */
export async function resolveReturnRequestIdentity(
  intentPayload: string,
  current: ReturnRequestIdentity | null,
  storage: IdentityStorage | null = browserStorage(),
  cryptoApi: Crypto = globalThis.crypto
): Promise<ReturnRequestIdentity> {
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(intentPayload))
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (current?.fingerprint === fingerprint && KEY_PATTERN.test(current.key)) return current

  const retained = readStored(storage)
  const identity = {
    fingerprint,
    key: retained?.fingerprint === fingerprint ? retained.key : newKey(cryptoApi)
  }
  store(identity, storage)
  return identity
}

/** Clear only the exact completed request; never erase a newer pending intent. */
export function clearStoredReturnRequestIdentity(key: string, storage: IdentityStorage | null = browserStorage()): void {
  if (!storage) return
  try {
    if (readStored(storage)?.key === key) storage.removeItem(STORAGE_KEY)
  } catch { /* browser storage is optional */ }
}
