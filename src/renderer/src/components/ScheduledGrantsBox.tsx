import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, jalaliToday } from '@shared/jalali'
import { LOCKED_PANELS } from '@shared/panels'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۱۶ (مورد ۱۴-ب) — «مجوزهای زمان‌بندی‌شده» در صفحهٔ «کنترل از راه دور با گوشی».
 *
 *   - یک قسمت (نه «قفل کار»)، یک روز از امروز تا ۷ روز بعد، ساعت شروع و پایان (حداکثر ۶۰ دقیقه) به ساعت رسمی برنامه،
 *     و یادداشت اختیاری؛ حداکثر ۱۰ مجوز فعال؛ یک بار، بی تکرار.
 *   - در آن بازه همان قسمت برای همهٔ پنجره‌های برنامه باز است و بی‌کاری آن را نمی‌بندد؛ سر ساعت پایان بسته می‌شود.
 *   - ساخت و لغو «کلیدسازی»اند: رمز تایپی مدیر (کادر خام). بی اینترنت و بی هاب هم کار می‌کند.
 *   - تغییر ساعت ویندوز (بیش از ۲ دقیقه) همهٔ مجوزهای زمان‌بندی‌شده را لغو می‌کند و ⚠️ خبر می‌دهد.
 * ===========================================================================
 */
type Grant = { id: string; panel: string; titleFa: string; span: string; state: 'PENDING' | 'OPEN' | 'DONE' | 'CANCELED'; reason: string | null; note: string }
type List = { offsetMinutes: number; grants: Grant[] }
const STATE: Record<Grant['state'], string> = { PENDING: 'در انتظار', OPEN: 'باز است', DONE: 'پایان یافت', CANCELED: 'لغو شد' }

export default function ScheduledGrantsBox() {
  const parts = useMemo(() => LOCKED_PANELS.filter((p) => p.kind === 'part'), [])
  const [list, setList] = useState<List | null>(null)
  const [panel, setPanel] = useState<string>(parts[0]?.key ?? '')
  const [day, setDay] = useState(jalaliToday())
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [note, setNote] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try { setList(await call<List>(CH.scheduledGrantsList)) } catch { setList(null) }
  }, [])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const run = async (fn: () => Promise<List>, done: string) => {
    if (busy) return
    if (!password) { setMessage({ ok: false, text: 'برای این کار «رمز مدیر» را تایپ کنید.' }); return }
    setBusy(true); setMessage(null)
    try { setList(await fn()); setPassword(''); setMessage({ ok: true, text: done }) }
    catch (e: any) { setMessage({ ok: false, text: e?.message || 'انجام نشد.' }) }
    finally { setBusy(false) }
  }
  const create = () => run(() => call<List>(CH.scheduledGrantsCreate, { panel, day, start, end, note, managerPassword: password }),
    'مجوز زمان‌بندی‌شده ساخته شد. سر ساعت شروع، برای همهٔ پنجره‌های برنامه باز می‌شود.')
  const cancel = (id: string) => run(() => call<List>(CH.scheduledGrantsCancel, { id, managerPassword: password }), 'مجوز لغو شد.')

  const active = (list?.grants ?? []).filter((g) => g.state === 'PENDING' || g.state === 'OPEN')
  const past = (list?.grants ?? []).filter((g) => g.state !== 'PENDING' && g.state !== 'OPEN').slice(0, 10)
  return (
    <div className="bg-white rounded shadow p-4 space-y-3" dir="rtl">
      <h2 className="font-bold">مجوزهای زمان‌بندی‌شده (بی اینترنت)</h2>
      <div className="kbd leading-6">
        یک قسمت را برای یک بازهٔ معین (حداکثر ۶۰ دقیقه، از امروز تا ۷ روز بعد) باز کنید؛ مثلاً «انبار مرکزی، امروز، ۱۶:۰۰ تا ۱۷:۰۰».
        در آن بازه همان قسمت برای همهٔ پنجره‌های برنامه باز است و بی‌کاری آن را نمی‌بندد. فقط یک بار اجرا می‌شود.
        ساعت، همان ساعت رسمی برنامه است{list && list.offsetMinutes ? ` (افست ${faDigits(list.offsetMinutes / 60)} ساعت)` : ''}. اگر ساعت ویندوز جابه‌جا شود، همهٔ این مجوزها لغو می‌شوند.
        «بستن همه» و P1 مجوز باز را می‌بندند؛ «توقف اضطراری کامل» (P2) مجوزهای آینده را هم لغو می‌کند. «قفل‌های کار» با این مجوز باز نمی‌شوند.
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block mb-1">قسمت</span>
          <select className="inp" value={panel} disabled={busy} onChange={(e) => setPanel(e.target.value)}>
            {parts.map((p) => <option key={p.key} value={p.key}>{p.group ? `${p.group} › ` : ''}{p.title}{p.tier === 'money' ? ' (پولی)' : ''}</option>)}
          </select>
        </label>
        <label className="block"><span className="block mb-1">روز</span>
          <input className="inp w-32 text-center" dir="ltr" value={day} disabled={busy} onChange={(e) => setDay(e.target.value)} placeholder="1405/09/02" />
        </label>
        <label className="block"><span className="block mb-1">از ساعت</span>
          <input className="inp w-24 text-center" dir="ltr" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} placeholder="16:00" />
        </label>
        <label className="block"><span className="block mb-1">تا ساعت</span>
          <input className="inp w-24 text-center" dir="ltr" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} placeholder="17:00" />
        </label>
        <label className="block"><span className="block mb-1">یادداشت (اختیاری)</span>
          <input className="inp w-48" value={note} maxLength={120} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !start || !end || !day} onClick={() => void create()}>ساخت مجوز زمان‌بندی‌شده</button>
      </div>
      {active.length ? (
        <ul className="space-y-1">
          {active.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
              <b>{g.titleFa}</b><span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{faDigits(g.span)}</span>
              <span className={g.state === 'OPEN' ? 'text-emerald-700 font-bold' : 'text-slate-600'}>{STATE[g.state]}</span>
              {g.note ? <span className="kbd">«{g.note}»</span> : null}
              <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel(g.id)}>لغو</button>
            </li>
          ))}
        </ul>
      ) : <div className="kbd">مجوز زمان‌بندی‌شدهٔ فعالی نیست.</div>}
      {past.length ? (
        <details><summary className="cursor-pointer kbd">مجوزهای گذشته</summary>
          <ul className="space-y-1 mt-1">{past.map((g) => <li key={g.id} className="kbd">{g.titleFa} · <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{faDigits(g.span)}</span> · {STATE[g.state]}{g.reason ? ` (${g.reason})` : ''}</li>)}</ul>
        </details>
      ) : null}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>{message.text}</div>
      )}
    </div>
  )
}
