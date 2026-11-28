/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — از ردیف ثبت‌شده به پیام (طرح §۲۱، §۲۵-۴، §۲۶-۲؛ معماری §۴-۱).
 *
 * قاعده‌های سخت این پرونده:
 *  - **فقط فیلدهای فهرست ثابت `EVENT_FIELDS`** از ستون `after` خوانده می‌شوند (تابع `pick`)، نه JSON خام.
 *    هرگز: کد یا بارکد اعتبار، کد برگشت فاکتور، تلفن، رمز، PIN، کلید.
 *  - **متن آزاد `note` هرگز عیناً در پیام نمی‌آید** (ممکن است نام یا تلفن داشته باشد)؛ فقط خط ثابت
 *    «روش تأیید» (معماری §۳-۹، `gateCatalog.ts`) از آن خوانده می‌شود.
 *  - عددها عیناً همان عددهای ثبت‌شده‌اند؛ پیام چیزی حساب نمی‌کند. عدد ثبت‌نشده «ثبت نشده» است، نه صفر.
 *  - «تحویل شیفت» = هر بستن صندوق؛ برای هر `cashSessionId` یک پیام (رویدادهای حضانتِ دارای
 *    `cashSessionId` پیام جدا نمی‌گیرند؛ طرح §۲۶-۲ افزودهٔ ۲۴).
 */
import { CASH_MOVEMENT_LABELS, CHEQUE_STATUS_LABELS, EXCHANGE_SETTLEMENT_LABELS, PAYMENT_DESTINATION_LABELS, REFUND_METHOD_LABELS } from '@shared/enums'
import { CREDIT_SOURCE_LABELS } from '@shared/credit'
import { faDigits } from '@shared/jalali'
import { LOCK_KIND_SIGNS, LOCK_KIND_TITLES, type LockKind } from '@shared/panels'
import { ACCESS_EVENT_KINDS, GATE_METHOD_LABELS, GATE_METHOD_NOTE_PREFIX, type GateMethodKey } from '@shared/gateCatalog'
import { CHARGE_KINDS, CHARGE_SCOPES, chargeTitle } from '@shared/charges'
import { invoiceDiscountPercent } from '@shared/accounting'
import { fmtAt, fmtClock, fmtDuration, itemLine, num, officialDay, rial, rialOrMissing, sectionTitle } from './messengerFormat'
import type { MessengerEvent } from './messengerTypes'

/** فهرست ثابت فیلدهای مجاز برای هر نوع ردیف AuditLog. هر نوعی که اینجا نیست، پیامی نمی‌سازد. */
export const EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SALE_CREATE: ['receiptNo', 'grandTotal', 'paidTotal', 'discountTotal', 'lines', 'customerId', 'shiftId'],
  WHOLESALE_SALE_CREATE: ['receiptNo', 'grandTotal', 'paidTotal', 'discountTotal', 'lines', 'customerId', 'shiftId'],
  SALE_UPDATE: ['receiptNo', 'grandTotal', 'paidTotal'],
  SALE_RETURN: ['receiptNo', 'total', 'fullyReturned'],
  RETURN_REFUND: ['receiptNo', 'returnTotal', 'refundMethod', 'refundAmount'],
  SALE_EXCHANGE: ['sourceReceiptNo', 'exchangeReceiptNo', 'returnTotal', 'exchangeTotal', 'diff', 'settlement'],
  STORE_CREDIT_ISSUE: ['publicReference', 'amount', 'source', 'expiresAtJalali', 'maxUses'],
  CREDIT_ISSUE_MANUAL: ['publicReference', 'amount', 'source', 'expiresAtJalali', 'maxUses'],
  CREDIT_BULK_GENERATE: ['created', 'amountEach', 'totalAmount', 'expiresAtJalali'],
  STORE_CREDIT_REDEEM: ['applied', 'receiptNo', 'remainderAfter', 'paymentId'],
  STORE_CREDIT_OVER_LIMIT: ['amount', 'limit'],
  SALE_PAYMENT_ADD: ['receiptNo', 'amount', 'kind', 'destination', 'dueDateJalali', 'remaining'],
  SALE_PAYMENT_UPDATE: ['paidTotal', 'remaining'],
  SALE_PAYMENT_DELETE: [],
  CHEQUE_STATUS: ['chequeStatus', 'amount', 'destination', 'remaining'],
  CASH_MOVEMENT: ['amount', 'type', 'refType'],
  CASH_CLOSE: ['shiftId', 'count', 'grandTotal', 'cashTotal', 'cardTotal', 'managerAccountTotal', 'creditTotal', 'openingFloat',
    'expectedCash', 'countedCash', 'cashDifference', 'state', 'withdrawals', 'deposits'],
  SHIFT_OPEN: ['name', 'number', 'session'],
  SHIFT_CLOSE: ['name', 'number', 'session'],
  SHIFT_OVERTIME: ['name', 'number', 'session'],
  VOID: [],
  DELETE: [],
  DATA_ARCHIVE_PURGE: [],
  SALE_PRICE_OVERRIDE: [],
  EXCHANGE_PRICE_OVERRIDE: [],
  /** دفتر آزمون ۴-۳۶: عوارض و حق سرویس دستی پنل فروش عمده (فقط دو عدد واردشده) */
  SALE_CHARGE_OVERRIDE: ['tax', 'service'],
  CLOSED_PERIOD_OVERRIDE: ['what', 'dayJalali'],
  PRICE_EDIT: [],
  PRICE_BULK_ADJUST: ['itemCount'],
  PRICE_BULK_REVERT: ['itemCount'],
  /** مرحلهٔ ۶: قفل شدن کدهای یک‌بارمصرف (`kind: ONE_TIME_CODES`) */
  AUTH_LOCKOUT: ['kind', 'minutes', 'windowNo'],
  PANEL_LOCKS_UPDATE: [],
  SETTINGS_UPDATE: [],
  CREDIT_VOID: [],
  CREDIT_DELETE: [],
  /** مرحلهٔ ۴ (مورد ۱۲): فقط برچسب‌های ثابت ردیف‌های فروشنده؛ توضیح آزاد هرگز خوانده نمی‌شود. */
  CREDIT_REPRINT: ['path', 'reasonCode'],
  CREDIT_AMOUNT_CHANGE: [],
  CREDIT_SUSPEND: [],
  CREDIT_REACTIVATE: [],
  CREDIT_EXPIRY_CHANGE: [],
  CARD_TRANSFER_REQUEST: ['receiptNo', 'amount'],
  CARD_TRANSFER_PAID: ['paidAmount', 'sourceReceiptNo'],
  ACCESS_EVENT: ['kind', 'titleFa', 'number', 'windowNo', 'count', 'minutes', 'recipientName', 'decision']
})

/** نام‌هایی که هرگز نباید در فهرست بالا بیایند (آزمون همین را می‌سنجد). */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = Object.freeze([
  'code', 'barcode', 'legacyCode', 'returnCode', 'phone', 'holderPhone', 'mobile', 'pin', 'password', 'managerPassword',
  'token', 'secret', 'idempotencyKey', 'chequeNo', 'reference', 'trackingNo', 'note', 'reason', 'voidReason',
  'overrideReason', 'noRefundReason', 'holderNationalId', 'holderAddress'
])

export interface AuditRowLite { id: number; at: Date | string | number; userId: number | null; action: string; entity: string; entityId: number | null; after: string | null; note: string | null }
export interface CustodyEventLite { id: number; type: string; shiftId: number | null; handoverId: number | null; actorUserId: number | null; managerUserId: number | null; payloadJson: string | null; at: Date | string | number }
export interface CustodyCountLite { id: number; kind: string; shiftId: number | null; handoverId: number | null; countedByUserId: number | null; countedCash: unknown; expectedCash: unknown; differenceCash: unknown; at: Date | string | number }

export interface LookupData {
  users: Map<number, string>
  /** دفتر آزمون ۴-۱۹: `userId` همان مسئول صندوقِ نشست (کاربر نشست) است. */
  shifts: Map<number, { name: string; number: number; userId?: number | null }>
  invoices: Map<number, { receiptNo: number; customerId: number | null }>
  customers: Map<number, string>
  payments: Map<number, { invoiceId: number; amount: number }>
  credits: Map<number, { userId: number | null; issuedAt: number }>
  /** کلید `${creditId}:${paymentId}` */
  redemptions: Map<string, { userId: number | null; at: number }>
  reprinted: Set<number>
  /** مرحلهٔ ۴ (مورد ۱۲): ردیف کاغذِ `markPrinted` که چاپ دوبارهٔ فروشنده است ⇒ کد دلیل («INCOMPLETE»/«OTHER») */
  sellerPapers: Map<number, string>
  handovers: Map<number, { fromUserId: number | null; receiverUserId: number | null; expectedAtStart: unknown; countedAtStart: unknown; differenceCash: unknown; fromShiftId?: number | null }>
  /** مرز تجمیعی حضانت (کشو + کارت‌خوان) که رویداد بستن نهایی به آن اشاره می‌کند؛ عددها همان ثبت‌شده‌اند. */
  boundaries: Map<number, AggregateBoundaryLite>
  /** دفتر آزمون ۴-۲۷: پایان برنامهٔ ذخیره‌شدهٔ هر بخش حضانت (`CustodyShiftMeta.scheduledEndAt`، ms)؛ کلید = شناسهٔ نشست. */
  segments: Map<number, { scheduledEndAt: number | null }>
  /** دفتر آزمون ۴-۹: بدنهٔ فاکتور فروش (کلید = شناسهٔ فاکتور)؛ فقط برای ردیف‌های «ثبت فروش» همان صفحه. */
  saleDocs: Map<number, SaleDocLite>
  /** دفتر آزمون ۴-۹: قلم‌های برگشت و تعویض (کلید = شناسهٔ سند برگشت). */
  returnDocs: Map<number, ReturnDocLite>
  /** دفتر آزمون ۴-۳۶: «آستانهٔ تخفیف غیرعادی» سیاست حسابداری (درصد؛ ۰ = خاموش)؛ فقط وقتی صفحه فروش دارد خوانده می‌شود. */
  abnormalDiscountPercent: number
}
/**
 * دفتر آزمون ۴-۹ — یک قلم سند، همان‌طور که هنگام ثبت در خود سند نوشته شد: نام روز فروش (`variantName`)، تعداد،
 * قیمت هر عدد، تخفیف همان ردیف و جمع ردیف. کد کالا و بارکد هرگز خوانده نمی‌شوند.
 */
