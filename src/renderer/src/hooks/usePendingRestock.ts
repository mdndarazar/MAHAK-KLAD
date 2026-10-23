import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, money } from '@shared/jalali'
import {
  EMPTY_PENDING_RESTOCK,
  pendingRestockHeadline,
  pendingRestockShiftWarning,
  pendingRestockTone,
  type PendingRestockItem,
  type PendingRestockSummary,
  type PendingRestockTone
} from '@shared/pendingRestock'

/**
 * ===========================================================================
 * جلسه ۴۳ · کار ب — تنها نقطه‌ی *خواندنِ* «معلق برگشتی» در رندرر.
 *
 * چهار صفحه‌ی نمایشی (`Products`، `SalesReports`، `Stocktake`، `CashClose`) و
 * پنل قفل‌دار مدیر همه یک عدد را نشان می‌دهند. اگر هر صفحه خودش
 * `call(CH.pendingRestockSummary)` می‌زد و خودش جمع می‌بست، اولین اصلاح چهار
 * عدد و چهار جمله‌ی متفاوت می‌ساخت — دقیقاً همان چیزی که `@shared/pendingRestock`
 * برای جلوگیری از آن نوشته شد. پس:
 *
 *   • *محاسبه و متن*  ⇒  `@shared/pendingRestock` (مشترک با main)
 *   • *اعمال*         ⇒  `CardTransferService.pay` برای C2C؛ `ReturnGoodsService.receive`
 *                       فقط برای پرونده‌های قدیمیِ علامت‌خورده
 *   • *خواندن در UI*  ⇒  همین هوک، و هیچ‌جای دیگر
 *
 * سه قاعده‌ی این هوک:
 *   ۱) **فقط خواندنی.** هیچ کانال نویسنده‌ای صدا نمی‌زند و هیچ صفحه‌ای با آن
   *      نمی‌تواند کالا را به موجودی قابل‌فروش برگرداند. روش‌های غیر C2C همان لحظه
 *      آزاد می‌شوند؛ C2C فقط با تأیید پرداخت مدیر و پروندهٔ قدیمی از مسیر خودش.
 *   ۲) **بازه‌ی تاریخ نمی‌گیرد** (عیناً همان تصمیم پنل مدیر در جلسه ۴۲):
 *      کالایی که سه ماه پیش معلق شده، تا پرداخت مدیر در C2C یا تعیین تکلیف پروندهٔ
 *      قدیمی همچنان پیگیری می‌خواهد؛ فیلتر تاریخ آن را پنهان می‌کرد.
 *   ۳) **هیچ‌وقت صفحه را نمی‌شکند.** اگر کانال خطا داد، عدد صفر می‌ماند و
 *      `error` پر می‌شود؛ نه استثنا بالا می‌رود و نه گزارش میزبان خراب می‌شود.
 *      هیچ عددِ مالیِ هیچ صفحه‌ای به این هوک وابسته نیست (همه‌جا فقط «هشدار»).
 * ===========================================================================
 */

export interface PendingRestockView {
  summary: PendingRestockSummary
  /** جمع کل معلق‌ها — میان‌بر پرکاربرد */
  totalQty: number
  /** رنگ/شدت هشدار بر اساس سن قدیمی‌ترین درخواست */
  tone: PendingRestockTone
  /** جمله‌ی خلاصه‌ی بالای صفحه (اگر معلقی نباشد `null`) */
  headline: string | null
  /** جمله‌ی هشدار بستن صندوق/شیفت (اگر معلقی نباشد `null`) */
  shiftWarning: string | null
  /** معلقِ یک کالا (صفحه‌ی کالاها و انبارگردانی) */
  qtyOfVariant: (variantId: number | null | undefined) => number
  /** کالای فیزیکیِ معلقِ یک واریانت، برای شمارش بدون افزودن به موجودی فروش */
  physicalQtyOfVariant: (variantId: number | null | undefined) => number
  /** معلقِ یک سند برگشت (تب برگشت/تعویض گزارشات) */
  qtyOfReturn: (returnId: number | null | undefined) => number
  /** ردیف‌های معلقِ یک کالا (برای tooltip و جزئیات) */
  itemsOfVariant: (variantId: number | null | undefined) => PendingRestockItem[]
  ready: boolean
  error: string | null
  reload: () => Promise<void>
}

/**
 * @param enabled وقتی `false` است هیچ درخواستی فرستاده نمی‌شود (برای تب‌هایی که
 *        هنوز باز نشده‌اند یا صفحه‌ای که قفلش باز نیست) و همه‌ی عددها صفر می‌مانند.
 */
export function usePendingRestock(enabled = true): PendingRestockView {
  const [summary, setSummary] = useState<PendingRestockSummary>(EMPTY_PENDING_RESTOCK)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) {
      setSummary(EMPTY_PENDING_RESTOCK)
      setReady(true)
      return
    }
    try {
      const res = await call<PendingRestockSummary>(CH.pendingRestockSummary, {})
      setSummary(res ?? EMPTY_PENDING_RESTOCK)
      setError(null)
    } catch (e: any) {
      // صفحه سالم می‌ماند؛ فقط هشدارِ معلق دیده نمی‌شود.
      setSummary(EMPTY_PENDING_RESTOCK)
      setError(e?.message ?? 'خواندن کالای معلق برگشتی ناموفق بود')
    } finally {
      setReady(true)
    }
  }, [enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  const byReturn = useMemo(() => {
    const map: Record<number, number> = {}
    for (const it of summary.items ?? []) map[it.returnId] = (map[it.returnId] ?? 0) + Math.max(0, it.qty)
    return map
  }, [summary])

  const byVariantItems = useMemo(() => {
    const map: Record<number, PendingRestockItem[]> = {}
    for (const it of summary.items ?? []) (map[it.variantId] ??= []).push(it)
    return map
  }, [summary])

  const qtyOfVariant = useCallback(
    (variantId: number | null | undefined): number =>
      variantId == null ? 0 : Math.max(0, Math.round(summary.byVariant?.[variantId] ?? 0)),
    [summary]
  )

  const qtyOfReturn = useCallback(
    (returnId: number | null | undefined): number => (returnId == null ? 0 : Math.max(0, byReturn[returnId] ?? 0)),
    [byReturn]
  )

  const itemsOfVariant = useCallback(
    (variantId: number | null | undefined): PendingRestockItem[] =>
      variantId == null ? [] : byVariantItems[variantId] ?? [],
    [byVariantItems]
  )

  const physicalQtyOfVariant = (variantId: number | null | undefined): number =>
    variantId == null ? 0 : Math.max(0, summary.physicalByVariant?.[variantId] ?? 0)

  return {
    summary,
    physicalQtyOfVariant,
    totalQty: Math.max(0, Math.round(summary.totalQty ?? 0)),
    tone: pendingRestockTone(summary.oldestAgeDays, summary.totalQty),
    headline: pendingRestockHeadline(summary, faDigits, money),
    shiftWarning: pendingRestockShiftWarning(summary, faDigits),
    qtyOfVariant,
    qtyOfReturn,
    itemsOfVariant,
    ready,
    error,
    reload
  }
}

/** کلاس کادر هشدار، هم‌رنگ با `PendingStockBadge` (یک زبان رنگی در همه‌ی صفحه‌ها). */
export function pendingToneBox(tone: PendingRestockTone): string {
  return tone === 'alert'
    ? 'border-rose-500 bg-rose-50 text-rose-900'
    : tone === 'warn'
      ? 'border-amber-500 bg-amber-50 text-amber-900'
      : 'border-sky-400 bg-sky-50 text-sky-900'
}
