import { useLayoutEffect, useRef } from 'react'
import { amountDigits, caretAfterDigits, formatAmountFa, tomanHint } from './amountFormat'

/**
 * دفتر آزمون ۴-۴۰ — کادر مشترک مبلغ (ریال): رقم‌ها هنگام تایپ سه‌تاسه جدا دیده می‌شوند،
 * رقم فارسی و لاتین هر دو پذیرفته است، واحد «ریال» کنار کادر و خط «یعنی … تومان» زیر آن.
 * `value` و `onChange` همان رشتهٔ رقم‌های لاتین امروز است؛ فقط نمایش عوض می‌شود.
 */
export default function AmountInput({
  value,
  onChange,
  className = 'input mt-1 w-full',
  placeholder
}: {
  value: string
  onChange: (digits: string) => void
  className?: string
  placeholder?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const caret = useRef<number | null>(null)
  const shown = formatAmountFa(value)
  useLayoutEffect(() => {
    if (caret.current == null || !ref.current) return
    const pos = caretAfterDigits(shown, caret.current)
    caret.current = null
    ref.current.setSelectionRange(pos, pos)
  }, [shown])
  const hint = tomanHint(value)
  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <input
          ref={ref}
          className={className}
          dir="ltr"
          inputMode="numeric"
          value={shown}
          placeholder={placeholder}
          onChange={(e) => {
            const before = e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length)
            caret.current = amountDigits(before).length
            onChange(amountDigits(e.target.value))
          }}
        />
        <span className="text-xs text-slate-500 shrink-0">ریال</span>
      </span>
      {hint ? <span className="block text-xs text-slate-500 mt-1">{hint}</span> : null}
    </span>
  )
}
