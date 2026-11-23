/**
 * طرح ۱۴۰۵ §۴-۸ (مورد ۳) — IPC کدهای بازیابی «توقف اضطراری کامل» در صفحهٔ «کنترل از راه دور با گوشی».
 *
 *  - فقط از پنجرهٔ اصلی برنامه روی همین رایانه (`isLocalAppFrame`، مثل `remoteSetupIpc.ts` و پیام‌رسان).
 *  - ساخت و باطل کردن «کلیدسازی» است: رمز تایپی خود مدیر، با همان گیت و شمارندهٔ قفل `AuthService`.
 *    نشست مدیر، مجوز گوشی یا کد یک‌بارمصرف این‌جا کافی نیست.
 *  - هاب باید روشن باشد (کدها در پایگاه دادهٔ هاب، کنار PIN، hash نمک‌دار می‌شوند). کد خام فقط همان یک بار
 *    هنگام ساخت برمی‌گردد؛ وضعیت فقط شمار است.
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { isLocalAppFrame } from '../../ipc/remoteAuth'
import { remoteRecoveryCodes } from '../CloudSyncService'
import { noteAccessEvent } from '../locks/accessEvents'

type Result = { ok: true; data: unknown } | { ok: false; error: string; code: string }
const fail = (code: string, error: string): Result => ({ ok: false, error, code })
const HUB_OFF = 'هاب کنترل از راه دور روشن نیست یا پاسخ نداد؛ اول آن را روشن کنید.'
let registered = false

async function typedManagerPassword(input: Record<string, unknown>, action: string): Promise<Result | null> {
  const password = input.managerPassword
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 256) return fail('MANAGER_PASSWORD', 'رمز مدیر برنامه را وارد کنید.')
  try {
    const auth = await import('../AuthService')
    await auth.assertManagerPassword(password, action)
    return null
  } catch (error) {
    return fail('MANAGER_PASSWORD', (error instanceof Error && error.message ? error.message : 'رمز مدیر درست نیست.').slice(0, 300))
  }
}

async function status(): Promise<Result> {
  const s = await remoteRecoveryCodes('status')
  return s.ok ? { ok: true, data: { running: true, total: s.total ?? 0, remaining: s.remaining ?? 0, lockedUntil: s.lockedUntil ?? 0 } }
    : { ok: true, data: { running: false, total: 0, remaining: 0, lockedUntil: 0 } }
}

export function registerRecoveryCodeHandlers(): void {
  if (registered) return
  registered = true
  const guard = (fn: (input: Record<string, unknown>) => Promise<Result>) => async (event: Electron.IpcMainInvokeEvent, payload: unknown): Promise<Result> => {
    if (!isLocalAppFrame(event)) return fail('FORBIDDEN', 'این کار فقط از پنجرهٔ اصلی برنامه روی همین رایانه ممکن است.')
    const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    try { return await fn(input) } catch { return fail('FAILED', 'انجام نشد؛ دوباره تلاش کنید.') }
  }
  ipcMain.handle(IPC.recoveryCodesStatus, guard(() => status()))
  ipcMain.handle(IPC.recoveryCodesCreate, guard(async (input) => {
    const denied = await typedManagerPassword(input, 'ساخت کدهای بازیابی توقف اضطراری')
    if (denied) return denied
    const made = await remoteRecoveryCodes('create')
    if (!made.ok || !made.codes) return fail('HUB', HUB_OFF)
    noteAccessEvent('RECOVERY_CODES_CREATED', { count: made.codes.length })
    return { ok: true, data: { codes: made.codes } }
  }))
  ipcMain.handle(IPC.recoveryCodesRevoke, guard(async (input) => {
    const denied = await typedManagerPassword(input, 'باطل کردن کدهای بازیابی توقف اضطراری')
    if (denied) return denied
    const done = await remoteRecoveryCodes('revoke')
    if (!done.ok) return fail('HUB', HUB_OFF)
    noteAccessEvent('RECOVERY_CODES_REVOKED', {})
    return status()
  }))
}
