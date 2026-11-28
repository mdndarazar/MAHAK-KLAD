import { useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toLatinDigits } from '@shared/jalali'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ — دو کار روی صفحهٔ «کنترل از راه دور»:
 *   - §۳-۱۳ (مورد ۷) و دفتر آزمون ۴-۲۸: دو «مدت مجوز راه دور»، هر کدام عدد صحیح ۱ تا ۱۰۰۰ دقیقه (پیش‌فرض ۱۰):
 *     «ماژول‌های معمولی» و «ماژول‌های پولی و حساس» (قسمت پولی و قسمت تازه؛ همان مرز کدهای «سایر» و «حساس»).
 *     تغییرشان «کلیدسازی» است: رمز تایپی مدیر می‌خواهد (یک کادر خام برای هر دو، هرگز نشانگر)، در AuditLog می‌نشیند و
 *     خبرش به پیام‌رسان می‌رود. مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود. «قفل کار» همان یک بار است.
 *   - §۳-۱۷: «بستن همهٔ مجوزها و قفل‌های باز» (مجوزهای راه دور، بلیت‌های یک‌بار، قسمت‌های بازشده با کد و مجوز
 *     زمان‌بندی‌شدهٔ باز)؛ رمز نمی‌خواهد، چون فقط می‌بندد. مجوزهای زمان‌بندی‌شدهٔ آینده و خود کدها باطل نمی‌شوند.
 * ===========================================================================
 */
type Durations = { sensitiveCodeMinutes: number; otherCodeMinutes: number; remoteGrantMinutes: number; remoteSensitiveGrantMinutes: number }
type RemoteKey = 'remoteGrantMinutes' | 'remoteSensitiveGrantMinutes'
const BOXES: ReadonlyArray<{ key: RemoteKey; title: string }> = [
  { key: 'remoteGrantMinutes', title: 'ماژول‌های معمولی' },
  { key: 'remoteSensitiveGrantMinutes', title: 'ماژول‌های پولی و حساس' }
]
const remoteOf = (d: Durations): Record<RemoteKey, number> => ({ remoteGrantMinutes: d.remoteGrantMinutes, remoteSensitiveGrantMinutes: d.remoteSensitiveGrantMinutes })
const texts = (c: Record<RemoteKey, number>): Record<RemoteKey, string> => ({ remoteGrantMinutes: String(c.remoteGrantMinutes), remoteSensitiveGrantMinutes: String(c.remoteSensitiveGrantMinutes) })

export default function RemoteGrantControls() {
  const [current, setCurrent] = useState<Record<RemoteKey, number> | null>(null)
  const [minutes, setMinutes] = useState<Record<RemoteKey, string>>({ remoteGrantMinutes: '', remoteSensitiveGrantMinutes: '' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void call<Durations>(CH.lockDurationsGet)
      .then((d) => { const c = remoteOf(d); setCurrent(c); setMinutes(texts(c)) })
      .catch(() => setCurrent(null))
  }, [])

  const valueOf = (key: RemoteKey) => Number(toLatinDigits(minutes[key]).trim())
  const validOf = (key: RemoteKey) => Number.isInteger(valueOf(key)) && valueOf(key) >= 1 && valueOf(key) <= 1000
  const valid = BOXES.every((b) => validOf(b.key))
  const changed = current === null || BOXES.some((b) => valueOf(b.key) !== current[b.key])
  const idleOf = (key: RemoteKey) => (validOf(key) ? Math.min(10, Math.max(3, Math.round(valueOf(key) / 5))) : null)

  const save = async () => {
    if (busy || !valid || !password) return
    setBusy(true)
    setMessage(null)
    try {
      const d = await call<Durations>(CH.lockDurationsSet, { managerPassword: password, remoteGrantMinutes: valueOf('remoteGrantMinutes'), remoteSensitiveGrantMinutes: valueOf('remoteSensitiveGrantMinutes') })
      const c = remoteOf(d)
      setCurrent(c)
      setMinutes(texts(c))
      setPassword('')
      setMessage({ ok: true, text: `مدت مجوز راه دور: ماژول‌های معمولی ${faDigits(c.remoteGrantMinutes)} دقیقه، ماژول‌های پولی و حساس ${faDigits(c.remoteSensitiveGrantMinutes)} دقیقه. مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود.` })
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
        مجوز گوشی یا ربات یک «قسمت» را برای مدت همان نوع باز می‌کند: قسمت معمولی با مدت اول، و قسمت پولی یا تازه با مدت دوم.
        یک «قفل کار» را فقط یک بار باز می‌کند (برای استفاده تا مدت دوم، حداکثر ۶۰ دقیقه). اگر از قسمتِ باز استفاده نشود، پس از
        یک‌پنجم مدت (کمینه ۳ و بیشینه ۱۰ دقیقه) بسته می‌شود. درخواستِ تأییدنشده پس از ۱۰ دقیقه باطل می‌شود.
        {current !== null ? <> مدت فعلی: معمولی <b>{faDigits(current.remoteGrantMinutes)} دقیقه</b>، پولی و حساس <b>{faDigits(current.remoteSensitiveGrantMinutes)} دقیقه</b>.</> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {BOXES.map((b) => (
          <label key={b.key} className="block">
            <span className="block mb-1">مدت مجوز راه دور — {b.title} (۱ تا ۱۰۰۰ دقیقه)</span>
            <input className="inp w-28 text-center" dir="ltr" inputMode="numeric" value={minutes[b.key]} disabled={busy}
              onChange={(e) => { const v = e.target.value; setMinutes((m) => ({ ...m, [b.key]: v })) }} />
          </label>
        ))}
        <label className="block">
          <span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !valid || !password || !changed} onClick={() => void save()}>
          ذخیرهٔ مدت‌ها
        </button>
      </div>
      {BOXES.some((b) => !validOf(b.key) && minutes[b.key].trim()) ? <div className="kbd text-rose-700">هر مدت باید عددی صحیح و بین ۱ تا ۱۰۰۰ باشد.</div> : null}
      {valid ? <div className="kbd">با این مدت‌ها، بی‌کاری قسمتِ باز آن را می‌بندد: معمولی پس از {faDigits(idleOf('remoteGrantMinutes') ?? 0)} دقیقه، پولی و حساس پس از {faDigits(idleOf('remoteSensitiveGrantMinutes') ?? 0)} دقیقه.</div> : null}
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
