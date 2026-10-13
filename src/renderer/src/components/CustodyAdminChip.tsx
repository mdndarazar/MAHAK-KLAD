import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { call, CH } from '../lib/api'
import { money } from '@shared/jalali'
import { useManagerSession } from '../hooks/useManagerSession'

/** This small Settings-only workspace deliberately owns no staff profile fields
 * and has no schedule/ShiftPlan writer. Shift Settings is the canonical place
 * for names, days, times, assigned people and handover policy. */
type Staff = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type LegacyPlan = { id: number; title: string; startMinute: number; durationMinutes: number; daysMask: number; isActive: boolean; reminderRepeatMin: number; staffIds: number[] }
type LegacyRecoveryReport = {
  id: number; createdAt: string; witnessName: string | null; countedCash: number; expectedTotalSnapshot: number | null; provisionalDifference: number | null; differenceScope: string; note: string | null; itemCount: number
  items: Array<{ id: number; shiftId: number; legacyUserName: string | null; invoiceCountSnapshot: number; expectedCalcStatus: string }>
  opening: null | { openingShiftId: number; openingCountedCash: number; gapCash: number; reason: string | null; openerName: string | null; at: string }
}
type Report = {
  summary: { handovers: number; unresolvedOpen: number; dispositionPending: number; totalCountDifference: number; legacyRecoveries?: number; legacyRecoveryReviews?: number; legacyRecoveriesAwaitingOpening?: number }
  counts: Array<{ id: number; at: string; shiftId: number; kind: string; countedCash: number; expectedCash: number | null; differenceCash: number | null; countedByName?: string | null }>
  legacyRecoveries?: LegacyRecoveryReport[]
  legacyRecoveryReviews?: Array<{ id: number; recoveryId: number; itemId: number | null; decision: string; actorName: string | null; reason: string; createdAt: string }>
}

type DiscrepancyReport = {
  from: string; to: string; status: 'ALL' | 'OPEN' | 'CLOSED'
  page: { skip: number; take: number; hasMore: boolean }
  summary: { allCases: number; openCases: number; closedCases: number; net: number; shortages: number; overages: number }
  cases: Array<{
    id: number; boundaryId: number; status: 'OPEN' | 'CLOSED'; boundaryKind: string; fromShiftId: number | null; toShiftId: number | null; detectedAt: string; operationalDay: string
    operationalExpectedTotal: number; theoreticalExpectedTotal: number; observedOperationalTotal: number; differenceAmount: number; totalTheoreticalDifference: number
    closedAt: string | null; closedByName: string | null; currentReviewResult: string | null
    reviews: Array<{ id: number; action: string; managerName: string | null; actorKind: string; result: string | null; note: string; at: string }>
  }>
}

type Tab = 'credentials' | 'legacy' | 'report'
const asTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** Entry point is rendered only in Settings > Custody. It is intentionally not
 * a top-bar management control; day-to-day operations remain in CustodyChip. */
export function CustodyAdminChip() {
  const { isManager } = useManagerSession()
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const reload = useCallback(async () => {
    try { setEnabled((await call<{ enabled: boolean }>(CH.custodyStatus, {})).enabled) } catch { setEnabled(false) }
  }, [])
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 60_000); return () => window.clearInterval(timer) }, [reload])
  if (!isManager || !enabled) return null
  return (
    <div className="contents">
      <button className="text-xs px-2 py-1 rounded whitespace-nowrap font-bold bg-indigo-700 hover:bg-indigo-800" onClick={() => setOpen(true)}>اعتبارنامه و سوابق حضانت</button>
      {open ? <CustodyAdminModal onClose={() => { setOpen(false); void reload() }} /> : null}
    </div>
  )
}

