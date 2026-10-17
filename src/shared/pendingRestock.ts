/**
 * ===========================================================================
 * جلسه ۴۰ · کار ب — «کالای برگشتیِ در انتظار دریافت/تعیین‌تکلیف»: منبعِ
 * *تعریف* و *متن‌ها*.
 *
 * ---------------------------------- مسئله ----------------------------------
 * سند مالیِ برگشت، هیچ شاهدی بر رسید کالا نیست؛ پیش از cutover فقط درخواست‌های
 * کارت‌به‌کارت کالا را معلق نگه می‌داشتند. اکنون هر برگشت/تعویضِ تازه که فروش
 * مرجعش موجودی را کسر کرده، مستقل از روش تسویه تا رسید فیزیکی معلق می‌ماند.
 * دادهٔ تاریخی بدون نشانگر افزایشی همچنان با سیاست خودش خوانده می‌شود.
 *
 * ------------------------------ تعریف رسمی ------------------------------
 *   «معلق برگشتی» =  Σ (qty − restockedQty)  روی اقلامِ برگشت‌هایی که
 *                    `restockPending = true` دارند.
 *
 * دو نکته‌ی سختِ این تعریف:
 *   ۱) منبع حقیقتِ *تعداد*، همان `SaleReturnItem.restockedQty` است. برای پروندهٔ
 *      جدید، فقط دریافت مقداربه‌مقدار و شاهددار آن را افزایش می‌دهد؛ اعلام
 *      مدیر یا حتی شاهد بانک جای شاهد فیزیکی کالا نیست. پروندهٔ قدیمیِ بدون
 *      marker/دفتر حق، رفتار تاریخیِ آزادسازی با تأیید مدیر را حفظ می‌کند.
 *   ۲) منبع حقیقتِ *معلق بودن*، ستون `SaleReturn.restockPending` است و نه
 *      «`restockedQty` صفر است». چون `restockedQty = 0` یک معنای دیگر هم دارد:
 *      «فاکتور اصلی بدون کسر از موجودی بود، پس هیچ‌وقت چیزی برنمی‌گردد». اگر
 *      این دو را یکی می‌گرفتیم، برگشتِ فاکتور عمده‌ی بدون کسر موجودی هم «معلق»
 *      شمرده می‌شد و انبارگردانی یک کسری کاذب می‌ساخت.
 *
 * ------------------------------- چرا اینجا -------------------------------
 * پنج صفحه این عدد را نشان می‌دهند (انبار فروشگاه، گزارشات فروش، انبارگردانی،
 * بستن صندوق، پنل کارت‌به‌کارت). اگر هر کدام متن و فرمول خودش را داشت، اولین
 * اصلاح، پنج عدد و پنج جمله‌ی متفاوت می‌ساخت. پس *محاسبه* و *جمله* هر دو
 * همین‌جا نوشته شده‌اند و همه فقط مصرف‌کننده‌اند.
 *
 * ⚠️ این فایل «قاعده» نمی‌سازد و به دیتابیس دست نمی‌زند: اعمال موجودیِ
 * پروندهٔ جدید در `ReturnGoodsService.receive` است؛ مسیر قدیمی در
 * `PendingRestockService` / `CardTransferService.pay` نگه داشته شده است.
 *
 * ⚠️⚠️ `StockState.PENDING` پروژه (کسر موقت تا تجمیع و انتقال) هیچ ربطی به این
 * ماژول ندارد. اینجا «در انتظار دریافت/تعیین تکلیف» است.
 * ===========================================================================
 */

/** برچسب کوتاه، همان چیزی که روی ستون و نشان (badge) می‌نشیند. */
export const PENDING_RESTOCK_LABEL = 'دریافت کالای برگشتی در انتظار'

/** برچسب ستون «معلق برگشتی» در جدول‌ها. */
export const PENDING_RESTOCK_COLUMN = 'معلق برگشتی (دریافت‌نشده/تعیین‌تکلیف‌نشده)'

/** جمله‌ی ثابتِ توضیحی — در هر پنج صفحه عیناً همین متن دیده می‌شود. */
export const PENDING_RESTOCK_EXPLAINER =
  'این تعداد هنوز با شاهد فیزیکی وارد موجودی قابل‌فروش نشده است. در پرونده‌های جدید، حضور کالا ' +
  'با اسکن/انتخاب و شمارش واقعی ثبت می‌شود؛ اعلام یا حتی تأیید پرداخت بانک جای رسید کالا نیست. ' +
  'برای پرونده‌های قدیمی، رویهٔ آزادسازی تاریخی جداگانه اعمال می‌شود.'

/** جمله‌ی انبارگردانی (بند ۴ خواسته‌ی مالک). */
export const PENDING_RESTOCK_STOCKTAKE_NOTE =
  'موجودی فیزیکیِ مورد انتظار = موجودی قابل‌فروش + معلقِ قدیمیِ دارای فرض حضور فیزیکی. ' +
  'کالای پروندهٔ جدید تا دریافتِ مقدارمحور و شاهددار، فیزیکی حاضر فرض نمی‌شود. ' +
  'ستون معلق، تعداد نیازمند بررسی را جداگانه نشان می‌دهد.'

