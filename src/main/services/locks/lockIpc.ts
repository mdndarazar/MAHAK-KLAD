/**
 * طرح ۱۴۰۵ — کانال‌های تازهٔ دروازه (همه از راه `handle()` مشترک `ipc/index.ts`، پس owner همان پنجره است):
 *   - `gate:unlock`: راه «رمز» پنجرهٔ «باز کردن قفل این کار» ⇒ یک بلیت یک‌بار برای همین پنجره (§۳-۷)؛
 *   - `gate:closeAll`: «بستن همهٔ مجوزها و قفل‌های باز» روی رایانه؛ رمز نمی‌خواهد، چون فقط می‌بندد (§۳-۱۷)؛
 *   - `lockDurations:get` / `lockDurations:set`: پروندهٔ مدت‌ها؛ تغییر «کلیدسازی» است و رمز تایپی مدیر
 *     می‌خواهد، با ردیف `ACCESS_EVENT` و خبر پیام‌رسان (§۳-۱۳)؛ دفتر آزمون ۴-۳۱: «حداکثر دفعات هر مجوز» و فهرست
 *     «قابل تکرار» از همین دو کانال، و مجوزهای چندبارهٔ باز در پاسخ `get`؛
 *   - مرحلهٔ ۶ (§۳-۱۵): `locks:redeemCode` (مصرف کد یک‌بارمصرف، بی رمز) و ساخت، باطل کردن و برداشتن قفل کدها
 *     (کلیدسازی، رمز تایپی مدیر)؛ §۳-۱۶: فهرست، ساخت و لغو مجوز زمان‌بندی‌شده (کلیدسازی، رمز تایپی مدیر).
 * رمز تایپی یعنی `assertManagerPassword` بیرون از قاب دروازه: نه نشست مدیر، نه نشانگر، نه کد و نه مجوز.
 */
import { BusinessError } from '../../errors'
import { GATE_IRREVERSIBLE_ACTIONS, gateEntry } from '../../../shared/gateCatalog'
import { assertManagerPassword, secretEqualsAnyPassword } from '../AuthService'
import { revokeAll } from '../RemoteGrantRegistry'
import { noteAccessEvent } from './accessEvents'
import { redeemOneTimeCode } from './codeRedeem'
import {
  LOCK_DURATION_KEYS, LOCK_DURATION_TITLES, REPEATABLE_ACTION_IDS, readLockDurations, readRepeatSettings, validDurationMinutes, writeLockSettings,
  type LockDurations, type RepeatSettings
} from './durations'
import { unlockActionWithPassword } from './gate'
import {
  CODE_SECTION_TITLES, CODE_SECTIONS, clearOneTimeCodeLock, commitOneTimeCodes, oneTimeCodesStatus,
  prepareOneTimeCodes, revokeOneTimeCodes, type CodeSection
} from './oneTimeCodes'
import { cancelScheduledGrant, closeScheduledGrants, createScheduledGrant, listScheduledGrants } from './scheduledGrants'
import { clearGateTickets, listRepeatTickets, setGateTicketUseListener } from './tickets'
import { setCloseAllUnlocksHook, type CloseAllOptions } from './unlockHooks'
import { closeGuardedParts } from './unlocks'

/**
 * یک تابع برای «بستن همه» (§۳-۱۷): مجوزهای راه دور (همان `revokeAll` موجود، که بلیت‌های راه دور را هم پاک
 * می‌کند)، همهٔ بلیت‌های یک‌بار (از کد «حساس»، مجوز یا رمز پنجرهٔ قفل)، نشست‌های بازشده با کد، و مجوز
 * زمان‌بندی‌شدهٔ باز. با `cancelFuture` (P2) مجوزهای زمان‌بندی‌شدهٔ آینده هم لغو می‌شوند.
 * کدهای یک‌بارمصرف با این دکمه و با P2 باطل نمی‌شوند؛ باطل کردنشان کار دستی مدیر است.
 */
export function closeAllUnlocks(options: CloseAllOptions = {}): { ok: true } {
  let failed = false
  try { revokeAll() } catch { failed = true }
  clearGateTickets()
  try { closeGuardedParts() } catch { failed = true }
  try { closeScheduledGrants({ cancelFuture: options.cancelFuture === true, ...(options.cancelFuture ? { reason: 'توقف اضطراری کامل' } : {}) }) } catch { failed = true }
  noteAccessEvent('REMOTE_GRANT_CLOSED', { titleFa: 'همهٔ مجوزها و قفل‌های باز', ...(options.source ? { decision: options.source } : {}) })
  if (failed) throw new BusinessError('بستن یکی از مجوزها کامل نشد؛ یک بار دیگر روی همین دکمه بزنید.')
  return { ok: true }
}

type LockSettingsView = LockDurations & { repeatUsesMax: number; repeatableActions: string[] }
const viewOf = (d: LockDurations, r: RepeatSettings): LockSettingsView => ({ ...d, repeatUsesMax: r.usesMax, repeatableActions: [...r.actions] })

