/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — خلاصهٔ ساعت ۲۴ (طرح §۲۴-۹ پرسش ۸، §۲۵-۴ بند «و»، §۲۶-۲ افزودهٔ ۲۹؛
 * معماری §۴-۱: خط «امروز N مجوز و M کد مصرف شد»).
 *
 * عددهای فروش و «به تفکیک فروشنده» از همان تابع‌های گزارش رایانه می‌آیند (`salesService.summary`،
 * `staffReportService.performance` و `abnormalDiscounts`)، با همان روز تقویمی، تا عیناً همان عددهای صفحهٔ
 * رایانه باشند. ماشهٔ ارسال، ساعت ۲۴ به ساعت رسمی برنامه است. همه فقط خواندن‌اند.
 */
import { faDigits, fromJalaliDate, jalaliAddDays } from '@shared/jalali'
import { ACCESS_EVENT_KINDS } from '@shared/gateCatalog'
import { fmtAt, num, rial } from './messengerFormat'
import type { MessengerDb } from './messengerDb'

export interface SalesSummaryLike {
  count: number; grandTotal: number; cashTotal: number; cardTotal: number; otherTotal: number
  managerAccountTotal: number; creditTotal: number; returnedTotal?: number
}
export interface StaffRowLike { userId: number | null; userName: string; invoiceCount: number; returnCount: number; exchangeCount: number; discountTotal: number }

export interface SummaryDeps {
  db: MessengerDb
  salesSummary(filter: { fromJalali: string; toJalali: string }): Promise<SalesSummaryLike>
  staffPerformance(filter: { fromJalali: string; toJalali: string }): Promise<{ rows: StaffRowLike[] }>
  abnormalDiscounts(filter: { fromJalali: string; toJalali: string }): Promise<{ rows: Array<{ userId: number | null }>; disabled?: boolean }>
  /** زمان آخرین بکاپ خودکار موفق (ms)، یا null */
  lastBackupAt(): Promise<number | null>
}

export interface DailySummary {
  day: string
  title: string
  lines: string[]
  /** هر فروشنده یک بخش؛ پیام بلند سر مرز همین بخش‌ها شکسته می‌شود */
  sellerSections: string[][]
  /** شمار فاکتورهای امروز در برنامه (کنار شمار پیام‌های فروش فرستاده‌شده در گزینهٔ «همه موارد») */
  invoiceCount: number
  /** زمان «ساعت ۲۴» همان روز */
  endAt: number
  /**
   * مرحلهٔ ۷ (معماری §۴-۷): همان عددهای خط‌های بالا، بی قالب، برای «خلاصهٔ امروز» گوشی و آزمون برابری.
   * مبلغ‌ها رشتهٔ عدد صحیح‌اند و دقیقاً همان عددی‌اند که `rial()` قالب می‌کند.
   */
  numbers: DailySummaryNumbers
}
export interface DailySummaryNumbers {
  count: number; grandTotal: string; cashTotal: string; cardTotal: string; managerAccountTotal: string
  otherTotal: string; creditTotal: string; returnCount: number; exchangeCount: number
}
/** همان عددی که `rial()` نشان می‌دهد (`money(Number(n) || 0)`)، به رشتهٔ عدد صحیح. */
const amountOf = (n: unknown): string => {
  if (typeof n === 'bigint') return n.toString()
  const r = Math.round(Number(n) || 0)
  return Object.is(r, -0) ? '0' : String(r)
}

const STATE_FA = (diff: number): string => (diff === 0 ? 'تطبیق کامل' : diff < 0 ? `کسری ${rial(Math.abs(diff))}` : `اضافه ${rial(diff)}`)

/** بازهٔ یک روز تقویمی (همان بازهٔ گزارش‌های رایانه). */
export function dayRange(day: string): { from: Date; to: Date } {
  return { from: fromJalaliDate(day), to: fromJalaliDate(jalaliAddDays(day, 1)) }
}

