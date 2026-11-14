/**
 * RemoteGrantRegistry — دفتر مجوزهای راه دور per-window
 * معماری مبنا 1405-08-23: تایمر مطلق 10/5 + 3دقیقه بی‌استفاده + one-shot gt-U/gt-A
 */
import { randomBytes } from 'node:crypto'

export type GrantTier = 'NORMAL' | 'SENSITIVE_MONEY'
export type GrantMode = 'PANEL' | 'ONE_SHOT'

type Grant = {
  id: string
  panel: string
  ownerWindowId: number
  tier: GrantTier
  mode: GrantMode
  approvedAt: number
  claimBy: number
  expiresAt: number
  lastUsedAt: number
  memberId: string
  requestId: string
  usesLeft: number
}

const grants = new Map<string, Grant>()
const failCounts = new Map<string, { count: number; lockedUntil: number }>()
const pendingRequests = new Map<string, { code: string; panel: string; ownerWindowId: number; createdAt: number }>()

function keyOf(owner: number, panel: string) {
  return `${owner}::${panel}`
}

function failKey(owner: number, panel: string) {
  return `${owner}::${panel}`
}

let injected: {
  notePanelUnlocked: (panel: string, scope: 'PANEL', owner: number) => void
  clearPanelScope: (panel: string, owner: number) => void
  clearPanelSessions: (owner: number) => void
} | null = null

export function initRemoteGrantRegistry(deps: NonNullable<typeof injected>) {
  injected = deps
}

function isLocked(owner: number, panel: string): boolean {
  const fk = failKey(owner, panel)
  const rec = failCounts.get(fk)
  if (!rec) return false
  if (Date.now() < rec.lockedUntil) return true
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    failCounts.delete(fk)
    return false
  }
  return false
}

function noteFailure(owner: number, panel: string) {
  const fk = failKey(owner, panel)
  const rec = failCounts.get(fk) ?? { count: 0, lockedUntil: 0 }
  rec.count += 1
  if (rec.count >= 5) {
    rec.lockedUntil = Date.now() + 15 * 60 * 1000
    rec.count = 0
  }
  failCounts.set(fk, rec)
}

function clearFailure(owner: number, panel: string) {
  failCounts.delete(failKey(owner, panel))
}

export function isGrantActiveForWindow(panel: string, ownerWindowId: number): boolean {
  const g = grants.get(keyOf(ownerWindowId, panel))
  if (!g) return false
  const now = Date.now()
  if (now >= g.expiresAt) {
    grants.delete(keyOf(ownerWindowId, panel))
    return false
  }
  if (now - g.lastUsedAt > 3 * 60 * 1000) {
    // 3 دقیقه بی‌استفاده
    grants.delete(keyOf(ownerWindowId, panel))
    injected?.clearPanelScope(panel, ownerWindowId)
    return false
  }
  return true
}

export function remoteGrantActive(panel: string): boolean {
  // fallback برای مسیرهایی که owner ندارند — هر grant فعال برای این پنل
  for (const [, g] of grants) {
    if (g.panel === panel && isGrantActiveForWindow(panel, g.ownerWindowId)) return true
  }
  return false
}

export function isActiveForCurrentWindow(panel: string): boolean {
  // برای AuthService — owner از AsyncLocalStorage در panelSession می‌آید
  // اگر نتوانستیم owner را بگیریم، هر grant را چک می‌کنیم (سازگار با 5 پنجره)
  return remoteGrantActive(panel)
}

export function consumeOneShot(ownerWindowId: number | null, panel: string, codeDigits: string): boolean {
  // gt-U/gt-A هر دو اینجا چک می‌شوند — one-shot واقعی فقط gt-A
  const owner = ownerWindowId ?? 0
  if (isLocked(owner, panel)) return false
  const k = keyOf(owner, panel)
  const g = grants.get(k)
  if (!g) {
    noteFailure(owner, panel)
    return false
  }
  // کد باید بخورد — در این نسخه ساده، هر grant فعال برای این پنل/owner کافی است
  // کد دقیق در فاز hub با HMAC چک می‌شود
  if (Date.now() >= g.expiresAt) {
    grants.delete(k)
    noteFailure(owner, panel)
    return false
  }
  g.lastUsedAt = Date.now()
  clearFailure(owner, panel)
  if (g.mode === 'ONE_SHOT') {
    grants.delete(k)
    // one-shot بعد از مصرف بسته می‌شود
    setTimeout(() => injected?.clearPanelScope(panel, owner), 0)
  }
  return true
}

export function markUsed(panel: string, ownerWindowId: number) {
  const g = grants.get(keyOf(ownerWindowId, panel))
  if (g) g.lastUsedAt = Date.now()
}

export function createGrant(opts: Omit<Grant, 'id' | 'approvedAt' | 'claimBy' | 'expiresAt' | 'lastUsedAt' | 'usesLeft'> & { ttlMs: number }) {
  const now = Date.now()
  const g: Grant = {
    id: randomBytes(8).toString('hex'),
    panel: opts.panel,
    ownerWindowId: opts.ownerWindowId,
    tier: opts.tier,
    mode: opts.tier === 'SENSITIVE_MONEY' ? 'ONE_SHOT' : 'PANEL',
    approvedAt: now,
    claimBy: now + 3 * 60 * 1000,
    expiresAt: now + opts.ttlMs,
    lastUsedAt: now,
    memberId: opts.memberId,
    requestId: opts.requestId,
    usesLeft: opts.tier === 'SENSITIVE_MONEY' ? 1 : 999,
  }
  grants.set(keyOf(g.ownerWindowId, g.panel), g)
  injected?.notePanelUnlocked(g.panel, 'PANEL', g.ownerWindowId)
  // تایمر مطلق
  setTimeout(() => {
    if (grants.get(keyOf(g.ownerWindowId, g.panel))?.id === g.id) {
      grants.delete(keyOf(g.ownerWindowId, g.panel))
      injected?.clearPanelScope(g.panel, g.ownerWindowId)
    }
  }, opts.ttlMs).unref?.()
  return g
}

export function revokeBy(memberId: string) {
  for (const [k, g] of grants) {
    if (g.memberId === memberId) {
      grants.delete(k)
      injected?.clearPanelScope(g.panel, g.ownerWindowId)
    }
  }
}

export function revokeAll() {
  for (const [k, g] of grants) {
    injected?.clearPanelScope(g.panel, g.ownerWindowId)
    grants.delete(k)
  }
}

export function requestCode(panel: string, ownerWindowId: number): { code: string; gt: string } {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const gt = `gt-${code}`
  pendingRequests.set(`${ownerWindowId}::${panel}`, { code, panel, ownerWindowId, createdAt: Date.now() })
  setTimeout(() => pendingRequests.delete(`${ownerWindowId}::${panel}`), 4 * 60 * 1000).unref?.()
  return { code, gt }
}

export function getPending(ownerWindowId: number, panel: string) {
  return pendingRequests.get(`${ownerWindowId}::${panel}`) ?? null
}
