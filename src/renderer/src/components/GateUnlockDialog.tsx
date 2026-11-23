import { useEffect, useState } from 'react'
import Modal from './Modal'
import PasswordField from './PasswordField'
import { RemoteRequestBox } from './RemoteRequestBox'
import OneTimeCodeBox from './OneTimeCodeBox'
import { call, CH, GATE_REQUIRED_EVENT } from '../lib/api'
import { useManagerSession } from '../hooks/useManagerSession'
import { gateEntry } from '@shared/gateCatalog'
import { faDigits } from '@shared/jalali'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۷ — پنجرهٔ سراسری «باز کردن قفل این کار» (یک بار در `Shell.tsx`).
 *
 * وقتی دروازهٔ main با کد `GATE_REQUIRED:<شناسه>` رد می‌کند، `lib/api.ts` رویداد سراسری می‌فرستد و این پنجره
 * نام فارسی کار یا قسمت را نشان می‌دهد، با این راه‌ها:
 *   ۱) «رمز»: رمز مدیر، یا رمز دوم/سوم همان کلید. برای «قفل کار» یک بلیت یک‌بار برای همین پنجره می‌سازد
 *      (رمز دوم/سوم هر بار تایپ می‌شود)؛ برای «قسمت» نشست همان قسمت. تلاش اشتباه روی همان کلید شمرده می‌شود.
 *   ۲) «کد یک‌بارمصرف» (§۳-۱۵): برای کار فقط کد «حساس» (یک بار)؛ برای قسمت طبق ردهٔ آن.
 *   ۳) «درخواست مجوز از مدیر (راه دور)»: همان `RemoteRequestBox`، با شناسهٔ کار یا کلید قسمت.
 *   ۴) «بستن».
 * هیچ صفحهٔ کاری برای دکمه‌های کد و مجوز ویرایش نمی‌شود. کارِ «قفل خاموش» هرگز این پنجره را نمی‌بیند.
 * ===========================================================================
 */
type GateRequest = { id: string; message: string }

export default function GateUnlockDialog() {
  const { unlockPanel } = useManagerSession()
  const [request, setRequest] = useState<GateRequest | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    const onRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: unknown; message?: unknown }>).detail
      const entry = gateEntry(detail?.id)
      if (!entry || entry.category === 1) return
      setRequest({ id: entry.id, message: typeof detail?.message === 'string' ? detail.message : '' })
      setPassword('')
      setError(null)
      setDone(null)
    }
    window.addEventListener(GATE_REQUIRED_EVENT, onRequired)
    return () => window.removeEventListener(GATE_REQUIRED_EVENT, onRequired)
  }, [])

  const entry = request ? gateEntry(request.id) : null
  if (!request || !entry) return null
  const isAction = entry.category === 3
  const close = () => setRequest(null)

  const unlock = async () => {
    if (busy || !password.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (isAction) {
        const result = await call<{ minutes: number }>(CH.gateUnlock, { id: entry.id, password })
        setDone(`این کار یک بار مجاز شد (تا ${faDigits(result?.minutes ?? 10)} دقیقه). دوباره روی دکمهٔ همان کار بزنید.`)
      } else {
        await unlockPanel(entry.lockKey, password)
        setDone('این بخش باز شد. دوباره روی دکمهٔ همان کار بزنید.')
      }
      setPassword('')
    } catch (e: any) {
      setError(e?.message || 'رمز پذیرفته نشد.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={`باز کردن قفل: ${entry.titleFa}`} onClose={close} width="max-w-lg" zIndexClass="z-[70]"
      footer={<button className="btn" onClick={close}>بستن</button>}>
      <div className="space-y-3 text-sm" dir="rtl">
        {request.message ? <div className="rounded px-3 py-2 bg-amber-50 border border-amber-300">{request.message}</div> : null}
        {done ? (
          <div role="status" className="rounded px-3 py-2 bg-emerald-50 border border-emerald-300 font-bold">{done}</div>
        ) : (
          <>
            <div className="text-slate-600">
              {isAction
                ? 'این یک «قفل کار» است: رمز مدیر، یا رمز دوم/سوم همین کار (یا ماژول مادرش) آن را فقط یک بار باز می‌کند.'
                : 'این یک «قسمت» است: رمز مدیر، یا رمز دوم/سوم همین قسمت آن را برای مدت نشست باز می‌کند.'}
            </div>
            <label className="block space-y-1">
              <span>رمز</span>
              <PasswordField typedOnly autoFocus value={password} disabled={busy}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void unlock() }} />
            </label>
            {error ? <div role="alert" className="rounded px-3 py-2 bg-rose-50 border border-rose-300">{error}</div> : null}
            <button className="btn btn-primary w-full" disabled={busy || !password.trim()} onClick={() => void unlock()}>
              {busy ? 'در حال بررسی…' : isAction ? 'مجاز کردن یک بار' : 'باز کردن این بخش'}
            </button>
            <OneTimeCodeBox target={entry.id} onDone={(text) => setDone(text)} />
            <RemoteRequestBox panel={entry.id} />
          </>
        )}
      </div>
    </Modal>
  )
}
