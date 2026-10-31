import { useRef, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, toJalaliDateTime } from '@shared/jalali'

export type BlueManagerNoteView = {
  id: number
  snapshotId?: number
  managerUserId: number
  managerName?: string | null
  text: string
  at: string
}
type Manager = { id: number; name: string; role: string; isActive: boolean }

/** A note is deliberately optional and independent of reconciliation. Its
 * server endpoint requires BOTH this window's manager session and the selected
 * manager's personal custody PIN; the renderer never supplies a blue amount. */
export function CustodyBlueNotes({ snapshotId, notes, managers, onSaved }: {
  snapshotId: number
  notes: BlueManagerNoteView[]
  managers: Manager[]
  onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [managerId, setManagerId] = useState<number | ''>('')
  const [pin, setPin] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Keep the SAME key on a lost response. A changed form gets a fresh key.
  const key = useRef<string | null>(null)
  const submit = async () => {
    if (!managerId || text.trim().length < 3 || text.trim().length > 1000) {
      setError('مدیر و متن یادداشت اختیاری (۳ تا ۱۰۰۰ نویسه) را مشخص کنید.'); return
    }
    setBusy(true); setError(null)
    try {
      key.current ??= `blue-note-${crypto.randomUUID()}`
      await call(CH.custodyBlueNoteAdd, {
        snapshotId, managerUserId: managerId, password: pin, text, idempotencyKey: key.current
      })
      await onSaved()
      setText(''); setPin(''); key.current = null; setEditing(false)
    } catch (reason: any) { setError(reason?.message ?? 'یادداشت ثبت نشد؛ با همان درخواست دوباره تلاش کنید.') }
    finally { setBusy(false) }
  }
  return <div className="mt-2 rounded border border-sky-200 bg-white p-2 text-sm">
    <div className="font-semibold">یادداشت‌های اختیاری مدیر برای سند #{faDigits(snapshotId)}</div>
    {notes.length ? <ul className="list-disc pr-5 mt-1 space-y-1">{notes.map((note) => <li key={note.id}>
      {faDigits(toJalaliDateTime(new Date(note.at)))} · {note.managerName ?? managers.find((manager) => manager.id === note.managerUserId)?.name ?? `مدیر #${faDigits(note.managerUserId)}`}: {note.text}
    </li>)}</ul> : <p className="text-slate-600">یادداشتی ثبت نشده؛ وجود یادداشت برای سند اجباری نیست.</p>}
    {!editing ? <button type="button" className="btn-secondary mt-2" onClick={() => setEditing(true)}>افزودن یادداشت اختیاری</button> : <div className="mt-2 space-y-2">
      <p className="text-xs text-slate-600">یادداشت قبلی و عدد مرجع تغییر نمی‌کنند. این یادداشت تصمیم مالی یا حکم اختلاف نیست.</p>
      <label className="block">مدیر یادداشت‌نویس<select className="input mt-1 w-full" value={managerId}
        onChange={(event) => { setManagerId(event.target.value ? Number(event.target.value) : ''); key.current = null }}>
        <option value="">انتخاب مدیر…</option>{managers.filter((manager) => manager.isActive && manager.role === 'MANAGER').map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
      </select></label>
      <label className="block">PIN شخصی همان مدیر<input className="input mt-1 w-full" type="password" value={pin}
        onChange={(event) => { setPin(event.target.value); key.current = null }} autoComplete="current-password" /></label>
      <label className="block">متن یادداشت اختیاری<textarea className="input mt-1 w-full" maxLength={1000} value={text}
        onChange={(event) => { setText(event.target.value); key.current = null }} /></label>
      {error ? <p className="text-rose-800" role="alert">{error}</p> : null}
      <div className="flex gap-2"><button className="btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'در حال ثبت…' : 'ثبت یادداشت افزایشی'}</button><button className="btn-secondary" disabled={busy} onClick={() => { setEditing(false); setPin(''); setText(''); setError(null); key.current = null }}>انصراف</button></div>
    </div>}
  </div>
}
