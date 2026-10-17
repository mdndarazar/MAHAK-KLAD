import { useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits, money } from '@shared/jalali'

/** The return of a non-cash opportunity is NOT a cash payout. Printing is
 * deliberately separate from a manager-confirmed witnessed customer handoff.
 * No credential is exposed by a normal sale/return response. */
export default function CreditOpportunityHandoff({ credits }: {
  credits: { creditId: number; amount: number; status: string }[]
}) {
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [holderPrepared, setHolderPrepared] = useState<Record<number, string>>({})
  const [witnessRef, setWitnessRef] = useState('')
  const [witnessKind, setWitnessKind] = useState<'CUSTOMER_HANDOFF' | 'COURIER_ACK'>('CUSTOMER_HANDOFF')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [delivered, setDelivered] = useState<number[]>([])
  const [printed, setPrinted] = useState<number[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function print(creditId: number) {
    setBusy(creditId); setError(''); setMessage('')
    try {
      const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ')
      const contact = phone.trim()
      if ([firstName, lastName, phone].some((field) => field.trim().length > 100))
        throw new Error('هر فیلد اختیاری نام/تلفن حداکثر ۱۰۰ نویسه دارد.')
      const identity = JSON.stringify({ name, contact })
      if ((name || contact) && holderPrepared[creditId] !== identity) {
        // No name/phone is required; if supplied, save its literal text with
        // manager evidence BEFORE rendering the paper. This does NOT lock a
        // customer, prove ownership, make the phone unique or permit SMS.
        await call(CH.creditHolderChange, { id: creditId,
          ...(name ? { customerName: name } : {}), ...(contact ? { holderPhone: contact } : {}),
          reason: 'ثبت مشخصات اختیاری روی برگهٔ اعتبار پیش از چاپ', managerPassword: password })
        setHolderPrepared((seen) => ({ ...seen, [creditId]: identity }))
      }
      await call(CH.returnCreditPrint, { creditId, managerPassword: password })
      setPrinted((ids) => [...new Set([...ids, creditId])])
      setMessage(`سند اعتبار #${faDigits(creditId)} برای چاپ ارسال شد؛ این به‌معنای تحویل نیست.`)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }
  async function deliver(creditId: number) {
    setBusy(creditId); setError(''); setMessage('')
    try {
      if (!confirmed || witnessRef.trim().length < 8)
        throw new Error('فقط پس از تحویل واقعی، نوع شاهد، توضیح حداقل ۸ نویسه و تأیید صریح را ثبت کنید.')
      const result = await call<{ status: string; replayed: boolean }>(CH.returnCreditDeliver, {
        creditId, managerPassword: password, witnessKind, witnessRef: witnessRef.trim()
      })
      setDelivered((ids) => [...new Set([...ids, creditId])])
      setMessage(`اعتبار #${faDigits(creditId)} با شاهد تحویل ثبت شد${result.replayed ? ' (تکرار همان درخواست)' : ''}.`)
      setConfirmed(false)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }
  if (!credits.length) return null
  return <section className="rounded border-2 border-sky-400 bg-sky-50 p-3 space-y-2 w-full">
    <b>چاپ و تحویلِ جداگانهٔ اعتبار B/E یا جانشین</b>
    <p className="text-sm">سهم اعتبار، پول نقد/کارت‌به‌کارت نیست. کد جدید تا تحویل واقعی و شاهددار خرج‌پذیر نمی‌شود. چاپ شکست‌خورده یا نتیجهٔ نامعلوم کد را خودکار فعال نمی‌کند. شناسهٔ زیر کد قابل‌خرج نیست.</p>
    <div className="flex flex-wrap gap-2 items-end text-sm">
      <label>نام (اختیاری)<input className="inp block" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label>
      <label>نام خانوادگی (اختیاری)<input className="inp block" value={lastName} onChange={(e) => setLastName(e.target.value)} /></label>
      <label>تلفن (اختیاری؛ نه مدرک مالکیت/مجوز پیامک)<input className="inp block" inputMode="tel"
        value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
    </div>
    <div className="flex flex-wrap gap-2 items-end">
      <label>رمز مدیر برای چاپ و تحویل<input className="inp block" type="password" value={password}
        onChange={(e) => setPassword(e.target.value)} /></label>
      <label>نوع شاهد<select className="inp block" value={witnessKind}
        onChange={(e) => setWitnessKind(e.target.value as typeof witnessKind)}>
        <option value="CUSTOMER_HANDOFF">تحویل حضوری به گیرنده</option>
        <option value="COURIER_ACK">تأیید تحویل پیک</option>
      </select></label>
      <label className="min-w-[220px] flex-1">شرح شاهد تحویل واقعی
        <input className="inp block w-full" value={witnessRef} onChange={(e) => { setWitnessRef(e.target.value); setConfirmed(false) }}
          placeholder="مثلاً مشتری سند چاپی را تحویل گرفت" />
      </label>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={confirmed}
        onChange={(e) => setConfirmed(e.target.checked)} />کد را واقعاً به گیرنده تحویل دادم</label>
    </div>
    {credits.map((credit) => <div className="flex flex-wrap gap-2 items-center" key={credit.creditId}>
      <span>اعتبار #{faDigits(credit.creditId)} · {money(credit.amount)} ریال ·
        {delivered.includes(credit.creditId) ? 'تحویل شاهددار ثبت شد' : 'منتظر تحویل'}</span>
      <button className="btn" disabled={busy !== null || !password.trim()}
        onClick={() => void print(credit.creditId)}>{printed.includes(credit.creditId) ? 'چاپ مجدد با رمز مدیر' : 'چاپ تحت نظر مدیر'}</button>
      <button className="btn btn-primary" disabled={busy !== null || !password.trim() || !confirmed || delivered.includes(credit.creditId)}
        onClick={() => void deliver(credit.creditId)}>ثبت تحویل واقعی</button>
    </div>)}
    {message && <p className="text-emerald-800">{message}</p>}
    {error && <p className="text-rose-800" role="alert">{error}</p>}
  </section>
}
