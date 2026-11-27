import { useRef } from 'react'
import { faDigits, isValidJalaliDate } from '@shared/jalali'
import { JALALI_PART_LENGTHS, cleanJalaliPart, joinJalaliParts, padJalaliPart, splitJalaliParts } from './jalaliDateParts'

/**
 * ورودی تاریخ شمسی به‌صورت yyyy/MM/dd.
 * دفتر آزمون ۴-۳۹: سه بخش جدا (سال، ماه، روز) با دو «/» ثابت و دست‌نخوردنی؛ فقط رقم
 * (فارسی هم، پیش از ذخیره لاتین می‌شود)؛ پس از پر شدن هر بخش مکان‌نما خودش به بخش بعد می‌رود.
 * مقدار بیرونی همان رشتهٔ «yyyy/MM/dd» است (پارس و ذخیره در main با jalaliToDateTime/toJalaliDate).
 */
export default function JalaliDateInput({
  value,
  onChange,
  className = 'inp w-36',
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  autoFocus?: boolean
}) {
  const ok = isValidJalaliDate(value)
  const parts = splitJalaliParts(value)
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)]
  const focusPart = (i: number) => {
    const box = refs[i]?.current
    if (box) { box.focus(); box.select() }
  }
  const setPart = (i: number, raw: string) => {
    const next = [...parts]
    next[i] = cleanJalaliPart(raw, i)
    onChange(joinJalaliParts(next))
    if (next[i].length === JALALI_PART_LENGTHS[i] && i < 2) focusPart(i + 1)
  }
  const padOnBlur = (i: number) => {
    const padded = padJalaliPart(parts[i], i)
    if (padded !== parts[i]) {
      const next = [...parts]
      next[i] = padded
      onChange(joinJalaliParts(next))
    }
  }
  const box = (i: number, width: string, label: string) => (
    <input
      ref={refs[i]}
      inputMode="numeric"
      maxLength={JALALI_PART_LENGTHS[i]}
      aria-label={label}
      autoFocus={i === 0 ? autoFocus : undefined}
      className={`${width} bg-transparent text-center outline-none`}
      placeholder={i === 0 ? '1405' : '01'}
      value={parts[i]}
      onChange={(e) => setPart(i, e.target.value)}
      onBlur={() => padOnBlur(i)}
      onKeyDown={(e) => {
        if (e.key === 'Backspace' && parts[i] === '' && i > 0) { e.preventDefault(); focusPart(i - 1) }
      }}
    />
  )
  return (
    <div>
      <div dir="ltr" className={`${className} inline-flex items-center justify-center gap-0.5 ${ok ? '' : 'border-red-400 bg-red-50'}`}>
        {box(0, 'w-12', 'سال')}
        <span className="select-none opacity-60">/</span>
        {box(1, 'w-7', 'ماه')}
        <span className="select-none opacity-60">/</span>
        {box(2, 'w-7', 'روز')}
      </div>
      {!ok && <div className="kbd text-red-600">تاریخ نامعتبر</div>}
      {ok && <div className="kbd">{faDigits(value)}</div>}
    </div>
  )
}
