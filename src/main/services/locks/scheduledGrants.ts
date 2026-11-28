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
 * وابستگی‌ها (ساعت‌ها، فهرست پنجره‌ها، افست رسمی، ثبت رویداد، حضانت) تزریقی‌اند تا آزمون با ساعت ساختگی اجرا شود.
 *
 * دفتر آزمون ۴-۴۷ (با ۴-۱۳؛ TL-D13):
 * - چند قسمت و چند قفل کار با هم: همهٔ قسمت‌ها و کارهای دستهٔ ۳، جز نُه کار برگشت‌ناپذیر (۴-۳۱)؛ «کلیدسازی» (دستهٔ ۱)
 *   هرگز. قفل کارِ تیک‌خورده در ساعت مجوز برای همهٔ پنجره‌ها هر چند بار باز است (`openScheduledAction`؛ دروازه بی مصرف
 *   بلیت می‌گذارد). قفل‌های داخلی هر قسمت جدا تیک می‌خورند و با قسمت باز نمی‌شوند.
 * - از روز … تا روز … (روز اول امروز تا ۷ روز بعد؛ کل بازه حداکثر ۳۱ روز)، هر روز از ساعت … تا … (حداکثر ۱۰۰۰ دقیقه، در
 *   همان روز). هر روز یک «پنجره» [شروع، پایان] به لحظهٔ واقعی (هنگام ساخت با افست ساعت رسمی همان لحظه). نشست بلندتر از
 *   سقف ۶۰ دقیقه را `unlocks.ts` پیش از سقف بی وقفه تازه می‌کند (۴-۲۸).
 * - «همه» یا یک کارمند: با کارمند، قسمت‌ها و کارها فقط وقتی باز است که صندوق دست همان کارمند باشد (مسئول بخش فعال
 *   حضانت؛ `custody`)؛ حضانت خاموش ⇒ فقط «همه». در پنجرهٔ بازِ مجوز کارمندی سنجش هر ۵ ثانیه است.
 * - «بستن همه» و P1 فقط پنجرهٔ بازِ همان روز را می‌بندند و روزهای بعد طبق برنامه باز می‌شوند؛ P2 همه را لغو می‌کند.
 * - هر برنامهٔ چندروزه یک مجوز فعال حساب می‌شود. پروندهٔ قدیمی (نسخهٔ ۱، ردیف یک‌قسمتی) همچنان خوانده می‌شود؛ نوشتن با
 *   نسخهٔ ۲ (برنامهٔ قدیمی پروندهٔ تازه را «خراب» می‌داند و هیچ مجوزی را باز نمی‌کند).
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app } from 'electron'
import { faDigits, isValidJalaliDate, jalaliAddDays, jalaliAtClock, toJalaliDate, toLatinDigits } from '@shared/jalali'
import { LOCKED_PANELS, normalizePanelKey, panelTitle } from '@shared/panels'
import { GATE_CATALOG, GATE_IRREVERSIBLE_ACTIONS, type AccessEventKind, type GateCatalogEntry } from '@shared/gateCatalog'
import type { AccessEventFields } from './accessEvents'
import { closeGuardedParts, guardedEntryFor, openGuardedPart, openScheduledAction } from './unlocks'