function CustodyAdminModal({ onClose }: { onClose: () => void }) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [legacyPlans, setLegacyPlans] = useState<LegacyPlan[]>([])
  const [selectedStaffId, setSelectedStaffId] = useState<number | ''>('')
  const [temporaryPin, setTemporaryPin] = useState('')
  const [pinReason, setPinReason] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyReport | null>(null)
  const [discrepancyFrom, setDiscrepancyFrom] = useState('')
  const [discrepancyTo, setDiscrepancyTo] = useState('')
  const [discrepancyStatus, setDiscrepancyStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL')
  const [discrepancySkip, setDiscrepancySkip] = useState(0)
  const [reviewRecoveryId, setReviewRecoveryId] = useState<number | ''>('')
  const [reviewReason, setReviewReason] = useState('')
  const [tab, setTab] = useState<Tab>('credentials')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [people, planRows] = await Promise.all([
        call<Staff[]>(CH.custodyStaffList, {}),
        call<LegacyPlan[]>(CH.custodyPlanList, {})
      ])
      setStaff(people)
      setLegacyPlans(planRows)
    } catch (reason: any) { setError(reason?.message ?? 'داده‌های حضانت خوانده نشد.') }
  }, [])
  useEffect(() => { void load() }, [load])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work(); await load() }
    catch (reason: any) { setError(reason?.message ?? 'عملیات انجام نشد.') }
    finally { setBusy(false) }
  }
  const loadDiscrepancies = async (skip = discrepancySkip) => {
    const next = await call<DiscrepancyReport>(CH.custodyDiscrepancyReport, {
      from: discrepancyFrom.trim() || undefined,
      to: discrepancyTo.trim() || undefined,
      status: discrepancyStatus,
      take: 50,
      skip
    })
    setDiscrepancies(next)
  }
  const summary = useMemo(() => report?.summary ?? null, [report])
  const operationalStaff = staff.filter((person) => person.isActive && (person.role === 'MANAGER' || person.role === 'CASHIER'))

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-black/55 overflow-auto p-4" dir="rtl">
      <section className="max-w-5xl mx-auto my-6 bg-white text-slate-800 rounded-lg shadow-xl p-5">
        <div className="flex items-start gap-3 border-b pb-3">
          <div className="flex-1">
            <h2 className="font-bold text-lg">حضانت صندوق: اعتبارنامه و بازبینی سابقه</h2>
            <p className="text-xs text-slate-500 mt-1">پیکربندی شیفت‌های جدید فقط در تب «شیفت‌ها»ی Settings انجام می‌شود.</p>
          </div>
          <button className="btn-secondary" onClick={onClose}>بستن</button>
        </div>
        {error ? <div className="my-3 p-2 bg-red-50 text-red-700 rounded text-sm">{error}</div> : null}
        <div className="my-4 p-3 rounded border border-indigo-100 bg-indigo-50 text-sm text-indigo-950">
          این بخش با نشست اصلی و فعال مدیر در همین پنجره محافظت می‌شود. رمز دوم پنل یا دادهٔ Renderer برای اختیار مدیریتی معتبر نیست.
        </div>
        <div className="flex gap-2 border-b mb-4">
          <button className={`px-3 py-2 ${tab === 'credentials' ? 'border-b-2 border-brand font-bold' : ''}`} onClick={() => setTab('credentials')}>رمز موقت</button>
          <button className={`px-3 py-2 ${tab === 'report' ? 'border-b-2 border-brand font-bold' : ''}`} onClick={() => setTab('report')}>گزارش کنترل</button>
        </div>

        {tab === 'credentials' ? <div className="max-w-xl space-y-3">
          <div>
            <h3 className="font-bold mb-2">صدور یا بازنشانی رمز موقت حضانت</h3>
            <p className="text-sm leading-6 text-slate-600">پرونده، نام و نقش کارمند در تب «کارمندان» Settings ثبت می‌شود. رمز خام قبلی هرگز نمایش داده نمی‌شود؛ کارمند باید رمز موقت خود را در نخستین ورود تغییر دهد.</p>
          </div>
          <label className="text-sm block">کارمند
            <select className="input mt-1 w-full" value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value ? Number(event.target.value) : '')}>
              <option value="">انتخاب کنید…</option>
              {operationalStaff.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.role} · {person.hasCustodyPin ? (person.mustChangePin ? 'رمز موقت' : 'رمز فعال') : 'بدون رمز'}</option>)}
            </select>
          </label>
          <label className="text-sm block">رمز موقت تازه (حداقل ۶ کاراکتر)<input className="input mt-1 w-full" type="password" value={temporaryPin} onChange={(event) => setTemporaryPin(event.target.value)} /></label>
          <label className="text-sm block">دلیل تغییر رمز<input className="input mt-1 w-full" value={pinReason} onChange={(event) => setPinReason(event.target.value)} /></label>
          <button className="btn-primary" disabled={busy || !selectedStaffId} onClick={() => void run(async () => {
            if (temporaryPin.length < 6 || pinReason.trim().length < 3) throw new Error('رمز حداقل ۶ کاراکتر و دلیل حداقل ۳ حرف لازم است.')
            await call(CH.custodyPinSet, { userId: selectedStaffId, newPassword: temporaryPin, reason: pinReason.trim() })
            setTemporaryPin(''); setPinReason('')
          })}>صدور رمز موقت</button>
        </div> : null}

        {tab === 'legacy' ? <div className="space-y-3">
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
            این‌ها داده‌های سازگار با نسخه‌های قبل‌اند. حذف یا تبدیل خودکار نشده‌اند تا سابقهٔ گذشته سالم بماند؛ ایجاد، ویرایش و حذف برنامهٔ قدیمی از این صفحه عمداً ممکن نیست. برای برنامهٔ عملیاتی تازه از «تنظیمات › شیفت‌ها» استفاده کنید.
          </div>
          {legacyPlans.length ? <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>عنوان</th><th>شروع</th><th>مدت</th><th>یادآوری</th><th>کارکنان قدیمی</th><th>وضعیت</th></tr></thead><tbody>
            {legacyPlans.map((plan) => <tr key={plan.id}><td>{plan.title}</td><td>{asTime(plan.startMinute)}</td><td>{plan.durationMinutes} دقیقه</td><td>هر {plan.reminderRepeatMin} دقیقه</td><td>{plan.staffIds.length}</td><td>{plan.isActive ? 'فعال در دادهٔ قدیمی' : 'غیرفعال'}</td></tr>)}
          </tbody></table></div> : <p className="text-sm text-slate-500">برنامهٔ قدیمی ثبت نشده است.</p>}
        </div> : null}

        {tab === 'report' ? <div>
          <div className="flex flex-wrap gap-2 items-end rounded border bg-slate-50 p-3">
            <label className="text-sm">از تاریخ جلالی<input className="input mt-1" dir="ltr" placeholder="۱۴۰۵/۰۷/۲۰" value={discrepancyFrom} onChange={(event) => { setDiscrepancySkip(0); setDiscrepancyFrom(event.target.value) }} /></label>
            <label className="text-sm">تا تاریخ جلالی<input className="input mt-1" dir="ltr" placeholder="۱۴۰۵/۰۷/۲۵" value={discrepancyTo} onChange={(event) => { setDiscrepancySkip(0); setDiscrepancyTo(event.target.value) }} /></label>
            <label className="text-sm">وضعیت<select className="input mt-1" value={discrepancyStatus} onChange={(event) => { setDiscrepancySkip(0); setDiscrepancyStatus(event.target.value as 'ALL' | 'OPEN' | 'CLOSED') }}><option value="ALL">همه</option><option value="OPEN">باز</option><option value="CLOSED">بسته</option></select></label>
            <button className="btn-primary" disabled={busy} onClick={() => void run(async () => {
              setDiscrepancySkip(0)
              const [next, nextDiscrepancies] = await Promise.all([
                call<Report>(CH.custodyReport, {}),
                call<DiscrepancyReport>(CH.custodyDiscrepancyReport, { from: discrepancyFrom.trim() || undefined, to: discrepancyTo.trim() || undefined, status: discrepancyStatus, take: 50, skip: 0 })
              ])
              setReport(next)
              setDiscrepancies(nextDiscrepancies)
              setReviewRecoveryId(next.legacyRecoveries?.[0]?.id ?? '')
            })}>تهیه گزارش مدیر</button>
          </div>
          {summary ? <>
            <div className="grid md:grid-cols-4 gap-3 my-4 text-sm"><Info label="تحویل‌ها" value={summary.handovers} /><Info label="شب‌های باز" value={summary.unresolvedOpen} /><Info label="تعیین تکلیف تأییدنشده" value={summary.dispositionPending} /><Info label="جمع اختلاف شمارش" value={money(summary.totalCountDifference)} /><Info label="بازیابی Shift قدیمی" value={summary.legacyRecoveries ?? 0} /><Info label="بازبینی‌های بازیابی" value={summary.legacyRecoveryReviews ?? 0} /></div>
            {discrepancies ? <DiscrepancyCasesPanel report={discrepancies} busy={busy} onRefresh={() => void run(loadDiscrepancies)} onPage={(skip) => { setDiscrepancySkip(skip); void run(() => loadDiscrepancies(skip)) }} /> : null}
            {(report?.legacyRecoveries?.length ?? 0) > 0 ? <div className="mt-6 space-y-3"><div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><b>بازیابی‌های Shift قدیمی</b><p className="mt-1">شاهدِ بازیابی مالک فروش‌ها، کسری‌ها یا اضافه‌های تاریخی نیست. شمارش بازیابی سند فیزیکی است و فقط شمارش افتتاح جداگانه، مسئولیت segment تازه را شروع می‌کند.</p></div><div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>زمان</th><th>شاهد</th><th>Shiftهای قدیمی</th><th>شمارش شاهد</th><th>افتتاح مستقل</th><th>مرز/اختلاف</th></tr></thead><tbody>{report?.legacyRecoveries?.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('fa-IR')}</td><td>{row.witnessName ?? '—'}</td><td>{row.items.map((item) => `#${item.shiftId}${item.legacyUserName ? ` (${item.legacyUserName})` : ''}`).join('، ')}</td><td>{money(row.countedCash)}</td><td>{row.opening ? `Shift #${row.opening.openingShiftId} · ${money(row.opening.openingCountedCash)} · ${row.opening.openerName ?? '—'}` : 'هنوز افتتاح مستقل ثبت نشده'}</td><td>{row.opening ? `${money(row.opening.gapCash)}${row.opening.reason ? ` · ${row.opening.reason}` : ''}` : '—'}</td></tr>)}</tbody></table></div><div className="rounded border bg-slate-50 p-3"><h4 className="font-bold text-sm">ثبت یادداشت بازبینی (افزایشی)</h4><p className="mt-1 text-xs text-slate-600">این یادداشت هیچ مبلغ، مسئولیت، فروش یا Shift قدیمی را تغییر نمی‌دهد.</p><div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_2fr_auto]"><select className="input" value={reviewRecoveryId} onChange={(event) => setReviewRecoveryId(event.target.value ? Number(event.target.value) : '')}>{report?.legacyRecoveries?.map((row) => <option key={row.id} value={row.id}>بازیابی #{row.id}</option>)}</select><input className="input" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="یادداشت بازبینی (حداقل ۳ حرف)" /><button className="btn-primary" disabled={busy || !reviewRecoveryId} onClick={() => void run(async () => { if (reviewReason.trim().length < 3) throw new Error('یادداشت بازبینی باید حداقل ۳ حرف باشد.')
                await call(CH.custodyLegacyRecoveryReview, { recoveryId: reviewRecoveryId, reason: reviewReason.trim(), idempotencyKey: `legacy-review-${crypto.randomUUID()}`, decision: 'NOTE' })
                const next = await call<Report>(CH.custodyReport, {})
                setReport(next); setReviewReason('')
              })}>ثبت یادداشت</button></div></div>{(report?.legacyRecoveryReviews?.length ?? 0) > 0 ? <div className="overflow-auto"><h4 className="font-bold text-sm mt-3">آخرین بازبینی‌های ثبت‌شده</h4><table className="w-full text-sm"><thead><tr><th>زمان</th><th>بازیابی</th><th>بازبین</th><th>یادداشت</th></tr></thead><tbody>{report?.legacyRecoveryReviews?.slice(0, 20).map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('fa-IR')}</td><td>#{row.recoveryId}</td><td>{row.actorName ?? 'نشست مدیر'}</td><td>{row.reason}</td></tr>)}</tbody></table></div> : null}</div> : null}
            <h3 className="font-bold mt-6">آخرین شمارش‌ها</h3>
            <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>زمان</th><th>شیفت</th><th>نوع</th><th>شمارش</th><th>انتظار</th><th>اختلاف</th><th>ثبت‌کننده</th></tr></thead><tbody>
              {report?.counts.slice(0, 20).map((row) => <tr key={row.id}><td>{new Date(row.at).toLocaleString('fa-IR')}</td><td>{row.shiftId}</td><td>{row.kind}</td><td>{money(row.countedCash)}</td><td>{row.expectedCash == null ? '—' : money(row.expectedCash)}</td><td>{row.differenceCash == null ? '—' : money(row.differenceCash)}</td><td>{row.countedByName ?? '—'}</td></tr>)}
            </tbody></table></div>
          </> : <p className="mt-3 text-sm text-slate-500">گزارش فقط در نشست فعال مدیر خوانده می‌شود.</p>}
        </div> : null}
      </section>
    </div>,
    document.body
  )
}

