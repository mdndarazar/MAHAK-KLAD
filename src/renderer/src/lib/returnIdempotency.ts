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
  if (!storage)
    throw new Error('ذخیرهٔ امن کلید برگشت در همین تب در دسترس نیست؛ برای جلوگیری از ثبت تکراری، درخواست ارسال نشد.')
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(identity))
    const persisted = readStored(storage)
    if (persisted?.key !== identity.key || persisted.fingerprint !== identity.fingerprint)
      throw new Error('persisted return identity did not match')
  } catch {
    throw new Error('ذخیرهٔ امن کلید برگشت در همین تب ممکن نشد؛ برای جلوگیری از ثبت تکراری، درخواست ارسال نشد.')
  }
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
 * Persistence is mandatory: if session storage cannot be verified, reject
 * before IPC instead of silently losing the reload-retry guarantee.
 */
export async function resolveReturnRequestIdentity(
  intentPayload: string,
  current: ReturnRequestIdentity | null,
  storage: IdentityStorage | null = browserStorage(),
  cryptoApi: Crypto = globalThis.crypto
): Promise<ReturnRequestIdentity> {
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(intentPayload))
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const retained = readStored(storage)
  const identity = current?.fingerprint === fingerprint && KEY_PATTERN.test(current.key)
    ? current
    : {
        fingerprint,
        key: retained?.fingerprint === fingerprint ? retained.key : newKey(cryptoApi)
      }
  // Persist and read back even on the in-memory fast path. If same-tab storage
  // disappeared since the previous attempt, fail before IPC rather than
  // silently weakening reload retry safety.
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
