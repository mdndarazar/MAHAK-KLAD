import { useEffect, useState } from 'react'
import { REMOTE_SETUP_CHANNELS, type RemoteSetupStatus } from '@shared/remoteAuthChannels'
import { toLatinDigits } from '@shared/jalali'
import { call } from '../lib/api'

/**
 * راه‌اندازی کنترل از راه دور (فقط روی همین رایانه). هر تغییر در Main با رمز مدیر
 * سنجیده می‌شود؛ این صفحه هیچ رمز یا کلیدی ذخیره نمی‌کند و پورتی باز نمی‌کند.
 */
const REASONS: Record<string, string> = {
  PORT_IN_USE: 'پورت انتخاب‌شده را برنامهٔ دیگری گرفته است.',
  HUB_LOCKED: 'قفل اجرای قبلی هاب باقی مانده است (مثلاً پس از قطع برق). برنامه را ببندید و باز کنید؛ اگر ماند، راه‌اندازی را حذف و از نو انجام دهید.',
  OWNER_REQUIRED: 'مالک گوشی هنوز ساخته نشده است.'
}
function explain(error: string | null): string | null {
  if (!error) return null
  if (error.includes('Remote stopped after backup restore')) return 'پس از بازگردانی یا ادغام بکاپ، کنترل از راه دور برای ایمنی خاموش شد. با باز شدن دوبارهٔ برنامه یا «روشن کردن» دوباره روشن می‌شود.'
  if (error.includes('Remote port in use')) return REASONS.PORT_IN_USE
  if (error.includes('Remote hub lock present')) return REASONS.HUB_LOCKED
  if (error.includes('Remote owner setup required')) return REASONS.OWNER_REQUIRED
  if (error.includes('Secure storage unavailable')) return 'ذخیره‌ساز امن ویندوز در دسترس نیست.'
  if (error.includes('Remote directory unavailable') || error.includes('Remote file unavailable') || error.includes('ENOENT')) return 'فایل‌های لازم کنترل از راه دور در نصب یا پوشهٔ داده پیدا نشد.'
  if (error.includes('Remote database identity unavailable')) return 'برنامه با پایگاه دادهٔ پیش‌فرض اجرا نشده است.'
  if (error.includes('lock')) return REASONS.HUB_LOCKED
  return 'روشن شدن هاب انجام نشد.'
}