/** دفتر آزمون ۴-۳۱: تنظیم تکرار تازه از ورودی؛ عدد نادرست، کار ناشناس یا برگشت‌ناپذیر رد می‌شود و چیزی عوض نمی‌شود. */
function repeatInput(input: Record<string, unknown>, before: RepeatSettings): RepeatSettings {
  const next: RepeatSettings = { usesMax: before.usesMax, actions: [...before.actions] }
  if (!(input.repeatUsesMax === undefined || input.repeatUsesMax === null || input.repeatUsesMax === '')) {
    const value = Number(input.repeatUsesMax)
    if (!validDurationMinutes(value)) throw new BusinessError('«حداکثر دفعات هر مجوز» باید عددی صحیح بین ۱ تا ۱۰۰۰ باشد.')
    next.usesMax = value
  }
  if (input.repeatableActions !== undefined) {
    const list: unknown = input.repeatableActions
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) throw new BusinessError('فهرست کارهای قابل تکرار نامعتبر است.')
    const never = list.find((id) => GATE_IRREVERSIBLE_ACTIONS.includes(id))
    if (never) throw new BusinessError(`«${gateEntry(never)?.titleFa ?? never}» برگشت‌ناپذیر است و هرگز قابل تکرار نمی‌شود.`)
    if (list.some((id) => !REPEATABLE_ACTION_IDS.includes(id))) throw new BusinessError('فهرست کارهای قابل تکرار نامعتبر است.')
    next.actions = REPEATABLE_ACTION_IDS.filter((id) => list.includes(id))
  }
  return next
}

/** پاسخ `lockDurations:get`: مدت‌ها، تنظیم تکرار و (۴-۳۱) مجوزهای چندبارهٔ باز با دفعات باقی؛ بی شناسهٔ عضو. */
export function lockSettingsView() {
  return {
    ...viewOf(readLockDurations(), readRepeatSettings()),
    openRepeats: listRepeatTickets().map((t) => ({ id: t.id, titleFa: gateEntry(t.id)?.titleFa ?? t.id, windowNo: t.owner, left: t.left, uses: t.uses, minutesLeft: Math.max(1, Math.ceil(t.remainingMs / 60_000)) }))
  }
}

/**
 * تغییر مدت‌ها: هر عدد باید صحیح ۱ تا ۱۰۰۰ باشد (دفتر آزمون ۴-۲۸)؛ عدد نادرست رد می‌شود و عدد قبلی می‌ماند. ۴-۳۱:
 * «حداکثر دفعات هر مجوز» (۱ تا ۱۰۰۰) و فهرست «قابل تکرار» با همان رمز تایپی مدیر و در همان یک نوشتن؛ پاسخ همان چهار مدت.
 */
export async function setLockDurations(input: Record<string, unknown>, userId: number | null = null): Promise<LockDurations> {
  const before = readLockDurations()
  const next: LockDurations = { ...before }
  for (const key of LOCK_DURATION_KEYS) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue
    const value = Number(input[key])
    if (!validDurationMinutes(value)) throw new BusinessError(`«${LOCK_DURATION_TITLES[key]}» باید عددی صحیح بین ۱ تا ۱۰۰۰ دقیقه باشد.`)
    next[key] = value
  }
  const changed = LOCK_DURATION_KEYS.filter((key) => next[key] !== before[key])
  const repeatBefore = readRepeatSettings(), repeat = repeatInput(input, repeatBefore)
  const repeatChanged = repeat.usesMax !== repeatBefore.usesMax || repeat.actions.join('|') !== repeatBefore.actions.join('|')
  if (!changed.length && !repeatChanged) return before
  const password = typeof input.managerPassword === 'string' ? input.managerPassword : ''
  await assertManagerPassword(password, 'تغییر مدت کدها و مجوز راه دور')
  writeLockSettings(next, repeat)
  for (const key of changed) noteAccessEvent('DURATIONS_CHANGED', { titleFa: LOCK_DURATION_TITLES[key], minutes: next[key] }, userId)
  if (repeatChanged) noteAccessEvent('REPEAT_SETTINGS_CHANGED', { number: repeat.usesMax, count: repeat.actions.length }, userId)
  return next
}

// ------------------------------------------------------------------ کدهای یک‌بارمصرف (§۳-۱۵)
const typed = (input: Record<string, unknown>) => (typeof input.managerPassword === 'string' ? input.managerPassword : '')
function sectionOf(value: unknown): CodeSection {
  if (!CODE_SECTIONS.includes(value as CodeSection)) throw new BusinessError('قسمت کد نامعتبر است.')
  return value as CodeSection
}
const asBusiness = (error: unknown): never => {
  if ((error as { isBusinessError?: unknown })?.isBusinessError === true) throw error
  throw new BusinessError(error instanceof Error && error.message ? error.message : 'انجام نشد؛ دوباره تلاش کنید.')
}

