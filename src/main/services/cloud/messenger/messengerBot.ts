/**
 * طرح ۱۴۰۵ · مورد ۱۵ (معماری §۴-۱-ب) — دکمه‌های ربات تلگرام و بله؛ پیش‌فرض خاموش.
 *
 * وقتی «پاسخ ربات به دکمه‌ها» روشن است (کلیدسازی، رمز تایپی مدیر):
 *   ۱) `getUpdates` پیوسته با long polling و تأیید `offset` خوانده می‌شود؛ فقط ارتباط بیرون‌رونده.
 *   ۲) هر درخواست تازهٔ فروشنده برای گیرنده‌های دارای اجازه («می‌تواند درخواست مجوز را تأیید کند») پیام می‌شود:
 *      نام فارسی قفل با نشان «پولی» یا «یک بار»، خط «نوع» (دفتر آزمون ۴-۳۰: کار یک‌باره، ماژول معمولی یا ماژول پولی
 *      و حساس، با نشانهٔ رنگی هر نوع) و برای ماژول «زمان رایانه برای این نوع»، کد ۶ رقمی مقایسه، ساعت، شمارهٔ پنجره و دو
 *      دکمهٔ «✅ تأیید» و «❌ رد». `callback_data` یک نشانهٔ تصادفی یک‌بارمصرف است، نه شناسهٔ درخواست. مبلغ هرگز در این پیام نیست.
 *   ۳) تأیید: گفت‌وگو جفت‌شده و دارای اجازه، نشانه تازه، درخواست هنوز در انتظار، و کنترل از راه دور روشن و بی
 *      توقف اضطراری (P2). سپس همان `createGrant` با سیاست همان قفل؛ عضو `bot-<شناسهٔ گیرنده>`. اولین تصمیم برنده
 *      است و پیام بقیهٔ گیرنده‌ها با `editMessageText` نتیجه را نشان می‌دهد.
 *   ۴) رد: همان لغو درخواست؛ پنجرهٔ فروشنده «مدیر رد کرد» می‌بیند.
 *   ۵) «منو»: «بستن همهٔ مجوزها» (با دکمهٔ دوم «مطمئنم»)، «مجوزهای باز» و «خلاصهٔ امروز».
 *   ۶) هرگز با ربات: P2، بازیابی، تغییر مسئول صندوق، PIN، تنظیمات و هر «کلیدسازی».
 *   ۷) دفتر آزمون ۴-۳۳: فهرست «/» (`setMyCommands`) و گزارش‌ها، فقط برای گیرندهٔ دارای تیک «می‌تواند گزارش‌ها را ببیند»
 *      (جدا از اجازهٔ تأیید): فروش، برگشت از فروش، تعویض، نسیه، کارت‌به‌کارت مدیر و صندوق با «امروز»، «دیروز» یا «وارد
 *      کردن تاریخ» (تا ۳۱ روز، قاعدهٔ گوشی)، و «وضعیت الان»؛ فهرست بلند صفحه‌به‌صفحه با «صفحهٔ بعد». از همان خواننده‌های
 *      گزارش گوشی و خلاصهٔ فروش؛ کد اعتبار، بارکد و تلفن هرگز؛ نام مشتری فقط با تیک خودش. فقط دیدن است.
 * هر تأیید، رد و «بستن همه» یک ردیف `ACCESS_EVENT` با نام گیرنده دارد و همان لحظه به همهٔ گیرنده‌ها خبر داده
 * می‌شود. دکمهٔ کهنه «منقضی شد» می‌گیرد. ۴۰۹ ⇒ خواندن می‌ایستد و ربات به «فقط خبر» برمی‌گردد. هر گفت‌وگو حداکثر
 * یک فرمان در ۵ ثانیه. عضو `bot-<n>` عضو واقعی هاب نیست؛ با P1، P2، خاموش کردن کلید ربات یا برداشتن تیک اجازهٔ
 * همان گیرنده بسته می‌شود.
 */
import { randomBytes } from 'node:crypto'
import { CARD_TRANSFER_STATUS_LABELS } from '@shared/enums'
import { gateEntry } from '@shared/gateCatalog'
import { faDigits, jalaliAddDays, toJalaliDate } from '@shared/jalali'
import { LOCKED_PANELS, LOCK_KIND_SIGNS, LOCK_KIND_TITLES, lockKindOf, panelTitle } from '@shared/panels'
import { PHONE_REPORTS, parsePhoneReportRequest, type PhoneField, type PhoneReportValue, type PhoneValue } from '../phoneReportCatalog'
import type { BotApi, BotCallbackQuery, BotMessage, BotUpdate, InlineKeyboard } from './messengerAdapters'
import type { BotCardTransferPage, BotCustodyNow, BotReturnDoc } from './messengerDb'
import { chainLine, docLineText, type DocLineLite } from './messengerEvents'
import { fmtAt, fmtClock, formatMessage, itemLine, num, rial, scrubText, splitText } from './messengerFormat'
import type { SalesSummaryLike } from './messengerSummary'
import type { MessengerProvider, MessengerRecipient, MessengerSettings } from './messengerTypes'

export interface BotRemoteRequest { requestId: string; code: string; panel: string; ownerWindowId: number; recent?: number }
/** پل به همان مسیر مجوز راه دور روی رایانه (`botRemoteBridge.ts`)؛ در آزمون ساختگی یا با رجیستری واقعی. */
export interface BotRemote {
  pending(): BotRemoteRequest[]
  /** OFF یعنی کنترل از راه دور خاموش است یا P2 فعال است؛ GONE یعنی درخواست دیگر در انتظار نیست */
  approve(req: BotRemoteRequest, memberId: string): Promise<'OK' | 'GONE' | 'OFF'>
  reject(req: BotRemoteRequest): boolean
  closeAll(): void
  openGrants(): Array<{ panel: string; ownerWindowId: number; claimed: boolean; remainingMs: number }>
  revokeMember(memberId: string): void
  /** ردیف `ACCESS_EVENT` نوع `BOT_DECISION` (فقط برچسب ثابت تصمیم، نام گیرنده، نام قفل و پنجره) */
  note(fields: { decision: string; recipientName: string; titleFa?: string; windowNo?: number }): void
  /** دفتر آزمون ۴-۳۰: مدت رایانه برای نوع همین ماژول (دقیقه، ۴-۲۸)؛ قفل کار یا نامعلوم ⇒ null */
  minutesFor?(panel: string): number | null
}

export interface BotContext {
  settings(): MessengerSettings | null
  /** موتور روشن، اعلان‌ها روشن، «پاسخ ربات به دکمه‌ها» روشن و پل راه دور هست */
  active(): boolean
  remote: BotRemote | null
  api(provider: MessengerProvider): BotApi | null
  pairingProvider(): MessengerProvider | null
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** خبر سیستمی به همهٔ گیرنده‌های فعال (صف بیرون از پایگاه داده) و تلاش فوری */
  notifyAll(title: string, lines: string[], important: boolean): Promise<void>
  /** ۴۰۹ هنگام خواندن پیوسته: موتور کلید ربات را خاموش و خبر می‌کند */
  conflict(provider: MessengerProvider): Promise<void>
  summary(): Promise<{ title: string; lines: string[] }>
  offsetHours(): Promise<number>
  now(): number
  log(message: string, error?: unknown): void
  schedule: boolean
  pollSeconds: number
  /** دفتر آزمون ۴-۳۳: منبع گزارش‌ها؛ نباشد ⇒ «گزارش‌ها در دسترس نیست» */
  reports?: BotReportSources | null
}