export interface DocLineLite { name: string; qty: number; unitPrice: number; discount: number; lineTotal: number }
/** دفتر آزمون ۴-۹ — بدنهٔ فاکتور فروش؛ عددها همان ستون‌های ذخیره‌شدهٔ خود فاکتورند. */
export interface SaleDocLite {
  goodsTotal: number; discountTotal: number; taxTotal: number; serviceCharge: number; deliveryFee: number; grandTotal: number
  lines: DocLineLite[]
  /** پرداخت‌های همان لحظهٔ ثبت، به ترتیب ثبت: نام روش، یا «حساب مدیر»، «اعتبار خرید» (بی کد) و «چک» (با سررسید). */
  payments: Array<{ label: string; amount: number }>
}
/** دفتر آزمون ۴-۹ — قلم‌های یک سند برگشت؛ تعویض با قلم‌های سند جایگزین و زنجیره. */
export interface ReturnDocLite {
  lines: DocLineLite[]
  /** تعویض: قلم‌های سند جایگزین؛ برگشت ساده: null */
  replacement: DocLineLite[] | null
  /** تعویض: شماره‌های زنجیره، از نخستین فاکتور تا سند همین تعویض */
  chain: number[]
}
/** فقط ستون‌های عددی و نوع مرز؛ هیچ متن آزاد. */
export interface AggregateBoundaryLite {
  observedOperationalTotal: unknown
  operationalExpectedTotal: unknown
  theoreticalExpectedTotal: unknown
  newDifference: unknown
  totalTheoreticalDifference: unknown
  baselineSource: string | null
}
export const emptyLookups = (): LookupData => ({
  users: new Map(), shifts: new Map(), invoices: new Map(), customers: new Map(), payments: new Map(),
  credits: new Map(), redemptions: new Map(), reprinted: new Set(), sellerPapers: new Map(), handovers: new Map(), boundaries: new Map(),
  segments: new Map(), saleDocs: new Map(), returnDocs: new Map(), abnormalDiscountPercent: 0
})

/**
 * دفتر آزمون ۴-۲۷ — فاصلهٔ تحویل یا بستن با پایان برنامهٔ شیفت (فقط برای پیگیری مدیر؛ مغایرت نیست و به پول
 * دست نمی‌زند): در ۱۵ دقیقهٔ آخر تا پایان «به‌موقع»، پس از پایان «… دقیقه دیرتر»، پیش از آن «… دقیقه زودتر».
 * بخشی که برنامه ندارد (`scheduledEndAt` تهی) خطی ندارد.
 */
const ON_TIME_WINDOW_MS = 15 * 60_000
/** دقیقه‌های کاملِ پس از پایان شیفت (۰ یعنی دیر نیست). */
export function minutesAfterShiftEnd(at: number, scheduledEndAt: number | null | undefined): number {
  if (!scheduledEndAt || !Number.isFinite(scheduledEndAt) || !Number.isFinite(at)) return 0
  return Math.max(0, Math.floor((at - scheduledEndAt) / 60_000))
}
export function shiftEndGap(at: number, scheduledEndAt: number | null | undefined): string {
  if (!scheduledEndAt || !Number.isFinite(scheduledEndAt) || !Number.isFinite(at)) return ''
  const late = minutesAfterShiftEnd(at, scheduledEndAt)
  if (late >= 1) return `${num(late)} دقیقه دیرتر از پایان شیفت`
  if (scheduledEndAt - at <= ON_TIME_WINDOW_MS) return 'به‌موقع'
  return `${num(Math.floor((scheduledEndAt - at) / 60_000))} دقیقه زودتر از پایان شیفت`
}

/**
 * ==================== دفتر آزمون ۴-۲۶ — یادآوری پایان شیفت به مدیر ====================
 * فقط در چندشیفت، فقط آگاهی (هیچ چیزی قفل نمی‌شود و به پول دست نمی‌زند)، هر کدام برای هر بخش صندوق یک بار:
 *  - «⏰ تحویل شیفت انجام نشده»: ۱۵ دقیقه پس از پایان شیفتی که بعدش شیفت دیگری هست، اگر صندوق هنوز دست همان بخش است؛
 *  - «🌙 صندوق شیفت آخر هنوز باز است»: ۳۰ دقیقه پس از پایان شیفت آخر روز، اگر صندوق هنوز باز است.
 * هر دو عدد ثابت‌اند (۴-۸۵). اگر آن لحظه برنامه خاموش بود، با روشن شدن فقط وقتی می‌رود که هنوز صادق باشد، چون همیشه از
 * وضعیت همان لحظهٔ صندوق ساخته می‌شود. نشانهٔ یک‌بار در `messenger-cursor.json` است (موتور). مبلغ، کد یا تلفن ندارد.
 */
export const SHIFT_HANDOVER_REMINDER_MIN = 15
export const LAST_SHIFT_REMINDER_MIN = 30
/** یک شیفت تعریف‌شده (قالب تنظیمات شیفت، یا برنامهٔ قدیمی): شروع از نیمه‌شب محلی، طول، و روزهای هفته (بیت `1 << getDay()`) */
export interface ShiftPlanLite { startMinute: number; durationMinutes: number; daysMask: number }
/** بخش باز صندوق (`CustodyState` اصلی و `CustodyShiftMeta` آن)؛ فقط همین‌ها خوانده می‌شود. */
export interface ShiftReminderSegment {
  shiftId: number
  shiftName: string
  custodianName: string
  /** پایان برنامهٔ ذخیره‌شدهٔ همین بخش (ms) */
  scheduledEndAt: number
  /** ساعت شروع روز کاری که هنگام باز شدن بخش ثبت شد (`dayCutoverSnapshot`، دقیقه از نیمه‌شب) */
  dayCutoverMinutes: number
  /** حالت ثبت‌شده در عکس برنامهٔ همان بخش */
  mode: 'SINGLE_SHIFT' | 'MULTI_SHIFT'
  handoverPending: boolean
  /** شیفت‌های فعال و دارای کارمندِ همان نوع برنامه */
  plans: ShiftPlanLite[]
}

/**
 * «شیفت آخر روز»: در همان روز کاری (از ساعت شروع روز تا همان ساعت فردا، به وقت محلی، همان‌طور که `CustodyService`
 * پایان برنامه را می‌سازد) هیچ شیفت فعال دیگری دیرتر از پایان این بخش تمام نمی‌شود.
 */
export function isLastShiftOfDay(seg: Pick<ShiftReminderSegment, 'scheduledEndAt' | 'dayCutoverMinutes' | 'plans'>): boolean {
  const end = seg.scheduledEndAt
  const cutover = Math.max(0, Math.min(1439, Math.round(Number(seg.dayCutoverMinutes)) || 0))
  const dayStart = new Date(end - 1)
  dayStart.setHours(Math.floor(cutover / 60), cutover % 60, 0, 0)
  if (dayStart.getTime() > end - 1) dayStart.setDate(dayStart.getDate() - 1)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)
  for (const plan of seg.plans) {
    const startMinute = Math.round(Number(plan.startMinute))
    const duration = Math.round(Number(plan.durationMinutes))
    if (!Number.isFinite(startMinute) || !(duration > 0)) continue
    for (const offset of [0, 1]) {
      const start = new Date(dayStart)
      start.setDate(start.getDate() + offset)
      start.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0)
      if (start.getTime() < dayStart.getTime() || start.getTime() >= dayEnd.getTime()) continue
      if ((Number(plan.daysMask) & (1 << start.getDay())) === 0) continue
      if (start.getTime() + duration * 60_000 > end + 60_000) return false
    }
  }
  return true
}

/** یادآوری‌ای که الان باید برود، یا null. `key` همان نشانهٔ یک‌بار است. */
export function shiftEndReminder(seg: ShiftReminderSegment | null, now: number, sent: ReadonlySet<string>, offsetHours: number): { key: string; event: MessengerEvent } | null {
  if (!seg || seg.mode !== 'MULTI_SHIFT' || !Number.isSafeInteger(seg.shiftId) || !Number.isFinite(seg.scheduledEndAt)) return null
  const last = isLastShiftOfDay(seg)
  const key = `${last ? 'n' : 'h'}:${seg.shiftId}`
  const minutes = minutesAfterShiftEnd(now, seg.scheduledEndAt)
  if (sent.has(key) || minutes < (last ? LAST_SHIFT_REMINDER_MIN : SHIFT_HANDOVER_REMINDER_MIN)) return null
  const shiftName = seg.shiftName ? `«${seg.shiftName}»` : 'شیفت'
  const plannedEnd = `پایان برنامه: ساعت ${fmtClock(seg.scheduledEndAt, offsetHours)}`
  const title = last ? '🌙 صندوق شیفت آخر هنوز باز است' : `⏰ تحویل شیفت انجام نشده · ${shiftName}`
  const lines = [
    last ? `${num(minutes)} دقیقه از پایان ${shiftName} گذشته (${plannedEnd})` : `${num(minutes)} دقیقه از پایان شیفت گذشته (${plannedEnd})`,
    `مسئول صندوق: ${seg.custodianName || 'نامشخص'}`,
    seg.handoverPending ? 'تحویل شروع شده ولی هنوز پذیرفته نشده است.' : ''
  ]
  return {
    key,
    event: {
      code: `R-${seg.shiftId}-${last ? LAST_SHIFT_REMINDER_MIN : SHIFT_HANDOVER_REMINDER_MIN}`, at: now,
      title: `${title} · ${fmtAt(now, offsetHours)}`, lines: lines.filter(Boolean),
      important: false, handover: true, system: false, day: officialDay(now, offsetHours)
    }
  }
}

export interface IdsNeeded {
  users: Set<number>; shifts: Set<number>; invoices: Set<number>; customers: Set<number>; payments: Set<number>
  credits: Set<number>; redemptions: Array<{ creditId: number; paymentId: number }>; handovers: Set<number>
  /** دفتر آزمون ۴-۹: فاکتور هر ردیف «ثبت فروش» ⇐ زمان همان ردیف (ms)، مرز «پرداخت همان لحظه» */
  saleDocs?: Map<number, number>
  /** دفتر آزمون ۴-۹: سندهای برگشت و تعویض */
  returnDocs?: Set<number>
}

export interface EventContext {
  offsetHours: number
  /** «سقف مجاز مغایرت صندوق» سیاست حسابداری (طرح §۲۵-۴ بند «د») */
  threshold: number
  includeCustomerName: boolean
  data: LookupData
}

const toMs = (at: Date | string | number): number => (at instanceof Date ? at.getTime() : typeof at === 'number' ? at : new Date(at).getTime())
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const intId = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)