/** ردیف یک کالای معلق (خواندنی؛ هیچ صفحه‌ای بیرون از پنل قفل‌دار دکمه ندارد). */
export interface PendingRestockItem {
  variantId: number
  name: string
  code: string | null
  /** تعداد معلق همین کالا در همین سند برگشت = qty − restockedQty */
  qty: number
  returnId: number
  /** شماره فیش فاکتور اصلی مشتری */
  receiptNo: number | null
  returnedAtJalali: string
  /** شناسه‌ی درخواست کارت‌به‌کارتِ در انتظار پرداخت (اگر هست) */
  requestId: number | null
  /** مبلغی که مدیر باید کارت‌به‌کارت کند */
  amount: number
  operationKind: string
  /** چند روز از ثبت درخواست گذشته است (یادآوری بر اساس سن) */
  ageDays: number
  /** درخواست مرجع رد/لغو شده ولی کالا هنوز معلق است (حالت نیازمند رسیدگی) */
  canceled: boolean
}

/** جمعِ همه‌ی معلق‌ها، همان شکلی که پنج صفحه مصرف می‌کنند. */
export interface PendingRestockSummary {
  /** جمع تعداد کالای معلق */
  totalQty: number
  /** تعداد اسناد برگشتِ معلق */
  returnCount: number
  /** تعداد کالاهای متمایز */
  variantCount: number
  /** جمع مبلغی که مدیر باید بپردازد */
  pendingAmount: number
  /** سنِ قدیمی‌ترین درخواست معلق (روز) */
  oldestAgeDays: number
  /** ردیف‌های معلق، مرتب بر اساس قدیمی‌ترین */
  items: PendingRestockItem[]
  /** معلق به تفکیک کالا (variantId ⇒ تعداد) — برای صفحه‌ی انبار و انبارگردانی */
  byVariant: Record<number, number>
  /** فقط کالای معلقِ قدیمی که رویهٔ قدیمی حضور فیزیکی‌اش را فرض می‌کرد؛
   * کالای پروندهٔ جدید بدون رسیدِ شاهددار هرگز به انتظار فیزیکی اضافه نمی‌شود. */
  physicalByVariant?: Record<number, number>
  /** تعداد پروندهٔ جدید که حضور فیزیکی آن هنوز اثبات نشده است. */
  unconfirmedQty?: number
  /** ردیف‌هایی که درخواستشان رد/لغو شده ولی کالا هنوز معلق است */
  needsAttentionQty: number
}

export const EMPTY_PENDING_RESTOCK: PendingRestockSummary = {
  totalQty: 0,
  returnCount: 0,
  variantCount: 0,
  pendingAmount: 0,
  oldestAgeDays: 0,
  items: [],
  byVariant: {},
  physicalByVariant: {},
  unconfirmedQty: 0,
  needsAttentionQty: 0
}

const n = (v: unknown): number => {
  const x = Math.round(Number(v) || 0)
  return Number.isFinite(x) ? x : 0
}

/**
 * تعداد معلقِ یک سند برگشت = Σ(qty − restockedQty).
 * هرگز منفی برنمی‌گردد: اگر `restockedQty` به هر دلیلی از `qty` بیشتر بود،
 * سهم آن قلم صفر است (وگرنه یک قلم می‌توانست معلقِ قلم دیگر را پاک کند).
 */
export function pendingQtyOfItems(items: { qty?: number; restockedQty?: number }[] = []): number {
  let sum = 0
  for (const it of items) sum += Math.max(0, n(it.qty) - n(it.restockedQty))
  return sum
}

/** آیا این قلم هنوز معلق است؟ (شمارش مقدار دریافت‌نشده) */
export function itemNeedsRestock(item: { qty?: number; restockedQty?: number }): boolean {
  return n(item.restockedQty) < n(item.qty)
}

