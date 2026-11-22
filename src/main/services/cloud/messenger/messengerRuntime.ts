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
 */
import * as electron from 'electron'
import { databaseFile } from '../../../db/client'
import { salesService } from '../../SalesService'
import { staffReportService } from '../../StaffReportService'
import { setDesktopBackupHooks } from '../desktopBackupCoordination'
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

/** آخرین بکاپ موفق (تازه‌ترین پروندهٔ بکاپ)، برای خلاصهٔ ساعت ۲۴. */
async function lastBackupAt(): Promise<number | null> {
  const { backupService } = await import('../../BackupService')
  const list = await backupService.list()
  const times = list.map((entry) => new Date(entry.at).getTime()).filter((t) => Number.isFinite(t))
  return times.length ? Math.max(...times) : null
}

export function messengerEngine(): MessengerEngine {
  if (engine) return engine
  engine = createMessengerEngine({
    dir: electron.app.getPath('userData'),
    storage: electron.safeStorage ?? null,
    db: createMessengerDb(),
    summary: {
      salesSummary: (filter) => salesService.summary(filter) as never,
      staffPerformance: (filter) => staffReportService.performance(filter) as never,
      abnormalDiscounts: (filter) => staffReportService.abnormalDiscounts(filter) as never,
      lastBackupAt
    },
    fetchFor: sessionFetch,
    databasePath: databasePath(),
    schedule: true,
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
  setDesktopBackupHooks({
    before: () => e.beforeDatabaseOperation('backup'),
    after: (outcome) => {
      const result = (outcome.result ?? null) as { mode?: unknown; willRestart?: unknown } | null
      e.afterDatabaseOperation({ ok: outcome.ok, kind: 'backup', mode: typeof result?.mode === 'string' ? result.mode : null, willRestart: result?.willRestart === true })
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
