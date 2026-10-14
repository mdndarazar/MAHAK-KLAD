import { useCallback, useEffect, useState } from 'react'
import { call, CH } from '../lib/api'

type Manager = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type State = { state: string; activeShiftId?: number | null; custodian?: { name: string } | null }
type Result = { outcome: 'NO_CHANGE' | 'ABORTED_INCOMPLETE' | 'RECOVERED_REAL_OWNER' | 'CLEARED_STALE_POINTER' }
const messageOf = (outcome: Result['outcome']) => ({
  NO_CHANGE: 'وضعیت سالم بود؛ نه مسئول، نه سند و نه شیفت تغییر کرد.',
  ABORTED_INCOMPLETE: 'تلاش ناتمام محفوظ ماند اما با شمارش/PIN قبلی قابل ادامه نیست. مسئول واقعی پیشین باقی ماند.',
  RECOVERED_REAL_OWNER: 'آخرین شیفت واقعی ثبت‌شده بازیابی شد؛ شیفت برنامه‌ای تازه ساخته نشد.',
  CLEARED_STALE_POINTER: 'اشاره‌گر ناسازگار پاک شد؛ شیفت برنامه‌ای یا مسئول ساختگی ساخته نشد.'
})[outcome]

/** Permanently available in manager Settings even with a closed/disabled box.
 * No financial amounts or stale PINs enter this form. Main re-reads the owner. */
export function CustodyResetShiftPanel({ staff }: { staff: Manager[] }) {
  const [state, setState] = useState<State | null>(null)
  const [managerId, setManagerId] = useState<number | ''>('')
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const load = useCallback(async () => {
    setState(await call<State>(CH.custodyStatus, {}))
  }, [])
  useEffect(() => { void load().catch((e) => setError(e?.message ?? 'وضعیت صندوق خوانده نشد.')) }, [load])
  const submit = async () => {
    setError(null); setSuccess(null); setBusy(true)
    try {
      if (!managerId || !password || reason.trim().length < 10 || !confirmed)
        throw new Error('مدیر، PIN شخصی او، دلیل روشن (حداقل ۱۰ حرف) و تأیید صریح لازم‌اند.')
      const result = await call<Result>(CH.custodyShiftReset, {
        managerUserId: managerId, password, reason: reason.trim(), confirmed
      })
      setSuccess(messageOf(result.outcome))
      setPassword(''); setReason(''); setConfirmed(false)
      await load()
      window.dispatchEvent(new Event('mahak:shift-changed'))
    } catch (e: any) {
      setError(e?.message ?? 'ریست انجام نشد؛ سندها و مسئولیت قبلی دست‌نخورده‌اند.')
      await load().catch(() => {})
    } finally { setBusy(false) }
  }
  const managers = staff.filter((person) => person.role === 'MANAGER' && person.isActive && person.hasCustodyPin && !person.mustChangePin)
  return <div className="max-w-2xl space-y-3 text-sm">
    <h3 className="font-bold">ریست ایمن شیفت (بازیابی)</h3>
    <p className="rounded border border-sky-300 bg-sky-50 p-3 leading-7">
      با صندوق باز یا بسته قابل درخواست است. در حالت سالم هیچ تغییر عملیاتی نمی‌دهد. اگر تحویل ناتمام باشد، شمارش و PIN قدیمی دوباره استفاده نمی‌شود؛ اصل سندها، فروش و اختلاف‌ها محفوظ‌اند. فقط آخرین مسئول <b>واقعاً ثبت‌شده</b> ملاک است؛ برنامهٔ شیفت، مسئول جدید نمی‌سازد.
    </p>
    <p>وضعیت فعلی: <b>{state?.state === 'ACTIVE' ? `باز، مسئول ${state.custodian?.name ?? 'ثبت‌شده'}` : state?.state === 'NO_SESSION' ? 'بسته / بدون مسئول' : state?.state === 'HANDOVER_PENDING' ? 'تحویل ناتمام (فروش با مسئول قبلی)' : state?.state ?? 'در حال خواندن'}</b></p>
    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void load().catch((e) => setError(e?.message ?? 'وضعیت خوانده نشد.'))}>تازه‌سازی وضعیت</button>
    <label className="block">مدیر اقدام‌کننده<select className="input mt-1 w-full" value={managerId} onChange={(e) => { setManagerId(e.target.value ? Number(e.target.value) : ''); setPassword('') }}><option value="">مدیر را انتخاب کنید…</option>{managers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
    <label className="block">PIN شخصی همان مدیر<input className="input mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <label className="block">دلیل ریست<textarea className="input mt-1 w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً قطع برق و تحویل ناتمام؛ شمارش تازه از نفر جدید خواسته می‌شود." /></label>
    <label className="flex gap-2 items-start"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>تأیید می‌کنم: این کار سند، فروش، شمارش یا اختلاف قبلی را حذف نمی‌کند و مسئولیت را خودکار منتقل نمی‌کند.</span></label>
    {error ? <p role="alert" className="rounded bg-red-50 p-2 text-red-800">{error}</p> : null}
    {success ? <p role="status" className="rounded bg-green-50 p-2 text-green-800">{success}</p> : null}
    <button type="button" className="btn-primary" disabled={busy || !managerId || !password || reason.trim().length < 10 || !confirmed} onClick={() => void submit()}>{busy ? 'در حال بررسی…' : 'تأیید و ریست ایمن شیفت'}</button>
  </div>
}
