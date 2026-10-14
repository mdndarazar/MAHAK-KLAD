import { useCallback, useEffect, useRef, useState } from 'react'
import { call, CH } from '../lib/api'
import { money } from '@shared/jalali'
import { CUSTODY_REFERENCE_VERSION } from '@shared/custodyReference'

const PAGE_SIZE = 100

type Staff = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type BlueRow = {
  snapshotId: number
  handoverId: number | null
  shiftId: number
  role: 'IN' | 'OPENING' | 'FINAL_CLOSE' | 'RECOVERY'
  fromUserId: number
  toUserId: number | null
  day: string
  referenceFromDay: string
  referenceToDay: string
  calculationVersion: string
  countedAmount: number | null
  knownSubtotal: number | null
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  originalReferenceAmount: number | null
  status: 'RESOLVED' | 'PENDING_RECONCILIATION'
  referenceAmount: number | null
  rawDifference: number | null
  freshDifference: number | null
  decision: null | { id: number; kind: string; destinationKind: string | null; destinationEvidenceDay: string | null; destinationEvidenceReference: string | null; managerUserId: number; evidenceDay: string; evidenceReference: string; reason: string; at: string }
}

/** Manager-only UI; Main also requires the current manager session AND the
 * selected manager's personal custody PIN on every append-only decision. */
