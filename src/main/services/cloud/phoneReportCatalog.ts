/**
 * طرح ۱۴۰۵ · مرحلهٔ ۷ (مورد ۶؛ معماری §۴-۷، طرح §۲۴-۳ بند ۶ و §۲۶-۲) — فهرست ثابت بخش‌های «دیدن با گوشی».
 *
 * Pure: no I/O and no database. One list shared by the desktop adapters (`phoneReports.ts`), the hub
 * supervisor, the hub child, the phone HTTP handler and the phone page labels.
 *
 *  - Every section has a fixed DTO: exact keys, typed values and bounded sizes. Anything that crosses a
 *    process boundary is copied through `parsePhoneReport` (no extra private field can pass).
 *  - Amounts are exact integer strings (`amount`); the phone formats them like the desktop `money()`.
 *  - Pages are at most 200 rows and date ranges at most 31 days (`parsePhoneReportRequest`).
 *  - Each section has its own VIEW ACL panel (`view.<section>`) for the «مدیر» and «فقط مشاهده» roles.
 *  - A store-credit code or barcode is never a field of any section.
 */
import { fromJalaliDate } from '../../../shared/jalali'
import { isInvoiceDate } from './invoiceFactsValidation'

export type PhoneFieldType = 'amount' | 'amount?' | 'int' | 'int?' | 'text' | 'text?' | 'bool'
/** [key, Persian label, type] */
export type PhoneField = readonly [string, string, PhoneFieldType]
export type PhoneReportInput = 'none' | 'range' | 'search'
export interface PhoneReportSpec {
  title: string
  phase: 1 | 2 | 3
  input: PhoneReportInput
  /** rows per page (0 = no rows) */
  pageSize: number
  /** more pages with «صفحه بعد»; false = one bounded page only */
  paged: boolean
  caption: string
  row: readonly PhoneField[]
  totals: readonly PhoneField[]
}

export const PHONE_REPORT_PANEL_PREFIX = 'view.'
export const PHONE_REPORT_MAX_DAYS = 31
export const PHONE_REPORT_MAX_PAGE = 1000
const TEXT_MAX = 256
const LINE_MAX = 512
const LINES_MAX = 120