function parseAfter(row: Pick<AuditRowLite, 'after'>): unknown {
  if (!row.after) return null
  try { return JSON.parse(row.after) } catch { return null }
}
/** تنها راه خواندن `after`: فقط کلیدهای فهرست ثابت همان نوع. */
export function pick(row: Pick<AuditRowLite, 'action' | 'after'>): Record<string, unknown> {
  const allowed = EVENT_FIELDS[row.action] ?? []
  const after = parseAfter(row)
  const out: Record<string, unknown> = {}
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(after, key)) out[key] = (after as Record<string, unknown>)[key]
  }
  return out
}
/** فقط شمار قلم‌ها، وقتی `after` آرایه است (مثل قیمت دستی) — هیچ فیلدی از ردیف‌ها خوانده نمی‌شود. */
const afterLength = (row: Pick<AuditRowLite, 'after'>): number | null => {
  const after = parseAfter(row)
  return Array.isArray(after) ? after.length : null
}

const METHOD_KEYS = (Object.keys(GATE_METHOD_LABELS) as GateMethodKey[]).sort((a, b) => GATE_METHOD_LABELS[b].length - GATE_METHOD_LABELS[a].length)
/** خط ثابت «روش تأیید» (معماری §۳-۹) از `note`؛ بقیهٔ `note` خوانده نمی‌شود. */
export function parseMethodLine(note: string | null): { method: GateMethodKey; number: number | null; windowNo: number | null } | null {
  if (!note) return null
  for (const line of note.split('\n')) {
    const start = line.indexOf(GATE_METHOD_NOTE_PREFIX)
    if (start < 0) continue
    const rest = line.slice(start + GATE_METHOD_NOTE_PREFIX.length)
    for (const key of METHOD_KEYS) {
      const label = GATE_METHOD_LABELS[key]
      if (!rest.startsWith(label)) continue
      const tail = rest.slice(label.length)
      const numberMatch = /^ شمارهٔ (\d{1,6})/.exec(tail)
      const windowMatch = / · پنجرهٔ (\d{1,6})/.exec(tail)
      return { method: key, number: numberMatch ? Number(numberMatch[1]) : null, windowNo: windowMatch ? Number(windowMatch[1]) : null }
    }
  }
  return null
}
const NEWS_METHODS: ReadonlySet<GateMethodKey> = new Set<GateMethodKey>(['SENSITIVE_CODE', 'OTHER_CODE', 'REMOTE_GRANT'])

/**
 * دفتر آزمون ۴-۱۴۲ — تبدیل خودکار یک‌بارهٔ تنظیمات «عوارض و مالیات» و «حق سرویس» (`migrateChargeKey` در
 * `SettingsService.ts`): سند بی کاربر، `entity` برابر `Setting` و یادداشتی که با همین آغاز ثابت شروع می‌شود.
 * مثل خط «روش تأیید» فقط همین آغاز خوانده می‌شود؛ نام تنظیم فقط اگر دقیقاً یکی از چهار عنوان ثابت باشد.
 */
const CHARGE_MIGRATION_PREFIX = 'مهاجرت تنظیمات «'
const CHARGE_TITLES: readonly string[] = CHARGE_KINDS.flatMap((kind) => CHARGE_SCOPES.map((scope) => chargeTitle(kind, scope)))
function autoChargeMigrationTitle(row: Pick<AuditRowLite, 'userId' | 'entity' | 'note'>): string | null {
  if (row.userId || row.entity !== 'Setting') return null
  const note = row.note ?? ''
  if (!note.startsWith(CHARGE_MIGRATION_PREFIX)) return null
  const end = note.indexOf('»', CHARGE_MIGRATION_PREFIX.length)
  const title = end > 0 ? note.slice(CHARGE_MIGRATION_PREFIX.length, end) : ''
  return CHARGE_TITLES.includes(title) ? title : 'عوارض یا حق سرویس'
}

const ENTITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Payment: 'پرداختی', SaleReturn: 'برگشت', ReturnCorrection: 'اصلاح برگشت', SaleInvoice: 'فاکتور', Product: 'کالا',
  ProductVariant: 'کالا', StoreCredit: 'اعتبار', CashMovement: 'گردش صندوق', Customer: 'مشتری', PurchaseInvoice: 'فاکتور خرید',
  CardTransferRequest: 'درخواست کارت‌به‌کارت', CashSession: 'بستن صندوق', Shift: 'نشست', User: 'کارمند'
})
const entityLabel = (entity: string): string => ENTITY_LABELS[entity] ?? 'سند'

/** نام فارسی نوع کار، برای خبر «کار با مجوز یا کد انجام شد». */
const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SALE_CREATE: 'ثبت فروش', WHOLESALE_SALE_CREATE: 'فروش عمده', SALE_UPDATE: 'ویرایش فاکتور', SALE_RETURN: 'برگشت از فروش',
  RETURN_REFUND: 'بازپرداخت برگشت', SALE_EXCHANGE: 'تعویض کالا', STORE_CREDIT_ISSUE: 'صدور اعتبار', CREDIT_ISSUE_MANUAL: 'صدور اعتبار',
  CREDIT_BULK_GENERATE: 'صدور گروهی اعتبار', STORE_CREDIT_REDEEM: 'مصرف اعتبار', SALE_PAYMENT_ADD: 'ثبت پرداخت',
  SALE_PAYMENT_DELETE: 'ابطال پرداختی', CHEQUE_STATUS: 'تغییر وضعیت چک', CASH_MOVEMENT: 'گردش صندوق', CASH_CLOSE: 'بستن صندوق',
  VOID: 'ابطال', DELETE: 'حذف', SALE_PRICE_OVERRIDE: 'قیمت دستی', EXCHANGE_PRICE_OVERRIDE: 'قیمت دستی در تعویض',
  CLOSED_PERIOD_OVERRIDE: 'ثبت در دورهٔ بسته', PRICE_EDIT: 'تغییر قیمت', PRICE_BULK_ADJUST: 'تغییر گروهی قیمت',
  CREDIT_VOID: 'ابطال اعتبار', CREDIT_REPRINT: 'چاپ دوبارهٔ اعتبار', CARD_TRANSFER_PAID: 'پرداخت کارت‌به‌کارت',
  CONSOLIDATE: 'تجمیع', STOCK_ADJUST: 'اصلاح موجودی', PURCHASE_CREATE: 'فاکتور خرید'
})
const AMOUNT_FIELDS = ['grandTotal', 'amount', 'total', 'refundAmount', 'applied', 'paidAmount', 'totalAmount'] as const

const PAYMENT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CASH: 'نقد', CARD: 'کارت', CREDIT: 'نسیه', CUSTOM: 'چک یا روش دیگر', STORE_CREDIT: 'اعتبار خرید', EXCHANGE_CREDIT: 'اعتبار تعویض',
  // دفتر آزمون ۴-۱۴۱ — نوع ردیف پرداخت چک `CHEQUE` است؛ پیام «چک» می‌نویسد، نه «روش ثبت‌نشده»
  CHEQUE: 'چک'
})

/** شناسه‌هایی که برای ساختن پیام‌های یک صفحه لازم‌اند (یک بار، دسته‌ای، خوانده می‌شوند). */
export function collectAuditIds(rows: readonly AuditRowLite[], includeCustomerName: boolean): IdsNeeded {
  const ids: IdsNeeded = { users: new Set(), shifts: new Set(), invoices: new Set(), customers: new Set(), payments: new Set(), credits: new Set(), redemptions: [], handovers: new Set(), saleDocs: new Map(), returnDocs: new Set() }
  for (const row of rows) {
    if (row.userId) ids.users.add(row.userId)
    const f = pick(row)
    const shiftId = intId(f.shiftId)
    if (shiftId) ids.shifts.add(shiftId)
    if (row.entity === 'Shift' && row.entityId) ids.shifts.add(row.entityId)
    if (row.entity === 'SaleInvoice' && row.entityId) ids.invoices.add(row.entityId)
    if (row.entity === 'Payment' && row.entityId) ids.payments.add(row.entityId)
    if (includeCustomerName && intId(f.customerId)) ids.customers.add(f.customerId as number)
    if (row.action === 'CREDIT_REPRINT' && row.entity === 'StoreCredit' && row.entityId) ids.credits.add(row.entityId)
    if (row.action === 'STORE_CREDIT_REDEEM' && row.entityId) {
      ids.credits.add(row.entityId)
      const paymentId = intId(f.paymentId)
      if (paymentId) ids.redemptions.push({ creditId: row.entityId, paymentId })
    }
    // دفتر آزمون ۴-۹: قالب کامل فاکتور فروش، برگشت و تعویض
    if ((row.action === 'SALE_CREATE' || row.action === 'WHOLESALE_SALE_CREATE') && row.entity === 'SaleInvoice' && row.entityId) ids.saleDocs!.set(row.entityId, toMs(row.at))
    if (row.entity === 'SaleReturn' && row.entityId && ['RETURN_REFUND', 'SALE_RETURN', 'SALE_EXCHANGE'].includes(row.action)) ids.returnDocs!.add(row.entityId)
  }
  return ids
}

function makeHelpers(ctx: EventContext) {
  const who = (id: number | null | undefined): string => (id ? ctx.data.users.get(id) ?? `کاربر ${num(id)}` : 'نامشخص')
  const shiftLabel = (id: number | null | undefined): string | null => {
    const s = id ? ctx.data.shifts.get(id) : null
    return s ? s.name : null
  }
  const receiptOf = (row: AuditRowLite, f: Record<string, unknown>): number | null =>
    n(f.receiptNo) ?? (row.entity === 'SaleInvoice' && row.entityId ? ctx.data.invoices.get(row.entityId)?.receiptNo ?? null : null)
  const event = (row: AuditRowLite, title: string, lines: string[], flags: Partial<Pick<MessengerEvent, 'important' | 'handover' | 'system' | 'sale'>> = {}, suffix = ''): MessengerEvent => {
    const at = toMs(row.at)
    return {
      code: `A-${row.id}${suffix}`, at, title: `${title} · ${fmtAt(at, ctx.offsetHours)}`, lines: lines.filter(Boolean),
      important: !!flags.important, handover: !!flags.handover, system: !!flags.system, sale: !!flags.sale,
      day: officialDay(at, ctx.offsetHours)
    }
  }
  return { who, shiftLabel, receiptOf, event }
}

/** مغایرت ثبت‌شده با برچسب کسری یا اضافه (عدد همان ثبت‌شده است). */
function differenceText(diff: number | null, state?: unknown): string {
  if (diff === null) return 'ثبت نشده'
  if (diff === 0) return 'تطبیق کامل (۰)'
  const label = state === 'SHORTAGE' || diff < 0 ? 'کسری' : 'اضافه'
  return `${rial(Math.abs(diff))} ${label}`
}

