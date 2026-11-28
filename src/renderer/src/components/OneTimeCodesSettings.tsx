import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toLatinDigits } from '@shared/jalali'
import { LOCK_KIND_HELP, lockKindLists } from '@shared/panels'
import { KindHelpList } from './RemoteGrantControls'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۳-۱۵ و ۲۵-۱۰ — بخش «کدهای یک‌بارمصرف» در «تنظیمات ← رمز مدیر و خروج».
 *
 *   - دفتر آزمون ۴-۴۵: یک جعبه و یک دستهٔ ۵ کد ۸ رقمی؛ هر کد روی همهٔ ماژول‌ها و قفل‌های کار یک بار، جز «کلیدسازی».
 *     ساخت تازه همهٔ کدهای قبلی را باطل می‌کند؛ کدهای دو دستهٔ قبلی تا آن موقع روی همه کار می‌کنند.
 *   - دو مدت کد، هر کدام ۱ تا ۱۰۰۰ دقیقه (دفتر آزمون ۴-۲۸)، از نوع چیزی که باز می‌شود: «ماژول‌های پولی» (و قفل‌های
 *     کار، که با کد همان یک بار است) و «سایر ماژول‌ها». فهرست زیر هر مدت از همان منبع حقیقت (`panels.ts`) است.
 *   - ساخت (تصادفی یا «خودم می‌نویسم»)، باطل کردن، برداشتن قفل کدها و دو مدت کد همه «کلیدسازی»اند: رمز تایپی
 *     مدیر (کادر خام، هرگز نشانگر نشست)، حتی وقتی نشست مدیر باز است.
 *   - کدها فقط همین یک بار، هنگام ساخت، نشان داده و چاپ می‌شوند؛ main فقط hash نمک‌دار نگه می‌دارد.
 * ===========================================================================
 */
type CodesState = { total: number; remaining: number; createdAt: number; groups: number } | null
type Status = { broken: boolean; lockedMs: number; codes: CodesState; sensitiveCodeMinutes: number; otherCodeMinutes: number }
type Created = { codes: Array<{ n: number; code: string }> }

