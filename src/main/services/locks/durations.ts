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
 * - دفتر آزمون ۴-۳۱ (TL-D12): دو کلید اختیاری در همین پرونده: `repeatUsesMax` («حداکثر دفعات هر مجوز»، عدد صحیح ۱ تا
 *   ۱۰۰۰، پیش‌فرض ۱) و `repeatableActions` (کارهای «قابل تکرار»، پیش‌فرض هیچ؛ کار برگشت‌ناپذیر هرگز). پروندهٔ قدیمی بی
 *   این دو سالم است؛ نادرستیِ یکی مثل هر فیلد نادرست دیگر است. تا تنظیم تکرار پیش‌فرض است، این دو نوشته نمی‌شوند.
 * - `remote-settings.json` دست نمی‌خورد.
 */
import { app } from 'electron'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_ACTION_IDS, GATE_IRREVERSIBLE_ACTIONS, gateEntry } from '../../../shared/gateCatalog'

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
  // دفتر آزمون ۴-۴۵: یک دستهٔ کد؛ مدت از نوع چیزی که باز می‌شود
  sensitiveCodeMinutes: 'مدت باز ماندن ماژول‌های پولی با کد',
  otherCodeMinutes: 'مدت باز ماندن سایر ماژول‌ها با کد',
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

/** دفتر آزمون ۴-۳۱: «حداکثر دفعات هر مجوز» و کارهای «قابل تکرار» (به ترتیب کاتالوگ). */
export interface RepeatSettings { usesMax: number; actions: string[] }
const repeatDefaults = (): RepeatSettings => ({ usesMax: 1, actions: [] })
const REPEAT_KEYS = ['repeatUsesMax', 'repeatableActions'] as const
/** کارهایی که می‌توانند «قابل تکرار» شوند: همهٔ «قفل‌های کار» کاتالوگ جز برگشت‌ناپذیرها، به ترتیب کاتالوگ. */
export const REPEATABLE_ACTION_IDS: readonly string[] = Object.freeze(GATE_ACTION_IDS.filter((id) => gateEntry(id)?.category === 3 && !GATE_IRREVERSIBLE_ACTIONS.includes(id)))

/** دو کلید تکرار (نبود ⇒ پیش‌فرض)؛ عدد نادرست، شناسهٔ ناشناس، برگشت‌ناپذیر یا تکراری ⇒ null. */
function repeatOf(record: Record<string, unknown>): RepeatSettings | null {
  const usesMax = record.repeatUsesMax === undefined ? 1 : record.repeatUsesMax
  const list = record.repeatableActions === undefined ? [] : record.repeatableActions
  if (!validDurationMinutes(usesMax) || !Array.isArray(list) || new Set(list).size !== list.length) return null
  if (!list.every((id) => typeof id === 'string' && REPEATABLE_ACTION_IDS.includes(id))) return null
  return { usesMax, actions: REPEATABLE_ACTION_IDS.filter((id) => list.includes(id)) }
}

/** سه کلید قدیمی درست و کلید چهارم نبود یا درست؛ خروجی همیشه چهار کلید به همین ترتیب، وگرنه null. */
function complete(record: Record<string, unknown>): LockDurations | null {
  const sensitive = record.remoteSensitiveGrantMinutes === undefined ? record.remoteGrantMinutes : record.remoteSensitiveGrantMinutes
  if (!LEGACY_KEYS.every((key) => validDurationMinutes(record[key])) || !validDurationMinutes(sensitive)) return null
  return {
    sensitiveCodeMinutes: record.sensitiveCodeMinutes as number, otherCodeMinutes: record.otherCodeMinutes as number,
    remoteGrantMinutes: record.remoteGrantMinutes as number, remoteSensitiveGrantMinutes: sensitive
  }
}