function DiscrepancyCasesPanel({ report, busy, onRefresh, onPage }: { report: DiscrepancyReport; busy: boolean; onRefresh: () => void; onPage: (skip: number) => void }) {
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [results, setResults] = useState<Record<number, string>>({})
  const [workingCase, setWorkingCase] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const review = async (row: DiscrepancyReport['cases'][number], action: 'CLOSE' | 'REOPEN') => {
    const note = String(notes[row.id] ?? '').trim()
    const result = String(results[row.id] ?? '').trim()
    if (note.length < 10) return setError('برای بستن یا بازگشایی پرونده، یادداشت روشنِ حداقل ۱۰ حرف لازم است.')
    if (action === 'CLOSE' && !result) return setError('برای بستن پرونده، نتیجهٔ بازبینی را مشخص کنید.')
    setWorkingCase(row.id); setError(null)
    try {
      await call(CH.custodyDiscrepancyReview, { caseId: row.id, action, note, result: result || undefined, idempotencyKey: `discrepancy-${row.id}-${action}-${crypto.randomUUID()}` })
      setNotes((prior) => ({ ...prior, [row.id]: '' }))
      setResults((prior) => ({ ...prior, [row.id]: '' }))
      onRefresh()
    } catch (reason: any) { setError(reason?.message ?? 'بازبینی پرونده ثبت نشد.') }
    finally { setWorkingCase(null) }
  }
  const exportPage = async () => {
    setError(null)
    try { await call(CH.custodyDiscrepancyExport, { from: report.from, to: report.to, status: report.status, take: report.page.take, skip: report.page.skip }) }
    catch (reason: any) { setError(reason?.message ?? 'خروجی پرونده‌های مغایرت ساخته نشد.') }
  }
  return <section className="mt-6 rounded border-2 border-rose-200 bg-rose-50/40 p-3">
    <div className="flex flex-wrap justify-between gap-3 items-start"><div><h3 className="font-bold text-rose-950">پرونده‌های مغایرت کشو و کارت‌خوان</h3><p className="text-xs mt-1 text-slate-600">بازهٔ جلالی {report.from} تا {report.to} · شواهد اولیه و اختلاف هرگز با بستن پرونده تغییر نمی‌کنند.</p></div><div className="flex gap-2"><button className="btn-secondary text-sm" disabled={busy || workingCase != null} onClick={() => void exportPage()}>خروجی همین صفحه</button><button className="btn-secondary text-sm" disabled={busy || workingCase != null} onClick={onRefresh}>تازه‌سازی</button></div></div>
    {error ? <p className="mt-3 rounded bg-red-100 p-2 text-sm text-red-800">{error}</p> : null}
    <div className="grid grid-cols-2 md:grid-cols-6 gap-2 my-3 text-sm"><Info label="همه" value={report.summary.allCases} /><Info label="باز" value={report.summary.openCases} /><Info label="بسته" value={report.summary.closedCases} /><Info label="کسری" value={money(Math.abs(Math.min(0, report.summary.shortages)))} /><Info label="اضافه" value={money(Math.max(0, report.summary.overages))} /><Info label="خالص" value={money(report.summary.net)} /></div>
    {!report.cases.length ? <p className="text-sm text-slate-600">در این بازه پرونده‌ای ثبت نشده است.</p> : <div className="space-y-3">{report.cases.map((row) => <details key={row.id} className="rounded border bg-white p-3"><summary className="cursor-pointer flex flex-wrap justify-between gap-2"><span><b>پرونده #{row.id}</b> · {row.status === 'OPEN' ? 'باز' : 'بسته'} · {row.boundaryKind}</span><span className={row.differenceAmount < 0 ? 'text-red-700 font-bold' : 'text-emerald-700 font-bold'}>{money(row.differenceAmount)} ریال</span></summary><div className="mt-3 space-y-3 text-sm"><div className="grid md:grid-cols-4 gap-2"><Info label="روز عملیاتی" value={row.operationalDay} /><Info label="نظری مدیر" value={money(row.theoreticalExpectedTotal)} /><Info label="انتظار عملیاتی" value={money(row.operationalExpectedTotal)} /><Info label="شمارش کور" value={money(row.observedOperationalTotal)} /></div><p className="text-xs text-slate-600">Shift قبلی: {row.fromShiftId ?? '—'} · Shift بعدی: {row.toShiftId ?? '—'} · زمان ثبت: {new Date(row.detectedAt).toLocaleString('fa-IR')} · اختلاف کل نظری در همان مرز: {money(row.totalTheoreticalDifference)} ریال</p>{row.currentReviewResult ? <p className="rounded bg-emerald-50 p-2 text-emerald-900">نتیجهٔ فعلی مدیر: {row.currentReviewResult}</p> : null}<div className="rounded border bg-slate-50 p-3"><div className="font-bold">بازبینی مدیر</div><div className="grid md:grid-cols-2 gap-2 mt-2"><input className="input" value={results[row.id] ?? ''} onChange={(event) => setResults((prior) => ({ ...prior, [row.id]: event.target.value }))} placeholder="نتیجهٔ بازبینی؛ برای بستن اجباری" /><textarea className="input" value={notes[row.id] ?? ''} onChange={(event) => setNotes((prior) => ({ ...prior, [row.id]: event.target.value }))} placeholder="یادداشت مدیر؛ حداقل ۱۰ حرف" /></div><div className="flex gap-2 mt-2">{row.status === 'OPEN' ? <button className="btn-primary" disabled={busy || workingCase === row.id} onClick={() => void review(row, 'CLOSE')}>✓ بررسی شد / بستن پرونده</button> : <button className="btn-secondary" disabled={busy || workingCase === row.id} onClick={() => void review(row, 'REOPEN')}>بازگشایی پرونده</button>}</div></div>{row.reviews.length ? <div><div className="font-bold mb-1">سابقهٔ افزایشی بازبینی</div><ul className="space-y-1">{row.reviews.map((review) => <li key={review.id} className="rounded bg-slate-50 p-2">{new Date(review.at).toLocaleString('fa-IR')} · {review.action} · {review.managerName ?? (review.actorKind === 'MANAGER_SESSION' ? 'نشست مدیر' : 'مدیر')} {review.result ? `· ${review.result}` : ''}<br />{review.note}</li>)}</ul></div> : null}</div></details>)}</div>}
    <div className="flex justify-between items-center mt-3 text-sm"><span>نمایش از {report.page.skip + 1}</span><div className="flex gap-2"><button className="btn-secondary" disabled={busy || report.page.skip === 0} onClick={() => onPage(Math.max(0, report.page.skip - report.page.take))}>صفحه قبل</button><button className="btn-secondary" disabled={busy || !report.page.hasMore} onClick={() => onPage(report.page.skip + report.page.take)}>صفحه بعد</button></div></div>
  </section>
}

function Info({ label, value }: { label: string; value: unknown }) {
  return <div className="rounded border bg-slate-50 p-3"><div className="text-slate-500">{label}</div><b>{String(value)}</b></div>
}