const RANGE_NOTE = 'بازه حداکثر ۳۱ روز.'
export const PHONE_REPORTS = Object.freeze({
  today: {
    title: 'خلاصهٔ فروش امروز', phase: 1, input: 'none', pageSize: 0, paged: false,
    caption: 'از پیش ساخته، هر چند دقیقه یک بار؛ همان خلاصهٔ پیام ساعت ۲۴ و ربات. عددها از گزارش فروش خود برنامه است.',
    row: [],
    totals: [['count', 'تعداد فاکتور', 'int'], ['grandTotal', 'جمع فروش', 'amount'], ['cashTotal', 'نقد', 'amount'],
      ['cardTotal', 'کارتخوان', 'amount'], ['managerAccountTotal', 'حساب مدیر', 'amount'], ['otherTotal', 'سایر (چک و…)', 'amount'],
      ['creditTotal', 'نسیه', 'amount'], ['returnCount', 'برگشت', 'int'], ['exchangeCount', 'تعویض', 'int']]
  },
  returns: {
    title: 'برگشت‌ها و تعویض‌ها', phase: 1, input: 'range', pageSize: 50, paged: true,
    caption: `همان فهرست تب «برگشت از فروش» برنامه، با تعویض‌ها. کد و بارکد سند و اعتبار نشان داده نمی‌شود. ${RANGE_NOTE}`,
    row: [['id', 'سند', 'int'], ['kind', 'نوع', 'text'], ['receiptNo', 'فیش فاکتور اصلی', 'int?'], ['returnedAtJalali', 'تاریخ', 'text'],
      ['time', 'ساعت', 'text'], ['customerName', 'مشتری', 'text'], ['total', 'مبلغ برگشت', 'amount'], ['refundMethodLabel', 'تسویه', 'text'],
      ['refundAmount', 'بازپرداخت', 'amount'], ['cashRefundAmount', 'نقد از صندوق', 'amount'], ['storeCreditTotal', 'اعتبار خرید', 'amount'],
      ['exchangeDiff', 'مابه‌التفاوت تعویض', 'amount'], ['exchangeSettlementLabel', 'تسویهٔ تعویض', 'text?'],
      ['invoiceUserName', 'فروشندهٔ فاکتور', 'text'], ['returnUserName', 'ثبت‌کننده', 'text'], ['items', 'کالاها', 'text']],
    totals: [['count', 'تعداد در بازه', 'int']]
  },
  status: {
    title: 'وضعیت سیستم', phase: 1, input: 'none', pageSize: 3, paged: false,
    caption: 'سه مدت تنظیم‌شده روی رایانه (تنظیمات ← رمز مدیر و خروج).',
    row: [['title', 'مدت', 'text'], ['minutes', 'دقیقه', 'int']],
    totals: []
  },
  stock: {
    title: 'موجودی فروشگاه', phase: 2, input: 'search', pageSize: 100, paged: true,
    caption: 'همان فهرست کالاهای فعال برنامه (بی قیمت خرید). با نام، کد یا بارکد جستجو کنید.',
    row: [['id', 'شناسه', 'int'], ['name', 'کالا', 'text'], ['code', 'کد', 'text'], ['barcode', 'بارکد', 'text'],
      ['stock', 'موجودی', 'int'], ['salePrice', 'قیمت فروش', 'amount']],
    totals: []
  },
  warehouse: {
    title: 'انبار مرکزی', phase: 2, input: 'search', pageSize: 200, paged: false,
    caption: 'همان فهرست انبار مرکزی برنامه (جدا از موجودی فروشگاه). حداکثر ۲۰۰ ردیف؛ برای بقیه با نام یا کد جستجو کنید.',
    row: [['id', 'شناسه', 'int'], ['name', 'نام', 'text'], ['code', 'کد', 'text?'], ['warehouseName', 'انبار', 'text'],
      ['qty', 'تعداد', 'int'], ['minQty', 'حد هشدار', 'int'], ['low', 'کمتر از حد هشدار', 'bool']],
    totals: []
  },
  management: {
    title: 'گزارش مدیریت', phase: 3, input: 'range', pageSize: 0, paged: false,
    caption: `همان عددهای «گزارش مدیریت» برنامه برای بازه (بی سود). ${RANGE_NOTE}`,
    row: [],
    totals: [['invoiceCount', 'تعداد فاکتور', 'int'], ['grossSales', 'فروش ناخالص', 'amount'], ['discounts', 'تخفیف', 'amount'],
      ['taxes', 'مالیات', 'amount'], ['serviceCharges', 'خدمات', 'amount'], ['deliveryFees', 'هزینهٔ ارسال', 'amount'],
      ['simpleReturns', 'برگشت ساده', 'amount'], ['exchangeReturned', 'برگشت در تعویض', 'amount'], ['netAccrualSales', 'فروش خالص', 'amount'],
      ['cashReceived', 'دریافت نقد', 'amount'], ['cardReceived', 'دریافت کارتخوان', 'amount'], ['otherReceived', 'دریافت سایر', 'amount'],
      ['managerAccountReceived', 'دریافت حساب مدیر', 'amount'], ['creditRemaining', 'نسیهٔ مانده', 'amount']]
  },
  credits: {
    title: 'اعتبار خرید', phase: 3, input: 'range', pageSize: 50, paged: true,
    caption: `اعتبارهای صادرشده در بازه، از همان فهرست امن برنامه. کد و بارکد اعتبار هرگز نشان داده نمی‌شود. ${RANGE_NOTE}`,
    row: [['id', 'شناسه', 'int'], ['publicReference', 'مرجع', 'text'], ['statusLabel', 'وضعیت', 'text'], ['issuedAtJalali', 'صدور', 'text'],
      ['expiresAtJalali', 'انقضا', 'text?'], ['customerName', 'مشتری', 'text?'], ['sourceLabel', 'منشأ', 'text'],
      ['amount', 'مبلغ', 'amount'], ['usedAmount', 'مصرف‌شده', 'amount'], ['remaining', 'مانده', 'amount']],
    totals: [['count', 'تعداد در بازه', 'int']]
  },
  purchases: {
    title: 'فاکتورهای خرید', phase: 3, input: 'range', pageSize: 50, paged: true,
    caption: `همان فهرست فاکتورهای خرید برنامه؛ جمع‌ها روی کل بازه‌اند. ${RANGE_NOTE}`,
    row: [['id', 'شناسه', 'int'], ['invoiceNo', 'شمارهٔ فاکتور', 'int'], ['issuedAtJalali', 'تاریخ', 'text'], ['supplierName', 'تأمین‌کننده', 'text?'],
      ['status', 'وضعیت', 'text'], ['goodsTotal', 'جمع کالا', 'amount'], ['discountTotal', 'تخفیف', 'amount'], ['grandTotal', 'جمع کل', 'amount'],
      ['paidTotal', 'پرداخت‌شده', 'amount']],
    totals: [['count', 'تعداد', 'int'], ['goodsTotal', 'جمع کالا', 'amount'], ['discountTotal', 'تخفیف', 'amount'],
      ['grandTotal', 'جمع کل', 'amount'], ['paidTotal', 'پرداخت‌شده', 'amount']]
  },
  cashbox: {
    title: 'بستن‌های صندوق', phase: 3, input: 'range', pageSize: 50, paged: true,
    caption: `همان سابقهٔ بستن صندوق برنامه. ${RANGE_NOTE}`,
    row: [['id', 'شناسه', 'int'], ['dayJalali', 'روز', 'text'], ['shiftName', 'شیفت', 'text'], ['invoiceCount', 'فاکتور', 'int'],
      ['cashTotal', 'نقد', 'amount'], ['cardTotal', 'کارتخوان', 'amount'], ['otherTotal', 'سایر', 'amount'], ['creditTotal', 'نسیه', 'amount'],
      ['grandTotal', 'جمع', 'amount'], ['countedTotal', 'شمرده‌شده', 'amount?'], ['diff', 'اختلاف نقد', 'amount?'], ['closedAtJalali', 'تاریخ بستن', 'text?']],
    totals: [['count', 'تعداد در بازه', 'int']]
  },
  shiftlog: {
    title: 'شیفت‌ها', phase: 3, input: 'range', pageSize: 200, paged: false,
    caption: `همان فهرست نشست‌های برنامه برای بازه؛ حداکثر ۲۰۰ ردیف. ${RANGE_NOTE}`,
    row: [['id', 'شناسه', 'int'], ['name', 'شیفت', 'text'], ['number', 'شماره', 'int'], ['dayJalali', 'روز', 'text'], ['userName', 'کارمند', 'text?'],
      ['closed', 'بسته شده', 'bool'], ['invoiceCount', 'فاکتور', 'int'], ['grandTotal', 'جمع', 'amount'], ['cashTotal', 'نقد', 'amount'],
      ['cardTotal', 'کارتخوان', 'amount'], ['creditTotal', 'نسیه', 'amount']],
    totals: [['count', 'تعداد در بازه', 'int']]
  }
} satisfies Record<string, PhoneReportSpec>)

