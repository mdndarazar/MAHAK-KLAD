/**
 * طرح ۱۴۰۵ · مرحلهٔ ۷ (مورد ۶؛ معماری §۴-۷، طرح §۲۶-۲ بند ۷) — «خلاصهٔ امروز» از پیش ساخته.
 *
 *  - یک سازنده برای هر سه مصرف‌کننده: گوشی (`phoneReports.ts`)، دکمهٔ «خلاصهٔ امروز» ربات و خلاصهٔ ساعت ۲۴
 *    پیام‌رسان. همه همان `buildDailySummary` را با همان عددهای گزارش رایانه می‌خوانند.
 *  - تازه‌سازی دوره‌ای (هر چند دقیقه) فقط وقتی `start()` صدا زده شده باشد (هاب روشن). درخواست گوشی هرگز
 *    محاسبهٔ سنگین شروع نمی‌کند: فقط آخرین نسخهٔ ساخته‌شده را با ساعتش می‌خواند («به‌روز تا ساعت …»).
 *  - تک‌اجرا: هر بار فقط یک محاسبه. شکست، نسخهٔ قبلی را نگه می‌دارد؛ `stop()` نسخه را پاک می‌کند (پس از
 *    بازگردانی یا توقف هاب، عدد کهنه دیده نمی‌شود).
 *  - هیچ نوشتنی در پایگاه داده ندارد.
 */
import { buildDailySummary, type DailySummary, type SummaryDeps } from './messenger/messengerSummary'
import { officialDay } from './messenger/messengerFormat'

export const TODAY_REFRESH_MS = 5 * 60_000

export interface TodaySnapshot { day: string; at: number; offsetHours: number; summary: DailySummary }
export interface TodaySummaryOptions {
  /** خوانده‌شده هنگام محاسبه (نه هنگام ساخت)؛ موتور پیام‌رسان بی خلاصه هم ساخته می‌شود. */
  deps: () => SummaryDeps
  offsetHours: () => Promise<number>
  now?: () => number
  refreshMs?: number
}
export type TodaySummary = ReturnType<typeof createTodaySummary>

export function createTodaySummary(options: TodaySummaryOptions) {
  const now = options.now ?? Date.now
  const refreshMs = options.refreshMs ?? TODAY_REFRESH_MS
  let cached: TodaySnapshot | null = null
  let running: { gen: number; task: Promise<TodaySnapshot | null> } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let generation = 0

  async function offset(): Promise<number> {
    try {
      const value = await options.offsetHours()
      return Number.isFinite(value) ? value : 0
    } catch { return 0 }
  }
  async function compute(): Promise<TodaySnapshot> {
    const offsetHours = await offset()
    const at = now(), day = officialDay(at, offsetHours)
    const summary = await buildDailySummary(day, options.deps(), { offsetHours, now: at })
    return { day, at, offsetHours, summary }
  }
  /** تک‌اجرا؛ نتیجهٔ محاسبه‌ای که پس از `stop()` تمام شود دور ریخته می‌شود. */
  function refresh(): Promise<TodaySnapshot | null> {
    if (running && running.gen === generation) return running.task
    const started = generation
    const task: Promise<TodaySnapshot | null> = compute().then(snapshot => {
      if (started !== generation) return null
      cached = snapshot
      return snapshot
    }, () => null).finally(() => { if (running?.task === task) running = null })
    running = { gen: started, task }
    return task
  }
  /** آخرین نسخهٔ همین روز (به ساعت رسمی)، یا null. هیچ محاسبه‌ای شروع نمی‌کند. */
  function current(): TodaySnapshot | null {
    const copy = cached
    if (!copy) return null
    const t = now()
    if (t < copy.at || officialDay(t, copy.offsetHours) !== copy.day) return null
    return copy
  }
  /** برای ربات: نسخهٔ تازه‌تر از `maxAgeMs`، وگرنه یک محاسبهٔ تک‌اجرا. */
  async function latest(maxAgeMs = refreshMs): Promise<TodaySnapshot> {
    const copy = current()
    if (copy && now() - copy.at <= maxAgeMs) return copy
    const fresh = await refresh()
    if (fresh) return fresh
    const fallback = current()
    if (fallback) return fallback
    return compute()
  }
  /** خلاصهٔ کامل یک روز (ساعت ۲۴)، با همان سازنده. */
  function forDay(day: string, ctx: { offsetHours: number; now: number }): Promise<DailySummary> {
    return buildDailySummary(day, options.deps(), ctx)
  }
  function start(): void {
    if (timer) return
    void refresh()
    timer = setInterval(() => { void refresh() }, refreshMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    generation++
    cached = null
  }
  return { refresh, current, latest, forDay, start, stop, running: () => timer !== null }
}
