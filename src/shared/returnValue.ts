/**
 * ===========================================================================
 * نشست ۲ زنجیره رفع — خوشه C / C1 · «ارزش برگشت = سهم واقعی مشتری از پرداخت»
 *
 * تصمیم مالک بند ۴-۱۱ و ۴-۱۷: مبلغ برگشت از snapshot فاکتور حساب می‌شود، نه از
 * `unitPrice × qty` خام:
 *   قیمت قلم − تخفیف قلم (+ مالیات قلم)   ← همان `lineTotal` ذخیره‌شده
 *   − سهم نسبی تخفیف کل فاکتور
 *   + سهم نسبی مالیات/حق سرویس سطح فاکتور
 * هزینه‌ی ارسال (deliveryFee) خدمتی است که مصرف شده و در ارزش کالا نمی‌آید
 * (DECISIONS.md، تصمیم S57-1).
 *
 * ترتیب محاسبه طبق بند ۵: تخصیص دقیق ریالی ← یک رُند ← reconcile با جمع کل
 * (روش بزرگ‌ترین باقی‌مانده) تا جمع سهم‌ها دقیقاً برابر «پرداختنی کالا» شود.
 * برای برگشت جزئی، سهم تجمعی حساب می‌شود تا جمع چند برگشت جزئی روی یک قلم
 * دقیقاً برابر سهم کل آن قلم شود (هیچ ریالی گم یا اضافه نمی‌شود).
 *
 * این فایل خالص است (بدون دیتابیس) و هم main و هم صفحه‌ی برگشت از آن استفاده
 * می‌کنند تا عددی که فروشنده می‌بیند همان عددی باشد که ثبت می‌شود.
 * ===========================================================================
 */

/** رُند ریاضی معمولی (بند ۴-۴۳): زیر ۰٫۵ پایین، ۰٫۵ و بالاتر بالا. */
export function roundRial(x: number): number {
  if (!Number.isFinite(x)) return 0
  return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5)
}

/**
 * نشست ۱۸۱ — ورودی محاسبه است، نه خروجی نمایش: ردیف Prisma (که حالا `bigint`
 * می‌دهد) باید بدون تبدیل دستی در هر صدازننده پذیرفته شود. همه‌ی مقادیر داخل
 * این فایل از `Number(...)`/`Math.round(...)` عبور می‌کنند و خروجی `number` است.
 */
type RialIn = number | bigint

function rialBigInt(value: RialIn | null | undefined): bigint {
  if (value == null) return 0n
  if (typeof value === 'bigint') return value
  if (!Number.isSafeInteger(value)) throw new RangeError('Return-value Rial snapshot is not a safe integer')
  return BigInt(value)
}

function safeRialNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Return-value Rial snapshot exceeds Number.MAX_SAFE_INTEGER')
  return Number(value)
}

export interface InvoiceForReturnValue {
  grandTotal?: RialIn | null
  deliveryFee?: RialIn | null
  items: { id: number; qty: number; unitPrice: RialIn; lineTotal?: RialIn | null; discount?: RialIn | null; tax?: RialIn | null }[]
}

/** «پرداختنی کالا» = جمع کل فاکتور منهای هزینه‌ی ارسال (هرگز منفی نیست). */
export function goodsPayableOf(inv: InvoiceForReturnValue): number {
  const grandTotal = rialBigInt(inv.grandTotal)
  const deliveryFee = rialBigInt(inv.deliveryFee)
  const goods = grandTotal - (deliveryFee > 0n ? deliveryFee : 0n)
  return goods > 0n ? safeRialNumber(goods) : 0
}

/** snapshot خالص قلم؛ اگر ردیف قدیمی lineTotal نداشت از اجزایش ساخته می‌شود. */
function lineBaseOf(it: InvoiceForReturnValue['items'][number]): bigint {
  if (!Number.isSafeInteger(it.qty) || it.qty < 0)
    throw new RangeError('Return-value item quantity snapshot is invalid')
  const raw = it.lineTotal != null
    ? rialBigInt(it.lineTotal)
    : rialBigInt(it.unitPrice) * BigInt(it.qty) - rialBigInt(it.discount) + rialBigInt(it.tax)
  return raw > 0n ? raw : 0n
}

/**
 * سهم هر قلم فاکتور از «پرداختنی کالا» (کل قلم، همه‌ی تعدادها).
 * جمع مقادیر برگشتی دقیقاً برابر `goodsPayableOf(inv)` است. تمام حاصل‌ضرب‌ها
 * و باقیمانده‌ها BigInt هستند تا snapshot بزرگ، ترتیب ریال را با float عوض نکند.
 */
