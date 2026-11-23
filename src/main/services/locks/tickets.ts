/**
 * طرح ۱۴۰۵ §۳-۸ — «بلیت یک‌بار»: در حافظهٔ main، با کلید «پنجره + شناسهٔ کار» و زمان پایان با ساعت یکنواخت.
 *
 * ساخته می‌شود از: مجوز یک‌بار راه دور (`consumeOneShot`)، راه «رمز» پنجرهٔ «باز کردن قفل این کار»، و در
 * مرحلهٔ ۶ کد «حساس». پاک می‌شود با: مصرف، پایان مدت، P1/P2 و «بستن همه» (`revokeAll`)، بسته شدن پنجره،
 * بازگردانی و صفر کردن. leaf است (بی import از main) تا آزمون‌های esbuild بی جعل بسته‌بندی‌اش کنند.
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
}

const MAX_TTL_MS = 60 * 60_000
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
  extra: { method?: GateMethodKey | null; number?: number; memberId?: string } = {}
): boolean {
  if (!validOwner(owner) || typeof id !== 'string' || !VALID_ID.test(id) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false
  const k = keyOf(owner, id)
  if (!tickets.has(k) && tickets.size >= MAX_TICKETS) purge()
  if (!tickets.has(k) && tickets.size >= MAX_TICKETS) return false
  const method = extra.method === undefined ? (source === 'PASSWORD' ? null : source) : extra.method
  tickets.set(k, Object.freeze({
    expiresAt: now() + Math.min(ttlMs, MAX_TTL_MS), source, method,
    ...(Number.isSafeInteger(extra.number) ? { number: extra.number } : {}),
    ...(typeof extra.memberId === 'string' ? { memberId: extra.memberId } : {})
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

/** مصرف (حذف) بلیت زنده؛ همان لحظهٔ مصرف پاک می‌شود و دوباره برنمی‌گردد. */
export function takeGateTicket(owner: number, id: string): GateTicket | null {
  const ticket = peekGateTicket(owner, id)
  if (ticket) tickets.delete(keyOf(owner, id))
  return ticket
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
