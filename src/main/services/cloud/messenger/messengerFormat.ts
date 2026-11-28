/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — قالب پیام (طرح §۲۱ بند ۵، معماری §۴-۱).
 *
 *  - متن ساده و مرتب (انتخاب مالک)؛ تاریخ و ساعت خود رویداد به شمسی و به ساعت رسمی برنامه؛
 *  - کد رویداد کوتاه و ثابت؛ برچسب «ارسال با تأخیر» و «ممکن است تکراری باشد» هنگام ارسال افزوده می‌شوند؛
 *  - چند رویداد در یک پیام جمع می‌شوند، به ترتیب زمان و هر کدام با ساعت خودش، تا سقف هر آداپتور؛
 *  - لایهٔ دوم محرمانگی: شمارهٔ تلفن و هر چیز شبیه کلید ربات از متن نهایی پاک می‌شود.
 *    لایهٔ اول، فهرست ثابت فیلدهای مجاز در `messengerEvents.ts` است.
 *  - دفتر آزمون ۴-۳۵: قالب یکدست همهٔ پیام‌ها فقط همین‌جاست (`formatMessage`): سرتیتر، خط زیر سرتیتر پیام چندبخشی،
 *    یک نشانهٔ ثابت برای هر برچسب، فهرست شماره‌دار قلم‌ها، پایینِ جدا («▫️ کد رویداد») و جداکنندهٔ میان پیام‌ها.
 *    سازنده‌ها همان خط‌های سادهٔ «برچسب: مقدار» را می‌سازند (گزارش گوشی همان خط‌ها را نشان می‌دهد)؛ قالب هنگام
 *    فرستادن روی آن‌ها می‌نشیند. متن ساده می‌ماند، بی HTML یا Markdown.
 */
import { faDigits, money, toClock, toJalaliDate } from '@shared/jalali'
import { applyOfficialOffset } from '@shared/receipt'
import { LATE_AFTER_MS, type OutboxItem } from './messengerTypes'

/** میان پیام‌هایی که پشت سر هم در یک پیام می‌آیند؛ «— — —» قدیمی را در خودش دارد (۴-۳۵). */
export const SEPARATOR = '\n\n✦ — — — ✦\n\n'
/** خط زیر سرتیتر پیام چندبخشی (فاکتور، گزارش، خلاصه) */
export const DIVIDER = '━━━━━━━━━━━━'

export function officialDate(at: number, offsetHours: number): Date {
  return applyOfficialOffset(new Date(at), { offsetHours })
}
/** «۱۴۰۵/۰۸/۳۰ ساعت ۱۶:۰۴» به ساعت رسمی برنامه */
export function fmtAt(at: number, offsetHours: number): string {
  const d = officialDate(at, offsetHours)
  return `${faDigits(toJalaliDate(d))} ساعت ${faDigits(toClock(d, false))}`
}
export function fmtClock(at: number, offsetHours: number): string {
  return faDigits(toClock(officialDate(at, offsetHours), false))
}
/** روز شمسی رسمی یک لحظه (yyyy/MM/dd، رقم لاتین) */
export function officialDay(at: number, offsetHours: number): string {
  return toJalaliDate(officialDate(at, offsetHours))
}
export const rial = (n: unknown): string => `${money(Number(n) || 0)} ریال`
export const num = (n: unknown): string => faDigits(String(Math.trunc(Number(n) || 0)))
/** عدد ثبت‌نشده «ثبت نشده» نوشته می‌شود، نه صفر (طرح §۲۱ بند ۴) */
export const rialOrMissing = (n: unknown): string => (n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? 'ثبت نشده' : rial(n))

/** «۲ ساعت و ۱۰ دقیقه» */
export function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes === 0) return 'کمتر از یک دقیقه'
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60
  const parts: string[] = []
  if (days) parts.push(`${faDigits(days)} روز`)
  if (hours) parts.push(`${faDigits(hours)} ساعت`)
  if (mins || !parts.length) parts.push(`${faDigits(mins)} دقیقه`)
  return parts.join(' و ')
}

