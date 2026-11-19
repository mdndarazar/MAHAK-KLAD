/**
 * Desktop IPC for the owner's remote-control setup page. Registered only when
 * the implementation readiness gate is open; it opens no port by itself. The
 * hub starts only after the owner opt-in is written, and every change requires
 * the manager password, checked in Main by AuthService (same lockout gate).
 *
 * Phone credentials are passed once to the first hub start (the child stores
 * only salted hashes) and are never written by this module.
 */
import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { REMOTE_SETUP_CHANNELS, remoteImplementationReady, type RemoteSetupStatus } from '../../../shared/remoteAuthChannels'
import { isLocalAppFrame } from '../../ipc/remoteAuth'
import { remoteHostState, replaceRemoteOwner, startCloudSync, stopCloudSync } from '../CloudSyncService'
import { remoteSettingEnabled } from './remoteSettings'
import {
  REMOTE_DEFAULT_PORT, RemoteSetupError, createRemoteSetupFiles, remoteSetupFiles, restoreMarkerHash,
  retireRemoteSetup, validateRemoteEndpoint, validateRemoteOwner, writeRemoteSetting, type RemoteOwner
} from './remoteSetup'

type Failure = { ok: false; error: string; code: string }
type Result = { ok: true; data: RemoteSetupStatus } | Failure
const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'این کار فقط از پنجرهٔ اصلی برنامه روی همین رایانه ممکن است.',
  BUSY: 'کار قبلی هنوز تمام نشده است؛ چند ثانیه بعد دوباره تلاش کنید.',
  RESTART: 'خاموش شدن قبلی تأیید نشد. برنامه را کامل ببندید و دوباره باز کنید.',
  NOT_CONFIGURED: 'ابتدا راه‌اندازی را کامل کنید.',
  OWNER_REQUIRED: 'راه‌اندازی نیمه‌کاره است؛ اطلاعات مالک گوشی را دوباره وارد کنید.',
  OWNER_EXISTS: 'مالک گوشی قبلاً ساخته شده است؛ فقط «روشن کردن» لازم است.',
  ALREADY_CONFIGURED: 'کنترل از راه دور قبلاً راه‌اندازی شده است.',
  ORIGIN: 'آدرس باید با https:// شروع شود و فقط نام دامنه باشد (بدون مسیر).',
  PORT: 'پورت باید عددی بین ۱۰۲۴ تا ۶۵۵۳۵ باشد.',
  USERNAME: 'نام کاربری باید ۳ تا ۶۴ نویسه از حرف، عدد، نقطه، خط تیره یا زیرخط باشد.',
  OWNER_PASSWORD: 'رمز گوشی باید دست‌کم ۱۰ نویسه باشد.',
  PIN: 'PIN باید دقیقاً ۶ رقم و متفاوت از رمز گوشی باشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  SECURE_STORAGE: 'ذخیره‌ساز امن ویندوز در دسترس نیست؛ کلیدها ساخته نشدند.',
  NOT_RUNNING: 'ابتدا کنترل از راه دور را روشن کنید؛ عوض کردن اطلاعات ورود مالک فقط وقتی هاب روشن است ممکن است.',
  OWNER_REPLACE: 'اطلاعات ورود مالک عوض نشد. شاید این نام کاربری مال عضو دیگری باشد؛ نام دیگری بزنید و دوباره تلاش کنید.',
  FAILED: 'عملیات انجام نشد.'
}
const failure = (code: string, error = MESSAGES[code] ?? MESSAGES.FAILED): Failure => ({ ok: false, error, code })
let registered = false, operation = false

function status(): RemoteSetupStatus {
  const userData = app.getPath('userData'), files = remoteSetupFiles(userData), host = remoteHostState()
  return {
    ready: remoteImplementationReady(), ...files, enabled: remoteSettingEnabled(userData),
    running: host.running, busy: host.busy || operation, needsRestart: host.needsRestart,
    mobilePort: host.mobilePort, defaultPort: REMOTE_DEFAULT_PORT, error: host.error
  }
}
function record(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
}
async function managerPassword(input: Record<string, unknown>, action: string): Promise<Failure | null> {
  const password = input.managerPassword
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 256) return failure('MANAGER_PASSWORD', 'رمز مدیر برنامه را وارد کنید.')
  try {
    const auth = await import('../AuthService')
    await auth.assertManagerPassword(password, action)
    return null
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'رمز مدیر درست نیست.'
    return failure('MANAGER_PASSWORD', message.slice(0, 300))
  }
}
function setupFailure(error: unknown): Failure {
  if (error instanceof RemoteSetupError) return failure(error.code === 'PASSWORD' ? 'OWNER_PASSWORD' : error.code)
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Secure storage unavailable') return failure('SECURE_STORAGE')
  return failure('FAILED', `${MESSAGES.FAILED} (${message.slice(0, 200)})`)
}
function owner(input: Record<string, unknown>): RemoteOwner {
  return validateRemoteOwner({ username: input.username, password: input.password, pin: input.pin })
}
async function startWith(ownerValue?: RemoteOwner): Promise<Result> {
  await startCloudSync(ownerValue ? { owner: ownerValue } : undefined)
  return { ok: true, data: status() }
}

