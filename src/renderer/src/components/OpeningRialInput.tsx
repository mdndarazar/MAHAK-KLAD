import { useLayoutEffect, useRef } from 'react'
import { money, parseRequiredRialAmount } from '@shared/jalali'
import { formatOpeningRialTyping } from '@shared/custodyRialInput'

/** Display formatting only: the server still independently validates the
 * physical count. Invalid input remains visible until corrected, not silently
 * changed to another amount or to zero. */
export function OpeningRialInput({ value, onChange, label, previewLabel = 'شمارش افتتاح' }: { value: string; onChange: (value: string) => void; label: string; previewLabel?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const pendingCursor = useRef<{ value: string; cursor: number } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingCursor.current
    const field = input.current
    if (pending && pending.value === value && field && field === document.activeElement)
      field.setSelectionRange(pending.cursor, pending.cursor)
    pendingCursor.current = null
  }, [value])
  const validAmount = value.trim() ? parseRequiredRialAmount(value) : null
  return <label className="block text-sm">{label}
    <div className="mt-1 flex items-center gap-2">
      <input ref={input} className="input w-full" inputMode="numeric" dir="ltr" value={value}
        onChange={(event) => {
          const formatted = formatOpeningRialTyping(event.target.value, event.target.selectionStart ?? event.target.value.length)
          pendingCursor.current = { value: formatted.text, cursor: formatted.cursor }
          onChange(formatted.text)
        }} placeholder="۰" />
      <span className="whitespace-nowrap font-semibold">ریال</span>
    </div>
    {validAmount !== null ? <small className="block mt-1 text-slate-600" aria-live="polite">{previewLabel}: {money(validAmount)} ریال</small> : null}
  </label>
}