const PHONE = /(?:(?:\+|00)?(?:98|۹۸)|[0۰])[9۹][0-9۰-۹]{9}(?![0-9۰-۹])/g
const TOKEN_LIKE = /[0-9]{3,20}:[A-Za-z0-9_-]{20,}/g

/** لایهٔ دوم: هر شمارهٔ تلفن همراه، هر چیز شبیه کلید ربات و هر راز شناخته‌شده از متن پاک می‌شود. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(PHONE, '[شماره حذف شد]').replace(TOKEN_LIKE, '[کلید حذف شد]')
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[حذف شد]')
  return out
}

/**
 * دفتر آزمون ۴-۳۵ — یک نشانهٔ ثابت برای هر برچسب، در همهٔ پیام‌ها (کار یکسان، نشانهٔ یکسان). برچسب همان متن پیش از «:»
 * است، بی پرانتز پایانی («شمرده (کشو + کارت‌خوان)» ⇐ «شمرده»). برچسبی که این‌جا نیست بی‌نشانه می‌ماند.
 */
const SIGN_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['💰', ['جمع فاکتور', 'جمع برگشت', 'جمع کالای برگشتی', 'جمع کالاها', 'جمع تازه', 'جمع', 'مبلغ', 'مبلغ فاکتور', 'مبلغ ثبت‌شده', 'مبلغ برگشت', 'مبلغ مصرف', 'نقد مورد انتظار']],
  ['🏷️', ['تخفیف']],
  ['➕', ['عوارض و مالیات', 'هزینهٔ خدمات', 'هزینهٔ پیک', 'حق سرویس']],
  ['💳', ['پرداخت', 'پرداخت هنگام ثبت', 'بازپرداخت', 'مقصد پول', 'نقد', 'سایر']],
  ['📒', ['مانده فاکتور', 'مانده', 'باقی‌مانده', 'فاکتورهای این بازه که هنوز مانده دارند', 'در انتظار پرداخت از روزهای قبل']],
  ['⚖️', ['مابه‌التفاوت', 'مغایرت', 'سقف مجاز مغایرت']],
  ['🧮', ['شمرده', 'شمرده و مرجع', 'مرجع کل دوره', 'گردش نقد و کارت‌خوان این نشست', 'بستن‌های صندوق']],
  ['👤', ['فروشنده', 'فروشندهٔ فاکتور', 'کاربر', 'مسئول صندوق', 'تحویل‌دهنده', 'تحویل‌گیرنده', 'مشتری', 'گیرنده', 'مدیر', 'صادرکننده', 'مصرف‌کننده', 'شمارنده', 'به دست']],
  ['🕘', ['شیفت', 'شیفت‌های باز', 'شیفت باز در ساعت ۲۴', 'شیفت‌های باز در ساعت ۲۴', 'ساعت', 'آغاز', 'پایان برنامه', 'زمان تحویل', 'زمان بستن', 'زمان بستن خودکار', 'زمان گزارش']],
  ['📅', ['روز', 'بازه', 'سررسید', 'چک پاس‌نشده با سررسید فردا', 'چک‌های پاس‌نشده با سررسید فردا']],
  ['⏳', ['مهلت']],
  ['📝', ['دلیل', 'کار']],
  ['📄', ['سند']],
  ['🔗', ['زنجیره']],
  ['🔒', ['قفل', 'بخش', 'قسمت', 'روش تأیید']],
  ['🔎', ['کد مقایسه']],
  ['🎫', ['اعتبار خرید']],
  ['🛒', ['فروش']],
  ['↩️', ['برگشت', 'کالای برگشتی']],
  ['🛍', ['قلم‌ها', 'کالاها', 'کالای جایگزین']],
  ['👥', ['به تفکیک فروشنده']],
  ['⏰', ['تحویل‌های دیر']],
  ['🌙', ['صندوق‌های بسته‌نشده']],
  ['🖨️', ['چاپ دوبارهٔ بارکد']],
  ['💾', ['آخرین بکاپ موفق']],
  ['📨', ['فاکتورهای این روز در برنامه']],
  ['📥', ['صف این گفت‌وگو']],
  ['🔢', ['تعداد', 'شمار فاکتور', 'شمار در این بازه', 'شمار ردیف‌ها در این بازه']],
  ['🔓', ['مجوزهای باز']],
  ['🤖', ['ربات']],
  ['⚙️', ['گزینه']]
]
export const LABEL_SIGNS: ReadonlyMap<string, string> = new Map(SIGN_GROUPS.flatMap(([sign, labels]) => labels.map((label) => [label, sign] as const)))

