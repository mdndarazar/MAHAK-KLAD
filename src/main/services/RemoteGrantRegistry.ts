/**
 * Experimental remote-grant registry. The app's remote-readiness gate remains
 * false: this module is not a complete approval channel. Before production, the
 * caller must verify a signed command, member ACL, tier policy and durable replay
 * protection, and the session lifecycle must be integrated and audited.
 * A visible six-digit code is only for visual comparison, never a credential.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export type GrantTier = 'NORMAL' | 'SENSITIVE_MONEY'
export type GrantMode = 'PANEL' | 'ONE_SHOT'
type Pending = { requestId: string; code: string; tokenHash: Buffer; panel: string; ownerWindowId: number; createdAt: number }
type Grant = {
  id: string; panel: string; ownerWindowId: number; tier: GrantTier; mode: GrantMode
  approvedAt: number; claimBy: number; expiresAt: number; lastUsedAt: number
  memberId: string; requestId: string; usesLeft: number
  tokenHash: Buffer; ttlMs: number; claimed: boolean
}
type GrantInput = {
  panel: string; ownerWindowId: number; tier: GrantTier; mode: GrantMode
  memberId: string; requestId: string; ttlMs: number
}
const grants = new Map<string, Grant>()
const pendingRequests = new Map<string, Pending>()
const failCounts = new Map<string, { count: number; lockedUntil: number }>()
const PENDING_MS = 4 * 60_000, CLAIM_MS = 3 * 60_000, IDLE_MS = 3 * 60_000
const LOCK_MS = 15 * 60_000
const VALID_PANEL = /^[A-Za-z0-9_.:-]{1,128}$/
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/
const VALID_TOKEN = /^[A-Za-z0-9_-]{43}$/
const now = () => performance.now()
const keyOf = (owner: number, panel: string) => `${owner}::${panel}`
const validOwner = (owner: number | null): owner is number => Number.isSafeInteger(owner) && (owner as number) > 0
const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest()

let injected: {
  notePanelUnlocked: (panel: string, scope: 'PANEL', owner: number) => void
  clearPanelScope: (panel: string, owner: number) => void
  clearPanelSessions: (owner: number) => void
} | null = null
export function initRemoteGrantRegistry(deps: NonNullable<typeof injected>) { injected = deps }
function clearGrant(k: string, grant: Grant) {
  if (grants.get(k) !== grant) return
  grants.delete(k)
  if (grant.claimed && grant.mode === 'PANEL') injected?.clearPanelScope(grant.panel, grant.ownerWindowId)
}
function active(k: string): Grant | null {
  const g = grants.get(k)
  if (!g) return null
  const t = now()
  if ((!g.claimed && t >= g.claimBy) || (g.claimed && (t >= g.expiresAt || t - g.lastUsedAt >= IDLE_MS))) {
    clearGrant(k, g); return null
  }
  return g
}
function scheduleExpiry(k: string, g: Grant) {
  const check = () => {
    if (grants.get(k) !== g) return
    if (!active(k)) return
    const deadline = g.claimed ? Math.min(g.expiresAt, g.lastUsedAt + IDLE_MS) : g.claimBy
    setTimeout(check, Math.max(1, Math.ceil(deadline - now()))).unref?.()
  }
  const deadline = g.claimed ? Math.min(g.expiresAt, g.lastUsedAt + IDLE_MS) : g.claimBy
  setTimeout(check, Math.max(1, Math.ceil(deadline - now()))).unref?.()
}
function isLocked(k: string): boolean {
  const record = failCounts.get(k)
  if (!record) return false
  if (record.lockedUntil && now() >= record.lockedUntil) { failCounts.delete(k); return false }
  return record.lockedUntil > now()
}
function noteFailure(k: string) {
  const record = failCounts.get(k) ?? { count: 0, lockedUntil: 0 }
  record.count++
  if (record.count >= 5) { record.count = 0; record.lockedUntil = now() + LOCK_MS }
  failCounts.set(k, record)
}

export function isGrantActiveForWindow(panel: string, ownerWindowId: number): boolean {
  if (!validOwner(ownerWindowId) || !VALID_PANEL.test(panel)) return false
  const g = active(keyOf(ownerWindowId, panel))
  return !!g && g.claimed && g.mode === 'PANEL'
}
/** An ownerless authorization is never valid; kept only for old callers. */
export function remoteGrantActive(_panel: string): boolean { return false }
export function isActiveForCurrentWindow(_panel: string): boolean { return false }

