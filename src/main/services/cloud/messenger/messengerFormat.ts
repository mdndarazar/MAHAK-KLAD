/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — قالب پیام (طرح §۲۱ بند ۵، معماری §۴-۱).
 *
 *  - متن ساده و مرتب (انتخاب مالک)؛ تاریخ و ساعت خود رویداد به شمسی و به ساعت رسمی برنامه؛
 *  - کد رویداد کوتاه و ثابت؛ برچسب «ارسال با تأخیر» و «ممکن است تکراری باشد» هنگام ارسال افزوده می‌شوند؛
 *  - چند رویداد در یک پیام جمع می‌شوند، به ترتیب زمان و هر کدام با ساعت خودش، تا سقف هر آداپتور؛
 *  - لایهٔ دوم محرمانگی: شمارهٔ تلفن و هر چیز شبیه کلید ربات از متن نهایی پاک می‌شود.
 *    لایهٔ اول، فهرست ثابت فیلدهای مجاز در `messengerEvents.ts` است.
 */
import { faDigits, money, toClock, toJalaliDate } from '@shared/jalali'
import { applyOfficialOffset } from '@shared/receipt'
import { LATE_AFTER_MS, type OutboxItem } from './messengerTypes'

export const SEPARATOR = '\n\n— — —\n\n'

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

/** متن یک خانهٔ صف، با برچسب‌های لحظهٔ ارسال. */
export function renderItem(item: OutboxItem, now: number): string {
  const head = `${item.important && !item.title.startsWith('⚠️') ? '⚠️ ' : ''}${item.title}`
  const out = [head, ...item.lines, `کد رویداد: ${item.code}`]
  if (now - item.at > LATE_AFTER_MS) out.push('🕒 ارسال با تأخیر')
  if (item.maybeDup) out.push('🔁 ممکن است تکراری باشد (ارسال قبلی نامعلوم ماند)')
  return out.join('\n')
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
