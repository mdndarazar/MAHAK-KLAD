/**
 * ===========================================================================
 * جلسه ۴۰ · کار ب — «موجودی کالای برگشتیِ معلق»: منبعِ
 * *تعریف* و *متن‌ها*.
 *
 * ---------------------------------- مسئله ----------------------------------
 * برگشت/تعویضِ غیر کارت‌به‌کارت موجودی را همان لحظه تغییر می‌دهد. فقط در
 * کارت‌به‌کارت، کالای برگشتی تا تأیید پرداخت مدیر معلق می‌ماند؛ با تأیید، همان
 * کالا به موجودی برمی‌گردد. این رویداد جای تطبیق بانک نیست و صندوق/کارت‌خوان را
 * تغییر نمی‌دهد. پرونده‌های قدیمیِ معلق با نشانگر خودشان جدا پیگیری می‌شوند.
 *
 * ------------------------------ تعریف رسمی ------------------------------
 *   «معلق برگشتی» =  Σ (qty − restockedQty)  روی اقلامِ برگشت‌هایی که
 *                    `restockPending = true` دارند.
 *
 * دو نکته‌ی سختِ این تعریف:
 *   ۱) منبع حقیقتِ *تعداد*، همان `SaleReturnItem.restockedQty` است. در پروندهٔ
 *      جدیدِ غیر C2C همان ثبت برگشت/تعویض آن را کامل می‌کند؛ در C2C تأیید پرداخت
 *      مدیرِ همان درخواست. پرونده‌های قدیمیِ دارای نشانگر دریافت، مسیر تاریخی
 *      خودشان را حفظ می‌کنند.
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
 * ⚠️ این فایل «قاعده» نمی‌سازد و به دیتابیس دست نمی‌زند: برگشت/تعویض عادی
 * در `SalesService` هم‌زمان موجودی را تغییر می‌دهد؛ آزادسازی C2C در `CardTransferService.pay` است.
 *
 * ⚠️⚠️ `StockState.PENDING` پروژه (کسر موقت تا تجمیع و انتقال) هیچ ربطی به این
 * ماژول ندارد. اینجا «در انتظار تأیید پرداخت یا تعیین تکلیف پروندهٔ قدیمی» است.
 * ===========================================================================
 */

/** برچسب کوتاه، همان چیزی که روی ستون و نشان (badge) می‌نشیند. */
export const PENDING_RESTOCK_LABEL = 'موجودی کالای برگشتیِ معلق'

/** برچسب ستون «معلق برگشتی» در جدول‌ها. */
export const PENDING_RESTOCK_COLUMN = 'معلق برگشتی (تا پرداخت مدیر/تعیین تکلیف پروندهٔ قدیمی)'

/** جمله‌ی ثابتِ توضیحی — در هر پنج صفحه عیناً همین متن دیده می‌شود. */
export const PENDING_RESTOCK_EXPLAINER =
  'این اقلام در پروندهٔ کارت‌به‌کارت تا تأیید پرداخت مدیر معلق‌اند؛ همان تأیید، کالای برگشتیِ همین سند را به موجودی برمی‌گرداند. ' +
  'برگشت/تعویضِ روش‌های دیگر همان لحظه موجودی را به‌روز می‌کند. تطبیق بانک و گردش صندوق/کارت‌خوان جدا می‌مانند.'

/** جمله‌ی انبارگردانی (بند ۴ خواسته‌ی مالک). */
export const PENDING_RESTOCK_STOCKTAKE_NOTE =
  'برگشت/تعویضِ غیر کارت‌به‌کارت همان لحظه در موجودی ثبت می‌شود. ' +
  'کالای C2C تا تأیید پرداخت مدیر در موجودی فروش‌پذیر نمی‌نشیند؛ پرونده‌های قدیمیِ معلق جدا دیده می‌شوند. ' +
  'ستون معلق فقط اقلامی را نشان می‌دهد که هنوز تعیین تکلیف نشده‌اند.'

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
  /** فقط ردیف‌های تاریخی که سیاست قبلی‌شان موجودی فیزیکی را فرض می‌کرد. */
  physicalByVariant?: Record<number, number>
  /** تعداد اقلام جدید C2C که تا تأیید پرداخت مدیر وارد موجودی نشده‌اند. */
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
 * ورودی دوم فقط معلق‌های تاریخی است که سیاست قبلی‌شان حضور فیزیکی را فرض می‌کرد؛
 * کالای C2Cِ پرداخت‌نشده طبق روال جدید هنوز جزو موجودی فروش‌پذیر نیست.
 */
export function expectedPhysicalQty(sellableQty: number, pendingQty: number): number {
  return n(sellableQty) + n(pendingQty)
}

/**
 * جمله‌ی کوتاه برای کالای برگشتیِ معلق؛ در روال جدید عمدتاً C2C منتظر پرداخت مدیر است.
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
    `${digits(item.qty)} ${item.name} برگشتی در انتظار تعیین تکلیف موجودی` +
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
    `در انتظار تأیید پرداخت مدیر یا تعیین تکلیف پروندهٔ قدیمی (درخواست‌های پرداختِ هنوز باز: ${money(summary.pendingAmount)} ریال). ` +
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
    `${digits(summary.totalQty)} قلم موجودی برگشتی تا تأیید پرداخت مدیر یا تعیین تکلیف پروندهٔ قدیمی معلق مانده است` +
    (d >= PENDING_RESTOCK_ALERT_DAYS
      ? ` و قدیمی‌ترینش ${digits(d)} روز است — رسیدگی‌اش عقب افتاده.`
      : d >= PENDING_RESTOCK_WARN_DAYS
        ? ` (قدیمی‌ترین: ${digits(d)} روز).`
        : '.') +
    ' این مبلغ و این کالا هیچ اثری روی کسری/اضافی صندوق ندارند: نه پولی از کشو ' +
    'بیرون رفته و نه کالا در موجودی قابل‌فروش نشسته.'
  )
}

/** متن درخواست C2C: فقط تأیید مدیرِ همان درخواست موجودی را آزاد می‌کند. */
export function pendingStockNote(qty: number, digits: (v: string | number) => string = String): string {
  return `${digits(qty)} عدد کالای برگشتی تا تأیید پرداخت مدیرِ همین درخواست به موجودی قابل‌فروش اضافه نمی‌شود. تطبیق بانک و گردش صندوق/کارت‌خوان جدا می‌مانند.`
}

export function releasedStockNote(qty: number, digits: (v: string | number) => string = String): string {
  return `${digits(qty)} عدد کالای برگشتی به موجودی قابل‌فروش برگشت`
}
