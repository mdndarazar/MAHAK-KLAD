import { useCallback, useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits } from '@shared/jalali'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ §۴-۸ (مورد ۳) — «کدهای بازیابی توقف اضطراری» در صفحهٔ «کنترل از راه دور با گوشی».
 *
 *   - ۵ کد ۱۲ نویسه‌ای (سه گروه چهارتایی، بی ۰ و O و ۱ و I و L)؛ فقط همین یک بار نمایش و چاپ؛ ساخت تازه همهٔ
 *     قبلی‌ها را باطل می‌کند؛ «باطل کردن همه» و شمار باقی‌مانده.
 *   - در حالت دوری، مالک یک کد را تلفنی به فروشنده می‌گوید و او پشت همین رایانه، روی صفحهٔ قفل یکی از پنل‌ها،
 *     «بازیابی توقف اضطراری راه دور» ← «کد بازیابی» را می‌زند؛ رمز مدیر و PIN لو نمی‌روند.
 *   - ساخت و باطل کردن «کلیدسازی»اند: رمز تایپی مدیر. هاب باید روشن باشد (کدها کنار PIN در پایگاه هاب‌اند).
 * ===========================================================================
 */
type Status = { running: boolean; total: number; remaining: number; lockedUntil: number }

function printCodes(codes: string[]): void {
  const rows = codes.map((c, i) => `<tr><td>${i + 1}</td><td dir="ltr" style="unicode-bidi:isolate;font-size:20px;letter-spacing:3px;font-family:monospace">${c}</td><td>☐</td></tr>`).join('')
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>کدهای بازیابی</title><style>body{font-family:Tahoma,sans-serif;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:8px 14px;text-align:center}</style></head><body><h3>کدهای بازیابی «توقف اضطراری کامل»</h3><table><tr><th>شماره</th><th>کد</th><th>مصرف شد</th></tr>${rows}</table><p>این برگه را پیش خودتان نگه دارید (نه کنار رایانهٔ فروشگاه). هر کد یک بار کار می‌کند. اگر گم شد، کدها را باطل و دوباره بسازید.</p></body></html>`
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'; frame.style.width = '0'; frame.style.height = '0'; frame.style.border = '0'
  frame.srcdoc = html
  frame.onload = () => { try { frame.contentWindow?.print() } finally { setTimeout(() => frame.remove(), 1000) } }
  document.body.appendChild(frame)
}

export default function RecoveryCodesBox() {
  const [status, setStatus] = useState<Status | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try { setStatus(await call<Status>(CH.recoveryCodesStatus)) } catch { setStatus(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    if (!password) { setMessage({ ok: false, text: 'برای این کار «رمز مدیر» را تایپ کنید.' }); return }
    setBusy(true); setMessage(null)
    try { await fn(); setPassword('') } catch (e: any) { setMessage({ ok: false, text: e?.message || 'انجام نشد.' }) } finally { setBusy(false); void load() }
  }
  const create = () => run(async () => {
    if (status && status.total > 0 && !confirm('ساخت کدهای تازه همهٔ کدهای بازیابی قبلی را باطل می‌کند. ادامه می‌دهید؟')) return
    const result = await call<{ codes: string[] }>(CH.recoveryCodesCreate, { managerPassword: password })
    setCodes(result.codes)
    setMessage({ ok: true, text: 'پنج کد بازیابی تازه ساخته شد؛ همهٔ قبلی‌ها باطل شد. کدها فقط همین حالا دیده می‌شوند.' })
  })
  const revoke = () => run(async () => {
    if (!confirm('همهٔ کدهای بازیابی باطل شوند؟')) return
    await call(CH.recoveryCodesRevoke, { managerPassword: password })
    setCodes(null)
    setMessage({ ok: true, text: 'همهٔ کدهای بازیابی باطل شد.' })
  })

  return (
    <div className="bg-white rounded shadow p-4 space-y-3" dir="rtl">
      <h2 className="font-bold">کدهای بازیابی «توقف اضطراری کامل»</h2>
      {/* دفتر آزمون ۴-۴۳: فرق روشن با کد یک‌بارمصرف (۸ رقمی، در «تنظیمات ← رمز مدیر و خروج») */}
      <div className="font-bold text-amber-800">این‌ها کد یک‌بارمصرف نیستند؛ فقط برای «بازیابی توقف اضطراری راه دور» به کار می‌روند.</div>
      <div className="kbd leading-6">
        اگر «توقف اضطراری کامل» زده شد و شما پشت رایانه نیستید، یک کد را تلفنی به فروشنده بگویید تا پشت همین رایانه، روی صفحهٔ قفل
        یکی از پنل‌ها «بازیابی توقف اضطراری راه دور» ← «کد بازیابی» را بزند؛ رمز مدیر و PIN شما لو نمی‌رود. هر کد یک بار کار می‌کند؛
        پس از ۵ کد اشتباه، ۱۵ دقیقه قفل می‌شود (رمز مدیر + PIN قفل نمی‌شود). مصرف هر کد با اعلان ویندوز، پیام در ورود بعدی گوشی و
        ⚠️ تلگرام و بله خبر داده می‌شود.
        <br />کدها را وقتی بسازید که کسی کنارتان نیست؛ ساخت کد تازه همهٔ قبلی‌ها را باطل می‌کند؛ اگر همه مصرف یا گم شد، فقط رمز مدیر و
        PIN پشت رایانه می‌ماند. اگر توقف اضطراری به خاطر دزدی گوشی یا لو رفتن رمز بود، پیش از بازیابی آن عضو را حذف یا PIN را عوض کنید.
        «گذاشتن رمز و PIN تازه برای مالک» و «حذف راه‌اندازی» همهٔ کدها را باطل می‌کنند.
      </div>
      <div>
        وضعیت: {!status ? '…' : !status.running ? <b>هاب کنترل از راه دور روشن نیست؛ برای ساخت یا باطل کردن، اول آن را روشن کنید.</b>
          : status.total ? <b>{faDigits(status.remaining)} از {faDigits(status.total)} کد باقی است</b> : <b>هنوز کدی ساخته نشده است</b>}
        {status?.lockedUntil ? <span className="text-rose-700"> · ورود کد بازیابی پس از ۵ اشتباه موقتاً قفل است.</span> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !status?.running} onClick={() => void create()}>ساخت ۵ کد بازیابی تازه</button>
        <button className="btn btn-ghost" disabled={busy || !status?.running || !status.total} onClick={() => void revoke()}>باطل کردن همه</button>
      </div>
      {codes && (
        <div className="rounded border-2 border-amber-400 bg-amber-50 p-3 space-y-2">
          <div className="font-bold">کدهای بازیابی — فقط همین یک بار دیده می‌شوند</div>
          <div className="text-amber-800">این‌ها کد یک‌بارمصرف نیستند؛ فقط برای «بازیابی توقف اضطراری راه دور» به کار می‌روند.</div>
          <ol className="space-y-1">{codes.map((c, i) => <li key={c}>شمارهٔ {faDigits(i + 1)}: <b dir="ltr" style={{ unicodeBidi: 'isolate' }} className="text-lg tracking-widest font-mono">{c}</b></li>)}</ol>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => printCodes(codes)}>چاپ برگه</button>
            <button className="btn" onClick={() => setCodes(null)}>یادداشت کردم؛ پنهان شود</button>
          </div>
        </div>
      )}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>{message.text}</div>
      )}
    </div>
  )
}
