/**
 * طرح ۱۴۰۵ §۳-۱۶ (مورد ۱۴-ب و ۲۵-۱۰) — مجوز زمان‌بندی‌شده.
 *
 * - پرونده: `userData/scheduled-grants.json`، اتمی، بیرون از پایگاه داده؛ بازگردانی بکاپ زنده‌اش نمی‌کند.
 * - ساخت و لغو در صفحهٔ «کنترل از راه دور» با رمز تایپی مدیر (لایهٔ IPC، «کلیدسازی»). فقط کلیدهای قسمت (عادی،
 *   پولی و تازه)، نه کارها؛ بازه حداکثر ۶۰ دقیقه؛ امروز تا ۷ روز بعد؛ حداکثر ۱۰ مجوز فعال؛ یک بار (بی تکرار).
 * - ساعت: ساعت رسمی برنامه (افست «تاریخ و ساعت رسمی»). زمان‌بند هر ۳۰ ثانیه و سر مرزها بیدار می‌شود.
 * - جهش ساعت: هر دور، فاصلهٔ `Date.now` با ساعت یکنواخت سنجیده می‌شود؛ بیش از ۲ دقیقه ⇒ همهٔ مجوزهای
 *   زمان‌بندی‌شده لغو و ⚠️ «ساعت سیستم عوض شد». بیدار شدن رایانه (`resume`) مبنا را از نو می‌گیرد و لغو نمی‌کند.
 * - باز شدن: سر ساعت شروع، برای هر پنجرهٔ برنامه یک نشست نگهبان‌دار تا ساعت پایان (بی بی‌کاری). پنجرهٔ تازه در
 *   همان بازه، در دور بعدی ۳۰ ثانیه‌ای همان را می‌گیرد؛ پنجره‌ای که همان قسمت را از قبل باز دارد، پس از بسته شدن
 *   آن نشست. خبر صریح می‌گوید «برای همهٔ پنجره‌های برنامه».
 * - P1 و «بستن همه» مجوز باز را می‌بندند (دوباره باز نمی‌شود)؛ P2 مجوزهای آینده را هم لغو می‌کند.
 * وابستگی‌ها (ساعت‌ها، فهرست پنجره‌ها، افست رسمی، ثبت رویداد) تزریقی‌اند تا آزمون با ساعت ساختگی اجرا شود.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app } from 'electron'
import { isValidJalaliDate, jalaliAddDays, jalaliAtClock, toJalaliDate, toLatinDigits } from '@shared/jalali'
import { LOCKED_PANELS, normalizePanelKey, panelTitle } from '@shared/panels'
import type { AccessEventKind } from '@shared/gateCatalog'
import type { AccessEventFields } from './accessEvents'
import { closeGuardedParts, guardedEntryFor, openGuardedPart } from './unlocks'

export type ScheduledState = 'PENDING' | 'OPEN' | 'DONE' | 'CANCELED'
export interface ScheduledGrant {
  id: string
  panel: string
  /** لحظهٔ واقعی (ms از ۱۹۷۰)؛ از ساعت رسمی تبدیل شده است */
  startAt: number
  endAt: number
  note: string
  createdAt: number
  state: ScheduledState
  /** برچسب ثابت پایان (مثل «لغو به دست مدیر»، «ساعت سیستم عوض شد») */
  reason: string | null
}

export const SCHEDULED_GRANTS_FILE = 'scheduled-grants.json'
export const SCHEDULED_MAX_ACTIVE = 10
export const SCHEDULED_MAX_SPAN_MS = 60 * 60_000
export const SCHEDULED_MAX_DAYS_AHEAD = 7
export const SCHEDULED_TICK_MS = 30_000
export const CLOCK_JUMP_MS = 2 * 60_000

export interface SchedulerDeps {
  dir?: string
  /** ساعت دیواری (Date.now) */
  now?: () => number
  /** ساعت یکنواخت (performance.now) */
  mono?: () => number
  /** افست «ساعت رسمی» به دقیقه */
  offsetMinutes?: () => number | Promise<number>
  /** شناسهٔ همهٔ پنجره‌های زندهٔ برنامه (`webContents.id`) */
  windows?: () => number[]
  event?: (kind: AccessEventKind, fields: AccessEventFields) => void
  /** در برنامه true؛ آزمون‌ها `tick` را خودشان صدا می‌زنند */
  schedule?: boolean
}

