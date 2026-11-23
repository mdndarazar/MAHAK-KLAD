/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — موتور پیام‌رسان: خواندن رویدادها، صف هر گیرنده، ارسال، جفت‌سازی و تنظیمات.
 *
 * قاعده‌های سخت (معماری §۴-۱):
 *  - پیش‌فرض خاموش؛ خاموش یعنی هیچ اتصالی، هیچ زمان‌سنجی و هیچ خواندنی.
 *  - هرگز جلوی فروش را نمی‌گیرد: حلقهٔ جدا، فقط خواندن از پایگاه داده، و هیچ خطایی به مسیر مالی نمی‌رسد.
 *  - صف ۲۴ ساعته از زمان رویداد؛ حذف بی‌صدا ممنوع («N پیام منقضی شد»)؛ ۱ پیام در ثانیه برای هر گفت‌وگو؛
 *    ۴۲۹ با `retry_after`؛ ۴۰۳ یعنی گیرندهٔ غیرفعال؛ نتیجهٔ نامعلوم با «ممکن است تکراری باشد» و همان کد.
 *  - هر تغییر تنظیمات پیش از اعمال به همهٔ گیرنده‌ها خبر داده می‌شود. رمز مدیر را لایهٔ IPC می‌سنجد.
 *  - نشانگر پس از بازگردانی، ادغام و صفر کردن، و با هر روشن کردن، از «اکنون» از نو تنظیم می‌شود.
 */
import { jalaliAddDays } from '@shared/jalali'
import { readDatabaseHeader } from '../databaseFingerprint'
import { createBotApi, type ApiResult, type BotApi, type FetchLike } from './messengerAdapters'
import { auditAnchorHash, type MessengerDb } from './messengerDb'
import { auditPageToEvents, collectAuditIds, custodyCountToEvents, custodyEventToEvents, type AuditRowLite } from './messengerEvents'
import { fmtAt, fmtClock, num, officialDay, packItems, renderItem, scrubText, splitText } from './messengerFormat'
import type { SummaryDeps } from './messengerSummary'
import { createTodaySummary, type TodaySummary } from '../todaySummary'
import { createBotController, type BotRemote } from './messengerBot'
import {
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, HEARTBEAT_MS, OUTBOX_MAX, PAIRING_TTL_MS, PROVIDER_INFO, QUEUE_TTL_MS, READ_GAP_MS, READ_PAGE,
  READ_PAGES_PER_PASS, RECIPIENT_MODE_LABELS, RECIPIENT_MODE_TRUST, defaultMessengerSettings, emptyStats, eventForMode, newPairCode,
  newRecipientId, normalizeProxy, validBotToken, type MessengerEvent, type MessengerProvider, type MessengerRecipient,
  type MessengerSettings, type OutboxItem, type RecipientMode
} from './messengerTypes'
import { createMessengerStore, secureStorageAvailable, type CursorFile, type OutboxFile, type SafeStorageLike, type VaultRead } from './messengerVault'

export class MessengerError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export const MESSENGER_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  SECURE_STORAGE: 'ذخیره‌ساز امن ویندوز در دسترس نیست؛ تنظیمات پیام‌رسان ذخیره نشد.',
  VAULT_BROKEN: 'پروندهٔ تنظیمات پیام‌رسان خوانا نیست. برای شروع دوباره، «بازنشانی تنظیمات پیام‌رسان» را با رمز مدیر بزنید.',
  TOKEN: 'کلید ربات درست نیست. کلید را کامل و بی فاصله از سازندهٔ ربات کپی کنید.',
  PROXY: 'پراکسی باید مثل socks5://127.0.0.1:10808 یا http://127.0.0.1:10809 باشد (یا خالی).',
  BOT_CHECK: 'ربات پاسخ نداد یا کلید پذیرفته نشد.',
  NO_BOT: 'اول ربات همین پیام‌رسان را اضافه کنید.',
  PAIR_NONE: 'جفت‌سازی فعالی نیست یا وقتش تمام شده است؛ دوباره «ساخت کد» را بزنید.',
  PAIR_WAIT: 'هنوز پیامی با این کد از یک گفت‌وگوی خصوصی به ربات نرسیده است.',
  DUPLICATE: 'این گفت‌وگو از قبل در فهرست گیرنده‌هاست.',
  NOT_FOUND: 'این گیرنده پیدا نشد.',
  LIMIT: 'حداکثر ۲۰ گیرنده می‌شود ثبت کرد.',
  INVALID: 'ورودی نامعتبر است.',
  CONFLICT: 'این ربات جای دیگری (webhook یا برنامهٔ دیگر) خوانده می‌شود. اگر برایش webhook گذاشته‌اید، آن را بردارید و دوباره تلاش کنید.',
  NO_REMOTE: 'دکمه‌های ربات در این نسخه در دسترس نیست.'
})
function fail(code: string, detail?: string): never {
  throw new MessengerError(code, detail ? `${MESSENGER_MESSAGES[code] ?? MESSENGER_MESSAGES.INVALID} (${detail})` : MESSENGER_MESSAGES[code] ?? MESSENGER_MESSAGES.INVALID)
}

export interface EngineDeps {
  /** پوشهٔ دادهٔ برنامه (userData) */
  dir: string
  storage: SafeStorageLike | null
  db: MessengerDb
  summary: Omit<SummaryDeps, 'db'>
  /** fetch هر پیام‌رسان؛ در برنامه `session.fetch` الکترون با پراکسی اختیاری تلگرام */
  fetchFor(provider: MessengerProvider, proxy: string): FetchLike
  /** فقط آزمون: نشانی سرور ساختگی loopback به‌جای نشانی واقعی */
  baseUrls?: Partial<Record<MessengerProvider, string>>
  now?: () => number
  /** پروندهٔ پایگاه داده، برای شمارندهٔ تغییر سرآیند (تشخیص بازگردانی بیرون از برنامه) */
  databasePath?: string | null
  /** در برنامه true؛ آزمون‌ها `runOnce` را خودشان صدا می‌زنند */
  schedule?: boolean
  powerSave?: { start(): number; stop(id: number): void } | null
  log?: (message: string, error?: unknown) => void
  /** مهلت‌های long polling جفت‌سازی (ثانیه)؛ آزمون کوتاه می‌گیرد */
  pairPollSeconds?: number
  /** مرحلهٔ ۶ (§۴-۱-ب): پل دکمه‌های ربات به مسیر مجوز راه دور روی رایانه؛ نباشد ⇒ دکمه‌ها در دسترس نیستند */
  remote?: BotRemote | null
  /** مهلت long polling خواندن پیوستهٔ دکمه‌ها (ثانیه)؛ آزمون کوتاه می‌گیرد */
  botPollSeconds?: number
  /** مرحلهٔ ۷ (§۴-۷): «خلاصهٔ امروز» مشترک با گوشی؛ نباشد ⇒ نسخهٔ خود موتور با همان سازنده */
  today?: TodaySummary | null
}

