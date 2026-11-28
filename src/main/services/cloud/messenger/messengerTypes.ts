/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — پیام‌رسان (تلگرام و بله): نوع‌ها، ثابت‌ها و اعتبارسنجی.
 *
 * معماری §۴-۱ و §۴-۱-الف. این پرونده به Electron و پایگاه داده وابسته نیست تا آزمون‌ها
 * و رابط هر دو بتوانند همین تعریف‌ها را بخوانند.
 */
import { randomBytes } from 'node:crypto'

export type MessengerProvider = 'telegram' | 'bale'
export const MESSENGER_PROVIDERS: readonly MessengerProvider[] = ['telegram', 'bale']

/**
 * سقف‌ها برای هر آداپتور جدا (معماری §۴-۱-الف). برای بله هم محافظه‌کارانه: ۱ پیام در ثانیه
 * برای هر گفت‌وگو و ۴۰۹۶ نویسه، تا در آزمون مالک سنجیده شود.
 */
export const PROVIDER_INFO: Readonly<Record<MessengerProvider, {
  label: string
  baseUrl: string
  maxLength: number
  minIntervalMs: number
  /** پراکسی اختیاری (فقط تلگرام؛ سرورهای بله داخل ایران‌اند) */
  proxy: boolean
  /** پیوند `?start=` مستند است (فقط تلگرام؛ در بله فرستادن کد راه پیش‌فرض است) */
  deepLink: boolean
}>> = Object.freeze({
  telegram: { label: 'تلگرام', baseUrl: 'https://api.telegram.org', maxLength: 4096, minIntervalMs: 1000, proxy: true, deepLink: true },
  bale: { label: 'بله', baseUrl: 'https://tapi.bale.ai', maxLength: 4096, minIntervalMs: 1000, proxy: false, deepLink: false }
})

export type RecipientMode = 'all' | 'handover' | 'important'
export const RECIPIENT_MODES: readonly RecipientMode[] = ['all', 'handover', 'important']
export const RECIPIENT_MODE_LABELS: Readonly<Record<RecipientMode, string>> = Object.freeze({
  all: 'همه موارد',
  handover: 'تحویل شیفت',
  important: 'فقط موارد مهم ⚠️'
})
/** برچسب اعتماد در رابط (طرح §۲۴-۳، مورد ۱۳) */
export const RECIPIENT_MODE_TRUST: Readonly<Record<RecipientMode, string>> = Object.freeze({
  all: 'تلاش حداکثری؛ مرجع، گزارش‌های خود برنامه است',
  handover: 'کامل: هر بستن صندوق یک پیام',
  important: 'فقط رویدادهای حساس و هشدارها'
})

export interface MessengerRecipient {
  /** شناسهٔ داخلی تصادفی (نام پروندهٔ صف) */
  id: string
  provider: MessengerProvider
  chatId: number
  /** نام نمایشی گفت‌وگو هنگام جفت‌سازی */
  name: string
  mode: RecipientMode
  active: boolean
  inactiveReason: string | null
  addedAt: number
  /** مرحلهٔ ۶ (دکمه‌های ربات): اجازهٔ تأیید درخواست مجوز؛ پیش‌فرض خاموش */
  canApprove: boolean
  /** دفتر آزمون ۴-۳۳: اجازهٔ دیدن گزارش‌ها با ربات، جدا از اجازهٔ تأیید؛ پیش‌فرض خاموش (کلید ناموجود = خاموش) */
  canViewReports: boolean
}

export interface MessengerBot {
  /** کلید ربات؛ فقط در گاوصندوق رمزشده. هرگز در لاگ، پیام، IPC یا صفحه نمی‌آید. */
  token: string
  username: string
  /** فقط تلگرام: مثلاً `socks5://127.0.0.1:10808`؛ خالی یعنی شبکهٔ خود ویندوز */
  proxy: string
}

