import { useEffect, useState } from 'react'
import { call, CH } from '../lib/api'
import Modal from './Modal'
import { faDigits } from '@shared/jalali'
import { resetConfirmMatches } from '@shared/gateCatalog'

/**
 * طرح ۱۴۰۵ · مورد ۸ — بخش «صفر کردن برنامه» در تنظیمات (معماری §۴-۲؛ طرح §۲۵-۱۰ بند «ج»).
 *
 * توضیح کامل هر حالت (چه پاک می‌شود، چه می‌ماند، چه اثری دارد) همیشه دیده می‌شود و دکمه فقط پس از انتخاب
 * یک حالت (یعنی دیدن توضیح همان حالت)، رسیدن پیش‌نمایش شمارش و بودن جای کافی فعال می‌شود. پنجرهٔ تأیید پایانی
 * خلاصه، شمارش و نام بکاپ را تکرار می‌کند؛ سپس تایپ «صفر» و تیک «می‌دانم برگشت فقط با بکاپ ممکن است».
 * دروازه (قفل کار «صفر کردن برنامه») در main سنجیده می‌شود؛ اگر قفل است، پنجرهٔ سراسری «باز کردن قفل این کار»
 * خودش باز می‌شود و پس از باز کردن قفل، همین دکمه دوباره زده می‌شود.
 */

type Mode = 'transactions' | 'full'
interface Headline { table: string; label: string; count: number }
interface ModePreview { mode: Mode; headlines: Headline[]; deletedRows: number; zeroStockItems: number; nextReceiptNo: number }
interface Receipt {
  at: string
  atJalali: string
  mode: Mode
  backup: { id: string; fileName: string; size: number }
  previousDatabaseFile: string
  deleted: Headline[]
  deletedRows: number
  zeroStockItems: number
  nextReceiptNo: number
}
interface Preview {
  modes: Record<Mode, ModePreview>
  protectedBackups: { count: number; bytes: number }
  space: { databaseBytes: number; freeBytes: number | null; neededBytes: number; enough: boolean }
  lastReset: Receipt | null
}

const MODE_TEXT: Record<Mode, { title: string; body: string[] }> = {
  transactions: {
    title: 'فقط تراکنش‌ها',
    body: [
      'همهٔ فروش‌ها، برگشت‌ها و تعویض‌ها، خریدها، بستن‌های صندوق و شیفت‌ها، تجمیع‌ها، اعتبارهای خرید و بارکدهایشان، نسیه و چک‌های مشتری‌ها، گردش موجودی، صف پیامک و گزارش کارها پاک می‌شوند.',
      'کالاها با قیمت و بارکد، دسته‌ها، فهرست مشتری‌ها و تأمین‌کننده‌ها، کاربران و کارمندان و همهٔ تنظیمات می‌مانند.',
      'موجودی فروشگاه و انبار مرکزی صفر می‌شود. برنامه بهای تمام‌شده و سود را از فاکتورهای خرید حساب می‌کند؛ اگر خریدها پاک شوند و موجودی بماند، سود گزارش مدیریت غلط درمی‌آید. پس از صفر کردن، موجودی واقعی را با «فاکتور خرید» وارد کنید تا قیمت خرید هم ثبت شود.',
      'شمارهٔ فیش فروش ادامه پیدا می‌کند تا هیچ فیش تازه‌ای هم‌شمارهٔ فیش کاغذی قدیمی نشود. بارکدهای اعتباری قدیمی مشتری‌ها دیگر کار نمی‌کنند. همگام‌سازی موجودی سایت خاموش می‌ماند تا خودتان روشنش کنید.'
    ]
  },
  full: {
    title: 'کامل',
    body: [
      'برنامه مثل روز نصب می‌شود. همهٔ کالاها، مشتری‌ها، فروش‌ها، کاربران و کارکنان، رمزهای حضانت و تنظیمات پاک می‌شوند؛ مثل سیاست حسابداری، شیفت‌ها، تخفیف، کلید پیامک و اتصال موجودی سایت.',
      'این‌ها می‌مانند: بکاپ‌ها؛ رمز مدیر؛ هر چه در تب «رمز مدیر و خروج» است (قفل ماژول‌ها، رمزهای دوم و سوم، قفل موقت پس از رمز اشتباه، کدهای یک‌بارمصرف)؛ تنظیمات چاپ و قالب فاکتور و چاپگر گواهی اعتبار؛ کنترل از راه دور؛ و تلگرام و بله.',
      'ساعت شیفت‌ها به پیش‌فرض برمی‌گردد. رمزهای سوم با شمارهٔ شیفت کار می‌کنند، پس ساعت شیفت‌ها را دوباره تنظیم کنید. شمارهٔ فیش فروش از ۱ شروع می‌شود و بارکدهای اعتباری قدیمی کار نمی‌کنند.'
    ]
  }
}

