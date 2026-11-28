import { useNavigate } from 'react-router-dom'
import StocktakeReminderBanner from '../components/StocktakeReminderBadge'
import DeveloperCard from '../components/DeveloperCard'
import { TileIcon, type TileIconName } from '../components/TileIcons'

/**
 * کاشی‌های صفحهٔ اصلی. طرح ۱۴۰۵ · مورد ۹ (معماری §۴-۶): هر کاشی آیکون **اجباری و یکتای**
 * خودش را دارد (`icon`)؛ پنل تازه بی آیکون typecheck و آزمون
 * `tests/audit-fixes/plan1405-dashboard-tiles.mjs` را می‌شکند. رنگ بدنه (`color`) کمی ملایم‌تر
 * شد و نام روی نوار تیره‌تر (`bar`) می‌نشیند؛ تضاد نوشتهٔ سفید با نوار دست‌کم ۴٫۵ به ۱ است.
 * ۶ کاشی آخر (پیش از «تنظیمات») همان ماژول‌های منوی بالا هستند که کاشی نداشتند؛ قفل هر
 * ماژول روی خود صفحه است، نه روی دکمه.
 */
type Tile = { title: string; key: string; to: string; color: string; bar: string; icon: TileIconName }

const TILES: Tile[] = [
  { title: 'پنل فروش', key: 'F2', to: '/pos', color: 'bg-[#4aa8d8]', bar: 'bg-[#277aa5]', icon: 'cash-register' },
  { title: 'گزارشات فروش', key: 'F9', to: '/sales-reports', color: 'bg-[#3fb58a]', bar: 'bg-[#2d8062]', icon: 'report-analytics' },
  { title: 'گزارش مدیریت', key: '', to: '/management-reports', color: 'bg-[#2fa597]', bar: 'bg-[#247d73]', icon: 'chart-pie' },
  { title: 'کالاها', key: 'F8', to: '/products', color: 'bg-[#e0a03a]', bar: 'bg-[#966a23]', icon: 'shirt' },
  { title: 'فاکتور خرید', key: 'F3', to: '/purchase', color: 'bg-[#e8823f]', bar: 'bg-[#ad5d29]', icon: 'truck-delivery' },
  { title: 'فاکتور فروش', key: '', to: '/sales-invoice', color: 'bg-[#7f8ae0]', bar: 'bg-[#5a68d7]', icon: 'file-invoice' },
  { title: 'بستن صندوق', key: 'F10', to: '/cash-close', color: 'bg-[#6b7a90]', bar: 'bg-[#647387]', icon: 'cash-banknote' },
  { title: 'تجمیع و انتقال', key: 'F11', to: '/consolidation', color: 'bg-[#8fba3a]', bar: 'bg-[#5f7c27]', icon: 'arrows-join' },
  { title: 'برگشت از فروش', key: '', to: '/sales-return', color: 'bg-[#e87a8b]', bar: 'bg-[#d13a52]', icon: 'receipt-refund' },
  /** جلسه ۱۸ · بندهای ۴ و ۵ — انبارگردانی (شمارش فیزیکی و مغایرت‌ها) */
  { title: 'انبارگردانی', key: '', to: '/stocktake', color: 'bg-[#2b97b5]', bar: 'bg-[#237b94]', icon: 'clipboard-list' },
  /** ماژول مستقل «پنل پیامکی» (صف ارسال، قالب‌ها، سرویس‌دهنده) */
  { title: 'پنل پیامکی', key: '', to: '/sms-panel', color: 'bg-[#8f6fe0]', bar: 'bg-[#7d58d8]', icon: 'message-dots' },
  { title: 'انبار مرکزی', key: '', to: '/secondary-stock', color: 'bg-[#a98467]', bar: 'bg-[#8d6b50]', icon: 'building-warehouse' },
  { title: 'تغییر قیمت گروهی', key: '', to: '/price-adjust', color: 'bg-[#c776cc]', bar: 'bg-[#b044b7]', icon: 'tags' },
  { title: 'مدیریت اعتبار', key: '', to: '/credit-management', color: 'bg-[#5e8ee6]', bar: 'bg-[#3b70d1]', icon: 'gift-card' },
  { title: 'موجودی سایت', key: '', to: '/woo-sync', color: 'bg-[#9d7cd0]', bar: 'bg-[#875ec5]', icon: 'world' },
  { title: 'عوارض و مالیات', key: '', to: '/charges/tax/pos', color: 'bg-[#e07b70]', bar: 'bg-[#ce4030]', icon: 'receipt-tax' },
  { title: 'حق سرویس', key: '', to: '/charges/service/pos', color: 'bg-[#62b07c]', bar: 'bg-[#408056]', icon: 'coins' },
  { title: 'تنظیمات', key: '', to: '/settings', color: 'bg-[#2f978c]', bar: 'bg-[#288076]', icon: 'settings' }
]

export default function Dashboard() {
  const nav = useNavigate()
  return (
    <div className="min-h-full flex flex-col gap-3">
      {/* جلسه ۱۸ · بند ۵ — یادآوری انبارگردانی، همان لحظه‌ی ورود به برنامه */}
      <StocktakeReminderBanner />
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        {TILES.map((t) => (
          <button
            key={t.to}
            onClick={() => nav(t.to)}
            className={`${t.color} text-white h-32 rounded-lg shadow relative flex flex-col overflow-hidden hover:brightness-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-300`}
          >
            {t.key && <span className="absolute top-2 right-2 text-[10px] bg-black/25 px-1.5 py-0.5 rounded">{t.key}</span>}
            <span className="flex flex-1 items-center justify-center">
              <TileIcon name={t.icon} className="h-12 w-12" />
            </span>
            <span className={`${t.bar} w-full px-3 py-2 text-start font-bold`}>{t.title}</span>
          </button>
        ))}
      </div>
      {/* طرح ۱۴۰۵ · مورد ۱۰ — کادر توسعه‌دهنده در گوشهٔ پایین‌چپ، در جریان صفحه (نه شناور) */}
      <div className="mt-auto flex justify-end pt-2">
        <DeveloperCard />
      </div>
    </div>
  )
}