export type ScheduledState = 'PENDING' | 'OPEN' | 'DONE' | 'CANCELED'
export interface ScheduledGrant {
  id: string
  /** ۴-۴۷: کلیدهای قسمت و شناسه‌های کار (یک یا چند) */
  panels: string[]
  /** شروع نخستین پنجره و پایان واپسین پنجره: لحظهٔ واقعی (ms از ۱۹۷۰)؛ از ساعت رسمی تبدیل شده است */
  startAt: number
  endAt: number
  /** ۴-۴۷: پنجره‌های روزانه [شروع، پایان]، به ترتیب و بی هم‌پوشانی (۱ تا ۳۱) */
  windows: Array<[number, number]>
  /** ۴-۴۷: null یعنی «همه»؛ وگرنه کارمندی که صندوق باید دست او باشد */
  userId: number | null
  userName: string | null
  note: string
  createdAt: number
  state: ScheduledState
  /** برچسب ثابت پایان (مثل «لغو به دست مدیر»، «ساعت سیستم عوض شد») */
  reason: string | null
  /** ۴-۴۷: «بستن همه» پنجرهٔ همان روز را بست؛ پنجره‌ای که تا این لحظه تمام می‌شود دوباره باز نمی‌شود */
  closedUntil: number | null
  /** ۴-۴۷: شروع پنجره‌ای که مجوز برایش «باز» است؛ پنجرهٔ دیگر یعنی روز تازه (خبر دوباره، نشست‌های روز قبل پاک) */
  openedFor: number | null
}
export interface CustodyNow { enabled: boolean; holder: number | null }
export interface StaffMember { id: number; name: string }

export const SCHEDULED_GRANTS_FILE = 'scheduled-grants.json'
export const SCHEDULED_MAX_ACTIVE = 10
/** دفتر آزمون ۴-۱۳ در ۴-۴۷: پنجرهٔ روزانه تا ۱۰۰۰ دقیقه (پیش‌تر ۶۰)؛ پروندهٔ ذخیره هم با همین سنجیده می‌شود. */
export const SCHEDULED_MAX_SPAN_MS = 1000 * 60_000
export const SCHEDULED_MAX_DAYS_AHEAD = 7
/** ۴-۴۷: از روز اول تا روز آخر حداکثر ۳۱ روز */
export const SCHEDULED_MAX_DAYS = 31
export const SCHEDULED_TICK_MS = 30_000
/** ۴-۴۷: سنجش مسئول صندوق در پنجرهٔ بازِ مجوز کارمندی */
export const SCHEDULED_CUSTODY_TICK_MS = 5_000
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
  /** ۴-۴۷: حضانت روشن است و صندوق دست کیست (مسئول بخش فعال)؛ نبود یا خطا ⇒ خاموش */
  custody?: () => CustodyNow | Promise<CustodyNow>
  /** ۴-۴۷: کارمندان فعال برای انتخاب */
  staff?: () => StaffMember[] | Promise<StaffMember[]>
  /** در برنامه true؛ آزمون‌ها `tick` را خودشان صدا می‌زنند */
  schedule?: boolean
}

