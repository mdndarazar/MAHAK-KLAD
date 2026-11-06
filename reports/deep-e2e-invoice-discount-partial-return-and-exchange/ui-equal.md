# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — UI-EQUAL

**نتیجه:** FAIL
**SQLite موقت:** /tmp/mahak-invoice-discount-return-exchange-ui-equal-rdZyWl/isolated.db

## فاکتور مبدأ
- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.
- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.

## رفتار
- {"message":"Expected values to be strictly equal:\n\n0 !== 1000000\n","stack":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 1000000\n\n    at file:///home/user/MAHAK-KLAD/tests/audit-fixes/deep-e2e-invoice-discount-partial-return-and-exchange.mjs:69:11"}

## تطبیق
- null

SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.