/** دفتر آزمون ۴-۳۶ — درصد با یک رقم اعشار، همان نمایش جدول «تخفیف‌های غیرعادی» (`StaffPerformancePanel.tsx`). */
const pct = (v: number): string => `${faDigits(v.toFixed(1))}٪`
/** دفتر آزمون ۴-۳۶ — درصد تخفیف یک ردیف از قیمت ناخالص همان ردیف (گرد کردن مثل `invoiceDiscountPercent`). */
function lineDiscountPercent(l: DocLineLite): number {
  const gross = l.qty * l.unitPrice
  return gross > 0 ? Math.round((l.discount / gross) * 1000) / 10 : 0
}
/**
 * دفتر آزمون ۴-۹ — هر قلم با تعداد، قیمت هر عدد و جمع ردیف؛ تخفیف ردیف اگر بود، با درصدش (۴-۳۶). قالب از ۴-۳۵
 * (`itemLine`): «• شلوار بگ سایز ۳۱ - ذغالی — ۲ × ۳۶٬۰۰۰٬۰۰۰ = ۷۲٬۰۰۰٬۰۰۰ ریال».
 */
export function docLineText(l: DocLineLite): string {
  return itemLine(l.name, l.qty, l.unitPrice, { extra: l.discount ? `تخفیف ${rial(l.discount)} (${pct(lineDiscountPercent(l))})` : undefined, total: l.lineTotal })
}
/** دفتر آزمون ۴-۳۵ — فهرست قلم‌های یک سند زیر زیرسرتیتر «🛍 قلم‌ها:» */
const itemsSection = (lines: readonly DocLineLite[]): string[] => (lines.length ? [sectionTitle('قلم‌ها'), ...lines.map(docLineText)] : [])
/**
 * دفتر آزمون ۴-۳۶ — درصد تخفیف فاکتور با همان تابع گزارش «تخفیف‌های غیرعادی» (`invoiceDiscountPercent`)، و غیرعادی بودنش
 * با همان قاعده (بیشتر از آستانه؛ آستانهٔ صفر = خاموش).
 */
function saleDiscount(doc: SaleDocLite, threshold: number): { percent: number; abnormal: boolean } {
  const percent = invoiceDiscountPercent({ goodsTotal: doc.goodsTotal, discountTotal: doc.discountTotal, taxTotal: doc.taxTotal, serviceCharge: doc.serviceCharge, deliveryFee: doc.deliveryFee })
  return { percent, abnormal: threshold > 0 && doc.discountTotal > 0 && percent > threshold }
}
/**
 * دفتر آزمون ۴-۹ — بدنهٔ فاکتور فروش: همهٔ قلم‌ها؛ جمع کالاها، تخفیف، عوارض و مالیات، هزینهٔ خدمات و هزینهٔ پیک هر کدام
 * فقط اگر صفر نباشد؛ «مبلغ فاکتور» همیشه؛ پرداخت‌های همان لحظه به تفکیک روش و مانده (نسیه). عددها همان ثبت‌شده‌اند.
 */
function saleDocLines(doc: SaleDocLite, threshold: number): string[] {
  const byLabel = new Map<string, number>()
  for (const p of doc.payments) byLabel.set(p.label, (byLabel.get(p.label) ?? 0) + p.amount)
  const remaining = doc.grandTotal - doc.payments.reduce((s, p) => s + p.amount, 0)
  const discount = saleDiscount(doc, threshold)
  return [
    ...itemsSection(doc.lines),
    doc.goodsTotal ? `جمع کالاها: ${rial(doc.goodsTotal)}` : '',
    // دفتر آزمون ۴-۳۶: جمع تخفیف با درصدش از جمع کالاها، و خط «تخفیف غیرعادی» همان لحظه
    doc.discountTotal ? `تخفیف: ${rial(doc.discountTotal)} (${pct(discount.percent)} از جمع کالاها)` : '',
    discount.abnormal ? `تخفیف غیرعادی (بیش از ${faDigits(threshold)}٪)` : '',
    doc.taxTotal ? `عوارض و مالیات: ${rial(doc.taxTotal)}` : '',
    doc.serviceCharge ? `هزینهٔ خدمات: ${rial(doc.serviceCharge)}` : '',
    doc.deliveryFee ? `هزینهٔ پیک: ${rial(doc.deliveryFee)}` : '',
    `مبلغ فاکتور: ${rial(doc.grandTotal)}`,
    byLabel.size ? `پرداخت: ${[...byLabel].map(([label, amount]) => `${label} ${rial(amount)}`).join(' · ')}` : '',
    remaining > 0 ? `مانده (نسیه): ${rial(remaining)}` : ''
  ]
}
/** دفتر آزمون ۴-۹ — «زنجیره: فاکتور ۱ ← سند ۲ ← سند ۳»؛ فقط وقتی فاکتور مبدأ خودش سند تعویض است. */
export function chainLine(chain: readonly number[]): string {
  return chain.length >= 3 ? `زنجیره: ${chain.map((receipt, i) => `${i ? 'سند' : 'فاکتور'} ${num(receipt)}`).join(' ← ')}` : ''
}

/**
 * ردیف‌های یک صفحه ⇒ پیام‌ها. ردیف‌های یک سند برگشت (`RETURN_REFUND`، `SALE_RETURN`، `SALE_EXCHANGE` با
 * همان شناسه) یک پیام می‌شوند؛ «پایان نشست»ی که پشت بستن صندوق همان شیفت آمده، پیام جدا نمی‌گیرد.
 */
export function auditPageToEvents(rows: readonly AuditRowLite[], ctx: EventContext, state: { closeShiftIds: number[] }): MessengerEvent[] {
  const h = makeHelpers(ctx)
  const out: MessengerEvent[] = []
  const returnGroups = new Map<number, { refund?: AuditRowLite; ret?: AuditRowLite; exchange?: AuditRowLite }>()
  for (const row of rows) {
    if (row.entity !== 'SaleReturn' || !row.entityId) continue
    const g = returnGroups.get(row.entityId) ?? {}
    if (row.action === 'RETURN_REFUND') g.refund = row
    else if (row.action === 'SALE_RETURN') g.ret = row
    else if (row.action === 'SALE_EXCHANGE') g.exchange = row
    returnGroups.set(row.entityId, g)
  }
  const done = new Set<number>()
  for (const row of rows) {
    if (done.has(row.id)) continue
    done.add(row.id)
    let events: MessengerEvent[] = []
    if (row.entity === 'SaleReturn' && row.entityId && ['RETURN_REFUND', 'SALE_RETURN', 'SALE_EXCHANGE'].includes(row.action)) {
      const g = returnGroups.get(row.entityId)!
      for (const r of [g.refund, g.ret, g.exchange]) if (r) done.add(r.id)
      events = returnGroupEvent(g, ctx, h)
    } else {
      events = mapRow(row, ctx, h, state)
    }
    out.push(...withMethodNews(row, events, ctx, h))
  }
  return out
}

/** خط «روش تأیید»: کد و مجوز راه دور ⇒ ⚠️ و خبر جدا (معماری §۴-۱، بازبینی دور ۱). */
function withMethodNews(row: AuditRowLite, events: MessengerEvent[], ctx: EventContext, h: ReturnType<typeof makeHelpers>): MessengerEvent[] {
  const method = parseMethodLine(row.note)
  if (!method) return events
  const label = GATE_METHOD_LABELS[method.method]
  const methodLine = `روش تأیید: ${label}${method.number ? ` شمارهٔ ${num(method.number)}` : ''}${method.windowNo ? ` · پنجرهٔ ${num(method.windowNo)}` : ''}`
  const news = NEWS_METHODS.has(method.method)
  if (events.length) {
    const [first, ...rest] = events
    return [{ ...first, lines: [...first.lines, methodLine], important: first.important || news }, ...rest]
  }
  if (!news) return events
  const f = pick(row)
  const amountKey = AMOUNT_FIELDS.find((k) => n(f[k]) !== null)
  const doc = h.receiptOf(row, f) ?? row.entityId
  return [h.event(row, `🔑 کار با ${label} انجام شد · ${ACTION_LABELS[row.action] ?? 'یک کار رمزدار'}`, [
    doc ? `سند: ${entityLabel(row.entity)} ${num(doc)}` : '',
    amountKey ? `مبلغ ثبت‌شده: ${rial(f[amountKey])}` : '',
    methodLine,
    `کاربر: ${h.who(row.userId)}`
  ], { important: true })]
}

function returnGroupEvent(g: { refund?: AuditRowLite; ret?: AuditRowLite; exchange?: AuditRowLite }, ctx: EventContext, h: ReturnType<typeof makeHelpers>): MessengerEvent[] {
  const refund = g.refund ? pick(g.refund) : null
  const refundLine = refund && n(refund.refundAmount) !== null
    ? `بازپرداخت: ${rial(refund.refundAmount)} · ${REFUND_METHOD_LABELS[String(refund.refundMethod)] ?? 'روش ثبت‌نشده'}`
    : ''
  if (g.exchange) {
    const f = pick(g.exchange)
    // دفتر آزمون ۴-۹: جمع‌ها زیر سرخط؛ خط زنجیره؛ دو فهرست «کالای برگشتی» و «کالای جایگزین» از خود سندها.
    const doc = g.exchange.entityId ? ctx.data.returnDocs.get(g.exchange.entityId) : undefined
    return [h.event(g.exchange, `🔄 تعویض کالا · فاکتور ${num(f.sourceReceiptNo)}${n(f.exchangeReceiptNo) !== null ? ` ← سند ${num(f.exchangeReceiptNo)}` : ''}`, [
      `جمع کالای برگشتی: ${rialOrMissing(f.returnTotal)} · جمع کالای جایگزین: ${rialOrMissing(f.exchangeTotal)}`,
      `مابه‌التفاوت: ${rialOrMissing(f.diff)} · ${EXCHANGE_SETTLEMENT_LABELS[String(f.settlement)] ?? 'تسویهٔ ثبت‌نشده'}`,
      doc ? chainLine(doc.chain) : '',
      ...(doc ? ['کالای برگشتی:', ...doc.lines.map(docLineText)] : []),
      ...(doc?.replacement ? ['کالای جایگزین:', ...doc.replacement.map(docLineText)] : []),
      refundLine,
      `فروشنده: ${h.who(g.exchange.userId)}`
    ], { important: true })]
  }
  const main = g.ret ?? g.refund!
  const f = g.ret ? pick(g.ret) : {}
  const receipt = n(f.receiptNo) ?? n(refund?.receiptNo)
  const doc = main.entityId ? ctx.data.returnDocs.get(main.entityId) : undefined // دفتر آزمون ۴-۹: همهٔ قلم‌های برگشتی
  return [h.event(main, `↩️ برگشت از فروش${receipt !== null ? ` · فاکتور ${num(receipt)}` : ''}`, [
    `جمع برگشت: ${g.ret ? rialOrMissing(f.total) : rialOrMissing(refund?.returnTotal)}${f.fullyReturned === true ? ' (کل فاکتور)' : ''}`,
    ...(doc ? itemsSection(doc.lines) : []),
    refundLine,
    `فروشنده: ${h.who(main.userId)}`
  ], { important: true })]
}

