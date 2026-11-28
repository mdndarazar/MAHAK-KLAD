import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toLatinDigits } from '@shared/jalali'
import { codeSectionOfPanel, LOCKED_PANELS, type OneTimeCodeSection } from '@shared/panels'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۱۵ و ۲۵-۱۰ — بخش «کدهای یک‌بارمصرف» در «تنظیمات ← رمز مدیر و خروج».
 *
 *   - دو قسمت، هر کدام ۵ کد ۸ رقمی: «حساس» (ماژول‌های پولی، قسمت‌های تازه و همهٔ قفل‌های کار) و «سایر ماژول‌ها».
 *     فهرست داخل پرانتز از همان منبع حقیقت (`panels.ts`) ساخته می‌شود که رفتار را تعیین می‌کند.
 *   - دو مدت کد، هر کدام ۱ تا ۱۰۰۰ دقیقه (دفتر آزمون ۴-۲۸)؛ «قفل کار» با کد همان یک بار است.
 *   - ساخت (تصادفی یا «خودم می‌نویسم»)، باطل کردن، برداشتن قفل کدها و دو مدت کد همه «کلیدسازی»اند: رمز تایپی
 *     مدیر (کادر خام، هرگز نشانگر نشست)، حتی وقتی نشست مدیر باز است.
 *   - کدها فقط همین یک بار، هنگام ساخت، نشان داده و چاپ می‌شوند؛ main فقط hash نمک‌دار نگه می‌دارد.
 * ===========================================================================
 */
type SectionStatus = { total: number; remaining: number; createdAt: number } | null
type Status = { broken: boolean; lockedMs: number; sections: Record<OneTimeCodeSection, SectionStatus>; sensitiveCodeMinutes: number; otherCodeMinutes: number }
type Created = { section: OneTimeCodeSection; codes: Array<{ n: number; code: string }> }

const TITLES: Record<OneTimeCodeSection, string> = {
  sensitive: 'کدهای یک‌بارمصرف ماژول‌های پولی «حساس»',
  other: 'کدهای یک‌بارمصرف سایر ماژول‌ها'
}

