/**
 * طرح ۱۴۰۵ · مورد ۱۵ (معماری §۴-۱-ب) — دکمه‌های ربات تلگرام و بله؛ پیش‌فرض خاموش.
 *
 * وقتی «پاسخ ربات به دکمه‌ها» روشن است (کلیدسازی، رمز تایپی مدیر):
 *   ۱) `getUpdates` پیوسته با long polling و تأیید `offset` خوانده می‌شود؛ فقط ارتباط بیرون‌رونده.
 *   ۲) هر درخواست تازهٔ فروشنده برای گیرنده‌های دارای اجازه («می‌تواند درخواست مجوز را تأیید کند») پیام می‌شود:
 *      نام فارسی قفل با نشان «پولی» یا «یک بار»، کد ۶ رقمی مقایسه، ساعت، شمارهٔ پنجره و دو دکمهٔ «✅ تأیید» و
 *      «❌ رد». `callback_data` یک نشانهٔ تصادفی یک‌بارمصرف است، نه شناسهٔ درخواست. مبلغ هرگز در این پیام نیست.
 *   ۳) تأیید: گفت‌وگو جفت‌شده و دارای اجازه، نشانه تازه، درخواست هنوز در انتظار، و کنترل از راه دور روشن و بی
 *      توقف اضطراری (P2). سپس همان `createGrant` با سیاست همان قفل؛ عضو `bot-<شناسهٔ گیرنده>`. اولین تصمیم برنده
 *      است و پیام بقیهٔ گیرنده‌ها با `editMessageText` نتیجه را نشان می‌دهد.
 *   ۴) رد: همان لغو درخواست؛ پنجرهٔ فروشنده «مدیر رد کرد» می‌بیند.
 *   ۵) «منو»: «بستن همهٔ مجوزها» (با دکمهٔ دوم «مطمئنم»)، «مجوزهای باز» و «خلاصهٔ امروز».
 *   ۶) هرگز با ربات: P2، بازیابی، تغییر مسئول صندوق، PIN، تنظیمات و هر «کلیدسازی».
 * هر تأیید، رد و «بستن همه» یک ردیف `ACCESS_EVENT` با نام گیرنده دارد و همان لحظه به همهٔ گیرنده‌ها خبر داده
 * می‌شود. دکمهٔ کهنه «منقضی شد» می‌گیرد. ۴۰۹ ⇒ خواندن می‌ایستد و ربات به «فقط خبر» برمی‌گردد. هر گفت‌وگو حداکثر
 * یک فرمان در ۵ ثانیه. عضو `bot-<n>` عضو واقعی هاب نیست؛ با P1، P2، خاموش کردن کلید ربات یا برداشتن تیک اجازهٔ
 * همان گیرنده بسته می‌شود.
 */
import { randomBytes } from 'node:crypto'
import { gateEntry } from '@shared/gateCatalog'
import { LOCKED_PANELS, panelTitle } from '@shared/panels'
import type { BotApi, BotCallbackQuery, BotMessage, BotUpdate, InlineKeyboard } from './messengerAdapters'
import { fmtAt, fmtClock, num } from './messengerFormat'
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
}

const MEMBER_PREFIX = 'bot-'
export const botMemberId = (recipientId: string): string => `${MEMBER_PREFIX}${recipientId}`
const TOKEN = /^[A-Za-z0-9_-]{22}$/
const COMMAND_GAP_MS = 5000
const CONFIRM_TTL_MS = 2 * 60_000
const OLD_MESSAGE_SEC = 120
const ALLOWED_UPDATES = ['message', 'callback_query'] as const
const MENU_WORDS = new Set(['منو', '/menu', 'menu', '/start'])

