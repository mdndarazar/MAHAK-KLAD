import { useEffect, useState } from 'react'
import { useBlocker, useNavigate } from 'react-router-dom'
import { call, CH } from '../lib/api'
import { faDigits, money, toJalaliDate, toJalaliDateTime } from '@shared/jalali'
import type { CashClosingHistoryResult, CashClosingHistoryRow } from '@shared/cashClosingHistory'

const eventLabels: Record<CashClosingHistoryRow['kind'], string> = {
  HANDOVER: 'تحویل انجام‌شده',
  EMERGENCY_COVER: 'پوشش اضطراری انجام‌شده',
  MASTER_OVERRIDE: 'تحویل با تأیید مدیر',
  FINAL_CLOSE: 'بستن نهایی انجام‌شده',
  LEGACY_CLOSE: 'بستن ثبت‌شده در سیستم قدیمی'
}
function person(row: CashClosingHistoryRow['from']) {
  if (!row) return '—'
  const id = row.userId == null ? '' : ` (شناسه ${faDigits(row.userId)})`
  const shift = row.shiftId == null ? '' : ` · نشست ${faDigits(row.shiftId)}`
  const absent = row.presence === 'ABSENT_UNCOUNTED' ? ' · فرد قبلی غایب؛ بدون شمارش از او' : ''
  return `${row.currentName ?? 'نام نامعلوم'}${id}${shift}${absent}`
}
function storedReference(row: CashClosingHistoryRow) {
  switch (row.reference.state) {
    case 'KNOWN_V2': return <><b className="text-sky-950">{money(row.reference.amount)} ریال</b><small className="block">مرجع آبی ثبت‌شده در لحظهٔ رویداد</small></>
    case 'KNOWN_V1': return <><b>{money(row.reference.amount)} ریال</b><small className="block text-amber-900">نسخهٔ قدیمی v1؛ با مرجع v2 قابل مقایسه نیست.</small></>
    case 'PENDING_V2':
    case 'PENDING_V1': return <><b>در انتظار تطبیق در همان لحظه</b>{row.reference.knownSubtotal != null ? <small className="block">بخش معلوم: {money(row.reference.knownSubtotal)} ریال؛ این مبلغ مرجع نیست.</small> : null}{row.reference.state === 'PENDING_V1' ? <small className="block">نسخهٔ قدیمی v1</small> : null}</>
    case 'NOT_RECORDED': return 'برای این سابقه، مبلغ مرجع آبی ثبت نشده است.'
    case 'INCONSISTENT': return <b className="text-rose-800">سند ناسازگار؛ مبلغ نامعلوم</b>
  }
}
function HistoryTable({ rows }: { rows: CashClosingHistoryRow[] }) {
  if (!rows.length) return null
  return <div className="overflow-auto border rounded bg-white">
    <table className="min-w-[1060px] w-full text-sm text-right" dir="rtl">
      <thead className="bg-slate-100 border-b"><tr>{['زمان تکمیل', 'رویداد', 'مسئول / نشست قبلی', 'مسئول / نشست بعدی', 'مرجع آبی همان لحظه', 'دامنهٔ مرجع', 'تصمیم بعدی مدیر'].map((x) => <th key={x} className="p-2">{x}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.source}-${row.sourceId}`} className="border-b align-top">
        <td className="p-2 whitespace-nowrap">{faDigits(toJalaliDateTime(new Date(row.occurredAt)))}</td>
        <td className="p-2"><b>{eventLabels[row.kind]}</b>{row.legacyRepeat && <small className="block text-amber-900">بستن دوباره/اصلاحیه؛ خارج از شمارنده</small>}{row.reason && <small className="block text-slate-600">دلیل ثبت‌شده: {row.reason}</small>}{row.evidenceWarning && <small className="block text-rose-800">{row.evidenceWarning}</small>}</td>
        <td className="p-2">{person(row.from)}</td>
        <td className="p-2">{row.kind === 'FINAL_CLOSE' || row.kind === 'LEGACY_CLOSE' ? '—' : person(row.to)}</td>
        <td className="p-2 min-w-44">{storedReference(row)}</td>
        <td className="p-2 min-w-40">{row.reference.fromDay ? <>{faDigits(row.reference.fromDay)}{row.reference.toDay !== row.reference.fromDay ? ` تا ${faDigits(row.reference.toDay ?? '')}` : ''}<small className="block">{row.reference.scopeKind === 'PRIOR_AND_TODAY' ? 'دیروز و امروز در نخستین شمارش' : 'روز تقویمی ثبت‌شده'}</small></> : '—'}</td>
        <td className="p-2">{row.laterDecision ? <><span className="block">{money(row.laterDecision.amount)} ریال</span><small>تصمیم بعدی در {faDigits(toJalaliDateTime(new Date(row.laterDecision.at)))}</small><small className="block">{row.laterDecision.managerCurrentName ?? 'مدیر'} (شناسه {faDigits(row.laterDecision.managerUserId)})</small></> : '—'}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

function ReadOnlyHistory({ onAuthorizationLost }: { onAuthorizationLost: () => void }) {
  const [from, setFrom] = useState(() => { const day = new Date(); day.setDate(day.getDate() - 30); return toJalaliDate(day) })
  const [to, setTo] = useState(() => toJalaliDate(new Date()))
  const [report, setReport] = useState<CashClosingHistoryResult | null>(null)
  const [rows, setRows] = useState<CashClosingHistoryRow[]>([])
  const [legacyRows, setLegacyRows] = useState<CashClosingHistoryRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [legacyNext, setLegacyNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const load = async () => {
    setLoading(true); setError(null); setReport(null); setRows([]); setLegacyRows([]); setNext(null); setLegacyNext(null); setExportMessage(null)
    try {
      const result = await call<CashClosingHistoryResult>(CH.cashClosingHistory, { fromJalali: from, toJalali: to })
      setReport(result); setRows(result.rows); setLegacyRows(result.legacy.rows)
      setNext(result.page.nextCursor); setLegacyNext(result.legacy.page.nextCursor)
    } catch (err: any) {
      if (err?.code === 'REPORT_MANAGER_REQUIRED') onAuthorizationLost()
      else setError(err?.message ?? 'گزارش بارگذاری نشد.')
    }
    finally { setLoading(false) }
  }
  const more = async (stream: 'CUSTODY' | 'LEGACY') => {
    const cursor = stream === 'CUSTODY' ? next : legacyNext
    if (!report || !cursor) return
    setLoading(true); setError(null)
    try {
      const result = await call<CashClosingHistoryResult>(CH.cashClosingHistory, {
        fromJalali: report.range.fromJalali, toJalali: report.range.toJalali,
        snapshotToken: report.snapshotToken, cursor
      })
      if (result.snapshotToken !== report.snapshotToken) throw new Error('نسخهٔ ثابت گزارش تغییر کرده است؛ گزارش را دوباره بگیرید.')
      if (stream === 'CUSTODY') { setRows((old) => [...old, ...result.rows]); setNext(result.page.nextCursor) }
      else { setLegacyRows((old) => [...old, ...result.legacy.rows]); setLegacyNext(result.legacy.page.nextCursor) }
    } catch (err: any) {
      if (err?.code === 'REPORT_MANAGER_REQUIRED') onAuthorizationLost()
      else {
        setError(err?.message ?? 'ادامهٔ گزارش بارگذاری نشد.')
        if (err?.code === 'REPORT_SNAPSHOT_EXPIRED') { setReport(null); setRows([]); setLegacyRows([]); setNext(null); setLegacyNext(null) }
      }
    } finally { setLoading(false) }
  }
  const exportReport = async () => {
    if (!report) return
    setExporting(true); setError(null); setExportMessage(null)
    try {
      const out = await call<{ canceled: boolean; path: string | null; rows: number }>(CH.cashClosingHistoryExport, { snapshotToken: report.snapshotToken, format: 'csv' })
      if (!out.canceled) setExportMessage(`فایل گزارشِ همین نسخهٔ ثابت، با ${faDigits(out.rows)} ردیف ذخیره شد: ${out.path ?? ''}`)
    } catch (err: any) {
      if (err?.code === 'REPORT_MANAGER_REQUIRED') onAuthorizationLost()
      else {
        setError(err?.message ?? 'خروجی ذخیره نشد.')
        if (err?.code === 'REPORT_SNAPSHOT_EXPIRED') { setReport(null); setRows([]); setLegacyRows([]); setNext(null); setLegacyNext(null) }
      }
    } finally { setExporting(false) }
  }
  const editFilter = (which: 'from' | 'to', value: string) => {
    if (which === 'from') setFrom(value); else setTo(value)
    // Never silently display the old range under newly edited dates.
    setReport(null); setRows([]); setLegacyRows([]); setNext(null); setLegacyNext(null); setError(null)
  }
  return <div className="space-y-4" dir="rtl">
    <header className="space-y-2"><h1 className="text-xl font-bold">گزارش بستن و تحویل صندوق</h1>
      <p className="text-sm leading-7 text-slate-700">فقط بستن‌ها و تحویل‌های واقعاً تکمیل‌شده نمایش داده می‌شوند؛ گذشت زمان یا دیدن این گزارش رویداد نمی‌سازد. مبلغ آبی، مرجع ثبت‌شده برای کنترل صندوق و کارت‌خوان در همان لحظه است، نه شمارش اسکناس کشو یا اختلاف آن.</p></header>
    <div className="flex flex-wrap items-end gap-3 rounded border bg-white p-4">
      <label className="text-sm font-semibold">از تاریخ شمسی<input className="inp mt-1 block" inputMode="numeric" dir="ltr" value={from} onChange={(e) => editFilter('from', e.target.value)} placeholder="۱۴۰۵/۰۷/۰۱" /></label>
      <label className="text-sm font-semibold">تا تاریخ شمسی<input className="inp mt-1 block" inputMode="numeric" dir="ltr" value={to} onChange={(e) => editFilter('to', e.target.value)} placeholder="۱۴۰۵/۰۷/۳۰" /></label>
      <button className="btn" disabled={loading} onClick={() => void load()}>{loading ? 'در حال خواندن…' : 'گرفتن گزارش'}</button>
      <span className="text-xs text-slate-600">مبنای تاریخ: روز تقویمی محلی، زمان تکمیل رویداد</span>
    </div>
    {error && <p className="rounded border border-amber-400 bg-amber-50 p-3 text-amber-950" role="alert">{error}</p>}
    {report && <>
      <div className="rounded border bg-white p-3 text-sm flex flex-wrap gap-x-4 gap-y-2 items-center">
        <span>بازهٔ تأییدشده: <b>{faDigits(report.range.fromJalali)} تا {faDigits(report.range.toJalali)}</b> (روز تقویمی محلی)</span>
        <span>نسخهٔ ثابت در {faDigits(toJalaliDateTime(new Date(report.snapshotAt)))}؛ اگر منقضی شود، دوباره گزارش بگیرید.</span>
        <button className="btn" disabled={loading || exporting} onClick={() => void exportReport()}>{exporting ? 'در حال ساخت فایل…' : 'خروجی CSV همین گزارش'}</button>
      </div>
      {exportMessage && <p className="rounded bg-emerald-50 border border-emerald-300 p-2 text-sm">{exportMessage}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border-2 border-sky-200 bg-sky-50 p-4"><div>تحویل‌های واقعیِ کامل در کل بازه</div><b className="text-2xl">{faDigits(report.totals.handovers)}</b><div className="text-xs">عادی {faDigits(report.totals.handoversByKind.normal)} · اضطراری {faDigits(report.totals.handoversByKind.emergency)} · تأیید مدیر {faDigits(report.totals.handoversByKind.override)}</div></div>
        <div className="rounded border-2 border-slate-200 bg-white p-4"><div>بستن‌های واقعی صندوق در کل بازه</div><b className="text-2xl">{faDigits(report.totals.finalClosings)}</b><div className="text-xs">حضانتی {faDigits(report.totals.custodyFinalClosings)} · قدیمی {faDigits(report.totals.legacyCloses)}؛ تکرارِ تأییدشده حساب نمی‌شود. سوابق قدیمی در بخش جدا نمایش داده می‌شوند.</div></div>
      </div>
      {report.warnings.map((w) => <p key={w} className="rounded bg-amber-50 border border-amber-300 p-2 text-sm text-amber-950">{w}</p>)}
      {!rows.length && !legacyRows.length && report.totals.handovers === 0 && report.totals.finalClosings === 0 && report.totals.legacyCloses === 0 ? <p className="rounded border bg-white p-5">در این بازه هیچ بستن یا تحویل واقعی ثبت نشده است.</p> : null}
      {report.totals.handovers + report.totals.custodyFinalClosings > 0 && <section className="space-y-2"><h2 className="font-bold">بستن و تحویل‌های تکمیل‌شده</h2><HistoryTable rows={rows} />{next && <button className="btn" disabled={loading} onClick={() => void more('CUSTODY')}>نمایش قدیمی‌تر</button>}</section>}
      {report.totals.legacyCloses + report.totals.legacyCorrections > 0 && <section className="space-y-2"><h2 className="font-bold">بستن‌های واقعیِ سیستم قدیمی · {faDigits(report.totals.legacyCloses)} بستن، {faDigits(report.totals.legacyCorrections)} ثبت تکراری/اصلاحیه</h2><p className="text-xs text-slate-700">برای این سوابق، مبلغ مرجع آبی آن زمان ثبت نشده است؛ از عدد فعلی یا شمارش کشو برای پر کردن آن استفاده نمی‌شود.</p><HistoryTable rows={legacyRows} />{legacyNext && <button className="btn" disabled={loading} onClick={() => void more('LEGACY')}>نمایش قدیمی‌ترِ بستن‌های قدیمی</button>}</section>}
      <p className="text-xs text-slate-600">شمارنده‌ها برای کل نتیجه‌اند، نه فقط ردیف‌های همین صفحه. نام افراد، نام فعلی است؛ شناسهٔ پایدارشان کنار نام نمایش داده می‌شود.</p>
    </>}
  </div>
}

/** History has its own report-safe authorization boundary. The Main endpoint
 * checks the current manager login independently; a panel-specific PIN or
 * disabled operational panel lock never grants access to this sensitive report.
 * No Shell, ManagerSessionProvider or operational page is mounted here. */
export default function CashCloseHistory() {
  const nav = useNavigate()
  // Native/browser Back after coming from the landing is already safe. A
  // directly opened history URL may instead have an unrelated/operational
  // route behind it: intercept that POP BEFORE it can mount Shell/rollover.
  const blocker = useBlocker(({ currentLocation, nextLocation, historyAction }) =>
    historyAction === 'POP' && currentLocation.pathname === '/cash-close/history' &&
    nextLocation.pathname !== '/cash-close'
  )
  useEffect(() => {
    if (blocker.state === 'blocked') {
      blocker.reset()
      nav('/cash-close', { replace: true })
    }
  }, [blocker, nav])
  const [access, setAccess] = useState<'checking' | 'manager' | 'denied'>('checking')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const session = await call<{ manager: boolean }>(CH.managerSessionStatus)
        if (active) setAccess(session.manager ? 'manager' : 'denied')
      } catch { if (active) setAccess('denied') }
    }
    void refresh()
    // Only the in-memory manager-session status is checked; there is no
    // operational/custody/shift status timer on this page.
    const id = window.setInterval(() => void refresh(), 30_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { active = false; window.clearInterval(id); window.removeEventListener('focus', onFocus) }
  }, [])
  const login = async () => {
    if (!password.trim()) return setError('رمز مدیر را وارد کنید.')
    setBusy(true); setError(null)
    try {
      await call(CH.managerVerify, { password })
      setPassword(''); setAccess('manager')
    } catch (err: any) { setPassword(''); setError(err?.message ?? 'ورود مدیر تأیید نشد.') }
    finally { setBusy(false) }
  }
  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 sm:p-6 text-slate-900">
    <div className="mx-auto max-w-7xl space-y-4">
      <button className="btn" onClick={() => nav('/cash-close')}>بازگشت به بستن صندوق</button>
      {access === 'checking' && <p>در حال بررسی دسترسی گزارش…</p>}
      {access === 'denied' && <div className="max-w-lg rounded border bg-white p-5 space-y-3">
        <h1 className="font-bold text-lg">تاریخچهٔ بستن صندوق · ورود مدیر</h1>
        <p className="text-sm">این گزارش به نشست مدیر نیاز دارد. رمز اختصاصیِ عملیات بستن صندوق برای گزارش کافی نیست؛ همچنان می‌توانید از صفحهٔ قبل وارد عملیات شوید.</p>
        <input className="inp w-full" type="password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void login() }} aria-label="رمز مدیر برای گزارش" />
        {error && <p className="rounded bg-amber-50 p-2 text-sm" role="alert">{error}</p>}
        <button className="btn" disabled={busy} onClick={() => void login()}>{busy ? 'در حال بررسی…' : 'ورود به گزارش'}</button>
      </div>}
      {access === 'manager' && <ReadOnlyHistory onAuthorizationLost={() => setAccess('denied')} />}
    </div>
  </main>
}
