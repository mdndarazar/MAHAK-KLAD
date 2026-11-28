/**
 * طرح ۱۴۰۵ · مرحلهٔ ۷ (مورد ۶؛ معماری §۴-۷) — فهرست ثابت نقطه‌های خواندنی «دیدن با گوشی» در main.
 *
 *  - هر بخش فقط یک تابع خواندنی خود رایانه را صدا می‌زند (همان تابع صفحه‌های برنامه)؛ هیچ تابع نوشتاری و
 *    هیچ دسترسی مستقیم به پایگاه داده این‌جا نیست (آزمون ایستای `plan1405-phone-reports.mjs`).
 *  - خروجی فقط فیلدهای ثابت `phoneReportCatalog.ts` است: مبلغ رشتهٔ عدد صحیح، متن کوتاه‌شده، بی کد و بارکد
 *    اعتبار و بی متن آزاد (یادداشت‌ها) و بی کد سند برگشت.
 *  - «خلاصهٔ امروز» از نسخهٔ از پیش ساخته (`todaySummary.ts`) خوانده می‌شود؛ درخواست گوشی محاسبه را شروع نمی‌کند.
 *  - «دیدن گزارش از گوشی» یک ردیف `ACCESS_EVENT` (`PHONE_REPORT_VIEW`)، حداکثر یکی برای هر عضو و هر بخش در ۱۰
 *    دقیقه؛ پیام نمی‌شود.
 *  - فرزند هاب هرگز `shop.db` را باز نمی‌کند: درخواست از راه کانال خصوصی ناظر هاب به همین‌جا می‌رسد.
 */
import { faDigits, jalaliEndOfDay, jalaliStartOfDay } from '@shared/jalali'
import { salesService } from '../SalesService'
import { staffReportService } from '../StaffReportService'
import { productService } from '../ProductService'
import { secondaryStockService } from '../SecondaryStockService'
import { storeCreditService } from '../StoreCreditService'
import { purchaseService } from '../PurchaseService'
import { cashboxService } from '../CashboxService'
import { shiftService } from '../ShiftService'
import { trendService } from '../management/TrendService'
import { LOCK_DURATION_KEYS, LOCK_DURATION_TITLES, readLockDurations } from '../locks/durations'
import { noteAccessEvent } from '../locks/accessEvents'
import { createMessengerDb } from './messenger/messengerDb'
import { fmtAt } from './messenger/messengerFormat'
import type { SummaryDeps } from './messenger/messengerSummary'
import { createTodaySummary, type TodaySummary } from './todaySummary'
import {
  PHONE_REPORTS, amountText, clipLines, clipText, intValue, isPhoneSection, nullableAmountText, nullableText, parsePhoneReport,
  parsePhoneReportRequest, type PhoneReportRequest, type PhoneReportValue, type PhoneSection, type PhoneValue
} from './phoneReportCatalog'
import { setPhoneReportSource } from './phoneReportSource'

type Row = Record<string, PhoneValue>

// ------------------------------------------------------------------ «خلاصهٔ امروز» مشترک (گوشی، ربات، ساعت ۲۴)
/** آخرین بکاپ موفق (تازه‌ترین پروندهٔ بکاپ)، برای خلاصه. */
async function lastBackupAt(): Promise<number | null> {
  const { backupService } = await import('../BackupService')
  const list = await backupService.list()
  const times = list.map((entry) => new Date(entry.at).getTime()).filter((t) => Number.isFinite(t))
  return times.length ? Math.max(...times) : null
}
/** همان وابستگی‌های خلاصهٔ پیام‌رسان: تابع‌های گزارش خود رایانه. */
export function todaySummaryDeps(): Omit<SummaryDeps, 'db'> {
  return {
    salesSummary: (filter) => salesService.summary(filter) as never,
    staffPerformance: (filter) => staffReportService.performance(filter) as never,
    abnormalDiscounts: (filter) => staffReportService.abnormalDiscounts(filter) as never,
    lastBackupAt
  }
}
let shared: TodaySummary | null = null
let lightDb: ReturnType<typeof createMessengerDb> | null = null
const messengerDb = (): ReturnType<typeof createMessengerDb> => (lightDb ??= createMessengerDb())
export function sharedTodaySummary(): TodaySummary {
  if (shared) return shared
  const deps: SummaryDeps = { ...todaySummaryDeps(), db: messengerDb() }
  shared = createTodaySummary({ deps: () => deps, offsetHours: () => messengerDb().officialOffsetHours() })
  return shared
}