export function consumeOneShot(ownerWindowId: number | null, panel: string, token: string): boolean {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) return false
  const k = keyOf(ownerWindowId, panel)
  if (isLocked(k)) return false
  const g = active(k)
  const matches = typeof token === 'string' && VALID_TOKEN.test(token) && !!g && timingSafeEqual(tokenHash(token), g.tokenHash)
  if (!matches || !g) { noteFailure(k); return false }
  const t = now()
  if (!g.claimed) {
    if (g.mode === 'PANEL' && !injected) return false
    g.claimed = true; g.expiresAt = t + g.ttlMs
    if (g.mode === 'PANEL') {
      // A future integration must ensure clearing this scope cannot revoke a
      // different local session subsequently opened in the same panel.
      try { injected?.notePanelUnlocked(panel, 'PANEL', ownerWindowId) } catch { clearGrant(k, g); return false }
    }
    scheduleExpiry(k, g)
  }
  g.lastUsedAt = t
  failCounts.delete(k)
  if (g.mode === 'ONE_SHOT') clearGrant(k, g)
  return true
}
export function markUsed(panel: string, ownerWindowId: number) {
  if (!validOwner(ownerWindowId) || !VALID_PANEL.test(panel)) return
  const g = active(keyOf(ownerWindowId, panel))
  if (g?.claimed && g.mode === 'PANEL') g.lastUsedAt = now()
}

/** Caller MUST first verify the signed approval, member ACL and replay state. */
export function createGrant(opts: GrantInput): Omit<Grant, 'tokenHash'> | null {
  if (!opts || !validOwner(opts.ownerWindowId) || typeof opts.panel !== 'string' || !VALID_PANEL.test(opts.panel) ||
      typeof opts.requestId !== 'string' || !VALID_ID.test(opts.requestId) ||
      typeof opts.memberId !== 'string' || !VALID_ID.test(opts.memberId) ||
      (opts.tier !== 'NORMAL' && opts.tier !== 'SENSITIVE_MONEY') ||
      (opts.mode !== 'PANEL' && opts.mode !== 'ONE_SHOT') || !Number.isSafeInteger(opts.ttlMs) ||
      opts.ttlMs <= 0 || opts.ttlMs > (opts.tier === 'NORMAL' ? 10 * 60_000 : 5 * 60_000)) return null
  const k = keyOf(opts.ownerWindowId, opts.panel), pending = pendingRequests.get(k), t = now()
  if (!pending || pending.requestId !== opts.requestId || t - pending.createdAt >= PENDING_MS) return null
  pendingRequests.delete(k)
  const old = grants.get(k)
  if (old) clearGrant(k, old)
  const mode: GrantMode = opts.tier === 'SENSITIVE_MONEY' ? 'ONE_SHOT' : opts.mode
  const g: Grant = {
    id: randomBytes(16).toString('hex'), panel: opts.panel, ownerWindowId: opts.ownerWindowId,
    tier: opts.tier, mode, approvedAt: t, claimBy: t + CLAIM_MS, expiresAt: 0, lastUsedAt: 0,
    memberId: opts.memberId, requestId: opts.requestId, usesLeft: mode === 'ONE_SHOT' ? 1 : 0,
    tokenHash: pending.tokenHash, ttlMs: opts.ttlMs, claimed: false
  }
  grants.set(k, g); scheduleExpiry(k, g)
  const { tokenHash: _secret, ...publicGrant } = g
  return publicGrant
}
export function revokeBy(memberId: string) {
  for (const [k, g] of grants) if (g.memberId === memberId) clearGrant(k, g)
}
export function revokeAll() {
  for (const [k, g] of grants) clearGrant(k, g)
  pendingRequests.clear(); failCounts.clear()
}
/** Window-scoped cancellation; never revoke another window's grants. */
export function cancelForWindow(ownerWindowId: number, panel?: string): boolean {
  if (!validOwner(ownerWindowId) || (panel !== undefined && (typeof panel !== 'string' || !VALID_PANEL.test(panel)))) return false
  for (const [k, p] of pendingRequests) {
    if (p.ownerWindowId === ownerWindowId && (panel === undefined || p.panel === panel)) pendingRequests.delete(k)
  }
  for (const [k, g] of grants) {
    if (g.ownerWindowId === ownerWindowId && (panel === undefined || g.panel === panel)) clearGrant(k, g)
  }
  // Cancellation must not erase a credential-guessing lockout.
  return true
}
export function requestCode(panel: string, ownerWindowId: number): { code: string; gt: string; requestId: string } {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) throw new Error('Invalid remote request')
  const k = keyOf(ownerWindowId, panel), code = String(randomInt(100_000, 1_000_000))
  const token = randomBytes(32).toString('base64url'), requestId = randomBytes(16).toString('hex')
  const pending: Pending = { requestId, code, tokenHash: tokenHash(token), panel, ownerWindowId, createdAt: now() }
  pendingRequests.set(k, pending)
  setTimeout(() => { if (pendingRequests.get(k) === pending) pendingRequests.delete(k) }, PENDING_MS).unref?.()
  return { code, gt: `gt-${token}`, requestId }
}
export function getPending(ownerWindowId: number, panel: string) {
  if (!validOwner(ownerWindowId) || !VALID_PANEL.test(panel)) return null
  const k = keyOf(ownerWindowId, panel), p = pendingRequests.get(k)
  if (!p) return null
  if (now() - p.createdAt >= PENDING_MS) { pendingRequests.delete(k); return null }
  return { requestId: p.requestId, code: p.code, panel: p.panel, ownerWindowId: p.ownerWindowId }
}