const VALID_ID = /^[a-f0-9]{12}$/
let deps: Required<Omit<SchedulerDeps, 'dir' | 'schedule'>> & Pick<SchedulerDeps, 'dir' | 'schedule'> = {
  now: () => Date.now(), mono: () => performance.now(), offsetMinutes: () => 0, windows: () => [], event: () => {}
}
let grants: ScheduledGrant[] | null = null
let loadedFrom: string | null = null
let base: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function directory(): string {
  return typeof deps.dir === 'string' && deps.dir ? deps.dir : app.getPath('userData')
}
const filePath = () => join(directory(), SCHEDULED_GRANTS_FILE)

function validGrant(v: unknown): v is ScheduledGrant {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const g = v as Record<string, unknown>
  return Object.keys(g).sort().join(',') === 'createdAt,endAt,id,note,panel,reason,startAt,state' &&
    typeof g.id === 'string' && VALID_ID.test(g.id) && typeof g.panel === 'string' && isPartKey(g.panel) &&
    Number.isSafeInteger(g.startAt) && Number.isSafeInteger(g.endAt) && (g.endAt as number) > (g.startAt as number) &&
    (g.endAt as number) - (g.startAt as number) <= SCHEDULED_MAX_SPAN_MS && Number.isSafeInteger(g.createdAt) &&
    typeof g.note === 'string' && g.note.length <= 120 && ['PENDING', 'OPEN', 'DONE', 'CANCELED'].includes(g.state as string) &&
    (g.reason === null || (typeof g.reason === 'string' && g.reason.length <= 60))
}

/** پارسر سخت‌گیر؛ پروندهٔ خراب ⇒ هیچ مجوزی (هرگز «باز»). */
export function parseScheduledGrants(raw: string): ScheduledGrant[] | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'grants,version' || value.version !== 1) return null
    if (!Array.isArray(value.grants) || value.grants.length > 200 || !value.grants.every(validGrant)) return null
    return (value.grants as ScheduledGrant[]).map((g) => ({ ...g }))
  } catch {
    return null
  }
}

function load(): ScheduledGrant[] {
  const path = filePath()
  if (grants && loadedFrom === path) return grants
  loadedFrom = path
  try {
    const stat = lstatSync(path)
    grants = stat.isFile() && stat.size <= 256 * 1024 ? parseScheduledGrants(readFileSync(path, 'utf8')) ?? [] : []
  } catch {
    grants = []
  }
  return grants
}

function persist(list: ScheduledGrant[]): void {
  // فقط ۲۰۰ ردیف آخر؛ مجوزهای فعال هرگز کنار نمی‌روند.
  const active = list.filter((g) => g.state === 'PENDING' || g.state === 'OPEN')
  const done = list.filter((g) => g.state !== 'PENDING' && g.state !== 'OPEN').slice(-(200 - active.length))
  const next = [...done, ...active].sort((a, b) => a.createdAt - b.createdAt)
  const path = filePath(), tmp = `${path}.${process.pid}.tmp`
  const body = JSON.stringify({ version: 1, grants: next }, null, 2) + '\n'
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
  grants = next
}

function isPartKey(panel: string): boolean {
  const key = normalizePanelKey(panel)
  return !!key && LOCKED_PANELS.some((p) => p.key === key && p.kind === 'part')
}

async function offsetMs(): Promise<number> {
  let minutes = 0
  try { minutes = Number(await deps.offsetMinutes()) } catch { minutes = 0 }
  return Number.isFinite(minutes) ? Math.round(minutes) * 60_000 : 0
}

const p2 = (n: number) => String(n).padStart(2, '0')
/** برچسب ثابت بازه به ساعت رسمی، مثل «16:00 تا 17:00 · 1405/09/02» (برای ردیف رویداد و صفحه). */
function spanLabel(g: ScheduledGrant, offset: number): string {
  const a = new Date(g.startAt + offset), b = new Date(g.endAt + offset)
  return `${p2(a.getHours())}:${p2(a.getMinutes())} تا ${p2(b.getHours())}:${p2(b.getMinutes())} · ${toJalaliDate(a)}`
}
const note = (kind: AccessEventKind, g: ScheduledGrant, decision: string) => {
  try { deps.event(kind, { titleFa: panelTitle(g.panel), decision }) } catch {}
}

/** «HH:mm» ساعت رسمی ⇒ شکل استاندارد، یا null. */
function clockOf(raw: unknown): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(toLatinDigits(String(raw ?? '')).trim())
  return m ? `${p2(Number(m[1]))}:${m[2]}` : null
}

