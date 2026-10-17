import { useEffect, useRef, useState } from 'react'
import { call, CH } from '../lib/api'
import { faDigits } from '@shared/jalali'

type Item = { id: number; variantId: number; variantCode: string | null; variantName: string | null;
  qty: number; received: number; pending: number }
type Goods = { managed: boolean; state?: string | null; voided?: boolean; corrected?: boolean;
  restockPending?: boolean; items: Item[] }

/** Cashier: scan or explicitly select + count the physical goods. This form
 * cannot touch payment, bank evidence or the customer's cash entitlement. */
export default function ReturnGoodsIntake({ returnId, onReceived }: { returnId: number; onReceived?: () => void }) {
  const [goods, setGoods] = useState<Goods | null>(null)
  const [itemId, setItemId] = useState<number | null>(null)
  const [qty, setQty] = useState('1')
  const [scan, setScan] = useState('')
  const [manual, setManual] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  // Keep the SAME key after an uncertain response. Changing a field starts a
  // new operation, never retries an already-posted quantity as a second one.
  const key = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const refresh = async () => {
    const result = await call<Goods>(CH.returnGoodsItems, { returnId })
    setGoods(result)
    setItemId((old) => result.items.some((i) => i.id === old && i.pending > 0)
      ? old : result.items.find((i) => i.pending > 0)?.id ?? null)
  }
  useEffect(() => {
    setGoods(null); setMessage(''); setError(''); key.current = crypto.randomUUID()
    void refresh().catch((e: Error) => setError(e.message))
  }, [returnId])
  const selected = goods?.items.find((i) => i.id === itemId) ?? null
  const change = () => { key.current = crypto.randomUUID(); setConfirmed(false); setError(''); setMessage('') }
  const receive = async () => {
    if (!selected || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const count = Number(qty)
      if (!Number.isSafeInteger(count) || count <= 0 || count > selected.pending)
        throw new Error('تعداد واقعی را به‌صورت صحیح و حداکثر ماندهٔ قلم وارد کنید.')
      const scanned = scan.trim()
      const res = await call<{ releasedQty: number; replayed: boolean }>(CH.returnGoodsReceive, {
        returnId, returnItemId: selected.id, qty: count, eventKey: key.current,
        witnessKind: scanned ? 'SCAN' : 'SELECTED_CONFIRMED',
        witnessRef: scanned || manual.trim(), physicalConfirmed: confirmed
      })
      setMessage(`${faDigits(res.releasedQty)} عدد از قلم انتخابی با شاهد دریافت شد${res.replayed ? ' (تلاش تکراری؛ موجودی دوباره تغییر نکرد)' : ''}. تسویهٔ پول و اعتبار مستقل از رسید کالا است.`)
      key.current = crypto.randomUUID()
      setConfirmed(false); setScan(''); setManual(''); setQty('1')
      await refresh(); onReceived?.()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false); lock.current = false }
  }
  return (
    <section className="rounded border-2 border-sky-400 bg-sky-50 p-3 space-y-2">
      <h3 className="font-bold">دریافت فیزیکی کالای برگشتی · سند #{faDigits(returnId)}</h3>
      <p className="text-sm">کالا فقط پس از اسکن یا انتخابِ قلم، شمارش و تأیید واقعی وارد موجودی می‌شود؛ نه با «پرداخت شد»، لغو درخواست یا چاپ رسید.</p>
      {goods && !goods.managed && <p className="text-amber-800">این پروندهٔ قدیمی دفتر دریافت مقدارمحور ندارد؛ رسیدگی مدیر لازم است. حضور فیزیکی از سند مالی حدس زده نمی‌شود.</p>}
      {goods?.voided && <p className="text-rose-700">سند باطل شده است؛ دریافت تازه مجاز نیست.</p>}
      {goods?.corrected && <p className="text-rose-700">اصلاح جبرانی برای این برگشت ثبت شده است؛ سند اصلی تاریخی است و دیگر دریافت تازه روی آن مجاز نیست.</p>}
      {!!goods?.managed && !goods.voided && !goods.corrected && <>
        {goods.items.map((i) => <div key={i.id} className="flex items-center gap-2">
          <input type="radio" name={`goods-${returnId}`} checked={i.id === itemId} disabled={!i.pending}
            onChange={() => { change(); setItemId(i.id) }} />
          <span>{i.variantName || i.variantCode || `قلم #${faDigits(i.id)}`}</span>
          <span className="text-sm">(مورد انتظار: {faDigits(i.qty)} · دریافت‌شده: {faDigits(i.received)} · مانده: {faDigits(i.pending)})</span>
        </div>)}
        {selected?.pending ? <div className="flex flex-wrap gap-2 items-end">
          <label>تعدادِ دیده‌شده
            <input className="inp w-24 block" type="number" min="1" max={selected.pending} step="1"
              value={qty} onChange={(e) => { change(); setQty(e.target.value) }} />
          </label>
          <label>اسکن کد کالا (اگر اسکن شد)
            <input className="inp w-44 block" value={scan} onChange={(e) => { change(); setScan(e.target.value) }} />
          </label>
          <label className="flex-1 min-w-[200px]">اگر بدون اسکن انتخاب شد: شرح کوتاه مشاهده
            <input className="inp w-full block" value={manual} onChange={(e) => { change(); setManual(e.target.value) }}
              placeholder="مثلاً دو لباس روی میز شمارش شد" />
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => { change(); setConfirmed(e.target.checked) }} />
            همین تعداد کالا را واقعاً دیدم و تحویل گرفتم
          </label>
          <button className="btn btn-primary" disabled={busy || !confirmed || (!scan.trim() && manual.trim().length < 8)}
            onClick={() => void receive()}>{busy ? 'در حال ثبت…' : 'ثبت دریافت کالا'}</button>
        </div> : <p className="text-emerald-800">همهٔ اقلام این سند دریافت شده‌اند.</p>}
      </>}
      {message && <p className="text-emerald-800">{message}</p>}
      {error && <p className="text-rose-700">{error} <button className="btn ms-2" onClick={() => void receive()}>تلاش دوباره با همان شناسه</button></p>}
    </section>
  )
}
