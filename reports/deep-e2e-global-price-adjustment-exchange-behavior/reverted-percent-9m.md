# تخفیف گروهی مدیر در تعویض — reverted-percent-9m

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-global-exchange-reverted-percent-9m-jMcgu0/isolated.db

## ورودی و رفتار مشاهده‌شده
- تخفیف واقعی PriceAdjust با scope=ALL و نوع ۱۰٪ روی همهٔ واریانت‌های fixture اعمال شد.
- قیمت اسمی قلم مبدأ ۱۰٬۰۰۰٬۰۰۰ ریال؛ فاکتور هنگام فروش ۹۰۰٬۰۰۰ تومان دریافت کرد.
- قیمت جایگزین در زمان تعویض ۸۱۰٬۰۰۰ تومان بود؛ خالص برگشت مبدأ ۹۰۰٬۰۰۰ تومان.
- اختلاف واقعی ۰ تومان؛ مسیر zero.

## تطبیق
- {"cashIn":9000000,"cashOut":0,"blue":9000000,"stock":[{"name":"source","actual":10,"ledger":0},{"name":"replacement","actual":9,"ledger":-1}],"previewDiff":0}

تست فقط با SQLite موقت/ایزوله انجام شد. هیچ DB واقعی/staging یا وجه واقعی استفاده نشد و هیچ منطق production تغییر نکرد. در کد/ API فعلی گزینهٔ انتقال تخفیف بله/خیر وجود ندارد.
