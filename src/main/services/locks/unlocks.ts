/**
 * طرح ۱۴۰۵ §۳-۱۴ تا §۳-۱۷ — نشست‌های نگهبان‌دارِ «کد یک‌بارمصرف» و «مجوز زمان‌بندی‌شده».
 *
 * هر دو با همان `noteRemotePanelUnlocked` موجود ساخته می‌شوند، پس بی‌کاری عمومی پنل روی آن‌ها اثری ندارد و
 * سقف سخت ۶۰ دقیقه را خود `panelSession` دارد (§۳-۱۴). نگهبان هر کدام مدت و بی‌کاری خودش را حساب می‌کند:
 *   - کد: مدت همان قسمت کد (۱ تا ۶۰ دقیقه)، بی‌کاری یک‌پنجم مدت (کمینه ۳ و بیشینه ۱۰ دقیقه)؛
 *   - زمان‌بندی‌شده: تا ساعت پایان، بی بی‌کاری.
 * اگر همان قسمت برای همان پنجره از قبل باز است (نشست مدیر یا نشست همان کلید)، چیزی ساخته نمی‌شود و خروجی
 * false است: کد مصرف نمی‌شود و مجوز زمان‌بندی‌شده در دور بعدی ۳۰ ثانیه‌ای نصب می‌شود.
 * «بستن همه»، P1 و P2 همه را با `closeGuardedParts` می‌بندند. ساعت: یکنواخت (`performance.now()`).
 */
import { performance } from 'node:perf_hooks'
import type { GateMethodKey } from '@shared/gateCatalog'
import { normalizePanelKey } from '@shared/panels'
import { noteRemotePanelUnlocked, panelSessionStatus, sessionGuardOf } from '../panelSession'

export type GuardSource = 'CODE' | 'SCHEDULED'
interface Guarded {
  readonly owner: number
  readonly key: string
  readonly source: GuardSource
  readonly method: GateMethodKey
  readonly number?: number
  readonly grantId?: string
  readonly allowed: (touch: boolean) => boolean
  closed: boolean
  cleanup: () => void
}

const MIN_IDLE_MS = 3 * 60_000, MAX_IDLE_MS = 10 * 60_000, MAX_MS = 60 * 60_000
const guards = new Map<string, Guarded>()
const keyOf = (owner: number, key: string) => `${owner}::${key}`
const panelKey = (panel: string) => normalizePanelKey(panel) ?? panel
let clock: () => number = () => performance.now()

/** فقط آزمون: ساعت یکنواخت ساختگی. */
export function setUnlockClockForTests(fn: (() => number) | null): void {
  clock = typeof fn === 'function' ? fn : () => performance.now()
}

/** بی‌کاری «یک‌پنجم مدت، کمینه ۳ و بیشینه ۱۰ دقیقه» (همان قاعدهٔ مجوز راه دور). */
export function idleForMs(ttlMs: number): number {
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.round(ttlMs / 5)))
}

/** آیا همین قسمت برای این پنجره از قبل باز است (نشست مدیر یا نشست همان کلید)؟ بی تمدید بی‌کاری. */
export function partAlreadyOpen(owner: number, panel: string): boolean {
  const status = panelSessionStatus(owner)
  return status.manager || status.panels.includes(panelKey(panel))
}

function forget(entry: Guarded): void {
  entry.closed = true
  const k = keyOf(entry.owner, entry.key)
  if (guards.get(k) === entry) guards.delete(k)
}

/** ورودی‌هایی که نشست پنلشان جای دیگری پاک شده (خروج مدیر، بسته شدن پنجره) کنار می‌روند. */
function purgeStale(): void {
  for (const entry of [...guards.values()]) if (sessionGuardOf(entry.key, entry.owner) !== entry.allowed) forget(entry)
}

/**
 * نشست نگهبان‌دار برای «پنجره + قسمت». خروجی false یعنی ساخته نشد (قسمت از قبل باز بود یا ورودی نادرست).
 * `ttlMs` تا ۶۰ دقیقه؛ `idle` فقط برای کد (زمان‌بندی‌شده بی‌کاری ندارد).
 */
export function openGuardedPart(owner: number, panel: string, opts: {
  source: GuardSource
  method: GateMethodKey
  number?: number
  grantId?: string
  ttlMs: number
  idle: boolean
}): boolean {
  if (!Number.isSafeInteger(owner) || owner <= 0 || typeof panel !== 'string' || !Number.isSafeInteger(opts.ttlMs) || opts.ttlMs <= 0) return false
  const key = panelKey(panel)
  purgeStale()
  if (partAlreadyOpen(owner, key)) return false
  const ttl = Math.min(opts.ttlMs, MAX_MS), idleMs = opts.idle ? idleForMs(ttl) : 0
  const start = clock(), end = start + ttl
  let lastUsed = start
  const allowed = (touch: boolean): boolean => {
    if (entry.closed) return false
    const t = clock()
    if (t >= end || (idleMs > 0 && t - lastUsed >= idleMs)) { forget(entry); return false }
    if (touch) lastUsed = t
    return true
  }
  const entry: Guarded = {
    owner, key, source: opts.source, method: opts.method, allowed, closed: false, cleanup: () => {},
    ...(Number.isSafeInteger(opts.number) ? { number: opts.number } : {}),
    ...(typeof opts.grantId === 'string' ? { grantId: opts.grantId } : {})
  }
  guards.set(keyOf(owner, key), entry)
  try {
    entry.cleanup = noteRemotePanelUnlocked(key, owner, allowed)
  } catch {
    forget(entry)
    return false
  }
  if (sessionGuardOf(key, owner) !== allowed) { forget(entry); return false }
  return true
}

/** بستن نشست‌های نگهبان‌دار (همه، یا فقط یک منبع، یک پنجره یا یک مجوز زمان‌بندی‌شده). خروجی: شمار بسته‌شده‌ها. */
export function closeGuardedParts(filter: { source?: GuardSource; owner?: number; grantId?: string } = {}): number {
  let closed = 0
  for (const entry of [...guards.values()]) {
    if (filter.source !== undefined && entry.source !== filter.source) continue
    if (filter.owner !== undefined && entry.owner !== filter.owner) continue
    if (filter.grantId !== undefined && entry.grantId !== filter.grantId) continue
    forget(entry)
    try { entry.cleanup() } catch {}
    closed++
  }
  return closed
}

/** روش ثبت‌شدنی نشست نگهبان‌دارِ زندهٔ همین پنجره و کلید (کد یا زمان‌بندی‌شده)؛ null یعنی مجوز راه دور یا هیچ. */
export function guardedEntryFor(owner: number, panel: string): { method: GateMethodKey; number?: number; grantId?: string; source: GuardSource } | null {
  const key = panelKey(panel)
  const entry = guards.get(keyOf(owner, key))
  if (!entry || entry.closed || sessionGuardOf(key, owner) !== entry.allowed) return null
  return {
    method: entry.method, source: entry.source,
    ...(entry.number !== undefined ? { number: entry.number } : {}),
    ...(entry.grantId !== undefined ? { grantId: entry.grantId } : {})
  }
}

/** وضعیت و آزمون: نشست‌های ثبت‌شده (بی سنجیدن انقضا). */
export function guardedParts(): Array<{ owner: number; key: string; source: GuardSource; grantId?: string }> {
  purgeStale()
  return [...guards.values()].filter((e) => !e.closed).map((e) => ({ owner: e.owner, key: e.key, source: e.source, ...(e.grantId ? { grantId: e.grantId } : {}) }))
}