interface PairingState {
  provider: MessengerProvider
  code: string
  expiresAt: number
  offset: number
  candidate: { chatId: number; name: string } | null
  error: string | null
  polling: boolean
}

export function createMessengerEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((message: string, error?: unknown) => console.error(`[messenger] ${message}`, error ?? ''))
  const store = createMessengerStore(deps.dir, deps.storage)
  // مرحلهٔ ۷ (§۴-۷): ربات و خلاصهٔ ساعت ۲۴ همان سازندهٔ «خلاصهٔ امروز» گوشی را می‌خوانند.
  const today: TodaySummary = deps.today ?? createTodaySummary({ deps: () => ({ ...deps.summary, db: deps.db }), offsetHours: () => offsetHours(), now })
  let vault: VaultRead = { state: 'absent' }
  let settings: MessengerSettings | null = null
  /** گاوصندوق هنوز خوانده نشده؛ پیش از هر تغییر خوانده می‌شود تا تنظیمات موجود هرگز با پیش‌فرض رونویسی نشود. */
  let loaded = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cursor: CursorFile | null = null
  let lastReadAt = 0, lastHeartbeatAt = 0
  let lastError: string | null = null
  let pairing: PairingState | null = null
  let powerId: number | null = null
  let seq = 0
  const nextAt = new Map<string, number>()
  const backoff = new Map<string, number>()
  const apis = new Map<string, BotApi>()
  let chain: Promise<unknown> = Promise.resolve()

  /** یک کار در هر لحظه (حلقه، تنظیمات و قلاب‌ها با هم تداخل نمی‌کنند). */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------------ دکمه‌های ربات (مرحلهٔ ۶، §۴-۱-ب)
  const bot = createBotController({
    settings: () => settings,
    active: () => running && !!settings?.enabled && !!settings?.botButtons && !!deps.remote,
    remote: deps.remote ?? null,
    api: (provider) => botApi(provider),
    pairingProvider: () => pairing && now() <= pairing.expiresAt ? pairing.provider : null,
    exclusive,
    notifyAll: async (title, lines, important) => {
      enqueueMany([systemEvent(title, lines, { important }, await offsetHours())])
      await deliverNowBounded(5000)
    },
    conflict: async (provider) => {
      if (!settings?.botButtons) return
      const next = JSON.parse(JSON.stringify(settings)) as MessengerSettings
      next.botButtons = false
      try { persist(next) } catch (error) { log('could not turn bot buttons off', error) }
      await bot.revoke(next.recipients.map((r) => r.id), '⌛ پاسخ ربات به دکمه‌ها خاموش شد.')
      enqueueMany([systemEvent(`⚠️ ربات ${PROVIDER_INFO[provider].label} جای دیگری در حال استفاده است`, ['پاسخ ربات به دکمه‌ها خاموش شد و ربات فقط خبر می‌دهد.', 'اگر برای ربات webhook گذاشته‌اید یا برنامهٔ دیگری آن را می‌خواند، آن را بردارید و دوباره روشن کنید.'], { important: true }, await offsetHours())])
      await deliverNowBounded(5000)
    },
    summary: async () => {
      // نسخهٔ از پیش ساختهٔ همین روز اگر تازه است؛ وگرنه یک محاسبهٔ تک‌اجرا. ساعت = زمان ساخت همان نسخه.
      const snap = await today.latest()
      const s = snap.summary
      return { title: `📊 خلاصهٔ امروز تا ساعت ${fmtClock(snap.at, snap.offsetHours)}`, lines: [...s.lines, ...(s.sellerSections.length ? ['— به تفکیک فروشنده —', ...s.sellerSections.flat()] : [])] }
    },
    offsetHours: () => offsetHours(),
    now,
    log,
    schedule: !!deps.schedule,
    pollSeconds: deps.botPollSeconds ?? 25
  })

  function load(): VaultRead {
    loaded = true
    vault = store.readSettings()
    settings = vault.state === 'ok' ? vault.settings : null
    return vault
  }
  function botApi(provider: MessengerProvider): BotApi | null {
    const bot = settings?.bots[provider]
    if (!bot) return null
    const key = `${provider}\n${bot.token}\n${bot.proxy}`
    let api = apis.get(key)
    if (!api) {
      api = createBotApi(provider, bot.token, deps.fetchFor(provider, bot.proxy), deps.baseUrls?.[provider])
      apis.set(key, api)
    }
    return api
  }
  const secrets = (): string[] => Object.values(settings?.bots ?? {}).map((b) => b?.token ?? '').filter(Boolean)
  /** افست ساعت رسمی، با نگه‌داری ۶۰ ثانیه‌ای (حلقه هر ثانیه پایگاه داده را نمی‌خواند). */
  let offsetCache: { value: number; at: number } | null = null
  const offsetHours = async (): Promise<number> => {
    const t = now()
    if (offsetCache && t - offsetCache.at < 60_000 && t >= offsetCache.at) return offsetCache.value
    let value = 0
    try { value = await deps.db.officialOffsetHours() } catch {}
    offsetCache = { value, at: t }
    return value
  }

  function persist(next: MessengerSettings): void {
    store.writeSettings(next)
    settings = next
    vault = { state: 'ok', settings: next }
  }
  function editable(): MessengerSettings {
    if (!loaded) load()
    if (vault.state === 'broken') fail('VAULT_BROKEN')
    if (vault.state === 'unavailable' || !secureStorageAvailable(deps.storage)) fail('SECURE_STORAGE')
    return JSON.parse(JSON.stringify(settings ?? defaultMessengerSettings())) as MessengerSettings
  }

  // ------------------------------------------------------------------ صف
  function systemEvent(title: string, lines: string[], opts: { important?: boolean; at?: number } = {}, offset = 0): MessengerEvent {
    const at = opts.at ?? now()
    return { code: `S-${at.toString(36)}${(seq++).toString(36)}`, at, title: `${title} · ${fmtAt(at, offset)}`, lines: lines.filter(Boolean), important: !!opts.important, handover: false, system: true }
  }
  /** رویداد ⇒ خانه‌های صف؛ رویداد بلندتر از سقف آداپتور سر مرز خط چند خانه می‌شود. */
  function itemsOf(ev: MessengerEvent, provider: MessengerProvider, extraLines: string[] = []): OutboxItem[] {
    const base: OutboxItem = { code: ev.code, at: ev.at, title: ev.title, lines: [...ev.lines, ...extraLines], important: ev.important, maybeDup: false, sale: !!ev.sale, day: ev.day ?? null }
    const limit = PROVIDER_INFO[provider].maxLength - 120
    if (renderItem(base, ev.at).length <= limit) return [base]
    const parts = splitText(base.lines.join('\n'), limit - base.title.length - 60)
    return parts.map((text, i) => ({ ...base, code: i ? `${ev.code}-${i + 1}` : ev.code, title: `${base.title} (بخش ${num(i + 1)} از ${num(parts.length)})`, lines: text.split('\n') }))
  }
  function appendItems(box: OutboxFile, items: OutboxItem[]): void {
    for (const item of items) if (!box.items.some((i) => i.code === item.code)) box.items.push(item)
    if (box.items.length > OUTBOX_MAX) {
      // حذف بی‌صدا ممنوع: کهنه‌ترین‌ها شمرده و مثل منقضی‌شده خبر داده می‌شوند.
      const dropped = box.items.splice(0, box.items.length - OUTBOX_MAX)
      noteExpired(box, dropped)
    }
  }
  function noteExpired(box: OutboxFile, items: OutboxItem[]): void {
    if (!items.length) return
    const fromAt = Math.min(...items.map((i) => i.at)), toAt = Math.max(...items.map((i) => i.at))
    const prev = box.stats.expiredPending
    box.stats.expiredPending = prev ? { count: prev.count + items.length, fromAt: Math.min(prev.fromAt, fromAt), toAt: Math.max(prev.toAt, toAt) } : { count: items.length, fromAt, toAt }
    box.stats.expiredTotal += items.length
  }
  /** چند رویداد ⇒ صف هر گیرندهٔ فعال، با سه گزینه؛ هر صف یک بار خوانده و نوشته می‌شود. */
  function enqueueMany(events: MessengerEvent[], only?: (r: MessengerRecipient) => boolean, extraFor?: (r: MessengerRecipient) => string[]): void {
    if (!settings || !events.length) return
    for (const r of settings.recipients) {
      if (!r.active || (only && !only(r))) continue
      const items = events.filter((ev) => only || eventForMode(ev, r.mode)).flatMap((ev) => itemsOf(ev, r.provider, extraFor?.(r)))
      if (!items.length) continue
      const box = store.readOutbox(r.id)
      appendItems(box, items)
      store.writeOutbox(r.id, box)
    }
  }

  // ------------------------------------------------------------------ نشانگر
  function readCounter(): number | null {
    if (!deps.databasePath) return null
    try { return readDatabaseHeader(deps.databasePath).changeCounter } catch { return null }
  }
  async function freshCursor(prev: CursorFile | null): Promise<CursorFile> {
    const auditId = await deps.db.maxAuditId()
    const anchor = auditId ? await deps.db.auditAnchor(auditId) : null
    const offset = await offsetHours()
    return {
      version: 1, auditId, auditHash: anchor ? auditAnchorHash(anchor) : '', counter: readCounter(),
      custodyEventId: await deps.db.maxCustodyEventId(), custodyCountId: await deps.db.maxCustodyCountId(),
      closeShiftIds: [], summaryDay: prev?.summaryDay ?? jalaliAddDays(officialDay(now(), offset), -1),
      pendingBackupAt: null, pendingKind: null, resetOnStart: false
    }
  }
  /** بازگردانی یا جایگزینی پایگاه داده: ردیف نشانگر نیست یا عوض شده، یا شمارندهٔ سرآیند کم شده است. */
  async function databaseReplaced(c: CursorFile): Promise<boolean> {
    if (c.auditId > 0) {
      const anchor = await deps.db.auditAnchor(c.auditId)
      if (!anchor || auditAnchorHash(anchor) !== c.auditHash) return true
    }
    const counter = readCounter()
    return counter !== null && c.counter !== null && counter < c.counter
  }
  async function resetCursor(notice: { title: string; lines: string[] } | null): Promise<void> {
    cursor = await freshCursor(cursor)
    store.writeCursor(cursor)
    if (notice) enqueueMany([systemEvent(notice.title, notice.lines, { important: true }, await offsetHours())])
  }

  // ------------------------------------------------------------------ خواندن رویدادها
  /** ردیف‌های یک سند برگشت در یک صفحه بمانند: در صفحهٔ پر، گروه آخر به صفحهٔ بعد می‌رود. */
  function trimTrailingGroup(rows: AuditRowLite[]): AuditRowLite[] {
    const last = rows[rows.length - 1]
    if (last.entity !== 'SaleReturn' || !last.entityId) return rows
    let cut = rows.length
    while (cut > 0 && rows[cut - 1].entity === 'SaleReturn' && rows[cut - 1].entityId === last.entityId) cut--
    return cut > 0 ? rows.slice(0, cut) : rows
  }
  async function readEvents(): Promise<void> {
    if (!settings) return
    if (!cursor) cursor = store.readCursor()
    if (!cursor) { cursor = await freshCursor(null); store.writeCursor(cursor); return }
    if (cursor.pendingBackupAt) return // بازگردانی، ادغام یا صفر کردن در جریان است
    if (await databaseReplaced(cursor)) {
      await resetCursor({ title: '🗄️ پایگاه دادهٔ برنامه عوض شد', lines: ['شاید بکاپی بازگردانی یا پرونده بیرون از برنامه جایگزین شد.', 'رویدادهای قدیمی دوباره فرستاده نمی‌شوند؛ پیام‌ها از همین لحظه ادامه دارند.'] })
      return
    }
    const ctxBase = { offsetHours: await offsetHours(), threshold: await deps.db.cashDifferenceThreshold().catch(() => 0), includeCustomerName: settings.includeCustomerName }
    for (let page = 0; page < READ_PAGES_PER_PASS; page++) {
      let rows = await deps.db.auditPage(cursor.auditId, READ_PAGE)
      if (!rows.length) break
      const full = rows.length === READ_PAGE
      if (full) rows = trimTrailingGroup(rows)
      const data = await deps.db.fetchLookups(collectAuditIds(rows, settings.includeCustomerName))
      enqueueMany(auditPageToEvents(rows, { ...ctxBase, data }, cursor))
      const last = rows[rows.length - 1]
      cursor.auditId = last.id
      cursor.auditHash = auditAnchorHash(last)
      store.writeCursor(cursor)
      if (!full) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const events = await deps.db.custodyEventPage(cursor.custodyEventId, READ_PAGE)
    const counts = await deps.db.custodyCountPage(cursor.custodyCountId, READ_PAGE)
    if (events.length || counts.length) {
      const data = await deps.db.fetchLookups({ users: new Set(), shifts: new Set(), invoices: new Set(), customers: new Set(), payments: new Set(), credits: new Set(), redemptions: [], handovers: new Set() }, { events, counts })
      const ctx = { ...ctxBase, data }
      enqueueMany([...events.flatMap((e) => custodyEventToEvents(e, ctx)), ...counts.flatMap((c) => custodyCountToEvents(c, ctx))].sort((a, b) => a.at - b.at))
      if (events.length) cursor.custodyEventId = events[events.length - 1].id
      if (counts.length) cursor.custodyCountId = counts[counts.length - 1].id
    }
    cursor.counter = readCounter() ?? cursor.counter
    store.writeCursor(cursor)
  }

  // ------------------------------------------------------------------ خلاصهٔ ساعت ۲۴
  async function maybeSummary(): Promise<void> {
    if (!settings || !cursor || cursor.pendingBackupAt) return
    const offset = await offsetHours()
    const yesterday = jalaliAddDays(officialDay(now(), offset), -1)
    if (!cursor.summaryDay) { cursor.summaryDay = yesterday; store.writeCursor(cursor); return }
    if (cursor.summaryDay >= yesterday) return
    const summary = await today.forDay(yesterday, { offsetHours: offset, now: now() })
    const late = now() - summary.endAt > 10 * 60_000
    const at = late ? now() : summary.endAt
    for (const r of settings.recipients) {
      if (!r.active) continue
      const box = store.readOutbox(r.id)
      const day = yesterday
      const sent = box.stats.saleSent?.day === day ? box.stats.saleSent.n : 0
      const lines = [
        ...summary.lines,
        ...(r.mode === 'all' ? [`فاکتورهای این روز در برنامه: ${num(summary.invoiceCount)} · پیام‌های فروش فرستاده‌شده به این گفت‌وگو: ${num(sent)}`] : []),
        `صف این گفت‌وگو: ${num(box.items.length)} پیام در انتظار · ${num(box.stats.expiredTotal)} پیام تا امروز منقضی شده`,
        ...(late ? ['🕒 ارسال با تأخیر: برنامه ساعت ۲۴ باز نبود.'] : []),
        ...(summary.sellerSections.length ? ['— به تفکیک فروشنده —'] : []),
        ...summary.sellerSections.flatMap((section) => [...section, ''])
      ]
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      const ev: MessengerEvent = { code: `D-${day.replace(/\//g, '')}`, at, title: summary.title, lines, important: false, handover: false, system: true }
      appendItems(box, itemsOf(ev, r.provider))
      store.writeOutbox(r.id, box)
    }
    cursor.summaryDay = yesterday
    store.writeCursor(cursor)
  }

  // ------------------------------------------------------------------ ارسال
  const expiredNotice = (e: { count: number; fromAt: number; toAt: number }, offset: number): string =>
    `⚠️ ${num(e.count)} پیام از ${fmtAt(e.fromAt, offset)} تا ${fmtAt(e.toAt, offset)} چون بیش از ۲۴ ساعت در صف ماند فرستاده نشد؛ جزئیات در گزارش‌های خود برنامه است.`
  const failureText = (r: ApiResult<unknown>): string => {
    switch (r.kind) {
      case 'unsent': return 'اتصال برقرار نشد (اینترنت یا فیلترشکن را بررسی کنید)'
      case 'uncertain': return 'نتیجهٔ ارسال نامعلوم ماند؛ دوباره فرستاده می‌شود'
      case 'retry': return 'سرور خواست کمی صبر شود (۴۲۹)'
      case 'forbidden': return 'گیرنده ربات را بسته یا گفت‌وگو را پاک کرده است (۴۰۳)'
      case 'unauthorized': return 'کلید ربات پذیرفته نشد'
      case 'conflict': return MESSENGER_MESSAGES.CONFLICT
      case 'bad': return `پیام پذیرفته نشد (خطای ${r.status})`
      default: return ''
    }
  }

  /** یک بار ارسال برای یک گیرنده: از سر صف، تا جایی که در یک پیام جا شود. */
  async function deliverOne(r: MessengerRecipient, force = false): Promise<'idle' | 'sent' | 'wait'> {
    const t = now()
    if (!force && (nextAt.get(r.id) ?? 0) > t) return 'wait'
    const api = botApi(r.provider)
    if (!api) return 'idle'
    const box = store.readOutbox(r.id)
    const expired = box.items.filter((i) => t - i.at > QUEUE_TTL_MS)
    if (expired.length) {
      box.items = box.items.filter((i) => t - i.at <= QUEUE_TTL_MS)
      noteExpired(box, expired)
      store.writeOutbox(r.id, box)
    }
    if (!box.items.length && !box.stats.expiredPending) return 'idle'
    const notice = box.stats.expiredPending ? expiredNotice(box.stats.expiredPending, await offsetHours()) : null
    const limit = PROVIDER_INFO[r.provider].maxLength
    const packed = packItems(box.items, t, limit, notice)
    const text = scrubText(packed.texts[0] ?? '', secrets())
    const result = await api.sendMessage(r.chatId, text)
    // در فاصلهٔ ارسال ممکن است گیرنده حذف شده باشد: صفِ او دوباره ساخته نمی‌شود.
    if (!settings?.recipients.some((x) => x.id === r.id)) return 'idle'
    const live = store.readOutbox(r.id)
    const head = box.items.slice(0, packed.count).map((i) => i.code)
    const isHead = (i: OutboxItem) => head.includes(i.code)
    if (result.kind === 'ok') {
      if (packed.texts.length > 1 && packed.count === 1) {
        // خانهٔ بلندتر از سقف: بقیه‌اش با همان کد می‌ماند.
        const first = live.items.find(isHead)
        if (first) { first.title = `${first.title} (ادامه)`; first.lines = packed.texts.slice(1).join('\n').split('\n'); first.maybeDup = false }
      } else {
        for (const item of live.items.filter(isHead)) {
          if (item.sale && item.day) live.stats.saleSent = live.stats.saleSent?.day === item.day ? { day: item.day, n: live.stats.saleSent.n + 1 } : { day: item.day, n: 1 }
        }
        live.items = live.items.filter((i) => !isHead(i))
      }
      if (notice) live.stats.expiredPending = null
      live.stats.lastSuccessAt = t
      live.stats.lastError = null
      backoff.delete(r.id)
      nextAt.set(r.id, t + PROVIDER_INFO[r.provider].minIntervalMs)
      store.writeOutbox(r.id, live)
      return 'sent'
    }
    live.stats.lastError = failureText(result)
    if (result.kind === 'retry') nextAt.set(r.id, t + result.afterMs)
    else if (result.kind === 'forbidden') {
      const next = JSON.parse(JSON.stringify(settings)) as MessengerSettings
      const target = next.recipients.find((x) => x.id === r.id)
      if (target) { target.active = false; target.inactiveReason = failureText(result) }
      try { persist(next) } catch (error) { log('could not mark recipient inactive', error) }
    } else if (result.kind === 'bad' || result.kind === 'conflict') {
      if (packed.count > 1) { const first = live.items.find(isHead); if (first) first.single = true }
      else if (packed.count === 1) { live.items = live.items.filter((i) => !isHead(i)); live.stats.failedTotal++ }
      else if (notice) live.stats.expiredPending = null
      nextAt.set(r.id, t + PROVIDER_INFO[r.provider].minIntervalMs)
    } else {
      if (result.kind === 'uncertain') for (const item of live.items) if (isHead(item)) item.maybeDup = true
      const wait = Math.min(BACKOFF_MAX_MS, backoff.get(r.id) ?? BACKOFF_MIN_MS)
      backoff.set(r.id, Math.min(BACKOFF_MAX_MS, wait * 2))
      nextAt.set(r.id, t + (result.kind === 'unauthorized' ? BACKOFF_MAX_MS : wait))
    }
    store.writeOutbox(r.id, live)
    return 'wait'
  }
  async function deliverAll(force = false): Promise<void> {
    for (const r of settings?.recipients ?? []) {
      if (!r.active) continue
      try { await deliverOne(r, force) } catch (error) { lastError = 'ارسال انجام نشد'; log('delivery failed', error) }
    }
  }
  /** خبر تغییر تنظیمات پیش از اعمال: یک تلاش فوری، با سقف زمانی؛ اگر نرسید، در صف می‌ماند. */
  async function deliverNowBounded(ms: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const done = await Promise.race([
      deliverAll(true).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), ms) })
    ])
    if (timeout) clearTimeout(timeout)
    return done
  }
  async function announceThenApply(title: string, lines: string[], apply: () => void | Promise<void>): Promise<void> {
    if (settings?.enabled && running && settings.recipients.some((r) => r.active)) {
      enqueueMany([systemEvent(title, lines, { important: true }, await offsetHours())])
      await deliverNowBounded(8000)
    }
    await apply()
  }

  // ------------------------------------------------------------------ حلقه
  async function tick(): Promise<void> {
    if (!running) return
    try {
      const t = now()
      if (t - lastReadAt >= READ_GAP_MS) { lastReadAt = t; await readEvents(); lastError = null }
      await maybeSummary()
      if (t - lastHeartbeatAt >= HEARTBEAT_MS) { lastHeartbeatAt = t; store.writeHeartbeat({ version: 1, at: t, clean: false }) }
      await deliverAll()
      await bot.tick()
    } catch (error) {
      lastError = 'خواندن یا ارسال رویدادها انجام نشد؛ دوباره تلاش می‌شود.'
      log('tick failed', error)
    }
  }
  function schedule(delay: number): void {
    if (!deps.schedule || !running || timer) return
    timer = setTimeout(() => {
      timer = null
      void exclusive(tick).finally(() => schedule(1000))
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
  }

  async function startRuntime(reason: 'app' | 'enable'): Promise<void> {
    if (running || !settings?.enabled) return
    running = true
    lastReadAt = 0; lastHeartbeatAt = 0
    const offset = await offsetHours()
    const heartbeat = store.readHeartbeat()
    cursor = store.readCursor()
    // با هر روشن کردن، از «اکنون» (رویدادهای دورهٔ خاموش فرستاده نمی‌شوند؛ خلاصهٔ بعدی ساعت ۲۴ امروز است).
    if (reason === 'enable') { cursor = await freshCursor(null); store.writeCursor(cursor) }
    else if (!cursor || cursor.resetOnStart) { cursor = await freshCursor(cursor); store.writeCursor(cursor) }
    else if (cursor.pendingBackupAt) {
      const kind = cursor.pendingKind === 'reset' ? 'صفر کردن برنامه' : 'بازگردانی یا ادغام بکاپ'
      enqueueMany([systemEvent(`🗄️ ${kind} آغاز شد ولی پایانش ثبت نشد`, [`آغاز: ${fmtAt(cursor.pendingBackupAt, offset)}`, 'شاید برنامه وسط کار بسته شد. رویدادها از همین لحظه ادامه دارند.'], { important: true }, offset)])
      await resetCursor(null)
    } else if (await databaseReplaced(cursor)) {
      await resetCursor({ title: '🗄️ پایگاه دادهٔ برنامه از آخرین اجرا عوض شده است', lines: ['رویدادهای قدیمی دوباره فرستاده نمی‌شوند.'] })
    }
    if (reason === 'app') {
      const t = now()
      enqueueMany([systemEvent('🟢 برنامه روشن شد', heartbeat ? [
        `برنامه از حدود ${fmtAt(heartbeat.at, offset)} تا ${fmtAt(t, offset)} بسته بود.`,
        heartbeat.clean ? 'دفعهٔ قبل برنامه عادی بسته شد.' : 'دفعهٔ قبل برنامه عادی بسته نشد (مثلاً قطع برق یا بسته شدن ناگهانی).'
      ] : [], { important: !!heartbeat && !heartbeat.clean }, offset)])
    } else {
      enqueueMany([systemEvent('🔔 اعلان‌ها روشن شد', ['پیام‌ها از همین لحظه فرستاده می‌شوند.'], {}, offset)])
    }
    store.writeHeartbeat({ version: 1, at: now(), clean: false })
    lastHeartbeatAt = now()
    applyPowerSave()
    schedule(0)
  }
  function applyPowerSave(): void {
    const want = !!(running && settings?.enabled && settings.preventSleep && deps.powerSave)
    try {
      if (want && powerId === null) powerId = deps.powerSave!.start()
      if (!want && powerId !== null) { deps.powerSave?.stop(powerId); powerId = null }
    } catch (error) { log('power save blocker failed', error) }
  }
  /** توقف همگام؛ درون کارهای صف‌شده (exclusive) همین به کار می‌رود، نه stopRuntime که منتظر خود صف است. */
  function haltRuntime(): void {
    running = false
    if (timer) { clearTimeout(timer); timer = null }
    applyPowerSave()
  }
  async function stopRuntime(): Promise<void> {
    haltRuntime()
    await chain.catch(() => undefined)
  }

  // ------------------------------------------------------------------ جفت‌سازی
  async function pairPollOnce(timeoutSec = deps.pairPollSeconds ?? 20): Promise<void> {
    const p = pairing
    if (!p || p.candidate || p.error) return
    if (now() > p.expiresAt) { pairing = null; return }
    const api = botApi(p.provider)
    if (!api) { p.error = MESSENGER_MESSAGES.NO_BOT; return }
    const result = await api.getUpdates(p.offset, timeoutSec)
    if (pairing !== p) return
    if (result.kind === 'conflict') { p.error = MESSENGER_MESSAGES.CONFLICT; return }
    if (result.kind === 'unauthorized') { p.error = MESSENGER_MESSAGES.BOT_CHECK; return }
    if (result.kind !== 'ok' || !Array.isArray(result.result)) return
    for (const update of result.result) {
      if (!Number.isSafeInteger(update?.update_id)) continue
      p.offset = Math.max(p.offset, update.update_id + 1)
      const message = update.message
      const text = typeof message?.text === 'string' ? message.text.trim() : ''
      // فقط گفت‌وگوی خصوصی، فقط در همین ۱۰ دقیقه، فقط با همین کد (طرح §۲۶-۲ افزودهٔ ۲۶).
      if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id) || message.chat.id <= 0) continue
      if (text !== p.code && text !== `/start ${p.code}`) continue
      if (now() > p.expiresAt) continue
      const name = [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || (message.chat.username ? `@${message.chat.username}` : `گفت‌وگوی ${message.chat.id}`)
      p.candidate = { chatId: message.chat.id, name: name.slice(0, 100) }
    }
    // تأیید به‌روزرسانی‌های خوانده‌شده تا دوباره نیایند.
    if (p.candidate) await api.getUpdates(p.offset, 0).catch(() => undefined)
  }
  function pairLoop(p: PairingState): void {
    if (!deps.schedule || p.polling) return
    p.polling = true
    void (async () => {
      while (pairing === p && !p.candidate && !p.error && now() <= p.expiresAt) {
        try { await pairPollOnce() } catch (error) { log('pairing poll failed', error); await new Promise((r) => setTimeout(r, 3000)) }
      }
      p.polling = false
      if (pairing === p && now() > p.expiresAt) pairing = null
    })()
  }

  // ------------------------------------------------------------------ نما برای رابط
  function status() {
    if (!loaded) load()
    const t = now()
    if (pairing && t > pairing.expiresAt) pairing = null
    const botInfo = (provider: MessengerProvider) => {
      const b = settings?.bots[provider]
      return b ? { configured: true, username: b.username, proxy: b.proxy } : null
    }
    return {
      secureStorage: secureStorageAvailable(deps.storage),
      vault: vault.state,
      enabled: !!settings?.enabled,
      running,
      bots: { telegram: botInfo('telegram'), bale: botInfo('bale') },
      includeCustomerName: !!settings?.includeCustomerName,
      preventSleep: !!settings?.preventSleep,
      /** مرحلهٔ ۶: «پاسخ ربات به دکمه‌ها» و هشدار ۴۰۹ */
      botButtons: !!settings?.botButtons,
      botAvailable: !!deps.remote,
      botConflict: bot.status().conflict,
      recipients: (settings?.recipients ?? []).map((r) => {
        const box = store.readOutbox(r.id)
        return {
          id: r.id, provider: r.provider, providerLabel: PROVIDER_INFO[r.provider].label, name: r.name, mode: r.mode,
          modeLabel: RECIPIENT_MODE_LABELS[r.mode], trust: RECIPIENT_MODE_TRUST[r.mode], active: r.active, inactiveReason: r.inactiveReason,
          queued: box.items.length, expiredTotal: box.stats.expiredTotal, failedTotal: box.stats.failedTotal,
          lastSuccessAt: box.stats.lastSuccessAt, lastError: box.stats.lastError, canApprove: r.canApprove
        }
      }),
      pairing: pairing ? {
        provider: pairing.provider, code: pairing.code, expiresAt: pairing.expiresAt, remainingSec: Math.max(0, Math.round((pairing.expiresAt - t) / 1000)),
        link: PROVIDER_INFO[pairing.provider].deepLink && settings?.bots[pairing.provider] ? `https://t.me/${settings.bots[pairing.provider]!.username}?start=${pairing.code}` : null,
        botUsername: settings?.bots[pairing.provider]?.username ?? null,
        candidate: pairing.candidate ? { name: pairing.candidate.name } : null, error: pairing.error
      } : null,
      lastError
    }
  }

  // ------------------------------------------------------------------ کارهای مدیر (رمز را IPC سنجیده است)
  return {
    store,
    status,
    /** شروع با روشن شدن برنامه (فقط اگر روشن باشد؛ وگرنه هیچ کاری). */
    start: () => exclusive(async () => {
      if (!store.vaultExists()) return
      load()
      await startRuntime('app')
    }),
    stop: () => stopRuntime(),
    /** بستن عادی برنامه: نشانهٔ «عادی بسته شد» (همگام، برای before-quit). */
    markCleanExit(): void {
      if (!running) return
      try { store.writeHeartbeat({ version: 1, at: now(), clean: true }) } catch (error) { log('heartbeat write failed', error) }
    },
    isRunning: () => running,

    saveBot: (provider: MessengerProvider, token: string, proxyRaw: unknown) => exclusive(async () => {
      if (provider !== 'telegram' && provider !== 'bale') fail('INVALID')
      const next = editable()
      if (!validBotToken(token)) fail('TOKEN')
      const proxy = provider === 'telegram' ? normalizeProxy(proxyRaw) : (normalizeProxy(proxyRaw) === '' ? '' : null)
      if (proxy === null) fail('PROXY')
      const probe = createBotApi(provider, token, deps.fetchFor(provider, proxy as string), deps.baseUrls?.[provider])
      const me = await probe.getMe()
      if (me.kind !== 'ok' || !me.result || typeof me.result.username !== 'string') fail('BOT_CHECK', failureText(me as ApiResult<unknown>) || undefined)
      const username = (me as { result: { username: string } }).result.username.slice(0, 64)
      const label = PROVIDER_INFO[provider].label
      const replacing = !!next.bots[provider]
      await announceThenApply(`🔧 ${replacing ? `ربات ${label} عوض شد` : `ربات ${label} افزوده شد`}`, [`ربات: @${username}`, 'به دست مدیر، روی رایانهٔ فروشگاه.'], () => {
        next.bots[provider] = { token, username, proxy: proxy as string }
        persist(next)
      })
      return { username }
    }),
    removeBot: (provider: MessengerProvider) => exclusive(async () => {
      const next = editable()
      if (!next.bots[provider]) fail('NO_BOT')
      const label = PROVIDER_INFO[provider].label
      const removed = next.recipients.filter((r) => r.provider === provider)
      await announceThenApply(`🔧 ربات ${label} برداشته شد`, [removed.length ? `${num(removed.length)} گیرندهٔ ${label} هم برداشته شدند.` : ''], () => {
        delete next.bots[provider]
        next.recipients = next.recipients.filter((r) => r.provider !== provider)
        persist(next)
        for (const r of removed) store.removeOutbox(r.id)
      })
      await bot.revoke(removed.map((r) => r.id), '⌛ ربات برداشته شد.')
    }),
    setEnabled: (enabled: boolean) => exclusive(async () => {
      const next = editable()
      if (enabled === next.enabled) return
      if (enabled) {
        next.enabled = true
        persist(next)
        await startRuntime('enable')
      } else {
        await announceThenApply('🔕 اعلان‌ها به دست مدیر خاموش شد', ['تا روشن شدن دوباره، هیچ پیامی فرستاده نمی‌شود.'], () => {
          next.enabled = false
          persist(next)
        })
        haltRuntime()
        await bot.revoke(next.recipients.map((r) => r.id), '⌛ اعلان‌ها خاموش شد.')
      }
    }),
    setOptions: (opts: { includeCustomerName?: boolean; preventSleep?: boolean }) => exclusive(async () => {
      const next = editable()
      const lines: string[] = []
      if (typeof opts.includeCustomerName === 'boolean' && opts.includeCustomerName !== next.includeCustomerName) {
        lines.push(opts.includeCustomerName ? 'از این پس نام مشتری هم در پیام‌ها می‌آید (تلفن هرگز).' : 'از این پس نام مشتری در پیام‌ها نمی‌آید.')
        next.includeCustomerName = opts.includeCustomerName
      }
      if (typeof opts.preventSleep === 'boolean' && opts.preventSleep !== next.preventSleep) {
        lines.push(opts.preventSleep ? 'رایانه تا وقتی برنامه باز است به خواب نمی‌رود.' : 'جلوگیری از خواب رایانه برداشته شد.')
        next.preventSleep = opts.preventSleep
      }
      if (!lines.length) return
      await announceThenApply('⚙️ تنظیمات اعلان‌ها عوض شد', lines, () => persist(next))
      applyPowerSave()
    }),
    updateRecipient: (id: string, mode: RecipientMode) => exclusive(async () => {
      const next = editable()
      const r = next.recipients.find((x) => x.id === id)
      if (!r) fail('NOT_FOUND')
      if (!RECIPIENT_MODE_LABELS[mode]) fail('INVALID')
      if (r!.mode === mode) return
      await announceThenApply('⚙️ تنظیم یک گیرنده عوض شد', [`گیرنده: ${r!.name} (${PROVIDER_INFO[r!.provider].label})`, `از «${RECIPIENT_MODE_LABELS[r!.mode]}» به «${RECIPIENT_MODE_LABELS[mode]}»`], () => {
        r!.mode = mode
        persist(next)
      })
    }),
    removeRecipient: (id: string) => exclusive(async () => {
      const next = editable()
      const r = next.recipients.find((x) => x.id === id)
      if (!r) fail('NOT_FOUND')
      await announceThenApply('➖ یک گیرنده حذف شد', [`گیرنده: ${r!.name} (${PROVIDER_INFO[r!.provider].label})`], () => {
        next.recipients = next.recipients.filter((x) => x.id !== id)
        persist(next)
        store.removeOutbox(id) // صف او همان لحظه پاک می‌شود
        nextAt.delete(id); backoff.delete(id)
      })
      await bot.revoke([id], '⌛ این گیرنده حذف شد.')
    }),
    /**
     * مرحلهٔ ۶ (§۴-۱-ب): «پاسخ ربات به دکمه‌ها» (رمز مدیر را IPC سنجیده است). پیش از اعمال به همه خبر داده می‌شود.
     * خاموش کردن مجوزهایی را که با ربات داده شده‌اند هم می‌بندد.
     */
    setBotButtons: (enabled: boolean) => exclusive(async () => {
      if (!deps.remote) fail('NO_REMOTE')
      const next = editable()
      if (enabled === next.botButtons) { if (enabled) bot.clearConflict(); return }
      await announceThenApply(enabled ? '🤖 پاسخ ربات به دکمه‌ها به دست مدیر روشن شد' : '🤖 پاسخ ربات به دکمه‌ها به دست مدیر خاموش شد', enabled
        ? ['گیرنده‌هایی که اجازهٔ تأیید دارند، درخواست مجوز را با دکمهٔ ربات تأیید یا رد می‌کنند و «بستن همهٔ مجوزها» را می‌زنند.', 'برای امنیت، «تأیید دومرحله‌ای» حساب پیام‌رسان خود را روشن کنید.']
        : ['ربات از این پس فقط خبر می‌دهد؛ مجوزهایی که با ربات داده شده بود بسته شد.'], () => {
        next.botButtons = enabled
        persist(next)
      })
      bot.clearConflict()
      if (!enabled) await bot.revoke(next.recipients.map((r) => r.id), '⌛ پاسخ ربات به دکمه‌ها خاموش شد.')
    }),
    /** مرحلهٔ ۶: تیک «می‌تواند درخواست مجوز را تأیید کند» برای یک گیرنده (پیش‌فرض خاموش). */
    setRecipientApprove: (id: string, canApprove: boolean) => exclusive(async () => {
      if (!deps.remote) fail('NO_REMOTE')
      const next = editable()
      const r = next.recipients.find((x) => x.id === id)
      if (!r) fail('NOT_FOUND')
      if (r!.canApprove === canApprove) return
      await announceThenApply(canApprove ? '🤖 اجازهٔ تأیید با ربات به یک گیرنده داده شد' : '🤖 اجازهٔ تأیید با ربات از یک گیرنده برداشته شد', [`گیرنده: ${r!.name} (${PROVIDER_INFO[r!.provider].label})`], () => {
        r!.canApprove = canApprove
        persist(next)
      })
      if (!canApprove) await bot.revoke([id], '⌛ اجازهٔ تأیید این گیرنده برداشته شد.')
    }),
    /** فقط آزمون: یک بار خواندن دکمه‌ها (long polling با مهلت کوتاه). */
    botPollOnce: (provider: MessengerProvider, timeoutSec?: number) => bot.pollOnce(provider, timeoutSec),
    pairStart: (provider: MessengerProvider) => exclusive(async () => {
      editable()
      if (!settings?.bots[provider]) fail('NO_BOT')
      const api = botApi(provider)!
      // به‌روزرسانی‌های قدیمی کنار می‌روند؛ فقط پیامی که پس از ساخت کد برسد پذیرفته است.
      let offset = 0
      for (let round = 0; round < 5; round++) {
        const old = await api.getUpdates(offset, 0)
        if (old.kind === 'conflict') fail('CONFLICT')
        if (old.kind === 'unauthorized') fail('BOT_CHECK')
        if (old.kind !== 'ok' || !Array.isArray(old.result) || !old.result.length) break
        offset = Math.max(offset, ...old.result.map((u) => (Number.isSafeInteger(u?.update_id) ? u.update_id + 1 : 0)))
      }
      pairing = { provider, code: newPairCode(), expiresAt: now() + PAIRING_TTL_MS, offset, candidate: null, error: null, polling: false }
      pairLoop(pairing)
      return status().pairing!
    }),
    pairPollOnce: (timeoutSec?: number) => pairPollOnce(timeoutSec),
    pairCancel: () => { pairing = null },
    pairConfirm: (mode: RecipientMode) => exclusive(async () => {
      const next = editable()
      const p = pairing
      if (!p || now() > p.expiresAt) { pairing = null; fail('PAIR_NONE') }
      if (!p!.candidate) fail('PAIR_WAIT')
      if (!RECIPIENT_MODE_LABELS[mode]) fail('INVALID')
      if (!next.bots[p!.provider]) fail('NO_BOT')
      if (next.recipients.some((r) => r.provider === p!.provider && r.chatId === p!.candidate!.chatId)) fail('DUPLICATE')
      if (next.recipients.length >= 20) fail('LIMIT')
      const recipient: MessengerRecipient = {
        id: newRecipientId(), provider: p!.provider, chatId: p!.candidate!.chatId, name: p!.candidate!.name, mode,
        active: true, inactiveReason: null, addedAt: now(), canApprove: false
      }
      await announceThenApply('➕ گیرندهٔ تازه افزوده شد', [`گیرنده: ${recipient.name} (${PROVIDER_INFO[recipient.provider].label})`, `گزینه: ${RECIPIENT_MODE_LABELS[mode]}`], () => {
        next.recipients.push(recipient)
        persist(next)
      })
      pairing = null
      const offset = await offsetHours()
      const welcome = systemEvent('✅ این گفت‌وگو برای اعلان‌های فروشگاه ثبت شد', [`گزینه: ${RECIPIENT_MODE_LABELS[mode]} (${RECIPIENT_MODE_TRUST[mode]})`, 'برای امنیت، «تأیید دومرحله‌ای» حساب خود را روشن کنید.'], {}, offset)
      if (settings?.enabled && running) {
        enqueueMany([welcome], (r) => r.id === recipient.id)
        await deliverNowBounded(8000)
      } else {
        await botApi(recipient.provider)?.sendMessage(recipient.chatId, scrubText(renderItem({ ...welcome, maybeDup: false, sale: false, day: null }, now()), secrets()))
      }
      return { id: recipient.id }
    }),
    /** پیام آزمایشی، مستقیم و بی صف (کار صریح مدیر). */
    sendTest: (id: string) => exclusive(async () => {
      const r = settings?.recipients.find((x) => x.id === id)
      if (!r) fail('NOT_FOUND')
      const api = botApi(r!.provider)
      if (!api) fail('NO_BOT')
      const offset = await offsetHours()
      const ev = systemEvent('🧪 پیام آزمایشی', ['اگر این پیام را می‌بینید، اتصال درست است.'], {}, offset)
      const result = await api!.sendMessage(r!.chatId, scrubText(renderItem({ ...ev, maybeDup: false, sale: false, day: null }, now()), secrets()))
      const box = store.readOutbox(r!.id)
      if (result.kind === 'ok') { box.stats.lastSuccessAt = now(); box.stats.lastError = null }
      else box.stats.lastError = failureText(result)
      store.writeOutbox(r!.id, box)
      if (result.kind !== 'ok') throw new MessengerError('SEND', failureText(result))
      return { ok: true }
    }),
    /** فقط برای گاوصندوق خراب: کنار گذاشتن پرونده (نه پاک کردن) و شروع از صفر، خاموش. */
    resetVault: () => exclusive(async () => {
      if (vault.state !== 'broken') fail('INVALID')
      haltRuntime()
      store.setAsideVault(now())
      for (const id of store.listOutboxIds()) store.removeOutbox(id)
      cursor = null
      load()
    }),

    // ---------------------------------------------------------------- قلاب‌ها (بازگردانی، ادغام، صفر کردن)
    /** همگام، پیش از جابه‌جایی پایگاه داده: خواندن متوقف و نشانهٔ «در جریان» بیرون از پایگاه داده نوشته می‌شود. */
    beforeDatabaseOperation(kind: 'backup' | 'reset'): void {
      if (!running) return
      try {
        cursor = cursor ?? store.readCursor()
        if (!cursor) return
        cursor.pendingBackupAt = now(); cursor.pendingKind = kind
        store.writeCursor(cursor)
      } catch (error) { log('before database operation failed', error) }
    },
    /**
     * پس از پایان کار، همگام (بکاپ کامل ۱.۲ ثانیه بعد با `app.exit` می‌بندد و `before-quit` نمی‌آید).
     * موفق ⇒ خبر ⚠️ در صف بیرون از پایگاه داده و نشانگر از «اکنون»؛ ناموفق (مثلاً رمز اشتباه) ⇒ بی خبر،
     * چون داده عوض نشد. تا نشانگر تازه نشده، خواندن رویدادها متوقف می‌ماند (ردیف‌های ادغام‌شده خبر نمی‌شوند).
     */
    afterDatabaseOperation(outcome: { ok: boolean; kind: 'backup' | 'reset'; mode?: string | null; willRestart?: boolean }): void {
      if (!running) return
      try {
        cursor = cursor ?? store.readCursor()
        if (!cursor) return
        if (!outcome.ok) { cursor.pendingBackupAt = null; cursor.pendingKind = null; store.writeCursor(cursor); return }
        const title = outcome.kind === 'reset' ? '♻️ برنامه صفر شد' : outcome.mode === 'merge' ? '🗄️ ادغام بکاپ انجام شد' : '🗄️ داده از بکاپ برگشت (جایگزینی کامل)'
        const lines = outcome.kind === 'reset' ? ['رویدادهای پیش از صفر شدن دوباره فرستاده نمی‌شوند.']
          : outcome.mode === 'merge' ? ['ردیف‌های واردشده از بکاپ دوباره خبر داده نمی‌شوند.'] : ['برنامه دوباره باز می‌شود؛ رویدادهای قدیمی دوباره فرستاده نمی‌شوند.']
        enqueueMany([systemEvent(title, lines, { important: true }, offsetCache?.value ?? 0)])
        if (outcome.willRestart) {
          // خروج عمدی «عادی» است؛ شروع بعدی نشانگر را بی پیام دوباره از «اکنون» می‌گیرد.
          cursor.pendingBackupAt = null; cursor.pendingKind = null; cursor.resetOnStart = true
          store.writeCursor(cursor)
          store.writeHeartbeat({ version: 1, at: now(), clean: true })
          running = false
          if (timer) { clearTimeout(timer); timer = null }
          applyPowerSave()
          void exclusive(() => deliverNowBounded(1000)).catch(() => undefined)
        } else {
          void exclusive(async () => { await resetCursor(null); await deliverNowBounded(5000) }).catch((error) => log('cursor reset failed', error))
        }
      } catch (error) { log('after database operation failed', error) }
    },
    /** صفر کردن (مرحلهٔ ۸): خبر ⚠️ «صفر کردن آغاز شد» پیش از کار، در صف بیرون از پایگاه داده. */
    beforeFactoryReset: () => exclusive(async () => {
      if (!running) return
      const offset = await offsetHours()
      enqueueMany([systemEvent('♻️ صفر کردن برنامه آغاز شد', ['پیش از آن بکاپ محافظ گرفته می‌شود.'], { important: true }, offset)])
      await deliverNowBounded(5000)
    }),

    // ---------------------------------------------------------------- فقط آزمون
    /** یک دور حلقه (آزمون‌ها؛ `read: true` فاصلهٔ ۵ ثانیه را نادیده می‌گیرد). */
    runOnce: (opts: { read?: boolean } = {}) => exclusive(async () => {
      if (opts.read) lastReadAt = 0
      await tick()
    })
  }
}
export type MessengerEngine = ReturnType<typeof createMessengerEngine>
