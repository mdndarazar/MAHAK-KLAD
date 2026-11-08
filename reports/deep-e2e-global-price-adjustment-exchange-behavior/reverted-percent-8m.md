# تخفیف گروهی مدیر در تعویض — reverted-percent-8m

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-global-exchange-reverted-percent-8m-v43sIe/isolated.db

## ورودی و رفتار مشاهده‌شده
- تخفیف واقعی PriceAdjust با scope=ALL و نوع ۱۰٪ روی همهٔ واریانت‌های fixture اعمال شد.
- قیمت اسمی قلم مبدأ ۱۰٬۰۰۰٬۰۰۰ ریال؛ فاکتور هنگام فروش ۹۰۰٬۰۰۰ تومان دریافت کرد.
- قیمت جایگزین در زمان تعویض ۷۲۰٬۰۰۰ تومان بود؛ خالص برگشت مبدأ ۹۰۰٬۰۰۰ تومان.
- اختلاف واقعی ‎−۱۰۰٬۰۰۰ تومان؛ مسیر refund-to-customer.

## تطبیق
- {"cashIn":9000000,"cashOut":1000000,"blue":8000000,"stock":[{"name":"source","actual":10,"ledger":0},{"name":"replacement","actual":9,"ledger":-1}],"previewDiff":-1000000}

تست فقط با SQLite موقت/ایزوله انجام شد. هیچ DB واقعی/staging یا وجه واقعی استفاده نشد و هیچ منطق production تغییر نکرد. در کد/ API فعلی گزینهٔ انتقال تخفیف بله/خیر وجود ندارد.
