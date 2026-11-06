# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — UI-LOW

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-invoice-discount-return-exchange-ui-low-jJdd8J/isolated.db

## فاکتور مبدأ
- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.
- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.

## رفتار
- {"kind":"exchange","uiCurrentMode":"current SalesReturn payload; no automatic replacement invoice discount","replacementGross":8000000,"replacementDiscount":0,"replacementNet":8000000,"sourceReturnValue":9000000,"diff":-1000000,"cashReceived":0,"cashRefunded":1000000,"settlement":"CASH_REFUND","previewDiff":-1000000}

## تطبیق
- {"cashIn":27000000,"cashOut":1000000,"blue":26000000,"stock":[{"name":"returned source","actual":20,"ledger":0},{"name":"kept line","actual":19,"ledger":-1},{"name":"replacement","actual":19,"ledger":-1}]}

SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.