export interface ScheduledInput { panel?: unknown; day?: unknown; start?: unknown; end?: unknown; note?: unknown }

/** ساخت یک مجوز زمان‌بندی‌شده (رمز مدیر را لایهٔ IPC سنجیده است). خطا ⇒ پیام فارسی. */
export async function createScheduledGrant(input: ScheduledInput): Promise<ScheduledGrant> {
  const key = normalizePanelKey(input.panel)
  if (!key) throw new Error('یک قسمت قفل‌دار انتخاب کنید.')
  if (!isPartKey(key)) throw new Error('مجوز زمان‌بندی‌شده فقط برای «قسمت»هاست، نه «قفل کار».')
  const day = toLatinDigits(String(input.day ?? '')).trim()
  if (!isValidJalaliDate(day)) throw new Error('روز را به شکل ۱۴۰۵/۰۹/۰۲ بنویسید.')
  const start = clockOf(input.start), end = clockOf(input.end)
  if (!start || !end) throw new Error('ساعت شروع و پایان را به شکل ۱۶:۰۰ بنویسید.')
  const offset = await offsetMs()
  const now = deps.now()
  const today = toJalaliDate(new Date(now + offset))
  if (day < today || day > jalaliAddDays(today, SCHEDULED_MAX_DAYS_AHEAD)) throw new Error('روز باید از امروز تا ۷ روز بعد باشد.')
  const startAt = jalaliAtClock(day, start).getTime() - offset
  const endAt = jalaliAtClock(day, end).getTime() - offset
  if (endAt <= startAt) throw new Error('ساعت پایان باید بعد از ساعت شروع (در همان روز) باشد.')
  if (endAt - startAt > SCHEDULED_MAX_SPAN_MS) throw new Error('بازهٔ مجوز زمان‌بندی‌شده حداکثر ۶۰ دقیقه است.')
  if (endAt <= now) throw new Error('این بازه گذشته است.')
  const list = load()
  if (list.filter((g) => g.state === 'PENDING' || g.state === 'OPEN').length >= SCHEDULED_MAX_ACTIVE) throw new Error('حداکثر ۱۰ مجوز زمان‌بندی‌شدهٔ فعال می‌شود داشت.')
  const text = String(input.note ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)
  const grant: ScheduledGrant = { id: randomBytes(6).toString('hex'), panel: key, startAt, endAt, note: text, createdAt: now, state: 'PENDING', reason: null }
  persist([...list, grant])
  note('SCHEDULED_GRANT_CREATED', grant, spanLabel(grant, offset))
  void tick().catch(() => undefined)
  return { ...grant }
}

function finish(g: ScheduledGrant, state: 'DONE' | 'CANCELED', reason: string): void {
  const wasOpen = g.state === 'OPEN'
  g.state = state
  g.reason = reason
  if (wasOpen) closeGuardedParts({ source: 'SCHEDULED', grantId: g.id })
}

/** لغو یک مجوز (مدیر). مجوز باز همان لحظه بسته می‌شود. */
export async function cancelScheduledGrant(id: unknown): Promise<void> {
  const list = load()
  const g = list.find((x) => x.id === id && (x.state === 'PENDING' || x.state === 'OPEN'))
  if (!g) throw new Error('این مجوز زمان‌بندی‌شده پیدا نشد یا دیگر فعال نیست.')
  finish(g, 'CANCELED', 'لغو به دست مدیر')
  persist(list)
  note('SCHEDULED_GRANT_CANCELED', g, 'لغو به دست مدیر')
}

/**
 * P1 و «بستن همه»: مجوزهای باز بسته می‌شوند و دوباره باز نمی‌شوند؛ با `cancelFuture` (P2) آینده‌ها هم لغو.
 * خروجی: شمار مجوزهای بسته یا لغوشده. شکست نوشتن پرونده جلوی بستن نشست‌ها را نمی‌گیرد.
 */
export function closeScheduledGrants(options: { cancelFuture?: boolean; reason?: string } = {}): number {
  const list = load()
  let changed = 0
  for (const g of list) {
    if (g.state === 'OPEN') { finish(g, 'DONE', options.reason ?? 'بستن همه'); note('SCHEDULED_GRANT_CLOSED', g, options.reason ?? 'بستن همه'); changed++ }
    else if (g.state === 'PENDING' && options.cancelFuture) { finish(g, 'CANCELED', options.reason ?? 'توقف اضطراری کامل'); note('SCHEDULED_GRANT_CANCELED', g, options.reason ?? 'توقف اضطراری کامل'); changed++ }
  }
  closeGuardedParts({ source: 'SCHEDULED' })
  if (changed) try { persist(list) } catch {}
  return changed
}