const VALID_ID = /^[a-f0-9]{12}$/
let deps: Required<Omit<SchedulerDeps, 'dir' | 'schedule'>> & Pick<SchedulerDeps, 'dir' | 'schedule'> = {
  now: () => Date.now(), mono: () => performance.now(), offsetMinutes: () => 0, windows: () => [], event: () => {},
  custody: () => ({ enabled: false, holder: null }), staff: () => []
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

const OLD_KEYS = 'createdAt,endAt,id,note,panel,reason,startAt,state'
const NEW_KEYS = 'closedUntil,createdAt,endAt,id,note,openedFor,panels,reason,startAt,state,userId,userName,windows'
function rowOf(v: unknown, keys: string): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== keys) return null
  const g = v as Record<string, unknown>
  return typeof g.id === 'string' && VALID_ID.test(g.id) && Number.isSafeInteger(g.startAt) && Number.isSafeInteger(g.endAt) &&
    (g.endAt as number) > (g.startAt as number) && Number.isSafeInteger(g.createdAt) && typeof g.note === 'string' && g.note.length <= 120 &&
    ['PENDING', 'OPEN', 'DONE', 'CANCELED'].includes(g.state as string) && (g.reason === null || (typeof g.reason === 'string' && g.reason.length <= 60)) ? g : null
}
/** ردیف قدیمی (نسخهٔ ۱): یک قسمت و یک بازه ⇒ شکل تازه با یک پنجره، برای «همه». */
function oldRow(v: unknown): ScheduledGrant | null {
  const g = rowOf(v, OLD_KEYS)
  if (!g || typeof g.panel !== 'string' || !isPartKey(g.panel) || (g.endAt as number) - (g.startAt as number) > SCHEDULED_MAX_SPAN_MS) return null
  const startAt = g.startAt as number, endAt = g.endAt as number
  return { id: g.id as string, panels: [normalizePanelKey(g.panel) ?? g.panel], startAt, endAt, windows: [[startAt, endAt]], userId: null, userName: null,
    note: g.note as string, createdAt: g.createdAt as number, state: g.state as ScheduledState, reason: g.reason as string | null, closedUntil: null,
    openedFor: g.state === 'OPEN' ? startAt : null }
}
function validWindows(w: unknown): w is Array<[number, number]> {
  if (!Array.isArray(w) || !w.length || w.length > SCHEDULED_MAX_DAYS) return false
  let previous = -Infinity
  for (const pair of w) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1])) return false
    if (pair[1] <= pair[0] || pair[1] - pair[0] > SCHEDULED_MAX_SPAN_MS || pair[0] < previous) return false
    previous = pair[1]
  }
  return true
}
/** ردیف تازه (نسخهٔ ۲؛ ۴-۴۷). */
function newRow(v: unknown): ScheduledGrant | null {
  const g = rowOf(v, NEW_KEYS)
  if (!g || !Array.isArray(g.panels) || !g.panels.length || g.panels.length > 200 || new Set(g.panels).size !== g.panels.length ||
    !g.panels.every((k) => selectable(k) === k) || !validWindows(g.windows)) return null
  const windows = g.windows.map(([a, b]) => [a, b] as [number, number])
  if (windows[0][0] !== g.startAt || windows[windows.length - 1][1] !== g.endAt || ![g.closedUntil, g.openedFor].every((t) => t === null || Number.isSafeInteger(t))) return null
  const userOk = g.userId === null ? g.userName === null
    : Number.isSafeInteger(g.userId) && (g.userId as number) > 0 && typeof g.userName === 'string' && !!g.userName && g.userName.length <= 60
  if (!userOk) return null
  return { id: g.id as string, panels: [...(g.panels as string[])], startAt: g.startAt as number, endAt: g.endAt as number, windows,
    userId: g.userId as number | null, userName: g.userName as string | null, note: g.note as string, createdAt: g.createdAt as number,
    state: g.state as ScheduledState, reason: g.reason as string | null, closedUntil: g.closedUntil as number | null, openedFor: g.openedFor as number | null }
}

/** پارسر سخت‌گیر؛ پروندهٔ خراب ⇒ هیچ مجوزی (هرگز «باز»). نسخهٔ ۱ فقط ردیف قدیمی، نسخهٔ ۲ فقط ردیف تازه. */
export function parseScheduledGrants(raw: string): ScheduledGrant[] | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'grants,version' || (value.version !== 1 && value.version !== 2)) return null
    if (!Array.isArray(value.grants) || value.grants.length > 200) return null
    const read = value.version === 1 ? oldRow : newRow
    const out: ScheduledGrant[] = []
    for (const row of value.grants) {
      const g = read(row)
      if (!g) return null
      out.push(g)
    }
    return out
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
  const body = JSON.stringify({ version: 2, grants: next }, null, 2) + '\n'
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
const catalogEntry = (raw: unknown): GateCatalogEntry | null =>
  typeof raw === 'string' && Object.prototype.hasOwnProperty.call(GATE_CATALOG, raw) ? GATE_CATALOG[raw] : null
