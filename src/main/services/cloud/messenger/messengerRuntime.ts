/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — سیم‌کشی پیام‌رسان در برنامهٔ واقعی (Electron).
 *
 *  - شبکه: `session.fetch` با `session` جدا و در حافظه برای هر پیام‌رسان. تلگرام: پراکسی اختیاری با
 *    `setProxy` همان session (وگرنه شبکهٔ خود ویندوز، که حالت TUN فیلترشکن را هم می‌پذیرد)؛ بله: مستقیم.
 *    `fetch` خام Node پراکسی ویندوز را نمی‌گیرد (طرح §۲۴-۳، مورد ۱۳).
 *  - گاوصندوق: `safeStorage` (DPAPI ویندوز).
 *  - راه‌اندازی از `registerIpcHandlers` (نه `src/main/index.ts`). وقتی پروندهٔ تنظیمات نیست، هیچ زمان‌سنجی،
 *    اتصالی یا قلابی ساخته نمی‌شود.
 *  - قلاب بازگردانی و ادغام از `desktopBackupCoordination` و قلاب بستن برنامه فقط وقتی پیام‌رسان روشن است.
 *  - مرحلهٔ ۶: دکمه‌های ربات با پل `botRemoteBridge` (همان `createGrant` و لغو درخواست)، «بستن همه» با همان قلاب
 *    «بستن همه»، و ردیف `BOT_DECISION` با همان نویسندهٔ `ACCESS_EVENT`.
 */
import * as electron from 'electron'
import { databaseFile } from '../../../db/client'
import { setDesktopBackupHooks } from '../desktopBackupCoordination'
import { sharedTodaySummary, todaySummaryDeps } from '../phoneReports'
import { createBotRemoteBridge } from '../botRemoteBridge'
import { remoteApprovalsLive } from '../../CloudSyncService'
import { noteAccessEvent } from '../../locks/accessEvents'
import { closeAllUnlocksFromRemote } from '../../locks/unlockHooks'
import type { FetchLike } from './messengerAdapters'
import { createMessengerDb } from './messengerDb'
import { createMessengerEngine, type MessengerEngine } from './messengerEngine'
import type { MessengerProvider } from './messengerTypes'

let engine: MessengerEngine | null = null
let quitHookInstalled = false

/** session جدا برای هر پیام‌رسان؛ هیچ کوکی یا پیشینه‌ای روی دیسک نمی‌ماند. */
function sessionFetch(provider: MessengerProvider, proxy: string): FetchLike {
  let configured: Promise<void> | null = null
  return async (url, init) => {
    const ses = electron.session.fromPartition(`messenger-${provider}`)
    configured ??= ses.setProxy(provider === 'bale'
      ? { mode: 'direct' }
      : proxy ? { proxyRules: proxy, proxyBypassRules: '<local>' } : { mode: 'system' })
    await configured
    const response = await ses.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, bypassCustomProtocolHandlers: true } as RequestInit)
    return { status: response.status, text: () => response.text() }
  }
}

function databasePath(): string | null {
  const url = process.env.DATABASE_URL ?? ''
  try { return url.startsWith('file:') ? url.slice(5) : databaseFile() } catch { return null }
}

export function messengerEngine(): MessengerEngine {
  if (engine) return engine
  engine = createMessengerEngine({
    dir: electron.app.getPath('userData'),
    storage: electron.safeStorage ?? null,
    db: createMessengerDb(),
    // مرحلهٔ ۷ (§۴-۷): همان تابع‌های گزارش و همان «خلاصهٔ امروز» از پیش ساختهٔ گوشی
    summary: todaySummaryDeps(),
    today: sharedTodaySummary(),
    fetchFor: sessionFetch,
    databasePath: databasePath(),
    schedule: true,
    // مرحلهٔ ۶ (§۴-۱-ب): دکمه‌های ربات از همان مسیر مجوز راه دور؛ تأیید فقط با هاب روشن و بی P2.
    remote: createBotRemoteBridge({
      available: () => remoteApprovalsLive(),
      closeAll: () => closeAllUnlocksFromRemote({ source: 'ربات پیام‌رسان' }),
      note: (f) => noteAccessEvent('BOT_DECISION', { decision: f.decision, recipientName: f.recipientName, titleFa: f.titleFa, windowNo: f.windowNo, minutes: f.minutes })
    }),
    powerSave: electron.powerSaveBlocker ? {
      start: () => electron.powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id: number) => electron.powerSaveBlocker.stop(id)
    } : null
  })
  return engine
}

/** پس از روشن شدن پیام‌رسان: قلاب بکاپ و بستن برنامه (یک بار). */
export function installMessengerHooks(): void {
  const e = messengerEngine()
  // مرحلهٔ ۸ (§۴-۲): صفر کردن هم از همین راه می‌آید، با `kind: 'reset'`.
  setDesktopBackupHooks({
    before: (kind) => e.beforeDatabaseOperation(kind === 'reset' ? 'reset' : 'backup'),
    after: (outcome) => {
      const result = (outcome.result ?? null) as { mode?: unknown; willRestart?: unknown } | null
      e.afterDatabaseOperation({ ok: outcome.ok, kind: outcome.kind === 'reset' ? 'reset' : 'backup', mode: typeof result?.mode === 'string' ? result.mode : null, willRestart: result?.willRestart === true })
    }
  })
  if (quitHookInstalled) return
  quitHookInstalled = true
  electron.app.on('before-quit', () => { e.markCleanExit() })
}

/**
 * با روشن شدن برنامه. پروندهٔ تنظیمات نباشد ⇒ هیچ کاری (نه زمان‌سنج، نه اتصال، نه قلاب).
 * چند ثانیه بعد از آماده شدن، تا با کارهای شروع برنامه هم‌زمان نشود.
 */
export function startMessengerAtLaunch(): void {
  const e = messengerEngine()
  if (!e.store.vaultExists()) return
  const timer = setTimeout(() => {
    void e.start().then(() => { if (e.isRunning()) installMessengerHooks() }).catch((error) => console.error('[messenger] start failed', error))
  }, 3000)
  ;(timer as { unref?: () => void }).unref?.()
}
