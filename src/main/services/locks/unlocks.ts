/**
 * طرح ۱۴۰۵ §۳-۱۴ تا §۳-۱۷ — نشست‌های نگهبان‌دارِ «کد یک‌بارمصرف» و «مجوز زمان‌بندی‌شده».
 *
 * هر دو با همان `noteRemotePanelUnlocked` موجود ساخته می‌شوند، پس بی‌کاری عمومی پنل روی آن‌ها اثری ندارد و
 * سقف سخت ۶۰ دقیقه را خود `panelSession` دارد (§۳-۱۴). نگهبان هر کدام مدت و بی‌کاری خودش را حساب می‌کند:
 *   - کد: مدت همان قسمت کد (۱ تا ۱۰۰۰ دقیقه؛ دفتر آزمون ۴-۲۸)، بی‌کاری یک‌پنجم مدت (کمینه ۳ و بیشینه ۱۰ دقیقه)؛
 *   - زمان‌بندی‌شده: تا ساعت پایان، بی بی‌کاری.
 * اگر همان قسمت برای همان پنجره از قبل باز است (نشست مدیر یا نشست همان کلید)، چیزی ساخته نمی‌شود و خروجی
 * false است: کد مصرف نمی‌شود و مجوز زمان‌بندی‌شده در دور بعدی ۳۰ ثانیه‌ای نصب می‌شود.
 * «بستن همه»، P1 و P2 همه را با `closeGuardedParts` می‌بندند. ساعت: یکنواخت (`performance.now()`).
 * نشستِ بلندتر از سقف ۶۰ دقیقه پیش از سقف تازه می‌شود (`openRenewingPanel`؛ همان راه مجوز راه دور در `CloudSyncService`).
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

const MIN_IDLE_MS = 3 * 60_000, MAX_IDLE_MS = 10 * 60_000, MAX_MS = 1000 * 60_000
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

/**
 * دفتر آزمون ۴-۲۸ (و ۴-۱۳): سقف سخت ۶۰ دقیقهٔ نشست نگهبان‌دار (`GUARDED_MAX_MS` در `panelSession.ts`) دست نمی‌خورد. نشستی
 * که مجوزش بلندتر است، ۵ دقیقه پیش از سقف همان لحظه بسته و با همان نگهبان دوباره باز می‌شود؛ فقط اگر نشست هنوز همان
 * است (جای دیگری بسته نشده)، سقف نرسیده، نگهبان بی تمدید بی‌کاری «معتبر» می‌گوید و ساعت جهش نکرده (فاصلهٔ ساعت
 * دیواری و یکنواخت از بازشدن بیش از ۲ دقیقه فرق نکرده). نشستِ بسته‌شده هرگز دوباره ساخته نمی‌شود. اگر نشست مدیر
 * همان پنجره باز است، تازه‌سازی ۳۰ ثانیه بعد دوباره امتحان می‌شود (نشست مدیر همه را می‌پوشاند).
 */
const SESSION_CAP_MS = 60 * 60_000, RENEW_LEAD_MS = 5 * 60_000, CLOCK_JUMP_MS = 2 * 60_000, MANAGER_RETRY_MS = 30_000
type Renewal = { owner: number; key: string; allowed: (touch: boolean) => boolean; mono: number; wall: number; cleanup: () => void; timer: ReturnType<typeof setTimeout> | null }
const renewals = new Set<Renewal>()

function stopRenewal(r: Renewal): void {
  renewals.delete(r)
  if (r.timer) clearTimeout(r.timer)
  r.timer = null
}
function armRenewal(r: Renewal, delayMs: number): void {
  if (r.timer) clearTimeout(r.timer)
  const timer = setTimeout(() => { renewSession(r) }, Math.max(1_000, delayMs))
  timer.unref?.()
  r.timer = timer
}
function renewSession(r: Renewal): boolean {
  if (!renewals.has(r)) return false
  r.timer = null
  const mono = performance.now(), wall = Date.now()
  let ok = sessionGuardOf(r.key, r.owner) === r.allowed && mono - r.mono < SESSION_CAP_MS && Math.abs((wall - r.wall) - (mono - r.mono)) <= CLOCK_JUMP_MS
  if (ok) { try { ok = r.allowed(false) === true } catch { ok = false } }
  if (!ok || !renewals.has(r)) { stopRenewal(r); return false }
  if (panelSessionStatus(r.owner).manager) { armRenewal(r, MANAGER_RETRY_MS); return false }
  r.cleanup()
  try { r.cleanup = noteRemotePanelUnlocked(r.key, r.owner, r.allowed) } catch { r.cleanup = () => {} }
  if (sessionGuardOf(r.key, r.owner) !== r.allowed) { stopRenewal(r); return false }
  r.mono = mono
  r.wall = wall
  armRenewal(r, SESSION_CAP_MS - RENEW_LEAD_MS)
  return true
}

/**
 * نشست نگهبان‌دار «پنجره + قسمت» با همان `noteRemotePanelUnlocked`. اگر مدت (`ttlMs`) از سقف ۶۰ دقیقهٔ نشست بلندتر است،
 * نشست پیش از سقف تازه می‌شود (بالا). خروجی: بستن همین نشست و توقف تازه‌سازی (مالکیت‌دار؛ نشست جایگزین را نمی‌بندد).
 */
export function openRenewingPanel(panel: string, owner: number, allowed: (touch: boolean) => boolean, ttlMs?: number): () => void {
  const key = panelKey(panel)
  const cleanup = noteRemotePanelUnlocked(key, owner, allowed)
  if (!(typeof ttlMs === 'number' && ttlMs > SESSION_CAP_MS) || sessionGuardOf(key, owner) !== allowed) return cleanup
  const r: Renewal = { owner, key, allowed, mono: performance.now(), wall: Date.now(), cleanup, timer: null }
  renewals.add(r)
  armRenewal(r, SESSION_CAP_MS - RENEW_LEAD_MS)
  return () => { stopRenewal(r); r.cleanup() }
}

/** فقط آزمون: تازه‌سازی‌هایی که وقتشان رسیده (همان کار زمان‌سنج، بی صبر واقعی). خروجی: شمار نشست‌های تازه‌شده. */
export function runDueRenewalsForTests(): number {
  let renewed = 0
  for (const r of [...renewals]) if (performance.now() - r.mono >= SESSION_CAP_MS - RENEW_LEAD_MS && renewSession(r)) renewed++
  return renewed
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
 * `ttlMs` تا ۱۰۰۰ دقیقه؛ `idle` فقط برای کد (زمان‌بندی‌شده بی‌کاری ندارد).
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
    entry.cleanup = openRenewingPanel(key, owner, allowed, ttl)
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
