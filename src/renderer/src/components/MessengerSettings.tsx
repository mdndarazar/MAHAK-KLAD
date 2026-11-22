import { useEffect, useState } from 'react'
import { faDigits, toJalaliDateTime } from '@shared/jalali'
import { call, CH } from '../lib/api'
import PasswordField from './PasswordField'

/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — «اطلاع‌رسانی با تلگرام و بله» (معماری §۴-۱).
 *
 * فقط نما و ورودی: همهٔ قاعده‌ها در Main است. هر تغییر رمز خود مدیر را می‌خواهد (دستهٔ ۱) و پیش از اعمال
 * به همهٔ گیرنده‌ها خبر داده می‌شود. کلید ربات پس از ذخیره هرگز به این صفحه برنمی‌گردد.
 */
type Provider = 'telegram' | 'bale'
type Mode = 'all' | 'handover' | 'important'
interface RecipientView {
  id: string; provider: Provider; providerLabel: string; name: string; mode: Mode; modeLabel: string; trust: string
  active: boolean; inactiveReason: string | null; queued: number; expiredTotal: number; failedTotal: number
  lastSuccessAt: number | null; lastError: string | null
}
interface MessengerStatus {
  secureStorage: boolean
  vault: 'absent' | 'ok' | 'broken' | 'unavailable'
  enabled: boolean
  running: boolean
  bots: Record<Provider, { configured: boolean; username: string; proxy: string } | null>
  includeCustomerName: boolean
  preventSleep: boolean
  recipients: RecipientView[]
  pairing: {
    provider: Provider; code: string; remainingSec: number; link: string | null; botUsername: string | null
    candidate: { name: string } | null; error: string | null; qr: string | null
  } | null
  lastError: string | null
}

const LABEL: Record<Provider, string> = { telegram: 'تلگرام', bale: 'بله' }
const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'all', label: 'همه موارد', hint: 'تلاش حداکثری؛ مرجع، گزارش‌های خود برنامه است' },
  { id: 'handover', label: 'تحویل شیفت', hint: 'کامل: هر بستن صندوق یک پیام' },
  { id: 'important', label: 'فقط موارد مهم ⚠️', hint: 'فقط رویدادهای حساس و هشدارها' }
]
const when = (ms: number | null): string => (ms ? faDigits(toJalaliDateTime(new Date(ms))) : 'هنوز نه')