export type PhoneSection = keyof typeof PHONE_REPORTS
export const PHONE_REPORT_SECTIONS: readonly PhoneSection[] = Object.freeze(Object.keys(PHONE_REPORTS) as PhoneSection[])
export const PHONE_REPORT_PANELS: readonly string[] = Object.freeze(PHONE_REPORT_SECTIONS.map(s => PHONE_REPORT_PANEL_PREFIX + s))

export function isPhoneSection(value: unknown): value is PhoneSection {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PHONE_REPORTS, value)
}
export function phoneReportPanel(section: PhoneSection): string {
  return PHONE_REPORT_PANEL_PREFIX + section
}
export function phoneReportSpec(section: PhoneSection): PhoneReportSpec {
  return PHONE_REPORTS[section] as PhoneReportSpec
}

/** Number of days from `from` to `to` (0 = the same day). */
export function jalaliSpanDays(from: string, to: string): number {
  return Math.round((fromJalaliDate(to).getTime() - fromJalaliDate(from).getTime()) / 86_400_000)
}

export interface PhoneReportRequest { section: PhoneSection; page: number; fromDay?: string; toDay?: string; search?: string }

/** Exact request keys per section: range ⇒ from/to (≤31 days); search ⇒ search (≤64 chars); always a page index. */
export function parsePhoneReportRequest(value: unknown): PhoneReportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report request')
  const v = value as Record<string, unknown>
  if (!isPhoneSection(v.section)) throw new Error('Invalid report request')
  const spec = phoneReportSpec(v.section)
  const page = v.page
  if (!Number.isSafeInteger(page) || (page as number) < 0 || (page as number) > PHONE_REPORT_MAX_PAGE || (!spec.paged && page !== 0)) throw new Error('Invalid report request')
  const keys = Object.keys(v).sort().join(',')
  if (spec.input === 'range') {
    if (keys !== 'fromDay,page,section,toDay' || !isInvoiceDate(v.fromDay) || !isInvoiceDate(v.toDay) || v.fromDay > v.toDay) throw new Error('Invalid report request')
    const span = jalaliSpanDays(v.fromDay, v.toDay)
    if (!Number.isSafeInteger(span) || span < 0 || span > PHONE_REPORT_MAX_DAYS - 1) throw new Error('Invalid report range')
    return { section: v.section, page: page as number, fromDay: v.fromDay, toDay: v.toDay }
  }
  if (spec.input === 'search') {
    if (keys !== 'page,search,section' || typeof v.search !== 'string' || v.search.length > 64 || /[\u0000-\u001f\u007f]/.test(v.search)) throw new Error('Invalid report request')
    return { section: v.section, page: page as number, search: v.search.trim() }
  }
  if (keys !== 'page,section') throw new Error('Invalid report request')
  return { section: v.section, page: page as number }
}

