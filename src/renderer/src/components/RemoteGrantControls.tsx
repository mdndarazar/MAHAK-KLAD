import { useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toLatinDigits } from '@shared/jalali'
import { GATE_IRREVERSIBLE_ACTIONS } from '@shared/gateCatalog'
import { LOCK_KIND_HELP, lockKindLists, type LockKindItem } from '@shared/panels'

/**
 * ===========================================================================
 * طرح ۱۴۰۵ — دو کار روی صفحهٔ «کنترل از راه دور»:
 *   - §۳-۱۳ (مورد ۷) و دفتر آزمون ۴-۲۸: دو «مدت مجوز راه دور»، هر کدام عدد صحیح ۱ تا ۱۰۰۰ دقیقه (پیش‌فرض ۱۰):
 *     «ماژول‌های معمولی» و «ماژول‌های پولی و حساس» (قسمت پولی و قسمت تازه؛ همان مرز کدهای «سایر» و «حساس»).
 *     تغییرشان «کلیدسازی» است: رمز تایپی مدیر می‌خواهد (یک کادر خام برای هر دو، هرگز نشانگر)، در AuditLog می‌نشیند و
 *     خبرش به پیام‌رسان می‌رود. مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود. «قفل کار» همان یک بار است.
 *   - دفتر آزمون ۴-۳۱: «حداکثر دفعات هر مجوز» (۱ تا ۱۰۰۰، پیش‌فرض ۱) و فهرست کارهای یک‌باره به تفکیک بخش با تیک «قابل
 *     تکرار» (پیش‌فرض همه خاموش؛ کار برگشت‌ناپذیر هرگز)، با همان رمز تایپی مدیر؛ و مجوزهای چندبارهٔ باز با دفعات باقی.
 *   - دفتر آزمون ۴-۳۲: زیر مدت‌ها فهرست ماژول‌های معمولی و پولی و حساس، و زیر دفعات فهرست کارهای یک‌باره به تفکیک بخش با
 *     نشان «قابل تکرار» یا «برگشت‌ناپذیر؛ همیشه یک بار»، همه از همان طبقه‌بندی برنامه (`lockKindLists`)؛ فهرست بلند «نمایش همه».
 *   - §۳-۱۷: «بستن همهٔ مجوزها و قفل‌های باز» (مجوزهای راه دور، بلیت‌های یک‌بار، قسمت‌های بازشده با کد و مجوز
 *     زمان‌بندی‌شدهٔ باز)؛ رمز نمی‌خواهد، چون فقط می‌بندد. مجوزهای زمان‌بندی‌شدهٔ آینده و خود کدها باطل نمی‌شوند.
 * ===========================================================================
 */
type Durations = { sensitiveCodeMinutes: number; otherCodeMinutes: number; remoteGrantMinutes: number; remoteSensitiveGrantMinutes: number }
type RemoteKey = 'remoteGrantMinutes' | 'remoteSensitiveGrantMinutes'
const BOXES: ReadonlyArray<{ key: RemoteKey; title: string }> = [
  { key: 'remoteGrantMinutes', title: 'ماژول‌های معمولی' },
  { key: 'remoteSensitiveGrantMinutes', title: 'ماژول‌های پولی و حساس' }
]
type OpenRepeat = { id: string; titleFa: string; windowNo: number; left: number; uses: number; minutesLeft: number }
type Settings = Durations & { repeatUsesMax?: number; repeatableActions?: string[]; openRepeats?: OpenRepeat[] }
/** دفتر آزمون ۴-۳۲: سه فهرست راهنما از همان طبقه‌بندی برنامه (`lockKindOf`). */
const KIND_LISTS = lockKindLists()
/** دفتر آزمون ۴-۳۱: همهٔ «قفل‌های کار» کاتالوگ به تفکیک بخش؛ کار برگشت‌ناپذیر تیکش غیرفعال است. */
const ACTION_GROUPS: ReadonlyArray<{ group: string; items: ReadonlyArray<{ id: string; title: string; never: boolean }> }> =
  KIND_LISTS.actions.map((g) => ({ group: g.group, items: g.items.map((i) => ({ ...i, never: GATE_IRREVERSIBLE_ACTIONS.includes(i.id) })) }))

