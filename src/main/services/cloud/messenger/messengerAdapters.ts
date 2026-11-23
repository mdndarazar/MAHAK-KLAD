/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — دو آداپتور، یک کد (معماری §۴-۱-الف).
 *
 * تلگرام `https://api.telegram.org` و بله `https://tapi.bale.ai` هر دو همان Bot API را دارند:
 * `getMe`، `sendMessage`، `getUpdates`، و برای دکمه‌های ربات (مرحلهٔ ۶) `answerCallbackQuery` و `editMessageText`.
 * فقط درخواست بیرون‌رونده؛ هیچ درگاه شنودی باز نمی‌شود. `fetch` از بیرون داده می‌شود: در برنامه
 * `session.fetch` الکترون (با پراکسی اختیاری فقط برای تلگرام)، در آزمون سرور ساختگی روی loopback.
 *
 * کلید ربات هرگز در متن خطا، لاگ یا نتیجه نمی‌آید.
 */
import { PROVIDER_INFO, type MessengerProvider } from './messengerTypes'

export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<{ status: number; text(): Promise<string> }>

export type ApiResult<T> =
  | { kind: 'ok'; result: T }
  /** ۴۲۹: به اندازهٔ `retry_after` صبر */
  | { kind: 'retry'; afterMs: number }
  /** ۴۰۳: گیرنده ربات را بسته یا گفت‌وگو در دسترس نیست ⇒ گیرندهٔ غیرفعال */
  | { kind: 'forbidden'; description: string }
  /** ۴۰۹: webhook یا برنامهٔ دیگری همان ربات را می‌خواند */
  | { kind: 'conflict'; description: string }
  /** ۴۰۱/۴۰۴: کلید ربات درست نیست */
  | { kind: 'unauthorized'; description: string }
  /** خطای ماندگار درخواست (مثل ۴۰۰) */
  | { kind: 'bad'; status: number; description: string }
  /** شاید به سرور رسیده باشد (قطع وسط کار، پایان مهلت، ۵xx) ⇒ تلاش دوباره با «ممکن است تکراری باشد» */
  | { kind: 'uncertain'; reason: string }
  /** قطعاً نرفت (اتصال برقرار نشد) */
  | { kind: 'unsent'; reason: string }

export interface BotUser { id: number; username?: string; first_name?: string }
export interface BotChat { id: number; type: string; first_name?: string; last_name?: string; username?: string; title?: string }
export interface BotMessage { message_id: number; chat: BotChat; text?: string; date?: number }
/** مرحلهٔ ۶ (دکمه‌های ربات): فشردن دکمهٔ inline؛ `data` همان `callback_data` (حداکثر ۶۴ بایت) است. */
export interface BotCallbackQuery { id: string; from?: { id: number }; message?: BotMessage; data?: string }
export interface BotUpdate { update_id: number; message?: BotMessage; callback_query?: BotCallbackQuery }
/** دکمه‌های inline (فقط `callback_data`؛ هیچ پیوند یا دادهٔ دیگر) */
export interface InlineKeyboard { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

const UNSENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_CONNECT_TIMEOUT|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_NETWORK_ACCESS_DENIED|ERR_NETWORK_CHANGED|ERR_CONNECTION_FAILED/

/** متن خطای شبکه بی کلید ربات و بی نشانی کامل. */
export function redactSecret(text: string, token: string): string {
  let out = String(text ?? '')
  if (token) out = out.split(token).join('***')
  return out.replace(/bot[0-9]{3,20}:[A-Za-z0-9_-]{10,}/g, 'bot***').replace(/[0-9]{3,20}:[A-Za-z0-9_-]{20,}/g, '***').slice(0, 200)
}

function networkFailure(error: unknown, token: string, timedOut: boolean): ApiResult<never> {
  const e = error as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } }
  const text = [e?.code, e?.cause?.code, e?.message, e?.cause?.message].filter(Boolean).join(' ')
  const reason = redactSecret(text || 'network error', token)
  if (timedOut || e?.name === 'AbortError') return { kind: 'uncertain', reason: 'timeout' }
  return UNSENT.test(text) ? { kind: 'unsent', reason } : { kind: 'uncertain', reason }
}

export function createBotApi(provider: MessengerProvider, token: string, fetchImpl: FetchLike, baseUrl: string = PROVIDER_INFO[provider].baseUrl) {
  const root = `${baseUrl.replace(/\/+$/, '')}/bot${token}/`

  async function call<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<ApiResult<T>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      let response: { status: number; text(): Promise<string> }
      try {
        response = await fetchImpl(root + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal
        })
      } catch (error) { return networkFailure(error, token, timedOut) }
      let body: Record<string, unknown> = {}
      try {
        const text = await response.text()
        body = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch (error) {
        if (response.status >= 200 && response.status < 300) return networkFailure(error, token, timedOut)
      }
      const description = redactSecret(typeof body.description === 'string' ? body.description : `HTTP ${response.status}`, token)
      if (response.status === 200 && body.ok === true) return { kind: 'ok', result: body.result as T }
      if (response.status === 429) {
        const params = body.parameters as { retry_after?: unknown } | undefined
        const seconds = Number(params?.retry_after)
        return { kind: 'retry', afterMs: Math.min(3600, Math.max(1, Number.isFinite(seconds) ? seconds : 5)) * 1000 }
      }
      if (response.status === 403) return { kind: 'forbidden', description }
      if (response.status === 409) return { kind: 'conflict', description }
      if (response.status === 401 || response.status === 404) return { kind: 'unauthorized', description }
      if (response.status >= 500) return { kind: 'uncertain', reason: description }
      return { kind: 'bad', status: response.status, description }
    } finally { clearTimeout(timer) }
  }

  return {
    provider,
    getMe: () => call<BotUser>('getMe', {}, 15000),
    /** متن ساده، بی قالب‌بندی (مالک «متن مرتب» را انتخاب کرد، طرح §۲۱)؛ مرحلهٔ ۶: دکمه‌های inline اختیاری */
    sendMessage: (chatId: number, text: string, keyboard?: InlineKeyboard) =>
      call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) }, 15000),
    /** فقط هنگام جفت‌سازی، و با «پاسخ ربات به دکمه‌ها» (مرحلهٔ ۶) پیوسته. `offset` به‌روزرسانی‌های قبلی را تأیید می‌کند. */
    getUpdates: (offset: number, timeoutSec: number, allowed: readonly string[] = ['message']) =>
      call<BotUpdate[]>('getUpdates', { offset, timeout: Math.max(0, Math.min(25, timeoutSec)), allowed_updates: [...allowed] }, (Math.max(0, Math.min(25, timeoutSec)) + 10) * 1000),
    /** مرحلهٔ ۶: پاسخ کوتاه به فشردن دکمه (مثلاً «منقضی شد») */
    answerCallbackQuery: (callbackId: string, text?: string) =>
      call<boolean>('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) }, 10000),
    /** مرحلهٔ ۶: نشان دادن نتیجه روی پیام درخواست (و برداشتن دکمه‌ها) */
    editMessageText: (chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) =>
      call<unknown>('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(keyboard ? { reply_markup: keyboard } : {}) }, 10000)
  }
}
export type BotApi = ReturnType<typeof createBotApi>
