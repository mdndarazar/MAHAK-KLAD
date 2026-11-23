/**
 * طرح ۱۴۰۵ §۳-۱۳ (۲۵-۱۲) — پروندهٔ مدت‌ها: `userData/lock-durations.json`، بیرون از پایگاه داده.
 *
 * - سه عدد صحیح ۱ تا ۶۰ دقیقه: کد «حساس»، کد «سایر ماژول‌ها»، مجوز راه دور.
 * - نبود یا خرابی پرونده (یا هر فیلد نادرست): هر سه ۱۰ دقیقه. پارسر سخت‌گیر است: کلید اضافه یا کم هم «خراب» است.
 * - نوشتن اتمی (پروندهٔ موقت + fsync + rename)؛ عدد نادرست پذیرفته نمی‌شود و عدد قبلی می‌ماند.
 * - خواندن هنگام مصرف کد یا فعال‌سازی مجوز؛ قفلی که همین حالا باز است با عدد قبلی بسته می‌شود.
 * - `remote-settings.json` دست نمی‌خورد.
 */
import { app } from 'electron'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface LockDurations {
  sensitiveCodeMinutes: number
  otherCodeMinutes: number
  remoteGrantMinutes: number
}
export type LockDurationKey = keyof LockDurations

export const LOCK_DURATIONS_FILE = 'lock-durations.json'
export const LOCK_DURATION_KEYS: readonly LockDurationKey[] = Object.freeze(['sensitiveCodeMinutes', 'otherCodeMinutes', 'remoteGrantMinutes'])
export const LOCK_DURATION_TITLES: Readonly<Record<LockDurationKey, string>> = Object.freeze({
  sensitiveCodeMinutes: 'مدت کد یک‌بارمصرف حساس',
  otherCodeMinutes: 'مدت کد یک‌بارمصرف سایر ماژول‌ها',
  remoteGrantMinutes: 'مدت مجوز راه دور'
})
export const DEFAULT_LOCK_DURATIONS: Readonly<LockDurations> = Object.freeze({ sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 10 })

export function validDurationMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 60
}

const defaults = (): LockDurations => ({ ...DEFAULT_LOCK_DURATIONS })

/** پارسر سخت‌گیر: دقیقاً همین سه کلید، هر کدام عدد صحیح ۱ تا ۶۰؛ وگرنه هر سه ۱۰. */
export function parseLockDurations(raw: unknown): LockDurations {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults()
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== [...LOCK_DURATION_KEYS].sort().join(',')) return defaults()
    if (!LOCK_DURATION_KEYS.every((key) => validDurationMinutes(record[key]))) return defaults()
    return { sensitiveCodeMinutes: record.sensitiveCodeMinutes as number, otherCodeMinutes: record.otherCodeMinutes as number, remoteGrantMinutes: record.remoteGrantMinutes as number }
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

/** میلی‌ثانیهٔ یک مدت؛ همیشه بین ۱ و ۶۰ دقیقه. */
export function lockDurationMs(key: LockDurationKey, dir?: string): number {
  return readLockDurations(dir)[key] * 60_000
}

/** نوشتن اتمی؛ ورودی نادرست رد می‌شود (خطا) و پروندهٔ قبلی دست‌نخورده می‌ماند. */
export function writeLockDurations(next: LockDurations, dir?: string): void {
  if (!next || !LOCK_DURATION_KEYS.every((key) => validDurationMinutes(next[key]))) throw new Error('Invalid lock durations')
  const base = directory(dir)
  if (!base) throw new Error('userData unavailable')
  const path = join(base, LOCK_DURATIONS_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  const body = JSON.stringify({ sensitiveCodeMinutes: next.sensitiveCodeMinutes, otherCodeMinutes: next.otherCodeMinutes, remoteGrantMinutes: next.remoteGrantMinutes }, null, 2) + '\n'
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
