/**
 * Minimal, live Electron sender for main-IPC integration tests. The production
 * sessionOwnerOf gate must stay strict: tests supply a real-looking event and
 * only this registered sender maps to a window (a null/foreign sender fails).
 * Printer tests can still construct their own separate hidden BrowserWindows.
 */
export function attachTestIpcWindow(electron, id = 80101) {
  const sender = { id, isDestroyed: () => false, once: () => {} }
  const window = { isDestroyed: () => false }
  const original = electron.BrowserWindow.fromWebContents
  electron.BrowserWindow.fromWebContents = (contents) =>
    contents === sender ? window : original?.call(electron.BrowserWindow, contents) ?? null
  return { sender, event: { sender }, owner: id }
}