const BOTH_TEXT = [
  'پیش از هر کاری، برنامه یک بکاپ کامل می‌گیرد و آن را می‌سنجد. اگر بکاپ نشود، هیچ چیزی پاک نمی‌شود. پروندهٔ قبلی داده هم پاک نمی‌شود و فقط تغییر نام می‌گیرد.',
  'اگر پشیمان شدید: «تنظیمات ← بکاپ و بازگردانی ← بکاپ «پیش از صفر کردن»» را با «جایگزینی کامل» برگردانید.',
  'کنترل از راه دور سر جایش می‌ماند، ولی همهٔ مجوزهای گوشی و قفل‌های باز بسته می‌شوند و گوشی‌ها باید دوباره وارد شوند. پس از کار، برنامه خودش دوباره باز می‌شود.'
]

const MODES: Mode[] = ['transactions', 'full']

function fileSize(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024 * 1024) return `${faDigits(Math.ceil(n / 1024))} کیلوبایت`
  return `${faDigits((n / 1024 / 1024).toFixed(1))} مگابایت`
}

function headlineText(list: Headline[]): string {
  return list.length ? list.map((h) => `${faDigits(h.count)} ${h.label}`).join('، ') : 'چیزی ثبت نشده است'
}

/** آیکون اختصاصی «صفر کردن» (پیکان چرخشی دور یک صفر)؛ تزئینی. */
function ResetIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0 -2.3 5.6" />
      <path d="M20 4v7h-7" />
      <ellipse cx="12" cy="12" rx="2.5" ry="3.5" />
    </svg>
  )
}