/** پرونده ⇒ شیء با کلیدهای شناخته (چهار مدت و دو کلید تکرار ۴-۳۱)، وگرنه null. */
function recordOf(raw: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const known: readonly string[] = [...LOCK_DURATION_KEYS, ...REPEAT_KEYS]
    return Object.keys(value).every((key) => known.includes(key)) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * پارسر سخت‌گیر: پروندهٔ سه‌کلیدی قدیمی یا چهارکلیدی (با دو کلید تکرار یا بی آن‌ها)، هر عدد صحیح ۱ تا ۱۰۰۰؛ کلید کم یا
 * ناشناس، عدد نادرست یا تنظیم تکرارِ نادرست ⇒ هر چهار ۱۰.
 */
export function parseLockDurations(raw: unknown): LockDurations {
  const record = recordOf(raw)
  return (record && repeatOf(record) && complete(record)) || defaults()
}

/** دفتر آزمون ۴-۳۱: تنظیم تکرار از همان پرونده؛ پروندهٔ نادرست (هر فیلد) ⇒ پیش‌فرض: یک بار و هیچ کار «قابل تکرار». */
export function parseRepeatSettings(raw: unknown): RepeatSettings {
  const record = recordOf(raw)
  return (record && complete(record) && repeatOf(record)) || repeatDefaults()
}

function directory(dir?: string): string | null {
  if (typeof dir === 'string' && dir) return dir
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

function fileText(dir?: string): string | null {
  const base = directory(dir)
  if (!base) return null
  try {
    const path = join(base, LOCK_DURATIONS_FILE)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 4096) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function readLockDurations(dir?: string): LockDurations {
  const text = fileText(dir)
  return text === null ? defaults() : parseLockDurations(text)
}

export function readRepeatSettings(dir?: string): RepeatSettings {
  const text = fileText(dir)
  return text === null ? repeatDefaults() : parseRepeatSettings(text)
}

/** دفتر آزمون ۴-۳۱: کار «قابل تکرار» ⇒ «حداکثر دفعات هر مجوز»؛ کار دیگر یا برگشت‌ناپذیر ⇒ null. */
export function repeatUsesOf(actionId: string, dir?: string): number | null {
  if (!REPEATABLE_ACTION_IDS.includes(actionId)) return null
  const settings = readRepeatSettings(dir)
  return settings.actions.includes(actionId) ? settings.usesMax : null
}

/** میلی‌ثانیهٔ پنجرهٔ بلیت یک‌بارِ «قفل کار»: همان مدت، حداکثر ۶۰ دقیقه (۴-۲۸: «قفل کار» زمان نمی‌گیرد). */
export function lockDurationMs(key: LockDurationKey, dir?: string): number {
  return Math.min(readLockDurations(dir)[key], ONE_SHOT_MAX_MINUTES) * 60_000
}

/** میلی‌ثانیهٔ باز ماندن یک قسمت (۱ تا ۱۰۰۰ دقیقه). */
export function partDurationMs(key: LockDurationKey, dir?: string): number {
  return readLockDurations(dir)[key] * 60_000
}

/** نوشتن اتمی؛ ورودی نادرست رد می‌شود (خطا) و پروندهٔ قبلی دست‌نخورده می‌ماند. همیشه چهار کلید؛ تنظیم تکرار همان‌که هست. */
export function writeLockDurations(next: LockDurationsInput, dir?: string): void {
  writeLockSettings(next, readRepeatSettings(dir), dir)
}

/** دفتر آزمون ۴-۳۱: مدت‌ها و تنظیم تکرار با هم، در یک نوشتن اتمی؛ تنظیم تکرارِ پیش‌فرض نوشته نمی‌شود (شکل پروندهٔ قدیمی). */
export function writeLockSettings(next: LockDurationsInput, repeat: RepeatSettings, dir?: string): void {
  const value = next && typeof next === 'object' ? complete(next as unknown as Record<string, unknown>) : null
  const extra = repeat && typeof repeat === 'object' ? repeatOf({ repeatUsesMax: repeat.usesMax, repeatableActions: repeat.actions }) : null
  if (!value || !extra) throw new Error('Invalid lock durations')
  const base = directory(dir)
  if (!base) throw new Error('userData unavailable')
  const path = join(base, LOCK_DURATIONS_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  const stored = extra.usesMax !== 1 || extra.actions.length ? { ...value, repeatUsesMax: extra.usesMax, repeatableActions: extra.actions } : value
  const body = JSON.stringify(stored, null, 2) + '\n'
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