/** دفتر آزمون ۴-۳۳ — منبع گزارش‌های ربات (موتور می‌سازد). */
export interface BotReportSources {
  /** تیک «نام مشتری هم در پیام بیاید» */
  includeCustomerName(): boolean
  /** همان `salesService.summary` («خلاصهٔ امروز» گوشی و گزارش فروش): جمع‌ها روی کل بازه، ردیف‌ها صفحه‌ای */
  sales(filter: { fromJalali: string; toJalali: string; take: number; skip: number }): Promise<SalesSummaryLike>
  /** یک بخش گزارش گوشی (`readPhoneReport`، فقط فیلدهای ثابت `phoneReportCatalog.ts`) */
  phone(section: 'returns' | 'cashbox', request: { fromDay: string; toDay: string; page: number }, member: string): Promise<PhoneReportValue>
  saleLines(invoiceIds: number[]): Promise<Map<number, DocLineLite[]>>
  /** نام نسیه‌گیرندهٔ روی فاکتور (فقط با تیک نام مشتری خوانده می‌شود) */
  debtorNames(invoiceIds: number[]): Promise<Map<number, string>>
  returnDocs(returnIds: number[]): Promise<Map<number, BotReturnDoc>>
  cardTransfers(fromDay: string, toDay: string, skip: number, take: number): Promise<BotCardTransferPage>
  custodyNow(at: number): Promise<BotCustodyNow>
}

const MEMBER_PREFIX = 'bot-'
export const botMemberId = (recipientId: string): string => `${MEMBER_PREFIX}${recipientId}`
const TOKEN = /^[A-Za-z0-9_-]{22}$/
const COMMAND_GAP_MS = 5000
const CONFIRM_TTL_MS = 2 * 60_000
const OLD_MESSAGE_SEC = 120
const ALLOWED_UPDATES = ['message', 'callback_query'] as const
const MENU_WORDS = new Set(['منو', '/menu', 'menu', '/start'])

// ------------------------------------------------------------------ دفتر آزمون ۴-۳۳: گزارش‌ها
type ReportKey = 's' | 'r' | 'x' | 'c' | 'k' | 'b'
const REPORT_TITLES: Readonly<Record<ReportKey, string>> = Object.freeze({
  s: '🧾 فروش', r: '↩️ برگشت از فروش', x: '🔁 تعویض', c: '📒 نسیه', k: '💳 کارت به کارت مدیر', b: '🧮 صندوق و مغایرت‌ها'
})
const NOW_TITLE = '👤 وضعیت الان'
/** فهرست «/» (`setMyCommands`): همان کارهای منو */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = Object.freeze([
  { command: 'menu', description: 'منوی ربات فروشگاه' },
  { command: 'sales', description: 'فروش: خلاصه و قلم‌ها' },
  { command: 'returns', description: 'برگشت از فروش' },
  { command: 'exchanges', description: 'تعویض' },
  { command: 'credit', description: 'نسیه' },
  { command: 'cardtransfer', description: 'کارت به کارت مدیر' },
  { command: 'cashbox', description: 'صندوق و مغایرت‌ها' },
  { command: 'status', description: 'وضعیت الان' },
  { command: 'today', description: 'خلاصهٔ امروز' },
  { command: 'grants', description: 'مجوزهای باز' },
  { command: 'closeall', description: 'بستن همهٔ مجوزها' }
])
const COMMAND_REPORTS: Readonly<Record<string, ReportKey>> = Object.freeze({ sales: 's', returns: 'r', exchanges: 'x', credit: 'c', cardtransfer: 'k', cashbox: 'b' })
const OTHER_COMMANDS = new Set(['menu', 'start', 'status', 'today', 'grants', 'closeall'])
const REPORT_DATA = /^(?:p:[srxckb]|q:[srxckb]:[tyd]|g:[srxckb]:\d{8}:\d{8}:\d{1,4}|m:now)$/
const INVOICES_PER_PAGE = 8
const ROWS_PER_PAGE = 10
const REPORT_TEXT_LIMIT = 3900
const DATE_TTL_MS = 5 * 60_000
const DATE_TRIES = 3
const CACHE_TTL_MS = 2 * 60_000
const CREDIT_SCAN = 5000
const PHONE_SCAN_PAGES = 20
const MAX_PAGE = 1000
const COMMANDS_RETRY_MS = 60 * 60_000
const NO_APPROVE = 'این گفت‌وگو اجازهٔ تأیید ندارد.'
const NO_REPORTS = 'این گفت‌وگو اجازهٔ دیدن گزارش‌ها را ندارد.'
const DATE_HELP = 'تاریخ را بنویسید، مثل ۱۴۰۵/۰۹/۰۳؛ برای بازه: ۱۴۰۵/۰۹/۰۱ تا ۱۴۰۵/۰۹/۰۳ (حداکثر ۳۱ روز).'

const latinDigits = (s: string): string =>
  s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
const DATE_IN_TEXT = /(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})/g
/** درستی روز و سقف ۳۱ روز با همان قاعدهٔ گوشی (`parsePhoneReportRequest`). */
function rangeCheck(from: string, to: string): 'ok' | 'invalid' | 'long' {
  try {
    parsePhoneReportRequest({ section: 'returns', page: 0, fromDay: from, toDay: to })
    return 'ok'
  } catch (error) {
    return /range/.test(String((error as Error)?.message ?? '')) ? 'long' : 'invalid'
  }
}
/** دفتر آزمون ۴-۳۳ — تاریخ نوشته‌شده: یک روز («۱۴۰۵/۰۹/۰۳») یا بازه («۱۴۰۵/۰۹/۰۱ تا ۱۴۰۵/۰۹/۰۳»)، با رقم فارسی هم. */
export function parseBotDates(input: string): { ok: true; from: string; to: string } | { ok: false; reason: 'invalid' | 'long' } {
  const t = latinDigits(String(input ?? '')).trim()
  const found = [...t.matchAll(DATE_IN_TEXT)].map((m) => `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`)
  const rest = t.replace(DATE_IN_TEXT, ' ').replace(/از|تا|الی|[-–—,،]/g, ' ').trim()
  if (found.length < 1 || found.length > 2 || rest) return { ok: false, reason: 'invalid' }
  const [a, b = a] = found
  const [from, to] = a <= b ? [a, b] : [b, a]
  const check = rangeCheck(from, to)
  return check === 'ok' ? { ok: true, from, to } : { ok: false, reason: check }
}
const day8 = (day: string): string => day.replace(/\//g, '')
const dayOf8 = (s: string): string => `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`
const rangeText = (from: string, to: string): string => (from === to ? faDigits(from) : `از ${faDigits(from)} تا ${faDigits(to)}`)
const amountOf = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')

interface SaleRowView { id: number; receiptNo: number; day: string; time: string; customerName: string; userName: string; grandTotal: number; remaining: number; isExchange: boolean }
/**
 * ردیف‌های گزارش فروش برنامه ⇒ فقط همین چند فیلد (کد برگشت و هر چیز دیگر کنار می‌ماند)، به ترتیب زمان. گزارش صفحه‌ها را از
 * قدیم به تازه می‌بُرد و هر صفحه را برای جدول خودش تازه‌به‌قدیم می‌چیند؛ ربات همان صفحه را به ترتیب زمان می‌آورد تا «صفحهٔ بعد»
 * همیشه فاکتورهای بعدی باشد.
 */
function saleRows(raw: unknown): SaleRowView[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r) => r && typeof r === 'object' && Number.isSafeInteger((r as { id?: unknown }).id)).map((r: any) => ({
    id: r.id, receiptNo: Math.trunc(amountOf(r.receiptNo)), day: clip(r.dateJalali, 16), time: clip(r.time, 8),
    customerName: clip(r.customerName, 80), userName: clip(r.userName, 60), grandTotal: amountOf(r.grandTotal),
    remaining: amountOf(r.remaining), isExchange: r.isExchange === true
  })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : a.receiptNo - b.receiptNo))
}
/** یک ردیف گزارش گوشی با برچسب‌های همان فهرست ثابت («مثل گوشی»)؛ شناسه نمی‌آید. */
function phoneFieldsText(fields: readonly PhoneField[], row: Record<string, PhoneValue>): string {
  const parts: string[] = []
  for (const [key, label, type] of fields) {
    const v = row[key]
    if (key === 'id' || v === null || v === undefined) continue
    const t = type.replace('?', '')
    parts.push(`${label}: ${t === 'amount' ? rial(v) : t === 'int' ? num(v) : t === 'bool' ? (v ? 'بله' : 'خیر') : faDigits(String(v))}`)
  }
  return parts.join(' · ')
}
interface BuiltReport { lines: string[]; pages: number | null; hasMore: boolean }