function printCodes(created: Created): void {
  const rows = created.codes.map((c) => `<tr><td>${c.n}</td><td dir="ltr" style="unicode-bidi:isolate;font-size:20px;letter-spacing:3px">${c.code}</td><td>☐</td></tr>`).join('')
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>کدهای یک‌بارمصرف</title><style>body{font-family:Tahoma,sans-serif;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:8px 14px;text-align:center}</style></head><body><h3>${TITLES[created.section]}</h3><table><tr><th>شماره</th><th>کد</th><th>مصرف شد</th></tr>${rows}</table><p>برگه را جای امن نگه دارید و جای مشترک ننویسید. اگر گم شد، «باطل کردن کدهای این قسمت» را بزنید. پس از مصرف هر کد، همان شماره را خط بزنید.</p></body></html>`
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'; frame.style.width = '0'; frame.style.height = '0'; frame.style.border = '0'
  frame.srcdoc = html
  frame.onload = () => { try { frame.contentWindow?.print() } finally { setTimeout(() => frame.remove(), 1000) } }
  document.body.appendChild(frame)
}

export default function OneTimeCodesSettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [ownFor, setOwnFor] = useState<OneTimeCodeSection | null>(null)
  const [own, setOwn] = useState<string[]>(['', '', '', '', ''])
  const [minutes, setMinutes] = useState<{ sensitive: string; other: string }>({ sensitive: '', other: '' })

  const lists = useMemo(() => {
    const money = LOCKED_PANELS.filter((p) => p.kind === 'part' && p.tier === 'money').map((p) => p.title)
    const fresh = LOCKED_PANELS.filter((p) => p.kind === 'part' && p.tier === 'sensitive').map((p) => p.title)
    const other = LOCKED_PANELS.filter((p) => codeSectionOfPanel(p.key) === 'other').map((p) => p.title)
    return { money, fresh, other }
  }, [])

  const load = useCallback(async () => {
    try {
      const s = await call<Status>(CH.locksCodesStatus)
      setStatus(s)
      setMinutes({ sensitive: String(s.sensitiveCodeMinutes), other: String(s.otherCodeMinutes) })
    } catch { setStatus(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<string | void>) => {
    if (busy) return
    if (!password) { setMessage({ ok: false, text: 'برای این کار «رمز مدیر» را در همین بخش تایپ کنید.' }); return }
    setBusy(true)
    setMessage(null)
    try {
      const text = await fn()
      setPassword('')
      if (text) setMessage({ ok: true, text })
      await load()
    } catch (e: any) {
      setMessage({ ok: false, text: e?.message || 'انجام نشد.' })
    } finally {
      setBusy(false)
    }
  }
  const create = (section: OneTimeCodeSection, mode: 'random' | 'own') => run(async () => {
    const result = await call<Created>(CH.locksCodesCreate, { section, mode, managerPassword: password, ...(mode === 'own' ? { codes: own } : {}) })
    setCreated(result)
    setOwnFor(null)
    setOwn(['', '', '', '', ''])
    return 'پنج کد تازه ساخته شد؛ کدهای قبلی همین قسمت باطل شد. کدها فقط همین حالا دیده می‌شوند.'
  })
  const revoke = (section: OneTimeCodeSection) => run(async () => {
    if (!confirm(`همهٔ «${TITLES[section]}» باطل شوند؟`)) return
    await call(CH.locksCodesRevoke, { section, managerPassword: password })
    if (created?.section === section) setCreated(null)
    return 'کدهای این قسمت باطل شد.'
  })
  const unlock = () => run(async () => {
    await call(CH.locksCodesUnlock, { managerPassword: password })
    return 'قفل ورود کدها برداشته شد.'
  })
  const saveMinutes = () => run(async () => {
    const s = Number(toLatinDigits(minutes.sensitive).trim()), o = Number(toLatinDigits(minutes.other).trim())
    if (![s, o].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new Error('هر مدت باید عددی صحیح بین ۱ تا ۱۰۰۰ دقیقه باشد.')
    await call(CH.lockDurationsSet, { managerPassword: password, sensitiveCodeMinutes: s, otherCodeMinutes: o })
    return `مدت کد «حساس» ${faDigits(s)} و کد «سایر ماژول‌ها» ${faDigits(o)} دقیقه شد. قفلی که همین حالا باز است با عدد قبلی بسته می‌شود.`
  })

  const section = (key: OneTimeCodeSection) => {
    const st = status?.sections[key] ?? null
    return (
      <div className="rounded border p-3 space-y-2">
        <div className="font-bold">{TITLES[key]}</div>
        <div className="kbd leading-6">
          {key === 'sensitive'
            ? <>({lists.money.join('، ')}؛ و قسمت‌های تازهٔ {lists.fresh.join('، ')}؛ و همهٔ «قفل‌های کار»، هر کد برای یک بار)</>
            : <>({lists.other.join('، ')})</>}
        </div>
        {key === 'sensitive' && (
          <div className="kbd leading-6 text-rose-800">
            این کدها ماژول‌های پولی را باز می‌کنند. فقط به کارمندی بدهید که به او اعتماد کامل دارید. هر مصرف همان لحظه با ⚠️ در تلگرام و بله می‌آید.
          </div>
        )}
        <div>
          وضعیت: {status?.broken ? <b className="text-rose-700">پروندهٔ کدها خراب بود؛ همه باطل است. کد تازه بسازید.</b>
            : st ? <b>{faDigits(st.remaining)} از {faDigits(st.total)} کد باقی است</b> : <b>هنوز کدی ساخته نشده است</b>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={() => void create(key, 'random')}>ساخت ۵ کد تازه (تصادفی)</button>
          <button className="btn" disabled={busy} onClick={() => setOwnFor(ownFor === key ? null : key)}>خودم می‌نویسم…</button>
          <button className="btn btn-ghost" disabled={busy || !st} onClick={() => void revoke(key)}>باطل کردن کدهای این قسمت</button>
        </div>
        {ownFor === key && (
          <div className="rounded bg-slate-50 border p-2 space-y-2">
            <div className="kbd leading-6">
              پنج کد ۸ رقمی بنویسید: همه یک رقم نباشد، پشت‌سرهم نباشد، تکراری نباشد و برابر رمز مدیر یا هیچ رمز دوم و سومی نباشد.
              تاریخ تولد، شمارهٔ تلفن و شمارهٔ فروشگاه را کد نکنید.
            </div>
            <div className="flex flex-wrap gap-2">
              {own.map((value, i) => (
                <input key={i} className="inp w-32 text-center" dir="ltr" style={{ unicodeBidi: 'isolate' }} inputMode="numeric" autoComplete="off"
                  maxLength={12} placeholder={`کد ${faDigits(i + 1)}`} value={value} disabled={busy}
                  onChange={(e) => setOwn((list) => list.map((x, j) => (j === i ? e.target.value : x)))} />
              ))}
            </div>
            <button className="btn btn-primary" disabled={busy || own.some((x) => !x.trim())} onClick={() => void create(key, 'own')}>ثبت همین ۵ کد</button>
          </div>
        )}
        <label className="block">
          <span className="block mb-1">مدت باز ماندن با کد این قسمت (۱ تا ۱۰۰۰ دقیقه)</span>
          <input className="inp w-24 text-center" dir="ltr" inputMode="numeric" value={minutes[key]} disabled={busy}
            onChange={(e) => setMinutes((m) => ({ ...m, [key]: e.target.value }))} />
        </label>
      </div>
    )
  }

  return (
    <section className="space-y-2" dir="rtl">
      <h2 className="font-bold border-b pb-1">کدهای یک‌بارمصرف</h2>
      <div className="kbd leading-6">
        وقتی پشت رایانه نیستید، یک کد را تلفنی به فروشنده بگویید تا همان قفل را یک بار باز کند؛ رمز شما لو نمی‌رود. هر کد فقط یک بار
        کار می‌کند و قسمت را برای مدت همان قسمت باز می‌کند (یک «قفل کار» را فقط یک بار). پس از ۵ کد اشتباه، ورود کد ۱۵ دقیقه قفل می‌شود.
        برگه را وقتی بسازید که کسی کنارتان نیست؛ آن را جای مشترک ننویسید؛ اگر گم شد، «باطل کردن کدهای این قسمت» را بزنید.
        «بستن همه» و توقف اضطراری کدها را باطل نمی‌کنند.
      </div>
      <label className="block max-w-xs">
        <span className="block mb-1">رمز مدیر (برای ساخت، باطل کردن، برداشتن قفل و مدت‌ها)</span>
        <input className="inp w-full" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {status && status.lockedMs > 0 && (
        <div className="rounded px-3 py-2 border-2 bg-rose-50 border-rose-400 flex flex-wrap items-center gap-2">
          <b>ورود کد پس از ۵ تلاش اشتباه قفل است ({faDigits(Math.ceil(status.lockedMs / 60_000))} دقیقهٔ دیگر).</b>
          <button className="btn" disabled={busy} onClick={() => void unlock()}>برداشتن قفل کدها</button>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {section('sensitive')}
        {section('other')}
      </div>
      <button className="btn" disabled={busy} onClick={() => void saveMinutes()}>ذخیرهٔ دو مدت کد</button>
      {created && (
        <div className="rounded border-2 border-amber-400 bg-amber-50 p-3 space-y-2">
          <div className="font-bold">{TITLES[created.section]} — فقط همین یک بار دیده می‌شوند</div>
          <ol className="space-y-1">
            {created.codes.map((c) => (
              <li key={c.n}>شمارهٔ {faDigits(c.n)}: <b dir="ltr" style={{ unicodeBidi: 'isolate' }} className="text-lg tracking-widest">{c.code}</b></li>
            ))}
          </ol>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => printCodes(created)}>چاپ برگه</button>
            <button className="btn" onClick={() => setCreated(null)}>یادداشت کردم؛ پنهان شود</button>
          </div>
        </div>
      )}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>{message.text}</div>
      )}
    </section>
  )
}
