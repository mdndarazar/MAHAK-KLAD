/**
 * ipc/remoteAuth — کانال‌های remoteAuth:*
 * بدون دست زدن به ipc/index.ts — مستقیم ipcMain.handle
 */
import { BrowserWindow, ipcMain } from 'electron'
import { REMOTE_AUTH_CHANNELS, REMOTE_GT_PREFIX, remoteImplementationReady } from '../../shared/remoteAuthChannels'
import { cancelForWindow, getRequestStatus, markUsed, requestCode } from '../services/RemoteGrantRegistry'

export function registerRemoteAuthHandlers() {
  if (!remoteImplementationReady()) return
  ipcMain.handle(REMOTE_AUTH_CHANNELS.request, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    if (!panel) return { ok: false as const, error: 'پنل مشخص نشده' }
    const owner = (event.sender as any)?.id ?? 0
    const { code, gt, requestId } = requestCode(panel, owner)
    return { ok: true as const, data: { code, gt, requestId, panel } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.status, async (event, payload: { panel?: string; requestId?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const requestId = String(payload?.requestId ?? '').trim()
    if (!panel || !requestId) return { ok: false as const, error: 'درخواست مشخص نشده' }
    const owner = (event.sender as any)?.id ?? 0
    return { ok: true as const, data: { state: getRequestStatus(owner, panel, requestId) } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.cancel, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = (event.sender as any)?.id ?? 0
    const ok = cancelForWindow(owner, panel || undefined)
    return ok ? { ok: true as const, data: { ok: true } } : { ok: false as const, error: 'درخواست معتبر نیست' }
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
