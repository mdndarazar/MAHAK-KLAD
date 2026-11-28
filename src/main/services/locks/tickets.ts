/**
 * طرح ۱۴۰۵ §۳-۸ — «بلیت یک‌بار»: در حافظهٔ main، با کلید «پنجره + شناسهٔ کار» و زمان پایان با ساعت یکنواخت.
 *
 * ساخته می‌شود از: مجوز یک‌بار راه دور (`consumeOneShot`)، راه «رمز» پنجرهٔ «باز کردن قفل این کار»، و در
 * مرحلهٔ ۶ کد «حساس». پاک می‌شود با: مصرف، پایان مدت، P1/P2 و «بستن همه» (`revokeAll`)، بسته شدن پنجره،
 * بازگردانی و صفر کردن. leaf است (بی import از main) تا آزمون‌های esbuild بی جعل بسته‌بندی‌اش کنند.
 * دفتر آزمون ۴-۳۱ (TL-D12): بلیت چندبارهٔ کارِ «قابل تکرار» با شمار دفعات؛ هر مصرف یکی کم می‌کند و خبرش را به شنوندهٔ
 * میزبان می‌دهد؛ پنجره‌اش تا مدت «پولی و حساس» (حداکثر ۱۰۰۰ دقیقه). P1، P2 و «بستن همه» دفعات باقی را هم پاک می‌کنند.
 */
import { performance } from 'node:perf_hooks'
import type { GateMethodKey } from '@shared/gateCatalog'

export type TicketSource = 'REMOTE_GRANT' | 'SENSITIVE_CODE' | 'PASSWORD'
export interface GateTicket {
  readonly expiresAt: number
  readonly source: TicketSource
  /** روش تازه‌ای که هنگام مصرف در `note` ردیف کار می‌نشیند؛ null یعنی روش امروز (رمز تایپی مدیر) */
  readonly method: GateMethodKey | null
  readonly number?: number
  readonly memberId?: string
  /** دفتر آزمون ۴-۳۱: شمار کل و باقی‌ماندهٔ بلیت چندباره (نبود ⇒ یک بار) */
  readonly uses?: number
  readonly left?: number
}

const MAX_TTL_MS = 60 * 60_000
const REPEAT_MAX_TTL_MS = 1000 * 60_000, REPEAT_MAX_USES = 1000
type UseListener = (use: { owner: number; id: string; use: number; uses: number; memberId?: string }) => void
let useListener: UseListener | null = null
const MAX_TICKETS = 1000
const VALID_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const tickets = new Map<string, GateTicket>()
const now = () => performance.now()
const keyOf = (owner: number, id: string) => `${owner}::${id}`
const validOwner = (owner: unknown): owner is number => Number.isSafeInteger(owner) && (owner as number) > 0

function purge(): void {
  const t = now()
  for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k)
}

/** بلیت تازه؛ بلیت قبلی همان پنجره و همان کار جایگزین می‌شود. خروجی false یعنی ساخته نشد. */
export function addGateTicket(
  owner: number,
  id: string,
  ttlMs: number,
  source: TicketSource,
  extra: { method?: GateMethodKey | null; number?: number; memberId?: string; uses?: number } = {}
): boolean {
  if (!validOwner(owner) || typeof id !== 'string' || !VALID_ID.test(id) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false
  const k = keyOf(owner, id)
  if (!tickets.has(k) && tickets.size >= MAX_TICKETS) purge()
  if (!tickets.has(k) && tickets.size >= MAX_TICKETS) return false
  const method = extra.method === undefined ? (source === 'PASSWORD' ? null : source) : extra.method
  const uses = Number.isSafeInteger(extra.uses) && (extra.uses as number) > 1 ? Math.min(extra.uses as number, REPEAT_MAX_USES) : 0
  tickets.set(k, Object.freeze({
    expiresAt: now() + Math.min(ttlMs, uses ? REPEAT_MAX_TTL_MS : MAX_TTL_MS), source, method,
    ...(Number.isSafeInteger(extra.number) ? { number: extra.number } : {}),
    ...(typeof extra.memberId === 'string' ? { memberId: extra.memberId } : {}),
    ...(uses ? { uses, left: uses } : {})
  }))
  return true
}

/** بی مصرف: آیا بلیت زندهٔ همین پنجره و همین کار هست؟ */
export function peekGateTicket(owner: number, id: string): GateTicket | null {
  if (!validOwner(owner) || typeof id !== 'string') return null
  const k = keyOf(owner, id), ticket = tickets.get(k)
  if (!ticket) return null
  if (ticket.expiresAt <= now()) { tickets.delete(k); return null }
  return ticket
}

/** مصرف (حذف) بلیت زنده؛ همان لحظهٔ مصرف پاک می‌شود و دوباره برنمی‌گردد. ۴-۳۱: بلیت چندباره تا دفعهٔ آخر یکی کم می‌شود. */
export function takeGateTicket(owner: number, id: string): GateTicket | null {
  const ticket = peekGateTicket(owner, id)
  if (!ticket) return null
  const left = ticket.uses && ticket.left ? ticket.left : 0
  if (left > 1) tickets.set(keyOf(owner, id), Object.freeze({ ...ticket, left: left - 1 }))
  else tickets.delete(keyOf(owner, id))
  if (left && ticket.uses) try { useListener?.({ owner, id, use: ticket.uses - left + 1, uses: ticket.uses, ...(ticket.memberId ? { memberId: ticket.memberId } : {}) }) } catch {}
  return ticket
}

/** دفتر آزمون ۴-۳۱: شنوندهٔ هر مصرف بلیت چندباره («بار ۲ از ۳»)؛ میزبان ردیف دسترسی و خبر پیام‌رسان می‌سازد. */
export function setGateTicketUseListener(listener: UseListener | null): void {
  useListener = listener
}

/** دفتر آزمون ۴-۳۱: بلیت‌های چندبارهٔ زنده با دفعات باقی (برای «مجوزهای باز» ربات و صفحهٔ رایانه). */
export function listRepeatTickets(): Array<{ owner: number; id: string; left: number; uses: number; remainingMs: number }> {
  purge()
  const out: Array<{ owner: number; id: string; left: number; uses: number; remainingMs: number }> = []
  for (const [k, v] of tickets) if (v.uses && v.left) out.push({ owner: Number(k.slice(0, k.indexOf('::'))), id: k.slice(k.indexOf('::') + 2), left: v.left, uses: v.uses, remainingMs: Math.max(0, Math.floor(v.expiresAt - now())) })
  return out
}

/** ثانیه‌های باقی‌ماندهٔ بلیت (برای پیام رابط)، بی مصرف. */
export function gateTicketSecondsLeft(owner: number, id: string): number | null {
  const ticket = peekGateTicket(owner, id)
  return ticket ? Math.max(0, Math.ceil((ticket.expiresAt - now()) / 1000)) : null
}

/** همهٔ بلیت‌ها، یا فقط بلیت‌های یک پنجره، یا فقط بلیت‌های راه دورِ یک عضو. */
export function clearGateTickets(filter: { owner?: number; memberId?: string } = {}): void {
  if (filter.owner === undefined && filter.memberId === undefined) { tickets.clear(); return }
  for (const [k, v] of tickets) {
    const owner = Number(k.slice(0, k.indexOf('::')))
    if (filter.owner !== undefined && owner !== filter.owner) continue
    if (filter.memberId !== undefined && v.memberId !== filter.memberId) continue
    tickets.delete(k)
  }
}

/** فقط برای آزمون و وضعیت: شمار بلیت‌های زنده. */
export function gateTicketCount(): number {
  purge()
  return tickets.size
}