interface Sent { recipientId: string; provider: MessengerProvider; chatId: number; messageId: number }
interface RequestState { req: BotRemoteRequest; text: string; sentTo: Set<string>; messages: Sent[]; decided: boolean; at: number }
type TokenInfo = { kind: 'a' | 'r'; requestId: string; recipientId: string } | { kind: 'c'; recipientId: string; expiresAt: number }

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

  const newToken = () => randomBytes(16).toString('base64url')
  const approvers = (provider?: MessengerProvider): MessengerRecipient[] =>
    (ctx.settings()?.recipients ?? []).filter((r) => r.active && r.canApprove && (!provider || r.provider === provider))
  const recipientOf = (provider: MessengerProvider, chatId: unknown): MessengerRecipient | null =>
    approvers(provider).find((r) => r.chatId === chatId) ?? null

  async function requestText(req: BotRemoteRequest): Promise<string> {
    const offset = await ctx.offsetHours()
    return [
      '🔐 درخواست مجوز از رایانهٔ فروشگاه',
      `قفل: ${botLockTitle(req.panel)}`,
      `کد مقایسه: ${req.code}`,
      `ساعت: ${fmtClock(ctx.now(), offset)}`,
      `پنجرهٔ ${num(req.ownerWindowId)}`,
      ...(Number.isSafeInteger(req.recent) && (req.recent as number) > 3 ? [`⚠️ ${num(req.recent as number)} درخواست برای همین قفل در ۱۰ دقیقهٔ اخیر`] : []),
      'کد را با کدی که فروشنده می‌بیند مقایسه کنید.'
    ].join('\n')
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
    await ctx.api(provider)?.sendMessage(r.chatId, '🤖 منوی ربات فروشگاه', { inline_keyboard: [
      [{ text: '🔒 بستن همهٔ مجوزها', callback_data: 'm:close' }],
      [{ text: '📋 مجوزهای باز', callback_data: 'm:list' }],
      [{ text: '📊 خلاصهٔ امروز', callback_data: 'm:sum' }]
    ] })
  }
  async function openList(provider: MessengerProvider, r: MessengerRecipient): Promise<void> {
    let grants: ReturnType<BotRemote['openGrants']> = []
    try { grants = ctx.remote?.openGrants() ?? [] } catch { grants = [] }
    const lines = grants.length
      ? grants.map((g) => `• ${botLockTitle(g.panel)} · پنجرهٔ ${num(g.ownerWindowId)} · ${g.claimed ? 'باز' : 'تأییدشده، هنوز باز نشده'} · ${num(Math.max(1, Math.ceil(g.remainingMs / 60_000)))} دقیقه`)
      : ['الان هیچ مجوز راه دوری باز نیست.']
    await ctx.api(provider)?.sendMessage(r.chatId, ['📋 مجوزهای باز', ...lines].join('\n'))
  }

  async function onCallback(provider: MessengerProvider, cq: BotCallbackQuery): Promise<void> {
    const chatId = cq.message?.chat?.id
    if (typeof cq.id !== 'string' || !cq.id) return
    if (cq.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId)) { await answer(provider, cq); return }
    const r = recipientOf(provider, chatId)
    if (!r) { await answer(provider, cq, 'این گفت‌وگو اجازهٔ تأیید ندارد.'); return }
    if (rateLimited(provider, chatId as number)) { await answer(provider, cq); return }
    const data = typeof cq.data === 'string' ? cq.data : ''
    if (data === 'm:list') { await answer(provider, cq); await openList(provider, r); return }
    if (data === 'm:sum') {
      await answer(provider, cq)
      try { const s = await ctx.summary(); await ctx.api(provider)?.sendMessage(r.chatId, [s.title, ...s.lines].join('\n').slice(0, 3900)) } catch (error) { ctx.log('bot summary failed', error) }
      return
    }
    if (data === 'm:close') {
      await answer(provider, cq)
      const t = newToken()
      tokens.set(t, { kind: 'c', recipientId: r.id, expiresAt: ctx.now() + CONFIRM_TTL_MS })
      await ctx.api(provider)?.sendMessage(r.chatId, 'همهٔ مجوزهای راه دور و قفل‌های بازشده با کد یا مجوز بسته شوند؟ (تا ۲ دقیقه)', { inline_keyboard: [[{ text: '✅ مطمئنم، همه را ببند', callback_data: `c:${t}` }]] })
      return
    }
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
      await editAll(state, `✅ تأیید شد (${r.name}) · ${fmtAt(ctx.now(), await ctx.offsetHours())}`)
      await ctx.notifyAll('🤖 درخواست مجوز با ربات تأیید شد', [`قفل: ${title}`, `پنجرهٔ ${num(state.req.ownerWindowId)}`, `گیرنده: ${r.name}`], true)
      return
    }
    if (!remote.reject(state.req)) { state.decided = true; dropTokens(state.req.requestId); await expired(provider, cq); return }
    state.decided = true; dropTokens(state.req.requestId)
    remote.note({ decision: 'رد', recipientName: r.name, titleFa: title, windowNo: state.req.ownerWindowId })
    await answer(provider, cq, 'رد شد')
    await editAll(state, `❌ رد شد (${r.name}) · ${fmtAt(ctx.now(), await ctx.offsetHours())}`)
    await ctx.notifyAll('🤖 درخواست مجوز با ربات رد شد', [`قفل: ${title}`, `پنجرهٔ ${num(state.req.ownerWindowId)}`, `گیرنده: ${r.name}`], true)
  }

  async function onMessage(provider: MessengerProvider, message: BotMessage): Promise<void> {
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (message.chat?.type !== 'private' || !MENU_WORDS.has(text)) return
    if (Number.isSafeInteger(message.date) && ctx.now() / 1000 - (message.date as number) > OLD_MESSAGE_SEC) return
    const r = recipientOf(provider, message.chat.id)
    if (!r || rateLimited(provider, message.chat.id)) return
    await menu(provider, r)
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
    ctx.active() && !!ctx.api(provider) && approvers(provider).length > 0 && ctx.pairingProvider() !== provider

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
      for (const provider of ['telegram', 'bale'] as const) if (canPoll(provider)) loop(provider)
    },
    pollOnce,
    /** خاموش شدن کلید ربات یا برداشتن اجازه: مجوزهای همان گیرنده(ها) بسته و پیام‌های در انتظار «بسته شد». */
    async revoke(recipientIds: string[], footer: string): Promise<void> {
      for (const id of recipientIds) { try { ctx.remote?.revokeMember(botMemberId(id)) } catch (error) { ctx.log('bot revoke failed', error) } }
      for (const [t, info] of tokens) if (recipientIds.includes(info.recipientId)) tokens.delete(t)
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
