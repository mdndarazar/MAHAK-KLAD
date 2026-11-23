/**
 * طرح ۱۴۰۵ §۳-۱۵ (مورد ۱۴-الف و ۲۵-۱۰) — کدهای یک‌بارمصرف دوقسمتی: «حساس» و «سایر ماژول‌ها»، هر کدام ۵ کد.
 *
 * - پرونده: `userData/one-time-codes.json`، بیرون از پایگاه داده، با نوشتن اتمی. بازگردانی بکاپ کد مصرف‌شده را
 *   زنده نمی‌کند و صفر کردن دستش نمی‌زند.
 * - هر قسمت یک نمک تصادفی ۱۶ بایتی (با هر ساخت تازه عوض می‌شود) و ۵ ردیف `{n, hash, usedAt}`؛ hash با scrypt،
 *   مثل رمزها. ساخت کدهای یک قسمت فقط کدهای همان قسمت را باطل می‌کند.
 * - شمارندهٔ اشتباه مشترک دو قسمت هم در همین پرونده است تا با بستن برنامه صفر نشود: ۵ اشتباه ⇒ ۱۵ دقیقه قفل؛
 *   جدا از رمز مدیر، رمزهای پنل، PIN و کدهای بازیابی. «برداشتن قفل کدها» کار مدیر است (رمز تایپی).
 * - پروندهٔ خراب یعنی همهٔ کدها باطل (هرگز «همه باز»)؛ خبر ⚠️ فقط یک بار در هر اجرا.
 * - مصرف همگام است: خواندن، سنجش، علامت «مصرف‌شده» و نوشتن بی هیچ `await`؛ پس دو پنجرهٔ هم‌زمان یک کد را دو بار
 *   مصرف نمی‌کنند. اگر نوشتن شکست بخورد، کد در حافظه مصرف‌شده می‌ماند.
 * - رقم فارسی و لاتین یکسان؛ خط تیره و فاصله نادیده گرفته می‌شود. قالب نمایش `4821-0937`.
 * کد خام هرگز ذخیره، ثبت یا فرستاده نمی‌شود؛ فقط هنگام ساخت یک بار برمی‌گردد.
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { toLatinDigits } from '@shared/jalali'
import type { OneTimeCodeSection } from '@shared/panels'

export type CodeSection = OneTimeCodeSection
export const CODE_SECTIONS: readonly CodeSection[] = Object.freeze(['sensitive', 'other'])
export const CODE_SECTION_TITLES: Readonly<Record<CodeSection, string>> = Object.freeze({
  sensitive: 'کدهای یک‌بارمصرف ماژول‌های پولی «حساس»',
  other: 'کدهای یک‌بارمصرف سایر ماژول‌ها'
})
/** برچسب ثابت قسمت در ردیف `ACCESS_EVENT` و پیام‌رسان */
export const CODE_SECTION_LABELS: Readonly<Record<CodeSection, string>> = Object.freeze({ sensitive: 'حساس', other: 'سایر ماژول‌ها' })
export const CODES_PER_SECTION = 5
export const CODE_MAX_FAILS = 5
export const CODE_LOCK_MS = 15 * 60_000
export const ONE_TIME_CODES_FILE = 'one-time-codes.json'

interface CodeRow { n: number; hash: string; usedAt: number | null }
interface CodeSectionState { salt: string; createdAt: number; rows: CodeRow[] }
interface CodesState { sections: Record<CodeSection, CodeSectionState | null>; fails: number; lockedUntil: number }
interface Loaded { path: string; state: CodesState | null; broken: boolean; brokenNoticed: boolean }

const HEX = /^[a-f0-9]+$/
let cache: Loaded | null = null
let wallClock: () => number = () => Date.now()

/** فقط آزمون: ساعت دیواری ساختگی (قفل ۱۵ دقیقه‌ای روی پرونده با همین ساعت است). */
export function setCodeClockForTests(fn: (() => number) | null): void {
  wallClock = typeof fn === 'function' ? fn : () => Date.now()
}

function directory(dir?: string): string {
  if (typeof dir === 'string' && dir) return dir
  return app.getPath('userData')
}
const emptyState = (): CodesState => ({ sections: { sensitive: null, other: null }, fails: 0, lockedUntil: 0 })