export default function FactoryResetSection() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const load = async () => {
    setErr(null)
    try {
      setPreview(await call<Preview>(CH.factoryResetPreview))
    } catch (e: any) {
      setErr(e.message)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const run = async () => {
    if (!mode) return
    setBusy(true)
    setErr(null)
    try {
      const r = await call<Receipt>(CH.factoryResetRun, { mode, confirmText, acknowledged })
      setConfirmOpen(false)
      setReceipt(r)
    } catch (e: any) {
      // رد دروازه پنجرهٔ سراسری «باز کردن قفل این کار» را باز می‌کند؛ متن همین‌جا هم می‌ماند
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const relaunch = async () => {
    try {
      await call(CH.factoryResetRelaunch)
    } catch (e: any) {
      setErr(e.message)
    }
  }

  const chosen = mode && preview ? preview.modes[mode] : null

  return (
    <section className="space-y-3">
      <h2 className="font-bold border-b pb-1 flex items-center gap-2 text-red-800">
        <ResetIcon />
        صفر کردن برنامه
      </h2>
      <p className="leading-7">
        برای شروع از اول، مثلاً پس از دورهٔ آموزش و تمرین. یکی از دو حالت را انتخاب کنید؛ توضیح کامل هر حالت همین‌جا
        آمده است. تا حالتی انتخاب نشود، دکمه فعال نمی‌شود.
      </p>

      {preview?.lastReset && (
        <div className="rounded border border-slate-300 bg-slate-50 px-3 py-2 leading-7">
          آخرین صفر کردن: <b>{faDigits(preview.lastReset.atJalali)}</b> · حالت «{MODE_TEXT[preview.lastReset.mode].title}» · بکاپ:{' '}
          <b>{preview.lastReset.backup.fileName}</b>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3" role="radiogroup" aria-label="حالت صفر کردن">
        {MODES.map((m) => {
          const info = preview?.modes[m]
          return (
            <label
              key={m}
              className={`block rounded border-2 p-3 cursor-pointer space-y-2 ${mode === m ? 'border-red-600 bg-red-50' : 'border-slate-200 bg-white'}`}
            >
              <div className="flex items-center gap-2 font-bold text-base">
                <input type="radio" name="factory-reset-mode" checked={mode === m} onChange={() => setMode(m)} />
                حالت «{MODE_TEXT[m].title}»
              </div>
              {MODE_TEXT[m].body.map((line) => (
                <p key={line} className="leading-7">
                  {line}
                </p>
              ))}
              {info && (
                <div className="rounded bg-white/70 border px-2 py-1 leading-7 text-sm">
                  <div>پاک می‌شود: {headlineText(info.headlines)}</div>
                  {m === 'transactions' && info.zeroStockItems > 0 && <div>موجودی {faDigits(info.zeroStockItems)} کالا صفر می‌شود.</div>}
                  <div>
                    شمارهٔ فیش بعدی پس از صفر کردن: <b>{faDigits(info.nextReceiptNo)}</b>
                  </div>
                </div>
              )}
            </label>
          )
        })}
      </div>

      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 space-y-1 leading-7">
        {BOTH_TEXT.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {preview && (
          <p>
            بکاپ‌های «پیش از صفر کردن» که تا امروز مانده‌اند: {faDigits(preview.protectedBackups.count)} پرونده،{' '}
            {fileSize(preview.protectedBackups.bytes)}. این بکاپ‌ها خودکار پاک نمی‌شوند؛ هر صفر کردن یک بکاپ کامل تازه
            می‌سازد.
          </p>
        )}
        {preview && (
          <p className={preview.space.enough ? '' : 'font-bold text-red-700'}>
            جای خالی دیسک: {preview.space.freeBytes === null ? 'سنجیده نشد' : fileSize(preview.space.freeBytes)} · لازم:{' '}
            {fileSize(preview.space.neededBytes)}
            {!preview.space.enough && ' — جای خالی کافی نیست؛ صفر کردن انجام نمی‌شود.'}
          </p>
        )}
        <p className="text-sm text-slate-600">
          اگر قفل «صفر کردن برنامه» روشن است و نشست مدیر باز نیست، پنجرهٔ «باز کردن قفل این کار» باز می‌شود؛ پس از باز
          کردن قفل، دوباره دکمهٔ «صفر کن» را بزنید.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          className="btn btn-danger"
          disabled={!mode || !preview || !preview.space.enough || busy}
          onClick={() => {
            setConfirmText('')
            setAcknowledged(false)
            setErr(null)
            setConfirmOpen(true)
          }}
        >
          {mode ? `ادامه: صفر کردن «${MODE_TEXT[mode].title}»…` : 'اول یکی از دو حالت را انتخاب کنید'}
        </button>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          به‌روز کردن شمارش‌ها
        </button>
      </div>

      {err && <div className="rounded px-3 py-2 border bg-amber-100 border-amber-300 whitespace-pre-line">{err}</div>}

      <Modal
        open={confirmOpen && !!mode}
        title="تأیید پایانی صفر کردن"
        onClose={() => {
          if (!busy) setConfirmOpen(false)
        }}
        width="max-w-2xl"
        footer={
          <>
            <button className="btn" onClick={() => setConfirmOpen(false)} disabled={busy}>
              انصراف
            </button>
            <button className="btn btn-danger" disabled={busy || !resetConfirmMatches(confirmText) || !acknowledged} onClick={() => void run()}>
              {busy ? 'در حال بکاپ و صفر کردن…' : 'صفر کن'}
            </button>
          </>
        }
      >
        {mode && (
          <div className="space-y-2 leading-7">
            <p className="font-bold text-base text-red-800">حالت «{MODE_TEXT[mode].title}»</p>
            <p>{MODE_TEXT[mode].body[0]}</p>
            {chosen && <p>پاک می‌شود: {headlineText(chosen.headlines)}</p>}
            {chosen && (
              <p>
                شمارهٔ فیش بعدی: <b>{faDigits(chosen.nextReceiptNo)}</b>
              </p>
            )}
            <p>
              نام بکاپ: <b>«پیش از صفر کردن – تاریخ و ساعت همین لحظه»</b> در «تنظیمات ← بکاپ و بازگردانی».
            </p>
            <label className="block">
              <span className="block mb-1">برای تأیید، واژهٔ «صفر» را بنویسید:</span>
              <input className="input w-40" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={busy} autoFocus />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={busy} />
              می‌دانم برگشت فقط با بکاپ ممکن است.
            </label>
            {err && <div className="rounded px-3 py-2 border bg-amber-100 border-amber-300 whitespace-pre-line">{err}</div>}
          </div>
        )}
      </Modal>

      <Modal
        open={!!receipt}
        title="صفر کردن انجام شد"
        onClose={() => setReceipt(null)}
        width="max-w-2xl"
        footer={
          <button className="btn btn-primary" onClick={() => void relaunch()}>
            باشه، برنامه همین حالا دوباره باز شود
          </button>
        }
      >
        {receipt && (
          <div className="space-y-2 leading-7">
            <p>
              تاریخ: <b>{faDigits(receipt.atJalali)}</b> · حالت «{MODE_TEXT[receipt.mode].title}»
            </p>
            <p>
              بکاپ پیش از صفر کردن: <b>{receipt.backup.fileName}</b> ({fileSize(receipt.backup.size)})
            </p>
            <p>
              پروندهٔ قبلی داده پاک نشد و با این نام کنار پوشهٔ داده ماند: <b dir="ltr">{receipt.previousDatabaseFile}</b>
            </p>
            <p>پاک شد: {headlineText(receipt.deleted)}</p>
            {receipt.zeroStockItems > 0 && <p>موجودی {faDigits(receipt.zeroStockItems)} کالا صفر شد.</p>}
            <p>
              شمارهٔ فیش بعدی: <b>{faDigits(receipt.nextReceiptNo)}</b>
            </p>
            <p>
              برای برگرداندن: «تنظیمات ← بکاپ و بازگردانی ← {receipt.backup.fileName} ← جایگزینی کامل».
            </p>
            <p className="font-bold">برنامه تا یک دقیقهٔ دیگر خودش دوباره باز می‌شود.</p>
          </div>
        )}
      </Modal>
    </section>
  )
}