/** «برچسب: مقدار» ⇐ «نشانه برچسب: مقدار». خطی که با نشانه، فاصله یا «•» آغاز شده، یا برچسبش ناشناخته است، همان می‌ماند. */
export function signLine(line: string): string {
  if (!/^[\p{L}\p{N}]/u.test(line)) return line
  const colon = line.indexOf(':')
  if (colon <= 0 || colon > 48) return line
  const sign = LABEL_SIGNS.get(line.slice(0, colon).replace(/\s*\([^()]*\)\s*$/, '').trim())
  return sign ? `${sign} ${line}` : line
}

/** زیرسرتیتر یک بخش: «قلم‌ها:» (نشانه‌اش را `signLine` می‌گذارد). */
export const sectionTitle = (title: string): string => `${title}:`

/** یک قلم، کوتاه برای صفحهٔ گوشی: «• نام — ۲ × ۱٬۸۰۰٬۰۰۰ = ۳٬۶۰۰٬۰۰۰ ریال»؛ تخفیف ردیف پیش از «=»؛ بی قیمت، «— ۲ عدد». */
export function itemLine(name: string, qty: unknown, unitPrice: unknown, opts: { extra?: string; total?: unknown } = {}): string {
  const price = Number(unitPrice) || 0
  const total = opts.total === undefined || opts.total === null ? '' : ` = ${rial(opts.total)}`
  return `• ${faDigits(name || 'کالای بی‌نام')} — ${num(qty)}${price ? ` × ${money(price)}` : ' عدد'}${opts.extra ? ` · ${opts.extra}` : ''}${total}`
}

const INDENT = '  '
/** بخشی با چند گروه (مثل «به تفکیک فروشنده»): زیرسرتیتر، و هر گروه با خط اولش و خط‌های تورفتهٔ زیرش؛ میان گروه‌ها یک خط خالی. */
export function groupedSection(title: string, groups: ReadonlyArray<readonly string[]>): string[] {
  if (!groups.length) return []
  return [sectionTitle(title), ...groups.flatMap((g, i) => [...(i ? [''] : []), ...g.map((line, j) => (j ? `${INDENT}${line}` : line))])]
}

/** بدنه: هر «برچسب: مقدار» با نشانه‌اش، و هر دنبالهٔ «•» (تورفته یا نه) فهرست شماره‌دار «۱)»، «۲)»… که از نو شمرده می‌شود. */
export function formatBody(lines: readonly string[]): string[] {
  const out: string[] = []
  let n = 0
  for (const line of lines) {
    const bullet = /^\s*• /.exec(line)
    if (bullet) {
      out.push(`${INDENT}${faDigits(++n)}) ${line.slice(bullet[0].length)}`)
      continue
    }
    n = 0
    out.push(signLine(line))
  }
  return out
}

const RLM = '\u200F'
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
/**
 * راست‌چین درست: پیام‌رسان جهت هر خط را از نخستین حرفش می‌گیرد؛ خطی که با حرف لاتین آغاز می‌شود (نام کالا یا «Master
 * Override») یک نشانهٔ نامرئی راست‌به‌چپ (RLM) در آغاز می‌گیرد. خط فارسی دست نمی‌خورد.
 */
export function rtlLine(line: string): string {
  const first = /\p{L}/u.exec(line)
  return first && !RTL_LETTER.test(first[0]) ? `${RLM}${line}` : line
}

/**
 * یک پیام کامل: سرتیتر (نشانهٔ نوع، نام کار، تاریخ و ساعت در یک خط)، خط «━━━━━━━━━━━━» زیر آن برای پیام چندبخشی (سه خط
 * یا بیشتر)، بدنه (`formatBody`) و پایینِ جدا (کد رویداد و برچسب‌های لحظهٔ ارسال).
 */