/** `۴۸۲۱-۰۹۳۷` و `4821 0937` ⇒ `48210937`؛ هر چیز دیگر ⇒ null. */
export function normalizeOneTimeCode(raw: unknown): string | null {
  const value = toLatinDigits(String(raw ?? '')).replace(/[\s\u200c\u200e\u200f\-\u2010-\u2015_]/g, '')
  return /^[0-9]{8}$/.test(value) ? value : null
}
export const formatOneTimeCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

function derive(code: string, salt: string): Buffer {
  return scryptSync(code, Buffer.from(salt, 'hex'), 32)
}
function sameHash(a: Buffer, hex: string): boolean {
  const b = Buffer.from(hex, 'hex')
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b)
}

function validSection(value: unknown): value is CodeSectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  if (Object.keys(s).sort().join(',') !== 'createdAt,rows,salt') return false
  if (typeof s.salt !== 'string' || s.salt.length !== 32 || !HEX.test(s.salt) || !Number.isSafeInteger(s.createdAt)) return false
  if (!Array.isArray(s.rows) || s.rows.length !== CODES_PER_SECTION) return false
  return s.rows.every((r: unknown, i: number) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    const row = r as Record<string, unknown>
    return Object.keys(row).sort().join(',') === 'hash,n,usedAt' && row.n === i + 1 &&
      typeof row.hash === 'string' && row.hash.length === 64 && HEX.test(row.hash) &&
      (row.usedAt === null || (Number.isSafeInteger(row.usedAt) && (row.usedAt as number) > 0))
  })
}

/** پارسر سخت‌گیر؛ هر ناسازگاری ⇒ null (یعنی «خراب»: همهٔ کدها باطل). */
export function parseOneTimeCodes(raw: string): CodesState | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (Object.keys(value).sort().join(',') !== 'fails,lockedUntil,sections,version' || value.version !== 1) return null
    if (!Number.isSafeInteger(value.fails) || (value.fails as number) < 0 || (value.fails as number) >= CODE_MAX_FAILS) return null
    if (!Number.isSafeInteger(value.lockedUntil) || (value.lockedUntil as number) < 0) return null
    const sections = value.sections as Record<string, unknown>
    if (!sections || typeof sections !== 'object' || Array.isArray(sections) || Object.keys(sections).sort().join(',') !== 'other,sensitive') return null
    for (const key of CODE_SECTIONS) if (sections[key] !== null && !validSection(sections[key])) return null
    return {
      sections: { sensitive: sections.sensitive as CodeSectionState | null, other: sections.other as CodeSectionState | null },
      fails: value.fails as number, lockedUntil: value.lockedUntil as number
    }
  } catch {
    return null
  }
}

function load(dir?: string): Loaded {
  const path = join(directory(dir), ONE_TIME_CODES_FILE)
  if (cache && cache.path === path) return cache
  let loaded: Loaded
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 64 * 1024) loaded = { path, state: null, broken: true, brokenNoticed: false }
    else {
      const state = parseOneTimeCodes(readFileSync(path, 'utf8'))
      loaded = state ? { path, state, broken: false, brokenNoticed: false } : { path, state: null, broken: true, brokenNoticed: false }
    }
  } catch (error) {
    loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { path, state: emptyState(), broken: false, brokenNoticed: false }
      : { path, state: null, broken: true, brokenNoticed: false }
  }
  cache = loaded
  return loaded
}