/** One owner action at a time, only from the local top-level window. */
function handle(channel: string, action: (input: Record<string, unknown>) => Promise<Result>) {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<Result> => {
    if (!remoteImplementationReady() || !isLocalAppFrame(event)) return failure('FORBIDDEN')
    const input = record(payload)
    if (!input) return failure('INVALID_INPUT')
    if (operation) return failure('BUSY')
    operation = true
    try {
      const host = remoteHostState()
      if (host.needsRestart) return failure('RESTART')
      if (host.busy) return failure('BUSY')
      return await action(input)
    } catch (error) { return setupFailure(error) }
    finally { operation = false }
  })
}

export function registerRemoteSetupHandlers(): void {
  if (!remoteImplementationReady() || registered) return
  registered = true
  ipcMain.handle(REMOTE_SETUP_CHANNELS.status, async (event): Promise<Result> =>
    remoteImplementationReady() && isLocalAppFrame(event) ? { ok: true, data: status() } : failure('FORBIDDEN'))

  handle(REMOTE_SETUP_CHANNELS.configure, async input => {
    const userData = app.getPath('userData')
    if (remoteSetupFiles(userData).configured || remoteSetupFiles(userData).partial) return failure('ALREADY_CONFIGURED')
    const endpoint = validateRemoteEndpoint({ origin: input.origin, port: input.port }), ownerValue = owner(input)
    const denied = await managerPassword(input, 'راه‌اندازی کنترل از راه دور')
    if (denied) return denied
    createRemoteSetupFiles(userData, endpoint, safeStorage, restoreMarkerHash(join(userData, 'backups', 'last-restore.txt')))
    writeRemoteSetting(userData, true)
    return await startWith(ownerValue)
  })

  handle(REMOTE_SETUP_CHANNELS.complete, async input => {
    const userData = app.getPath('userData'), files = remoteSetupFiles(userData)
    if (!files.configured) return failure('NOT_CONFIGURED')
    if (input.replace !== undefined) {
      // OWNER recovery at the computer (design §4, physical presence): new
      // phone username, password and PIN for the existing owner. Members stay.
      if (input.replace !== true) return failure('INVALID_INPUT')
      if (files.ownerRequired) return failure('OWNER_REQUIRED')
      const ownerValue = owner(input)
      const denied = await managerPassword(input, 'عوض کردن اطلاعات ورود مالک گوشی')
      if (denied) return denied
      if (!remoteHostState().running) return failure('NOT_RUNNING')
      if (!await replaceRemoteOwner(ownerValue)) return failure('OWNER_REPLACE')
      return { ok: true, data: status() }
    }
    if (!files.ownerRequired) return failure('OWNER_EXISTS')
    const ownerValue = owner(input)
    const denied = await managerPassword(input, 'تکمیل راه‌اندازی کنترل از راه دور')
    if (denied) return denied
    writeRemoteSetting(userData, true)
    return await startWith(ownerValue)
  })

  handle(REMOTE_SETUP_CHANNELS.enable, async input => {
    const userData = app.getPath('userData'), files = remoteSetupFiles(userData)
    if (!files.configured) return failure('NOT_CONFIGURED')
    if (files.ownerRequired) return failure('OWNER_REQUIRED')
    const denied = await managerPassword(input, 'روشن کردن کنترل از راه دور')
    if (denied) return denied
    writeRemoteSetting(userData, true)
    return await startWith()
  })

  handle(REMOTE_SETUP_CHANNELS.disable, async input => {
    const denied = await managerPassword(input, 'خاموش کردن کنترل از راه دور')
    if (denied) return denied
    // The opt-in is cleared first: even if this shutdown is not confirmed, the
    // next application start opens no port.
    writeRemoteSetting(app.getPath('userData'), false)
    try { await stopCloudSync() } catch { return failure('RESTART') }
    return { ok: true, data: status() }
  })

  handle(REMOTE_SETUP_CHANNELS.reset, async input => {
    const denied = await managerPassword(input, 'حذف راه‌اندازی کنترل از راه دور')
    if (denied) return denied
    const userData = app.getPath('userData')
    writeRemoteSetting(userData, false)
    try { await stopCloudSync() } catch { return failure('RESTART') }
    const host = remoteHostState()
    if (host.needsRestart || host.running || host.busy) return failure('RESTART')
    retireRemoteSetup(userData)
    return { ok: true, data: status() }
  })
}