interface Sent { recipientId: string; provider: MessengerProvider; chatId: number; messageId: number }
interface RequestState { req: BotRemoteRequest; text: string; sentTo: Set<string>; messages: Sent[]; decided: boolean; at: number }
type TokenInfo = { kind: 'a' | 'r'; requestId: string; recipientId: string } | { kind: 'c'; recipientId: string; expiresAt: number }

/** دفتر آزمون ۴-۳۰: خط «نوع» با نشانهٔ رنگی همان نوع (`lockKindOf`، همان مرز کدها و مدت‌ها). */
export function botKindLine(panel: string): string {
  const kind = lockKindOf(panel)
  return `${LOCK_KIND_SIGNS[kind]} نوع: ${LOCK_KIND_TITLES[kind]}${kind === 'action' ? ' (فقط یک بار؛ زمان ندارد)' : ''}`
}

/** عنوان فارسی قفل با نشان «پولی» یا «یک بار» (از همان منبع حقیقت). */
export function botLockTitle(panel: string): string {
  const entry = gateEntry(panel)
  if (entry?.category === 3) return `${entry.titleFa} (یک بار)`
  const def = LOCKED_PANELS.find((p) => p.key === panel)
  return def ? `${def.title}${def.tier === 'money' ? ' (پولی)' : ''}` : panelTitle(panel)
}