export type PhoneValue = string | number | boolean | null
export interface PhoneReportValue {
  /** when the data was read or (today) computed; ms since epoch, null = not ready yet */
  at: number | null
  /** the same moment as text in the desktop's official time («۱۴۰۵/۰۸/۳۰ ساعت ۱۶:۰۴») */
  atText: string | null
  rows: Record<string, PhoneValue>[]
  totals: Record<string, PhoneValue> | null
  lines: string[]
  hasMore: boolean
}

const AMOUNT = /^-?(0|[1-9][0-9]{0,29})$/
function fieldValue(type: PhoneFieldType, value: unknown): PhoneValue {
  const nullable = type.endsWith('?')
  if (nullable && value === null) return null
  switch (type.replace('?', '')) {
    case 'amount':
      if (typeof value !== 'string' || !AMOUNT.test(value)) throw new Error('Invalid report amount')
      return value
    case 'int':
      if (!Number.isSafeInteger(value)) throw new Error('Invalid report number')
      return value as number
    case 'text':
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > TEXT_MAX) throw new Error('Invalid report text')
      return value
    case 'bool':
      if (typeof value !== 'boolean') throw new Error('Invalid report flag')
      return value
    default:
      throw new Error('Invalid report field')
  }
}
function record(fields: readonly PhoneField[], value: unknown): Record<string, PhoneValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report record')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== fields.map(f => f[0]).sort().join(',')) throw new Error('Invalid report record')
  const out: Record<string, PhoneValue> = {}
  for (const [key, , type] of fields) out[key] = fieldValue(type, v[key])
  return out
}

/** Copy only the section's fixed fields (exact keys, typed and bounded); anything else fails. */
export function parsePhoneReport(section: PhoneSection, value: unknown): PhoneReportValue {
  const spec = phoneReportSpec(section)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'at,atText,hasMore,lines,rows,totals') throw new Error('Invalid report')
  if (v.at !== null && (!Number.isSafeInteger(v.at) || (v.at as number) < 0)) throw new Error('Invalid report time')
  if (v.atText !== null && (typeof v.atText !== 'string' || Buffer.byteLength(v.atText, 'utf8') > 64)) throw new Error('Invalid report time')
  if (typeof v.hasMore !== 'boolean' || (!spec.paged && v.hasMore)) throw new Error('Invalid report page')
  if (!Array.isArray(v.rows) || v.rows.length > spec.pageSize || (spec.row.length === 0 && v.rows.length)) throw new Error('Invalid report rows')
  if (!Array.isArray(v.lines) || v.lines.length > LINES_MAX || v.lines.some(l => typeof l !== 'string' || Buffer.byteLength(l, 'utf8') > LINE_MAX)) throw new Error('Invalid report lines')
  let totals: Record<string, PhoneValue> | null = null
  if (v.totals !== null) {
    if (!spec.totals.length) throw new Error('Invalid report totals')
    totals = record(spec.totals, v.totals)
  }
  return {
    at: v.at as number | null, atText: v.atText as string | null,
    rows: v.rows.map(r => record(spec.row, r)), totals, lines: [...(v.lines as string[])], hasMore: v.hasMore
  }
}

/** Exact integer text of a desktop amount (bigint as is; a number rounded like the desktop `money()`). */
export function amountText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && AMOUNT.test(value)) return value
  if (value === null || value === undefined) return '0'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid amount')
  const r = Math.round(n)
  return Object.is(r, -0) ? '0' : String(r)
}
export function nullableAmountText(value: unknown): string | null {
  return value === null || value === undefined ? null : amountText(value)
}
/** Text cut to the byte limit of a report field (whole characters only). */
export function clipText(value: unknown, max = TEXT_MAX): string {
  let s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  while (Buffer.byteLength(s, 'utf8') > max) s = [...s].slice(0, -1).join('')
  return s
}
export function nullableText(value: unknown, max = TEXT_MAX): string | null {
  return value === null || value === undefined || value === '' ? null : clipText(value, max)
}
export function intValue(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const r = Math.round(n)
  return Number.isSafeInteger(r) ? (Object.is(r, -0) ? 0 : r) : 0
}
export function clipLines(lines: readonly string[]): string[] {
  const out = lines.slice(0, LINES_MAX).map(l => clipText(l, LINE_MAX))
  if (lines.length > LINES_MAX) out[LINES_MAX - 1] = '… (ادامه در برنامهٔ رایانه)'
  return out
}