export function allocateLineNet(inv: InvoiceForReturnValue): Map<number, number> {
  const out = new Map<number, number>()
  const seen = new Set<number>()
  const bases = inv.items.map((it) => {
    if (!Number.isSafeInteger(it.id) || it.id <= 0 || seen.has(it.id))
      throw new RangeError('Return-value item identity snapshot is invalid')
    seen.add(it.id)
    return { id: it.id, base: lineBaseOf(it) }
  })
  const sumBase = bases.reduce((sum, base) => sum + base.base, 0n)
  const target = goodsPayableOf(inv)
  if (sumBase <= 0n || target <= 0) {
    for (const base of bases) out.set(base.id, 0)
    return out
  }

  // تخصیص دقیق، سپس floor، سپس بزرگ‌ترین باقیمانده تا جمع = target
  const targetBig = BigInt(target)
  const parts = bases.map((base) => {
    const numerator = targetBig * base.base
    const floor = numerator / sumBase
    const remainder = numerator % sumBase
    return { id: base.id, floor, remainder }
  })
  let left = targetBig - parts.reduce((sum, part) => sum + part.floor, 0n)
  const order = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1)
  for (const part of order) {
    if (left <= 0n) break
    part.floor += 1n
    left -= 1n
  }
  if (left !== 0n) throw new RangeError('Return-value line allocation did not reconcile')
  for (const part of parts) out.set(part.id, safeRialNumber(part.floor))
  return out
}

/**
 * ارزش برگشت `qty` عدد از یک قلم، وقتی `prevReturnedQty` عدد از قبل برگشت خورده.
 * سهم تجمعی ⇒ جمع برگشت‌های جزئی = سهم کل قلم.
 */
function roundRatioHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('INVALID_RETURN_VALUE_DENOMINATOR')
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n)
  return negative ? -rounded : rounded
}

export function returnValueOf(lineNet: number, soldQty: number, prevReturnedQty: number, qty: number): number {
  const sold = Math.max(0, Math.round(soldQty))
  if (sold <= 0 || qty <= 0) return 0
  const prev = Math.min(sold, Math.max(0, Math.round(prevReturnedQty)))
  const take = Math.round(qty)
  const upto = Math.min(sold, prev + take)
  if ([lineNet, sold, prev, take, upto].every(Number.isSafeInteger)) {
    const net = BigInt(lineNet)
    const denominator = BigInt(sold)
    const before = roundRatioHalfUp(net * BigInt(prev), denominator)
    const after = roundRatioHalfUp(net * BigInt(upto), denominator)
    return Number(after - before)
  }
  // Preserve legacy display behavior for non-integral/non-finite callers.
  // Persisted Rial snapshots and quantities take the exact BigInt path above.
  return roundRial((lineNet * upto) / sold) - roundRial((lineNet * prev) / sold)
}

/**
 * مبلغ «کامل، بدون کسر تخفیف» برای override مدیر.
 *
 * unitPrice و tax هر دو snapshot قلم‌اند؛ مالیات/عوارض قلم حفظ می‌شود، اما
 * تخفیف قلم و سهم تخفیف کل فاکتور عمداً وارد این عدد نمی‌شوند. تخصیص تعداد
 * جزئی با همان قاعده‌ی رند واحد انجام می‌شود تا چند برگشت ریالی روی هم دقیقاً
 * به قیمت کامل همان قلم برسند.
 */
export function returnListPriceOf(unitPrice: number, tax: number, soldQty: number, qty: number): number {
  const sold = Math.max(0, Math.round(soldQty))
  const take = Math.min(sold, Math.max(0, Math.round(qty)))
  if (sold <= 0 || take <= 0) return 0
  return roundRial(Number(unitPrice || 0) * take + (Number(tax || 0) * take) / sold)
}

/**
 * C5 — تجمیع ردیف‌های تکراری یک `saleItemId` *قبل* از اعتبارسنجی. بدون این،
 * دو ردیف qty=۱ روی قلمی که فقط ۱ عدد فروخته شده جدا جدا از سقف رد می‌شدند و
 * ۲ عدد برگشت می‌خورد.
 */
export function mergeReturnTargets<T extends { saleItemId: number; qty: number }>(targets: T[]): { saleItemId: number; qty: number }[] {
  const m = new Map<number, number>()
  for (const t of targets) {
    const id = Number(t.saleItemId)
    const q = Number(t.qty)
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(q) || q <= 0) continue
    m.set(id, (m.get(id) ?? 0) + q)
  }
  return [...m.entries()].map(([saleItemId, qty]) => ({ saleItemId, qty }))
}

/** C7 — وضعیت‌هایی که برگشت رویشان کاملاً ممنوع است (بند ۴-۲۰). */
export const NON_RETURNABLE_STATUSES = ['DRAFT', 'CANCELED'] as const
export function isReturnableStatus(status: string | null | undefined): boolean {
  return !NON_RETURNABLE_STATUSES.includes(String(status ?? '') as any)
}
