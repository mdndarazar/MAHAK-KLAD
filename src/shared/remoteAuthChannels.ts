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
  ping: 'remoteAuth:ping',
  used: 'remoteAuth:used',
} as const

export type RemoteAuthChannel = (typeof REMOTE_AUTH_CHANNELS)[keyof typeof REMOTE_AUTH_CHANNELS]

export type RemoteAuthRequestPayload = { panel: string }
export type RemoteAuthRequestResult = { ok: true; code: string; gt: string } | { ok: false; error: string }
export type RemoteAuthStatusPayload = { panel: string }
export type RemoteAuthStatusResult = { pending: boolean; code?: string; granted: boolean; tier?: string; expiresAt?: number }
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
