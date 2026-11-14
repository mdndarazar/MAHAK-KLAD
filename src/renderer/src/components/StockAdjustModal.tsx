import { useEffect, useState } from 'react'
import Modal from './Modal'
import ConfirmDialog from './ConfirmDialog'
import PasswordField from './PasswordField'
import { call, CH } from '../lib/api'
import { usePanelLock } from '../hooks/usePanelLocks'
import { PANEL_KEYS } from '@shared/panels'
import { faDigits } from '@shared/jalali'

/**
 * «موجودی / انبارگردانی»: تعیین موجودی شمارش‌شده.
 * IPC: stock:adjust ← ProductService.adjustStock ← inventoryService.setStock
 * فقط اختلاف به‌عنوان یک حرکت ADJUSTMENT ثبت می‌شود (سابقه پاک نمی‌شود).
 *
 * نکته: از فرم کالا هم می‌توان موجودی را مستقیم ویرایش کرد؛ این مودال برای
 * انبارگردانی و ثبت توضیح اختصاصی است، نه یک مسیر اجباری.
 *
 * اصل «بدون مانع»: عدد منفی یا اختلاف صفر دیگر عملیات را رد نمی‌کند؛ فقط
 * هشدار قابل‌تایید (منفی) یا پیام اطلاعی (بدون تغییر) نشان داده می‌شود.
 *
 * نشست ۱۴۶ · بند ۴-۳۹/۴-۴۰ — «اصلاح موجودی» فقط‌مدیر است و main خودش رمز
 * پنل کالاها را می‌سنجد؛ پس اگر قفل این پنل روشن است (یا سیاست هنوز خوانده
 * نشده ⇒ fail-closed)، رمز همراه همین ثبت فرستاده می‌شود و بعد از ثبت پاک می‌شود.
 */
