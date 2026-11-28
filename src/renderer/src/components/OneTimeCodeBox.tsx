import { useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits } from '@shared/jalali'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۱۵ و §۳-۷ — «کد یک‌بارمصرف» روی صفحهٔ قفل یک قسمت (`ManagerGate`) و در پنجرهٔ سراسری
 * «باز کردن قفل این کار» (`GateUnlockDialog`).
 *
 *   - دفتر آزمون ۴-۴۵: یک دستهٔ کد؛ هر کد روی همهٔ قسمت‌ها و قفل‌های کار، جز «کلیدسازی» (که این کادر را ندارد).
 *     تصمیم فقط در main است؛ این کادر فقط کد را می‌فرستد.
 *   - قسمت ⇒ برای مدت نوع همان قسمت باز می‌شود (پولی یا سایر؛ همین پنجره)؛ کار ⇒ فقط یک بار.
 *   - رقم فارسی و لاتین یکسان؛ خط تیره و فاصله نادیده گرفته می‌شود. کد `dir="ltr"` و جدا از متن راست‌به‌چپ است.
 *   - دفتر آزمون ۴-۴۳: کد ۸ رقم پیوسته است؛ ورودیِ غیر ۸ رقمی پیام روشن می‌گیرد و شمرده نمی‌شود (تصمیم در main).
 *   - روی قفل خاموش هرگز دیده نمی‌شود (صداکننده‌ها فقط روی قفل روشن نشانش می‌دهند).
 * ===========================================================================
 */
type Redeemed = { kind: 'part' | 'action'; minutes: number; number: number }

export default function OneTimeCodeBox({ target, onDone }: { target: string; onDone?: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { setOpen(false); setCode(''); setMessage(null) }, [target])

  const submit = async () => {
    if (busy || !code.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await call<Redeemed>(CH.locksRedeemCode, { target, code })
      const text = r.kind === 'action'
        ? `این کار یک بار مجاز شد (تا ${faDigits(r.minutes)} دقیقه). دوباره روی دکمهٔ همان کار بزنید.`
        : `این بخش با کد شمارهٔ ${faDigits(r.number)} برای ${faDigits(r.minutes)} دقیقه باز شد.`
      setCode('')
      setMessage({ ok: true, text })
      // نشست‌های main دوباره خوانده می‌شوند تا صفحهٔ قفل همان لحظه باز شود.
      window.dispatchEvent(new Event('mahak-remote-sync'))
      onDone?.(text)
    } catch (e: any) {
      setCode('')
      setMessage({ ok: false, text: e?.message || 'کد پذیرفته نشد.' })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost w-full" onClick={() => setOpen(true)}>
        کد یک‌بارمصرف
      </button>
    )
  }
  return (
    <div className="rounded px-3 py-2 bg-indigo-50 border border-indigo-200 space-y-2" dir="rtl">
      <div className="kbd leading-6">کدی را که مدیر (مثلاً تلفنی) گفته وارد کنید. هر کد فقط یک بار کار می‌کند.</div>
      <div className="flex gap-2 items-center">
        <input
          className="inp w-44 text-center tracking-widest"
          dir="ltr"
          style={{ unicodeBidi: 'isolate' }}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="۸ رقم"
          maxLength={12}
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
        />
        <button type="button" className="btn btn-primary" disabled={busy || !code.trim()} onClick={() => void submit()}>
          {busy ? 'در حال بررسی…' : 'باز کردن با کد'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setOpen(false); setMessage(null) }}>بستن</button>
      </div>
      {message ? (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>
          {message.text}
        </div>
      ) : null}
    </div>
  )
}
