/**
 * طرح ۱۴۰۵ §۳-۴ و §۳-۵ — دروازهٔ مرکزی قفل‌ها.
 *
 * هر فراخوانی رمزدار «پوشانده» می‌شود و متن خود فراخوانی حرف‌به‌حرف همان می‌ماند:
 *   `await gateAction('<شناسه>', () => assertPanelPasswordStrict(...))`
 *   `await gateSession('<شناسه>', () => assertManagerSession(...))`
 * `gateAction` فقط شناسه را در بافت همان فراخوانی می‌گذارد؛ تصمیم داخل `assertManagerPassword` و
 * `assertPanelPasswordStrict` گرفته می‌شود (رمز آن‌جاست) و از `gatePasses` همین پرونده می‌پرسند.
 *
 * ترتیب تصمیم (برای هر شناسهٔ کار و «اثبات»: رمز تایپ‌شده، یا خالی/نشانگر):
 *   ۱) دستهٔ ۱ یا شناسهٔ ناشناس ⇒ فقط رفتار امروز («پیش‌فرض رد»).
 *   ۲) قفل خاموش (کلیدهای policy را خود صداکننده می‌سنجد) ⇒ می‌گذرد؛ روش «قفل خاموش بود».
 *   ۳) نشست مدیر همان پنجره ⇒ می‌گذرد؛ رمز سنجیده نمی‌شود و شمارندهٔ اشتباه دست نمی‌خورد.
 *   ۴) رمز تایپ‌شده: رمز دوم/سوم جدای خود «قفل کار» اگر تعریف شده و برابر است؛ وگرنه همان مسیر امروز.
 *   ۵) رمز تایپ‌نشده: بلیت یک‌بار همین کار در همین پنجره ⇒ مصرف می‌شود و می‌گذرد.
 *   ۶) وگرنه رد، با همان پیام امروز و کد خطای `GATE_REQUIRED:<شناسه>`.
 * بیرون از IPC (بی بافت فراخوانی) هیچ‌کدام از این‌ها اجرا نمی‌شود و رفتار عیناً امروز است (§۳-۸).
 */
import { GATE_REQUIRED_PREFIX, gateEntry, type GateCatalogEntry } from '@shared/gateCatalog'
import { isPanelLockEnabled, normalizePanelKey } from '@shared/panels'
import { BusinessError } from '../../errors'
import { actionKeyPasswordMatches, assertManagerPassword, authService, readPanelLocks } from '../AuthService'
import { isGuardedPanelOpen, isManagerSessionUnlocked, isPanelUnlocked } from '../panelSession'
import { currentGateCall, currentGateFrame, noteGateMethod, runInGateFrame, type GateCall, type GateFrame, type GateMethodRecord, type GateScope } from './callContext'
import { lockDurationMs } from './durations'
import { addGateTicket, peekGateTicket, takeGateTicket } from './tickets'
import { guardedEntryFor } from './unlocks'

export type GateIds = string | readonly string[]

function idsOf(id: GateIds): string[] {
  const list = typeof id === 'string' ? [id] : Array.isArray(id) ? id : []
  return [...new Set(list.map((value) => String(value)))]
}

/** همهٔ شناسه‌ها باید در کاتالوگ باشند؛ یکی ناشناس ⇒ null (رفتار امروز). */
function entriesOf(ids: readonly string[]): GateCatalogEntry[] | null {
  const out: GateCatalogEntry[] = []
  for (const id of ids) {
    const entry = gateEntry(id)
    if (!entry) return null
    out.push(entry)
  }
  return out.length ? out : null
}

/** کلیدهای `panel` با قفل خاموش کنار می‌روند؛ کلیدهای `policy` این‌جا همیشه «روشن»اند (صداکننده می‌سنجد). */
async function stillLocked(entries: GateCatalogEntry[]): Promise<GateCatalogEntry[]> {
  if (!entries.length) return entries
  const locks = await readPanelLocks()
  return entries.filter((e) => e.lockKind !== 'panel' || !e.lockKey || isPanelLockEnabled(locks, e.lockKey))
}

function pass(call: GateCall, entries: GateCatalogEntry[], scope: GateScope, method: GateMethodRecord | null): GateScope {
  for (const e of entries) if (!call.passed.has(e.id)) call.passed.set(e.id, scope)
  noteGateMethod(method)
  return scope
}

/** مصرف بلیت همهٔ شناسه‌ها، فقط اگر همه هست (هم‌زمان؛ در JS تک‌رشته‌ای بی رقابت). */
function takeTickets(call: GateCall, entries: GateCatalogEntry[]): GateMethodRecord | null | false {
  if (!entries.every((e) => peekGateTicket(call.owner, e.id))) return false
  let method: GateMethodRecord | null = null
  for (const e of entries) {
    const ticket = takeGateTicket(call.owner, e.id)
    if (!method && ticket?.method) method = { key: ticket.method, ...(ticket.number ? { number: ticket.number } : {}) }
  }
  return method
}

