/**
 * Remote-grant registry of the desktop host. This module is not a complete
 * approval channel by itself: its caller (the host's approval bridge) must verify
 * a signed command, member ACL, tier policy and durable replay protection before
 * a grant is created here. NORMAL panel policies open a part; SENSITIVE_MONEY
 * one-shot policies (catalog action ids only) become a one-time gate ticket.
 * A visible six-digit code is only for visual comparison, never a credential.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { GATE_ACTION_IDS } from '../../shared/gateCatalog'

export type GrantTier = 'NORMAL' | 'SENSITIVE_MONEY'
export type GrantMode = 'PANEL' | 'ONE_SHOT'
type Pending = { requestId: string; code: string; tokenHash: Buffer; panel: string; ownerWindowId: number; createdAt: number; recent: number }
type Grant = {
  id: string; panel: string; ownerWindowId: number; tier: GrantTier; mode: GrantMode
  approvedAt: number; claimBy: number; expiresAt: number; lastUsedAt: number
  memberId: string; requestId: string; usesLeft: number
  tokenHash: Buffer; ttlMs: number; idleMs: number; claimed: boolean; revoking?: boolean; cleanup?: () => void
}
type GrantInput = {
  panel: string; ownerWindowId: number; tier: GrantTier; mode: GrantMode
  memberId: string; requestId: string; ttlMs: number
}
const grants = new Map<string, Grant>()
const pendingRequests = new Map<string, Pending>()
const failCounts = new Map<string, { count: number; lockedUntil: number }>()
// طرح ۱۴۰۵ §۳-۱۲ بند ۴: انتظار درخواست ۱۰ دقیقه؛ بی‌کاری «یک‌پنجم مدت، کمینه ۳ و بیشینه ۱۰ دقیقه»؛ سقف هر دو رده ۱۰۰۰ دقیقه (دفتر آزمون ۴-۲۸).
const PENDING_MS = 10 * 60_000, CLAIM_MS = 3 * 60_000, IDLE_MS = 3 * 60_000, MAX_TTL_MS = 1000 * 60_000
const idleFor = (ttl: number) => Math.min(10 * 60_000, Math.max(IDLE_MS, Math.round(ttl / 5)))
/** فقط شناسه‌های کار کاتالوگ مجوز یک‌بار می‌گیرند؛ نتیجه‌اش بلیت است، نه نشست پنل (§۳-۱۲ بند ۵). */
const ONE_SHOT_IDS: ReadonlySet<string> = new Set(GATE_ACTION_IDS)
const LOCK_MS = 15 * 60_000
// Decision 15 of the mobile design: more than three requests for one panel in
// ten minutes are flagged to the approvers on the phone. A warning, never a block.
const REQUEST_LOG_MS = 10 * 60_000, SUSPICIOUS_OVER = 3
const requestLog = new Map<string, number[]>()
function noteRequest(panel: string): number {
  const t = now()
  if (!requestLog.has(panel) && requestLog.size >= 256) {
    for (const [p, times] of requestLog) if (!times.some(x => t - x < REQUEST_LOG_MS)) requestLog.delete(p)
    if (requestLog.size >= 256) return 1
  }
  const times = (requestLog.get(panel) ?? []).filter(x => t - x < REQUEST_LOG_MS)
  times.push(t)
  if (times.length > 1000) times.splice(0, times.length - 1000)
  requestLog.set(panel, times)
  return times.length
}
const VALID_PANEL = /^[A-Za-z0-9_.:-]{1,128}$/
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/
const VALID_TOKEN = /^[A-Za-z0-9_-]{43}$/
const now = () => performance.now()
const keyOf = (owner: number, panel: string) => `${owner}::${panel}`
const validOwner = (owner: number | null): owner is number => Number.isSafeInteger(owner) && (owner as number) > 0
const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest()

