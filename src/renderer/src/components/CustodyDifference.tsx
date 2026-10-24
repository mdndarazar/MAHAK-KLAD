import { money } from '@shared/jalali'

/** Purely presentational: a sign is evidence of a numerical variance, NOT an
 * assignment of responsibility. Unknown is neither zero nor green. */
export function CustodyDifference({ value, label = 'اختلاف' }: { value: number | null | undefined; label?: string }) {
  if (value == null || !Number.isSafeInteger(value))
    return <span className="font-semibold text-amber-900" aria-label={`${label}: نامعلوم (نه صفر)`}>نامعلوم (نه صفر)</span>
  const meaning = value < 0 ? 'کسری عددی؛ نه حکم تقصیر' : value > 0 ? 'اضافهٔ عددی؛ نه حکم تقصیر' : 'بدون اختلاف عددی'
  const color = value < 0 ? 'text-rose-700' : value > 0 ? 'text-emerald-700' : 'text-slate-700'
  return <span className={`font-semibold ${color}`} aria-label={`${label}: ${meaning}`}>
    <bdi dir="ltr">{money(value)}</bdi> ریال <small>({meaning})</small>
  </span>
}