function todayValue(): PhoneReportValue {
  const snap = sharedTodaySummary().current()
  if (!snap) {
    return { at: null, atText: null, rows: [], totals: null, lines: ['خلاصهٔ امروز هنوز آماده نشده است (هر چند دقیقه ساخته می‌شود)؛ کمی بعد دوباره بزنید.'], hasMore: false }
  }
  const s = snap.summary, n = s.numbers
  return {
    at: snap.at, atText: fmtAt(snap.at, snap.offsetHours), rows: [],
    totals: {
      count: n.count, grandTotal: n.grandTotal, cashTotal: n.cashTotal, cardTotal: n.cardTotal, managerAccountTotal: n.managerAccountTotal,
      otherTotal: n.otherTotal, creditTotal: n.creditTotal, returnCount: n.returnCount, exchangeCount: n.exchangeCount
    },
    lines: clipLines([...s.lines, ...(s.sellerSections.length ? ['— به تفکیک فروشنده —', ...s.sellerSections.flat()] : [])]),
    hasMore: false
  }
}

// ------------------------------------------------------------------ قالب ردیف‌ها (فقط فیلدهای ثابت)
/** زمان خواندن، به ساعت رسمی برنامه (همان افست پیام‌رسان). */
async function list(rows: Row[], totals: Row | null, hasMore: boolean, lines: string[] = []): Promise<PhoneReportValue> {
  const at = Date.now()
  let offset = 0
  try { offset = await messengerDb().officialOffsetHours() } catch {}
  return { at, atText: fmtAt(at, Number.isFinite(offset) ? offset : 0), rows, totals, lines: clipLines(lines), hasMore }
}
const pageOf = (value: unknown): { totalCount: number; truncated: boolean } => {
  const page = (value as { page?: { totalCount?: unknown; truncated?: unknown } } | null)?.page
  return { totalCount: intValue(page?.totalCount ?? 0), truncated: page?.truncated === true }
}
const skipOf = (r: PhoneReportRequest, section: PhoneSection): number => r.page * PHONE_REPORTS[section].pageSize

function returnRow(r: any): Row {
  const items = Array.isArray(r?.items) ? r.items.map((i: any) => `${clipText(i?.name, 80)} ×${faDigits(String(intValue(i?.qty)))}`).join('، ') : ''
  return {
    id: intValue(r.id), kind: r.isExchange === true ? 'تعویض' : 'برگشت', receiptNo: r.receiptNo == null ? null : intValue(r.receiptNo),
    returnedAtJalali: clipText(r.returnedAtJalali, 32), time: clipText(r.time, 16), customerName: clipText(r.customerName),
    total: amountText(r.total), refundMethodLabel: clipText(r.refundMethodLabel), refundAmount: amountText(r.refundAmount),
    cashRefundAmount: amountText(r.cashRefundAmount), storeCreditTotal: amountText(r.storeCreditTotal ?? 0), exchangeDiff: amountText(r.exchangeDiff),
    exchangeSettlementLabel: nullableText(r.exchangeSettlementLabel), invoiceUserName: clipText(r.invoiceUserName),
    returnUserName: clipText(r.returnUserName), items: clipText(items)
  }
}
function stockRow(v: any): Row {
  const name = [v?.product?.name, v?.size, v?.color].filter((x) => typeof x === 'string' && x.trim()).join(' · ')
  return { id: intValue(v.id), name: clipText(name), code: clipText(v.code), barcode: clipText(v.barcode), stock: intValue(v.stock), salePrice: amountText(v.salePrice) }
}
function warehouseRow(w: any): Row {
  return { id: intValue(w.id), name: clipText(w.name), code: nullableText(w.code), warehouseName: clipText(w.warehouseName), qty: intValue(w.qty), minQty: intValue(w.minQty), low: w.low === true }
}
function creditRow(c: any): Row {
  return {
    id: intValue(c.id), publicReference: clipText(c.publicReference), statusLabel: clipText(c.statusLabel), issuedAtJalali: clipText(c.issuedAtJalali, 32),
    expiresAtJalali: nullableText(c.expiresAtJalali, 32), customerName: nullableText(c.customerName), sourceLabel: clipText(c.sourceLabel),
    amount: amountText(c.amount), usedAmount: amountText(c.usedAmount), remaining: amountText(c.remaining)
  }
}
function purchaseRow(p: any): Row {
  return {
    id: intValue(p.id), invoiceNo: intValue(p.invoiceNo), issuedAtJalali: clipText(p.issuedAtJalali, 32), supplierName: nullableText(p.supplier?.name),
    status: clipText(p.status, 32), goodsTotal: amountText(p.goodsTotal), discountTotal: amountText(p.discountTotal), grandTotal: amountText(p.grandTotal),
    paidTotal: amountText(p.paidTotal)
  }
}
function cashboxRow(c: any): Row {
  return {
    id: intValue(c.id), dayJalali: clipText(c.dayJalali, 32), shiftName: clipText(c.shiftName), invoiceCount: intValue(c.invoiceCount),
    cashTotal: amountText(c.cashTotal), cardTotal: amountText(c.cardTotal), otherTotal: amountText(c.otherTotal), creditTotal: amountText(c.creditTotal),
    grandTotal: amountText(c.grandTotal), countedTotal: nullableAmountText(c.countedTotal), diff: nullableAmountText(c.diff), closedAtJalali: nullableText(c.closedAtJalali, 32)
  }
}
function shiftRow(s: any): Row {
  return {
    id: intValue(s.id), name: clipText(s.name), number: intValue(s.number), dayJalali: clipText(s.dayJalali, 32), userName: nullableText(s.userName),
    closed: s.closed === true, invoiceCount: intValue(s.invoiceCount), grandTotal: amountText(s.grandTotal), cashTotal: amountText(s.cashTotal),
    cardTotal: amountText(s.cardTotal), creditTotal: amountText(s.creditTotal)
  }
}