/** دفتر آزمون ۴-۳۲: فهرست راهنمای یک نوع زیر تنظیمش؛ فهرست بلند با «نمایش همه» باز می‌شود. */
export function KindHelpList({ label, items, limit = 6 }: { label: string; items: ReadonlyArray<LockKindItem>; limit?: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <div className="kbd leading-6">
      {label}: {shown.map((i) => i.title).join('، ')}{items.length > limit && !all ? '، …' : ''}
      {items.length > limit ? <> <button type="button" className="btn btn-ghost" onClick={() => setAll((v) => !v)}>{all ? 'بستن' : `نمایش همه (${faDigits(items.length)})`}</button></> : null}
    </div>
  )
}
const remoteOf = (d: Durations): Record<RemoteKey, number> => ({ remoteGrantMinutes: d.remoteGrantMinutes, remoteSensitiveGrantMinutes: d.remoteSensitiveGrantMinutes })
const texts = (c: Record<RemoteKey, number>): Record<RemoteKey, string> => ({ remoteGrantMinutes: String(c.remoteGrantMinutes), remoteSensitiveGrantMinutes: String(c.remoteSensitiveGrantMinutes) })

export default function RemoteGrantControls() {
  const [current, setCurrent] = useState<Record<RemoteKey, number> | null>(null)
  const [minutes, setMinutes] = useState<Record<RemoteKey, string>>({ remoteGrantMinutes: '', remoteSensitiveGrantMinutes: '' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // دفتر آزمون ۴-۳۱: حداکثر دفعات، کارهای «قابل تکرار» و مجوزهای چندبارهٔ باز
  const [usesNow, setUsesNow] = useState<number | null>(null)
  const [usesText, setUsesText] = useState('')
  const [repeatNow, setRepeatNow] = useState<string[]>([])
  const [repeatable, setRepeatable] = useState<string[]>([])
  const [openRepeats, setOpenRepeats] = useState<OpenRepeat[]>([])
  const [showActions, setShowActions] = useState(false)

  const apply = (d: Settings) => {
    const c = remoteOf(d)
    setCurrent(c)
    setMinutes(texts(c))
    const uses = Number.isInteger(d.repeatUsesMax) ? (d.repeatUsesMax as number) : 1
    setUsesNow(uses)
    setUsesText(String(uses))
    const list = Array.isArray(d.repeatableActions) ? d.repeatableActions : []
    setRepeatNow(list)
    setRepeatable(list)
    if (Array.isArray(d.openRepeats)) setOpenRepeats(d.openRepeats)
  }
  const load = () => call<Settings>(CH.lockDurationsGet).then(apply).catch(() => setCurrent(null))
  useEffect(() => { void load() }, [])

  const valueOf = (key: RemoteKey) => Number(toLatinDigits(minutes[key]).trim())
  const validOf = (key: RemoteKey) => Number.isInteger(valueOf(key)) && valueOf(key) >= 1 && valueOf(key) <= 1000
  const usesValue = Number(toLatinDigits(usesText).trim())
  const usesValid = Number.isInteger(usesValue) && usesValue >= 1 && usesValue <= 1000
  const valid = BOXES.every((b) => validOf(b.key)) && usesValid
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))
  const changed = current === null || BOXES.some((b) => valueOf(b.key) !== current[b.key]) || usesValue !== usesNow || !sameList(repeatable, repeatNow)
  const idleOf = (key: RemoteKey) => (validOf(key) ? Math.min(10, Math.max(3, Math.round(valueOf(key) / 5))) : null)

  const save = async () => {
    if (busy || !valid || !password) return
    setBusy(true)
    setMessage(null)
    try {
      await call<Durations>(CH.lockDurationsSet, {
        managerPassword: password, remoteGrantMinutes: valueOf('remoteGrantMinutes'), remoteSensitiveGrantMinutes: valueOf('remoteSensitiveGrantMinutes'),
        repeatUsesMax: usesValue, repeatableActions: repeatable
      })
      const d = await call<Settings>(CH.lockDurationsGet)
      apply(d)
      const c = remoteOf(d)
      setPassword('')
      setMessage({ ok: true, text: `مدت مجوز راه دور: ماژول‌های معمولی ${faDigits(c.remoteGrantMinutes)} دقیقه، ماژول‌های پولی و حساس ${faDigits(c.remoteSensitiveGrantMinutes)} دقیقه. مجوزی که همین حالا باز است با عدد قبلی بسته می‌شود. حداکثر دفعات هر مجوز: ${faDigits(d.repeatUsesMax ?? 1)} بار؛ کارهای قابل تکرار: ${faDigits((d.repeatableActions ?? []).length)}.` })
    } catch (e: any) {
      setMessage({ ok: false, text: e?.message || 'ذخیره نشد.' })
    } finally {
      setBusy(false)
    }
  }

  const closeAll = async () => {
    if (busy || !confirm('همهٔ مجوزهای راه دور، کارهای یک‌بارِ مجازشده، قسمت‌های بازشده با کد و مجوز زمان‌بندی‌شدهٔ باز همین حالا بسته شوند؟')) return
    setBusy(true)
    setMessage(null)
    try {
      await call(CH.gateCloseAll)
      setOpenRepeats([])
      setMessage({ ok: true, text: 'همهٔ مجوزها و قفل‌های باز بسته شدند.' })
    } catch (e: any) {
      setMessage({ ok: false, text: e?.message || 'بستن کامل نشد؛ دوباره بزنید.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded shadow p-4 space-y-3" dir="rtl">
      <h2 className="font-bold">مدت مجوز راه دور و بستن همه</h2>
      <div className="kbd leading-6">
        مجوز گوشی یا ربات یک «قسمت» را برای مدت همان نوع باز می‌کند: قسمت معمولی با مدت اول، و قسمت پولی یا تازه با مدت دوم.
        یک «قفل کار» را فقط یک بار باز می‌کند (برای استفاده تا مدت دوم، حداکثر ۶۰ دقیقه)؛ کار «قابل تکرار» تا «حداکثر دفعات هر مجوز»
        و تا پایان مدت دوم. اگر از قسمتِ باز استفاده نشود، پس از
        یک‌پنجم مدت (کمینه ۳ و بیشینه ۱۰ دقیقه) بسته می‌شود. درخواستِ تأییدنشده پس از ۱۰ دقیقه باطل می‌شود.
        {current !== null ? <> مدت فعلی: معمولی <b>{faDigits(current.remoteGrantMinutes)} دقیقه</b>، پولی و حساس <b>{faDigits(current.remoteSensitiveGrantMinutes)} دقیقه</b>.</> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {BOXES.map((b) => (
          <label key={b.key} className="block">
            <span className="block mb-1">مدت مجوز راه دور — {b.title} (۱ تا ۱۰۰۰ دقیقه)</span>
            <input className="inp w-28 text-center" dir="ltr" inputMode="numeric" value={minutes[b.key]} disabled={busy}
              onChange={(e) => { const v = e.target.value; setMinutes((m) => ({ ...m, [b.key]: v })) }} />
          </label>
        ))}
        <label className="block">
          <span className="block mb-1">حداکثر دفعات هر مجوز (۱ تا ۱۰۰۰ بار)</span>
          <input className="inp w-28 text-center" dir="ltr" inputMode="numeric" value={usesText} disabled={busy}
            onChange={(e) => setUsesText(e.target.value)} />
        </label>
        <label className="block">
          <span className="block mb-1">رمز مدیر</span>
          <input className="inp w-40" type="password" dir="ltr" autoComplete="off" value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !valid || !password || !changed} onClick={() => void save()}>
          ذخیرهٔ مدت‌ها و دفعات
        </button>
      </div>
      {BOXES.some((b) => !validOf(b.key) && minutes[b.key].trim()) ? <div className="kbd text-rose-700">هر مدت باید عددی صحیح و بین ۱ تا ۱۰۰۰ باشد.</div> : null}
      <div className="space-y-1">
        <div className="kbd leading-6">{LOCK_KIND_HELP}</div>
        <KindHelpList label="مدت اول، ماژول‌های معمولی" items={KIND_LISTS.normal} />
        <KindHelpList label="مدت دوم، ماژول‌های پولی و حساس" items={KIND_LISTS.sensitive} />
      </div>
      {!usesValid && usesText.trim() ? <div className="kbd text-rose-700">حداکثر دفعات باید عددی صحیح و بین ۱ تا ۱۰۰۰ باشد.</div> : null}
      <div className="rounded border p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold">کارهای یک‌بارهٔ قابل تکرار</span>
          <span className="kbd">({faDigits(repeatable.length)} کار تیک خورده)</span>
          <button className="btn btn-ghost" onClick={() => setShowActions((v) => !v)}>{showActions ? 'بستن فهرست' : 'نمایش همه'}</button>
        </div>
        <div className="kbd leading-6">
          زیر «حداکثر دفعات هر مجوز»: همهٔ کارهای یک‌باره ({faDigits(ACTION_GROUPS.reduce((n, g) => n + g.items.length, 0))} کار در {faDigits(ACTION_GROUPS.length)} بخش).
          پیش‌فرض هر کار «یک بار» است. کار تیک‌خورده با یک مجوز تا «حداکثر دفعات هر مجوز» انجام می‌شود و هر بار خبرش به تلگرام و بله می‌رود.
          کارهای برگشت‌ناپذیر هرگز قابل تکرار نمی‌شوند. تغییر با همان رمز مدیر و دکمهٔ ذخیره است.
        </div>
        {showActions ? ACTION_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="font-bold mt-2">{g.group}</div>
            {g.items.map((item) => (
              <label key={item.id} className="flex items-center gap-2 leading-7">
                <input type="checkbox" disabled={busy || item.never} checked={!item.never && repeatable.includes(item.id)}
                  onChange={(e) => { const on = e.target.checked; setRepeatable((list) => (on ? [...list, item.id] : list.filter((x) => x !== item.id))) }} />
                <span>{item.title}</span>
                <span className="kbd">{item.never ? 'برگشت‌ناپذیر؛ همیشه یک بار' : 'قابل تکرار'}</span>
              </label>
            ))}
          </div>
        )) : null}
      </div>
      <div className="kbd leading-6">
        مجوزهای چندبارهٔ باز:{' '}
        {openRepeats.length ? openRepeats.map((o) => `${o.titleFa} · پنجرهٔ ${faDigits(o.windowNo)} · ${faDigits(o.left)} بار از ${faDigits(o.uses)} باقی · تا ${faDigits(o.minutesLeft)} دقیقه`).join('؛ ') : 'هیچ'}
        {' '}<button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>تازه کردن</button>
      </div>
      {valid ? <div className="kbd">با این مدت‌ها، بی‌کاری قسمتِ باز آن را می‌بندد: معمولی پس از {faDigits(idleOf('remoteGrantMinutes') ?? 0)} دقیقه، پولی و حساس پس از {faDigits(idleOf('remoteSensitiveGrantMinutes') ?? 0)} دقیقه.</div> : null}
      <div className="border-t pt-3">
        <button className="btn btn-danger" disabled={busy} onClick={() => void closeAll()}>
          بستن همهٔ مجوزها و قفل‌های باز
        </button>
        <div className="kbd mt-1">مجوزهای گوشی و ربات، کارهای یک‌بارِ مجازشده، قسمت‌های بازشده با کد یک‌بارمصرف و مجوز زمان‌بندی‌شدهٔ باز بسته می‌شوند؛ رمز لازم نیست. نشست مدیر، رمزهای دوم، خود کدهای یک‌بارمصرف و مجوزهای زمان‌بندی‌شدهٔ آینده دست نمی‌خورند.</div>
      </div>
      {message ? (
        <div role={message.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 border ${message.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>
          {message.text}
        </div>
      ) : null}
    </div>
  )
}