/** سن یک درخواست به روز (بر اساس تاریخ ثبت). */
export function ageInDays(from: Date | string | number | null | undefined, now: Date = new Date()): number {
  if (!from) return 0
  const d = from instanceof Date ? from : new Date(from)
  const t = d.getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/**
 * موجودی فیزیکیِ *مورد انتظار* روی قفسه.
 * ورودی دوم فقط معلقِ قدیمی با فرض حضور فیزیکی است؛ معلقِ پروندهٔ جدید
 * بدون شاهد فیزیکی هرگز نباید به این تابع داده شود.
 */
export function expectedPhysicalQty(sellableQty: number, pendingQty: number): number {
  return n(sellableQty) + n(pendingQty)
}

/**
 * جمله‌ی هشدارِ آماده برای پروندهٔ جدید: بدون دریافت شاهددار، حضور
 * فیزیکی کالای برگشتی در فروشگاه فرض نمی‌شود.
 *
 * `digits` را صدازننده می‌دهد (در renderer همان `faDigits`) تا این فایل به
 * هیچ ماژول دیگری وابسته نشود و در تست خالص هم قابل اجرا بماند.
 */
export function pendingRestockLine(
  item: { name: string; qty: number; ageDays?: number },
  digits: (v: string | number) => string = String
): string {
  const age = n(item.ageDays)
  return (
    `${digits(item.qty)} ${item.name} برگشتی در انتظار دریافت/تعیین تکلیف؛ حضور فیزیکی آن بدون شاهد فرض نمی‌شود` +
    (age > 0 ? ` · ${digits(age)} روز از ثبت درخواست گذشته است` : '')
  )
}

/** جمله‌ی خلاصه‌ی بالای هر صفحه (خالی ⇒ null، پس هیچ کادر بی‌محتوایی ساخته نمی‌شود). */
export function pendingRestockHeadline(
  summary: Pick<PendingRestockSummary, 'totalQty' | 'returnCount' | 'pendingAmount' | 'oldestAgeDays'> | null | undefined,
  digits: (v: string | number) => string = String,
  /** جلسه ۴۹: `money(n: number, persian?: boolean)` پروژه فقط عدد می‌گیرد */
  money: (v: number) => string = String
): string | null {
  if (!summary || n(summary.totalQty) <= 0) return null
  return (
    `${digits(summary.totalQty)} قلم کالای برگشتی در ${digits(summary.returnCount)} سند، ` +
    `در انتظار دریافت یا تعیین تکلیف کالا (درخواست‌های پرداختِ هنوز باز: ${money(summary.pendingAmount)} ریال). ` +
    PENDING_RESTOCK_EXPLAINER +
    (n(summary.oldestAgeDays) > 0
      ? ` قدیمی‌ترین درخواست ${digits(summary.oldestAgeDays)} روز پیش ثبت شده است.`
      : '')
  )
}

/**
 * یادآوری بر اساس *سن* درخواست (خواسته‌ی «چند روز مانده»).
 * سه پله، عمداً ساده و بدون تنظیمات جدید: پروژه برای هر عدد جادویی یک صفحه‌ی
 * تنظیمات می‌خواهد و این یکی ارزشش را ندارد؛ متن خودش عدد روز را می‌گوید.
 */
export const PENDING_RESTOCK_WARN_DAYS = 3
export const PENDING_RESTOCK_ALERT_DAYS = 7

export type PendingRestockTone = 'none' | 'info' | 'warn' | 'alert'

export function pendingRestockTone(oldestAgeDays: number, totalQty = 1): PendingRestockTone {
  if (n(totalQty) <= 0) return 'none'
  const d = n(oldestAgeDays)
  if (d >= PENDING_RESTOCK_ALERT_DAYS) return 'alert'
  if (d >= PENDING_RESTOCK_WARN_DAYS) return 'warn'
  return 'info'
}

/** متن یادآوری بستن صندوق/شیفت (فقط هشدار؛ روی هیچ عددی اثر ندارد). */
export function pendingRestockShiftWarning(
  summary: Pick<PendingRestockSummary, 'totalQty' | 'returnCount' | 'oldestAgeDays'> | null | undefined,
  digits: (v: string | number) => string = String
): string | null {
  if (!summary || n(summary.totalQty) <= 0) return null
  const d = n(summary.oldestAgeDays)
  return (
    `${digits(summary.totalQty)} قلم کالای برگشتی در انتظار دریافت/تعیین تکلیف باقی مانده است` +
    (d >= PENDING_RESTOCK_ALERT_DAYS
      ? ` و قدیمی‌ترینش ${digits(d)} روز است — رسیدگی‌اش عقب افتاده.`
      : d >= PENDING_RESTOCK_WARN_DAYS
        ? ` (قدیمی‌ترین: ${digits(d)} روز).`
        : '.') +
    ' این مبلغ و این کالا هیچ اثری روی کسری/اضافی صندوق ندارند: نه پولی از کشو ' +
    'بیرون رفته و نه کالا در موجودی قابل‌فروش نشسته.'
  )
}

/** متن درخواستِ جدید: تا رسید مقداربه‌مقدار، نه فروش‌پذیر است نه فیزیکی فرض می‌شود. */
export function pendingStockNote(qty: number, digits: (v: string | number) => string = String): string {
  return `${digits(qty)} عدد کالای برگشتی هنوز با شاهد دریافت نشده و به موجودی قابل‌فروش اضافه نشده است؛ حضور فیزیکی بدون اسکن/انتخاب و شمارش واقعی فرض نمی‌شود. پرداخت بانک مستقل است.`
}

export function releasedStockNote(qty: number, digits: (v: string | number) => string = String): string {
  return `${digits(qty)} عدد کالای برگشتی با تأیید پرداخت مدیر به موجودی قابل‌فروش برگشت`
}
