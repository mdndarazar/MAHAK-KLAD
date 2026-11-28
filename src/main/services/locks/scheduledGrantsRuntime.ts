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
import { custodyService } from '../CustodyService'
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
    event: (kind, fields) => noteAccessEvent(kind, fields),
    // دفتر آزمون ۴-۴۷ (TL-D13): فقط خواندن؛ صندوق دست کیست (مسئول بخش فعال حضانت، مثل تحویل در انتظار) و کارمندان فعال
    custody: async () => {
      if (!(await custodyService.enabled())) return { enabled: false, holder: null }
      const state = await prisma.custodyState.findUnique({ where: { key: 'MAIN' } })
      if (!state?.activeShiftId || (state.state !== 'ACTIVE' && state.state !== 'HANDOVER_PENDING')) return { enabled: true, holder: null }
      const [shift, meta] = await Promise.all([prisma.shift.findUnique({ where: { id: state.activeShiftId } }), prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })])
      return { enabled: true, holder: shift && !shift.closedAt && shift.userId && meta?.custodianUserId === shift.userId ? shift.userId : null }
    },
    staff: async () => (await custodyService.staffList()).filter((u) => u.isActive).map((u) => ({ id: u.id, name: String(u.name ?? '') }))
  })
  // فضای نام (نه import نام‌دار): هارنس آزمون‌ها `powerMonitor` ندارد و این پرونده را از راه ipc/index.ts بار می‌کند.
  try { electron.powerMonitor.on('resume', () => scheduledGrantsResumed()) } catch {}
}