export function formatMessage(header: string, lines: readonly string[], footer: readonly string[] = []): string {
  const body = formatBody(lines)
  const multi = lines.filter((line) => line !== '').length >= 3
  return [header, ...(multi ? [DIVIDER] : []), ...body, ...footer].map(rtlLine).join('\n')
}

/** متن یک خانهٔ صف، با برچسب‌های لحظهٔ ارسال در پایین. */
export function renderItem(item: OutboxItem, now: number): string {
  const head = `${item.important && !item.title.startsWith('⚠️') ? '⚠️ ' : ''}${item.title}`
  const footer = [`▫️ کد رویداد: ${item.code}`]
  if (now - item.at > LATE_AFTER_MS) footer.push('🕒 ارسال با تأخیر')
  if (item.maybeDup) footer.push('🔁 ممکن است تکراری باشد (ارسال قبلی نامعلوم ماند)')
  return formatMessage(head, item.lines, footer)
}

/**
 * دفتر آزمون ۴-۳۵ — پیام بلندتر از سقف ⇒ خط‌های چند بخش، سر مرز خط. بدنه پیش از بخش کردن قالب می‌خورد، پس شمارهٔ
 * قلم‌ها در بخش بعد ادامه می‌یابد؛ اندازهٔ هر بخش با همان متن قالب‌خورده سنجیده می‌شود، با جای «(بخش i از n)»، نشان ⚠️
 * و همهٔ برچسب‌های پایین. خطی که تنها هم جا نمی‌شود، مثل پیش سخت بریده می‌شود. چیزی جا نمی‌افتد.
 */
export function splitLines(item: OutboxItem, limit: number): string[][] {
  const probe: OutboxItem = { ...item, title: `${item.title} (بخش ۹۹۹ از ۹۹۹)`, important: true, maybeDup: true, at: 0 }
  const size = (lines: string[]): number => renderItem({ ...probe, lines }, LATE_AFTER_MS + 1).length
  const room = Math.max(100, limit - size([]) - 16)
  const parts: string[][] = []
  let current: string[] = []
  for (const line of formatBody(item.lines).flatMap((l) => splitText(l, room))) {
    if (current.length && size([...current, line]) > limit) { parts.push(current); current = [] }
    current.push(line)
  }
  if (current.length) parts.push(current)
  return parts
}

/** متن بلند سر مرز خط شکسته می‌شود؛ خط بلندتر از سقف هم سخت بریده می‌شود. */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    let rest = line
    while (rest.length > limit) {
      if (current) { parts.push(current); current = '' }
      parts.push(rest.slice(0, limit)); rest = rest.slice(limit)
    }
    const next = current ? `${current}\n${rest}` : rest
    if (next.length > limit) { parts.push(current); current = rest } else current = next
  }
  if (current) parts.push(current)
  return parts
}

/**
 * از سر صف، تا جایی که در یک پیام جا شود. همیشه دست‌کم خانهٔ اول برمی‌گردد (اگر خودش از سقف بلندتر
 * بود، `parts` آن را چند تکه کرده است). خانهٔ «single» (پس از خطای ۴۰۰) تنها می‌رود.
 */
export function packItems(items: readonly OutboxItem[], now: number, limit: number, prefix?: string | null): { count: number; texts: string[] } {
  const texts: string[] = []
  let text = prefix ?? ''
  let count = 0
  for (const item of items) {
    const rendered = renderItem(item, now)
    if (count === 0 && !prefix && rendered.length > limit) return { count: 1, texts: splitText(rendered, limit) }
    if (item.single && (count > 0 || prefix)) break
    const next = text ? `${text}${SEPARATOR}${rendered}` : rendered
    if (next.length > limit) {
      if (count === 0 && prefix) { texts.push(text); return { count: 0, texts } }
      break
    }
    text = next
    count++
    if (item.single) break
  }
  if (text) texts.push(text)
  return { count, texts }
}