/**
 * تصمیم دروازه برای `assertManagerPassword` و `assertPanelPasswordStrict` (رمز نرمال‌شده؛ نشانگر خالی است).
 * خروجی: scope یعنی «بگذر» (تابع بی سنجیدن رمز برمی‌گردد)؛ null یعنی «همان مسیر امروز».
 */
export async function gatePasses(password: string): Promise<GateScope | null> {
  const frame = currentGateFrame()
  const call = frame?.call
  if (!frame || !call || !frame.ids) return null
  const entries = entriesOf(frame.ids)
  if (!entries || entries.some((e) => e.category === 1)) return null
  const left = entries.filter((e) => !call.passed.has(e.id))
  if (!left.length) return call.passed.get(entries[0].id) ?? 'PANEL'
  const pending = await stillLocked(left)
  if (!pending.length) return pass(call, entries, 'PANEL', { key: 'LOCK_OFF' })
  if (isManagerSessionUnlocked()) return pass(call, entries, 'MANAGER', pending.some((e) => e.origin !== 'SESSION') ? { key: 'MANAGER_SESSION' } : null)
  if (password) {
    const own = pending.filter((e) => e.lockKey && e.lockKey !== e.parentPanel)
    if (own.length === pending.length) {
      let all = true
      for (const e of own) if (!(await actionKeyPasswordMatches(e.lockKey, password))) { all = false; break }
      if (all) return pass(call, entries, 'PANEL', { key: 'PANEL_PASSWORD' })
    }
    return null
  }
  const method = takeTickets(call, pending)
  if (method !== false) return pass(call, entries, 'PANEL', method)
  frame.required = pending[0].id
  return null
}

/**
 * §۳-۱۰ ردیف ۲۶ (`preverifyOverpayManager`): پرسش بی رد با رمز خالی. نشست مدیر همین پنجره یا بلیت همین کار
 * ⇒ true؛ وگرنه false، مثل امروز (رد بعدی همان پیام امروز را با کد `GATE_REQUIRED` می‌دهد). بیرون از IPC false.
 */
export async function gateProbe(id: string): Promise<boolean> {
  const call = currentGateCall(), entry = gateEntry(id)
  if (!call || !entry || entry.category !== 3) return false
  if (call.passed.has(entry.id) || !(await stillLocked([entry])).length) return true
  // بی خط روش: این پرسش در هر تعویض صدا زده می‌شود، حتی وقتی سقف رد نشده است.
  if (isManagerSessionUnlocked()) return true
  const method = takeTickets(call, [entry])
  if (method === false) return false
  pass(call, [entry], 'PANEL', method)
  return true
}

/** رد با رمز خالی ⇒ همان خطای امروز، با کد `GATE_REQUIRED:<شناسه>` (فقط درون IPC). */
function gateRequiredError(err: unknown, frame: GateFrame): unknown {
  const e = err as { isBusinessError?: unknown; code?: unknown; message?: unknown } | null
  if (!frame.required || !frame.call || !e || e.isBusinessError !== true) return err
  if (typeof e.code === 'string' && e.code) return err
  return new BusinessError(String(e.message ?? ''), GATE_REQUIRED_PREFIX + frame.required)
}

/** پوشاندن `assertManagerPassword` و `assertPanelPasswordStrict`؛ `fn` همیشه اجرا می‌شود. */
export async function gateAction<T>(id: GateIds, fn: () => T | Promise<T>): Promise<T> {
  return runInGateFrame(idsOf(id), async (frame) => {
    try {
      return await fn()
    } catch (err) {
      throw gateRequiredError(err, frame)
    }
  })
}

/**
 * پوشاندن `assertManagerSession` (هم‌زمان). تصمیم بی رمز پیش از آن گرفته می‌شود: «باز» ⇒ `fn` صدا زده
 * نمی‌شود؛ نشست مدیر ⇒ `fn` مثل امروز (همان تمدید نشست)؛ وگرنه همان پیام امروز با کد `GATE_REQUIRED`.
 * قسمت‌ها با نشست همان کلید (رمز دوم/سوم یا مجوز) باز می‌شوند؛ کارها فقط با بلیت یک‌بار.
 */