let injected: {
  notePanelUnlocked: (panel: string, scope: 'PANEL', owner: number, allowed: (touch: boolean) => boolean, ttlMs?: number) => void | (() => void)
  clearPanelScope: (panel: string, owner: number) => void
  clearPanelSessions: (owner: number) => void
  /** طرح ۱۴۰۵: بلیت یک‌بار «پنجره + شناسهٔ کار»؛ خروجی true یعنی ساخته شد. میزبان زنده همیشه می‌دهد. */
  addOneShotTicket?: (actionId: string, owner: number, ttlMs: number, memberId: string) => boolean
  clearOneShotTickets?: (memberId?: string) => void
  /** مدت مجوز راه دور همان قسمت از پروندهٔ مدت‌ها (میلی‌ثانیه، ۱ تا ۱۰۰۰ دقیقه؛ ۴-۲۸) */
  grantDurationMs?: (panel: string) => number
} | null = null
/** مدت واقعی هنگام فعال‌سازی: کمترینِ «سقف سیاست» و «مدت مجوز راه دور» (§۳-۱۲ بند ۳). */
function effectiveTtl(policyTtl: number, panel: string): number {
  let configured: unknown = null
  try { configured = injected?.grantDurationMs?.(panel) } catch { configured = null }
  return Number.isSafeInteger(configured) && (configured as number) >= 60_000 && (configured as number) <= MAX_TTL_MS
    ? Math.min(policyTtl, configured as number) : policyTtl
}
let isolated = false
// A supervisor owns this latch through startup and shutdown. Failure leaves it
// closed; only a cleanly stopped owner may release it for a later supervisor.
let admissionOwner: object | null = null
let admissionBlocked = false
type ClaimGuard = (claim:()=>boolean)=>Promise<boolean>
let claimGuard: ClaimGuard | null = null
export function acquireRemoteAdmissionLease() {
  if (admissionOwner) throw new Error('Remote admission owner already active')
  const owner = {}; admissionOwner = owner; admissionBlocked = true
  let failed = false
  const owns = () => admissionOwner === owner
  return {
    isOpen() { return owns() && !failed && !admissionBlocked },
    open() { if (!owns() || failed) throw new Error('Remote admission lease unavailable'); admissionBlocked = false },
    installClaimGuard(guard:ClaimGuard) {
      if (!owns() || failed || claimGuard || typeof guard !== 'function') throw new Error('Remote claim guard unavailable')
      claimGuard=guard
    },
    block() { if (owns()) { failed = true; admissionBlocked = true; claimGuard=null } },
    release() { if (!owns()) throw new Error('Remote admission lease lost'); admissionBlocked = true; claimGuard=null; admissionOwner = null }
  }
}
/** True once a host has wired the registry to the panel-session store. Grant
 * IPC must not exist before that (e.g. while the owner opt-in is off). */
export function remoteRegistryInitialized(): boolean { return injected !== null }
export function initRemoteGrantRegistry(deps: NonNullable<typeof injected>) {
  if (isolated) throw new Error('Isolated remote registry cannot be replaced')
  injected = deps
}
/** Experimental isolated mode: a remote grant is checked separately instead of
 * writing to or deleting the local panel-session map. Must be selected before
 * any requests, grants, or credential lockouts exist. Not wired into the app. */
export function initIsolatedRemoteGrantRegistry() {
  if (isolated) return
  if (pendingRequests.size || grants.size || failCounts.size) throw new Error('Remote registry is not empty')
  injected = { notePanelUnlocked: () => {}, clearPanelScope: () => {}, clearPanelSessions: () => {} }
  isolated = true
}
function clearGrant(k: string, grant: Grant) {
  if (grants.get(k) !== grant) return
  // A failing external cleanup must not reactivate this grant, nor lose the
  // information required to retry clearing the host's panel session.
  grant.revoking = true
  if (grant.claimed && grant.mode === 'PANEL') {
    if (grant.cleanup) grant.cleanup()
    else injected?.clearPanelScope(grant.panel, grant.ownerWindowId)
  }
  grants.delete(k)
}
function active(k: string): Grant | null {
  const g = grants.get(k)
  if (!g || g.revoking || admissionBlocked) return null
  const t = now()
  if ((!g.claimed && t >= g.claimBy) || (g.claimed && (t >= g.expiresAt || t - g.lastUsedAt >= g.idleMs))) {
    // A host cleanup exception cannot make an expired grant active again. The
    // expiry timer retains the entry and retries without crashing Electron.
    try { clearGrant(k, g) } catch {}
    return null
  }
  return g
}
function scheduleExpiry(k: string, g: Grant) {
  const check = () => {
    if (grants.get(k) !== g) return
    if (g.revoking) {
      try { clearGrant(k, g) } catch {}
      if (grants.get(k) === g) setTimeout(check, 1000).unref?.()
      return
    }
    if (!active(k)) {
      if (grants.get(k) === g && g.revoking) setTimeout(check, 1000).unref?.()
      return
    }
    const deadline = g.claimed ? Math.min(g.expiresAt, g.lastUsedAt + g.idleMs) : g.claimBy
    setTimeout(check, Math.max(1, Math.ceil(deadline - now()))).unref?.()
  }
  const deadline = g.claimed ? Math.min(g.expiresAt, g.lastUsedAt + g.idleMs) : g.claimBy
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
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) return false
  const g = active(keyOf(ownerWindowId, panel))
  return !!g && g.claimed && g.mode === 'PANEL'
}

