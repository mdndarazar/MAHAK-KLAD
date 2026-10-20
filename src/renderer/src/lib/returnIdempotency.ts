export interface ReturnRequestIdentity {
  fingerprint: string
  key: string
}

export type ExchangeRequestIdentity = ReturnRequestIdentity

const RETURN_CONFIG = {
  storageKey: 'mahak.sales-return.idempotency.v1',
  keyPrefix: 'return-request:',
  keyPattern: /^return-request:[A-Za-z0-9-]{36}$/,
  label: 'برگشت'
}
const EXCHANGE_CONFIG = {
  storageKey: 'mahak.sales-exchange.idempotency.v1',
  keyPrefix: 'exchange-request:',
  keyPattern: /^exchange-request:[A-Za-z0-9-]{36}$/,
  label: 'تعویض'
}
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
type IdentityConfig = typeof RETURN_CONFIG | typeof EXCHANGE_CONFIG
type IdentityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): IdentityStorage | null {
  try { return globalThis.sessionStorage ?? null } catch { return null }
}

function readStored(storage: IdentityStorage | null, config: IdentityConfig): ReturnRequestIdentity | null {
  if (!storage) return null
  try {
    const stored = JSON.parse(storage.getItem(config.storageKey) ?? 'null')
    return stored && typeof stored.fingerprint === 'string' && FINGERPRINT_PATTERN.test(stored.fingerprint) &&
      typeof stored.key === 'string' && config.keyPattern.test(stored.key)
      ? stored : null
  } catch { return null }
}

function store(identity: ReturnRequestIdentity, storage: IdentityStorage | null, config: IdentityConfig): void {
  if (!storage)
    throw new Error(`ذخیرهٔ امن کلید ${config.label} در همین تب در دسترس نیست؛ برای جلوگیری از ثبت تکراری، درخواست ارسال نشد.`)
  try {
    storage.setItem(config.storageKey, JSON.stringify(identity))
    const persisted = readStored(storage, config)
    if (persisted?.key !== identity.key || persisted.fingerprint !== identity.fingerprint)
      throw new Error('persisted request identity did not match')
  } catch {
    throw new Error(`ذخیرهٔ امن کلید ${config.label} در همین تب ممکن نشد؛ برای جلوگیری از ثبت تکراری، درخواست ارسال نشد.`)
  }
}

function newKey(cryptoApi: Crypto, config: IdentityConfig): string {
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const raw = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
  return `${config.keyPrefix}${uuid}`
}

async function resolveRequestIdentity(
  intentPayload: string,
  current: ReturnRequestIdentity | null,
  storage: IdentityStorage | null,
  cryptoApi: Crypto,
  config: IdentityConfig
): Promise<ReturnRequestIdentity> {
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(intentPayload))
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const retained = readStored(storage, config)
  const identity = current?.fingerprint === fingerprint && config.keyPattern.test(current.key)
    ? current
    : {
        fingerprint,
        key: retained?.fingerprint === fingerprint ? retained.key : newKey(cryptoApi, config)
      }
  // Persist and read back even on the in-memory fast path. If same-tab storage
  // disappeared since the previous attempt, fail before IPC rather than
  // silently weakening reload retry safety.
  store(identity, storage, config)
  return identity
}

/**
 * Reuse one caller-held key for exact payload retries, including after a page
 * reload in the same tab. Only a SHA-256 fingerprint and the opaque key are
 * stored; changing any intent field rotates the key before invoking IPC.
 * Persistence is mandatory: if session storage cannot be verified, reject
 * before IPC instead of silently losing reload-retry safety.
 */
export function resolveReturnRequestIdentity(
  intentPayload: string,
  current: ReturnRequestIdentity | null,
  storage: IdentityStorage | null = browserStorage(),
  cryptoApi: Crypto = globalThis.crypto
): Promise<ReturnRequestIdentity> {
  return resolveRequestIdentity(intentPayload, current, storage, cryptoApi, RETURN_CONFIG)
}

export function resolveExchangeRequestIdentity(
  intentPayload: string,
  current: ExchangeRequestIdentity | null,
  storage: IdentityStorage | null = browserStorage(),
  cryptoApi: Crypto = globalThis.crypto
): Promise<ExchangeRequestIdentity> {
  return resolveRequestIdentity(intentPayload, current, storage, cryptoApi, EXCHANGE_CONFIG)
}

function clearRequestIdentity(key: string, storage: IdentityStorage | null, config: IdentityConfig): void {
  if (!storage) return
  try {
    if (readStored(storage, config)?.key === key) storage.removeItem(config.storageKey)
  } catch { /* browser storage is optional */ }
}

/** Clear only the exact completed request; never erase a newer pending intent. */
export function clearStoredReturnRequestIdentity(key: string, storage: IdentityStorage | null = browserStorage()): void {
  clearRequestIdentity(key, storage, RETURN_CONFIG)
}

export function clearStoredExchangeRequestIdentity(key: string, storage: IdentityStorage | null = browserStorage()): void {
  clearRequestIdentity(key, storage, EXCHANGE_CONFIG)
}