/**
 * فهرست ثابت: هر بخش ← دقیقاً یک تابع خواندنی رایانه. افزودن بخش یعنی افزودن به همین فهرست و به
 * `PHONE_REPORTS`؛ آزمون ایستا هر فراخوانی سرویس این پرونده را با فهرست مجاز خواندنی می‌سنجد.
 */
export const PHONE_REPORT_READERS: Readonly<Record<PhoneSection, (r: PhoneReportRequest) => Promise<PhoneReportValue>>> = Object.freeze({
  today: async () => todayValue(),
  returns: async (r) => {
    const skip = skipOf(r, 'returns'), take = PHONE_REPORTS.returns.pageSize
    const rows = await salesService.returnList({ fromJalali: r.fromDay, toJalali: r.toDay, includeExchanges: true, take, skip })
    const page = pageOf(rows)
    return list(rows.map(returnRow), { count: page.totalCount }, page.totalCount > skip + rows.length)
  },
  status: async () => {
    const d = readLockDurations()
    return list(LOCK_DURATION_KEYS.map((key) => ({ title: LOCK_DURATION_TITLES[key], minutes: d[key] })), null, false)
  },
  stock: async (r) => {
    const take = PHONE_REPORTS.stock.pageSize
    const rows = await productService.list({ search: r.search || undefined, take: take + 1, skip: skipOf(r, 'stock') })
    return list(rows.slice(0, take).map(stockRow), null, rows.length > take)
  },
  warehouse: async (r) => {
    const take = PHONE_REPORTS.warehouse.pageSize
    const rows = await secondaryStockService.list({ search: r.search || undefined, take: take + 1 })
    return list(rows.slice(0, take).map(warehouseRow), null, false, rows.length > take ? ['ردیف‌های بیشتری هست؛ با نام یا کد جستجو کنید.'] : [])
  },
  management: async (r) => {
    const snap = await trendService.snapshot({ fromJalali: r.fromDay, toJalali: r.toDay })
    const a = snap.accounting
    const totals: Row | null = a ? {
      invoiceCount: intValue(a.invoice.invoiceCount), grossSales: amountText(a.invoice.grossSales), discounts: amountText(a.invoice.discounts),
      taxes: amountText(a.invoice.taxes), serviceCharges: amountText(a.invoice.serviceCharges), deliveryFees: amountText(a.invoice.deliveryFees),
      simpleReturns: amountText(a.invoice.simpleReturns), exchangeReturned: amountText(a.invoice.exchangeReturned),
      netAccrualSales: amountText(a.invoice.netAccrualSales), cashReceived: amountText(a.cash.cashReceived), cardReceived: amountText(a.cash.cardReceived),
      otherReceived: amountText(a.cash.otherReceived), managerAccountReceived: amountText(a.cash.managerAccountReceived), creditRemaining: amountText(a.credit.remaining)
    } : null
    return list([], totals, false, [...(snap.warnings ?? []), ...(a?.notes ?? [])].map(String))
  },
  credits: async (r) => {
    const skip = skipOf(r, 'credits'), take = PHONE_REPORTS.credits.pageSize
    const rows = await storeCreditService.list({ fromJalali: r.fromDay, toJalali: r.toDay, take, skip })
    const page = pageOf(rows)
    return list(rows.map(creditRow), { count: page.totalCount }, page.totalCount > skip + rows.length)
  },
  purchases: async (r) => {
    const skip = skipOf(r, 'purchases'), take = PHONE_REPORTS.purchases.pageSize
    const rows = await purchaseService.list({ from: jalaliStartOfDay(r.fromDay!).toISOString(), to: jalaliEndOfDay(r.toDay!).toISOString(), take, skip })
    const t = rows.totals
    return list(rows.map(purchaseRow), { count: intValue(t.count), goodsTotal: amountText(t.goodsTotal), discountTotal: amountText(t.discountTotal), grandTotal: amountText(t.grandTotal), paidTotal: amountText(t.paidTotal) },
      intValue(t.count) > skip + rows.length)
  },
  cashbox: async (r) => {
    const skip = skipOf(r, 'cashbox'), take = PHONE_REPORTS.cashbox.pageSize
    const rows = await cashboxService.sessions({ fromJalali: r.fromDay, toJalali: r.toDay, take, skip })
    const page = pageOf(rows)
    return list(rows.map(cashboxRow), { count: page.totalCount }, page.totalCount > skip + rows.length)
  },
  shiftlog: async (r) => {
    const take = PHONE_REPORTS.shiftlog.pageSize
    const rows = await shiftService.list({ fromJalali: r.fromDay, toJalali: r.toDay, take })
    const page = pageOf(rows)
    return list(rows.slice(0, take).map(shiftRow), { count: page.totalCount }, false, page.truncated ? ['فقط ۲۰۰ ردیف اول؛ بازه را کوچک‌تر کنید.'] : [])
  }
})

