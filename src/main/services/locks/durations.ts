/**
 * طرح ۱۴۰۵ §۳-۱۳ (۲۵-۱۲) و دفتر آزمون ۴-۲۸ — پروندهٔ مدت‌ها: `userData/lock-durations.json`، بیرون از پایگاه داده.
 *
 * - چهار عدد صحیح ۱ تا ۱۰۰۰ دقیقه: کد «حساس»، کد «سایر ماژول‌ها»، مجوز راه دور «ماژول‌های معمولی» (کلید قدیمی
 *   `remoteGrantMinutes`) و مجوز راه دور «ماژول‌های پولی و حساس» (`remoteSensitiveGrantMinutes`).
 * - پروندهٔ قدیمیِ سه‌کلیدی سالم خوانده می‌شود و «مدت مجوز راه دور» قبلی برای هر دو مدت راه دور می‌ماند.
 * - نبود یا خرابی پرونده (یا هر فیلد نادرست یا کلید ناشناس): هر چهار ۱۰ دقیقه.
 * - نوشتن اتمی (پروندهٔ موقت + fsync + rename)؛ عدد نادرست پذیرفته نمی‌شود و عدد قبلی می‌ماند.
 * - خواندن هنگام مصرف کد یا فعال‌سازی مجوز؛ قفلی که همین حالا باز است با عدد قبلی بسته می‌شود.
 * - «قفل کار» زمان نمی‌گیرد و یک بار است: پنجرهٔ بلیتش همان مدت است، حداکثر ۶۰ دقیقه (`lockDurationMs`، سقف `tickets.ts`).
 * - `remote-settings.json` دست نمی‌خورد.
 */
import { app } from 'electron'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface LockDurations {
  sensitiveCodeMinutes: number
  otherCodeMinutes: number
  remoteGrantMinutes: number
  remoteSensitiveGrantMinutes: number
}
export type LockDurationKey = keyof LockDurations
/** شکل پروندهٔ قدیمی هم پذیرفته است: بی `remoteSensitiveGrantMinutes`، همان «مدت مجوز راه دور» برای هر دو. */
export type LockDurationsInput = Omit<LockDurations, 'remoteSensitiveGrantMinutes'> & { remoteSensitiveGrantMinutes?: number }

export const LOCK_DURATIONS_FILE = 'lock-durations.json'
/** دفتر آزمون ۴-۲۸: هر مدت ۱ تا ۱۰۰۰ دقیقه. */
export const MAX_DURATION_MINUTES = 1000
/** پنجرهٔ بلیت یک‌بارِ «قفل کار» (همان سقف `tickets.ts`). */
export const ONE_SHOT_MAX_MINUTES = 60
export const LOCK_DURATION_KEYS: readonly LockDurationKey[] = Object.freeze(['sensitiveCodeMinutes', 'otherCodeMinutes', 'remoteGrantMinutes', 'remoteSensitiveGrantMinutes'])
const LEGACY_KEYS = ['sensitiveCodeMinutes', 'otherCodeMinutes', 'remoteGrantMinutes'] as const
export const LOCK_DURATION_TITLES: Readonly<Record<LockDurationKey, string>> = Object.freeze({
  sensitiveCodeMinutes: 'مدت کد یک‌بارمصرف حساس',
  otherCodeMinutes: 'مدت کد یک‌بارمصرف سایر ماژول‌ها',
  remoteGrantMinutes: 'مدت مجوز راه دور — ماژول‌های معمولی',
  remoteSensitiveGrantMinutes: 'مدت مجوز راه دور — ماژول‌های پولی و حساس'
})
export const DEFAULT_LOCK_DURATIONS: Readonly<LockDurations> = Object.freeze({ sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 10, remoteSensitiveGrantMinutes: 10 })

export function validDurationMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_DURATION_MINUTES
}

/** کلید مدت راه دور یک قسمت از بخش کد آن (`codeSectionOfPanel`): «سایر» ⇒ معمولی؛ قسمت پولی، تازه یا قفل کار ⇒ پولی و حساس. */
export function remoteDurationKey(section: string | null): 'remoteGrantMinutes' | 'remoteSensitiveGrantMinutes' {
  return section === 'other' ? 'remoteGrantMinutes' : 'remoteSensitiveGrantMinutes'
}

const defaults = (): LockDurations => ({ ...DEFAULT_LOCK_DURATIONS })

/** سه کلید قدیمی درست و کلید چهارم نبود یا درست؛ خروجی همیشه چهار کلید به همین ترتیب، وگرنه null. */
function complete(record: Record<string, unknown>): LockDurations | null {
  const sensitive = record.remoteSensitiveGrantMinutes === undefined ? record.remoteGrantMinutes : record.remoteSensitiveGrantMinutes
  if (!LEGACY_KEYS.every((key) => validDurationMinutes(record[key])) || !validDurationMinutes(sensitive)) return null
  return {
    sensitiveCodeMinutes: record.sensitiveCodeMinutes as number, otherCodeMinutes: record.otherCodeMinutes as number,
    remoteGrantMinutes: record.remoteGrantMinutes as number, remoteSensitiveGrantMinutes: sensitive
  }
}

/** پارسر سخت‌گیر: پروندهٔ سه‌کلیدی قدیمی یا چهارکلیدی، هر عدد صحیح ۱ تا ۱۰۰۰؛ کلید کم یا ناشناس یا عدد نادرست ⇒ هر چهار ۱۰. */
export function parseLockDurations(raw: unknown): LockDurations {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults()
    const record = value as Record<string, unknown>
    if (Object.keys(record).some((key) => !(LOCK_DURATION_KEYS as readonly string[]).includes(key))) return defaults()
    return complete(record) ?? defaults()
  } catch {
    return defaults()
  }
}

function directory(dir?: string): string | null {
  if (typeof dir === 'string' && dir) return dir
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

export function readLockDurations(dir?: string): LockDurations {
  const base = directory(dir)
  if (!base) return defaults()
  try {
    const path = join(base, LOCK_DURATIONS_FILE)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 4096) return defaults()
    return parseLockDurations(readFileSync(path, 'utf8'))
  } catch {
    return defaults()
  }
}

/** میلی‌ثانیهٔ پنجرهٔ بلیت یک‌بارِ «قفل کار»: همان مدت، حداکثر ۶۰ دقیقه (۴-۲۸: «قفل کار» زمان نمی‌گیرد). */
export function lockDurationMs(key: LockDurationKey, dir?: string): number {
  return Math.min(readLockDurations(dir)[key], ONE_SHOT_MAX_MINUTES) * 60_000
}

/** میلی‌ثانیهٔ باز ماندن یک قسمت (۱ تا ۱۰۰۰ دقیقه). */
export function partDurationMs(key: LockDurationKey, dir?: string): number {
  return readLockDurations(dir)[key] * 60_000
}

/** نوشتن اتمی؛ ورودی نادرست رد می‌شود (خطا) و پروندهٔ قبلی دست‌نخورده می‌ماند. همیشه چهار کلید نوشته می‌شود. */
export function writeLockDurations(next: LockDurationsInput, dir?: string): void {
  const value = next && typeof next === 'object' ? complete(next as unknown as Record<string, unknown>) : null
  if (!value) throw new Error('Invalid lock durations')
  const base = directory(dir)
  if (!base) throw new Error('userData unavailable')
  const path = join(base, LOCK_DURATIONS_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  const body = JSON.stringify(value, null, 2) + '\n'
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}
