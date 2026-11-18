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

export const REMOTE_GT_PREFIX = 'gt-'
export const REMOTE_GT_PREFIX_LEN = 3

/** This is a code-readiness gate, not a user setting. Do not enable until the
 * hub, identity, replay protection, grants and rollback are complete and tested. */
export function remoteImplementationReady(): boolean {
  return false
}
