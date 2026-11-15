/**
 * Verification primitive for a future remote-approval transport.
 *
 * This module does not issue grants, open panels, start a server, or enable
 * remote access. The caller must authenticate the member, check its ACL, and
 * bind the verified command to a live pending request before issuing a grant.
 * Replay state here is process-local; it is not a durable replay ledger.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type SignedGrantCommand = {
  version: 1
  storeId: string
  requestId: string
  nonce: string
  panel: string
  ownerWindowId: number
  memberId: string
  tier: 'NORMAL' | 'SENSITIVE_MONEY'
  issuedAt: number
  expiresAt: number
  signature: string
}

export type CommandVerification =
  | { ok: true; command: SignedGrantCommand }
  | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'REPLAY' | 'CAPACITY' }

type VerifierOptions = {
  key: Uint8Array
  storeId: string
  allowedPanels: Iterable<string>
  now?: () => number
  maxEntries?: number
}

const MAX_TTL_MS = 60_000
const MAX_FUTURE_SKEW_MS = 15_000
const COMMAND_KEYS = [
  'version', 'storeId', 'requestId', 'nonce', 'panel', 'ownerWindowId',
  'memberId', 'tier', 'issuedAt', 'expiresAt', 'signature'
] as const
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/
const PANEL_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/

/** Exactly these fields and this order must be signed by any future transport. */
function signedBytes(c: SignedGrantCommand): string {
  return JSON.stringify([
    c.version, c.storeId, c.requestId, c.nonce, c.panel, c.ownerWindowId,
    c.memberId, c.tier, c.issuedAt, c.expiresAt
  ])
}

function parseCommand(input: unknown): SignedGrantCommand | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const c = input as Record<string, unknown>
  const keys = Object.keys(c)
  if (keys.length !== COMMAND_KEYS.length || COMMAND_KEYS.some((key) => !Object.hasOwn(c, key))) return null
  if (c.version !== 1 || typeof c.storeId !== 'string' || !ID_PATTERN.test(c.storeId) ||
      typeof c.requestId !== 'string' || !ID_PATTERN.test(c.requestId) ||
      typeof c.nonce !== 'string' || !NONCE_PATTERN.test(c.nonce) ||
      typeof c.panel !== 'string' || !PANEL_PATTERN.test(c.panel) ||
      typeof c.memberId !== 'string' || !ID_PATTERN.test(c.memberId) ||
      !Number.isSafeInteger(c.ownerWindowId) || (c.ownerWindowId as number) <= 0 ||
      (c.tier !== 'NORMAL' && c.tier !== 'SENSITIVE_MONEY') ||
      !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) ||
      typeof c.signature !== 'string' || !SIGNATURE_PATTERN.test(c.signature)) return null
  return c as SignedGrantCommand
}

/**
 * In-memory duplicate rejection has a hard capacity: never evict an unexpired
 * entry to make room, because that would make a replay valid again. Verify and
 * consume synchronously so competing requests cannot both succeed in one process.
 * A transport must add durable replay protection and a trusted clock on restart.
 */
export function createSignedGrantVerifier(options: VerifierOptions) {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength < 32 ||
      typeof options.storeId !== 'string' || !ID_PATTERN.test(options.storeId)) {
    throw new Error('Invalid remote verifier configuration')
  }
  const maxEntries = options.maxEntries ?? 2048
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new Error('Invalid remote verifier capacity')
  }
  const allowedPanels = new Set(options.allowedPanels)
  const storeId = options.storeId
  const key = Buffer.from(options.key)
  const clock = options.now ?? Date.now
  const requestIds = new Map<string, number>()
  const nonces = new Map<string, number>()
  let lastNow = 0

  return (input: unknown): CommandVerification => {
    const command = parseCommand(input)
    if (!command || command.storeId !== storeId || !allowedPanels.has(command.panel)) {
      return { ok: false, reason: 'INVALID' }
    }
    const observedNow = clock()
    if (!Number.isSafeInteger(observedNow) || observedNow <= 0) return { ok: false, reason: 'INVALID' }
    // A clock rollback must not resurrect a command already observed as expired.
    const now = Math.max(lastNow, observedNow)
    lastNow = now
    if (command.issuedAt <= 0 || command.expiresAt <= command.issuedAt ||
        command.expiresAt - command.issuedAt > MAX_TTL_MS ||
        command.issuedAt > now + MAX_FUTURE_SKEW_MS || command.expiresAt <= now) {
      return { ok: false, reason: 'EXPIRED' }
    }
    const expected = createHmac('sha256', key).update(signedBytes(command), 'utf8').digest()
    const received = Buffer.from(command.signature, 'hex')
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { ok: false, reason: 'INVALID' }
    }
    for (const [id, expiry] of requestIds) if (expiry <= now) requestIds.delete(id)
    for (const [nonce, expiry] of nonces) if (expiry <= now) nonces.delete(nonce)
    if (requestIds.has(command.requestId) || nonces.has(command.nonce)) {
      return { ok: false, reason: 'REPLAY' }
    }
    if (requestIds.size >= maxEntries || nonces.size >= maxEntries) {
      return { ok: false, reason: 'CAPACITY' }
    }
    requestIds.set(command.requestId, command.expiresAt)
    nonces.set(command.nonce, command.expiresAt)
    return { ok: true, command: { ...command } }
  }
}