/** ۴-۴۷: کلید قابل انتخاب (قسمت، یا کار دستهٔ ۳ جز نُه کار برگشت‌ناپذیر)، به شکل استاندارد؛ وگرنه null. */
function selectable(raw: unknown): string | null {
  const part = typeof raw === 'string' ? normalizePanelKey(raw) : null
  if (part && isPartKey(part)) return part
  const entry = catalogEntry(raw)
  return entry && entry.category === 3 && !GATE_IRREVERSIBLE_ACTIONS.includes(entry.id) ? entry.id : null
}
const titleOf = (key: string) => catalogEntry(key)?.titleFa ?? panelTitle(key)
/** نام قسمت‌ها و کارها برای ردیف رویداد (تا حدود ۷۰ نویسه؛ بقیه «و n مورد دیگر»). */
function titlesLabel(g: ScheduledGrant): string {
  const titles = g.panels.map(titleOf)
  let out = titles[0] ?? ''
  for (let i = 1; i < titles.length; i++) {
    if (out.length + titles[i].length + 2 > 64) return `${out} و ${faDigits(titles.length - i)} مورد دیگر`
    out = `${out}، ${titles[i]}`
  }
  return out
}

async function offsetMs(): Promise<number> {
  let minutes = 0
  try { minutes = Number(await deps.offsetMinutes()) } catch { minutes = 0 }
  return Number.isFinite(minutes) ? Math.round(minutes) * 60_000 : 0
}

const p2 = (n: number) => String(n).padStart(2, '0')
/**
 * برچسب ثابت بازه به ساعت رسمی (برای ردیف رویداد و صفحه؛ حداکثر ۴۰ نویسه): یک روز «16:00 تا 17:00 · 1405/09/02»؛
 * چند روز (۴-۴۷) «16:00 تا 17:00 · 1405/09/02 تا 09/05» (ساعت روزانه، روز اول و روز آخر).
 */
function spanLabel(g: ScheduledGrant, offset: number): string {
  const [s0, e0] = g.windows[0], last = g.windows[g.windows.length - 1]
  const a = new Date(s0 + offset), b = new Date(e0 + offset)
  const clock = `${p2(a.getHours())}:${p2(a.getMinutes())} تا ${p2(b.getHours())}:${p2(b.getMinutes())}`
  const first = toJalaliDate(a)
  if (g.windows.length === 1) return `${clock} · ${first}`
  const lastDay = toJalaliDate(new Date(last[0] + offset))
  return `${clock} · ${lastDay.slice(0, 4) === first.slice(0, 4) ? `${first} تا ${lastDay.slice(5)}` : `${first.slice(5)} تا ${lastDay}`}`
}
const note = (kind: AccessEventKind, g: ScheduledGrant, decision: string, extra: AccessEventFields = {}) => {
  try { deps.event(kind, { titleFa: titlesLabel(g), decision, ...(g.userName ? { recipientName: g.userName } : {}), ...extra }) } catch {}
}
/** پنجرهٔ امروزِ باز (شروع ≤ اکنون < پایان) که «بستن همه» نبسته است؛ وگرنه null. */
function currentWindow(g: ScheduledGrant, now: number): { start: number; end: number } | null {
  for (const [start, end] of g.windows) if (start <= now && now < end && !(g.closedUntil !== null && g.closedUntil >= end)) return { start, end }
  return null
}
async function custodyNow(): Promise<CustodyNow> {
  try {
    const c = await deps.custody()
    const enabled = c?.enabled === true
    return { enabled, holder: enabled && Number.isSafeInteger(c.holder) && (c.holder as number) > 0 ? c.holder as number : null }
  } catch {
    return { enabled: false, holder: null }
  }
}
async function staffList(): Promise<StaffMember[]> {
  try {
    const rows = await deps.staff()
    return Array.isArray(rows) ? rows.filter((r) => r && Number.isSafeInteger(r.id) && r.id > 0 && typeof r.name === 'string').map((r) => ({ id: r.id, name: r.name.slice(0, 60) })) : []
  } catch {
    return []
  }
}

/** «HH:mm» ساعت رسمی ⇒ شکل استاندارد، یا null. */
function clockOf(raw: unknown): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(toLatinDigits(String(raw ?? '')).trim())
  return m ? `${p2(Number(m[1]))}:${m[2]}` : null
}

