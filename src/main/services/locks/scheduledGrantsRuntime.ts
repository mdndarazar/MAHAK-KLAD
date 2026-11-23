/**
 * طرح ۱۴۰۵ §۳-۱۶ — سیم‌کشی زمان‌بند مجوزهای زمان‌بندی‌شده در برنامهٔ واقعی (Electron).
 *
 *   - پنجره‌ها: همهٔ `BrowserWindow`های زنده (شناسهٔ `webContents`، همان owner دروازه)؛
 *   - ساعت رسمی: همان افست «تاریخ و ساعت رسمی» (`time.official`)؛
 *   - خواب رایانه: رویداد `resume` از `powerMonitor` مبنای سنجش ساعت را از نو می‌گیرد (لغو نمی‌کند).
 * از `registerIpcHandlers` شروع می‌شود (نه `src/main/index.ts`). پرونده نباشد ⇒ زمان‌بند فقط هر ۳۰ ثانیه
 * فهرست خالی را می‌بیند؛ هیچ اتصالی ساخته نمی‌شود.
 */
import * as electron from 'electron'
import { parseOfficialTimeConfig, SETTING_KEYS } from '@shared/receipt'
import { prisma } from '../../db/client'
import { noteAccessEvent } from './accessEvents'
import { scheduledGrantsResumed, startScheduledGrants } from './scheduledGrants'

let started = false

export function startScheduledGrantsRuntime(): void {
  if (started) return
  started = true
  startScheduledGrants({
    windows: () => electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed()).map((w) => w.webContents.id),
    offsetMinutes: async () => {
      const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.officialTime } })
      return Math.round(parseOfficialTimeConfig(row?.value ?? null).offsetHours * 60)
    },
    event: (kind, fields) => noteAccessEvent(kind, fields)
  })
  // فضای نام (نه import نام‌دار): هارنس آزمون‌ها `powerMonitor` ندارد و این پرونده را از راه ipc/index.ts بار می‌کند.
  try { electron.powerMonitor.on('resume', () => scheduledGrantsResumed()) } catch {}
}