/** صفحهٔ «کنترل از راه دور»: فهرست مجوزها (تازه‌ترین بالا) با برچسب بازه به ساعت رسمی. */
export async function listScheduledGrants(): Promise<{ offsetMinutes: number; grants: Array<ScheduledGrant & { titleFa: string; span: string }> }> {
  const offset = await offsetMs()
  const list = load()
  return {
    offsetMinutes: offset / 60_000,
    grants: [...list].sort((a, b) => b.startAt - a.startAt).slice(0, 50).map((g) => ({ ...g, titleFa: panelTitle(g.panel), span: spanLabel(g, offset) }))
  }
}

/** یک دور زمان‌بند: جهش ساعت، باز و بسته شدن سر ساعت، و نصب برای پنجره‌های تازه. */
export async function tick(): Promise<void> {
  const list = load()
  const now = deps.now(), mono = deps.mono()
  let changed = false
  const drift = now - mono
  if (base === null) base = drift
  else if (Math.abs(drift - base) > CLOCK_JUMP_MS) {
    base = drift
    for (const g of list) {
      if (g.state !== 'PENDING' && g.state !== 'OPEN') continue
      finish(g, 'CANCELED', 'ساعت سیستم عوض شد')
      note('SCHEDULED_GRANT_CANCELED', g, 'ساعت سیستم عوض شد')
      changed = true
    }
  }
  const windows = (() => { try { return deps.windows().filter((w) => Number.isSafeInteger(w) && w > 0) } catch { return [] } })()
  for (const g of list) {
    if (g.state === 'PENDING' && now >= g.endAt) { finish(g, 'DONE', 'اجرا نشد (برنامه بسته بود)'); note('SCHEDULED_GRANT_CLOSED', g, 'اجرا نشد (برنامه بسته بود)'); changed = true; continue }
    if (g.state === 'PENDING' && now >= g.startAt) { g.state = 'OPEN'; changed = true; note('SCHEDULED_GRANT_OPENED', g, 'برای همهٔ پنجره‌های برنامه') }
    if (g.state !== 'OPEN') continue
    if (now >= g.endAt) { finish(g, 'DONE', 'پایان بازه'); note('SCHEDULED_GRANT_CLOSED', g, 'پایان بازه'); changed = true; continue }
    for (const owner of windows) {
      if (guardedEntryFor(owner, g.panel)?.grantId === g.id) continue
      openGuardedPart(owner, g.panel, { source: 'SCHEDULED', method: 'SCHEDULED_GRANT', grantId: g.id, ttlMs: g.endAt - now, idle: false })
    }
  }
  if (changed) try { persist(list) } catch {}
  arm(list, now)
}

function arm(list: ScheduledGrant[], now: number): void {
  if (!running || !deps.schedule) return
  if (timer) clearTimeout(timer)
  const next = list.flatMap((g) => g.state === 'PENDING' ? [g.startAt] : g.state === 'OPEN' ? [g.endAt] : []).filter((t) => t > now)
  const delay = Math.max(1000, Math.min(SCHEDULED_TICK_MS, ...next.map((t) => t - now + 250)))
  timer = setTimeout(() => { timer = null; void tick().catch(() => undefined) }, delay)
  ;(timer as { unref?: () => void }).unref?.()
}

/** بیدار شدن رایانه از خواب: مبنای سنجش ساعت از نو؛ هیچ لغوی رخ نمی‌دهد (§۳-۱۶). */
export function scheduledGrantsResumed(): void {
  base = null
  void tick().catch(() => undefined)
}

/** شروع زمان‌بند (برنامه) یا پیکربندی آزمون. */
export function configureScheduledGrants(next: SchedulerDeps): void {
  deps = { ...deps, ...next } as typeof deps
  grants = null
  loadedFrom = null
  base = null
}
export function startScheduledGrants(next: SchedulerDeps): void {
  configureScheduledGrants({ ...next, schedule: next.schedule ?? true })
  running = true
  void tick().catch(() => undefined)
}
export function stopScheduledGrants(): void {
  running = false
  if (timer) { clearTimeout(timer); timer = null }
}