export default function RemoteLink() {
  const [status, setStatus] = useState<RemoteSetupStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [managerPassword, setManagerPassword] = useState('')
  const [origin, setOrigin] = useState('https://')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordAgain, setPasswordAgain] = useState('')
  const [pin, setPin] = useState('')
  const [pinAgain, setPinAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const refresh = async () => {
    try { setStatus(await call<RemoteSetupStatus>(REMOTE_SETUP_CHANNELS.status as any)); setLoadError(null) }
    catch { setLoadError('کنترل از راه دور در این نسخه یا این پنجره در دسترس نیست.') }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [])

  const run = async (channel: string, payload: Record<string, unknown>, done: string) => {
    if (busy) return
    setBusy(true); setMessage(null)
    try {
      const next = await call<RemoteSetupStatus>(channel as any, { managerPassword, ...payload })
      setStatus(next)
      const failed = explain(next.error)
      setMessage(next.running || channel === REMOTE_SETUP_CHANNELS.disable || channel === REMOTE_SETUP_CHANNELS.reset
        ? { ok: true, text: done }
        : { ok: false, text: failed ?? 'هاب روشن نشد.' })
      if (next.running || channel === REMOTE_SETUP_CHANNELS.reset) { setPassword(''); setPasswordAgain(''); setPin(''); setPinAgain('') }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'انجام نشد.' })
    } finally { setManagerPassword(''); setConfirmReset(false); setBusy(false); void refresh() }
  }

  const ownerProblem = (): string | null => {
    if (password.length < 10) return 'رمز گوشی باید دست‌کم ۱۰ نویسه باشد.'
    if (password !== passwordAgain) return 'دو رمز گوشی یکسان نیستند.'
    if (!/^[0-9]{6}$/.test(pin)) return 'PIN باید دقیقاً ۶ رقم باشد.'
    if (pin !== pinAgain) return 'دو PIN یکسان نیستند.'
    if (username.trim().length < 3) return 'نام کاربری دست‌کم ۳ نویسه باشد.'
    return null
  }
  const ownerPayload = () => ({ username, password, pin })
  const portValue = () => Number(port || status?.defaultPort || 0)

  if (loadError && !status) {
    return <div className="bg-white rounded shadow p-4 space-y-2"><h1 className="font-bold">کنترل از راه دور با گوشی</h1><div>{loadError}</div></div>
  }
  if (!status) return <div className="bg-white rounded shadow p-4">در حال خواندن وضعیت…</div>

  const ownerFields = (
    <div className="space-y-2">
      <label className="block">نام کاربری مالک برای ورود در گوشی
        <input className="inp w-full" dir="ltr" autoComplete="off" value={username} disabled={busy} onChange={e => setUsername(e.target.value)} />
      </label>
      <label className="block">رمز ورود گوشی (دست‌کم ۱۰ نویسه؛ با رمز برنامه یکی نباشد)
        <input className="inp w-full" type="password" autoComplete="new-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} />
      </label>
      <label className="block">تکرار رمز ورود گوشی
        <input className="inp w-full" type="password" autoComplete="new-password" value={passwordAgain} disabled={busy} onChange={e => setPasswordAgain(e.target.value)} />
      </label>
      <label className="block">PIN شش‌رقمی تأیید (برای هر تأیید در گوشی و بازیابی توقف اضطراری)
        <input className="inp w-full" type="password" inputMode="numeric" maxLength={6} autoComplete="off" value={pin} disabled={busy} onChange={e => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ''))} />
      </label>
      <label className="block">تکرار PIN
        <input className="inp w-full" type="password" inputMode="numeric" maxLength={6} autoComplete="off" value={pinAgain} disabled={busy} onChange={e => setPinAgain(toLatinDigits(e.target.value).replace(/[^0-9]/g, ''))} />
      </label>
    </div>
  )
  const managerField = (
    <label className="block">رمز مدیر برنامه (برای تأیید هر تغییر در این صفحه)
      <input className="inp w-full" type="password" autoComplete="off" value={managerPassword} disabled={busy} onChange={e => setManagerPassword(e.target.value)} />
    </label>
  )
  const problem = ownerProblem()
  const shownPort = status.mobilePort ?? status.port

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="bg-white rounded shadow p-4 space-y-2">
        <h1 className="text-brand font-bold">کنترل از راه دور با گوشی</h1>
        {!status.ready ? <div>این نسخه هنوز کنترل از راه دور را فعال نکرده است.</div> : (
          <div className="space-y-1">
            <div>وضعیت: <b>{status.running ? 'روشن' : status.busy ? 'در حال تغییر…' : status.enabled ? 'روشن نشده (خطا)' : 'خاموش'}</b></div>
            {status.origin && <div>آدرس گوشی: <b dir="ltr">{status.origin}</b></div>}
            {shownPort !== null && <div>پورت محلی هاب: <b dir="ltr">127.0.0.1:{shownPort}</b></div>}
            {status.enabled && !status.running && !status.busy && explain(status.error) && <div role="alert" className="rounded px-3 py-2 bg-amber-50 border border-amber-300">{explain(status.error)}</div>}
            {status.needsRestart && <div role="alert" className="rounded px-3 py-2 bg-rose-50 border border-rose-300">خاموش شدن قبلی تأیید نشد. برنامه را کامل ببندید و دوباره باز کنید.</div>}
          </div>
        )}
        {status.ready && managerField}
        {message && <div role="status" className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'}`}>{message.text}</div>}
      </div>

      {status.ready && !status.configured && !status.partial && (
        <div className="bg-white rounded shadow p-4 space-y-2">
          <h2 className="font-bold">راه‌اندازی اول</h2>
          <div className="kbd leading-6">
            هاب فقط روی همین رایانه (127.0.0.1) گوش می‌دهد. برای دسترسی گوشی، یک تونل یا شبکهٔ امن (مثل Cloudflare Tunnel یا Tailscale)
            باید آدرس https زیر را به همین پورت محلی برساند. برنامه باید باز بماند.
          </div>
          <label className="block">آدرس https که گوشی باز می‌کند
            <input className="inp w-full" dir="ltr" autoComplete="off" value={origin} disabled={busy} onChange={e => setOrigin(e.target.value.trim())} />
          </label>
          <label className="block">پورت محلی (پیش‌فرض {status.defaultPort})
            <input className="inp w-full" dir="ltr" inputMode="numeric" placeholder={String(status.defaultPort)} value={port} disabled={busy} onChange={e => setPort(toLatinDigits(e.target.value).replace(/[^0-9]/g, ''))} />
          </label>
          {ownerFields}
          {problem && <div className="kbd">{problem}</div>}
          <button className="btn btn-primary" disabled={busy || !!problem || !managerPassword || !origin.startsWith('https://')}
            onClick={() => void run(REMOTE_SETUP_CHANNELS.configure, { origin, port: portValue(), ...ownerPayload() }, 'راه‌اندازی انجام شد و هاب روشن است.')}>
            راه‌اندازی و روشن کردن
          </button>
        </div>
      )}

      {status.ready && status.configured && status.ownerRequired && (
        <div className="bg-white rounded shadow p-4 space-y-2">
          <h2 className="font-bold">تکمیل راه‌اندازی</h2>
          <div className="kbd">مالک گوشی هنوز ساخته نشده است. اطلاعات مالک را وارد کنید.</div>
          {ownerFields}
          {problem && <div className="kbd">{problem}</div>}
          <button className="btn btn-primary" disabled={busy || !!problem || !managerPassword}
            onClick={() => void run(REMOTE_SETUP_CHANNELS.complete, ownerPayload(), 'راه‌اندازی کامل شد و هاب روشن است.')}>
            ساخت مالک و روشن کردن
          </button>
        </div>
      )}

      {status.ready && status.configured && !status.ownerRequired && (
        <div className="bg-white rounded shadow p-4 space-y-2">
          <h2 className="font-bold">روشن / خاموش</h2>
          <div className="kbd">خاموش یعنی هیچ پورتی باز نیست و هیچ اتصالی برقرار نمی‌شود؛ در شروع بعدی برنامه هم خاموش می‌ماند.</div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !managerPassword || status.running}
              onClick={() => void run(REMOTE_SETUP_CHANNELS.enable, {}, 'هاب روشن شد.')}>روشن کردن</button>
            <button className="btn" disabled={busy || !managerPassword || (!status.running && !status.enabled)}
              onClick={() => void run(REMOTE_SETUP_CHANNELS.disable, {}, 'خاموش شد؛ پورت بسته است.')}>خاموش کردن</button>
          </div>
        </div>
      )}

      {status.ready && (status.configured || status.partial) && (
        <div className="bg-white rounded shadow p-4 space-y-2">
          <h2 className="font-bold">حذف راه‌اندازی</h2>
          <div className="kbd leading-6">
            {status.partial ? 'راه‌اندازی قبلی نیمه‌کاره مانده است. ' : ''}
            حذف، هاب را خاموش می‌کند و پوشهٔ آن را با نام «remote-hub-removed-…» کنار می‌گذارد (پاک نمی‌کند). گوشی‌ها باید از نو وارد شوند.
            داده‌های فروشگاه دست نمی‌خورند.
          </div>
          {!confirmReset ? (
            <button className="btn" disabled={busy || !managerPassword} onClick={() => setConfirmReset(true)}>حذف راه‌اندازی…</button>
          ) : (
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy || !managerPassword}
                onClick={() => void run(REMOTE_SETUP_CHANNELS.reset, {}, 'راه‌اندازی حذف شد.')}>بله، حذف شود</button>
              <button className="btn" disabled={busy} onClick={() => setConfirmReset(false)}>انصراف</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
