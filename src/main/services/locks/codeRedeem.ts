/**
 * طرح ۱۴۰۵ §۳-۱۵ — مصرف کد یک‌بارمصرف روی یک «قسمت» یا یک «قفل کار» (کانال `locks:redeemCode`).
 *
 *   - هدف: کلید یک قسمت یا یک شناسهٔ کار. قسمت «عادی» فقط با کد «سایر ماژول‌ها»؛ قسمت «پولی»، قسمت‌های تازه و
 *     همهٔ قفل‌های کار فقط با کد «حساس». دستهٔ ۱ («کلیدسازی»)، کلید بی‌رده یا شناسهٔ ناشناس ⇒ رد («پیش‌فرض رد»).
 *   - قسمت ⇒ نشست نگهبان‌دار با مدت همان قسمت کد و بی‌کاری یک‌پنجم؛ کار ⇒ بلیت یک‌بار تا مدت کد «حساس».
 *   - کد روی قسمتِ از قبل باز (یا کارِ از قبل مجاز) و روی قفل خاموش مصرف نمی‌شود.
 *   - کدِ قسمت دیگر: «کد درست نیست یا برای این ماژول نیست»، یک تلاش اشتباه، مصرف نمی‌شود.
 *   - مدت هنگام مصرف از پروندهٔ مدت‌ها خوانده می‌شود؛ قفلی که همین حالا باز است با عدد قبلی بسته می‌شود.
 * پس از هر `await`، بخش «سنجش، مصرف و ساختن نشست یا بلیت» همگام و بی فاصله است.
 */
import { gateEntry } from '@shared/gateCatalog'
import { codeSectionOfPanel, isPanelLockEnabled, LOCKED_PANELS, normalizePanelKey } from '@shared/panels'
import { faDigits } from '@shared/jalali'
import { BusinessError } from '../../errors'
import { readPanelLocks } from '../AuthService'
import { noteAccessEvent, noteCodeLockout } from './accessEvents'
import { currentGateCall } from './callContext'
import { readLockDurations } from './durations'
import { CODE_LOCK_MS, CODE_SECTION_LABELS, consumeOneTimeCode, restoreOneTimeCode, type CodeSection } from './oneTimeCodes'
import { addGateTicket, peekGateTicket } from './tickets'
import { openGuardedPart, partAlreadyOpen } from './unlocks'

export interface CodeTarget {
  kind: 'part' | 'action'
  /** شناسهٔ کار یا کلید قسمت (همان که پنجرهٔ قفل فرستاد) */
  id: string
  /** کلید قفل در `panels.ts` (برای روشن/خاموش و نشست) */
  lockKey: string
  lockKind: 'panel' | 'policy'
  section: CodeSection
  titleFa: string
}

/** هدف کد از روی کاتالوگ و `panels.ts`؛ null یعنی «پیش‌فرض رد». */
export function codeTargetOf(target: unknown): CodeTarget | null {
  const entry = gateEntry(target)
  if (entry) {
    if (entry.category === 1 || !entry.lockKey) return null
    const section = codeSectionOfPanel(entry.lockKey)
    if (!section) return null
    // کارها همیشه «حساس»اند (حتی کار پنج کلید استثنا)؛ قسمت‌های تازه هم.
    return { kind: entry.category === 3 ? 'action' : 'part', id: entry.id, lockKey: entry.lockKey, lockKind: entry.lockKind, section: 'sensitive', titleFa: entry.titleFa }
  }
  const key = normalizePanelKey(target)
  const panel = key ? LOCKED_PANELS.find((p) => p.key === key && p.kind === 'part') : undefined
  const section = panel ? codeSectionOfPanel(panel.key) : null
  if (!panel || !section) return null
  return { kind: 'part', id: panel.key, lockKey: panel.key, lockKind: 'panel', section, titleFa: panel.title }
}

const WRONG = 'کد درست نیست یا برای این ماژول نیست.'

export interface RedeemResult { kind: 'part' | 'action'; id: string; minutes: number; number: number; section: CodeSection; titleFa: string }

export async function redeemOneTimeCode(target: unknown, code: unknown): Promise<RedeemResult> {
  const call = currentGateCall()
  if (!call) throw new BusinessError('پنجرهٔ درخواست معتبر نیست؛ صفحه را یک بار ببندید و باز کنید.')
  const t = codeTargetOf(target)
  if (!t) throw new BusinessError('برای این بخش کد یک‌بارمصرف پذیرفته نمی‌شود.')
  if (typeof code !== 'string' || !code.trim()) throw new BusinessError('کد یک‌بارمصرف را وارد کنید.')
  if (t.lockKind === 'panel' && !isPanelLockEnabled(await readPanelLocks(), t.lockKey))
    throw new BusinessError('قفل این بخش خاموش است؛ کد لازم نیست و مصرف نشد.')
  const durations = readLockDurations()
  const minutes = t.section === 'sensitive' ? durations.sensitiveCodeMinutes : durations.otherCodeMinutes
  // ---------------- از این‌جا تا پایان، همگام (بی await): سنجش، مصرف و ساختن نشست یا بلیت ----------------
  if (t.kind === 'part' && partAlreadyOpen(call.owner, t.lockKey)) throw new BusinessError('این بخش همین حالا باز است؛ کد مصرف نشد.')
  if (t.kind === 'action' && peekGateTicket(call.owner, t.id)) throw new BusinessError('این کار همین حالا یک بار مجاز است؛ کد مصرف نشد. روی دکمهٔ همان کار بزنید.')
  const result = consumeOneTimeCode(t.section, code)
  if (!result.ok) {
    if (result.reason === 'BROKEN') {
      if (result.firstNotice) noteAccessEvent('CODES_FILE_BROKEN', {})
      throw new BusinessError(WRONG)
    }
    if (result.reason === 'LOCKED') {
      const left = Math.max(1, Math.ceil(result.lockedMs / 60_000))
      throw new BusinessError(`ورود کد یک‌بارمصرف پس از چند تلاش اشتباه قفل است؛ ${faDigits(left)} دقیقهٔ دیگر دوباره تلاش کنید یا به مدیر بگویید.`)
    }
    noteAccessEvent('CODE_WRONG', { titleFa: t.titleFa, windowNo: call.owner, decision: CODE_SECTION_LABELS[t.section] })
    if (result.justLocked) {
      noteCodeLockout(CODE_LOCK_MS / 60_000, call.owner)
      throw new BusinessError(`${WRONG} پس از ۵ تلاش اشتباه، ورود کد ۱۵ دقیقه قفل شد.`)
    }
    throw new BusinessError(`${WRONG} (${faDigits(result.failsLeft)} تلاش دیگر تا قفل شدن)`)
  }
  const ms = minutes * 60_000
  const method = t.section === 'sensitive' ? 'SENSITIVE_CODE' as const : 'OTHER_CODE' as const
  const made = t.kind === 'part'
    ? openGuardedPart(call.owner, t.lockKey, { source: 'CODE', method, number: result.n, ttlMs: ms, idle: true })
    : addGateTicket(call.owner, t.id, ms, 'SENSITIVE_CODE', { number: result.n })
  if (!made) {
    restoreOneTimeCode(t.section, result.n)
    throw new BusinessError('باز کردن انجام نشد و کد مصرف نشد؛ دوباره تلاش کنید.')
  }
  noteAccessEvent('CODE_USED', { titleFa: t.titleFa, number: result.n, windowNo: call.owner, minutes, decision: CODE_SECTION_LABELS[t.section] })
  return { kind: t.kind, id: t.id, minutes, number: result.n, section: t.section, titleFa: t.titleFa }
}
