/**
 * طرح ۱۴۰۵ §۴-۱-ب و §۳-۱۲ بند ۸ — پل دکمه‌های ربات به همان مسیر مجوز راه دور، روی همین رایانه.
 *
 *   - تأیید ⇒ همان `createGrant` با سیاست همان قفل (کلید قسمت: `NORMAL/PANEL`؛ شناسهٔ کار: `SENSITIVE_MONEY/ONE_SHOT`)
 *     و سقف ۱۰۰۰ دقیقه (دفتر آزمون ۴-۲۸)؛ مدت واقعی هنگام فعال‌سازی از پروندهٔ مدت‌ها و با کلید همان قسمت خوانده می‌شود
 *     (معمولی، یا پولی و حساس؛ مثل تأیید گوشی).
 *   - رد ⇒ همان لغو درخواستِ همان پنجره، با یادداشت «رد شد» (پنجرهٔ فروشنده «مدیر رد کرد» می‌بیند).
 *   - دفتر آزمون ۴-۳۰: «زمان رایانه برای این نوع» در پیام درخواست = همان مدتی که فعال‌سازی می‌خواند (همان کلید قسمت).
 *   - دفتر آزمون ۴-۲۹ (TL-D11): تأیید با زمان دلخواه فقط برای قسمت، عدد صحیح ۱ تا ۱۰۰۰ دقیقه، فقط برای همین یک مجوز
 *     (نشانهٔ `exact` رجیستری؛ پروندهٔ مدت‌ها عوض نمی‌شود)؛ بیش از ۶۰ دقیقه با همان تمدید نشست ۴-۲۸. عدد نادرست یا برای
 *     قفل کار ⇐ BAD و درخواست در انتظار می‌ماند.
 *   - دفتر آزمون ۴-۳۱ (TL-D12): کار «قابل تکرار» ⇐ «تعداد رایانه» (`repeatFor`) یا تعداد دلخواه ۱ تا ۱۰۰۰ فقط برای همان
 *     مجوز؛ تعداد کنار رجیستری نگه داشته می‌شود (کلید پنجره و کار، همان عضو، ۱۰ دقیقه) و میزبان هنگام ساختن بلیت یک بار
 *     می‌خواندش. «مجوزهای باز» بلیت‌های چندباره را با دفعات باقی هم دارد.
 *   - شرط تأیید: کنترل از راه دور روشن و راه‌اندازی‌شده، و توقف اضطراری کامل (P2) یا مکث فعال نیست؛ همین لحظه
 *     از خود هاب پرسیده می‌شود. «بستن همه» همیشه کار می‌کند، چون فقط می‌بندد.
 *   - عضو `bot-<شناسهٔ گیرنده>` عضو واقعی هاب نیست؛ با P1، P2، خاموش کردن کلید ربات یا برداشتن اجازه بسته می‌شود.
 * مسیرها نسبی‌اند (بی `@shared`) تا هر بسته‌بندی esbuild هم بی alias کار کند.
 */
import { REMOTE_PANELS } from '../../../shared/enums'
import { GATE_ACTION_IDS } from '../../../shared/gateCatalog'
import { codeSectionOfPanel } from '../../../shared/panels'
import { partDurationMs, remoteDurationKey, repeatUsesOf } from '../locks/durations'
import { listRepeatTickets } from '../locks/tickets'
import { createGrant, listActiveGrants, listPendingRequests, rejectRequest, revokeBy } from '../RemoteGrantRegistry'
import type { BotRemote, BotRemoteRequest } from './messenger/messengerBot'

const MEMBER = /^bot-[a-f0-9]{12}$/
const POLICY_TTL_MS = 60_000_000
const remotePanel = (panel: string) => (REMOTE_PANELS as readonly string[]).includes(panel)
const samePending = (req: BotRemoteRequest) => listPendingRequests().some((p) => p.requestId === req.requestId && p.ownerWindowId === req.ownerWindowId && p.panel === req.panel)
const bad = (n: unknown) => !Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 1000
const USES_TTL_MS = 10 * 60_000
const customUses = new Map<string, { memberId: string; uses: number; until: number }>()

/** دفتر آزمون ۴-۳۱: تعداد دلخواه ربات برای همان مجوز کار (یک بار خوانده و پاک می‌شود)؛ عضو دیگر، کهنه یا نبود ⇒ null. */
export function takeBotUses(owner: number, actionId: string, memberId: string): number | null {
  const k = `${owner}::${actionId}`, entry = customUses.get(k)
  if (!entry) return null
  customUses.delete(k)
  return entry.memberId === memberId && performance.now() <= entry.until ? entry.uses : null
}

export function createBotRemoteBridge(deps: {
  /** هاب روشن است و تأیید راه دور متوقف نیست (همین لحظه) */
  available: () => Promise<boolean>
  closeAll: () => void
  note: BotRemote['note']
}): BotRemote {
  return {
    pending: () => listPendingRequests().filter((p) => remotePanel(p.panel)),
    async approve(req, memberId, minutes, uses) {
      if (!MEMBER.test(memberId) || !remotePanel(req.panel)) return 'GONE'
      const oneShot = GATE_ACTION_IDS.includes(req.panel), custom = minutes !== undefined, counted = uses !== undefined
      if (custom && (oneShot || bad(minutes))) return 'BAD'
      if (counted && (!oneShot || custom || bad(uses) || repeatUsesOf(req.panel) === null)) return 'BAD'
      let ok = false
      try { ok = await deps.available() } catch { ok = false }
      if (!ok) return 'OFF'
      if (!samePending(req)) return 'GONE'
      const key = `${req.ownerWindowId}::${req.panel}`
      if (counted) customUses.set(key, { memberId, uses: uses as number, until: performance.now() + USES_TTL_MS })
      else customUses.delete(key)
      const grant = createGrant({
        panel: req.panel, ownerWindowId: req.ownerWindowId, requestId: req.requestId, memberId,
        tier: oneShot ? 'SENSITIVE_MONEY' : 'NORMAL', mode: oneShot ? 'ONE_SHOT' : 'PANEL',
        ...(custom ? { ttlMs: (minutes as number) * 60_000, exact: true } : { ttlMs: POLICY_TTL_MS })
      })
      if (!grant) customUses.delete(key)
      return grant ? 'OK' : 'GONE'
    },
    reject: (req) => remotePanel(req.panel) && rejectRequest(req.ownerWindowId, req.panel, req.requestId),
    closeAll: () => deps.closeAll(),
    openGrants: () => [...listActiveGrants(), ...listRepeatTickets().filter((t) => remotePanel(t.id)).map((t) => ({ panel: t.id, ownerWindowId: t.owner, claimed: true, remainingMs: t.remainingMs, left: t.left, uses: t.uses }))],
    revokeMember(memberId) {
      if (MEMBER.test(memberId)) revokeBy(memberId)
    },
    note: (fields) => deps.note(fields),
    minutesFor: (panel) => GATE_ACTION_IDS.includes(panel) || !remotePanel(panel) ? null : Math.round(partDurationMs(remoteDurationKey(codeSectionOfPanel(panel))) / 60_000),
    repeatFor: (panel) => GATE_ACTION_IDS.includes(panel) && remotePanel(panel) ? repeatUsesOf(panel) : null
  }
}