function mapRow(row: AuditRowLite, ctx: EventContext, h: ReturnType<typeof makeHelpers>, state: { closeShiftIds: number[] }): MessengerEvent[] {
  const f = pick(row)
  switch (row.action) {
    case 'SALE_CREATE':
    case 'WHOLESALE_SALE_CREATE': {
      const grand = n(f.grandTotal), paid = n(f.paidTotal)
      const customerId = intId(f.customerId)
      const customer = ctx.includeCustomerName && customerId ? ctx.data.customers.get(customerId) : null
      // دفتر آزمون ۴-۹: قالب کامل فاکتور از خود سند؛ سندِ خوانده‌نشده ⇐ همان خط‌های پیش از آن.
      const doc = row.entityId ? ctx.data.saleDocs.get(row.entityId) : undefined
      // دفتر آزمون ۴-۳۶: تخفیف غیرعادی ⇐ پیام مهم (نشان ⚠️؛ به گیرندهٔ «فقط موارد مهم» هم می‌رسد)
      const abnormal = doc ? saleDiscount(doc, ctx.data.abnormalDiscountPercent).abnormal : false
      return [h.event(row, `🧾 فروش${row.action === 'WHOLESALE_SALE_CREATE' ? ' عمده' : ''} · فاکتور ${num(f.receiptNo)}`, [
        `جمع فاکتور: ${rialOrMissing(grand)}${n(f.lines) !== null ? ` · ${num(f.lines)} قلم` : ''}`, // ۴-۳۵: «جمع:» ⇐ «جمع فاکتور:»
        ...(doc ? saleDocLines(doc, ctx.data.abnormalDiscountPercent) : [
          n(f.discountTotal) ? `تخفیف: ${rial(f.discountTotal)}` : '',
          // `paidTotal` هنگام ثبت فقط پرداخت‌های همان لحظه است؛ اعتبار خرید جدا (پیام «اعتبار مصرف شد») می‌آید.
          grand !== null && paid !== null && paid < grand ? `پرداخت هنگام ثبت: ${rial(paid)} از ${rial(grand)} (بقیه با اعتبار خرید یا نسیه)` : ''
        ]),
        `فروشنده: ${h.who(row.userId)}${h.shiftLabel(intId(f.shiftId)) ? ` · شیفت ${h.shiftLabel(intId(f.shiftId))}` : ''}`,
        customer ? `مشتری: ${customer}` : ''
      ], { sale: true, important: abnormal })]
    }
    case 'SALE_UPDATE': {
      const receipt = h.receiptOf(row, f)
      return [h.event(row, `✏️ ویرایش فاکتور${receipt !== null ? ` ${num(receipt)}` : ''}`, [
        n(f.grandTotal) !== null ? `جمع تازه: ${rial(f.grandTotal)}` : '',
        `کاربر: ${h.who(row.userId)}`
      ])]
    }
    case 'STORE_CREDIT_ISSUE':
    case 'CREDIT_ISSUE_MANUAL':
      return [h.event(row, `🎫 صدور اعتبار${typeof f.publicReference === 'string' ? ` · ${faDigits(f.publicReference.slice(0, 40))}` : ''}`, [
        `مبلغ: ${rialOrMissing(f.amount)} · ${CREDIT_SOURCE_LABELS[String(f.source)] ?? 'منشأ ثبت‌نشده'}`,
        `مهلت: ${typeof f.expiresAtJalali === 'string' ? faDigits(f.expiresAtJalali) : 'بدون انقضا'}${n(f.maxUses) && (f.maxUses as number) > 1 ? ` · تا ${num(f.maxUses)} بار` : ''}`,
        `صادرکننده: ${h.who(row.userId)}`
      ], { important: true })]
    case 'CREDIT_BULK_GENERATE':
      return [h.event(row, '🎫 صدور گروهی اعتبار', [
        `تعداد: ${num(f.created)} · هر کدام ${rialOrMissing(f.amountEach)} · جمع ${rialOrMissing(f.totalAmount)}`,
        `صادرکننده: ${h.who(row.userId)}`
      ], { important: true })]
    case 'STORE_CREDIT_OVER_LIMIT':
      return [h.event(row, '🎫 صدور اعتبار بالاتر از سقف (با تأیید مدیر)', [
        `مبلغ: ${rialOrMissing(f.amount)} · سقف: ${rialOrMissing(f.limit)}`,
        `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    case 'STORE_CREDIT_REDEEM': {
      // طرح §۲۵-۴ بند «هـ»: مصرف‌کننده، صادرکننده، مبلغ و فاصلهٔ صدور تا مصرف؛ کد و بارکد هرگز.
      const creditId = row.entityId
      const paymentId = intId(f.paymentId)
      const credit = creditId ? ctx.data.credits.get(creditId) : undefined
      const redemption = creditId && paymentId ? ctx.data.redemptions.get(`${creditId}:${paymentId}`) : undefined
      const consumer = redemption?.userId ?? row.userId
      const issuer = credit?.userId ?? null
      const sameIssuer = !!consumer && !!issuer && consumer === issuer
      const reprinted = !!creditId && ctx.data.reprinted.has(creditId)
      const usedAt = redemption?.at ?? toMs(row.at)
      return [h.event(row, `💳 اعتبار مصرف شد${creditId ? ` · اعتبار #${num(creditId)}` : ''}`, [
        `مبلغ مصرف: ${rialOrMissing(f.applied)}${n(f.receiptNo) !== null ? ` · فاکتور ${num(f.receiptNo)}` : ''}`,
        `مصرف‌کننده: ${h.who(consumer)} · صادرکننده: ${issuer ? h.who(issuer) : 'ثبت نشده'}`,
        credit ? `${fmtDuration(usedAt - credit.issuedAt)} پس از صدور` : '',
        n(f.remainderAfter) !== null ? `باقی‌مانده: ${rial(f.remainderAfter)}` : '',
        sameIssuer ? 'مصرف‌کننده همان صادرکننده است.' : '',
        reprinted ? 'این اعتبار پیش‌تر به دست فروشنده دوباره چاپ شده بود.' : ''
      ], { important: sameIssuer || reprinted })]
    }
    case 'SALE_PAYMENT_ADD': {
      // دفتر آزمون ۴-۱۴۴ — پول دریافت‌شده (نوع CASH) فقط با جای پول: «کارت (کارتخوان فروشگاه)»، «نقدی (صندوق
      // فروشگاه)» یا «حساب مدیر»؛ بی جای پول همان «نقد». چک (۴-۱۴۱) و روش‌های دیگر مثل امروز.
      const place = PAYMENT_DESTINATION_LABELS[String(f.destination)]
      const how = String(f.kind) === 'CASH' && place ? place : `${PAYMENT_KIND_LABELS[String(f.kind)] ?? 'روش ثبت‌نشده'}${place ? ` · ${place}` : ''}`
      return [h.event(row, `💰 پرداخت${n(f.receiptNo) !== null ? ` · فاکتور ${num(f.receiptNo)}` : ''}`, [
        `مبلغ: ${rialOrMissing(f.amount)} · ${how}`,
        typeof f.dueDateJalali === 'string' ? `سررسید: ${faDigits(f.dueDateJalali)}` : '',
        n(f.remaining) !== null ? `مانده فاکتور: ${rial(f.remaining)}` : '',
        `کاربر: ${h.who(row.userId)}`
      ])]
    }
    case 'SALE_PAYMENT_UPDATE':
      return [h.event(row, '✏️ ویرایش پرداختی', [n(f.remaining) !== null ? `مانده فاکتور: ${rial(f.remaining)}` : '', `کاربر: ${h.who(row.userId)}`])]
    case 'SALE_PAYMENT_DELETE': {
      const payment = row.entityId ? ctx.data.payments.get(row.entityId) : undefined
      const receipt = payment ? ctx.data.invoices.get(payment.invoiceId)?.receiptNo ?? null : null
      return [h.event(row, `⛔ ابطال پرداختی${receipt !== null ? ` · فاکتور ${num(receipt)}` : ''}`, [
        payment ? `مبلغ: ${rial(payment.amount)}` : '', `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    }
    case 'CHEQUE_STATUS': {
      const payment = row.entityId ? ctx.data.payments.get(row.entityId) : undefined
      const bounced = f.chequeStatus === 'BOUNCED'
      return [h.event(row, `🧾 چک: ${CHEQUE_STATUS_LABELS[String(f.chequeStatus)] ?? 'تغییر وضعیت'}`, [
        `مبلغ: ${n(f.amount) !== null ? rial(f.amount) : payment ? rial(payment.amount) : 'ثبت نشده'}`,
        PAYMENT_DESTINATION_LABELS[String(f.destination)] ? `مقصد پول: ${PAYMENT_DESTINATION_LABELS[String(f.destination)]}` : '',
        `کاربر: ${h.who(row.userId)}`
      ], { important: bounced })]
    }
    case 'CASH_MOVEMENT': {
      // بازپرداخت‌های خودکار برگشت و تعویض در پیام همان سند آمده‌اند.
      const type = String(f.type)
      if (!['CASH_IN', 'CASH_OUT', 'DEPOSIT', 'WITHDRAWAL'].includes(type)) return []
      return [h.event(row, `💵 ${CASH_MOVEMENT_LABELS[type] ?? 'گردش صندوق'}`, [`مبلغ: ${rialOrMissing(f.amount)}`, `کاربر: ${h.who(row.userId)}`])]
    }
    case 'CASH_CLOSE': {
      const shiftId = intId(f.shiftId)
      if (shiftId) {
        state.closeShiftIds.push(shiftId)
        if (state.closeShiftIds.length > 20) state.closeShiftIds.splice(0, state.closeShiftIds.length - 20)
      }
      const diff = n(f.cashDifference)
      const counted = n(f.countedCash)
      const shift = h.shiftLabel(shiftId)
      const closeGap = shiftId ? shiftEndGap(toMs(row.at), ctx.data.segments?.get(shiftId)?.scheduledEndAt) : ''
      const close = h.event(row, `🔁 تحویل شیفت · بستن صندوق${shift ? ` ${shift}` : ' بازه‌ای'}`, [
        `کاربر: ${h.who(row.userId)}`,
        `نقد مورد انتظار: ${rialOrMissing(f.expectedCash)} · شمرده: ${counted === null ? 'شمرده نشد' : rial(counted)}`,
        `مغایرت: ${counted === null ? 'ثبت نشده' : differenceText(diff, f.state)}`,
        `فروش: ${num(f.count)} فاکتور · جمع ${rialOrMissing(f.grandTotal)}`,
        `نقد ${rialOrMissing(f.cashTotal)} · کارتخوان ${rialOrMissing(f.cardTotal)} · حساب مدیر ${rialOrMissing(f.managerAccountTotal)} · نسیه ${rialOrMissing(f.creditTotal)}`,
        `موجودی اول ${rialOrMissing(f.openingFloat)} · برداشت ${rialOrMissing(f.withdrawals)} · واریز ${rialOrMissing(f.deposits)}`,
        // دفتر آزمون ۴-۲۷: فقط بخش حضانتِ برنامه‌دار پایان ثبت‌شده دارد
        closeGap ? `زمان بستن: ${closeGap}` : ''
      ], { handover: true, important: counted !== null && diff !== null && diff !== 0 })
      const out = [close]
      // طرح §۲۵-۴ بند «د»: فقط عدد ثبت‌شده با همان آستانهٔ سیاست حسابداری سنجیده می‌شود.
      if (counted !== null && diff !== null && ctx.threshold > 0 && Math.abs(diff) > ctx.threshold) {
        out.push(h.event(row, `🚨 مغایرت بزرگ در بستن صندوق${shift ? ` ${shift}` : ''}`, [
          `مغایرت: ${differenceText(diff, f.state)}`,
          `سقف مجاز مغایرت: ${rial(ctx.threshold)}`,
          `کاربر: ${h.who(row.userId)}`
        ], { system: true, important: true, handover: true }, '-D'))
      }
      return out
    }
    case 'SHIFT_OPEN':
      return [h.event(row, `▶️ نشست باز شد · ${typeof f.session === 'string' ? f.session : h.shiftLabel(row.entityId) ?? 'نشست'}`, [`فروشنده: ${h.who(row.userId)}`], { handover: true })]
    case 'SHIFT_CLOSE':
      if (row.entityId && state.closeShiftIds.includes(row.entityId)) return []
      return [h.event(row, `⏹️ نشست بسته شد · ${typeof f.session === 'string' ? f.session : h.shiftLabel(row.entityId) ?? 'نشست'}`, [`کاربر: ${h.who(row.userId)}`], { handover: true })]
    case 'SHIFT_OVERTIME':
      return [h.event(row, `⏱️ اضافه‌کاری نشست · ${typeof f.session === 'string' ? f.session : h.shiftLabel(row.entityId) ?? 'نشست'}`, [`کاربر: ${h.who(row.userId)}`], { handover: true })]
    case 'VOID': {
      const payment = row.entity === 'Payment' && row.entityId ? ctx.data.payments.get(row.entityId) : undefined
      const receipt = payment ? ctx.data.invoices.get(payment.invoiceId)?.receiptNo ?? null : null
      return [h.event(row, `⛔ ابطال ${entityLabel(row.entity)}${receipt !== null ? ` · فاکتور ${num(receipt)}` : row.entityId ? ` ${num(row.entityId)}` : ''}`, [
        payment ? `مبلغ: ${rial(payment.amount)}` : '', `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    }
    case 'DELETE':
      return [h.event(row, `🗑️ حذف ${entityLabel(row.entity)}${row.entityId ? ` ${num(row.entityId)}` : ''}`, [`کاربر: ${h.who(row.userId)}`], { important: true })]
    case 'DATA_ARCHIVE_PURGE':
      return [h.event(row, '🗑️ پاک‌سازی و بایگانی داده‌های قدیمی', [`کاربر: ${h.who(row.userId)}`], { important: true })]
    case 'SALE_CHARGE_OVERRIDE': {
      // دفتر آزمون ۴-۳۶: تنها کار پنل فروش که پیام نداشت؛ عوارض یا حق سرویس دستی فاکتور عمده (عدد واردشده، همان ثبت‌شده)
      const receipt = h.receiptOf(row, f)
      return [h.event(row, `✍️ عوارض یا حق سرویس دستی${receipt !== null ? ` · فاکتور ${num(receipt)}` : ''}`, [
        n(f.tax) !== null ? `عوارض و مالیات: ${rial(f.tax)}` : '',
        n(f.service) !== null ? `حق سرویس: ${rial(f.service)}` : '',
        `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    }
    case 'SALE_PRICE_OVERRIDE':
    case 'EXCHANGE_PRICE_OVERRIDE': {
      const receipt = h.receiptOf(row, f)
      const count = afterLength(row)
      return [h.event(row, `✍️ قیمت دستی${row.action === 'EXCHANGE_PRICE_OVERRIDE' ? ' در تعویض' : ''}${receipt !== null ? ` · فاکتور ${num(receipt)}` : ''}`, [
        count !== null ? `${num(count)} قلم با قیمت دستی` : '', `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    }
    case 'CLOSED_PERIOD_OVERRIDE':
      return [h.event(row, '📕 ثبت در دورهٔ بسته (با تأیید مدیر)', [
        typeof f.what === 'string' ? `کار: ${f.what.slice(0, 120)}` : '',
        typeof f.dayJalali === 'string' ? `روز: ${faDigits(f.dayJalali)}` : '',
        `کاربر: ${h.who(row.userId)}`
      ], { important: true })]
    case 'PRICE_EDIT':
      return [h.event(row, '🏷️ تغییر قیمت یک کالا', [`کاربر: ${h.who(row.userId)}`])]
    case 'PRICE_BULK_ADJUST':
    case 'PRICE_BULK_REVERT':
      return [h.event(row, row.action === 'PRICE_BULK_ADJUST' ? '🏷️ تغییر گروهی قیمت' : '🏷️ برگرداندن تغییر گروهی قیمت', [
        n(f.itemCount) !== null ? `${num(f.itemCount)} کالا` : '', `کاربر: ${h.who(row.userId)}`
      ])]
    case 'AUTH_LOCKOUT':
      if (f.kind === 'ONE_TIME_CODES') {
        return [h.event(row, `🔒 ورود کد یک‌بارمصرف پس از ۵ تلاش اشتباه ${n(f.minutes) !== null ? `${num(f.minutes)} دقیقه` : ''} قفل شد`, [
          n(f.windowNo) !== null ? `پنجرهٔ ${num(f.windowNo)}` : '', 'مدیر می‌تواند در «تنظیمات ← رمز مدیر و خروج» قفل کدها را بردارد.'
        ], { important: true })]
      }
      return [h.event(row, '🔒 رمز پس از تلاش‌های اشتباه قفل شد', [row.userId ? `کاربر: ${h.who(row.userId)}` : ''], { important: true })]
    case 'PANEL_LOCKS_UPDATE':
      return [h.event(row, '🔐 قفل‌های برنامه عوض شد', [`کاربر: ${h.who(row.userId)}`], { important: true })]
    case 'SETTINGS_UPDATE': {
      if (row.entity === 'MessengerSettings') return [] // خبر همین تغییر پیش از اعمال رفته است
      // دفتر آزمون ۴-۱۴۲ — کار خود برنامه، نه کاربر: پیام ساده و غیرهشداری (فقط برای گیرندهٔ «همه»)
      const autoTitle = autoChargeMigrationTitle(row)
      if (autoTitle !== null)
        return [h.event(row, `⚙️ تبدیل خودکار تنظیمات «${autoTitle}»`, ['یک بار، کار خود برنامه پس از نصب یا به‌روزرسانی؛ کسی تنظیمی را عوض نکرده.'])]
      return [h.event(row, '⚙️ تنظیمات برنامه عوض شد', [`کاربر: ${h.who(row.userId)}`], { important: true })]
    }
    case 'CREDIT_VOID':
    case 'CREDIT_DELETE':
      return [h.event(row, `⛔ ${row.action === 'CREDIT_VOID' ? 'ابطال' : 'ابطال و بایگانی'} اعتبار${row.entityId ? ` #${num(row.entityId)}` : ''}`, [`کاربر: ${h.who(row.userId)}`], { important: true })]
    case 'CREDIT_REPRINT': {
      // مرحلهٔ ۴ (مورد ۱۲): رزرو و آزادسازیِ چاپ دوبارهٔ فروشنده فقط دفترند؛ خبر با ردیف کاغذ واقعی می‌رود (یک پیام برای یک کاغذ).
      if (typeof f.path === 'string' && f.path.startsWith('SELLER_CERTIFICATE')) return []
      const sellerReason = ctx.data.sellerPapers.get(row.id)
      if (sellerReason !== undefined) {
        return [h.event(row, `🖨️ چاپ دوبارهٔ گواهی اعتبار به دست فروشنده${row.entityId ? ` #${num(row.entityId)}` : ''}`, [
          `کاربر: ${h.who(row.userId)}`, `دلیل: ${sellerReason === 'OTHER' ? 'سایر' : 'چاپ ناقص'}`
        ], { important: true })]
      }
      return [h.event(row, `🖨️ چاپ دوبارهٔ اعتبار${row.entityId ? ` #${num(row.entityId)}` : ''}`, [`کاربر: ${h.who(row.userId)}`], { important: true })]
    }
    case 'CREDIT_AMOUNT_CHANGE':
      return [h.event(row, `✏️ تغییر مبلغ اعتبار${row.entityId ? ` #${num(row.entityId)}` : ''}`, [`کاربر: ${h.who(row.userId)}`], { important: true })]
    case 'CREDIT_SUSPEND':
    case 'CREDIT_REACTIVATE':
    case 'CREDIT_EXPIRY_CHANGE': {
      const label = row.action === 'CREDIT_SUSPEND' ? 'تعلیق' : row.action === 'CREDIT_REACTIVATE' ? 'فعال شدن دوباره' : 'تغییر مهلت'
      return [h.event(row, `✏️ ${label} اعتبار${row.entityId ? ` #${num(row.entityId)}` : ''}`, [`کاربر: ${h.who(row.userId)}`])]
    }
    case 'CARD_TRANSFER_REQUEST':
      return [h.event(row, `🏦 درخواست کارت‌به‌کارت${n(f.receiptNo) !== null ? ` · فاکتور ${num(f.receiptNo)}` : ''}`, [`مبلغ: ${rialOrMissing(f.amount)}`, `کاربر: ${h.who(row.userId)}`])]
    case 'CARD_TRANSFER_PAID':
      return [h.event(row, '🏦 کارت‌به‌کارت پرداخت شد', [
        `مبلغ: ${rialOrMissing(f.paidAmount)}${n(f.sourceReceiptNo) !== null ? ` · فاکتور ${num(f.sourceReceiptNo)}` : ''}`, `کاربر: ${h.who(row.userId)}`
      ])]
    case 'ACCESS_EVENT':
      return accessEvent(row, f, h)
    default:
      return []
  }
}

/** ردیف‌های `ACCESS_EVENT` (نویسنده‌ها در مرحله‌های ۵ و ۶). دیدن گزارش از گوشی و ورود و خروج مدیر پیام نمی‌شوند. */
function accessEvent(row: AuditRowLite, f: Record<string, unknown>, h: ReturnType<typeof makeHelpers>): MessengerEvent[] {
  const kind = String(f.kind ?? '')
  const lock = typeof f.titleFa === 'string' ? f.titleFa.slice(0, 80) : ''
  const where = [lock ? `قفل: ${lock}` : '', n(f.number) !== null ? `شمارهٔ ${num(f.number)}` : '', n(f.windowNo) !== null ? `پنجرهٔ ${num(f.windowNo)}` : ''].filter(Boolean).join(' · ')
  const by = `کاربر: ${h.who(row.userId)}`
  const K = ACCESS_EVENT_KINDS
  // `decision` فقط برچسب ثابت است (بازه، دلیل، نوع)؛ هیچ کد یا متن آزاد.
  const label = typeof f.decision === 'string' ? f.decision.slice(0, 40) : ''
  // دفتر آزمون ۴-۴۷ (مجوز زمان‌بندی‌شده): کارمند مجوز، و در «باز شد» ساعت بستن پنجرهٔ امروز (`minutes` = ساعت پایان رسمی به دقیقهٔ روز)
  const custodian = kind.startsWith('SCHEDULED_GRANT_') && typeof f.recipientName === 'string' && f.recipientName ? `مسئول صندوق: ${f.recipientName.slice(0, 60)}` : ''
  const endMin = kind === K.SCHEDULED_GRANT_OPENED ? n(f.minutes) : null
  const until = endMin !== null && Number.isInteger(endMin) && endMin >= 0 && endMin < 1440 ? `زمان بستن: ساعت ${faDigits(`${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`)}` : ''
  switch (kind) {
    // دفتر آزمون ۴-۴۵: یک دستهٔ کد که ماژول‌های پولی را هم باز می‌کند ⇒ هر مصرف ⚠️ (در «فقط موارد مهم» هم)، بی «حساس» یا «قسمت»
    case K.CODE_USED: return [h.event(row, '🔑 کد یک‌بارمصرف مصرف شد', [where, n(f.minutes) !== null ? `تا ${num(f.minutes)} دقیقه` : ''], { important: true })]
    case K.CODE_WRONG: return [h.event(row, '🔑 کد یک‌بارمصرف اشتباه وارد شد', [where], { important: true })]
    case K.CODES_CREATED: return [h.event(row, '🔑 کدهای یک‌بارمصرف تازه ساخته شد', [n(f.count) !== null ? `تعداد: ${num(f.count)}` : '', lock ? `بخش: ${lock}` : '', by], { important: true })]
    case K.CODES_REVOKED: return [h.event(row, '🔑 کدهای یک‌بارمصرف باطل شد', [lock ? `بخش: ${lock}` : '', by])]
    case K.CODES_UNLOCKED: return [h.event(row, '🔓 قفل ورود کدهای یک‌بارمصرف به دست مدیر برداشته شد', [by])]
    case K.CODES_FILE_BROKEN: return [h.event(row, '⚠️ پروندهٔ کدهای یک‌بارمصرف خراب بود؛ همهٔ کدها باطل است. کد تازه بسازید.', [], { important: true })]
    case K.RECOVERY_CODES_CREATED: return [h.event(row, '🆘 کدهای بازیابی توقف اضطراری تازه ساخته شد', [n(f.count) !== null ? `تعداد: ${num(f.count)}` : '', 'کدهای قبلی باطل شد.'], { important: true })]
    case K.RECOVERY_CODES_REVOKED: return [h.event(row, '🆘 کدهای بازیابی توقف اضطراری باطل شد', [], { important: true })]
    case K.RECOVERY_CODE_USED: return [h.event(row, `🆘 توقف اضطراری کامل با کد بازیابی${n(f.number) !== null ? ` شمارهٔ ${num(f.number)}` : ''} پشت رایانه برداشته شد`, ['اگر شما نبودید، همین حالا کدهای بازیابی را باطل کنید.'], { important: true })]
    case K.REMOTE_GRANT_OPENED: {
      // دفتر آزمون ۴-۳۰: نوع (برچسب ثابت `decision`) و زمان؛ ردیف قدیمی بی نوع همان دو خط قبلی را دارد. ۴-۳۱: کار قابل تکرار با دفعات.
      const kind = (Object.keys(LOCK_KIND_TITLES) as LockKind[]).find((k) => LOCK_KIND_TITLES[k] === label) ?? null
      const times = kind === 'action' && (n(f.count) ?? 0) > 1 ? n(f.count) : null
      const span = times !== null ? '' : kind === 'action' ? 'یک بار' : kind && n(f.minutes) !== null ? `${num(f.minutes)} دقیقه` : ''
      return [h.event(row, '📱 مجوز راه دور باز شد', [where, kind ? `${LOCK_KIND_SIGNS[kind]} نوع: ${times !== null ? 'کار یک‌بارهٔ قابل تکرار' : label}` : '', span ? `⏱ زمان: ${span}` : '',
        times !== null ? `🔢 دفعات: ${num(times)} بار${n(f.minutes) !== null ? ` (تا ${num(f.minutes)} دقیقه)` : ''}` : '', by], { important: true })]
    }
    // دفتر آزمون ۴-۳۱: هر بار استفاده از مجوز چندبارهٔ کار، و تغییر تنظیم تکرار
    case K.REPEAT_GRANT_USED: return [h.event(row, `🔁 ${lock || 'کار قابل تکرار'} · بار ${num(f.number)} از ${num(f.count)}`, [[lock ? `قفل: ${lock}` : '', n(f.windowNo) !== null ? `پنجرهٔ ${num(f.windowNo)}` : ''].filter(Boolean).join(' · ')], { important: true })]
    case K.REPEAT_SETTINGS_CHANGED: return [h.event(row, '⚙️ کارهای قابل تکرار عوض شد', [n(f.number) !== null ? `حداکثر دفعات هر مجوز: ${num(f.number)} بار` : '', n(f.count) !== null ? `کارهای قابل تکرار: ${num(f.count)} کار` : '', by], { important: true })]
    case K.REMOTE_GRANT_CLOSED: return [h.event(row, '📱 مجوز راه دور بسته شد', [where, label ? `به دست: ${label}` : '', by])]
    case K.SCHEDULED_GRANT_CREATED: return [h.event(row, '🗓️ مجوز زمان‌بندی‌شده ساخته شد', [where, label ? `بازه: ${label}` : '', (n(f.count) ?? 0) > 1 ? `روز: هر روز همین ساعت، ${num(f.count)} روز` : '', custodian, by], { important: true })]
    case K.SCHEDULED_GRANT_CANCELED:
      if (label === 'ساعت سیستم عوض شد') return [h.event(row, '⚠️ ساعت سیستم عوض شد؛ مجوزهای زمان‌بندی‌شده لغو شد', [where], { important: true })]
      return [h.event(row, '🗓️ مجوز زمان‌بندی‌شده لغو شد', [where, label ? `دلیل: ${label}` : '', custodian, by])]
    case K.SCHEDULED_GRANT_OPENED: return [h.event(row, '🗓️ مجوز زمان‌بندی‌شده باز شد', [where, label, custodian, until])]
    case K.SCHEDULED_GRANT_CLOSED: return [h.event(row, '🗓️ مجوز زمان‌بندی‌شده بسته شد', [where, label, custodian])]
    case K.DURATIONS_CHANGED: return [h.event(row, '⚙️ مدت مجوزها و کدها عوض شد', [lock ? `${lock}: ${n(f.minutes) !== null ? `${num(f.minutes)} دقیقه` : ''}` : (n(f.minutes) !== null ? `${num(f.minutes)} دقیقه` : ''), by], { important: true })]
    // تأیید، رد و «بستن همه» با دکمهٔ ربات را خود موتور پیام‌رسان همان لحظه به همهٔ گیرنده‌ها خبر می‌دهد.
    case K.BOT_DECISION: return []
    default: return []
  }
}

function custodyPayload(ev: Pick<CustodyEventLite, 'payloadJson'>): Record<string, unknown> {
  try { const p = ev.payloadJson ? JSON.parse(ev.payloadJson) : null; if (p && typeof p === 'object' && !Array.isArray(p)) return p } catch {}
  return {}
}
/** شناسهٔ مرز تجمیعی بستن نهایی (برای خواندن دسته‌ای عددهایش در `messengerDb`). */
export function custodyBoundaryId(ev: Pick<CustodyEventLite, 'type' | 'payloadJson'>): number | null {
  return ev.type === 'FINAL_AGGREGATE_CLOSE' ? intId(custodyPayload(ev).aggregateBoundaryId) : null
}
/** دفتر آزمون ۴-۱۹ — مسئول صندوقِ بایگانی‌شده (فقط شناسه؛ «دلیل» متن آزاد است و خوانده نمی‌شود). */
export function custodyTargetUserId(ev: Pick<CustodyEventLite, 'type' | 'payloadJson'>): number | null {
  return ev.type === 'CUSTODIAN_ARCHIVED_UNRESOLVED' ? intId(custodyPayload(ev).targetUserId) : null
}
/** دفتر آزمون ۴-۱۹ — بستنی که بیش از این پس از زمان ثبت‌شده‌اش انجام شد، با روشن شدن برنامه انجام شده است
 *  (وقتی برنامه باز است، وضعیت صندوق هر ۳۰ تا ۶۰ ثانیه خوانده و بستن همان لحظه انجام می‌شود). */
const LATE_ROLLOVER_MS = 10 * 60_000
const NOT_MEASURED = 'سنجیده نشد؛ این نشست بی شمارش جمع کشو و کارت‌خوان شروع شده بود، پس مرجعی برای سنجش نبود'
/**
 * عددهای بستن نهایی تجمیعی، عیناً از مرز ثبت‌شده (طرح §۲۱ بند ۴: سند تکمیل‌شده پیام کامل دارد).
 * `diff` فقط وقتی عدد است که مغایرت واقعاً سنجیده شده باشد.
 */
function aggregateCloseLines(b: AggregateBoundaryLite | undefined, payload: Record<string, unknown>): { lines: string[]; diff: number | null } {
  if (!b) return { lines: ['شمرده و مرجع: ثبت نشده'], diff: null }
  const counted = `شمرده (کشو + کارت‌خوان): ${rialOrMissing(b.observedOperationalTotal)}`
  if (b.baselineSource === 'ADOPTION') {
    const movement = n(payload.unreconciledSegmentMovement)
    return { lines: [counted, `مغایرت: ${NOT_MEASURED}`, movement !== null ? `گردش نقد و کارت‌خوان این نشست: ${rial(movement)}` : ''], diff: null }
  }
  const diff = n(b.newDifference)
  const lines = [`${counted} · مرجع: ${rialOrMissing(b.operationalExpectedTotal)}`, `مغایرت: ${differenceText(diff)}`]
  const operational = n(b.operationalExpectedTotal), theoretical = n(b.theoreticalExpectedTotal)
  if (theoretical !== null && operational !== null && theoretical !== operational)
    lines.push(`مرجع کل دوره (نظری مدیر): ${rial(theoretical)} · اختلاف کل دوره: ${differenceText(n(b.totalTheoreticalDifference))}`)
  return { lines, diff }
}
/** پوشش اضطراری و Master Override: عددهای خود رویداد (در حالت شمارش پایه، مرجعی نیست). */
function coverLines(payload: Record<string, unknown>): string[] {
  if (payload.aggregateBootstrap === true) return [`شمرده: ${rialOrMissing(payload.countedCash)}`, `مغایرت: ${NOT_MEASURED}`]
  return [`شمرده: ${rialOrMissing(payload.countedCash)} · مرجع: ${rialOrMissing(payload.expectedCash)} · مغایرت: ${differenceText(n(payload.differenceCash))}`]
}

/** رویدادهای حضانت از جدول خودشان (طرح §۲۱ بند ۴). */
export function custodyEventToEvents(ev: CustodyEventLite, ctx: EventContext): MessengerEvent[] {
  const payload = custodyPayload(ev)
  // یک بستن، یک پیام: بستن‌های حضانت `CASH_CLOSE` هم می‌نویسند و همان پیام کافی است.
  if (intId(payload.cashSessionId)) return []
  const at = toMs(ev.at)
  const who = (id: number | null | undefined): string => (id ? ctx.data.users.get(id) ?? `کاربر ${num(id)}` : 'نامشخص')
  const make = (title: string, lines: string[], flags: { important?: boolean } = {}): MessengerEvent[] => [{
    code: `E-${ev.id}`, at, title: `${title} · ${fmtAt(at, ctx.offsetHours)}`, lines: lines.filter(Boolean),
    important: !!flags.important, handover: true, system: false, day: officialDay(at, ctx.offsetHours)
  }]
  const handover = ev.handoverId ? ctx.data.handovers.get(ev.handoverId) : undefined
  const shift = ev.shiftId ? ctx.data.shifts.get(ev.shiftId)?.name : undefined
  const custodianOf = (): number | null => (ev.shiftId ? ctx.data.shifts.get(ev.shiftId)?.userId ?? null : null)
  /** دفتر آزمون ۴-۲۷: پایان برنامهٔ ذخیره‌شدهٔ یک بخش */
  const segmentEnd = (shiftId: number | null | undefined): number | null => (shiftId ? ctx.data.segments?.get(shiftId)?.scheduledEndAt ?? null : null)
  switch (ev.type) {
    case 'OPEN': return make('🔓 افتتاح صندوق (حضانت)', [`مسئول صندوق: ${who(ev.actorUserId)}`, shift ? `شیفت: ${shift}` : ''])
    case 'HANDOVER_START': return make('⏳ تحویل صندوق شروع شد', [`تحویل‌دهنده: ${who(handover?.fromUserId ?? ev.actorUserId)}`, 'منتظر شمارش تحویل‌گیرنده'])
    case 'HANDOVER_DIFFERENCE_PENDING':
    case 'HANDOVER_RECOUNT_FREEZE': return make('⏳ تحویل صندوق در انتظار شمارش دوباره', [`تحویل‌دهنده: ${who(handover?.fromUserId ?? ev.actorUserId)}`])
    case 'HANDOVER_ACCEPT':
    case 'HANDOVER_ACCEPT_WITH_DIFFERENCE': {
      const diff = n(handover?.differenceCash)
      const gap = shiftEndGap(at, segmentEnd(handover?.fromShiftId)) // دفتر آزمون ۴-۲۷: نسبت به پایان شیفت تحویل‌دهنده
      return make('🔁 تحویل صندوق · تکمیل‌شده', [
        `تحویل‌دهنده: ${who(handover?.fromUserId)} · شمرده: ${rialOrMissing(handover?.countedAtStart)} · مرجع: ${rialOrMissing(handover?.expectedAtStart)} · مغایرت: ${differenceText(diff)}`,
        `تحویل‌گیرنده: ${who(handover?.receiverUserId ?? ev.actorUserId)}`,
        gap ? `زمان تحویل: ${gap}` : ''
      ], { important: diff !== null && diff !== 0 })
    }
    case 'HANDOVER_CANCEL':
    case 'HANDOVER_DIFFERENCE_FROZEN_CANCELED':
      return make('✖️ تحویل صندوق لغو شد', [`تحویل‌دهنده: ${who(handover?.fromUserId ?? ev.actorUserId)} · شمرده: ${rialOrMissing(handover?.countedAtStart)}`])
    case 'HANDOVER_RECOUNT_ABORTED': return make('✖️ شمارش دوبارهٔ تحویل نیمه‌کاره ماند', [`کاربر: ${who(ev.actorUserId)}`], { important: true })
    case 'EMERGENCY_COVER_FREEZE': return make('🚨 پوشش اضطراری صندوق شروع شد', [`کاربر: ${who(ev.actorUserId)}`])
    case 'EMERGENCY_COVER_COMPLETED': return make('🚨 پوشش اضطراری صندوق انجام شد', [`کاربر: ${who(ev.actorUserId)}`, ev.managerUserId ? `مدیر: ${who(ev.managerUserId)}` : '', ...coverLines(payload)], { important: true })
    case 'EMERGENCY_COVER_ABORTED': return make('🚨 پوشش اضطراری صندوق نیمه‌کاره ماند', [`کاربر: ${who(ev.actorUserId)}`], { important: true })
    case 'MASTER_OVERRIDE_FREEZE': return make('🛡️ Master Override شروع شد', [`کاربر: ${who(ev.actorUserId)}`])
    case 'MASTER_OVERRIDE_COMPLETED': return make('🛡️ Master Override انجام شد', [`مدیر: ${who(ev.managerUserId ?? ev.actorUserId)}`, ...coverLines(payload)], { important: true })
    case 'MASTER_OVERRIDE_ABORTED': return make('🛡️ Master Override نیمه‌کاره ماند', [`کاربر: ${who(ev.actorUserId)}`], { important: true })
    case 'ROLLOVER_UNRESOLVED': {
      // دفتر آزمون ۴-۱۹ — مسئول همان کسی است که صندوق دستش بود (کاربر نشست)؛ زمان بستن همان که برنامه ثبت کرد.
      const effectiveAt = typeof payload.effectiveAt === 'string' ? Date.parse(payload.effectiveAt) : NaN
      return make('⚠️ صندوق بسته نشد و به روز بعد رفت', [
        shift ? `شیفت: ${shift}` : '',
        `مسئول صندوق: ${who(custodianOf())}`,
        Number.isFinite(effectiveAt) ? `زمان بستن خودکار: ${fmtAt(effectiveAt, ctx.offsetHours)}` : '',
        Number.isFinite(effectiveAt) && at - effectiveAt > LATE_ROLLOVER_MS ? 'برنامه در آن ساعت خاموش بود؛ بستن با روشن شدن انجام شد' : ''
      ], { important: true })
    }
    case 'CUSTODIAN_ARCHIVED_UNRESOLVED':
      return make('⚠️ مسئول صندوق بایگانی شد و صندوقش بسته نشده است', [shift ? `شیفت: ${shift}` : '', `مسئول صندوق: ${who(custodyTargetUserId(ev) ?? custodianOf())}`], { important: true })
    case 'FINAL_AGGREGATE_CLOSE': {
      const boundaryId = intId(payload.aggregateBoundaryId)
      const { lines, diff } = aggregateCloseLines(boundaryId ? ctx.data.boundaries?.get(boundaryId) : undefined, payload)
      const gap = shiftEndGap(at, segmentEnd(ev.shiftId)) // دفتر آزمون ۴-۲۷
      const out = make('🔁 بستن نهایی صندوق تجمیعی (حضانت)', [`کاربر: ${who(ev.actorUserId)}`, ...lines, gap ? `زمان بستن: ${gap}` : ''], { important: diff !== null && diff !== 0 })
      // طرح §۲۵-۴ بند «د»: همان آستانهٔ «سقف مجاز مغایرت صندوق» که برای بستن صندوق عادی هست.
      if (diff !== null && ctx.threshold > 0 && Math.abs(diff) > ctx.threshold) {
        out.push({
          code: `E-${ev.id}-D`, at, title: `🚨 مغایرت بزرگ در بستن نهایی صندوق تجمیعی · ${fmtAt(at, ctx.offsetHours)}`,
          lines: [`مغایرت: ${differenceText(diff)}`, `سقف مجاز مغایرت: ${rial(ctx.threshold)}`, `کاربر: ${who(ev.actorUserId)}`],
          important: true, handover: true, system: true, day: officialDay(at, ctx.offsetHours)
        })
      }
      return out
    }
    case 'FINAL_AGGREGATE_CLOSE_ABORTED': return make('✖️ بستن نهایی صندوق تجمیعی نیمه‌کاره ماند', [`کاربر: ${who(ev.actorUserId)}`], { important: true })
    default: return []
  }
}

/** شمارش‌هایی که خودشان بخشی از یک بستن صندوق‌اند؛ مغایرتشان در پیام همان بستن می‌آید. */
const CLOSE_COUNT_KINDS: ReadonlySet<string> = new Set(['CLOSING', 'MORNING_WITNESS', 'ARCHIVED_CUSTODIAN_WITNESS', 'HANDOVER_RECOUNT_DIFFERENCE_PENDING', 'OPENING'])

/** هشدار مغایرت بزرگ حضانت (طرح §۲۵-۴ بند «د»): فقط عدد ثبت‌شده، با همان آستانه. */
export function custodyCountToEvents(count: CustodyCountLite, ctx: EventContext): MessengerEvent[] {
  if (CLOSE_COUNT_KINDS.has(count.kind)) return []
  const diff = n(count.differenceCash)
  if (diff === null || ctx.threshold <= 0 || Math.abs(diff) <= ctx.threshold) return []
  const at = toMs(count.at)
  const who = count.countedByUserId ? ctx.data.users.get(count.countedByUserId) ?? `کاربر ${num(count.countedByUserId)}` : 'نامشخص'
  return [{
    code: `K-${count.id}`, at, title: `🚨 مغایرت بزرگ در شمارش صندوق (حضانت) · ${fmtAt(at, ctx.offsetHours)}`,
    lines: [`شمارنده: ${who}`, `شمرده: ${rialOrMissing(count.countedCash)} · مرجع: ${rialOrMissing(count.expectedCash)} · مغایرت: ${differenceText(diff)}`, `سقف مجاز مغایرت: ${rial(ctx.threshold)}`],
    important: true, handover: true, system: true, day: officialDay(at, ctx.offsetHours)
  }]
}