export default function StockAdjustModal({
  open,
  variant,
  onClose,
  onSaved
}: {
  open: boolean
  variant: any | null
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [qty, setQty] = useState(0)
  const [note, setNote] = useState('')
  /**
   * مورد ۱۱ — کاهش دستی موجودی بدون علت ثبت نمی‌شود. «خرابی/کسری» با بهای FIFO
   * زیان موجودی است؛ «اصلاح اشتباه» زیان نمی‌سازد. افزایش از این مسیر بسته است.
   */
  const [kind, setKind] = useState<'DAMAGE' | 'CORRECTION'>('DAMAGE')
  const [err, setErr] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const { lockEnabled, loaded } = usePanelLock(PANEL_KEYS.products)
  const needPassword = !loaded || lockEnabled

  useEffect(() => {
    if (!open || !variant) return
    setQty(variant.stock ?? 0)
    setNote('')
    setKind('DAMAGE')
    setErr(null)
    setWarn(null)
    setBusy(false)
    setPassword('')
  }, [open, variant])

  /** بسته شدن ⇒ رمز از حافظه پاک شود (هیچ‌جا ذخیره نمی‌شود). */
  useEffect(() => {
    if (!open) setPassword('')
  }, [open])

  const delta = Math.round(qty) - (variant?.stock ?? 0)

  const doSave = async () => {
    if (!variant) return
    setWarn(null)
    if (delta === 0) {
      onSaved('موجودی تغییری نداشت؛ حرکت انباری ثبت نشد')
      return
    }
    setBusy(true)
    try {
      // نشست ۱۴۴ — بدون گرد بی‌صدا؛ main موجودی اعشاری را با پیام فارسی رد می‌کند.
      await call(CH.stockAdjust, {
        variantId: variant.id,
        newQty: qty,
        kind,
        note: note.trim(),
        managerPassword: password.trim() || null
      })
      setPassword('')
      onSaved(`موجودی «${variant.product?.name ?? ''}» به ${faDigits(Math.round(qty))} تغییر کرد`)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!variant) return
    if (!Number.isFinite(qty)) return setErr('موجودی باید یک عدد باشد')
    if (delta > 0)
      return setErr(
        'افزایش دستی موجودی مجاز نیست. مازاد فقط از مسیر «انبارگردانی» (با مجوز مدیر، دلیل و بهای صریح) یا با فاکتور خرید واقعی ثبت می‌شود.'
      )
    if (delta < 0 && note.trim().length < 3)
      return setErr('برای کاهش موجودی، شرح علت الزامی است (دست‌کم ۳ نویسه).')
    if (needPassword && delta !== 0 && !password.trim())
      return setErr('اصلاح دستی موجودی تأیید مدیر لازم دارد؛ رمز مدیر (یا رمز دوم پنل کالاها) را وارد کنید.')
    setErr(null)
    if (Math.round(qty) < 0) {
      setWarn(
        'موجودی وارد‌شده منفی است. موجودی منفی معمولاً نشانه‌ی جا افتادن یک فاکتور خرید است و ممکن است گزارش‌های انبار را گمراه‌کننده کند. این حرکت با همین عدد در گردش انبار ثبت خواهد شد.'
      )
      return
    }
    void doSave()
  }

  /** Esc وقتی هشدار باز است فقط هشدار را می‌بندد، نه کل مودال. */
  const closeGuarded = () => {
    if (warn) return setWarn(null)
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        title="اصلاح موجودی / انبارگردانی"
        onClose={closeGuarded}
        width="max-w-md"
        footer={
          <>
            <button className="btn" onClick={closeGuarded} disabled={busy}>
              انصراف
            </button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'در حال ثبت…' : 'ثبت حرکت'}
            </button>
          </>
        }
      >
        {variant && (
          <>
            <div className="bg-slate-50 border rounded p-2">
              <div className="font-bold">
                {variant.product?.name}
                {variant.size ? ` سایز ${faDigits(variant.size)}` : ''}
              </div>
              <div className="kbd">
                کد {faDigits(variant.code)} · بارکد {faDigits(variant.barcode)} · موجودی فعلی {faDigits(variant.stock)}
              </div>
            </div>
            <label className="block">
              <div className="mb-1">موجودی شمارش‌شده</div>
              <input type="number" className="inp" autoFocus value={qty} onChange={(e) => setQty(+e.target.value)} />
            </label>
            <div className={`text-center py-1 rounded ${delta === 0 ? 'bg-slate-100' : delta > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
              {delta === 0 ? (
                'اختلافی با موجودی فعلی نیست؛ با ثبت، حرکتی ساخته نمی‌شود'
              ) : (
                <>
                  حرکت ثبت‌شدنی: {delta > 0 ? '+' : '−'}
                  {faDigits(Math.abs(delta))}
                </>
              )}
            </div>
            {delta < 0 && (
              <div className="space-y-1">
                <div className="mb-1 font-bold">علت کاهش موجودی (اجباری)</div>
                <label className="flex items-start gap-2 rounded border p-2 cursor-pointer">
                  <input
                    type="radio"
                    className="w-4 h-4 mt-1"
                    name="stock-loss-kind"
                    checked={kind === 'DAMAGE'}
                    onChange={() => setKind('DAMAGE')}
                  />
                  <span>
                    <b>خرابی/کسری</b>
                    <div className="kbd leading-5">با بهای FIFO همان حرکت، زیان موجودی ثبت می‌شود و جدا از سود دیده می‌شود.</div>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded border p-2 cursor-pointer">
                  <input
                    type="radio"
                    className="w-4 h-4 mt-1"
                    name="stock-loss-kind"
                    checked={kind === 'CORRECTION'}
                    onChange={() => setKind('CORRECTION')}
                  />
                  <span>
                    <b>اصلاح اشتباه</b>
                    <div className="kbd leading-5">شمارش/ثبت قبلی غلط بوده و فقط اصلاح می‌شود؛ زیان موجودی نمی‌سازد.</div>
                  </span>
                </label>
              </div>
            )}
            <label className="block">
              <div className="mb-1">توضیح (برای کاهش، اجباری است)</div>
              <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: دو عدد پاره شد" />
            </label>
            {needPassword && (
              <label className="block">
                <div className="mb-1">رمز مدیر (یا رمز دوم پنل کالاها)</div>
                <PasswordField value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="kbd leading-6">
                  اصلاح دستی موجودی کار «فقط مدیر» است؛ سرور رمز را خودش می‌سنجد و نوع تأیید همراه نام کارمند نشست در
                  سابقه ثبت می‌شود.
                </div>
              </label>
            )}
            {err && <div className="bg-amber-100 border border-amber-300 rounded px-3 py-2">{err}</div>}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!warn}
        title="موجودی منفی می‌شود"
        message={
          <>
            <div>{warn}</div>
            <div className="font-bold">آیا مطمئن هستید که می‌خواهید همین حالا ثبت شود؟</div>
          </>
        }
        busy={busy}
        onConfirm={() => void doSave()}
        onCancel={() => setWarn(null)}
      />
    </>
  )
}
