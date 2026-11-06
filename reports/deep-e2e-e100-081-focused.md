# بازاجرای هدفمند E100-081 — بررسی دوازدهمین توقف

**اجرا:** 1/1 جریان · PASS 0 · FAIL 0 · خطای غیرمنتظره 0 · توقف امن 1 · finding 0 · رد مورد انتظار 1.
**دیتابیس:** SQLite موقت ایزوله (/tmp/mahak-e2e-100-GckC0k/isolated.db).
**تعریف blue:** physical cash received + POS received - cash refund - POS refund; store credit and pending/paid C2C transfers are excluded.
**تسویه/چک/نسیه:** 2 فاکتور؛ پرداخت‌نشده 0؛ تسویه‌نشده 0؛ پرداخت چکی 0؛ جدول بدهی 0.
**ماتریس:** تعداد بارکد فروش 2; tender فروش SPLIT; روش‌های برگشت CASH.

هر شماره یک جریان مستقل با shift، SKUها، فاکتورها و اعتبارهای خودش است؛ شاخه‌های پرداخت به‌عنوان سناریوی مستقل جدا شمرده نشده‌اند. هر عملیات و رد/تلاش تکراری checkpoint دارد؛ وضعیت BLOCKED یعنی ادامهٔ زنجیره به‌علت توقف امن انجام نشد و جداگانه گزارش شده است.

| # | وضعیت | تعداد کد/مبلغ کد | مدل مصرف | tender | روش برگشت | مراحل تعویض | نتیجه/رد/خطا |
|---:|---|---:|---|---|---|---|---|
| 81 | BLOCKED | 2 × ۵۰٬۰۰۰ | MULTI_LIVE و redemption دوم | SPLIT | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 | fallback negative B exchange failed: برگشت قبلی #1 تخصیص منشأ اعتبار ندارد؛ هیچ تعویضی ثبت نشد تا منبع مالی با حدس جابه‌جا نشود. |

## یافته‌های double-spend / تبدیل اعتبار به پول نقد

## توقف‌های ایمن نیازمند بازبینی سیاست/تخصیص
- سناریوی 1: SAFE_STOP_REQUIRES_POLICY_REVIEW; fallback negative B exchange failed: برگشت قبلی #1 تخصیص منشأ اعتبار ندارد؛ هیچ تعویضی ثبت نشد تا منبع مالی با حدس جابه‌جا نشود.; Exchange was rejected because a prior return has no source-credit allocation row; the runner confirmed the attempted exchange was mutation-free. Determine whether this prior return truly makes funding ambiguous or is unrelated to the new exchange.
- سناریوی 1، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRTU2D97) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲ در تاریخ ۱۴۰۵/۰۸/۰۵.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- هیچ double-spend تأییدشده یا پرداخت نقد/POSِ بدون پشتوانه در نتایج نهایی ثبت نشد. هر تلاش بازاستفادهٔ کد کاملاًمصرف‌شده که رد شد، بدون invoice/payment/stock/redemption اضافی بود.

## تطبیق ریزبه‌ریز
- جزئیات هر رویداد در JSON کنار همین فایل است: انتظار و نتیجهٔ cash/POS/refunds/blue؛ stock SKU و ledger؛ invoice/return/exchange IDs؛ وضعیت/مانده/usedCount و redemption history هر کد؛ successor و delivery state؛ allocationهای منبع و وضعیت انتقال C2C.
- در خرید اصلی تعداد کدها ۰،۱،۲،۳،۴ یا ۶ است؛ در موارد multi-use کدها یا نیمه‌مصرف‌شده می‌مانند یا با redemption دوم در فاکتور مستقل به‌طور مشروع مصرف می‌شوند. هر کد fully-used برای جلوگیری از double-spend دوباره امتحان می‌شود.
- زنجیرهٔ هدف فروش چهارقلمی، برگشت A، تعویض B، تعویض هم‌زمان C+D و تعویض دوبارهٔ B1 از فاکتور child خودش بود؛ 87 جریان آن را کامل کردند و 13 مورد پیش از تکمیل، در گیت تخصیص منشأ اعتبار به‌صورت mutation-free متوقف شدند. تفاوت مثبت/منفی، tender نقد/POS/اعتبار و روش‌های برگشت در ماتریس چرخانده شدند.

## محدوده و محدودیت
- فقط service-layer و SQLite موقت؛ پنل Electron واقعی، چاپگر واقعی و پایانهٔ POS واقعی اجرا نشدند.
- هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB زنده، stage یا reset استفاده نشد.
- کارت‌به‌کارت فقط در جدول درخواست آزمایشی و با مدیر test-paid می‌شود؛ انتقال واقعی بانکی نیست.
- این تست هیچ production source را تغییر نمی‌دهد.
