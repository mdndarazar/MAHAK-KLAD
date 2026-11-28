import { faDigits } from '@shared/jalali'
import { BRAND_MARKS, PhoneIcon } from './TileIcons'

/**
 * طرح ۱۴۰۵ · مورد ۱۰ — کادر معرفی توسعه‌دهنده در گوشهٔ پایین‌چپ صفحهٔ اصلی (معماری §۴-۶).
 *
 * فقط نمایشی است: هیچ پیوند (`<a href>`)، `openExternal` یا داده‌ای ندارد. در جریان صفحه
 * می‌نشیند، پس هرگز روی کاشی‌ها نمی‌افتد. لوگو نسخهٔ ۱۲۸ پیکسلی نشان «AP» است؛ خود فایل
 * بزرگ لوگو (`docs/plan-assets/item11-arka-pos-logo.png`) در بسته نمی‌رود.
 */
const DEVELOPER_NAME = 'امیرحسین معدندار'
const DEVELOPER_PHONE = '0919 950 4821'
const LOGO_URL = new URL('../assets/branding/arkapos-mark-128.png', import.meta.url).href

function BrandBadge({ mark, label }: { mark: keyof typeof BRAND_MARKS; label: string }) {
  const { color, path } = BRAND_MARKS[mark]
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-full"
      style={{ backgroundColor: color }}
      title={label}
      aria-label={label}
      role="img"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="#ffffff" aria-hidden="true" focusable="false">
        <path d={path} />
      </svg>
    </span>
  )
}

export default function DeveloperCard() {
  return (
    <aside
      className="relative w-[300px] max-w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
      aria-label="معرفی توسعه‌دهنده"
    >
      <span className="absolute inset-y-0 right-0 w-1.5 bg-brand" aria-hidden="true" />
      <div className="flex items-center gap-3 py-4 pe-4 ps-5">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
          <img src={LOGO_URL} alt="نشان ArkaPOS" className="h-14 w-14 object-contain" draggable={false} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-slate-500">توسعه‌دهنده</div>
          <div className="truncate text-base font-bold text-slate-800">{DEVELOPER_NAME}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <PhoneIcon className="h-4 w-4 shrink-0 text-brand" />
            <span dir="ltr" className="text-sm font-medium tracking-wide text-slate-700 [unicode-bidi:isolate]">
              {faDigits(DEVELOPER_PHONE)}
            </span>
            <span className="ms-auto flex items-center gap-1.5">
              <BrandBadge mark="whatsapp" label="این شماره در واتس‌اپ هم هست" />
              <BrandBadge mark="telegram" label="این شماره در تلگرام هم هست" />
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