/** Separate from local panel sessions. Only real authorized activity may touch
 * idle time; renderer status polling must use the default non-touching check. */
export function hasIsolatedRemotePanel(panel: string, ownerWindowId: number, touch = false): boolean {
  if (!isolated || typeof touch !== 'boolean' || !validOwner(ownerWindowId) ||
      typeof panel !== 'string' || !VALID_PANEL.test(panel)) return false
  const grant = active(keyOf(ownerWindowId, panel))
  if (!grant?.claimed || grant.mode !== 'PANEL') return false
  if (touch) grant.lastUsedAt = now()
  return true
}
export function listIsolatedRemotePanels(ownerWindowId: number): string[] {
  if (!isolated || !validOwner(ownerWindowId)) return []
  const result: string[] = []
  for (const [key, grant] of grants) {
    if (grant.ownerWindowId !== ownerWindowId) continue
    const current = active(key)
    if (current?.claimed && current.mode === 'PANEL') result.push(current.panel)
  }
  return result.sort()
}

/** Window and request bound status; this does not claim or extend a grant. */
export function getRequestStatus(ownerWindowId: number, panel: string, requestId: string): 'PENDING' | 'APPROVED' | 'CLAIMED' | 'UNAVAILABLE' {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel) ||
      typeof requestId !== 'string' || !VALID_ID.test(requestId)) return 'UNAVAILABLE'
  const pending = getPending(ownerWindowId, panel)
  if (pending) return pending.requestId === requestId ? 'PENDING' : 'UNAVAILABLE'
  const grant = active(keyOf(ownerWindowId, panel))
  if (!grant || grant.requestId !== requestId) return 'UNAVAILABLE'
  return grant.claimed ? 'CLAIMED' : 'APPROVED'
}
/** An ownerless authorization is never valid; kept only for old callers. */
export function remoteGrantActive(_panel: string): boolean { return false }
export function isActiveForCurrentWindow(_panel: string): boolean { return false }

/** Explicit remote panel claim; never interpret a local password as a token.
 * The request, owner and normal-panel policy are checked synchronously with
 * consumption so a stale renderer response cannot claim another request. */
export async function claimRemotePanel(ownerWindowId: number, panel: string, requestId: string, token: string): Promise<boolean> {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel) ||
      typeof requestId !== 'string' || !VALID_ID.test(requestId) || !admissionOwner || admissionBlocked || !claimGuard) return false
  const owner=admissionOwner, guard=claimGuard
  try {
    return await guard(()=>{
      // Stop, restore and another lease cannot be allowed to race this claim.
      if (admissionOwner!==owner || admissionBlocked || claimGuard!==guard) return false
      const grant=active(keyOf(ownerWindowId,panel))
      const shape=!!grant && ((grant.tier==='NORMAL' && grant.mode==='PANEL') || (grant.tier==='SENSITIVE_MONEY' && grant.mode==='ONE_SHOT' && ONE_SHOT_IDS.has(panel)))
      if (!grant || grant.claimed || grant.requestId!==requestId || !shape) return false
      return consumeOneShot(ownerWindowId,panel,token)
    }) === true
  } catch { return false }
}