export async function gateSession<T>(id: GateIds, fn: () => T): Promise<T | undefined> {
  return runInGateFrame(idsOf(id), async (frame) => {
    const call = frame.call
    const entries = frame.ids ? entriesOf(frame.ids) : null
    if (!call || !entries || entries.some((e) => e.category === 1)) return fn()
    const pending = await stillLocked(entries.filter((e) => !call.passed.has(e.id)))
    if (!pending.length) {
      if (entries.some((e) => !call.passed.has(e.id))) pass(call, entries, 'PANEL', { key: 'LOCK_OFF' })
      return undefined
    }
    if (isManagerSessionUnlocked()) return fn()
    const parts = pending.filter((e) => e.category === 2), actions = pending.filter((e) => e.category !== 2)
    if (parts.every((e) => isPanelUnlocked(e.lockKey)) && actions.every((e) => peekGateTicket(call.owner, e.id))) {
      const fromTicket = takeTickets(call, actions)
      const method = fromTicket || (parts.length ? guardedMethod(call.owner, parts[0].lockKey) ?? { key: 'PANEL_PASSWORD' as const } : null)
      pass(call, entries, 'PANEL', method)
      return undefined
    }
    frame.required = pending[0].id
    try {
      return fn()
    } catch (err) {
      throw gateRequiredError(err, frame)
    }
  })
}

/**
 * `assertPanelPassword` (۲۷ جای «رمز داخل یک قسمت»؛ فراخوانی‌ها بی‌تغییر): رمز خالی یا نشانگر فقط درون IPC
 * با نشست مدیر یا قسمتی که با مجوز (نگهبان‌دار) برای همین پنجره باز است پذیرفته می‌شود. باز بودن قسمت با
 * رمز دوم، کار رمزدار همان کلید را بی تایپ دوباره باز نمی‌کند (مثل امروز).
 */
export function emptyPanelPasswordScope(panel: string): GateScope | null {
  if (!currentGateCall()) return null
  if (isManagerSessionUnlocked()) {
    noteGateMethod({ key: 'MANAGER_SESSION' })
    return 'MANAGER'
  }
  const via = guardedMethod(currentGateCall()!.owner, normalizePanelKey(panel) ?? panel)
  if (via) {
    noteGateMethod(via)
    return 'PANEL'
  }
  return null
}

/**
 * روش نشست نگهبان‌دارِ زندهٔ همین پنجره و کلید: کد یک‌بارمصرف (با شماره) یا مجوز زمان‌بندی‌شده از ثبت‌شان،
 * وگرنه مجوز راه دور. null یعنی نشست نگهبان‌دار نیست (مثلاً رمز دوم).
 */
function guardedMethod(owner: number, key: string): GateMethodRecord | null {
  if (!isGuardedPanelOpen(key)) return null
  const entry = guardedEntryFor(owner, key)
  return entry ? { key: entry.method, ...(entry.number ? { number: entry.number } : {}) } : { key: 'REMOTE_GRANT' }
}

/**
 * راه «رمز» در پنجرهٔ «باز کردن قفل این کار» (§۳-۷): برای یک «قفل کار» یک بلیت یک‌بار برای همین پنجره
 * می‌سازد. رمز دوم/سوم جدای خود کار، یا برای strictها رمز دوم/سوم ماژول مادر (همان شمارندهٔ امروز روی
 * همان کلید)، یا رمز مدیر (همان شمارندهٔ امروز). مدت بلیت همان مدت کد «حساس» است. قسمت‌ها از همان
 * مسیر موجود `auth:verifyPanel` (`ManagerGate`) باز می‌شوند، نه این‌جا.
 */
export async function unlockActionWithPassword(id: unknown, password: unknown): Promise<{ id: string; minutes: number }> {
  const call = currentGateCall()
  const entry = gateEntry(id)
  if (!call || !entry || entry.category !== 3) throw new BusinessError('این کار قفل جدا ندارد؛ صفحه را یک بار ببندید و باز کنید.')
  const pass = String(password ?? '').replace(/\u2063/g, '').trim()
  if (!pass) throw new BusinessError('رمز را وارد کنید.')
  let method: 'PANEL_PASSWORD' | null = null
  if (entry.lockKey !== entry.parentPanel && (await actionKeyPasswordMatches(entry.lockKey, pass))) method = 'PANEL_PASSWORD'
  else if (entry.origin === 'STRICT' && entry.parentPanel) {
    const res = await authService.verifyPanel({ panel: entry.parentPanel, password: pass, force: true })
    if (res.scope === 'OPEN') throw new BusinessError('رمز واردشده پذیرفته نشد.')
    if (res.scope === 'PANEL') method = 'PANEL_PASSWORD'
  } else await assertManagerPassword(pass, entry.titleFa)
  const ms = lockDurationMs('sensitiveCodeMinutes')
  if (!addGateTicket(call.owner, entry.id, ms, 'PASSWORD', { method })) throw new BusinessError('مجوز این کار ساخته نشد؛ دوباره تلاش کنید.')
  return { id: entry.id, minutes: Math.round(ms / 60_000) }
}