/** نوشتن اتمی (پروندهٔ موقت + fsync + rename)؛ خطا به صداکننده برمی‌گردد. */
function writeAtomic(path: string, state: CodesState): void {
  const body = JSON.stringify({ version: 1, sections: state.sections, fails: state.fails, lockedUntil: state.lockedUntil }) + '\n'
  const tmp = `${path}.${process.pid}.tmp`
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

/** فقط آزمون: فراموش کردن حافظه (مثل شروع دوبارهٔ برنامه). */
export function resetOneTimeCodesCacheForTests(): void {
  cache = null
}

function lockLeft(state: CodesState): number {
  const t = wallClock()
  if (state.lockedUntil <= t) return 0
  // ساعتِ عقب‌کشیده قفل را بیش از ۱۵ دقیقه نگه نمی‌دارد.
  if (state.lockedUntil - t > CODE_LOCK_MS) state.lockedUntil = t + CODE_LOCK_MS
  return state.lockedUntil - t
}

export interface CodesStatus {
  broken: boolean
  lockedMs: number
  sections: Record<CodeSection, { total: number; remaining: number; createdAt: number } | null>
}
export function oneTimeCodesStatus(dir?: string): CodesStatus {
  const l = load(dir)
  if (!l.state) return { broken: true, lockedMs: 0, sections: { sensitive: null, other: null } }
  const section = (s: CodeSectionState | null) => s ? { total: s.rows.length, remaining: s.rows.filter((r) => r.usedAt === null).length, createdAt: s.createdAt } : null
  return { broken: false, lockedMs: lockLeft(l.state), sections: { sensitive: section(l.state.sections.sensitive), other: section(l.state.sections.other) } }
}

/** «همه یک رقم» یا «پشت‌سرهم» (مثل ۱۲۳۴۵۶۷۸ یا ۸۷۶۵۴۳۲۱). */
export function weakOneTimeCode(code: string): boolean {
  if (/^(\d)\1{7}$/.test(code)) return true
  const d = [...code].map(Number)
  const step = d[1] - d[0]
  return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)
}

/**
 * پنج کد تازهٔ یک قسمت (پیش از ثبت): تصادفی، یا «خودم می‌نویسم» با قاعده‌های ۲۵-۱۰. قاعدهٔ «برابر رمز مدیر یا
 * رمز دوم و سوم نباشد» را لایهٔ IPC با AuthService می‌سنجد (ناهم‌زمان). خطا ⇒ پیام فارسی.
 */
export function prepareOneTimeCodes(mode: unknown, own: unknown): string[] {
  if (mode === 'own') {
    if (!Array.isArray(own) || own.length !== CODES_PER_SECTION) throw new Error(`دقیقاً ${CODES_PER_SECTION} کد بنویسید.`)
    const codes: string[] = []
    own.forEach((raw, i) => {
      const code = normalizeOneTimeCode(raw)
      const label = `کد شمارهٔ ${'۱۲۳۴۵'[i]}`
      if (!code) throw new Error(`${label} باید دقیقاً ۸ رقم باشد.`)
      if (weakOneTimeCode(code)) throw new Error(`${label} ساده است (همه یک رقم یا پشت‌سرهم)؛ کد دیگری بنویسید.`)
      if (codes.includes(code)) throw new Error(`${label} تکراری است.`)
      codes.push(code)
    })
    return codes
  }
  if (mode !== 'random') throw new Error('روش ساخت کد نامعتبر است.')
  const codes: string[] = []
  while (codes.length < CODES_PER_SECTION) {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    if (!weakOneTimeCode(code) && !codes.includes(code)) codes.push(code)
  }
  return codes
}

/** کدهای فعال قسمت دیگر را که با یکی از این کدها برابرند پیدا می‌کند (برای رد تکراری). */
function clashesWithOther(state: CodesState, section: CodeSection, codes: string[]): boolean {
  const other = state.sections[section === 'sensitive' ? 'other' : 'sensitive']
  if (!other) return false
  const live = other.rows.filter((r) => r.usedAt === null)
  return codes.some((code) => { const h = derive(code, other.salt); return live.some((r) => sameHash(h, r.hash)) })
}

/**
 * ثبت پنج کد تازهٔ یک قسمت (کدهای قبلی همان قسمت باطل می‌شوند). پروندهٔ خراب جایگزین می‌شود.
 * `random` برای کد تصادفی: اگر با کد فعال قسمت دیگر برابر شد، دوباره ساخته می‌شود.
 * خروجی: کدهای خام شماره‌دار، فقط برای همین یک بار نمایش.
 */
