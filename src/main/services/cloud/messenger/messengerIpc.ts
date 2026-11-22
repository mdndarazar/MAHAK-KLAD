/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — IPC تنظیمات پیام‌رسان (بخش «اطلاع‌رسانی با تلگرام و بله» در صفحهٔ
 * «کنترل از راه دور با گوشی»).
 *
 *  - فقط از پنجرهٔ اصلی برنامه روی همین رایانه (`isLocalAppFrame`، مثل `remoteSetupIpc.ts`).
 *  - هر تغییر دستهٔ ۱ است: رمز تایپی خود مدیر، با همان گیت و شمارندهٔ قفل `AuthService` (معماری §۳-۱۰).
 *    نشست مدیر، مجوز گوشی یا کد یک‌بارمصرف این‌جا کافی نیست (فروشنده نتواند بی‌صدا خاموشش کند).
 *  - کلید ربات و شناسهٔ گفت‌وگوها هرگز از main برنمی‌گردند.
 */
import { ipcMain } from 'electron'
import bwipjs from 'bwip-js'
import { IPC } from '@shared/ipc'
import { isLocalAppFrame } from '../../../ipc/remoteAuth'
import { MessengerError } from './messengerEngine'
import { installMessengerHooks, messengerEngine, startMessengerAtLaunch } from './messengerRuntime'
import { RECIPIENT_MODES, type MessengerProvider, type RecipientMode } from './messengerTypes'

type Failure = { ok: false; error: string; code: string }
type Result = { ok: true; data: unknown } | Failure
const failure = (code: string, error: string): Failure => ({ ok: false, error, code })
let registered = false
let qrCache: { link: string; dataUrl: string } | null = null

const record = (payload: unknown): Record<string, unknown> | null =>
  payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
const provider = (value: unknown): MessengerProvider | null => (value === 'telegram' || value === 'bale' ? value : null)
const mode = (value: unknown): RecipientMode | null => (RECIPIENT_MODES.includes(value as RecipientMode) ? value as RecipientMode : null)

/** دستهٔ ۱: رمز تایپی مدیر، با همان گیت و قفل پس از اشتباه‌های پیاپی. */
async function managerPassword(input: Record<string, unknown>, action: string): Promise<Failure | null> {
  const password = input.managerPassword
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 256) return failure('MANAGER_PASSWORD', 'رمز مدیر برنامه را وارد کنید.')
  try {
    const auth = await import('../../AuthService')
    await auth.assertManagerPassword(password, action)
    return null
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'رمز مدیر درست نیست.'
    return failure('MANAGER_PASSWORD', message.slice(0, 300))
  }
}

async function statusWithQr() {
  const status = messengerEngine().status()
  let qr: string | null = null
  const link = status.pairing?.link
  if (link) {
    if (qrCache?.link !== link) {
      try {
        const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: link, scale: 4, paddingwidth: 2, paddingheight: 2 } as never)
        qrCache = { link, dataUrl: png.length ? `data:image/png;base64,${png.toString('base64')}` : '' }
      } catch { qrCache = { link, dataUrl: '' } }
    }
    qr = qrCache.dataUrl || null
  }
  return { ...status, pairing: status.pairing ? { ...status.pairing, qr } : null }
}

function handle(channel: string, action: string | null, run: (input: Record<string, unknown>) => Promise<unknown>) {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<Result> => {
    if (!isLocalAppFrame(event)) return failure('FORBIDDEN', 'این کار فقط از پنجرهٔ اصلی برنامه روی همین رایانه ممکن است.')
    const input = record(payload ?? {})
    if (!input) return failure('INVALID', 'ورودی نامعتبر است.')
    try {
      if (action) {
        const denied = await managerPassword(input, action)
        if (denied) return denied
      }
      await run(input)
      return { ok: true, data: await statusWithQr() }
    } catch (error) {
      if (error instanceof MessengerError) return failure(error.code, error.message.slice(0, 400))
      console.error(`[messenger:${channel}]`, error instanceof Error ? error.message : 'failed')
      return failure('FAILED', 'انجام نشد؛ دوباره تلاش کنید.')
    }
  })
}

export function registerMessengerHandlers(): void {
  if (registered) return
  registered = true
  const ACTION = 'تنظیمات پیام‌رسان (تلگرام و بله)'
  handle(IPC.messengerStatus, null, async () => undefined)
  handle(IPC.messengerSaveBot, ACTION, async (input) => {
    const p = provider(input.provider)
    if (!p || typeof input.token !== 'string') throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().saveBot(p, input.token.trim(), input.proxy ?? '')
  })
  handle(IPC.messengerRemoveBot, ACTION, async (input) => {
    const p = provider(input.provider)
    if (!p) throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().removeBot(p)
  })
  handle(IPC.messengerSetEnabled, ACTION, async (input) => {
    if (typeof input.enabled !== 'boolean') throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    const engine = messengerEngine()
    await engine.setEnabled(input.enabled)
    if (engine.isRunning()) installMessengerHooks()
  })
  handle(IPC.messengerSetOptions, ACTION, async (input) => {
    await messengerEngine().setOptions({
      includeCustomerName: typeof input.includeCustomerName === 'boolean' ? input.includeCustomerName : undefined,
      preventSleep: typeof input.preventSleep === 'boolean' ? input.preventSleep : undefined
    })
  })
  handle(IPC.messengerPairStart, ACTION, async (input) => {
    const p = provider(input.provider)
    if (!p) throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().pairStart(p)
  })
  handle(IPC.messengerPairConfirm, ACTION, async (input) => {
    const m = mode(input.mode)
    if (!m) throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().pairConfirm(m)
  })
  handle(IPC.messengerPairCancel, null, async () => { messengerEngine().pairCancel() })
  handle(IPC.messengerRecipientUpdate, ACTION, async (input) => {
    const m = mode(input.mode)
    if (!m || typeof input.id !== 'string') throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().updateRecipient(input.id, m)
  })
  handle(IPC.messengerRecipientRemove, ACTION, async (input) => {
    if (typeof input.id !== 'string') throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().removeRecipient(input.id)
  })
  handle(IPC.messengerTest, null, async (input) => {
    if (typeof input.id !== 'string') throw new MessengerError('INVALID', 'ورودی نامعتبر است.')
    await messengerEngine().sendTest(input.id)
  })
  handle(IPC.messengerResetVault, 'بازنشانی تنظیمات پیام‌رسان', async () => { await messengerEngine().resetVault() })
  startMessengerAtLaunch()
}