export async function buildDailySummary(day: string, deps: SummaryDeps, ctx: { offsetHours: number; now: number }): Promise<DailySummary> {
  const { from, to } = dayRange(day)
  const filter = { fromJalali: day, toJalali: day }
  const sales = await deps.salesSummary(filter)
  const staff = await deps.staffPerformance(filter)
  let abnormal: { rows: Array<{ userId: number | null }>; disabled?: boolean } = { rows: [], disabled: true }
  try { abnormal = await deps.abnormalDiscounts(filter) } catch {}
  const closes = await deps.db.cashSessionsClosed(from, to)
  const openShifts = await deps.db.openShiftsAt(to)
  const tomorrow = dayRange(jalaliAddDays(day, 1))
  const cheques = await deps.db.chequesDue(tomorrow.from, tomorrow.to)
  const counted = await deps.db.auditRowsInRange(['VOID', 'SALE_PRICE_OVERRIDE', 'EXCHANGE_PRICE_OVERRIDE', 'CREDIT_REPRINT', 'ACCESS_EVENT'], from, to)
  const lastBackupAt = await deps.lastBackupAt().catch(() => null)
  // دفتر آزمون ۴-۲۷: پیگیری مدیر (تحویل دیر و صندوق بسته‌نشده)؛ مغایرت نیست و عدد پولی ندارد.
  const followUp = await deps.db.custodyFollowUp?.(from, to).catch(() => null) ?? null

  const perUser = new Map<string, { voids: number; manual: number; reprints: number; abnormal: number }>()
  const slot = (userId: number | null) => {
    const key = String(userId ?? 'none')
    if (!perUser.has(key)) perUser.set(key, { voids: 0, manual: 0, reprints: 0, abnormal: 0 })
    return perUser.get(key)!
  }
  let grants = 0, codes = 0, reprints = 0
  // مرحلهٔ ۴ (مورد ۱۲): «چاپ دوبارهٔ بارکد» = کاغذهای `markPrinted`؛ رزرو فروشنده جدا و فقط اگر آزاد نشده باشد
  const sellerReserved: Array<{ id: number; userId: number | null }> = []
  const sellerReleased = new Set<number>()
  for (const row of counted) {
    if (row.action === 'VOID') slot(row.userId).voids++
    else if (row.action === 'SALE_PRICE_OVERRIDE' || row.action === 'EXCHANGE_PRICE_OVERRIDE') slot(row.userId).manual++
    else if (row.action === 'CREDIT_REPRINT') {
      let after: any = null
      try { after = JSON.parse(row.after ?? 'null') } catch {}
      if (after?.path === 'SELLER_CERTIFICATE_RELEASED') { if (Number.isSafeInteger(after.releasedFrom)) sellerReleased.add(after.releasedFrom) }
      else if (after?.path === 'SELLER_CERTIFICATE') { if (after.sellerReprint === true) sellerReserved.push({ id: row.id, userId: row.userId }) }
      else reprints++
    } else if (row.action === 'ACCESS_EVENT') {
      let kind = ''
      try { kind = String(JSON.parse(row.after ?? 'null')?.kind ?? '') } catch {}
      if (kind === ACCESS_EVENT_KINDS.CODE_USED) codes++
      else if (kind === ACCESS_EVENT_KINDS.REMOTE_GRANT_OPENED || kind === ACCESS_EVENT_KINDS.SCHEDULED_GRANT_OPENED) grants++
    }
  }
  for (const s of sellerReserved) if (!sellerReleased.has(s.id)) slot(s.userId).reprints++
  if (!abnormal.disabled) for (const row of abnormal.rows) slot(row.userId).abnormal++

  const rows = staff.rows ?? []
  const covered = new Set(rows.map((r) => String(r.userId ?? 'none')))
  const orphanIds = [...perUser.keys()].filter((k) => !covered.has(k) && k !== 'none').map(Number)
  const names = await deps.db.userNames([...closes.map((c) => c.closedBy ?? 0), ...openShifts.map((s) => s.userId ?? 0), ...orphanIds,
    ...(followUp ? [...followUp.late, ...followUp.unclosed].map((x) => x.userId ?? 0) : [])])
  const nameOf = (id: number | null): string => (id ? names.get(id) ?? `کاربر ${num(id)}` : 'نامشخص')
  const returns = rows.reduce((s, r) => s + (Number(r.returnCount) || 0), 0)
  const exchanges = rows.reduce((s, r) => s + (Number(r.exchangeCount) || 0), 0)
  const endAt = to.getTime()
  const lines: string[] = [
    `بازه: ${faDigits(day)}، ساعت ۰۰:۰۰ تا ۲۴:۰۰ (روز تقویمی گزارش‌های برنامه)`,
    `فروش: ${num(sales.count)} فاکتور · جمع ${rial(sales.grandTotal)}`,
    `نقد ${rial(sales.cashTotal)} · کارتخوان ${rial(sales.cardTotal)} · حساب مدیر ${rial(sales.managerAccountTotal)} · سایر (چک و…) ${rial(sales.otherTotal)} · نسیه ${rial(sales.creditTotal)}`,
    `برگشت: ${num(returns)} · تعویض: ${num(exchanges)}`,
    `بستن‌های صندوق: ${num(closes.length)}`,
    ...closes.map((c) => `  • ${names.get(c.closedBy ?? 0) ?? 'نامشخص'}: ${c.counted === null ? 'پول نقد شمرده نشد' : STATE_FA(c.difference)}`),
    ...(followUp?.active ? [
      followUp.late.length ? `تحویل‌های دیر: ${followUp.late.map((x) => `${nameOf(x.userId)} (${num(x.minutes)} دقیقه)`).join('، ')}` : 'تحویل‌های دیر: ندارد',
      followUp.unclosed.length ? `صندوق‌های بسته‌نشده: ${followUp.unclosed.map((x) => nameOf(x.userId)).join('، ')}` : 'صندوق‌های بسته‌نشده: ندارد'
    ] : []),
    `چاپ دوبارهٔ بارکد: ${num(reprints)}`,
    openShifts.length ? `شیفت‌های باز در ساعت ۲۴: ${openShifts.map((s) => `${s.name}${s.userId ? ` (${names.get(s.userId) ?? 'نامشخص'})` : ''}`).join('، ')}` : 'شیفت باز در ساعت ۲۴: ندارد',
    lastBackupAt ? `آخرین بکاپ موفق: ${fmtAt(lastBackupAt, ctx.offsetHours)}` : 'آخرین بکاپ موفق: پیدا نشد',
    ...(!lastBackupAt || ctx.now - lastBackupAt > 2 * 24 * 3600_000 ? ['⚠️ دو روز است بکاپ موفقی گرفته نشده است.'] : []),
    cheques.count ? `چک‌های پاس‌نشده با سررسید فردا: ${num(cheques.count)} چک، جمع ${rial(cheques.total)}` : 'چک پاس‌نشده با سررسید فردا: ندارد',
    `امروز ${num(grants)} مجوز و ${num(codes)} کد مصرف شد.`
  ]
  const sellerSections: string[][] = []
  for (const r of rows) {
    if (!r.invoiceCount && !r.returnCount && !r.exchangeCount && !perUser.get(String(r.userId ?? 'none'))) continue
    const extra = perUser.get(String(r.userId ?? 'none')) ?? { voids: 0, manual: 0, reprints: 0, abnormal: 0 }
    sellerSections.push([
      `👤 ${r.userName}`,
      `فاکتور ${num(r.invoiceCount)} · برگشت ${num(r.returnCount)} · تعویض ${num(r.exchangeCount)} · جمع تخفیف ${rial(r.discountTotal)}`,
      `تخفیف غیرعادی ${num(extra.abnormal)} · ابطال ${num(extra.voids)} · قیمت دستی ${num(extra.manual)} · چاپ دوبارهٔ بارکد ${num(extra.reprints)}`
    ])
  }
  // کسی که امروز فروشی نداشت ولی ابطال، قیمت دستی یا چاپ دوباره ثبت کرد
  for (const id of orphanIds) {
    const extra = perUser.get(String(id))!
    sellerSections.push([
      `👤 ${names.get(id) ?? `کاربر ${num(id)}`}`,
      'فاکتور ۰ · برگشت ۰ · تعویض ۰',
      `تخفیف غیرعادی ${num(extra.abnormal)} · ابطال ${num(extra.voids)} · قیمت دستی ${num(extra.manual)} · چاپ دوبارهٔ بارکد ${num(extra.reprints)}`
    ])
  }
  const numbers: DailySummaryNumbers = {
    count: Math.trunc(Number(sales.count) || 0), grandTotal: amountOf(sales.grandTotal), cashTotal: amountOf(sales.cashTotal),
    cardTotal: amountOf(sales.cardTotal), managerAccountTotal: amountOf(sales.managerAccountTotal), otherTotal: amountOf(sales.otherTotal),
    creditTotal: amountOf(sales.creditTotal), returnCount: returns, exchangeCount: exchanges
  }
  return { day, title: `📊 خلاصهٔ روز ${faDigits(day)}`, lines, sellerSections, invoiceCount: Number(sales.count) || 0, endAt, numbers }
}
