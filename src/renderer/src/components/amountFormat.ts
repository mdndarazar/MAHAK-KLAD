import { faDigits, toLatinDigits } from '@shared/jalali'

/**
 * دفتر آزمون ۴-۴۰ — منطق خالص کادر مبلغ: نمایش با جداکنندهٔ هزارگان هنگام تایپ؛ مقدار همان
 * رشتهٔ رقم‌های لاتین امروز (عدد صحیح ریالی)، پس حساب و شمارش کور دست نمی‌خورد.
 */
const SEP = '٬'

/** ورودی کاربر (رقم فارسی، عربی یا لاتین، با جداکننده یا بی آن) ⇒ فقط رقم لاتین. */
export function amountDigits(raw: string): string {
  return toLatinDigits(String(raw ?? '')).replace(/[^0-9]/g, '')
}

/** «10000000» ⇒ «۱۰٬۰۰۰٬۰۰۰». */
export function formatAmountFa(digits: string): string {
  const d = amountDigits(digits)
  return d === '' ? '' : faDigits(d.replace(/\B(?=(\d{3})+(?!\d))/g, SEP))
}

/** خط کمکی زیر کادر: «یعنی ۷ میلیون تومان» یا «یعنی ۷٬۰۵۰٬۰۰۰ تومان»؛ خالی ⇒ ''. */
export function tomanHint(digits: string): string {
  const d = amountDigits(digits).replace(/^0+(?=\d)/, '')
  if (d === '' || d === '0') return ''
  const rial = BigInt(d)
  const toman = rial / 10n
  const half = rial % 10n
  if (half === 0n && toman % 1_000_000n === 0n) return `یعنی ${faDigits(String(toman / 1_000_000n))} میلیون تومان`
  const whole = formatAmountFa(String(toman))
  return `یعنی ${half === 0n ? whole : `${whole}${faDigits(`٫${half}`)}`} تومان`
}

/** جای مکان‌نما پس از n رقم در متن قالب‌دار (برای حفظ جای تایپ هنگام افزودن جداکننده). */
export function caretAfterDigits(formatted: string, digitCount: number): number {
  if (digitCount <= 0) return 0
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (/[0-9۰-۹]/.test(formatted[i])) seen++
    if (seen === digitCount) return i + 1
  }
  return formatted.length
}