export function BlueResolutionPanel({ staff }: { staff: Staff[] }) {
  const [rows, setRows] = useState<BlueRow[]>([])
  const [more, setMore] = useState(false)
  const [page, setPage] = useState(0)
  const loadSerial = useRef(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [managerId, setManagerId] = useState<number | ''>('')
  const [pin, setPin] = useState('')
  const [decisionKind, setDecisionKind] = useState('RECEIVED_CASH')
  const [evidenceDay, setEvidenceDay] = useState('')
  const [evidenceReference, setEvidenceReference] = useState('')
  const [destinationDecisionKind, setDestinationDecisionKind] = useState('RECEIVED_CASH')
  const [destinationEvidenceDay, setDestinationEvidenceDay] = useState('')
  const [destinationEvidenceReference, setDestinationEvidenceReference] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const request = ++loadSerial.current
    try {
      const result = await call<{ rows: BlueRow[]; hasMore: boolean }>(CH.custodyBluePendingList, { skip: page * PAGE_SIZE })
      if (request !== loadSerial.current) return
      setRows(result.rows)
      setMore(result.hasMore)
    } catch (e) {
      if (request === loadSerial.current) throw e
    }
  }, [page])
  useEffect(() => {
    void load().catch((e) => setError(e?.message ?? 'شواهد خوانده نشدند.'))
    return () => { loadSerial.current++ }
  }, [load])
  const goToPage = (next: number) => {
    setSelected(null)
    setPin('')
    setEvidenceReference(''); setDestinationEvidenceReference('')
    setRows([])
    setMore(false)
    setError(null)
    setPage(next)
  }
  const managerList = staff.filter((row) => row.role === 'MANAGER' && row.isActive && row.hasCustodyPin && !row.mustChangePin)
  const nameOf = (id: number | null) => staff.find((row) => row.id === id)?.name ?? `کارمند ${id ?? 'نامشخص'}`
  const labelOf = (row: BlueRow) => row.handoverId != null ? `تحویل #${row.handoverId}`
    : `${row.role === 'FINAL_CLOSE' ? 'بستن نهایی' : row.role === 'OPENING' ? 'افتتاح' : 'بازیابی'} شیفت واقعی #${row.shiftId} · سند #${row.snapshotId}`
  const amountOf = (value: number | null) => value == null ? 'نامعلوم' : `${money(value)} ریال`
  const selectedRow = rows.find((row) => row.snapshotId === selected)
  const submit = async () => {
    if (!selectedRow || selectedRow.status !== 'PENDING_RECONCILIATION') return
    setBusy(true)
    setError(null)
    try {
      if (!managerId || !pin.trim()) throw new Error('مدیر و PIN شخصی او را وارد کنید.')
      const hasCredit = Number(selectedRow.ambiguousLegacyCredit) > 0
      const hasDestination = Number(selectedRow.destinationUnknownReceived) > 0
      await call(CH.custodyBlueResolve, {
        snapshotId: selectedRow.snapshotId, managerUserId: managerId, password: pin,
        decisionKind: hasCredit ? decisionKind : 'NO_LEGACY_CREDIT',
        evidenceDay: hasCredit ? evidenceDay.trim() : destinationEvidenceDay.trim(),
        evidenceReference: hasCredit ? evidenceReference.trim() : destinationEvidenceReference.trim(),
        destinationDecisionKind: hasDestination ? destinationDecisionKind : undefined,
        destinationEvidenceDay: hasDestination ? destinationEvidenceDay.trim() : undefined,
        destinationEvidenceReference: hasDestination ? destinationEvidenceReference.trim() : undefined,
        reason: reason.trim(), idempotencyKey: `blue-manager:${crypto.randomUUID()}`
      })
      setSelected(null)
      setPin('')
      setReason('')
      setEvidenceReference(''); setDestinationEvidenceReference('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'تصمیم ثبت نشد.')
      // A lost response can still have committed the append-only decision.
      await load().catch(() => {})
    } finally { setBusy(false) }
  }

  return <div className="space-y-4 text-sm">
    <div className="rounded border border-amber-300 bg-amber-50 p-3 leading-7 text-amber-950">
      <b>سند اولیه تغییر نمی‌کند.</b> مرجع و اختلاف نامعلوم تحویل، افتتاح یا بستن نهایی فقط با شاهد همان بازه تعیین تکلیف می‌شوند. تصمیم بعدی با PIN شخصی مدیر به <b>همان سند اولیه و همان روز</b> افزوده می‌شود؛ «حل شد» به‌تنهایی به معنی مقصر بودن کسی نیست.
    </div>
    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void load().catch((e) => setError(e?.message ?? 'شواهد خوانده نشدند.'))}>تازه‌سازی اسناد</button>
    {error ? <p className="rounded bg-rose-50 p-2 text-rose-900" role="alert">{error}</p> : null}
    <div className="flex flex-wrap items-center gap-3">
      <span>صفحهٔ {page + 1} · حداکثر {PAGE_SIZE} سند در هر صفحه</span>
      <button type="button" className="btn-secondary" disabled={busy || page === 0} onClick={() => goToPage(page - 1)}>صفحهٔ جدیدتر</button>
      <button type="button" className="btn-secondary" disabled={busy || !more} onClick={() => goToPage(page + 1)}>صفحهٔ قدیمی‌تر</button>
    </div>
    {!rows.length ? <p className="text-slate-500">{page === 0 ? 'هنوز سند شمارش، تحویل یا بستن با مقصد نامشخص یا پرداخت قدیمیِ مبهم ثبت نشده است.' : 'در این صفحه سند تکمیل‌شده‌ای وجود ندارد؛ در صورت وجود، صفحهٔ بعد را ببینید.'}</p> : null}
    <div className="space-y-2">
      {rows.map((row) => <div key={row.snapshotId} className="rounded border border-slate-200 bg-white p-3 leading-7">
        <div className="flex flex-wrap justify-between gap-2"><b>{labelOf(row)} · روز {row.day}</b><span className={row.status === 'RESOLVED' ? 'text-emerald-800' : 'text-amber-900'}>{row.status === 'RESOLVED' ? 'تعیین تکلیف شده' : 'در انتظار تطبیق'}</span></div>
        <p>{row.handoverId != null ? `از ${nameOf(row.fromUserId)} به ${nameOf(row.toUserId)}` : `شمارش شخصی ${nameOf(row.fromUserId)}`} · بازهٔ مرجع: {row.referenceFromDay} تا {row.referenceToDay}</p>
        <p>شمارش واقعی {row.handoverId != null ? 'گیرنده' : 'صندوق'}: {amountOf(row.countedAmount)} · بخش معلوم: {amountOf(row.knownSubtotal)} · پرداخت اعتباری قدیمی مبهم: {amountOf(row.ambiguousLegacyCredit)} · دریافتی با مقصد نامشخص: {row.calculationVersion !== CUSTODY_REFERENCE_VERSION ? 'در نسخهٔ قدیمی ثبت نمی‌شد' : amountOf(row.destinationUnknownReceived)}</p>
        <p>مرجع اولیه: <b>نامعلوم</b> · مرجع پس از تصمیم: <b>{amountOf(row.referenceAmount)}</b> · اختلاف خام پس از تصمیم: <b>{amountOf(row.rawDifference)}</b> · اختلاف تازه: <b>{amountOf(row.freshDifference)}</b></p>
        {row.decision ? <div className="rounded bg-emerald-50 p-2 mt-1 text-emerald-950">تصمیم #{row.decision.id} با PIN مدیر {nameOf(row.decision.managerUserId)}:
          {row.decision.kind !== 'NO_LEGACY_CREDIT' ? <div>اعتبار قدیمی: {row.decision.kind} · روز {row.decision.evidenceDay} · سند: {row.decision.evidenceReference}</div> : null}
          {row.decision.destinationKind ? <div>مقصد نامشخص: {row.decision.destinationKind} · روز {row.decision.destinationEvidenceDay} · سند: {row.decision.destinationEvidenceReference}</div> : null}
          <div>توضیح: {row.decision.reason}. تعیین مرجع به‌تنهایی حکم تقصیر نیست.</div>
        </div>
          : row.calculationVersion !== CUSTODY_REFERENCE_VERSION
            ? <p className="mt-2 rounded bg-amber-100 p-2 text-amber-950">مرجع نسخهٔ قدیمی مقصد نامشخص را جدا ثبت نکرده است؛ برای تعیین تکلیف این سند قدیمی بررسی ویژه لازم است، نه تصمیم حدسی. فروش و مسئولیت فعلی ادامه دارند.</p>
          : row.knownSubtotal == null || row.ambiguousLegacyCredit == null || row.destinationUnknownReceived == null ||
            (row.ambiguousLegacyCredit <= 0 && row.destinationUnknownReceived <= 0)
            ? <p className="mt-2 rounded bg-amber-100 p-2 text-amber-950">منبع مالی این مرجع هنوز کامل/قابل‌محاسبه نیست. بدون مبلغ معلوم برای هر جزء مبهم، تصمیم «دریافت شد / نشد» مجاز نیست؛ مرجع و اختلاف همچنان نامعلوم می‌مانند و فروش ادامه دارد.</p>
            : <button className="btn-primary mt-2" disabled={busy} onClick={() => {
              setSelected(row.snapshotId); setEvidenceDay(row.referenceToDay); setDestinationEvidenceDay(row.referenceToDay)
              setPin(''); setEvidenceReference(''); setDestinationEvidenceReference(''); setReason('')
            }}>ثبت شاهد مستقل برای هر مبلغ مبهم با PIN مدیر</button>}
      </div>)}
    </div>
    {selectedRow && selectedRow.status === 'PENDING_RECONCILIATION' ? <div className="rounded border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
      <h3 className="font-bold">تعیین تکلیف افزایشیِ {labelOf(selectedRow)}</h3>
      <p>برای هر مبلغ مبهمِ مثبت شاهدی جدا در همان بازه لازم است؛ تنها بعد از اثبات همهٔ اجزا مرجع معلوم می‌شود. دریافت در کشو/کارت‌خوان به مرجع اضافه می‌شود؛ وجهی که در فروشگاه دریافت نشده باشد اضافه نمی‌شود. این بررسی به‌تنهایی حکم تخلف یا انتساب اختلاف تازه نیست.</p>
      <label className="block">مدیر تصمیم‌گیرنده<select className="input mt-1 w-full" value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{managerList.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label className="block">PIN شخصی همان مدیر<input className="input mt-1 w-full" type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" /></label>
      {selectedRow.ambiguousLegacyCredit != null && selectedRow.ambiguousLegacyCredit > 0 ? <fieldset className="rounded border border-amber-300 bg-white p-2 space-y-2"><legend className="font-bold">پرداخت اعتباری قدیمی مبهم: {amountOf(selectedRow.ambiguousLegacyCredit)}</legend>
        <label className="block">نتیجهٔ بررسی اعتبار<select className="input mt-1 w-full" value={decisionKind} onChange={(e) => setDecisionKind(e.target.value)}><option value="RECEIVED_CASH">رسید نقدیِ همین بازه</option><option value="RECEIVED_CARD">رسید کارت‌خوانِ همین بازه</option><option value="NOT_RECEIVED">در فروشگاه دریافت نشده است</option></select></label>
        <label className="block">روز سند اعتبار (داخل بازه)<input className="input mt-1 w-full" value={evidenceDay} onChange={(e) => setEvidenceDay(e.target.value)} placeholder={selectedRow.referenceToDay} /></label>
        <label className="block">شماره/مشخصات سند اعتبار<input className="input mt-1 w-full" value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} placeholder="رسید اعتبار یا سند اثبات دریافت‌نشدن" /></label>
      </fieldset> : null}
      {selectedRow.destinationUnknownReceived != null && selectedRow.destinationUnknownReceived > 0 ? <fieldset className="rounded border border-sky-300 bg-white p-2 space-y-2"><legend className="font-bold">دریافتی با مقصد نامشخص: {amountOf(selectedRow.destinationUnknownReceived)}</legend>
        <label className="block">نتیجهٔ بررسی مقصد<select className="input mt-1 w-full" value={destinationDecisionKind} onChange={(e) => setDestinationDecisionKind(e.target.value)}><option value="RECEIVED_CASH">به کشوی فروشگاه رسیده است</option><option value="RECEIVED_CARD">به کارت‌خوان فروشگاه رسیده است</option><option value="NOT_RECEIVED">به کشو/کارت‌خوان فروشگاه نرسیده است</option></select></label>
        <label className="block">روز سند مقصد (داخل بازه)<input className="input mt-1 w-full" value={destinationEvidenceDay} onChange={(e) => setDestinationEvidenceDay(e.target.value)} placeholder={selectedRow.referenceToDay} /></label>
        <label className="block">شماره/مشخصات سند مقصد<input className="input mt-1 w-full" value={destinationEvidenceReference} onChange={(e) => setDestinationEvidenceReference(e.target.value)} placeholder="رسید کشو/کارت‌خوان، یا سند اثبات خارج‌بودن وجه" /></label>
      </fieldset> : null}
      <label className="block">توضیح تصمیم (حداقل ۱۰ نویسه)<textarea className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="flex gap-2"><button className="btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'در حال ثبت…' : 'ثبت تصمیم روی همین سند اولیه'}</button><button className="btn-secondary" disabled={busy} onClick={() => { setSelected(null); setPin('') }}>انصراف</button></div>
    </div> : null}
  </div>
}