export interface MessengerSettings {
  version: 1
  enabled: boolean
  bots: { telegram?: MessengerBot; bale?: MessengerBot }
  recipients: MessengerRecipient[]
  /** نام مشتری به‌طور پیش‌فرض نمی‌آید (طرح §۲۶-۲، افزودهٔ ۲۷) */
  includeCustomerName: boolean
  /** «تا برنامه باز است، رایانه به خواب نرود» (powerSaveBlocker)؛ پیش‌فرض خاموش */
  preventSleep: boolean
  /** مرحلهٔ ۶: «پاسخ ربات به دکمه‌ها»؛ پیش‌فرض خاموش */
  botButtons: boolean
}

export const defaultMessengerSettings = (): MessengerSettings => ({
  version: 1,
  enabled: false,
  bots: {},
  recipients: [],
  includeCustomerName: false,
  preventSleep: false,
  botButtons: false
})

/** یک رویداد پیام‌شدنی (پیش از رفتن به صف هر گیرنده). */
export interface MessengerEvent {
  /** کد رویداد کوتاه و ثابت؛ پیام تکراری همان کد را دارد */
  code: string
  /** زمان خود رویداد (ms)؛ انقضای ۲۴ ساعته از همین زمان است */
  at: number
  title: string
  lines: string[]
  /** ⚠️ رویداد حساس */
  important: boolean
  /** جزو «تحویل شیفت» */
  handover: boolean
  /** خبر سیستمی: به همهٔ گیرنده‌ها، با هر گزینه */
  system: boolean
  /** پیام فروش (برای خط «شمار پیام‌های فروش فرستاده‌شده» در خلاصهٔ ساعت ۲۴) */
  sale?: boolean
  /** روز شمسی رویداد (برای شمارش فروش‌های فرستاده‌شده) */
  day?: string | null
}

/** یک خانهٔ صف یک گیرنده روی دیسک. */
export interface OutboxItem {
  code: string
  at: number
  title: string
  lines: string[]
  important: boolean
  /** نتیجهٔ ارسال قبلی نامعلوم بود ⇒ «ممکن است تکراری باشد» */
  maybeDup: boolean
  sale: boolean
  day: string | null
  /** پس از خطای ۴۰۰ در یک پیام چندتایی، تنها فرستاده شود */
  single?: boolean
  /** نشانهٔ «بازگردانی یا ادغام در جریان» که هنوز فرستادنی نیست (معماری §۴-۱) */
  hold?: boolean
}

export interface RecipientStats {
  lastSuccessAt: number | null
  lastError: string | null
  /** منقضی‌شده‌هایی که خبرشان هنوز نرفته است */
  expiredPending: { count: number; fromAt: number; toAt: number } | null
  expiredTotal: number
  failedTotal: number
  /** شمار پیام‌های فروش فرستاده‌شده به این گیرنده، به روز رویداد */
  saleSent: { day: string; n: number } | null
}
export const emptyStats = (): RecipientStats => ({ lastSuccessAt: null, lastError: null, expiredPending: null, expiredTotal: 0, failedTotal: 0, saleSent: null })

export const QUEUE_TTL_MS = 24 * 3600_000
export const LATE_AFTER_MS = 5 * 60_000
export const PAIRING_TTL_MS = 10 * 60_000
export const READ_PAGE = 200
export const READ_PAGES_PER_PASS = 3
export const READ_GAP_MS = 5000
export const HEARTBEAT_MS = 60_000
export const OUTBOX_MAX = 3000
/** فاصلهٔ تلاش دوباره پس از قطعی شبکه: از ۵ ثانیه تا ۶۰ ثانیه */
export const BACKOFF_MIN_MS = 5000
export const BACKOFF_MAX_MS = 60_000

/** کدام رویداد به کدام گیرنده برسد (معماری §۴-۱: سه گزینه). */
export function eventForMode(ev: Pick<MessengerEvent, 'important' | 'handover' | 'system'>, mode: RecipientMode): boolean {
  if (ev.system || mode === 'all') return true
  if (mode === 'handover') return ev.handover
  return ev.important
}

