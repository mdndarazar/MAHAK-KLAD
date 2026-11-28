import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, jalaliToday } from '@shared/jalali'
import { GATE_IRREVERSIBLE_ACTIONS } from '@shared/gateCatalog'
import { lockKindLists, type LockKindItem } from '@shared/panels'
import JalaliDateInput from './JalaliDateInput'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۱۶ (مورد ۱۴-ب) — «مجوزهای زمان‌بندی‌شده» در صفحهٔ «کنترل از راه دور با گوشی».
 *
 *   - دفتر آزمون ۴-۴۷ (با ۴-۱۳): چند ماژول و چند قفل کار با هم (فهرست همان سازندهٔ ۴-۳۲؛ نُه کار برگشت‌ناپذیر و
 *     «کلیدسازی» نیستند)، از روز … تا روز … (روز اول امروز تا ۷ روز بعد، حداکثر ۳۱ روز)، هر روز از ساعت … تا …
 *     (حداکثر ۱۰۰۰ دقیقه، بی گذر از ساعت ۲۴) به ساعت رسمی برنامه، برای «همه» یا یک کارمند، و یادداشت اختیاری؛
 *     حداکثر ۱۰ مجوز فعال (هر برنامهٔ چندروزه یکی).
 *   - در آن ساعت‌ها ماژول‌ها برای همهٔ پنجره‌های برنامه باز است و بی‌کاری آن را نمی‌بندد؛ قفل کارِ تیک‌خورده هر چند بار
 *     لازم باشد باز است. با یک کارمند، فقط وقتی صندوق دست همان کارمند است.
 *   - ساخت و لغو «کلیدسازی»اند: رمز تایپی مدیر (کادر خام). بی اینترنت و بی هاب هم کار می‌کند.
 *   - تغییر ساعت ویندوز (بیش از ۲ دقیقه) همهٔ مجوزهای زمان‌بندی‌شده را لغو می‌کند و ⚠️ خبر می‌دهد.
 * ===========================================================================
 */
type Grant = {
  id: string; panels: string[]; titles: string[]; titleFa: string; span: string; days: number; userName: string | null
  state: 'PENDING' | 'OPEN' | 'DONE' | 'CANCELED'; reason: string | null; note: string
}
type List = { offsetMinutes: number; custody: boolean; staff: Array<{ id: number; name: string }>; grants: Grant[] }
const STATE: Record<Grant['state'], string> = { PENDING: 'در انتظار', OPEN: 'باز است', DONE: 'پایان یافت', CANCELED: 'لغو شد' }
const NEVER = new Set<string>(GATE_IRREVERSIBLE_ACTIONS)

/** ۴-۴۷: فهرست تیک‌دار از همان سه فهرست ۴-۳۲؛ نُه کار برگشت‌ناپذیر بیرون می‌مانند. */
function pickGroups(): Array<{ title: string; items: LockKindItem[] }> {
  const lists = lockKindLists()
  return [
    { title: 'ماژول‌های معمولی', items: lists.normal },
    { title: 'ماژول‌های پولی و حساس', items: lists.sensitive },
    ...lists.actions.map((g) => ({ title: `قفل‌های کار › ${g.group}`, items: g.items.filter((i) => !NEVER.has(i.id)) })).filter((g) => g.items.length)
  ]
}