// ------------------------------------------------------------------ ردیف «دیدن گزارش از گوشی» (۱ در ۱۰ دقیقه)
const VIEW_GAP_MS = 10 * 60_000
const views = new Map<string, number>()
function noteView(member: string, section: PhoneSection): void {
  const t = Date.now(), key = `${member}\n${section}`, last = views.get(key)
  if (last !== undefined && t >= last && t - last < VIEW_GAP_MS) return
  if (views.size >= 512) for (const [k, at] of views) if (t < at || t - at >= VIEW_GAP_MS) views.delete(k)
  if (views.size >= 512) views.clear()
  views.set(key, t)
  noteAccessEvent('PHONE_REPORT_VIEW', { titleFa: `گزارش گوشی: ${PHONE_REPORTS[section].title}`, recipientName: member })
}

/** یک بخش برای عضو گوشی: ورودی سنجیده، تابع ثابت، خروجی کپی‌شده از فیلدهای ثابت. */
export async function readPhoneReportSection(section: string, request: Record<string, unknown>, member: string): Promise<PhoneReportValue> {
  if (!isPhoneSection(section) || typeof member !== 'string' || !member || member.length > 64) throw new Error('Invalid report request')
  const parsed = parsePhoneReportRequest({ ...request, section })
  const value = parsePhoneReport(section, await PHONE_REPORT_READERS[section](parsed))
  noteView(member, section)
  return value
}

let registered = false
/** از `registerIpcHandlers`: خوانندهٔ گزارش‌ها برای میزبان هاب (بی زمان‌سنج تا هاب روشن شود). */
export function registerPhoneReports(): void {
  if (registered) return
  registered = true
  setPhoneReportSource({
    read: (section, request, member) => readPhoneReportSection(section, request, member),
    start: () => sharedTodaySummary().start(),
    stop: () => sharedTodaySummary().stop()
  })
}
