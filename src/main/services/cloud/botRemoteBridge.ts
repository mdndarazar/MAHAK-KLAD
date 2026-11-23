/**
 * طرح ۱۴۰۵ §۴-۱-ب و §۳-۱۲ بند ۸ — پل دکمه‌های ربات به همان مسیر مجوز راه دور، روی همین رایانه.
 *
 *   - تأیید ⇒ همان `createGrant` با سیاست همان قفل (کلید قسمت: `NORMAL/PANEL`؛ شناسهٔ کار: `SENSITIVE_MONEY/ONE_SHOT`)
 *     و سقف ۶۰ دقیقه؛ مدت واقعی هنگام فعال‌سازی از پروندهٔ مدت‌ها خوانده می‌شود (مثل تأیید گوشی).
 *   - رد ⇒ همان لغو درخواستِ همان پنجره، با یادداشت «رد شد» (پنجرهٔ فروشنده «مدیر رد کرد» می‌بیند).
 *   - شرط تأیید: کنترل از راه دور روشن و راه‌اندازی‌شده، و توقف اضطراری کامل (P2) یا مکث فعال نیست؛ همین لحظه
 *     از خود هاب پرسیده می‌شود. «بستن همه» همیشه کار می‌کند، چون فقط می‌بندد.
 *   - عضو `bot-<شناسهٔ گیرنده>` عضو واقعی هاب نیست؛ با P1، P2، خاموش کردن کلید ربات یا برداشتن اجازه بسته می‌شود.
 * مسیرها نسبی‌اند (بی `@shared`) تا هر بسته‌بندی esbuild هم بی alias کار کند.
 */
import { REMOTE_PANELS } from '../../../shared/enums'
import { GATE_ACTION_IDS } from '../../../shared/gateCatalog'
import { createGrant, listActiveGrants, listPendingRequests, rejectRequest, revokeBy } from '../RemoteGrantRegistry'
import type { BotRemote, BotRemoteRequest } from './messenger/messengerBot'

const MEMBER = /^bot-[a-f0-9]{12}$/
const POLICY_TTL_MS = 3_600_000
const remotePanel = (panel: string) => (REMOTE_PANELS as readonly string[]).includes(panel)
const samePending = (req: BotRemoteRequest) => listPendingRequests().some((p) => p.requestId === req.requestId && p.ownerWindowId === req.ownerWindowId && p.panel === req.panel)

export function createBotRemoteBridge(deps: {
  /** هاب روشن است و تأیید راه دور متوقف نیست (همین لحظه) */
  available: () => Promise<boolean>
  closeAll: () => void
  note: BotRemote['note']
}): BotRemote {
  return {
    pending: () => listPendingRequests().filter((p) => remotePanel(p.panel)),
    async approve(req, memberId) {
      if (!MEMBER.test(memberId) || !remotePanel(req.panel)) return 'GONE'
      let ok = false
      try { ok = await deps.available() } catch { ok = false }
      if (!ok) return 'OFF'
      if (!samePending(req)) return 'GONE'
      const oneShot = GATE_ACTION_IDS.includes(req.panel)
      const grant = createGrant({
        panel: req.panel, ownerWindowId: req.ownerWindowId, requestId: req.requestId, memberId,
        tier: oneShot ? 'SENSITIVE_MONEY' : 'NORMAL', mode: oneShot ? 'ONE_SHOT' : 'PANEL', ttlMs: POLICY_TTL_MS
      })
      return grant ? 'OK' : 'GONE'
    },
    reject: (req) => remotePanel(req.panel) && rejectRequest(req.ownerWindowId, req.panel, req.requestId),
    closeAll: () => deps.closeAll(),
    openGrants: () => listActiveGrants(),
    revokeMember(memberId) {
      if (MEMBER.test(memberId)) revokeBy(memberId)
    },
    note: (fields) => deps.note(fields)
  }
}