export function consumeOneShot(ownerWindowId: number | null, panel: string, token: string): boolean {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) return false
  const k = keyOf(ownerWindowId, panel)
  if (isLocked(k)) return false
  const g = active(k)
  const matches = typeof token === 'string' && VALID_TOKEN.test(token) && !!g && timingSafeEqual(tokenHash(token), g.tokenHash)
  if (!matches || !g) { noteFailure(k); return false }
  const t = now()
  const ttl = g.claimed ? g.ttlMs : effectiveTtl(g.ttlMs, panel)
  // طرح ۱۴۰۵ §۳-۱۲ بند ۵: بلیت یک‌بار پیش از پاک کردن مجوز؛ شکست ساخت ⇒ مجوز مصرف نمی‌شود و «ناموفق».
  if (g.mode === 'ONE_SHOT' && injected?.addOneShotTicket) {
    let made = false
    try { made = injected.addOneShotTicket(panel, ownerWindowId, ttl, g.memberId) === true } catch { made = false }
    if (!made) return false
  }
  if (!g.claimed) {
    if (g.mode === 'PANEL' && !injected) return false
    g.claimed = true; g.ttlMs = ttl; g.idleMs = idleFor(ttl); g.expiresAt = t + ttl
    if (g.mode === 'PANEL') {
      // A host may supply an ownership-bound cleanup; legacy adapters still
      // use clearPanelScope and must not be wired into the live desktop.
      try {
        const allowed = (touch: boolean) => {
          if (active(k) !== g || !g.claimed || g.mode !== 'PANEL') return false
          if (touch) g.lastUsedAt = now()
          return true
        }
        const cleanup=injected?.notePanelUnlocked(panel, 'PANEL', ownerWindowId, allowed, ttl)
        if (typeof cleanup === 'function') g.cleanup=cleanup
      } catch { clearGrant(k, g); return false }
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
  if (admissionBlocked) return null
  if (!opts || !validOwner(opts.ownerWindowId) || typeof opts.panel !== 'string' || !VALID_PANEL.test(opts.panel) ||
      typeof opts.requestId !== 'string' || !VALID_ID.test(opts.requestId) ||
      typeof opts.memberId !== 'string' || !VALID_ID.test(opts.memberId) ||
      (opts.tier !== 'NORMAL' && opts.tier !== 'SENSITIVE_MONEY') ||
      (opts.mode !== 'PANEL' && opts.mode !== 'ONE_SHOT') || !Number.isSafeInteger(opts.ttlMs) ||
      opts.ttlMs <= 0 || opts.ttlMs > MAX_TTL_MS) return null
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
    tokenHash: pending.tokenHash, ttlMs: opts.ttlMs, idleMs: IDLE_MS, claimed: false
  }
  grants.set(k, g); scheduleExpiry(k, g)
  const { tokenHash: _secret, ...publicGrant } = g
  return publicGrant
}
export function revokeBy(memberId: string) {
  let failed = false
  for (const [k, g] of grants) if (g.memberId === memberId) {
    try { clearGrant(k, g) } catch { failed = true }
  }
  try { injected?.clearOneShotTickets?.(memberId) } catch {}
  if (failed) throw new Error('Remote panel cleanup failed')
}
export function revokeAll() {
  let failed = false
  for (const [k, g] of grants) {
    try { clearGrant(k, g) } catch { failed = true }
  }
  pendingRequests.clear(); failCounts.clear()
  try { injected?.clearOneShotTickets?.() } catch {}
  // Never acknowledge if the host could not clear an external session.
  // Failed entries remain inactive and can be retried.
  if (failed) throw new Error('Remote panel cleanup failed')
}
/** Window-scoped cancellation; never revoke another window's grants. */
export function cancelForWindow(ownerWindowId: number, panel?: string): boolean {
  if (!validOwner(ownerWindowId) || (panel !== undefined && (typeof panel !== 'string' || !VALID_PANEL.test(panel)))) return false
  for (const [k, p] of pendingRequests) {
    if (p.ownerWindowId === ownerWindowId && (panel === undefined || p.panel === panel)) pendingRequests.delete(k)
  }
  let failed = false
  for (const [k, g] of grants) {
    if (g.ownerWindowId === ownerWindowId && (panel === undefined || g.panel === panel)) {
      try { clearGrant(k, g) } catch { failed = true }
    }
  }
  // Continue closing other scopes even when one host cleanup fails. Failed
  // entries remain revoking for retry, and the caller must not report success.
  if (failed) throw new Error('Remote panel cleanup failed')
  // Cancellation must not erase a credential-guessing lockout.
  return true
}
/**
 * طرح ۱۴۰۵ §۴-۱-ب — «رد» با دکمهٔ ربات: همان لغو درخواستِ همان پنجره و همان قفل (مثل `cancelForWindow`)،
 * به‌علاوهٔ یادداشت «رد شد» تا پنجرهٔ فروشنده «مدیر رد کرد» ببیند. فقط درخواستِ هنوز در انتظار با همان شناسه.
 */
