import { useCallback, useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, parseRequiredRialAmount, toJalaliDateTime } from '@shared/jalali'
import { OpeningRialInput } from './OpeningRialInput'

type Manager = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type Case = {
  id: number; shiftId: number; handoverId: number | null; snapshotId: number | null
  reasonCode: string; detectedAt: string; detectedEpoch: number
  oldOwnerUserId: number | null; closedAt: string | null; active: boolean
  originalClaim: null | { role: string; calculationVersion: string; referenceStatus: string
    referenceAmount: string | null; fromDay: string; toDay: string; countOrigin: string
    humanAmount: string | null; evidenceDigest: string | null }
  recovery: null | { id: number; outcome: string; managerUserId: number
    countedAmount: string; reason: string; at: string; recoverySnapshotId: number | null }
}
type Inventory = { rows: Case[]; hasMore: boolean; seenEpoch: number }

/** This is a manager-only case file, NEVER a second alias for resetShift or a
 * way to resolve a missing blue amount with the old corrupt snapshot. */
export function CustodyEvidenceRecoveryPanel({ staff }: { staff: Manager[] }) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [managerId, setManagerId] = useState<number | ''>('')
  const [password, setPassword] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [key, setKey] = useState(() => `evidence-recovery:${crypto.randomUUID()}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const load = useCallback(async () => {
    setInventory(await call<Inventory>(CH.custodyEvidenceCases, { skip: page * 50 }))
  }, [page])
  useEffect(() => { void load().catch((e) => setError(e?.message ?? 'پرونده‌های سند خوانده نشدند.')) }, [load])
  const select = (id: number | null) => {
    setSelected(id); setPassword(''); setAmount(''); setReason(''); setError(null)
    setKey(`evidence-recovery:${crypto.randomUUID()}`)
  }
  const managers = staff.filter((row) => row.role === 'MANAGER' && row.isActive && row.hasCustodyPin && !row.mustChangePin)
  const selectedCase = inventory?.rows.find((row) => row.id === selected && !row.recovery)
  const submit = async () => {
    setBusy(true); setError(null); setSuccess(null)
    try {
      const operationalTotal = amount.trim() ? parseRequiredRialAmount(amount) : null
      if (!selectedCase || !managerId || !password.trim() || operationalTotal == null || reason.trim().length < 10)
        throw new Error('پرونده، مدیر، PIN شخصی، شمارش تازهٔ صریحِ مجموع کشو و کارت‌خوان و دلیل حداقل ۱۰ حرف لازم است.')
      const result = await call<{ outcome: string; replayed: boolean }>(CH.custodyManagerEvidenceRecovery, {
        caseId: selectedCase.id, managerUserId: managerId, password, operationalTotal,
        reason: reason.trim(), seenEpoch: inventory?.seenEpoch, idempotencyKey: key
      })
      setSuccess(result.outcome === 'ACTIVE_FRESH_WITNESS'
        ? 'شاهد تازهٔ مستقل روی همان Shift ثبت شد؛ مسئولیت قبلی دست‌نخورده و سند خراب محفوظ ماند.'
        : 'نشست قدیمی بسته باقی ماند؛ شمارش تازه فقط در پروندهٔ مدیر ثبت شد. فرد بعدی باید مستقلاً با PIN و شمارش جدید افتتاح کند.')
      select(null)
      await load()
      window.dispatchEvent(new Event('mahak:shift-changed'))
    } catch (e: any) {
      setError(e?.message ?? 'بازیابی سند ثبت نشد؛ شاهد خراب و مسئولیت قبلی دست‌نخورده‌اند.')
      // Do not replace the idempotency key on an ambiguous network failure.
      // A byte-for-byte retry may safely read back the same committed result.
      await load().catch(() => {})
    } finally { setBusy(false); setPassword('') }
  }
  return <section className="space-y-3 text-sm" dir="rtl">
    <h3 className="font-bold">پرونده‌های قرنطینهٔ سند آبی · بازیابی مستقل مدیر</h3>
    <p className="rounded border border-rose-300 bg-rose-50 p-3 leading-7">
      <b>شاهد خراب، «مبلغ نامعلومِ قابل‌تطبیق» نیست.</b> اصل OUT/IN و رویدادها محفوظ می‌مانند؛ ریست شیفت، محاسبهٔ صفر یا بستن نهایی ساختگی راه بازیابی نیست.
      فقط مدیر با PIN شخصی، دلیل مستند و <b>شمارش تازه</b> اقدام می‌کند. اگر Shift واقعاً منقضی شده باشد، این شمارش به گذشته منتسب نمی‌شود و فرد حاضر باید بعداً مستقل افتتاح کند.
    </p>
    <button className="btn-secondary" type="button" disabled={busy} onClick={() => void load().catch((e) => setError(e?.message ?? 'فهرست خوانده نشد.'))}>تازه‌سازی پرونده‌ها و نسخهٔ صندوق</button>
    {error ? <p role="alert" className="rounded bg-rose-50 p-2 text-rose-900">{error}</p> : null}
    {success ? <p role="status" className="rounded bg-emerald-50 p-2 text-emerald-900">{success}</p> : null}
    {!inventory?.rows.length ? <p>در این صفحه پرونده‌ای وجود ندارد.</p> : null}
    <div className="space-y-2">{inventory?.rows.map((row) => <details key={row.id} className="rounded border bg-white p-3">
      <summary className="cursor-pointer font-semibold">پرونده #{faDigits(row.id)} · Shift واقعی #{faDigits(row.shiftId)} · {row.recovery ? 'تعیین‌تکلیف‌شده با شاهد تازه' : 'باز؛ عملیات مالی نیازمند بازیابی'} · {row.reasonCode}</summary>
      <div className="mt-2 space-y-2 leading-7">
        <p>مسئول ثبت‌شده: {row.oldOwnerUserId == null ? 'نامشخص' : `شناسهٔ ${faDigits(row.oldOwnerUserId)}`} · تشخیص: {faDigits(toJalaliDateTime(new Date(row.detectedAt)))} · {row.closedAt ? `پایان واقعی Shift: ${faDigits(toJalaliDateTime(new Date(row.closedAt)))}` : 'Shift هنوز باز است'}.</p>
        <p>پیوندهای پایدار: تحویل #{row.handoverId ?? '—'} · شاهد #{row.snapshotId ?? '—'} · epoch تشخیص {faDigits(row.detectedEpoch)}.</p>
        {row.originalClaim ? <p className="rounded border border-rose-200 bg-rose-50 p-2 text-rose-950">ادعای ذخیره‌شدهٔ سند اصلی (نامعتبر؛ نه مرجع مالی): {row.originalClaim.role} · {row.originalClaim.calculationVersion} · دامنه {row.originalClaim.fromDay} تا {row.originalClaim.toDay} · وضعیت ثبت‌شده {row.originalClaim.referenceStatus} · مبلغ ادعاشده {row.originalClaim.referenceAmount ?? 'ندارد'} · منشأ شمارش {row.originalClaim.countOrigin} · digest {row.originalClaim.evidenceDigest ?? 'نسخهٔ تاریخی بدون digest'}. هیچ‌کدام برای بستن یا افتتاح قرض گرفته نمی‌شوند.</p> : <p className="text-rose-900">سند اصلی پیدا نشد؛ نبودِ آن صفرِ مالی نیست.</p>}
        {row.recovery ? <p className="rounded bg-emerald-50 p-2">تصمیم افزایشی #{faDigits(row.recovery.id)} با PIN مدیر #{faDigits(row.recovery.managerUserId)} در {faDigits(toJalaliDateTime(new Date(row.recovery.at)))} · شمارش جدید فقط برای پرونده: {row.recovery.countedAmount} ریال · {row.recovery.outcome === 'CLOSED_SHIFT_DOCUMENTED' ? 'Shift قدیمی بسته باقی مانده؛ هیچ شاهد آبی روی آن ساخته نشد.' : `شاهد RECOVERY مستقل #${row.recovery.recoverySnapshotId} روی همان Shift`} · دلیل: {row.recovery.reason}</p>
          : <button className="btn-primary" type="button" disabled={busy} onClick={() => select(row.id)}>ثبت شمارش تازه و تصمیم مستقل مدیر</button>}
      </div>
    </details>)}</div>
    {inventory && <div className="flex gap-2"><button className="btn-secondary" disabled={busy || page === 0} onClick={() => { select(null); setPage(page - 1) }}>جدیدتر</button><button className="btn-secondary" disabled={busy || !inventory.hasMore} onClick={() => { select(null); setPage(page + 1) }}>قدیمی‌تر</button></div>}
    {selectedCase ? <div className="rounded border-2 border-rose-300 bg-rose-50 p-4 space-y-3">
      <h4 className="font-bold">بازیابی مستقل پرونده #{faDigits(selectedCase.id)}</h4>
      <p>{selectedCase.closedAt ? 'نشست قدیمی بسته است: مبلغ امروز فقط در پروندهٔ مدیر ثبت می‌شود، نه در شمارش/بستن قدیمی.' : 'نشست هنوز باز است: شاهد RECOVERY جدید بدون استفاده از مبلغ یا PIN قدیمی به همان مسئولیت متصل می‌شود.'}</p>
      <label className="block">مدیر ثبت‌کننده<select className="input mt-1 w-full" value={managerId} onChange={(event) => { setManagerId(event.target.value ? Number(event.target.value) : ''); setPassword(''); setKey(`evidence-recovery:${crypto.randomUUID()}`) }}><option value="">انتخاب کنید…</option>{managers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label className="block">PIN شخصی همان مدیر<input className="input mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <OpeningRialInput label="شمارش تازهٔ مجموع فیزیکی کشو و کارت‌خوان (صفر فقط با ۰ صریح)" previewLabel="شمارش تازهٔ مدیر" value={amount} onChange={(value) => { setAmount(value); setKey(`evidence-recovery:${crypto.randomUUID()}`) }} />
      <label className="block">دلیل مستند مدیر<textarea className="input mt-1 w-full" rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setKey(`evidence-recovery:${crypto.randomUUID()}`) }} /></label>
      <div className="flex gap-2"><button className="btn-primary" disabled={busy || !managerId || !password || !amount.trim() || reason.trim().length < 10} onClick={() => void submit()}>{busy ? 'در حال ثبت…' : 'ثبت بازیابی مستقل با CAS'}</button><button className="btn-secondary" disabled={busy} onClick={() => select(null)}>انصراف</button></div>
    </div> : null}
  </section>
}
