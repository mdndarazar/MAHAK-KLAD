/**
 * ipc/remoteAuth — کانال‌های remoteAuth:*
 * بدون دست زدن به ipc/index.ts — مستقیم ipcMain.handle
 */
import { BrowserWindow, ipcMain } from 'electron'
import { REMOTE_AUTH_CHANNELS, REMOTE_GT_PREFIX } from '../../shared/remoteAuthChannels'
import { getPending, isGrantActiveForWindow, markUsed, requestCode, revokeAll } from '../services/RemoteGrantRegistry'

export function registerRemoteAuthHandlers() {
  ipcMain.handle(REMOTE_AUTH_CHANNELS.request, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    if (!panel) return { ok: false as const, error: 'پنل مشخص نشده' }
    const owner = (event.sender as any)?.id ?? 0
    const { code, gt } = requestCode(panel, owner)
    return { ok: true as const, data: { code, gt, panel } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.status, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    if (!panel) return { ok: false as const, error: 'پنل مشخص نشده' }
    const owner = (event.sender as any)?.id ?? 0
    const pending = getPending(owner, panel)
    const granted = isGrantActiveForWindow(panel, owner)
    return { ok: true as const, data: { pending: !!pending, code: pending?.code, granted } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.cancel, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = (event.sender as any)?.id ?? 0
    // ساده: revoke همه برای این owner
    if (!panel) revokeAll()
    return { ok: true as const, data: { ok: true } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.used, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = (event.sender as any)?.id ?? 0
    if (panel) markUsed(panel, owner)
    return { ok: true as const, data: { ok: true } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.banner, async (event) => {
    const owner = (event.sender as any)?.id ?? 0
    // بنر ساده — اگر هر grant فعال باشد
    return { ok: true as const, data: { owner } }
  })
}
