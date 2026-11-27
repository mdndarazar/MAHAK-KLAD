import { toLatinDigits } from '@shared/jalali'

/**
 * دفتر آزمون ۴-۳۹ — منطق خالص کادر تاریخ سه‌بخشی (سال، ماه، روز با «/» ثابت).
 * مقدار بیرونی همان رشتهٔ امروز است («yyyy/MM/dd» یا خالی)، پس پرونده‌های صداکننده دست نمی‌خورند.
 */
export const JALALI_PART_LENGTHS = [4, 2, 2] as const
export type JalaliParts = [string, string, string]

/** «1405/06/25» ⇒ ['1405','06','25']؛ خالی ⇒ ['','','']؛ هر بخش فقط رقم لاتین. */
export function splitJalaliParts(value: string | null | undefined): JalaliParts {
  const raw = String(value ?? '').split('/')
  return [0, 1, 2].map((i) => cleanJalaliPart(raw[i] ?? '', i)) as JalaliParts
}

/** ورودی یک بخش: رقم فارسی و عربی ⇒ لاتین؛ هر چیز غیررقم (از جمله «/») حذف؛ حداکثر طول همان بخش. */
export function cleanJalaliPart(raw: string, index: number): string {
  const max = JALALI_PART_LENGTHS[index] ?? 2
  return toLatinDigits(String(raw ?? '')).replace(/[^0-9]/g, '').slice(0, max)
}

/** سه بخش ⇒ مقدار بیرونی؛ همه خالی ⇒ '' (همان «بی تاریخ» امروز). */
export function joinJalaliParts(parts: readonly string[]): string {
  const [y = '', m = '', d = ''] = parts
  return y === '' && m === '' && d === '' ? '' : `${y}/${m}/${d}`
}

/** هنگام ترک ماه یا روز: یک رقم ⇒ دو رقم («9» ⇒ «09»). سال دست نمی‌خورد. */
export function padJalaliPart(part: string, index: number): string {
  return index > 0 && part.length === 1 ? `0${part}` : part
}
