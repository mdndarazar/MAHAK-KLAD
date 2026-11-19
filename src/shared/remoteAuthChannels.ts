/**
 * کانال‌های IPC راه دور — فقط نام ثابت، بدون منطق
 * فاز ۲-۳: درخواست مجوز + وضعیت + بنر
 */
export const REMOTE_AUTH_CHANNELS = {
  request: 'remoteAuth:request',
  status: 'remoteAuth:status',
  cancel: 'remoteAuth:cancel',
  banner: 'remoteAuth:banner',
  claim: 'remoteAuth:claim',
  recover: 'remoteAuth:recover',
  ping: 'remoteAuth:ping',
  used: 'remoteAuth:used',
} as const

export type RemoteAuthChannel = (typeof REMOTE_AUTH_CHANNELS)[keyof typeof REMOTE_AUTH_CHANNELS]

export type RemoteAuthRequestPayload = { panel: string }
// Renderer call() unwraps the IPC envelope; these types describe its data.
export type RemoteAuthRequestResult = { code: string; gt: string; requestId: string; panel: string }
export type RemoteAuthStatusPayload = { panel: string; requestId: string }
export type RemoteAuthStatusResult = { state: 'PENDING' | 'APPROVED' | 'CLAIMED' | 'UNAVAILABLE' }
export type RemoteGrantCommand = {
  reqId: string
  panel: string
  ownerWindowId: number
  tier: 'NORMAL' | 'SENSITIVE_MONEY'
  ttlMs: number
  idleMs: number
  sig: string
  nonce: string
}

/** Owner setup page on the desktop. Main accepts these only from the app's own
 * top-level window, and every change requires the manager password there. */
export const REMOTE_SETUP_CHANNELS = {
  status: 'remoteSetup:status',
  configure: 'remoteSetup:configure',
  complete: 'remoteSetup:complete',
  enable: 'remoteSetup:enable',
  disable: 'remoteSetup:disable',
  reset: 'remoteSetup:reset',
} as const
/** No secrets, keys or credentials. `error` is the last startup failure text. */
export type RemoteSetupStatus = {
  ready: boolean; configured: boolean; partial: boolean; ownerRequired: boolean; enabled: boolean
  running: boolean; busy: boolean; needsRestart: boolean; origin: string | null; port: number | null
  mobilePort: number | null; defaultPort: number; error: string | null
}
export type RemoteSetupConfigurePayload = { managerPassword: string; origin: string; port: number; username: string; password: string; pin: string }

export const REMOTE_GT_PREFIX = 'gt-'
export const REMOTE_GT_PREFIX_LEN = 3

/** Code-readiness gate, not a user setting. Open since stage 4: the hub,
 * identity, replay protection, grants, Panic and database fencing are wired and
 * tested. Remote access still starts only after the owner's explicit opt-in
 * (`userData/remote-settings.json` exactly `{"enabled":true}`; default off). */
export function remoteImplementationReady(): boolean {
  return true
}
