/**
 * طرح ۱۴۰۵ — کانال‌های تازهٔ دروازه (همه از راه `handle()` مشترک `ipc/index.ts`، پس owner همان پنجره است):
 *   - `gate:unlock`: راه «رمز» پنجرهٔ «باز کردن قفل این کار» ⇒ یک بلیت یک‌بار برای همین پنجره (§۳-۷)؛
 *   - `gate:closeAll`: «بستن همهٔ مجوزها و قفل‌های باز» روی رایانه؛ رمز نمی‌خواهد، چون فقط می‌بندد (§۳-۱۷)؛
 *   - `lockDurations:get` / `lockDurations:set`: پروندهٔ مدت‌ها؛ تغییر «کلیدسازی» است و رمز تایپی مدیر
 *     می‌خواهد، با ردیف `ACCESS_EVENT` و خبر پیام‌رسان (§۳-۱۳).
 */
import { BusinessError } from '../../errors'
import { assertManagerPassword } from '../AuthService'
import { revokeAll } from '../RemoteGrantRegistry'
import { noteAccessEvent } from './accessEvents'
import { LOCK_DURATION_KEYS, LOCK_DURATION_TITLES, readLockDurations, validDurationMinutes, writeLockDurations, type LockDurations } from './durations'
import { unlockActionWithPassword } from './gate'
import { clearGateTickets } from './tickets'

/**
 * یک تابع برای «بستن همه» (§۳-۱۷): مجوزهای راه دور (همان `revokeAll` موجود، که بلیت‌های راه دور را هم پاک
 * می‌کند)، همهٔ بلیت‌های یک‌بار، و در مرحلهٔ ۶ نشست‌های بازشده با کد و مجوز زمان‌بندی‌شده (`cancelFuture`).
 * کدهای یک‌بارمصرف با این دکمه باطل نمی‌شوند؛ باطل کردنشان کار دستی مدیر است.
 */
export function closeAllUnlocks(_options: { cancelFuture?: boolean } = {}): { ok: true } {
  let failed = false
  try { revokeAll() } catch { failed = true }
  clearGateTickets()
  noteAccessEvent('REMOTE_GRANT_CLOSED', { titleFa: 'همهٔ مجوزها و قفل‌های باز' })
  if (failed) throw new BusinessError('بستن یکی از مجوزهای راه دور کامل نشد؛ یک بار دیگر روی همین دکمه بزنید.')
  return { ok: true }
}

/** تغییر مدت‌ها: هر عدد باید صحیح ۱ تا ۶۰ باشد؛ عدد نادرست رد می‌شود و عدد قبلی می‌ماند. */
export async function setLockDurations(input: Record<string, unknown>, userId: number | null = null): Promise<LockDurations> {
  const before = readLockDurations()
  const next: LockDurations = { ...before }
  for (const key of LOCK_DURATION_KEYS) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue
    const value = Number(input[key])
    if (!validDurationMinutes(value)) throw new BusinessError(`«${LOCK_DURATION_TITLES[key]}» باید عددی صحیح بین ۱ تا ۶۰ دقیقه باشد.`)
    next[key] = value
  }
  const changed = LOCK_DURATION_KEYS.filter((key) => next[key] !== before[key])
  if (!changed.length) return before
  const password = typeof input.managerPassword === 'string' ? input.managerPassword : ''
  await assertManagerPassword(password, 'تغییر مدت کدها و مجوز راه دور')
  writeLockDurations(next)
  for (const key of changed) noteAccessEvent('DURATIONS_CHANGED', { titleFa: LOCK_DURATION_TITLES[key], minutes: next[key] }, userId)
  return next
}

type Handle = (channel: string, fn: (payload: any) => unknown) => void

export function registerLockHandlers(handle: Handle, channels: { unlock: string; closeAll: string; durationsGet: string; durationsSet: string }): void {
  handle(channels.unlock, (p) => unlockActionWithPassword(p?.id, p?.password))
  handle(channels.closeAll, () => closeAllUnlocks({ cancelFuture: false }))
  handle(channels.durationsGet, () => readLockDurations())
  handle(channels.durationsSet, (p) => setLockDurations(p && typeof p === 'object' ? p : {}))
}
