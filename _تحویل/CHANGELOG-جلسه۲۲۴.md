# نشست ۲۲۴ — بستن اضافه‌پرداخت در مسیرهای دریافت پول (مورد ۴ طرح رفع ابهام)

**شاخه:** `arena/76a92283-mahak-klad` · **پایه:** `8f5ede2`

## چه چیزی عوض شد

مورد ۴ سند «طرح نهایی رفع ابهام» می‌گوید: «هیچ اضافه‌دریافتی… مجاز نیست… رمز، دلیل یا
«فهمیدم» مبلغ بیش‌ازحد را مجاز نمی‌کند. مازاد نقد، باقی‌پول مشتری است.»

پیش از این نشست، سه مسیر دریافت پول با پرچم `confirmOverpay` (و `overpayAsCredit`)
مبلغ بیش‌ازحد را می‌پذیرفتند. حالا **بدون استثنا رد می‌شوند** و اختلاف دقیق ریالی در
پیام می‌آید؛ هیچ سندی هم ساخته نمی‌شود:

| مسیر | محل | رفتار جدید |
|---|---|---|
| ثبت فاکتور فروش | `SalesService.create` | `saleOverpay > 0` ⇒ رد، بدون نوشتن فاکتور/پرداخت/اعتبار |
| ویرایش فاکتور | `SalesService.update` | `overpayIncrease > 0` ⇒ رد و rollback کل ویرایش |
| وصول بدهی | `SalesService.addPayment` | `amount > remaining` ⇒ رد، حتی ۱ ریال |

همچنین پرسش رمز مدیر برای «صدور اعتبار از اضافه‌دریافت» در این دو مسیر حذف شد، چون
آن مسیر دیگر قابل استفاده نیست (پرچم‌ها برای سازگاری IPC و دادهٔ تاریخی می‌مانند).

**برگشت/تعویض عمداً دست نخورد:** «اضافه‌دریافت» در برگشت می‌تواند اثر انتخاب روش
(اعتبار خرید) باشد و با قاعدهٔ سقف بازپرداخت سنجیده می‌شود؛ مورد ۴ فقط مسیرهای
*دریافت پول* را می‌بندد. تست `fix-s223-item4` (۱۵/۰) همچنان سبز است.

## اثبات قبل/بعد

- تست تازه: `tests/audit-fixes/fix-s224-no-overpay-anywhere.mjs` — **قبل از اصلاح: ۶ موفق / ۹ ناموفق** (فاکتور ۱۲۰٬۰۰۰ روی ۱۰۰٬۰۰۰ با تأیید پذیرفته می‌شد و ۲۰٬۰۰۰ اعتبار `OVERPAY` می‌ساخت) — **بعد از اصلاح: ۱۴ موفق / ۰ ناموفق**.
- `fix-s62-overpay-flow` و `fix-s63-edit-overpay-lock` بازنویسی شدند: این دو فلو با تصمیم موخر منسوخ شده‌اند و اکنون همان رد شدن را می‌سنجند (۶/۰ و ۵/۰).
- سبز ماندند: `fix-s223-item3` (۱۴/۰)، `item4` (۱۵/۰)، `item6` (۲۰/۰)، `fix-exchange-partial-cash-refund`، `deep-e2e-refund-decision-state-machine`.

## قرمزهای ناشی از همین تصمیم (باید تبدیل شوند، نه نادیده)

۱۸ فایل تست، رفتار **منسوخ** را ادعا می‌کنند (اضافه‌دریافت پذیرفته و به اعتبار تبدیل شود).
این‌ها باگ تازه نیستند؛ آزمون سیاست لغوشده‌اند و هر کدام باید مثل `fix-s62`/`fix-s63`
به «رد شدن» تبدیل شوند:

`deep-e2e-discount-policy-80-scenario-03-10-matrix` · `deep-e2e-discount-policy-80-scenario-11-20-credit-matrix` ·
`deep-e2e-followup-scenario13-no-method-auto-credit-and-independent-limit-gates` · `deep-e2e-retest-30-settlement-variants` ·
`deep-e2e-scenario2-return-resell-cd` · `deep-e2e-scenario4-e100-030-invoice-discount` · `deep-e2e-scenario4-e100-030-no-discount` ·
`fix-s142-payment-mutation-integer-validation` · `fix-s162-c-integrated-chain` · `fix-s163-c-integrated-ext` ·
`fix-s167-prior-overpay-label` · `fix-s170b-overpay-remainder-hint` · `fix-s189-return-overpay-flow` ·
`fix-s191-audit-report` · `fix-s205-voided-payment-hides-overpay` · `fix-s58-remaining` · `fix-s59-bridge-exchange` ·
`fix-s61-overpay-credit`

## اجرا نشده

`npm ci` / `npm run typecheck` / `npm run build` در این محیط ممکن نیست (بدون `node_modules`).