const PROXY = /^(https?|socks4|socks5):\/\/[A-Za-z0-9.-]{1,253}:(\d{1,5})$/
/** پراکسی اختیاری تلگرام: خالی، یا `http|https|socks4|socks5://host:port`. نادرست ⇒ null */
export function normalizeProxy(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return ''
  const m = PROXY.exec(value)
  if (!m) return null
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? value : null
}

/** شکل کلید ربات در تلگرام و بله: `<شناسهٔ عددی>:<رشته>` */
export function validBotToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9]{3,20}:[A-Za-z0-9_-]{20,128}$/.test(raw)
}

export const newRecipientId = (): string => randomBytes(6).toString('hex')

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** کد یک‌بارمصرف جفت‌سازی: ۸ نویسه، بی نویسه‌های گیج‌کننده (۰/O، ۱/I). در `?start=` هم مجاز است. */
export function newPairCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (const b of bytes) out += PAIR_ALPHABET[b % PAIR_ALPHABET.length]
  return out
}

function validRecipient(v: unknown): v is MessengerRecipient {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return typeof r.id === 'string' && /^[a-f0-9]{12}$/.test(r.id) &&
    (r.provider === 'telegram' || r.provider === 'bale') &&
    Number.isSafeInteger(r.chatId) && (r.chatId as number) > 0 &&
    typeof r.name === 'string' && r.name.length <= 200 &&
    RECIPIENT_MODES.includes(r.mode as RecipientMode) &&
    typeof r.active === 'boolean' && (r.inactiveReason === null || typeof r.inactiveReason === 'string') &&
    Number.isSafeInteger(r.addedAt) && typeof r.canApprove === 'boolean' &&
    (r.canViewReports === undefined || typeof r.canViewReports === 'boolean')
}
function validBot(v: unknown, provider: MessengerProvider): v is MessengerBot {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const b = v as Record<string, unknown>
  if (!validBotToken(b.token) || typeof b.username !== 'string' || b.username.length > 100 || typeof b.proxy !== 'string') return false
  return provider === 'bale' ? b.proxy === '' : normalizeProxy(b.proxy) === b.proxy
}

/** خواندن سخت‌گیر تنظیمات از گاوصندوق. هر چیز ناشناخته ⇒ null (یعنی «خراب»؛ fail-closed). */
export function parseMessengerSettings(raw: unknown): MessengerSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (s.version !== 1 || typeof s.enabled !== 'boolean' || typeof s.includeCustomerName !== 'boolean' ||
      typeof s.preventSleep !== 'boolean' || typeof s.botButtons !== 'boolean') return null
  const bots = s.bots
  if (!bots || typeof bots !== 'object' || Array.isArray(bots)) return null
  const out: MessengerSettings = { ...defaultMessengerSettings(), enabled: s.enabled, includeCustomerName: s.includeCustomerName, preventSleep: s.preventSleep, botButtons: s.botButtons }
  for (const [key, value] of Object.entries(bots as Record<string, unknown>)) {
    if (key !== 'telegram' && key !== 'bale') return null
    if (!validBot(value, key)) return null
    out.bots[key] = { token: value.token, username: value.username, proxy: value.proxy }
  }
  if (!Array.isArray(s.recipients) || s.recipients.length > 50) return null
  const ids = new Set<string>()
  for (const r of s.recipients) {
    if (!validRecipient(r) || ids.has(r.id)) return null
    ids.add(r.id)
    out.recipients.push({ id: r.id, provider: r.provider, chatId: r.chatId, name: r.name, mode: r.mode, active: r.active, inactiveReason: r.inactiveReason, addedAt: r.addedAt, canApprove: r.canApprove, canViewReports: r.canViewReports === true })
  }
  return out
}