function printCodes(created: Created): void {
  const rows = created.codes.map((c) => `<tr><td>${c.n}</td><td dir="ltr" style="unicode-bidi:isolate;font-size:20px;letter-spacing:3px">${c.code}</td><td>☐</td></tr>`).join('')
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>کدهای یک‌بارمصرف</title><style>body{font-family:Tahoma,sans-serif;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:8px 14px;text-align:center}</style></head><body><h3>کدهای یک‌بارمصرف</h3><table><tr><th>شماره</th><th>کد</th><th>مصرف شد</th></tr>${rows}</table><p>هر کد روی همهٔ ماژول‌ها و قفل‌های کار یک بار کار می‌کند، جز «کلیدسازی». برگه را جای امن نگه دارید و جای مشترک ننویسید. اگر گم شد، «باطل کردن کدها» را بزنید. پس از مصرف هر کد، همان شماره را خط بزنید.</p></body></html>`
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
  const [ownOpen, setOwnOpen] = useState(false)
  const [own, setOwn] = useState<string[]>(['', '', '', '', ''])
  const [minutes, setMinutes] = useState<{ sensitive: string; other: string }>({ sensitive: '', other: '' })

  // دفتر آزمون ۴-۳۲: همان فهرست‌های راهنمای صفحهٔ «کنترل از راه دور» (`lockKindLists`؛ مرز همان `codeSectionOfPanel`)
  const lists = useMemo(() => lockKindLists(), [])

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
  const create = (mode: 'random' | 'own') => run(async () => {
    const result = await call<Created>(CH.locksCodesCreate, { mode, managerPassword: password, ...(mode === 'own' ? { codes: own } : {}) })
    setCreated(result)
    setOwnOpen(false)
    setOwn(['', '', '', '', ''])
    return 'پنج کد تازه ساخته شد؛ همهٔ کدهای قبلی باطل شد. کدها فقط همین حالا دیده می‌شوند.'
  })
  const revoke = () => run(async () => {
    if (!confirm('همهٔ کدهای یک‌بارمصرف باطل شوند؟')) return
    await call(CH.locksCodesRevoke, { managerPassword: password })
    setCreated(null)
    return 'همهٔ کدها باطل شد.'
  })
  const unlock = () => run(async () => {
    await call(CH.locksCodesUnlock, { managerPassword: password })
    return 'قفل ورود کدها برداشته شد.'
  })
  const saveMinutes = () => run(async () => {
    const s = Number(toLatinDigits(minutes.sensitive).trim()), o = Number(toLatinDigits(minutes.other).trim())
    if (![s, o].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new Error('هر مدت باید عددی صحیح بین ۱ تا ۱۰۰۰ دقیقه باشد.')
    await call(CH.lockDurationsSet, { managerPassword: password, sensitiveCodeMinutes: s, otherCodeMinutes: o })
    return `مدت باز ماندن ماژول‌های پولی ${faDigits(s)} و سایر ماژول‌ها ${faDigits(o)} دقیقه شد. قفلی که همین حالا باز است با عدد قبلی بسته می‌شود.`
  })

  const st = status?.codes ?? null
  return (
    <section className="space-y-2" dir="rtl">
      <h2 className="font-bold border-b pb-1">کدهای یک‌بارمصرف</h2>
      <div className="kbd leading-6">
        وقتی پشت رایانه نیستید، یک کد را تلفنی به فروشنده بگویید تا همان قفل را یک بار باز کند؛ رمز شما لو نمی‌رود. هر کد روی همهٔ
        ماژول‌ها و همهٔ قفل‌های کار فقط یک بار کار می‌کند، جز «کلیدسازی»؛ ماژول را برای مدت نوع همان ماژول باز می‌کند (یک «قفل کار»
        را فقط یک بار). پس از ۵ کد اشتباه، ورود کد ۱۵ دقیقه قفل می‌شود. برگه را وقتی بسازید که کسی کنارتان نیست؛ آن را جای مشترک
        ننویسید؛ اگر گم شد، «باطل کردن کدها» را بزنید. «بستن همه» و توقف اضطراری کدها را باطل نمی‌کنند.
      </div>
      <label className="block max-w-xs">
        <span className="block mb-1">رمز مدیر (برای ساخت، باطل کردن، برداشتن قفل و مدت‌ها)</span>
        <input className="inp w-full" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <div className="rounded border p-3 space-y-2">
        <div className="font-bold">۵ کد یک‌بارمصرف</div>
        <div className="kbd leading-6 text-rose-800">
          این کدها ماژول‌های پولی و قفل‌های کار را هم باز می‌کنند. فقط به کارمندی بدهید که به او اعتماد کامل دارید. هر مصرف همان لحظه با ⚠️ در تلگرام و بله می‌آید.
        </div>
        <div>
          وضعیت: {status?.broken ? <b className="text-rose-700">پروندهٔ کدها خراب بود؛ همه باطل است. کد تازه بسازید.</b>
            : st ? <b>{faDigits(st.remaining)} از {faDigits(st.total)} کد باقی است</b> : <b>هنوز کدی ساخته نشده است</b>}
          {st && st.groups > 1 ? <span className="kbd"> (کدهای دو دستهٔ قبلی؛ حالا هر دو روی همهٔ ماژول‌ها کار می‌کنند تا کد تازه بسازید)</span> : null}
        </div>
        {status && status.lockedMs > 0 && (
          <div className="rounded px-3 py-2 border-2 bg-rose-50 border-rose-400 flex flex-wrap items-center gap-2">
            <b>ورود کد پس از ۵ تلاش اشتباه قفل است ({faDigits(Math.ceil(status.lockedMs / 60_000))} دقیقهٔ دیگر).</b>
            <button className="btn" disabled={busy} onClick={() => void unlock()}>برداشتن قفل کدها</button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={() => void create('random')}>ساخت ۵ کد تازه (تصادفی)</button>
          <button className="btn" disabled={busy} onClick={() => setOwnOpen(!ownOpen)}>خودم می‌نویسم…</button>
          <button className="btn btn-ghost" disabled={busy || !st} onClick={() => void revoke()}>باطل کردن کدها</button>
        </div>
        {ownOpen && (
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
            <button className="btn btn-primary" disabled={busy || own.some((x) => !x.trim())} onClick={() => void create('own')}>ثبت همین ۵ کد</button>
          </div>
        )}
      </div>
      <div className="kbd leading-6">
        {LOCK_KIND_HELP}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded border p-3 space-y-2">
          <label className="block">
            <span className="block mb-1">مدت باز ماندن ماژول‌های پولی با کد (۱ تا ۱۰۰۰ دقیقه)</span>
            <input className="inp w-24 text-center" dir="ltr" inputMode="numeric" value={minutes.sensitive} disabled={busy}
              onChange={(e) => setMinutes((m) => ({ ...m, sensitive: e.target.value }))} />
          </label>
          <KindHelpList label="ماژول‌های پولی و حساس" items={lists.sensitive} />
          <div className="kbd leading-6">و همهٔ «کارهای یک‌باره»، هر کد برای یک بار.</div>
        </div>
        <div className="rounded border p-3 space-y-2">
          <label className="block">
            <span className="block mb-1">مدت باز ماندن سایر ماژول‌ها با کد (۱ تا ۱۰۰۰ دقیقه)</span>
            <input className="inp w-24 text-center" dir="ltr" inputMode="numeric" value={minutes.other} disabled={busy}
              onChange={(e) => setMinutes((m) => ({ ...m, other: e.target.value }))} />
          </label>
          <KindHelpList label="ماژول‌های معمولی" items={lists.normal} />
        </div>
      </div>
      <button className="btn" disabled={busy} onClick={() => void saveMinutes()}>ذخیرهٔ دو مدت کد</button>
      {created && (
        <div className="rounded border-2 border-amber-400 bg-amber-50 p-3 space-y-2">
          <div className="font-bold">کدهای یک‌بارمصرف — فقط همین یک بار دیده می‌شوند</div>
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
