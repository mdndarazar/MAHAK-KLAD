/**
 * ipc/remoteAuth — کانال‌های remoteAuth:*
 * بدون دست زدن به ipc/index.ts — مستقیم ipcMain.handle
 */
import { BrowserWindow, ipcMain } from 'electron'
import { REMOTE_AUTH_CHANNELS, REMOTE_GT_PREFIX, remoteImplementationReady } from '../../shared/remoteAuthChannels'
import { cancelForWindow, getRequestStatus, markUsed, requestCode } from '../services/RemoteGrantRegistry'

// Match the application's other IPC handlers: only a live BrowserWindow may
// own a request. A destroyed renderer must not retain pending requests or grants.
const observed = new WeakSet<Electron.WebContents>()
function ownerOf(event: Electron.IpcMainInvokeEvent): number {
  const sender=event.sender
  const window=sender && BrowserWindow.fromWebContents(sender)
  if (!sender || sender.isDestroyed() || !window || window.isDestroyed() || !Number.isSafeInteger(sender.id) || sender.id<=0)
    throw new Error('Invalid remote request owner')
  const id=sender.id
  if (!observed.has(sender)) {
    observed.add(sender)
    sender.once('destroyed',()=>{
      // Failed cleanups are left revoking and retried by the registry; they
      // cannot be made active by a later request from another window.
      try {cancelForWindow(id)} catch {}
    })
  }
  return id
}

export function registerRemoteAuthHandlers() {
  if (!remoteImplementationReady()) return
  ipcMain.handle(REMOTE_AUTH_CHANNELS.request, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    if (!panel) return { ok: false as const, error: 'پنل مشخص نشده' }
    const owner = ownerOf(event)
    const { code, gt, requestId } = requestCode(panel, owner)
    return { ok: true as const, data: { code, gt, requestId, panel } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.status, async (event, payload: { panel?: string; requestId?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const requestId = String(payload?.requestId ?? '').trim()
    if (!panel || !requestId) return { ok: false as const, error: 'درخواست مشخص نشده' }
    const owner = ownerOf(event)
    return { ok: true as const, data: { state: getRequestStatus(owner, panel, requestId) } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.cancel, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = ownerOf(event)
    const ok = cancelForWindow(owner, panel || undefined)
    return ok ? { ok: true as const, data: { ok: true } } : { ok: false as const, error: 'درخواست معتبر نیست' }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.used, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = ownerOf(event)
    if (panel) markUsed(panel, owner)
    return { ok: true as const, data: { ok: true } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.banner, async (event) => {
    const owner = ownerOf(event)
    // بنر ساده — اگر هر grant فعال باشد
    return { ok: true as const, data: { owner } }
  })
}
