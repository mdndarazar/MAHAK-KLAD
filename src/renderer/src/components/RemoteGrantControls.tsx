import { useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toLatinDigits } from '@shared/jalali'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ — دو کار روی صفحهٔ «کنترل از راه دور»:
 *   - §۳-۱۳ (مورد ۷): «مدت مجوز راه دور»، یک عدد ۱ تا ۶۰ دقیقه برای همهٔ قفل‌ها (پیش‌فرض ۱۰). تغییرش «کلیدسازی»
 *     است: رمز تایپی مدیر می‌خواهد (کادر خام، هرگز نشانگر)، در AuditLog می‌نشیند و خبرش به پیام‌رسان می‌رود.
 *     مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود.
 *   - §۳-۱۷: «بستن همهٔ مجوزها و قفل‌های باز» (مجوزهای راه دور، بلیت‌های یک‌بار، قسمت‌های بازشده با کد و مجوز
 *     زمان‌بندی‌شدهٔ باز)؛ رمز نمی‌خواهد، چون فقط می‌بندد. مجوزهای زمان‌بندی‌شدهٔ آینده و خود کدها باطل نمی‌شوند.
 * ===========================================================================
 */
type Durations = { sensitiveCodeMinutes: number; otherCodeMinutes: number; remoteGrantMinutes: number }

export default function RemoteGrantControls() {
  const [current, setCurrent] = useState<number | null>(null)
  const [minutes, setMinutes] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void call<Durations>(CH.lockDurationsGet)
      .then((d) => { setCurrent(d.remoteGrantMinutes); setMinutes(String(d.remoteGrantMinutes)) })
      .catch(() => setCurrent(null))
  }, [])

  const value = Number(toLatinDigits(minutes).trim())
  const valid = Number.isInteger(value) && value >= 1 && value <= 60
  const idle = valid ? Math.min(10, Math.max(3, Math.round(value / 5))) : null

  const save = async () => {
    if (busy || !valid || !password) return
    setBusy(true)
    setMessage(null)
    try {
      const d = await call<Durations>(CH.lockDurationsSet, { managerPassword: password, remoteGrantMinutes: value })
      setCurrent(d.remoteGrantMinutes)
      setMinutes(String(d.remoteGrantMinutes))
      setPassword('')
      setMessage({ ok: true, text: `مدت مجوز راه دور ${faDigits(d.remoteGrantMinutes)} دقیقه شد. مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود.` })
    } catch (e: any) {
      setMessage({ ok: false, text: e?.message || 'ذخیره نشد.' })
    } finally {
      setBusy(false)
    }
  }

  const closeAll = async () => {
    if (busy || !confirm('همهٔ مجوزهای راه دور، کارهای یک‌بارِ مجازشده، قسمت‌های بازشده با کد و مجوز زمان‌بندی‌شدهٔ باز همین حالا بسته شوند؟')) return
    setBusy(true)
    setMessage(null)
    try {
      await call(CH.gateCloseAll)
      setMessage({ ok: true, text: 'همهٔ مجوزها و قفل‌های باز بسته شدند.' })
    } catch (e: any) {
      setMessage({ ok: false, text: e?.message || 'بستن کامل نشد؛ دوباره بزنید.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded shadow p-4 space-y-3" dir="rtl">
      <h2 className="font-bold">مدت مجوز راه دور و بستن همه</h2>
      <div className="kbd leading-6">
        مجوز گوشی یک «قسمت» را برای این مدت باز می‌کند و یک «قفل کار» را فقط یک بار، تا همین مدت. اگر از قسمتِ باز استفاده
        نشود، پس از یک‌پنجم مدت (کمینه ۳ و بیشینه ۱۰ دقیقه) بسته می‌شود. درخواستِ تأییدنشده پس از ۱۰ دقیقه باطل می‌شود.
        {current !== null ? <> مدت فعلی: <b>{faDigits(current)} دقیقه</b>.</> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="block mb-1">مدت مجوز راه دور (۱ تا ۶۰ دقیقه)</span>
          <input className="inp w-28 text-center" dir="ltr" inputMode="numeric" value={minutes} disabled={busy}
            onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <label className="block">
          <span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !valid || !password || value === current} onClick={() => void save()}>
          ذخیرهٔ مدت
        </button>
      </div>
      {!valid && minutes.trim() ? <div className="kbd text-rose-700">عدد باید صحیح و بین ۱ تا ۶۰ باشد.</div> : null}
      {valid && idle !== null ? <div className="kbd">با این مدت، بی‌کاری قسمتِ باز پس از {faDigits(idle)} دقیقه آن را می‌بندد.</div> : null}
      <div className="border-t pt-3">
        <button className="btn btn-danger" disabled={busy} onClick={() => void closeAll()}>
          بستن همهٔ مجوزها و قفل‌های باز
        </button>
        <div className="kbd mt-1">مجوزهای گوشی و ربات، کارهای یک‌بارِ مجازشده، قسمت‌های بازشده با کد یک‌بارمصرف و مجوز زمان‌بندی‌شدهٔ باز بسته می‌شوند؛ رمز لازم نیست. نشست مدیر، رمزهای دوم، خود کدهای یک‌بارمصرف و مجوزهای زمان‌بندی‌شدهٔ آینده دست نمی‌خورند.</div>
      </div>
      {message ? (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>
          {message.text}
        </div>
      ) : null}
    </div>
  )
}