export function commitOneTimeCodes(section: CodeSection, codes: string[], opts: { dir?: string; random?: boolean } = {}): Array<{ n: number; code: string }> {
  if (!CODE_SECTIONS.includes(section)) throw new Error('قسمت کد نامعتبر است.')
  const l = load(opts.dir)
  const base: CodesState = l.state ? JSON.parse(JSON.stringify(l.state)) as CodesState : emptyState()
  let list = [...codes]
  for (let round = 0; clashesWithOther(base, section, list); round++) {
    if (!opts.random || round > 20) throw new Error('یکی از کدها با کدهای فعال قسمت دیگر برابر است؛ کد دیگری بنویسید.')
    list = prepareOneTimeCodes('random', null)
  }
  if (list.length !== CODES_PER_SECTION || list.some((c) => !normalizeOneTimeCode(c))) throw new Error('کدها نامعتبرند.')
  const salt = randomBytes(16).toString('hex')
  base.sections[section] = {
    salt, createdAt: wallClock(),
    rows: list.map((code, i) => ({ n: i + 1, hash: derive(code, salt).toString('hex'), usedAt: null }))
  }
  writeAtomic(l.path, base)
  cache = { path: l.path, state: base, broken: false, brokenNoticed: false }
  return list.map((code, i) => ({ n: i + 1, code: formatOneTimeCode(code) }))
}

/** «باطل کردن کدهای این قسمت». */
export function revokeOneTimeCodes(section: CodeSection, dir?: string): void {
  if (!CODE_SECTIONS.includes(section)) throw new Error('قسمت کد نامعتبر است.')
  const l = load(dir)
  const base: CodesState = l.state ? JSON.parse(JSON.stringify(l.state)) as CodesState : emptyState()
  base.sections[section] = null
  writeAtomic(l.path, base)
  cache = { path: l.path, state: base, broken: false, brokenNoticed: false }
}

/** «برداشتن قفل کدها» (مدیر، با رمز تایپی). خروجی: آیا قفل یا شمارش اشتباهی بود؟ */
export function clearOneTimeCodeLock(dir?: string): boolean {
  const l = load(dir)
  if (!l.state) return false
  const had = l.state.fails > 0 || lockLeft(l.state) > 0
  if (!had) return false
  const next = { ...l.state, fails: 0, lockedUntil: 0 }
  writeAtomic(l.path, next)
  cache = { ...l, state: next }
  return true
}

export type ConsumeResult =
  | { ok: true; n: number }
  | { ok: false; reason: 'LOCKED'; lockedMs: number }
  | { ok: false; reason: 'WRONG'; justLocked: boolean; failsLeft: number }
  | { ok: false; reason: 'BROKEN'; firstNotice: boolean }

/**
 * مصرف همگام یک کد برای یک قسمت. کدِ قسمت دیگر اینجا «اشتباه» است (مصرف نمی‌شود و شمرده می‌شود).
 * شکست نوشتن: کد در حافظه مصرف‌شده می‌ماند (همان اجرا دوباره نمی‌پذیرد).
 */
export function consumeOneTimeCode(section: CodeSection, raw: unknown, dir?: string): ConsumeResult {
  const l = load(dir)
  if (!l.state) {
    const firstNotice = !l.brokenNoticed
    l.brokenNoticed = true
    return { ok: false, reason: 'BROKEN', firstNotice }
  }
  const state = l.state
  const left = lockLeft(state)
  if (left > 0) return { ok: false, reason: 'LOCKED', lockedMs: left }
  const code = normalizeOneTimeCode(raw)
  const target = CODE_SECTIONS.includes(section) ? state.sections[section] : null
  let hit: CodeRow | null = null
  if (code && target) {
    const h = derive(code, target.salt)
    hit = target.rows.find((r) => r.usedAt === null && sameHash(h, r.hash)) ?? null
  }
  if (!hit) {
    state.fails += 1
    let justLocked = false
    if (state.fails >= CODE_MAX_FAILS) { state.fails = 0; state.lockedUntil = wallClock() + CODE_LOCK_MS; justLocked = true }
    try { writeAtomic(l.path, state) } catch {}
    return { ok: false, reason: 'WRONG', justLocked, failsLeft: justLocked ? 0 : CODE_MAX_FAILS - state.fails }
  }
  hit.usedAt = wallClock()
  state.fails = 0
  try { writeAtomic(l.path, state) } catch {}
  return { ok: true, n: hit.n }
}

/**
 * برگرداندن کدی که همین حالا مصرف شد ولی نشست یا بلیتش ساخته نشد (همگام، بی فاصله با مصرف). فقط همان ردیف.
 */
export function restoreOneTimeCode(section: CodeSection, n: number, dir?: string): void {
  const l = load(dir)
  const row = l.state?.sections[section]?.rows.find((r) => r.n === n)
  if (!l.state || !row) return
  row.usedAt = null
  try { writeAtomic(l.path, l.state) } catch {}
}
