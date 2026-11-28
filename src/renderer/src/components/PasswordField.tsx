import { forwardRef, useEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { GATE_PROOF_MARKER } from '@shared/gateCatalog'
import { useManagerSession } from '../hooks/useManagerSession'

/**
 * ===========================================================================
 * مورد ۲ — «نمایش/مخفی‌کردن رمز با آیکون چشم».
 *
 * یک اینپوت رمز + یک دکمه‌ی چشم 👁 کنارش. با هر کلیک، نوع اینپوت بین
 * `password` و `text` سوییچ می‌شود تا کاربر ببیند چه رمزی تایپ کرده (مثلاً
 * وقتی رمز جدید و تکرارش با هم نمی‌خوانند و معلوم نیست کدام غلط تایپ شده).
 *
 * چرا یک کامپوننت مشترک؟ چون همین اینپوت در ۷ جای برنامه هست (رمز فعلی، رمز
 * جدید، تکرار رمز جدید، رمز مدیر برای تایید قفل ماژول‌ها، رمز مدیر برای تایید
 * رمزهای دوم، رمز دوم هر پنل، و صفحه‌ی ورود رمز `ManagerGate`). با یک
 * کامپوننت، منطق چشم یک بار نوشته می‌شود و همه‌جا یکسان رفتار می‌کند.
 *
 * ⚠️ هیچ چیزی از رفتار قبلی عوض نشده: پیش‌فرض همیشه `password` است (رمز مخفی)،
 * خود اینپوت همان کلاس‌ها/`dir`/`value`/`onChange`/`onKeyDown` قبلی را می‌گیرد
 * و نمایش رمز فقط تا وقتی است که کاربر خودش چشم را باز نگه دارد — هیچ‌جا ذخیره
 * یا به خاطر سپرده نمی‌شود.
 * ===========================================================================
 */
/**
 * طرح ۱۴۰۵ §۳-۶ — «حالت نشست»: با نشست مدیر همین پنجره، کادرِ دست‌نخورده نشانگر غیرراز می‌فرستد (رمز لازم نیست)؛
 * بی نشست، دکمهٔ 🔑 «رمز ندارم» همان نشانگر را می‌فرستد تا دروازه بلیت یک‌بار را مصرف کند یا پنجرهٔ قفل را باز کند.
 * نخستین حرف تایپ‌شده جای نشانگر را می‌گیرد. `typedOnly` (کلیدسازی، ساختن رمز تازه، هویت و هر رازِ غیرِرمز
 * مثل کلید API) هرگز نشانگر و هرگز «رمز ندارم» ندارد.
 */
export type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { typedOnly?: boolean }

/**
 * دفتر آزمون ۴-۳۷: در نشست مدیر، کادرِ «دروازه»ای که نشانگر نشست را دارد اصلاً دیده نمی‌شود: نه خود کادر و دکمهٔ چشم، نه
 * برچسب و توضیحش. دکمه‌ها مثل پیش همان نشانگر را می‌فرستند. برچسب‌ها بی دست زدن به جاهای استفاده با یک قاعدهٔ CSS پنهان
 * می‌شوند: برچسبی که کادر را مستقیم در بر دارد، متنِ سادهٔ درست پیش از کادر (یا پیش از پوستهٔ تنهای کادر)، و پوستهٔ تنها.
 * `typedOnly`، `GateUnlockDialog` و `ManagerGate` همیشه دیده می‌شوند. با «خروج مدیر» همه دوباره پیدا می‌شوند.
 */
export const SESSION_HIDDEN_CLASS = 'pw-session-hidden'
export const SESSION_HIDDEN_CSS = [
  `label:has(> .${SESSION_HIDDEN_CLASS})`,
  `:is(div,span,label,p):not(:has(*)):has(+ .${SESSION_HIDDEN_CLASS})`,
  `:is(div,span,label,p):not(:has(*)):has(+ :is(div,span) > .${SESSION_HIDDEN_CLASS}:only-child)`,
  `:is(div,span):has(> .${SESSION_HIDDEN_CLASS}:only-child)`
].join(',') + '{display:none !important}'
if (typeof document !== 'undefined' && !document.getElementById(`${SESSION_HIDDEN_CLASS}-css`)) {
  const style = document.createElement('style')
  style.id = `${SESSION_HIDDEN_CLASS}-css`
  style.textContent = SESSION_HIDDEN_CSS
  document.head.appendChild(style)
}

const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { className = 'inp text-center', dir = 'ltr', disabled, typedOnly = false, value, onChange, placeholder, ...rest },
  ref
) {
  const [shown, setShown] = useState(false)
  const { isManager } = useManagerSession()
  const gated = !typedOnly && typeof value === 'string' && typeof onChange === 'function'
  const source = useRef<'session' | 'link' | null>(null), touched = useRef(false)
  const emit = (v: string) => onChange?.({ target: { value: v }, currentTarget: { value: v } } as unknown as ChangeEvent<HTMLInputElement>)
  useEffect(() => { touched.current = false }, [isManager])
  useEffect(() => {
    if (!gated) return
    if (isManager && value === '' && !touched.current) { source.current = 'session'; emit(GATE_PROOF_MARKER) }
    else if (!isManager && value === GATE_PROOF_MARKER && source.current === 'session') { source.current = null; emit('') }
  }, [gated, isManager, value]) // eslint-disable-line react-hooks/exhaustive-deps
  const marked = gated && value === GATE_PROOF_MARKER
  const hint = marked ? (isManager ? 'نشست مدیر باز است؛ رمز لازم نیست' : 'بی رمز: کد یک‌بارمصرف یا مجوز') : placeholder
  if (marked && isManager) return <span className={SESSION_HIDDEN_CLASS} hidden aria-hidden="true" />
  return (
    <div className="flex items-stretch gap-1">
      <input ref={ref} type={shown ? 'text' : 'password'} dir={dir} className={`${className} flex-1`} disabled={disabled} {...rest}
        value={value === GATE_PROOF_MARKER ? '' : value} placeholder={hint} title={marked ? hint : rest.title}
        onChange={(e) => { touched.current = true; source.current = null; onChange?.(e) }} />
      {gated && !isManager && !marked && (
        <button type="button" className="btn px-2 shrink-0" tabIndex={-1} disabled={disabled} title="رمز ندارم؛ کد یک‌بارمصرف یا مجوز"
          aria-label="رمز ندارم؛ کد یک‌بارمصرف یا مجوز" onClick={() => { source.current = 'link'; emit(GATE_PROOF_MARKER) }}>🔑</button>
      )}
      <button
        type="button"
        className="btn px-2 shrink-0"
        // با tabIndex={-1} فشردن Tab از اینپوت رمز مستقیم به کنترل بعدی می‌رود
        // (مثل قبل) و روی دکمه‌ی چشم گیر نمی‌کند.
        tabIndex={-1}
        aria-label={shown ? 'مخفی کردن رمز' : 'نمایش رمز'}
        title={shown ? 'مخفی کردن رمز' : 'نمایش رمز وارد‌شده'}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? '🙈' : '👁'}
      </button>
    </div>
  )
})

export default PasswordField