export function createBotController(ctx: BotContext) {
  const requests = new Map<string, RequestState>()
  const tokens = new Map<string, TokenInfo>()
  const offsets = new Map<MessengerProvider, number>()
  const lastCommand = new Map<string, number>()
  const loops = new Set<MessengerProvider>()
  let conflictText: string | null = null
  // دفتر آزمون ۴-۳۳: حالت کوتاه‌مدت «منتظر تاریخ»، نسخهٔ دودقیقه‌ای فهرست‌های اسکن‌شده و ثبت فهرست «/» برای هر کلید ربات
  const awaiting = new Map<string, { key: ReportKey; recipientId: string; expiresAt: number; tries: number }>()
  const cache = new Map<string, { at: number; value: unknown }>()
  const commandsSent = new WeakMap<object, { at: number; ok: boolean }>()

  const newToken = () => randomBytes(16).toString('base64url')
  const approvers = (provider?: MessengerProvider): MessengerRecipient[] =>
    (ctx.settings()?.recipients ?? []).filter((r) => r.active && r.canApprove && (!provider || r.provider === provider))
  /** دفتر آزمون ۴-۳۳: گیرنده‌ای که اجازهٔ تأیید یا اجازهٔ دیدن گزارش‌ها دارد */
  const members = (provider?: MessengerProvider): MessengerRecipient[] =>
    (ctx.settings()?.recipients ?? []).filter((r) => r.active && (r.canApprove || r.canViewReports === true) && (!provider || r.provider === provider))
  const memberOf = (provider: MessengerProvider, chatId: unknown): MessengerRecipient | null =>
    members(provider).find((r) => r.chatId === chatId) ?? null

  /** دفتر آزمون ۴-۳۰: مدت رایانه برای نوع همین ماژول (دقیقه، ۱ تا ۱۰۰۰)؛ قفل کار، بی پل یا عدد نادرست ⇒ null. */
  const computerMinutes = (panel: string): number | null => {
    if (lockKindOf(panel) === 'action') return null
    let m: unknown = null
    try { m = ctx.remote?.minutesFor?.(panel) ?? null } catch { m = null }
    return Number.isSafeInteger(m) && (m as number) >= 1 && (m as number) <= 1000 ? (m as number) : null
  }
  /** زمان مجوز برای پیام نتیجه: قفل کار «یک بار»، ماژول همان مدت رایانه. */
  const grantSpan = (panel: string, minutes: number | null): string | null =>
    lockKindOf(panel) === 'action' ? 'یک بار' : minutes !== null ? `${num(minutes)} دقیقه` : null

  /** دفتر آزمون ۴-۳۵: همان قالب یکدست پیام‌ها؛ تاریخ و ساعت در سرتیتر. ۴-۳۰: خط «نوع» و زمان رایانهٔ همان نوع. */
  async function requestText(req: BotRemoteRequest): Promise<string> {
    const offset = await ctx.offsetHours()
    const minutes = computerMinutes(req.panel)
    return formatMessage(`🔐 درخواست مجوز از رایانهٔ فروشگاه · ${fmtAt(ctx.now(), offset)}`, [
      `قفل: ${botLockTitle(req.panel)}`,
      botKindLine(req.panel),
      ...(minutes !== null ? [`⏱ زمان رایانه برای این نوع: ${num(minutes)} دقیقه`] : []),
      `کد مقایسه: ${req.code}`,
      `پنجرهٔ ${num(req.ownerWindowId)}`,
      ...(Number.isSafeInteger(req.recent) && (req.recent as number) > 3 ? [`⚠️ ${num(req.recent as number)} درخواست برای همین قفل در ۱۰ دقیقهٔ اخیر`] : []),
      'کد را با کدی که فروشنده می‌بیند مقایسه کنید.'
    ])
  }
  const keyboardFor = (a: string, r: string): InlineKeyboard => ({ inline_keyboard: [[{ text: '✅ تأیید', callback_data: `a:${a}` }, { text: '❌ رد', callback_data: `r:${r}` }]] })

  async function editAll(state: RequestState, footer: string): Promise<void> {
    for (const sent of state.messages) {
      const api = ctx.api(sent.provider)
      if (!api) continue
      try { await api.editMessageText(sent.chatId, sent.messageId, `${state.text}\n\n${footer}`) } catch (error) { ctx.log('bot edit failed', error) }
    }
  }
  function dropTokens(requestId: string): void {
    for (const [t, info] of tokens) if (info.kind !== 'c' && info.requestId === requestId) tokens.delete(t)
  }

  /** درخواست‌های تازه ⇒ پیام با دو دکمه؛ درخواستی که دیگر در انتظار نیست ⇒ ویرایش «دیگر در انتظار نیست». */
  async function announce(): Promise<void> {
    const remote = ctx.remote
    if (!remote) return
    let list: BotRemoteRequest[] = []
    try { list = remote.pending() } catch { list = [] }
    const ids = new Set(list.map((p) => p.requestId))
    for (const [id, state] of requests) {
      if (ids.has(id) || state.decided) continue
      state.decided = true
      dropTokens(id)
      await editAll(state, '⌛ این درخواست دیگر در انتظار نیست (پذیرفته، لغو یا منقضی شد).')
    }
    for (const [id, state] of requests) if (state.decided && ctx.now() - state.at > 30 * 60_000) requests.delete(id)
    const who = approvers()
    for (const req of list) {
      let state = requests.get(req.requestId)
      if (!state) {
        state = { req, text: await requestText(req), sentTo: new Set(), messages: [], decided: false, at: ctx.now() }
        requests.set(req.requestId, state)
      }
      if (state.decided) continue
      for (const r of who) {
        if (state.sentTo.has(r.id)) continue
        const api = ctx.api(r.provider)
        if (!api) continue
        const a = newToken(), rj = newToken()
        const result = await api.sendMessage(r.chatId, state.text, keyboardFor(a, rj))
        if (result.kind !== 'ok' || !Number.isSafeInteger(result.result?.message_id)) continue
        state.sentTo.add(r.id)
        state.messages.push({ recipientId: r.id, provider: r.provider, chatId: r.chatId, messageId: result.result.message_id })
        tokens.set(a, { kind: 'a', requestId: req.requestId, recipientId: r.id })
        tokens.set(rj, { kind: 'r', requestId: req.requestId, recipientId: r.id })
      }
    }
  }

  const answer = async (provider: MessengerProvider, cq: BotCallbackQuery, text?: string) => {
    try { await ctx.api(provider)?.answerCallbackQuery(cq.id, text) } catch {}
  }
  async function expired(provider: MessengerProvider, cq: BotCallbackQuery): Promise<void> {
    await answer(provider, cq, 'منقضی شد')
    const message = cq.message
    if (message && Number.isSafeInteger(message.chat?.id) && Number.isSafeInteger(message.message_id)) {
      const base = typeof message.text === 'string' && message.text ? `${message.text.split('\n\n⌛')[0]}\n\n` : ''
      try { await ctx.api(provider)?.editMessageText(message.chat.id, message.message_id, `${base}⌛ منقضی شد.`) } catch {}
    }
  }
  const rateLimited = (provider: MessengerProvider, chatId: number): boolean => {
    const key = `${provider}:${chatId}`, t = ctx.now(), last = lastCommand.get(key) ?? -Infinity
    if (t - last < COMMAND_GAP_MS && t >= last) return true
    lastCommand.set(key, t)
    return false
  }

  async function menu(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    const rows: InlineKeyboard['inline_keyboard'] = []
    if (r.canApprove) rows.push([{ text: '🔒 بستن همهٔ مجوزها', callback_data: 'm:close' }])
    // دفتر آزمون ۴-۳۳: دکمه‌های گزارش فقط با تیک خودش؛ ردیف نخست هرگز دو دکمه ندارد (شکل پیام درخواست مجوز)
    if (r.canViewReports) rows.push(
      [{ text: REPORT_TITLES.s, callback_data: 'p:s' }],
      [{ text: REPORT_TITLES.r, callback_data: 'p:r' }, { text: REPORT_TITLES.x, callback_data: 'p:x' }],
      [{ text: REPORT_TITLES.c, callback_data: 'p:c' }, { text: REPORT_TITLES.k, callback_data: 'p:k' }],
      [{ text: REPORT_TITLES.b, callback_data: 'p:b' }, { text: NOW_TITLE, callback_data: 'm:now' }]
    )
    if (r.canApprove) rows.push([{ text: '📋 مجوزهای باز', callback_data: 'm:list' }])
    rows.push([{ text: '📊 خلاصهٔ امروز', callback_data: 'm:sum' }])
    await ctx.api(provider)?.sendMessage(r.chatId, '🤖 منوی ربات فروشگاه', { inline_keyboard: rows })
  }
  function grantLines(): string[] {
    let grants: ReturnType<BotRemote['openGrants']> = []
    try { grants = ctx.remote?.openGrants() ?? [] } catch { grants = [] }
    return grants.length
      ? grants.map((g) => `• ${botLockTitle(g.panel)} · پنجرهٔ ${num(g.ownerWindowId)} · ${g.claimed ? 'باز' : 'تأییدشده، هنوز باز نشده'} · ${num(Math.max(1, Math.ceil(g.remainingMs / 60_000)))} دقیقه`)
      : ['الان هیچ مجوز راه دوری باز نیست.']
  }
  async function openList(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    await ctx.api(provider)?.sendMessage(r.chatId, formatMessage(`📋 مجوزهای باز · ${fmtAt(ctx.now(), await ctx.offsetHours())}`, grantLines()))
  }
  async function sendSummary(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    // دفتر آزمون ۴-۳۵: قالب یکدست؛ متن بلند چند پیام می‌شود و چیزی بریده نمی‌شود
    try { const s = await ctx.summary(); await sendLong(provider, r.chatId, formatMessage(s.title, s.lines)) } catch (error) { ctx.log('bot summary failed', error) }
  }
  async function askCloseAll(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    const t = newToken()
    tokens.set(t, { kind: 'c', recipientId: r.id, expiresAt: ctx.now() + CONFIRM_TTL_MS })
    await ctx.api(provider)?.sendMessage(r.chatId, 'همهٔ مجوزهای راه دور و قفل‌های بازشده با کد یا مجوز بسته شوند؟ (تا ۲ دقیقه)', { inline_keyboard: [[{ text: '✅ مطمئنم، همه را ببند', callback_data: `c:${t}` }]] })
  }

  // ------------------------------------------------------------------ دفتر آزمون ۴-۳۳: گزارش‌ها
  const chatKey = (provider: MessengerProvider, chatId: number): string => `${provider}:${chatId}`
  const memberName = (r: MessengerRecipient): string => `ربات: ${r.name}`.slice(0, 64)
  /** روز شمسی خود رایانه (همان روزی که گزارش‌های برنامه و گوشی با آن می‌سنجند) */
  const systemDay = (at: number): string => toJalaliDate(new Date(at))
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const t = ctx.now(), hit = cache.get(key)
    if (hit && t >= hit.at && t - hit.at < CACHE_TTL_MS) return hit.value as T
    const value = await load()
    if (cache.size >= 32) for (const [k, v] of cache) if (t < v.at || t - v.at >= CACHE_TTL_MS) cache.delete(k)
    if (cache.size >= 32) cache.clear()
    cache.set(key, { at: t, value })
    return value
  }
  /** متن بلند سر مرز خط چند پیام می‌شود؛ دکمه روی آخرین پیام. لایهٔ دوم محرمانگی همان `scrubText` پیام‌هاست. */
  async function sendLong(provider: MessengerProvider, chatId: number, body: string, keyboard?: InlineKeyboard): Promise<void> {
    const api = ctx.api(provider)
    if (!api) return
    const parts = splitText(scrubText(body), REPORT_TEXT_LIMIT)
    for (let i = 0; i < parts.length; i++) await api.sendMessage(chatId, parts[i], i === parts.length - 1 ? keyboard : undefined)
  }
  async function askDay(provider: MessengerProvider, r: MessengerRecipient, key: ReportKey): Promise<void> {
    await ctx.api(provider)?.sendMessage(r.chatId, `${REPORT_TITLES[key]}\nکدام روز؟`, { inline_keyboard: [[
      { text: 'امروز', callback_data: `q:${key}:t` }, { text: 'دیروز', callback_data: `q:${key}:y` }, { text: 'وارد کردن تاریخ', callback_data: `q:${key}:d` }
    ]] })
  }
  const invoiceHead = (icon: string, row: SaleRowView, withName: boolean, extra = ''): string =>
    `${icon} فاکتور ${num(row.receiptNo)}${row.isExchange ? ' (سند تعویض)' : ''} · ${faDigits(row.day)} ساعت ${faDigits(row.time)} · ${rial(row.grandTotal)}${extra}` +
    `${withName && row.customerName ? ` · مشتری: ${row.customerName}` : ''}${row.userName ? ` · فروشنده: ${row.userName}` : ''}`
  async function phoneRows(r: MessengerRecipient, provider: MessengerProvider, from: string, to: string): Promise<{ rows: Record<string, PhoneValue>[]; truncated: boolean }> {
    return cached(`${chatKey(provider, r.chatId)}:returns:${from}:${to}`, async () => {
      const rows: Record<string, PhoneValue>[] = []
      for (let page = 0; page < PHONE_SCAN_PAGES; page++) {
        const v = await ctx.reports!.phone('returns', { fromDay: from, toDay: to, page }, memberName(r))
        rows.push(...v.rows)
        if (!v.hasMore) return { rows, truncated: false }
      }
      return { rows, truncated: true }
    })
  }

  async function buildReport(provider: MessengerProvider, r: MessengerRecipient, key: ReportKey, from: string, to: string, page: number): Promise<BuiltReport> {
    const src = ctx.reports!
    const withName = src.includeCustomerName()
    const lines: string[] = []
    if (key === 's') {
      // همان گزارش فروش برنامه (salesService.summary): جمع‌ها روی کل بازه و فاکتورها صفحه‌به‌صفحه
      const res = await src.sales({ fromJalali: from, toJalali: to, take: INVOICES_PER_PAGE, skip: page * INVOICES_PER_PAGE })
      const count = Math.max(0, Math.trunc(amountOf(res.count)))
      const rows = saleRows(res.rows)
      if (page === 0) lines.push(
        `شمار فاکتور: ${num(count)} · جمع فروش: ${rial(res.grandTotal)}`,
        `نقد: ${rial(res.cashTotal)} · کارتخوان: ${rial(res.cardTotal)} · حساب مدیر: ${rial(res.managerAccountTotal)}`,
        `سایر (چک و…): ${rial(res.otherTotal)} · نسیه: ${rial(res.creditTotal)}`
      )
      const docs = rows.length ? await src.saleLines(rows.map((x) => x.id)) : new Map<number, DocLineLite[]>()
      for (const row of rows) lines.push('', invoiceHead('🧾', row, withName), ...(docs.get(row.id) ?? []).map(docLineText))
      if (!count) lines.push('در این بازه فاکتوری نیست.')
      return { lines, pages: Math.max(1, Math.ceil(count / INVOICES_PER_PAGE)), hasMore: (page + 1) * INVOICES_PER_PAGE < count }
    }
    if (key === 'c') {
      // نسیه: فاکتورهای همین بازه که هنوز مانده دارند؛ «مانده» همان عدد گزارش فروش برنامه (تنها فرمول بدهی)
      const all = await cached(`${chatKey(provider, r.chatId)}:credit:${from}:${to}`, async () => {
        const res = await src.sales({ fromJalali: from, toJalali: to, take: CREDIT_SCAN, skip: 0 })
        const rows = saleRows(res.rows)
        return { rows: rows.filter((x) => x.remaining > 0), truncated: rows.length < Math.trunc(amountOf(res.count)) }
      })
      const slice = all.rows.slice(page * INVOICES_PER_PAGE, (page + 1) * INVOICES_PER_PAGE)
      if (page === 0) {
        lines.push(`فاکتورهای این بازه که هنوز مانده دارند: ${num(all.rows.length)} · جمع مانده: ${rial(all.rows.reduce((sum, x) => sum + x.remaining, 0))}`)
        if (all.truncated) lines.push(`فقط ${num(CREDIT_SCAN)} فاکتور نخست بازه بررسی شد؛ بازه را کوچک‌تر کنید.`)
      }
      const docs = slice.length ? await src.saleLines(slice.map((x) => x.id)) : new Map<number, DocLineLite[]>()
      // نام کسی که نسیه برد (نسیه‌گیرندهٔ روی فاکتور، وگرنه مشتری)، فقط با تیک نام مشتری
      const debtors = withName && slice.length ? await src.debtorNames(slice.map((x) => x.id)) : new Map<number, string>()
      for (const row of slice) {
        const named = { ...row, customerName: debtors.get(row.id) ?? row.customerName }
        lines.push('', invoiceHead('📒', named, withName, ` · مانده: ${rial(row.remaining)}`), ...(docs.get(row.id) ?? []).map(docLineText))
      }
      if (!all.rows.length) lines.push('در این بازه فاکتور نسیهٔ مانده‌دار نیست.')
      return { lines, pages: Math.max(1, Math.ceil(all.rows.length / INVOICES_PER_PAGE)), hasMore: (page + 1) * INVOICES_PER_PAGE < all.rows.length }
    }
    if (key === 'r' || key === 'x') {
      // همان بخش «برگشت‌ها و تعویض‌ها»ی گوشی (فهرست تب برگشت برنامه)؛ قلم‌ها از خود سند
      const scan = await phoneRows(r, provider, from, to)
      const want = key === 'x' ? 'تعویض' : 'برگشت'
      const all = scan.rows.filter((row) => row.kind === want)
      const slice = all.slice(page * INVOICES_PER_PAGE, (page + 1) * INVOICES_PER_PAGE)
      if (page === 0) {
        lines.push(`شمار در این بازه: ${num(all.length)}`)
        if (scan.truncated) lines.push(`فقط ${num(PHONE_SCAN_PAGES * PHONE_REPORTS.returns.pageSize)} سند نخست بازه خوانده شد؛ بازه را کوچک‌تر کنید.`)
      }
      const docs = slice.length ? await src.returnDocs(slice.map((row) => Number(row.id))) : new Map<number, BotReturnDoc>()
      for (const row of slice) {
        const doc = docs.get(Number(row.id))
        const head = `${key === 'x' ? '🔁 تعویض' : '↩️ برگشت'} · سند ${num(row.id)}${row.receiptNo != null ? ` · فاکتور ${num(row.receiptNo)}` : ''} · ${faDigits(String(row.returnedAtJalali ?? ''))} ساعت ${faDigits(String(row.time ?? ''))}`
        lines.push('', head)
        if (key === 'r') {
          lines.push(`مبلغ برگشت: ${rial(row.total)} · بازپرداخت: ${String(row.refundMethodLabel ?? '')}${amountOf(row.refundAmount) ? ` ${rial(row.refundAmount)}` : ''}`)
        } else {
          lines.push(`جمع کالای برگشتی: ${rial(row.total)}${doc?.exchangeGrandTotal != null ? ` · مبلغ فاکتور جایگزین: ${rial(doc.exchangeGrandTotal)}` : ''}`)
          lines.push(`مابه‌التفاوت: ${rial(row.exchangeDiff)}${row.exchangeSettlementLabel ? ` · ${String(row.exchangeSettlementLabel)}` : ''}`)
        }
        if (amountOf(row.storeCreditTotal)) lines.push(`اعتبار خرید: ${rial(row.storeCreditTotal)}`)
        if (withName && row.customerName) lines.push(`مشتری: ${String(row.customerName)}`)
        lines.push(`فروشندهٔ فاکتور: ${String(row.invoiceUserName ?? '')} · ثبت‌کننده: ${String(row.returnUserName ?? '')}`)
        if (key === 'x' && doc) {
          const chain = chainLine(doc.chain)
          if (chain) lines.push(chain)
          lines.push('کالای برگشتی:', ...doc.lines.map(docLineText))
          lines.push(`کالای جایگزین${doc.exchangeReceiptNo != null ? ` (فاکتور ${num(doc.exchangeReceiptNo)})` : ''}:`, ...(doc.replacement ?? []).map(docLineText))
        } else if (doc?.lines.length) lines.push(...doc.lines.map(docLineText))
        else if (row.items) lines.push(`کالاها: ${faDigits(String(row.items))}`)
      }
      if (!all.length) lines.push(key === 'x' ? 'در این بازه تعویضی نیست.' : 'در این بازه برگشتی نیست.')
      return { lines, pages: Math.max(1, Math.ceil(all.length / INVOICES_PER_PAGE)), hasMore: (page + 1) * INVOICES_PER_PAGE < all.length }
    }
    if (key === 'k') {
      // خوانندهٔ تازهٔ فقط‌خواندنی (همان شرط فهرست کارت‌به‌کارت برنامه)؛ شمارهٔ کارت مشتری با ۴-۳۴
      const res = await src.cardTransfers(from, to, page * ROWS_PER_PAGE, ROWS_PER_PAGE)
      if (page === 0) {
        lines.push(`شمار ردیف‌ها در این بازه: ${num(res.total)}`)
        if (res.pendingBefore.count) lines.push(`در انتظار پرداخت از روزهای قبل: ${num(res.pendingBefore.count)} درخواست · جمع ${rial(res.pendingBefore.total)}`)
      }
      for (const row of res.rows) {
        lines.push('',
          `💳 ${row.kind === 'ADJUSTMENT' ? `رویداد اصلاحی${row.adjustsRequestId != null ? ` درخواست ${num(row.adjustsRequestId)}` : ''}` : `درخواست ${num(row.id)}`} · ${CARD_TRANSFER_STATUS_LABELS[row.status] ?? row.status} · ${faDigits(row.createdAtJalali)} ساعت ${faDigits(row.createdAtTime)}`,
          `برای ${row.operationKind === 'EXCHANGE' ? 'تعویض' : 'برگشت'} سند ${num(row.returnId)}${row.sourceReceiptNo != null ? ` · فاکتور ${num(row.sourceReceiptNo)}` : ''}${row.exchangeReceiptNo != null ? ` · فاکتور تعویض ${num(row.exchangeReceiptNo)}` : ''}`,
          `مبلغ: ${rial(row.amount)}${row.userName ? ` · فروشنده: ${row.userName}` : ''}`)
        if (row.paid) lines.push(`پرداخت: ${rial(row.paidAmount ?? row.amount)} · ${faDigits(row.paidAtJalali)} ساعت ${faDigits(row.paidAtTime)}${row.paidByUserName ? ` · ${row.paidByUserName}` : ''}`)
        lines.push(...row.items.map((i) => itemLine(i.name, i.qty, i.unitPrice)))
      }
      if (!res.total) lines.push('در این بازه کارت به کارتی نیست.')
      return { lines, pages: Math.max(1, Math.ceil(res.total / ROWS_PER_PAGE)), hasMore: (page + 1) * ROWS_PER_PAGE < res.total }
    }
    // key === 'b': همان بخش «بستن‌های صندوق» گوشی، با برچسب‌های همان فهرست ثابت
    const size = PHONE_REPORTS.cashbox.pageSize
    const phonePage = Math.floor((page * ROWS_PER_PAGE) / size), at = (page * ROWS_PER_PAGE) % size
    const v = await src.phone('cashbox', { fromDay: from, toDay: to, page: phonePage }, memberName(r))
    const count = v.totals && Number.isSafeInteger(v.totals.count) ? (v.totals.count as number) : null
    if (page === 0) lines.push(...(count !== null ? [`شمار در این بازه: ${num(count)}`] : []), ...v.lines)
    for (const row of v.rows.slice(at, at + ROWS_PER_PAGE)) lines.push(`• ${phoneFieldsText(PHONE_REPORTS.cashbox.row, row)}`)
    if (!v.rows.length && page === 0) lines.push('در این بازه بستن صندوقی نیست.')
    return { lines, pages: count !== null ? Math.max(1, Math.ceil(count / ROWS_PER_PAGE)) : null, hasMore: at + ROWS_PER_PAGE < v.rows.length || v.hasMore }
  }

  async function runReport(provider: MessengerProvider, r: MessengerRecipient, key: ReportKey, from: string, to: string, page: number): Promise<void> {
    if (!ctx.reports) { await ctx.api(provider)?.sendMessage(r.chatId, 'گزارش‌ها روی این رایانه در دسترس نیست.'); return }
    let built: BuiltReport
    try {
      built = await buildReport(provider, r, key, from, to, page)
    } catch (error) {
      ctx.log('bot report failed', error)
      await ctx.api(provider)?.sendMessage(r.chatId, `${REPORT_TITLES[key]}: گزارش الان خوانده نشد؛ کمی بعد دوباره بزنید.`)
      return
    }
    const pageLine = built.hasMore || page > 0 ? [`صفحهٔ ${num(page + 1)}${built.pages ? ` از ${num(built.pages)}` : ''}`] : []
    const sub = page === 0 ? [`زمان گزارش: ${fmtAt(ctx.now(), await ctx.offsetHours())}`] : pageLine
    const next = built.hasMore && page < MAX_PAGE
      ? { inline_keyboard: [[{ text: 'صفحهٔ بعد ◀️', callback_data: `g:${key}:${day8(from)}:${day8(to)}:${page + 1}` }]] }
      : undefined
    // دفتر آزمون ۴-۳۵: سرتیتر، خط زیرش، برچسب‌های نشانه‌دار و قلم‌های شماره‌دار (`formatMessage`)
    await sendLong(provider, r.chatId, formatMessage(`${REPORT_TITLES[key]} · ${rangeText(from, to)}`, [...sub, ...built.lines, ...(page === 0 ? pageLine : [])]), next)
  }
  async function nowReport(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    if (!ctx.reports) { await ctx.api(provider)?.sendMessage(r.chatId, 'گزارش‌ها روی این رایانه در دسترس نیست.'); return }
    let lines: string[]
    try {
      const s = await ctx.reports.custodyNow(ctx.now())
      const offset = await ctx.offsetHours()
      lines = [`${NOW_TITLE} · ${fmtAt(ctx.now(), offset)}`]
      if (s.holder) {
        lines.push(`صندوق دست ${s.holder.name || 'نامشخص'} است، از ${fmtAt(s.holder.since, offset)}${s.holder.shiftName ? ` · شیفت: ${s.holder.shiftName}` : ''}` +
          `${s.holder.scheduledEndAt ? ` · پایان برنامهٔ شیفت: ساعت ${fmtClock(s.holder.scheduledEndAt, offset)}` : ''}`)
      } else {
        lines.push('الان صندوق دست کسی نیست.')
        lines.push(s.openShifts.length ? `شیفت‌های باز: ${s.openShifts.map((x) => `${x.name}${x.userName ? ` (${x.userName})` : ''} از ${fmtAt(x.since, offset)}`).join('، ')}` : 'شیفت بازی نیست.')
      }
      if (s.handoverPending) lines.push('یک تحویل صندوق در انتظار پذیرش است.')
      lines.push('مجوزهای باز:', ...grantLines())
    } catch (error) {
      ctx.log('bot status failed', error)
      lines = [`${NOW_TITLE}: الان خوانده نشد؛ کمی بعد دوباره بزنید.`]
    }
    await sendLong(provider, r.chatId, formatMessage(lines[0], lines.slice(1)))
  }
  /** دکمه‌های گزارش (`p:`، `q:`، `g:`، `m:now`)؛ اجازه پیش‌تر سنجیده شده است. */
  async function onReportButton(provider: MessengerProvider, cq: BotCallbackQuery, r: MessengerRecipient, data: string): Promise<void> {
    if (data === 'm:now') { await answer(provider, cq); await nowReport(provider, r); return }
    const [kind, key, a, b, c] = data.split(':') as [string, ReportKey, string, string?, string?]
    if (kind === 'p') { await answer(provider, cq); await askDay(provider, r, key); return }
    if (kind === 'q') {
      await answer(provider, cq)
      if (a === 'd') {
        awaiting.set(chatKey(provider, r.chatId), { key, recipientId: r.id, expiresAt: ctx.now() + DATE_TTL_MS, tries: 0 })
        await ctx.api(provider)?.sendMessage(r.chatId, `${REPORT_TITLES[key]}\n${DATE_HELP}`)
        return
      }
      const today = systemDay(ctx.now())
      const day = a === 'y' ? jalaliAddDays(today, -1) : today
      await runReport(provider, r, key, day, day, 0)
      return
    }
    // g: «صفحهٔ بعد» (بازهٔ همان گزارش در خود دکمه)
    const from = dayOf8(a), to = dayOf8(b ?? ''), page = Number(c)
    if (from > to || rangeCheck(from, to) !== 'ok' || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) { await expired(provider, cq); return }
    await answer(provider, cq)
    await runReport(provider, r, key, from, to, page)
  }
  /** پاسخ «وارد کردن تاریخ» (حالت کوتاه‌مدت همان گفت‌وگو). */
  async function onDateText(provider: MessengerProvider, r: MessengerRecipient, text: string): Promise<void> {
    const key = chatKey(provider, r.chatId), wait = awaiting.get(key)
    if (!wait) return
    if (ctx.now() > wait.expiresAt || wait.recipientId !== r.id || !r.canViewReports) { awaiting.delete(key); return }
    const parsed = parseBotDates(text)
    if (!parsed.ok) {
      wait.tries += 1
      const last = wait.tries >= DATE_TRIES
      if (last) awaiting.delete(key)
      await ctx.api(provider)?.sendMessage(r.chatId, `${parsed.reason === 'long' ? 'بازه بیشتر از ۳۱ روز است.' : 'تاریخ درست نیست.'} ${last ? 'دوباره از منو شروع کنید.' : DATE_HELP}`)
      return
    }
    awaiting.delete(key)
    await runReport(provider, r, wait.key, parsed.from, parsed.to, 0)
  }
  /** فهرست «/» برای هر کلید ربات یک بار (ناموفق ⇒ حداکثر هر ساعت یک بار دوباره)؛ نتیجه کار ربات را عوض نمی‌کند. */
  function registerCommands(provider: MessengerProvider): void {
    const api = ctx.api(provider)
    if (!api || typeof api.setMyCommands !== 'function') return
    const last = commandsSent.get(api)
    if (last && (last.ok || (ctx.now() >= last.at && ctx.now() - last.at < COMMANDS_RETRY_MS))) return
    commandsSent.set(api, { at: ctx.now(), ok: false })
    void api.setMyCommands(BOT_COMMANDS).then((result) => { if (result.kind === 'ok') commandsSent.set(api, { at: ctx.now(), ok: true }) }).catch(() => undefined)
  }

  async function onCallback(provider: MessengerProvider, cq: BotCallbackQuery): Promise<void> {
    const chatId = cq.message?.chat?.id
    if (typeof cq.id !== 'string' || !cq.id) return
    if (cq.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId)) { await answer(provider, cq); return }
    const r = memberOf(provider, chatId)
    if (!r) { await answer(provider, cq, NO_APPROVE); return }
    const data = typeof cq.data === 'string' ? cq.data : ''
    const report = REPORT_DATA.test(data)
    if (rateLimited(provider, chatId as number)) { await answer(provider, cq, report ? 'کمی صبر کنید؛ هر ۵ ثانیه یک فرمان.' : undefined); return }
    if (data === 'm:sum') { await answer(provider, cq); await sendSummary(provider, r); return }
    // دفتر آزمون ۴-۳۳: گزارش‌ها فقط با تیک «می‌تواند گزارش‌ها را ببیند»؛ بقیهٔ دکمه‌ها فقط با اجازهٔ تأیید
    if (report) {
      if (!r.canViewReports) { await answer(provider, cq, NO_REPORTS); return }
      await onReportButton(provider, cq, r, data)
      return
    }
    if (!r.canApprove) { await answer(provider, cq, NO_APPROVE); return }
    if (data === 'm:list') { await answer(provider, cq); await openList(provider, r); return }
    if (data === 'm:close') { await answer(provider, cq); await askCloseAll(provider, r); return }
    const m = /^([arc]):(.+)$/.exec(data)
    if (!m || !TOKEN.test(m[2])) { await expired(provider, cq); return }
    const info = tokens.get(m[2])
    if (!info || info.kind !== m[1] || info.recipientId !== r.id) { await expired(provider, cq); return }
    if (info.kind === 'c') {
      tokens.delete(m[2])
      if (ctx.now() > info.expiresAt) { await expired(provider, cq); return }
      try { ctx.remote?.closeAll() } catch (error) { ctx.log('bot close-all failed', error) }
      ctx.remote?.note({ decision: 'بستن همه', recipientName: r.name })
      await answer(provider, cq, 'همه بسته شد')
      try { if (cq.message) await ctx.api(provider)?.editMessageText(r.chatId, cq.message.message_id, '🔒 همهٔ مجوزها و قفل‌های باز بسته شد.') } catch {}
      await ctx.notifyAll('🤖 «بستن همهٔ مجوزها» با ربات', [`گیرنده: ${r.name}`], true)
      return
    }
    const state = requests.get(info.requestId)
    if (!state || state.decided) { tokens.delete(m[2]); await expired(provider, cq); return }
    const remote = ctx.remote
    if (!remote) { await expired(provider, cq); return }
    const stillPending = (() => { try { return remote.pending().some((p) => p.requestId === state.req.requestId && p.ownerWindowId === state.req.ownerWindowId && p.panel === state.req.panel) } catch { return false } })()
    if (!stillPending) {
      state.decided = true; dropTokens(state.req.requestId)
      await expired(provider, cq)
      await editAll(state, '⌛ این درخواست دیگر در انتظار نیست.')
      return
    }
    const title = botLockTitle(state.req.panel)
    if (info.kind === 'a') {
      const outcome = await remote.approve(state.req, botMemberId(r.id))
      if (outcome === 'OFF') { await answer(provider, cq, 'کنترل از راه دور خاموش است یا توقف اضطراری فعال است؛ تأیید ممکن نیست.'); return }
      if (state.decided) { await expired(provider, cq); return }
      state.decided = true; dropTokens(state.req.requestId)
      if (outcome !== 'OK') { await expired(provider, cq); await editAll(state, '⌛ این درخواست دیگر در انتظار نیست.'); return }
      remote.note({ decision: 'تأیید', recipientName: r.name, titleFa: title, windowNo: state.req.ownerWindowId })
      await answer(provider, cq, 'تأیید شد')
      // دفتر آزمون ۴-۳۰: نتیجه برای بقیهٔ گیرنده‌ها و خبر همه، با نوع و زمان (همان تنظیمات رایانه)
      const span = grantSpan(state.req.panel, computerMinutes(state.req.panel))
      await editAll(state, `✅ تأیید شد (${r.name})${span ? ` · ${span}` : ''} · ${fmtAt(ctx.now(), await ctx.offsetHours())}`)
      await ctx.notifyAll('🤖 درخواست مجوز با ربات تأیید شد', [`قفل: ${title}`, botKindLine(state.req.panel),
        ...(span ? [`⏱ زمان: ${span}${lockKindOf(state.req.panel) === 'action' ? '' : ' (همان تنظیمات رایانه)'}`] : []),
        `پنجرهٔ ${num(state.req.ownerWindowId)}`, `گیرنده: ${r.name}`], true)
      return
    }
    if (!remote.reject(state.req)) { state.decided = true; dropTokens(state.req.requestId); await expired(provider, cq); return }
    state.decided = true; dropTokens(state.req.requestId)
    remote.note({ decision: 'رد', recipientName: r.name, titleFa: title, windowNo: state.req.ownerWindowId })
    await answer(provider, cq, 'رد شد')
    await editAll(state, `❌ رد شد (${r.name}) · ${fmtAt(ctx.now(), await ctx.offsetHours())}`)
    await ctx.notifyAll('🤖 درخواست مجوز با ربات رد شد', [`قفل: ${title}`, botKindLine(state.req.panel), `پنجرهٔ ${num(state.req.ownerWindowId)}`, `گیرنده: ${r.name}`], true)
  }

  async function onMessage(provider: MessengerProvider, message: BotMessage): Promise<void> {
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (message.chat?.type !== 'private' || !text) return
    if (Number.isSafeInteger(message.date) && ctx.now() / 1000 - (message.date as number) > OLD_MESSAGE_SEC) return
    const r = memberOf(provider, message.chat.id)
    if (!r) return
    // دفتر آزمون ۴-۳۳: فرمان‌های فهرست «/» (با یا بی «@نام ربات»)؛ متن دیگر فقط پاسخ «وارد کردن تاریخ» است
    const command = /^\/([a-z]{1,32})(?:@[A-Za-z0-9_]{1,64})?$/.exec(text)?.[1] ?? null
    const known = MENU_WORDS.has(text) || (command !== null && (command in COMMAND_REPORTS || OTHER_COMMANDS.has(command)))
    if (!known) { await onDateText(provider, r, text); return }
    if (rateLimited(provider, message.chat.id)) return
    if (MENU_WORDS.has(text) || command === 'menu' || command === 'start') { await menu(provider, r); return }
    const say = (line: string) => ctx.api(provider)?.sendMessage(r.chatId, line)
    if (command === 'today') { await sendSummary(provider, r); return }
    if (command === 'status' || (command !== null && command in COMMAND_REPORTS)) {
      if (!r.canViewReports) { await say(NO_REPORTS); return }
      if (command === 'status') await nowReport(provider, r)
      else await askDay(provider, r, COMMAND_REPORTS[command!])
      return
    }
    if (!r.canApprove) { await say(NO_APPROVE); return }
    if (command === 'grants') await openList(provider, r)
    else if (command === 'closeall') await askCloseAll(provider, r)
  }

  /** یک دسته به‌روزرسانی (درون `exclusive` موتور). */
  async function handle(provider: MessengerProvider, updates: BotUpdate[]): Promise<void> {
    for (const update of updates) {
      try {
        if (update?.callback_query) await onCallback(provider, update.callback_query)
        else if (update?.message) await onMessage(provider, update.message)
      } catch (error) { ctx.log('bot update failed', error) }
    }
  }

  const canPoll = (provider: MessengerProvider): boolean =>
    ctx.active() && !!ctx.api(provider) && members(provider).length > 0 && ctx.pairingProvider() !== provider

  /** یک بار خواندن (آزمون‌ها این را صدا می‌زنند؛ در برنامه حلقهٔ هر پیام‌رسان). */
  async function pollOnce(provider: MessengerProvider, timeoutSec = ctx.pollSeconds): Promise<'ok' | 'idle' | 'conflict' | 'error'> {
    if (!canPoll(provider)) return 'idle'
    const api = ctx.api(provider)!
    const offset = offsets.get(provider) ?? 0
    const result = await api.getUpdates(offset, timeoutSec, ALLOWED_UPDATES)
    if (result.kind === 'conflict') {
      conflictText = 'ربات جای دیگری در حال استفاده است (اتصال یا برنامهٔ دیگر)؛ پاسخ ربات به دکمه‌ها خاموش شد.'
      await ctx.exclusive(() => ctx.conflict(provider))
      return 'conflict'
    }
    if (result.kind !== 'ok' || !Array.isArray(result.result)) return 'error'
    let next = offset
    for (const u of result.result) if (Number.isSafeInteger(u?.update_id)) next = Math.max(next, u.update_id + 1)
    offsets.set(provider, next)
    if (result.result.length && canPoll(provider)) await ctx.exclusive(() => handle(provider, result.result))
    return 'ok'
  }
  function loop(provider: MessengerProvider): void {
    if (!ctx.schedule || loops.has(provider)) return
    loops.add(provider)
    void (async () => {
      try {
        while (canPoll(provider)) {
          let outcome: Awaited<ReturnType<typeof pollOnce>>
          try { outcome = await pollOnce(provider) } catch (error) { ctx.log('bot poll failed', error); outcome = 'error' }
          if (outcome === 'conflict') break
          if (outcome === 'error') await new Promise((r) => setTimeout(r, 3000))
        }
      } finally { loops.delete(provider) }
    })()
  }

  return {
    /** هر دور حلقهٔ موتور (درون `exclusive`): پیام درخواست‌ها و راه‌اندازی خواندن پیوسته. */
    async tick(): Promise<void> {
      if (!ctx.active()) return
      for (const [t, info] of tokens) if (info.kind === 'c' && ctx.now() > info.expiresAt) tokens.delete(t)
      await announce()
      for (const provider of ['telegram', 'bale'] as const) if (canPoll(provider)) { registerCommands(provider); loop(provider) }
    },
    pollOnce,
    /** خاموش شدن کلید ربات یا برداشتن اجازه: مجوزهای همان گیرنده(ها) بسته و پیام‌های در انتظار «بسته شد». */
    async revoke(recipientIds: string[], footer: string): Promise<void> {
      for (const id of recipientIds) { try { ctx.remote?.revokeMember(botMemberId(id)) } catch (error) { ctx.log('bot revoke failed', error) } }
      for (const [t, info] of tokens) if (recipientIds.includes(info.recipientId)) tokens.delete(t)
      for (const [k, wait] of awaiting) if (recipientIds.includes(wait.recipientId)) awaiting.delete(k)
      for (const state of requests.values()) {
        if (state.decided) continue
        const mine = state.messages.filter((s) => recipientIds.includes(s.recipientId))
        for (const sent of mine) { try { await ctx.api(sent.provider)?.editMessageText(sent.chatId, sent.messageId, `${state.text}\n\n${footer}`) } catch {} }
        state.messages = state.messages.filter((s) => !recipientIds.includes(s.recipientId))
      }
    },
    clearConflict(): void { conflictText = null },
    status: () => ({ conflict: conflictText })
  }
}
export type BotController = ReturnType<typeof createBotController>