const rejectedRequests = new Map<string, { requestId: string; at: number }>()
export function rejectRequest(ownerWindowId: number, panel: string, requestId: string): boolean {
  const pending = getPending(ownerWindowId, panel)
  if (!pending || pending.requestId !== requestId) return false
  pendingRequests.delete(keyOf(ownerWindowId, panel))
  if (rejectedRequests.size >= 1000) rejectedRequests.clear()
  rejectedRequests.set(keyOf(ownerWindowId, panel), { requestId, at: now() })
  return true
}
/** پنجرهٔ فروشنده: آیا همین درخواست با دکمهٔ ربات رد شد؟ (تا ۱۰ دقیقه) */
export function requestRejected(ownerWindowId: number, panel: string, requestId: string): boolean {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || typeof requestId !== 'string') return false
  const r = rejectedRequests.get(keyOf(ownerWindowId, panel))
  return !!r && r.requestId === requestId && now() - r.at < PENDING_MS
}
export function requestCode(panel: string, ownerWindowId: number): { code: string; gt: string; requestId: string } {
  if (admissionBlocked) throw new Error('Remote admission closed')
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) throw new Error('Invalid remote request')
  const k = keyOf(ownerWindowId, panel)
  if (!pendingRequests.has(k) && pendingRequests.size >= 1000) {
    for (const p of pendingRequests.values()) getPending(p.ownerWindowId,p.panel)
    if (pendingRequests.size >= 1000) throw new Error('Remote request capacity reached')
  }
  const code = String(randomInt(100_000, 1_000_000))
  const token = randomBytes(32).toString('base64url'), requestId = randomBytes(16).toString('hex')
  const pending: Pending = { requestId, code, tokenHash: tokenHash(token), panel, ownerWindowId, createdAt: now(), recent: noteRequest(panel) }
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
/** Trusted host only: active grants for the owner's live view, without token,
 * request or member identifiers. `remainingMs` is the time until the grant
 * closes unless it is used (claimed: idle or hard expiry, whichever is first;
 * unclaimed: the claim deadline). Reading never extends a grant. */
export function listActiveGrants() {
  const result: { panel: string; ownerWindowId: number; claimed: boolean; remainingMs: number }[] = []
  for (const key of [...grants.keys()]) {
    const g = active(key)
    if (!g) continue
    const remainingMs = Math.floor((g.claimed ? Math.min(g.expiresAt, g.lastUsedAt + g.idleMs) : g.claimBy) - now())
    if (remainingMs > 0) result.push({ panel: g.panel, ownerWindowId: g.ownerWindowId, claimed: g.claimed, remainingMs })
  }
  return result
}
/** Desktop banner: whole seconds left on this window's claimed panel grant, or
 * null when none is open. A status read; it never touches idle time. */
export function remotePanelSecondsLeft(ownerWindowId: number, panel: string): number | null {
  if (!validOwner(ownerWindowId) || typeof panel !== 'string' || !VALID_PANEL.test(panel)) return null
  const g = active(keyOf(ownerWindowId, panel))
  if (!g || !g.claimed || g.mode !== 'PANEL') return null
  return Math.max(0, Math.ceil((Math.min(g.expiresAt, g.lastUsedAt + g.idleMs) - now()) / 1000))
}
/** Trusted host only: filter by member ACL before returning entries to a client. */
export function listPendingRequests() {
  const result: { requestId: string; code: string; panel: string; ownerWindowId: number; recent?: number }[] = []
  for (const p of pendingRequests.values()) {
    const current = getPending(p.ownerWindowId,p.panel)
    // `recent` (requests for this panel in the last ten minutes) only when suspicious.
    if (current) result.push(p.recent > SUSPICIOUS_OVER ? { ...current, recent: p.recent } : current)
  }
  return result
}
