import { useCallback, useEffect, useState } from 'react'
import { call, CH } from '../lib/api'

type Manager = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type Missed = { id: number; shiftId: number; openedAt: string; oldOwnerUserId: number | null; systemEndedAt: string | null; evidence: string | null }

/** Historical review stays in Manager Settings, not the new worker's drawer.
 * No physical count from the new person is attached to the old Shift. */
export function CustodyMissedShiftPanel({ staff }: { staff: Manager[] }) {
  const [rows, setRows] = useState<Missed[]>([])
  const [more, setMore] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [managerId, setManagerId] = useState<number | ''>('')
  const [pin, setPin] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const load = useCallback(async () => {
    const result = await call<{ rows: Missed[]; hasMore: boolean }>(CH.custodyOpenResolutions, {})
    setRows(result.rows); setMore(result.hasMore)
  }, [])
  useEffect(() => { void load().catch((e) => setError(e?.message ?? 'پرونده‌های مدیر خوانده نشد.')) }, [load])
  const managers = staff.filter((row) => row.role === 'MANAGER' && row.isActive && row.hasCustodyPin && !row.mustChangePin)
  const nameOf = (id: number | null) => staff.find((person) => person.id === id)?.name ?? 'مسئول ثبت‌شدهٔ قدیمی'
  const decide = async () => {
    setError(null); setSuccess(null); setBusy(true)
    try {
      if (!selectedId || !managerId || !pin || reason.trim().length < 10)
        throw new Error('پرونده، مدیر، PIN شخصی و دلیل حداقل ۱۰ حرف لازم است.')
      await call(CH.custodyUnresolvedResolve, {
        resolutionId: selectedId, managerUserId: managerId,
        managerPassword: pin, reason: reason.trim(), attribution: 'DIFFERENCE_UNKNOWN'
      })
      setPin(''); setReason(''); setSelectedId(null)
      setSuccess('بازبینی مدیر ثبت شد؛ بدون ادعای شمارش گذشته، تغییر مسئولیت یا انتساب خودکار اختلاف.')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'تصمیم ثبت نشد؛ اصل شواهد باقی است.')
      await load().catch(() => {})
    } finally { setBusy(false) }
  }
  return <div className="space-y-3 text-sm">
    <h3 className="font-bold">شیفت‌های منقضی و پرونده‌های قدیمی — فقط مدیر</h3>
    <p className="rounded border border-sky-300 bg-sky-50 p-3 leading-7">
      سیستم پایان <b>آخرین مسئول واقعی</b> را ثبت کرده است. نفر تازه لازم نیست این شیفت‌ها را ببیند یا ببندد؛ با مبلغ واقعی و PIN خود افتتاح می‌کند و فروش ادامه می‌یابد. اینجا فقط بازبینی تاریخی است: شمارش نفر تازه به صندوق قدیمی منتقل نمی‌شود و تصمیم بدون شاهد اختلاف، حکم تقصیر نیست.
    </p>
    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void load().catch((e) => setError(e?.message ?? 'فهرست خوانده نشد.'))}>تازه‌سازی پرونده‌ها</button>
    {error ? <p role="alert" className="rounded bg-red-50 p-2 text-red-800">{error}</p> : null}
    {success ? <p role="status" className="rounded bg-green-50 p-2 text-green-800">{success}</p> : null}
    {!rows.length ? <p className="text-slate-600">پروندهٔ منقضیِ در انتظار بازبینی وجود ندارد.</p> : null}
    {more ? <p className="text-amber-800">بیش از ۱۰۰ پرونده وجود دارد؛ فقط تازه‌ترین پرونده‌ها اینجا هستند. برای سوابق کامل، گزارش حضانت را ببینید.</p> : null}
    <div className="space-y-2">{rows.map((row) => <div key={row.id} className="rounded border p-3 leading-7">
      <b>پرونده #{row.id} · شیفت واقعی #{row.shiftId} · {nameOf(row.oldOwnerUserId)}</b>
      <p>پایان ثبت‌شدهٔ سیستم: {row.systemEndedAt ? new Date(row.systemEndedAt).toLocaleString('fa-IR') : 'در انتظار بررسی'} · وضعیت شاهد: {row.evidence === 'EVIDENCE_QUARANTINED' ? 'سند ناسازگار در قرنطینه؛ مبلغ و اختلاف نامعلوم' : row.evidence === 'CUSTODIAN_ARCHIVED' ? 'مسئول پیشین آرشیو شده' : 'شمارش پایان توسط مسئول پیشین موجود نیست'}</p>
      {row.evidence === 'EVIDENCE_QUARANTINED'
        ? <p className="rounded bg-rose-50 p-2 text-rose-900">از تب «قرنطینهٔ شاهد · بازیابی مستقل» تعیین تکلیف کنید؛ بستن مالی یا بازبینی شب برای این پرونده مجاز نیست.</p>
        : <button className="btn-secondary mt-1" disabled={busy} onClick={() => { setSelectedId(row.id); setPin(''); setReason(''); setError(null) }}>بازبینی مدیر بدون شمارش فرضی</button>}
    </div>)}</div>
    {selectedId && rows.some((row) => row.id === selectedId && row.evidence !== 'EVIDENCE_QUARANTINED') ? <div className="rounded border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
      <h4 className="font-bold">بازبینی پرونده #{selectedId}</h4>
      <p>مبلغ جدید یا شمارش نفر تازه را برای شیفت قدیمی وارد نکنید. در نبود شاهد قابل اتکا، نتیجه فقط «اختلاف نامعلوم و بدون انتساب» است.</p>
      <label className="block">مدیر بازبین<select className="input mt-1 w-full" value={managerId} onChange={(e) => { setManagerId(e.target.value ? Number(e.target.value) : ''); setPin('') }}><option value="">انتخاب کنید…</option>{managers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label className="block">PIN شخصی مدیر<input className="input mt-1 w-full" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
      <label className="block">دلیل بررسی<textarea className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="مثلاً پایان قدیمی به‌صورت سیستمی ثبت شد؛ شاهد شمارش پایان موجود نیست." /></label>
      <div className="flex gap-2"><button className="btn-secondary" type="button" onClick={() => { setSelectedId(null); setPin('') }} disabled={busy}>انصراف</button><button className="btn-primary" type="button" disabled={busy || !managerId || !pin || reason.trim().length < 10} onClick={() => void decide()}>{busy ? 'در حال ثبت…' : 'ثبت بازبینی بدون انتساب اختلاف'}</button></div>
    </div> : null}
  </div>
}
