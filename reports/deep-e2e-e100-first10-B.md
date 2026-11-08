# E100 اول ۱۰ — شاخهٔ B

**اجرا:** 10/10 جریان · PASS 10 · FAIL 0 · خطای غیرمنتظره 0 · توقف امن 0 · finding 0 · رد مورد انتظار 2.
**دیتابیس:** SQLite موقت ایزوله (/tmp/mahak-e2e-100-sd1oK0/isolated.db).
**تعریف blue:** physical cash received + POS received - cash refund - POS refund; store credit and pending/paid C2C transfers are excluded.
**تسویه/چک/نسیه:** 42 فاکتور؛ پرداخت‌نشده 0؛ تسویه‌نشده 0؛ پرداخت چکی 0؛ جدول بدهی 0.
**ماتریس:** تعداد بارکد فروش 3; tender فروش CARD; روش‌های برگشت CARD_TO_CARD.

هر شماره یک جریان مستقل با shift، SKUها، فاکتورها و اعتبارهای خودش است؛ شاخه‌های پرداخت به‌عنوان سناریوی مستقل جدا شمرده نشده‌اند. هر عملیات و رد/تلاش تکراری checkpoint دارد؛ وضعیت BLOCKED یعنی ادامهٔ زنجیره به‌علت توقف امن انجام نشد و جداگانه گزارش شده است.

| # | وضعیت | تعداد کد/مبلغ کد | مدل مصرف | tender | روش برگشت | مراحل تعویض | نتیجه/رد/خطا |
|---:|---|---:|---|---|---|---|---|
| 1 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE و redemption دوم | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 2 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 3 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 4 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 5 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 6 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE و redemption دوم | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 7 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 8 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 9 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 10 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |

## یافته‌های double-spend / تبدیل اعتبار به پول نقد

## توقف‌های ایمن نیازمند بازبینی سیاست/تخصیص
- سناریوی 1، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRWF7KWR) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲ در تاریخ ۱۴۰۵/۰۸/۰۶.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 6، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRVDYN8V) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۳ در تاریخ ۱۴۰۵/۰۸/۰۶.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- هیچ double-spend تأییدشده یا پرداخت نقد/POSِ بدون پشتوانه در نتایج نهایی ثبت نشد. هر تلاش بازاستفادهٔ کد کاملاًمصرف‌شده که رد شد، بدون invoice/payment/stock/redemption اضافی بود.

## تطبیق ریزبه‌ریز
- جزئیات هر رویداد در JSON کنار همین فایل است: انتظار و نتیجهٔ cash/POS/refunds/blue؛ stock SKU و ledger؛ invoice/return/exchange IDs؛ وضعیت/مانده/usedCount و redemption history هر کد؛ successor و delivery state؛ allocationهای منبع و وضعیت انتقال C2C.
- در خرید اصلی تعداد کدها ۰،۱،۲،۳،۴ یا ۶ است؛ در موارد multi-use کدها یا نیمه‌مصرف‌شده می‌مانند یا با redemption دوم در فاکتور مستقل به‌طور مشروع مصرف می‌شوند. هر کد fully-used برای جلوگیری از double-spend دوباره امتحان می‌شود.
- زنجیرهٔ هدف فروش چهارقلمی، برگشت A، تعویض B، تعویض هم‌زمان C+D و تعویض دوبارهٔ B1 از فاکتور child خودش بود؛ 10 جریان کامل شدند و 0 مورد پیش از تکمیل، در گیت تخصیص منشأ اعتبار به‌صورت mutation-free متوقف شدند. تفاوت مثبت/منفی، tender نقد/POS/اعتبار و روش‌های برگشت در ماتریس چرخانده شدند.

## محدوده و محدودیت
- فقط service-layer و SQLite موقت؛ پنل Electron واقعی، چاپگر واقعی و پایانهٔ POS واقعی اجرا نشدند.
- هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB زنده، stage یا reset استفاده نشد.
- کارت‌به‌کارت فقط در جدول درخواست آزمایشی و با مدیر test-paid می‌شود؛ انتقال واقعی بانکی نیست.
- این تست هیچ production source را تغییر نمی‌دهد.
