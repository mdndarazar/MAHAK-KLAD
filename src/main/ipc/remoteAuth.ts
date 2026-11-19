/**
 * ipc/remoteAuth — کانال‌های remoteAuth:*
 * بدون دست زدن به ipc/index.ts — مستقیم ipcMain.handle
 */
import { BrowserWindow, ipcMain } from 'electron'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_AUTH_CHANNELS, REMOTE_GT_PREFIX, remoteImplementationReady } from '../../shared/remoteAuthChannels'
import { cancelForWindow, claimRemotePanel, getRequestStatus, remoteRegistryInitialized, requestCode } from '../services/RemoteGrantRegistry'

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

// The production main build is code-split: this module may run from
// out/main/chunks, while the renderer always sits next to the entry script
// (out/main/index.js -> out/renderer/index.html). Without an entry script
// (isolated test bundles) the module's own directory is used.
function rendererBase(): string {
  const entry = typeof require !== 'undefined' ? require.main?.filename : undefined
  return entry ? dirname(entry) : __dirname
}
/** True only for the application's own renderer page. File URLs are compared
 * as decoded paths, case-insensitively on Windows: Chromium canonicalizes the
 * URL that loadFile() produces, and its percent-encoding of characters in the
 * install path (a Persian Windows user name, spaces, brackets) may differ from
 * Node's. Any other scheme, host, file, or an undecodable URL is rejected. */
export function isOwnRendererPage(value: string, expectedFile?: string, windows: boolean = process.platform === 'win32'): boolean {
  try {
    const actual = new URL(value), dev = process.env.ELECTRON_RENDERER_URL
    if (dev) {
      const expected = new URL(dev)
      return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
    }
    if (actual.protocol !== 'file:' || actual.host !== '') return false
    const path = windows ? win32 : posix, file = expectedFile ?? join(rendererBase(), '../renderer/index.html')
    if (!path.isAbsolute(file)) return false
    const found = path.normalize(fileURLToPath(actual, { windows })), wanted = path.normalize(file)
    return windows ? found.toLowerCase() === wanted.toLowerCase() : found === wanted
  } catch { return false }
}
/** Only the application's own top-level renderer page may call owner-only
 * remote IPC: not a subframe, another page or a destroyed window. */
export function isLocalAppFrame(event: Electron.IpcMainInvokeEvent): boolean {
  try {
    ownerOf(event)
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
    return isOwnRendererPage(event.senderFrame.url)
  } catch { return false }
}

/** `panels`, when given, are the only panels a request may be made for: the
 * hub has an approval policy for no other panel, so a request for one could
 * be shown on the phone but never approved. */
export function registerRemoteAuthHandlers(recover?: (password:string, pin:string)=>Promise<boolean>, panels?: readonly string[]) {
  // Readiness alone is not enough: only a host that initialized the registry
  // (after the owner opt-in and before starting its hub) may expose grant IPC.
  if (!remoteImplementationReady() || !remoteRegistryInitialized()) return
  if (recover) ipcMain.handle(REMOTE_AUTH_CHANNELS.recover, async (event, payload: unknown) => {
    ownerOf(event)
    // Only the top-level local application window can request recovery; mobile
    // pages, subframes and destroyed windows cannot invoke this path.
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return {ok:false as const,error:'بازیابی ممکن نیست.'}
    if (!isOwnRendererPage(event.senderFrame.url)) return {ok:false as const,error:'بازیابی ممکن نیست.'}
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {ok:false as const,error:'بازیابی ممکن نیست.'}
    const {password,pin}=payload as Record<string,unknown>
    if (typeof password!=='string' || !password || Buffer.byteLength(password,'utf8')>128 ||
        typeof pin!=='string' || !/^[0-9]{6}$/.test(pin)) return {ok:false as const,error:'بازیابی ممکن نیست.'}
    try {
      return await recover(password,pin) ? {ok:true as const,data:{ok:true}} : {ok:false as const,error:'بازیابی تأیید نشد.'}
    } catch { return {ok:false as const,error:'بازیابی تأیید نشد.'} }
  })
  ipcMain.handle(REMOTE_AUTH_CHANNELS.request, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    if (!panel) return { ok: false as const, error: 'پنل مشخص نشده' }
    const owner = ownerOf(event)
    if (panels && !panels.includes(panel)) return { ok: false as const, error: 'این پنل با تأیید گوشی باز نمی‌شود.' }
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

  ipcMain.handle(REMOTE_AUTH_CHANNELS.claim, async (event, payload: { panel?: string; requestId?: string; gt?: string }) => {
    const owner = ownerOf(event)
    const panel = typeof payload?.panel === 'string' ? payload.panel : ''
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
    const gt = typeof payload?.gt === 'string' ? payload.gt : ''
    if (!/^gt-[A-Za-z0-9_-]{43}$/.test(gt) || !await claimRemotePanel(owner,panel,requestId,gt.slice(REMOTE_GT_PREFIX.length)))
      return { ok: false as const, error: 'مجوز راه دور نامعتبر یا منقضی شده است.' }
    return { ok: true as const, data: { scope: 'PANEL' as const } }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.cancel, async (event, payload: { panel?: string }) => {
    const panel = String(payload?.panel ?? '').trim()
    const owner = ownerOf(event)
    const ok = cancelForWindow(owner, panel || undefined)
    return ok ? { ok: true as const, data: { ok: true } } : { ok: false as const, error: 'درخواست معتبر نیست' }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.used, async (event) => {
    ownerOf(event)
    // A renderer-supplied keepalive is not evidence of authorized activity.
    // The panel-session guard touches the grant on a real protected operation.
    return { ok: false as const, error: 'تمدید مجوز فقط با استفادهٔ معتبر از پنل انجام می‌شود.' }
  })

  ipcMain.handle(REMOTE_AUTH_CHANNELS.banner, async (event) => {
    const owner = ownerOf(event)
    // بنر ساده — اگر هر grant فعال باشد
    return { ok: true as const, data: { owner } }
  })
}