export interface ScheduledInput {
  /** شکل امروز: یک قسمت و یک روز؛ ۴-۴۷: `panels` (چند قسمت و کار) و `fromDay`/`toDay` */
  panel?: unknown; panels?: unknown; day?: unknown; fromDay?: unknown; toDay?: unknown
  start?: unknown; end?: unknown; userId?: unknown; note?: unknown
}
const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))

/** ساخت یک مجوز زمان‌بندی‌شده (رمز مدیر را لایهٔ IPC سنجیده است). خطا ⇒ پیام فارسی. */
export async function createScheduledGrant(input: ScheduledInput): Promise<ScheduledGrant> {
  const raw = Array.isArray(input.panels) ? input.panels : input.panel === undefined || input.panel === null || input.panel === '' ? [] : [input.panel]
  if (!raw.length) throw new Error('دست‌کم یک قسمت یا قفل کارِ قفل‌دار انتخاب کنید.')
  if (raw.length > 200) throw new Error('فهرست انتخاب‌ها بیش از اندازه است.')
  const panels: string[] = []
  for (const item of raw) {
    const key = selectable(item)
    if (!key) {
      const entry = catalogEntry(item)
      if (entry?.category === 1) throw new Error('«کلیدسازی» هرگز در مجوز زمان‌بندی‌شده نمی‌آید.')
      if (entry && GATE_IRREVERSIBLE_ACTIONS.includes(entry.id)) throw new Error(`«${entry.titleFa}» برگشت‌ناپذیر است و در مجوز زمان‌بندی‌شده نمی‌آید.`)
      throw new Error('این مورد در فهرست مجوز زمان‌بندی‌شده نیست؛ یک قسمت یا قفل کارِ قفل‌دار انتخاب کنید.')
    }
    if (!panels.includes(key)) panels.push(key)
  }
  const fromDay = toLatinDigits(String(input.fromDay ?? input.day ?? '')).trim()
  const toDay = toLatinDigits(String(input.toDay ?? input.fromDay ?? input.day ?? '')).trim()
  if (!isValidJalaliDate(fromDay) || !isValidJalaliDate(toDay)) throw new Error('روز را به شکل ۱۴۰۵/۰۹/۰۲ بنویسید.')
  const start = clockOf(input.start), end = clockOf(input.end)
  if (!start || !end) throw new Error('ساعت شروع و پایان را به شکل ۱۶:۰۰ بنویسید.')
  const offset = await offsetMs()
  const now = deps.now()
  const today = toJalaliDate(new Date(now + offset))
  if (fromDay < today || fromDay > jalaliAddDays(today, SCHEDULED_MAX_DAYS_AHEAD)) throw new Error('روز اول باید از امروز تا ۷ روز بعد باشد.')
  if (toDay < fromDay || toDay > jalaliAddDays(fromDay, SCHEDULED_MAX_DAYS - 1)) throw new Error('روز آخر باید از روز اول تا حداکثر ۳۱ روز باشد.')
  const span = minutesOf(end) - minutesOf(start)
  if (span <= 0) throw new Error('ساعت پایان باید بعد از ساعت شروع (در همان روز) باشد.')
  if (span * 60_000 > SCHEDULED_MAX_SPAN_MS) throw new Error('ساعت روزانهٔ مجوز زمان‌بندی‌شده حداکثر ۱۰۰۰ دقیقه (۱۶ ساعت و ۴۰ دقیقه) است.')
  const windows: Array<[number, number]> = []
  for (let day = fromDay, i = 0; day <= toDay && i < SCHEDULED_MAX_DAYS; day = jalaliAddDays(day, 1), i++) {
    const s = jalaliAtClock(day, start).getTime() - offset, e = jalaliAtClock(day, end).getTime() - offset
    if (e > now && e > s && e - s <= SCHEDULED_MAX_SPAN_MS) windows.push([s, e])
  }
  if (!windows.length) throw new Error('این بازه گذشته است.')
  let userId: number | null = null, userName: string | null = null
  if (input.userId !== undefined && input.userId !== null && input.userId !== '' && input.userId !== 'all') {
    const id = Number(toLatinDigits(String(input.userId)))
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('کارمند را از فهرست انتخاب کنید.')
    if (!(await custodyNow()).enabled) throw new Error('حضانت صندوق خاموش است؛ مجوز زمان‌بندی‌شده فقط برای «همه» ساخته می‌شود.')
    const person = (await staffList()).find((x) => x.id === id)
    if (!person) throw new Error('این کارمند پیدا نشد یا غیرفعال است.')
    userId = id
    userName = person.name.trim() || `کارمند ${id}`
  }
  const list = load()
  if (list.filter((g) => g.state === 'PENDING' || g.state === 'OPEN').length >= SCHEDULED_MAX_ACTIVE) throw new Error('حداکثر ۱۰ مجوز زمان‌بندی‌شدهٔ فعال می‌شود داشت.')
  const text = String(input.note ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)
  const grant: ScheduledGrant = {
    id: randomBytes(6).toString('hex'), panels, startAt: windows[0][0], endAt: windows[windows.length - 1][1], windows, userId, userName,
    note: text, createdAt: now, state: 'PENDING', reason: null, closedUntil: null, openedFor: null
  }
  persist([...list, grant])
  note('SCHEDULED_GRANT_CREATED', grant, spanLabel(grant, offset), { count: windows.length })
  void tick().catch(() => undefined)
  return { ...grant, panels: [...panels], windows: windows.map(([x, y]) => [x, y]) }
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
  const now = deps.now()
  let changed = 0
  for (const g of list) {
    if (g.state === 'OPEN') {
      const w = currentWindow(g, now), later = g.windows.some(([start]) => start > now)
      if (later && !options.cancelFuture) {
        // ۴-۴۷: فقط پنجرهٔ همان روز؛ روزهای بعد طبق برنامه
        closeGuardedParts({ source: 'SCHEDULED', grantId: g.id })
        g.state = 'PENDING'
        g.openedFor = null
        g.closedUntil = w ? w.end : now
        note('SCHEDULED_GRANT_CLOSED', g, `${options.reason ?? 'بستن همه'}؛ روزهای بعد طبق برنامه`)
      } else if (later) { finish(g, 'CANCELED', options.reason ?? 'توقف اضطراری کامل'); note('SCHEDULED_GRANT_CANCELED', g, options.reason ?? 'توقف اضطراری کامل') }
      else { finish(g, 'DONE', options.reason ?? 'بستن همه'); note('SCHEDULED_GRANT_CLOSED', g, options.reason ?? 'بستن همه') }
      changed++
    }
    else if (g.state === 'PENDING' && options.cancelFuture) { finish(g, 'CANCELED', options.reason ?? 'توقف اضطراری کامل'); note('SCHEDULED_GRANT_CANCELED', g, options.reason ?? 'توقف اضطراری کامل'); changed++ }
  }
  closeGuardedParts({ source: 'SCHEDULED' })
  if (changed) try { persist(list) } catch {}
  return changed
}