export default function MessengerSettings() {
  const [status, setStatus] = useState<MessengerStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [tokens, setTokens] = useState<Record<Provider, string>>({ telegram: '', bale: '' })
  const [proxy, setProxy] = useState('')
  const [editing, setEditing] = useState<Record<Provider, boolean>>({ telegram: false, bale: false })
  const [pairProvider, setPairProvider] = useState<Provider>('telegram')
  const [pairMode, setPairMode] = useState<Mode>('all')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const refresh = async () => {
    try { setStatus(await call<MessengerStatus>(CH.messengerStatus)); setLoadError(null) }
    catch { setLoadError('بخش پیام‌رسان در این پنجره در دسترس نیست.') }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [])

  /** هر کار تغییردهنده: رمز مدیر همراهش می‌رود و پس از کار پاک می‌شود. */
  const run = async (channel: string, payload: Record<string, unknown>, done: string, keepPassword = false): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setMessage(null)
    try {
      setStatus(await call<MessengerStatus>(channel as never, { managerPassword: password, ...payload }))
      setMessage({ ok: true, text: done })
      return true
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'انجام نشد.' })
      return false
    } finally {
      if (!keepPassword) setPassword('')
      setBusy(false)
    }
  }

  if (loadError && !status) return <div className="bg-white rounded shadow p-4 space-y-2"><h2 className="font-bold">اطلاع‌رسانی با تلگرام و بله</h2><div>{loadError}</div></div>
  if (!status) return <div className="bg-white rounded shadow p-4">در حال خواندن وضعیت پیام‌رسان…</div>

  const needPassword = !password
  const configured = (['telegram', 'bale'] as Provider[]).filter((p) => status.bots[p])
  const pairing = status.pairing

  return (
    <div className="space-y-3">
      <div className="bg-white rounded shadow p-4 space-y-2">
        <h2 className="text-brand font-bold">اطلاع‌رسانی با تلگرام و بله</h2>
        <div className="kbd leading-6">
          رویدادهای فروشگاه (فروش، برگشت، تعویض، بستن صندوق، هشدارها و خلاصهٔ ساعت ۲۴) برای شما یا شریکتان فرستاده می‌شود.
          پیش‌فرض خاموش است؛ خاموش یعنی هیچ اتصالی. هر تغییر این بخش رمز خود مدیر را می‌خواهد و پیش از اعمال به همهٔ گیرنده‌ها خبر داده می‌شود.
          فروش هیچ‌وقت منتظر این بخش نمی‌ماند.
        </div>
        <div>وضعیت: <b>{status.enabled ? (status.running ? 'روشن' : 'روشن (در حال آماده شدن)') : 'خاموش'}</b></div>
        {!status.secureStorage && <div role="alert" className="rounded px-3 py-2 bg-amber-50 border border-amber-300">ذخیره‌ساز امن ویندوز در دسترس نیست؛ تنظیمات پیام‌رسان ذخیره نمی‌شود.</div>}
        {status.vault === 'broken' && (
          <div role="alert" className="rounded px-3 py-2 bg-rose-50 border border-rose-300 space-y-2">
            <div>پروندهٔ تنظیمات پیام‌رسان خوانا نیست (مثلاً از رایانهٔ دیگری آمده یا خراب شده). پیام‌رسان خاموش ماند و چیزی بی‌صدا عوض نشد.</div>
            <button className="btn" disabled={busy || needPassword} onClick={() => void run(CH.messengerResetVault, {}, 'پروندهٔ خراب کنار گذاشته شد؛ از نو تنظیم کنید.')}>بازنشانی تنظیمات پیام‌رسان</button>
          </div>
        )}
        {status.lastError && status.enabled && <div className="kbd">{status.lastError}</div>}
        <label className="block">رمز مدیر برنامه (برای هر تغییر در این بخش)
          <PasswordField className="inp w-full" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {needPassword && !busy && <div className="kbd">دکمه‌های تغییر تا وقتی رمز مدیر را نزنید، غیرفعال می‌مانند.</div>}
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={busy || needPassword || status.enabled || !configured.length || status.vault === 'broken'}
            onClick={() => void run(CH.messengerSetEnabled, { enabled: true }, 'اعلان‌ها روشن شد.')}>روشن کردن اعلان‌ها</button>
          <button className="btn" disabled={busy || needPassword || !status.enabled}
            onClick={() => void run(CH.messengerSetEnabled, { enabled: false }, 'اعلان‌ها خاموش شد؛ هیچ اتصالی برقرار نیست.')}>خاموش کردن</button>
        </div>
        {!configured.length && <div className="kbd">برای روشن کردن، اول یک ربات (تلگرام یا بله) اضافه کنید.</div>}
        {message && <div role="status" className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'}`}>{message.text}</div>}
      </div>

      <div className="bg-white rounded shadow p-4 space-y-3">
        <h3 className="font-bold">ربات‌ها</h3>
        <div className="kbd leading-6">
          ربات را خودتان می‌سازید: در تلگرام با @BotFather و در بله با @botfather (دستور ساخت ربات تازه). کلید ربات را فقط همین‌جا روی رایانهٔ فروشگاه بگذارید، نه در گفت‌وگو.
          کلید رمزشده نگه داشته می‌شود و هرگز دوباره نشان داده نمی‌شود.
        </div>
        {(['telegram', 'bale'] as Provider[]).map((p) => {
          const bot = status.bots[p]
          const showForm = !bot || editing[p]
          return (
            <div key={p} className="border rounded p-3 space-y-2">
              <div className="font-bold">{LABEL[p]}{bot ? <> · <span dir="ltr">@{bot.username}</span></> : ' · افزوده نشده'}</div>
              {p === 'bale' && <div className="kbd">سرورهای بله داخل ایران‌اند و بی فیلترشکن کار می‌کنند.</div>}
              {p === 'telegram' && bot?.proxy && !editing[p] && <div className="kbd">پراکسی: <span dir="ltr">{bot.proxy}</span></div>}
              {showForm ? (
                <div className="space-y-2">
                  <label className="block">کلید ربات {LABEL[p]}
                    <PasswordField className="inp w-full" autoComplete="off" value={tokens[p]} disabled={busy} onChange={(e) => setTokens({ ...tokens, [p]: e.target.value.trim() })} />
                  </label>
                  {p === 'telegram' && (
                    <label className="block">پراکسی (اختیاری؛ مثلاً پورت فیلترشکن: socks5://127.0.0.1:10808)
                      <input className="inp w-full" dir="ltr" autoComplete="off" value={proxy} disabled={busy} onChange={(e) => setProxy(e.target.value.trim())} />
                    </label>
                  )}
                  <div className="flex gap-2">
                    <button className="btn btn-primary" disabled={busy || needPassword || !tokens[p]}
                      onClick={() => void run(CH.messengerSaveBot, { provider: p, token: tokens[p], proxy: p === 'telegram' ? proxy : '' }, `ربات ${LABEL[p]} بررسی و ذخیره شد.`)
                        .then((ok) => { if (ok) { setTokens({ ...tokens, [p]: '' }); setEditing({ ...editing, [p]: false }) } })}>ذخیره و بررسی ربات</button>
                    {bot && <button className="btn" disabled={busy} onClick={() => setEditing({ ...editing, [p]: false })}>انصراف</button>}
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button className="btn" disabled={busy} onClick={() => { setEditing({ ...editing, [p]: true }); setProxy(bot?.proxy ?? '') }}>عوض کردن کلید یا پراکسی…</button>
                  <button className="btn" disabled={busy || needPassword} onClick={() => void run(CH.messengerRemoveBot, { provider: p }, `ربات ${LABEL[p]} و گیرنده‌هایش برداشته شدند.`)}>برداشتن ربات</button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="bg-white rounded shadow p-4 space-y-3">
        <h3 className="font-bold">گیرنده‌ها</h3>
        {!status.recipients.length && <div className="kbd">هنوز گیرنده‌ای نیست. از بخش «افزودن گیرنده» شروع کنید.</div>}
        {status.recipients.map((r) => (
          <div key={r.id} className="border rounded p-3 space-y-1">
            <div className="font-bold">{r.name} · {r.providerLabel} {r.active ? '' : '· غیرفعال'}</div>
            {!r.active && r.inactiveReason && <div className="kbd">{r.inactiveReason} (برای فعال شدن دوباره، حذف و دوباره جفت کنید)</div>}
            <label className="block">چه پیام‌هایی برسد
              <select className="inp w-full" value={r.mode} disabled={busy || needPassword}
                onChange={(e) => void run(CH.messengerRecipientUpdate, { id: r.id, mode: e.target.value }, 'تنظیم گیرنده عوض شد.')}>
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}
              </select>
            </label>
            <div className="kbd">در صف: {faDigits(r.queued)} · منقضی‌شده: {faDigits(r.expiredTotal)} · ناموفق: {faDigits(r.failedTotal)} · آخرین ارسال موفق: {when(r.lastSuccessAt)}</div>
            {r.lastError && <div className="kbd">آخرین خطا: {r.lastError}</div>}
            <div className="flex gap-2">
              <button className="btn" disabled={busy} onClick={() => void run(CH.messengerTest, { id: r.id }, 'پیام آزمایشی فرستاده شد.', true)}>پیام آزمایشی</button>
              {confirmRemove !== r.id
                ? <button className="btn" disabled={busy || needPassword} onClick={() => setConfirmRemove(r.id)}>حذف…</button>
                : <>
                    <button className="btn btn-primary" disabled={busy || needPassword} onClick={() => void run(CH.messengerRecipientRemove, { id: r.id }, 'گیرنده حذف شد و صفش پاک شد.').then(() => setConfirmRemove(null))}>بله، حذف شود</button>
                    <button className="btn" disabled={busy} onClick={() => setConfirmRemove(null)}>انصراف</button>
                  </>}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded shadow p-4 space-y-2">
        <h3 className="font-bold">افزودن گیرنده</h3>
        {!configured.length ? <div className="kbd">اول یک ربات اضافه کنید.</div> : !pairing ? (
          <div className="space-y-2">
            <div className="kbd">یک کد یک‌بارمصرف ۱۰ دقیقه‌ای ساخته می‌شود. فقط گفت‌وگوی خصوصی پذیرفته می‌شود، نه گروه.</div>
            <div className="flex gap-3">
              {configured.map((p) => (
                <label key={p} className="flex items-center gap-1"><input type="radio" checked={pairProvider === p} onChange={() => setPairProvider(p)} />{LABEL[p]}</label>
              ))}
            </div>
            <button className="btn btn-primary" disabled={busy || needPassword || !status.bots[pairProvider]}
              onClick={() => void run(CH.messengerPairStart, { provider: pairProvider }, 'کد ساخته شد؛ ۱۰ دقیقه فرصت دارید.')}>ساخت کد جفت‌سازی</button>
          </div>
        ) : (
          <div className="space-y-2">
            <div>کد: <b dir="ltr" className="text-lg">{pairing.code}</b> · زمان باقی‌مانده: {faDigits(Math.floor(pairing.remainingSec / 60))} دقیقه و {faDigits(pairing.remainingSec % 60)} ثانیه</div>
            {pairing.provider === 'telegram' && pairing.link && (
              <div className="space-y-1">
                <div>در گوشی گیرنده، این پیوند را باز کنید یا QR را بخوانید و «Start» را بزنید:</div>
                <div dir="ltr" className="kbd break-all">{pairing.link}</div>
                {pairing.qr && <img src={pairing.qr} alt="QR جفت‌سازی" className="w-40 h-40" />}
                <div className="kbd">راه دوم: همین کد را برای ربات بفرستید.</div>
              </div>
            )}
            {pairing.provider === 'bale' && <div>در بله، ربات <b dir="ltr">@{pairing.botUsername}</b> را باز کنید و همین کد را برایش بفرستید.</div>}
            {pairing.error && <div role="alert" className="rounded px-3 py-2 bg-amber-50 border border-amber-300">{pairing.error}</div>}
            {!pairing.candidate && !pairing.error && <div className="kbd">منتظر پیام گیرنده…</div>}
            {pairing.candidate && (
              <div className="space-y-2">
                <div>پیام از <b>{pairing.candidate.name}</b> رسید. اگر همین شخص است، گزینه را انتخاب و تأیید کنید.</div>
                <select className="inp w-full" value={pairMode} disabled={busy} onChange={(e) => setPairMode(e.target.value as Mode)}>
                  {MODES.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}
                </select>
                <button className="btn btn-primary" disabled={busy || needPassword}
                  onClick={() => void run(CH.messengerPairConfirm, { mode: pairMode }, 'گیرنده افزوده شد و پیام خوش‌آمد فرستاده شد.')}>تأیید و افزودن</button>
              </div>
            )}
            <button className="btn" disabled={busy} onClick={() => void run(CH.messengerPairCancel, {}, 'جفت‌سازی لغو شد.', true)}>انصراف</button>
          </div>
        )}
      </div>

      <div className="bg-white rounded shadow p-4 space-y-2">
        <h3 className="font-bold">گزینه‌ها و راهنما</h3>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={status.includeCustomerName} disabled={busy || needPassword}
            onChange={(e) => void run(CH.messengerSetOptions, { includeCustomerName: e.target.checked }, 'گزینه ذخیره شد.')} />
          نام مشتری هم در پیام بیاید (تلفن مشتری، کد و بارکد اعتبار هرگز نمی‌آیند)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={status.preventSleep} disabled={busy || needPassword}
            onChange={(e) => void run(CH.messengerSetOptions, { preventSleep: e.target.checked }, 'گزینه ذخیره شد.')} />
          تا برنامه باز است، رایانه به خواب نرود
        </label>
        <ul className="kbd leading-6 list-disc pr-5">
          <li>رایانهٔ خوابیده یا خاموش پیامی نمی‌فرستد. خواب ویندوز را خاموش کنید و برنامه را باز بگذارید.</li>
          <li>اگر اینترنت قطع بود، پیام‌ها تا ۲۴ ساعت در صف می‌مانند؛ کهنه‌ترها با یک پیام «منقضی شد» خبر داده می‌شوند.</li>
          <li>خلاصهٔ روز ساعت ۲۴ می‌آید. اگر نیامد، یعنی برنامه یا اتصال قطع بوده است.</li>
          <li>برای امنیت، «تأیید دومرحله‌ای» حساب تلگرام و بلهٔ خود را روشن کنید.</li>
          <li>اگر پیام «ربات جای دیگری خوانده می‌شود» دیدید، webhook یا برنامهٔ دیگری که همین ربات را می‌خواند بردارید.</li>
        </ul>
      </div>
    </div>
  )
}
