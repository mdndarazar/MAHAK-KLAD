import { useState } from 'react'
import { call, CH } from '../../lib/api'
import { faDigits, money } from '@shared/jalali'

export type HandoffCredit = {
  id: number
  amount: number
  status: string
  publicReference: string
  printCount?: number
  expiresAtJalali?: string | null
  returnId?: number | null
  exchangeInvoiceId?: number | null
}

/** Optional printing and handoff notes are audit-only; the barcode is ACTIVE at issuance. */
export default function ReturnCreditHandoffActions({ credits }: { credits?: HandoffCredit[] }) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [printedIds, setPrintedIds] = useState<Set<number>>(new Set())
  const [activeIds, setActiveIds] = useState<Set<number>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = (credits ?? []).filter((credit) => credit.status === 'ACTIVE' || credit.status === 'DRAFT')
  if (!pending.length) return null

  const printCertificate = async (credit: HandoffCredit) => {
    if (busyId != null) return
    setBusyId(credit.id)
    setNotice(null)
    setError(null)
    try {
      const result = await call<any>(CH.creditDeliveryPrint, { id: credit.id, copies: 1 })
      const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : []
      setPrintedIds((current) => new Set(current).add(credit.id))
      setNotice(warnings.length ? warnings.join('\n') : `گواهی بارکد ${credit.publicReference} برای چاپ فرستاده شد؛ اعتبار از زمان صدور فعال بوده است.`)
    } catch (cause: any) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusyId(null)
    }
  }

  const confirmHandoff = async (credit: HandoffCredit) => {
    if (busyId != null || !window.confirm(`آیا بارکد ${credit.publicReference} واقعاً به خود مشتری تحویل شده است؟ این ثبت فقط سابقه است و روی فعال‌بودن اعتبار اثری ندارد.`)) return
    setBusyId(credit.id)
    setNotice(null)
    setError(null)
    try {
      const result = await call<any>(CH.creditDeliveryConfirm, { id: credit.id })
      setActiveIds((current) => new Set(current).add(credit.id))
      setNotice(result?.replayed
        ? `سابقه‌ی تحویل ${credit.publicReference} قبلاً ثبت شده بود؛ اعتبار از لحظه‌ی صدور فعال بوده است.`
        : `سابقه‌ی تحویل ${credit.publicReference} ثبت شد؛ اعتبار از لحظه‌ی صدور فعال بوده است.`)
    } catch (cause: any) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="w-full rounded border border-indigo-300 bg-indigo-50 p-3 space-y-2">
      <b>چاپ و ثبت تحویل بارکدهای برگشت/تعویض (اختیاری؛ اعتبارها از زمان صدور فعال‌اند)</b>
      <div className="space-y-2">
        {pending.map((credit) => {
          const active = activeIds.has(credit.id)
          const alreadyPrinted = Number(credit.printCount ?? 0) > 0 || printedIds.has(credit.id)
          return (
            <div key={credit.id} className="flex flex-wrap items-center gap-2 rounded bg-white border p-2">
              <span className="font-bold">{credit.publicReference} · {money(credit.amount)} ریال</span>
              {credit.expiresAtJalali && <span className="kbd">انقضا: {faDigits(credit.expiresAtJalali)}</span>}
              {active ? (
                <span className="font-bold text-emerald-700">سابقه‌ی تحویل ثبت شده · اعتبار فعال است</span>
              ) : (
                <span className="font-bold text-emerald-700">اعتبار از لحظه‌ی صدور فعال است</span>
              )}
              <>
                {!alreadyPrinted ? (
                  <button className="btn" disabled={busyId != null} onClick={() => void printCertificate(credit)}>
                    {busyId === credit.id ? 'در حال چاپ…' : 'چاپ گواهی بارکد'}
                  </button>
                ) : (
                  <span className="kbd">گواهی قبلاً چاپ شده؛ چاپ مجدد فقط با تأیید مدیر</span>
                )}
                <button className="btn btn-primary" disabled={busyId != null} onClick={() => void confirmHandoff(credit)}>
                  {busyId === credit.id ? 'در حال ثبت…' : 'ثبت سابقه‌ی تحویل واقعی (اختیاری)'}
                </button>
              </>
            </div>
          )
        })}
      </div>
      {notice && <div className="text-emerald-800 whitespace-pre-line">{notice}</div>}
      {error && <div className="text-rose-700 whitespace-pre-line">{error}</div>}
    </div>
  )
}