/** صفحهٔ «کنترل از راه دور»: فهرست مجوزها (تازه‌ترین بالا) با برچسب بازه به ساعت رسمی؛ ۴-۴۷: حضانت و کارمندان برای انتخاب. */
export async function listScheduledGrants(): Promise<{
  offsetMinutes: number; custody: boolean; staff: StaffMember[]
  grants: Array<ScheduledGrant & { titleFa: string; titles: string[]; span: string; days: number }>
}> {
  const offset = await offsetMs()
  const list = load()
  const custody = await custodyNow()
  return {
    offsetMinutes: offset / 60_000,
    custody: custody.enabled,
    staff: custody.enabled ? await staffList() : [],
    grants: [...list].sort((a, b) => b.startAt - a.startAt).slice(0, 50).map((g) => ({
      ...g, panels: [...g.panels], windows: g.windows.map(([x, y]) => [x, y] as [number, number]),
      titleFa: titlesLabel(g), titles: g.panels.map(titleOf), span: spanLabel(g, offset), days: g.windows.length
    }))
  }
}

/** ۴-۴۷: ساعت پایان پنجره به ساعت رسمی، به دقیقهٔ روز (برای «زمان بستن» در خبر «باز شد»). */
function endClockMinutes(end: number, offset: number): number {
  const d = new Date(end + offset)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * یک دور زمان‌بند: جهش ساعت، باز و بسته شدن سر ساعت، و نصب برای پنجره‌های تازه. ۴-۴۷: هر روز پنجرهٔ همان روز؛
 * پس از پایان پنجره، اگر روز دیگری مانده «در انتظار» و وگرنه «پایان»؛ مجوز کارمندی فقط وقتی صندوق دست همان کارمند است.
 */
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
  const custody = list.some((g) => g.userId !== null && (g.state === 'PENDING' || g.state === 'OPEN') && currentWindow(g, now)) ? await custodyNow() : null
  let offset: number | null = null
  for (const g of list) {
    if (g.state !== 'PENDING' && g.state !== 'OPEN') continue
    const w = currentWindow(g, now)
    if (!w) {
      if (g.state === 'OPEN' && now < g.endAt) {
        closeGuardedParts({ source: 'SCHEDULED', grantId: g.id })
        g.state = 'PENDING'
        g.openedFor = null
        note('SCHEDULED_GRANT_CLOSED', g, 'پایان ساعت امروز؛ روزهای بعد طبق برنامه')
        changed = true
      } else if (g.state === 'OPEN') { finish(g, 'DONE', 'پایان بازه'); note('SCHEDULED_GRANT_CLOSED', g, 'پایان بازه'); changed = true }
      else if (now >= g.endAt) {
        const reason = g.windows.length === 1 ? 'اجرا نشد (برنامه بسته بود)' : 'پایان بازه'
        finish(g, 'DONE', reason); note('SCHEDULED_GRANT_CLOSED', g, reason); changed = true
      }
      continue
    }
    if (g.state === 'PENDING' || g.openedFor !== w.start) {
      // پنجرهٔ تازه؛ اگر هنوز «باز» بود، پنجرهٔ قبل بی دور زمان‌بند تمام شده (خواب رایانه یا بسته بودن برنامه)
      if (g.state === 'OPEN') closeGuardedParts({ source: 'SCHEDULED', grantId: g.id })
      g.state = 'OPEN'
      g.openedFor = w.start
      changed = true
      if (offset === null) offset = await offsetMs()
      note('SCHEDULED_GRANT_OPENED', g, g.userId === null ? 'برای همهٔ پنجره‌های برنامه' : 'فقط وقتی صندوق دست این کارمند است', { minutes: endClockMinutes(w.end, offset) })
    }
    if (g.userId !== null && custody?.holder !== g.userId) { closeGuardedParts({ source: 'SCHEDULED', grantId: g.id }); continue }
    for (const key of g.panels) {
      if (!isPartKey(key)) { openScheduledAction(key, g.id, w.end - now); continue }
      for (const owner of windows) {
        if (guardedEntryFor(owner, key)?.grantId === g.id) continue
        openGuardedPart(owner, key, { source: 'SCHEDULED', method: 'SCHEDULED_GRANT', grantId: g.id, ttlMs: w.end - now, idle: false })
      }
    }
  }
  if (changed) try { persist(list) } catch {}
  arm(list, now)
}

function arm(list: ScheduledGrant[], now: number): void {
  if (!running || !deps.schedule) return
  if (timer) clearTimeout(timer)
  const next = list.flatMap((g) => g.state === 'PENDING' || g.state === 'OPEN' ? g.windows.flat() : []).filter((t) => t > now)
  const watch = list.some((g) => g.state === 'OPEN' && g.userId !== null)
  const delay = Math.max(1000, Math.min(watch ? SCHEDULED_CUSTODY_TICK_MS : SCHEDULED_TICK_MS, ...next.map((t) => t - now + 250)))
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