export default function ScheduledGrantsBox() {
  const groups = useMemo(() => pickGroups(), [])
  const [list, setList] = useState<List | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [fromDay, setFromDay] = useState(jalaliToday())
  const [toDay, setToDay] = useState(jalaliToday())
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [userId, setUserId] = useState('')
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
  useEffect(() => { if (list && !list.custody && userId) setUserId('') }, [list, userId])

  const toggle = (id: string) => setPicked((now) => now.includes(id) ? now.filter((x) => x !== id) : [...now, id])
  const run = async (fn: () => Promise<List>, done: string) => {
    if (busy) return
    if (!password) { setMessage({ ok: false, text: 'برای این کار «رمز مدیر» را تایپ کنید.' }); return }
    setBusy(true); setMessage(null)
    try { setList(await fn()); setPassword(''); setMessage({ ok: true, text: done }) }
    catch (e: any) { setMessage({ ok: false, text: e?.message || 'انجام نشد.' }) }
    finally { setBusy(false) }
  }
  const create = () => run(async () => {
    const next = await call<List>(CH.scheduledGrantsCreate, { panels: picked, fromDay, toDay, start, end, userId: userId || null, note, managerPassword: password })
    setPicked([])
    return next
  }, userId ? 'مجوز زمان‌بندی‌شده ساخته شد. هر روز سر ساعت شروع باز می‌شود، فقط وقتی صندوق دست همان کارمند است.'
    : 'مجوز زمان‌بندی‌شده ساخته شد. هر روز سر ساعت شروع، برای همهٔ پنجره‌های برنامه باز می‌شود.')
  const cancel = (id: string) => run(() => call<List>(CH.scheduledGrantsCancel, { id, managerPassword: password }), 'مجوز لغو شد.')

  const active = (list?.grants ?? []).filter((g) => g.state === 'PENDING' || g.state === 'OPEN')
  const past = (list?.grants ?? []).filter((g) => g.state !== 'PENDING' && g.state !== 'OPEN').slice(0, 10)
  const span = (g: Grant) => <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{faDigits(g.span)}</span>
  return (
    <div className="bg-white rounded shadow p-4 space-y-3" dir="rtl">
      <h2 className="font-bold">مجوزهای زمان‌بندی‌شده (بی اینترنت)</h2>
      <div className="kbd leading-6">
        چند ماژول یا قفل کار را برای چند روز، هر روز در ساعت‌های معین باز کنید؛ مثلاً «انبار مرکزی و جابه‌جایی کالا، از فردا تا پس‌فردا، هر روز ۹:۰۰ تا ۱۷:۰۰».
        روز اول از امروز تا ۷ روز بعد و کل بازه حداکثر ۳۱ روز است؛ ساعت روزانه حداکثر ۱۰۰۰ دقیقه است و از ساعت ۲۴ نمی‌گذرد.
        در آن ساعت‌ها ماژول‌ها برای همهٔ پنجره‌های برنامه باز است و بی‌کاری آن را نمی‌بندد؛ قفل کارِ تیک‌خورده هر چند بار لازم باشد باز است.
        با «یک کارمند مشخص»، فقط وقتی صندوق دست همان کارمند است (با رمز خودش باز کرده یا تحویل گرفته)؛ اگر کارمند دیگری صندوق را بگیرد، دوباره قفل می‌شود.
        برنامه نمی‌بیند چه کسی واقعاً پشت رایانه است؛ اگر آن کارمند رایانه را رها کند، دیگری هم در همان ساعت‌ها می‌تواند کار کند.
        ساعت، همان ساعت رسمی برنامه است{list && list.offsetMinutes ? ` (افست ${faDigits(list.offsetMinutes / 60)} ساعت)` : ''}. اگر ساعت ویندوز جابه‌جا شود، همهٔ این مجوزها لغو می‌شوند.
        «بستن همه» و P1 فقط پنجرهٔ بازِ همان روز را می‌بندند و روزهای بعد طبق برنامه باز می‌شوند؛ «توقف اضطراری کامل» (P2) همه را لغو می‌کند.
        «کلیدسازی» و نُه کار برگشت‌ناپذیر در این فهرست نیستند.
      </div>
      <div className="rounded border max-h-64 overflow-auto p-2 space-y-2">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="font-bold text-sm">{g.title}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {g.items.map((item) => (
                <label key={item.id} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={picked.includes(item.id)} disabled={busy} onChange={() => toggle(item.id)} />
                  <span>{item.title}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="kbd">{picked.length ? `${faDigits(picked.length)} مورد انتخاب شده است.` : 'هنوز چیزی انتخاب نشده است.'}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block mb-1">از تاریخ</span>
          <JalaliDateInput value={fromDay} onChange={(v) => { setFromDay(v); if (toDay < v) setToDay(v) }} />
        </label>
        <label className="block"><span className="block mb-1">تا تاریخ</span>
          <JalaliDateInput value={toDay} onChange={setToDay} />
        </label>
        <label className="block"><span className="block mb-1">هر روز از ساعت</span>
          <input className="inp w-24 text-center" dir="ltr" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} placeholder="09:00" />
        </label>
        <label className="block"><span className="block mb-1">تا ساعت</span>
          <input className="inp w-24 text-center" dir="ltr" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} placeholder="17:00" />
        </label>
        <label className="block"><span className="block mb-1">برای</span>
          <select className="inp" value={userId} disabled={busy || !list?.custody} onChange={(e) => setUserId(e.target.value)}>
            <option value="">همه</option>
            {(list?.staff ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
        </label>
        <label className="block"><span className="block mb-1">یادداشت (اختیاری)</span>
          <input className="inp w-48" value={note} maxLength={120} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {list && !list.custody ? <div className="kbd">حضانت صندوق خاموش است؛ مجوز فقط برای «همه» ساخته می‌شود.</div> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !picked.length || !start || !end || !fromDay || !toDay} onClick={() => void create()}>ساخت مجوز زمان‌بندی‌شده</button>
      </div>
      {active.length ? (
        <ul className="space-y-1">
          {active.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
              <b title={g.titles.join('، ')}>{g.titleFa}</b>{span(g)}{g.days > 1 ? <span className="kbd">هر روز، {faDigits(g.days)} روز</span> : null}
              <span className="kbd">{g.userName ? `فقط با صندوقِ ${g.userName}` : 'برای همه'}</span>
              <span className={g.state === 'OPEN' ? 'text-emerald-700 font-bold' : 'text-slate-600'}>{STATE[g.state]}</span>
              {g.note ? <span className="kbd">«{g.note}»</span> : null}
              <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel(g.id)}>لغو</button>
            </li>
          ))}
        </ul>
      ) : <div className="kbd">مجوز زمان‌بندی‌شدهٔ فعالی نیست.</div>}
      {past.length ? (
        <details><summary className="cursor-pointer kbd">مجوزهای گذشته</summary>
          <ul className="space-y-1 mt-1">{past.map((g) => <li key={g.id} className="kbd">{g.titleFa} · {span(g)}{g.userName ? ` · ${g.userName}` : ''} · {STATE[g.state]}{g.reason ? ` (${g.reason})` : ''}</li>)}</ul>
        </details>
      ) : null}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>{message.text}</div>
      )}
    </div>
  )
}