/** وضعیت دو قسمت (شمار باقی‌مانده، قفل) و دو مدت کد؛ کد خام هرگز. */
export function codesStatus() {
  const durations = readLockDurations()
  return { ...oneTimeCodesStatus(), sensitiveCodeMinutes: durations.sensitiveCodeMinutes, otherCodeMinutes: durations.otherCodeMinutes }
}

/** «ساخت ۵ کد تازه» یک قسمت؛ پیش‌فرض تصادفی، یا «خودم می‌نویسم». کدهای خام فقط همین یک بار برمی‌گردند. */
export async function createCodes(input: Record<string, unknown>): Promise<{ section: CodeSection; codes: Array<{ n: number; code: string }> }> {
  const section = sectionOf(input.section)
  const mode = input.mode === 'own' ? 'own' : 'random'
  let codes: string[]
  try { codes = prepareOneTimeCodes(mode, input.codes) } catch (error) { return asBusiness(error) }
  await assertManagerPassword(typed(input), `ساخت ${CODE_SECTION_TITLES[section]}`)
  if (mode === 'own') {
    for (const [i, code] of codes.entries()) {
      if (await secretEqualsAnyPassword(code)) throw new BusinessError(`کد شمارهٔ ${'۱۲۳۴۵'[i]} با یکی از رمزهای برنامه برابر است؛ کد دیگری بنویسید.`)
    }
  }
  let made: Array<{ n: number; code: string }>
  try { made = commitOneTimeCodes(section, codes, { random: mode === 'random' }) } catch (error) { return asBusiness(error) }
  noteAccessEvent('CODES_CREATED', { titleFa: CODE_SECTION_TITLES[section], count: made.length })
  return { section, codes: made }
}

export async function revokeCodes(input: Record<string, unknown>) {
  const section = sectionOf(input.section)
  await assertManagerPassword(typed(input), `باطل کردن ${CODE_SECTION_TITLES[section]}`)
  try { revokeOneTimeCodes(section) } catch (error) { return asBusiness(error) }
  noteAccessEvent('CODES_REVOKED', { titleFa: CODE_SECTION_TITLES[section] })
  return codesStatus()
}

export async function unlockCodes(input: Record<string, unknown>) {
  await assertManagerPassword(typed(input), 'برداشتن قفل کدهای یک‌بارمصرف')
  if (clearOneTimeCodeLock()) noteAccessEvent('CODES_UNLOCKED', {})
  return codesStatus()
}

// ------------------------------------------------------------------ مجوز زمان‌بندی‌شده (§۳-۱۶)
export async function createScheduled(input: Record<string, unknown>) {
  await assertManagerPassword(typed(input), 'ساخت مجوز زمان‌بندی‌شده')
  try { await createScheduledGrant(input) } catch (error) { return asBusiness(error) }
  return listScheduledGrants()
}
export async function cancelScheduled(input: Record<string, unknown>) {
  await assertManagerPassword(typed(input), 'لغو مجوز زمان‌بندی‌شده')
  try { await cancelScheduledGrant(input.id) } catch (error) { return asBusiness(error) }
  return listScheduledGrants()
}

type Handle = (channel: string, fn: (payload: any) => unknown) => void
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {})

export function registerLockHandlers(handle: Handle, channels: {
  unlock: string; closeAll: string; durationsGet: string; durationsSet: string
  redeemCode: string; codesStatus: string; codesCreate: string; codesRevoke: string; codesUnlock: string
  scheduledList: string; scheduledCreate: string; scheduledCancel: string
}): void {
  handle(channels.unlock, (p) => unlockActionWithPassword(p?.id, p?.password))
  handle(channels.closeAll, () => closeAllUnlocks({ cancelFuture: false }))
  handle(channels.durationsGet, () => lockSettingsView())
  handle(channels.durationsSet, (p) => setLockDurations(obj(p)))
  handle(channels.redeemCode, (p) => redeemOneTimeCode(p?.target, typeof p?.code === 'string' ? p.code : ''))
  handle(channels.codesStatus, () => codesStatus())
  handle(channels.codesCreate, (p) => createCodes(obj(p)))
  handle(channels.codesRevoke, (p) => revokeCodes(obj(p)))
  handle(channels.codesUnlock, (p) => unlockCodes(obj(p)))
  handle(channels.scheduledList, () => listScheduledGrants())
  handle(channels.scheduledCreate, (p) => createScheduled(obj(p)))
  handle(channels.scheduledCancel, (p) => cancelScheduled(obj(p)))
  // P1 و P2 گوشی (مسیر لغو موجود در CloudSyncService) همین «بستن همه» را از راه قلاب leaf صدا می‌زنند.
  setCloseAllUnlocksHook((options) => closeAllUnlocks(options))
  // دفتر آزمون ۴-۳۱: هر بار استفاده از مجوز چندبارهٔ کار یک ردیف دسترسی و خبر پیام‌رسان («بار ۲ از ۳»)
  setGateTicketUseListener((u) => noteAccessEvent('REPEAT_GRANT_USED', { titleFa: gateEntry(u.id)?.titleFa ?? u.id, windowNo: u.owner, number: u.use, count: u.uses }))
}
