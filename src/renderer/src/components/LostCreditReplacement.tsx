import { useState } from 'react'
import { call, CH } from '../lib/api'
import { toLatinDigits, faDigits, money } from '@shared/jalali'
import type { StoreCreditSafeRow } from '@shared/types'
import Modal from './Modal'

interface Manager { id: number; name: string; role: string; isActive: boolean }

/** This is a case review, not a name/phone-based ownership check. The source
 * instrument is canceled only after the named manager authenticates and the
 * witnessed receipt reference is checked by main in one transaction. */
export default function LostCreditReplacement({ credit, replacement, onOpenSuccessor, onRefresh }: {
  credit: StoreCreditSafeRow
  replacement?: { originalCreditId: number; successorCreditId: number; transferredAmount: number } | null
  onOpenSuccessor: (id: number) => void
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [managers, setManagers] = useState<Manager[]>([])
  const [managerId, setManagerId] = useState('')
  const [managerPin, setManagerPin] = useState('')
  const [receiptNo, setReceiptNo] = useState('')
  const [receiptRef, setReceiptRef] = useState('')
  const [witnessRef, setWitnessRef] = useState('')
  const [reason, setReason] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (replacement) return <section className="rounded border border-amber-400 bg-amber-50 p-3 space-y-2">
    <strong>پروندهٔ جانشینی اعتبار</strong>
    <p>ماندهٔ معتبر {money(replacement.transferredAmount)} ریال به سند #{faDigits(replacement.successorCreditId)} منتقل شده است.
      کد قدیمی دیگر خرج‌پذیر نیست؛ چاپ/ساخت کد تازه را تکرار نکنید. چاپ جانشین به‌معنای تحویل نیست.</p>
    <button className="btn btn-primary" onClick={() => onOpenSuccessor(replacement.successorCreditId)}>
      مشاهدهٔ جانشین و وضعیت چاپ/تحویل شاهددار
    </button>
  </section>
  if (credit.status !== 'ACTIVE' && credit.status !== 'PARTIALLY_USED') return null

  const close = () => {
    if (busy) return
    setOpen(false); setManagerPin(''); setReviewed(false); setError('')
  }
  const begin = async () => {
    setManagerPin(''); setReceiptNo(''); setReceiptRef(''); setWitnessRef('')
    setReason(''); setReviewed(false); setError(''); setManagerId('')
    setOpen(true)
    try {
      const directory = await call<{ rows: Manager[] }>(CH.staffDirectory, { includeInactive: false })
      setManagers((directory.rows ?? []).filter((m) => m.role === 'MANAGER' && m.isActive))
    } catch (e: any) { setError(e.message); setManagers([]) }
  }
  const submit = async () => {
    if (busy) return
    const typed = toLatinDigits(receiptNo).replace(/[\s,\u066C]/g, '')
    const parsed = /^\d+$/.test(typed) ? Number(typed) : NaN
    if ((credit.sourceInvoiceId != null && (!Number.isSafeInteger(parsed) || parsed <= 0)) ||
        (typed && (!Number.isSafeInteger(parsed) || parsed <= 0)))
      return setError('شمارهٔ فیش را فقط از روی رسید ارائه‌شده و به‌صورت عدد صحیح وارد کنید.')
    if (!reviewed || !Number.isSafeInteger(Number(managerId)) || Number(managerId) <= 0 || !managerPin.trim() ||
        [receiptRef, witnessRef, reason].some((text) => text.trim().length < 8))
      return setError('رسید/شاهد/دلیل (هرکدام حداقل ۸ نویسه)، تأیید بررسی و رمز مدیر تعیین‌شده لازم است.')
    setBusy(true); setError('')
    try {
      const result = await call<{ successorCreditId: number; transferredAmount: number }>(CH.creditManagerReplaceLost, {
        creditId: credit.id, receiptNo: typed ? parsed : null,
        receiptRef: receiptRef.trim(), witnessRef: witnessRef.trim(), reason: reason.trim(),
        approvingManagerId: Number(managerId), managerPin: managerPin.trim()
      })
      setManagerPin(''); setOpen(false); setReviewed(false)
      onOpenSuccessor(result.successorCreditId)
    } catch (e: any) {
      setManagerPin('')
      setError(e.message + ' اگر نتیجهٔ ثبت نامعلوم است، پیش از تلاش مجدد پروندهٔ مبدأ را تازه کنید.')
      onRefresh()
    } finally { setBusy(false) }
  }

  return <section className="rounded border border-slate-300 bg-white p-3 space-y-1">
    <p className="text-sm">کد گم‌شده؟ جست‌وجوی نام یا تلفن، مالکیت را اثبات نمی‌کند. فقط مدیر با رسید، شاهد و رمز شخصی می‌تواند ماندهٔ معتبر را انتقال دهد.</p>
    <button className="btn" onClick={() => void begin()}>بررسی مدیر برای جایگزینی کد گم‌شده</button>
    <Modal open={open} onClose={close} title="پروندهٔ جایگزینی کد گم‌شده" width="max-w-2xl"
      footer={<><button className="btn" disabled={busy} onClick={close}>انصراف</button>
        <button className="btn btn-primary" disabled={busy || !reviewed || !managerId || !managerPin.trim()}
          onClick={() => void submit()}>{busy ? 'در حال انتقال اتمیک…' : 'انتقال فقط ماندهٔ معتبر'}</button></>}>
      <p className="rounded bg-amber-50 p-2 text-sm">شمارهٔ فیش و مدارک را از شخصِ حاضر بررسی کنید؛ مقدار نشان‌داده‌شده در فهرست، نام و تلفن هیچ‌کدام مدرک مالکیت نیستند. اگر چاپ جانشین شکست بخورد کد قدیمی خودکار فعال نمی‌شود. بعداً تحویل شاهددار جداگانه لازم است.</p>
      <p>اعتبار مبدأ #{faDigits(credit.id)} · ماندهٔ نمایشی {money(credit.remaining)} ریال (مبلغ قطعی را سرور دوباره می‌سنجد).</p>
      <label className="block">شمارهٔ فیشِ ارائه‌شده {credit.sourceInvoiceId != null ? '(الزامی)' : '(در صورت وجود)'}
        <input className="inp block w-full" inputMode="numeric" autoComplete="off" value={receiptNo}
          onChange={(e) => setReceiptNo(e.target.value)} /></label>
      <label className="block">نشانی رسید/پرونده (حداقل ۸ نویسه)
        <input className="inp block w-full" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} /></label>
      <label className="block">شاهد بررسی حضوری مدیر (حداقل ۸ نویسه)
        <input className="inp block w-full" value={witnessRef} onChange={(e) => setWitnessRef(e.target.value)} /></label>
      <label className="block">دلیل فقدان و جانشینی (حداقل ۸ نویسه)
        <textarea className="inp block w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <label className="block">مدیر تأییدکننده
        <select className="inp block w-full" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">انتخاب مدیر فعال</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select></label>
      <label className="block">رمز شخصیِ همان مدیر
        <input className="inp block w-full" type="password" autoComplete="off" value={managerPin}
          onChange={(e) => setManagerPin(e.target.value)} /></label>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={reviewed}
        onChange={(e) => setReviewed(e.target.checked)} />رسید و شاهد را حضوری بررسی کردم و انتقال مانده را تأیید می‌کنم</label>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
    </Modal>
  </section>
}
