import { useNavigate } from 'react-router-dom'

/** The existing Cash Closing top-bar/F10 module entry. Deliberately outside
 * Shell and ManagerSessionProvider: choosing history must never mount custody
 * status, expected cash, shift creation, rollover or settings migration. */
export default function CashClosingLanding() {
  const nav = useNavigate()
  return (
    <main dir="rtl" className="min-h-screen bg-slate-50 p-4 sm:p-8 text-slate-900">
      <div className="mx-auto max-w-3xl space-y-5">
        <button className="btn" onClick={() => nav('/')}>بازگشت به صفحهٔ اصلی</button>
        <header className="rounded-lg bg-white border border-slate-200 shadow-sm p-5 space-y-2">
          <h1 className="text-xl font-bold">بستن صندوق</h1>
          <p className="text-sm text-slate-600 leading-7">از همین بخش می‌توانید تاریخچهٔ بستن و تحویل‌های انجام‌شده را ببینید یا وارد صفحهٔ فعلی بستن صندوق شوید.</p>
        </header>
        <div className="grid gap-4 sm:grid-cols-2">
          <button type="button" className="text-right rounded-lg border-2 border-sky-300 bg-sky-50 hover:bg-sky-100 p-5 space-y-2" onClick={() => nav('/cash-close/history')}>
            <span className="block font-bold text-lg text-sky-950">گزارش بستن و تحویل‌های گذشته</span>
            <span className="block text-sm leading-7">فقط مشاهدهٔ رویدادهای تکمیل‌شده، تاریخ شمسی و مبلغ مرجع ثبت‌شده در همان لحظه؛ دیدن گزارش صندوق را نمی‌بندد.</span>
          </button>
          <button type="button" className="text-right rounded-lg border-2 border-slate-300 bg-white hover:bg-slate-100 p-5 space-y-2" onClick={() => nav('/cash-close/operate')}>
            <span className="block font-bold text-lg">ورود به صفحهٔ فعلی بستن صندوق</span>
            <span className="block text-sm leading-7">همان صفحه و همان دسترسی‌های قبلی؛ ورود به آن انتخابی جداگانه است.</span>
          </button>
        </div>
      </div>
    </main>
  )
}
