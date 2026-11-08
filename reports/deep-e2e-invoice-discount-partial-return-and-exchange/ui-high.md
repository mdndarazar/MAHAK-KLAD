# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — UI-HIGH

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-invoice-discount-return-exchange-ui-high-AedWBx/isolated.db

## فاکتور مبدأ
- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.
- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.

## رفتار
- {"kind":"exchange","uiCurrentMode":"current SalesReturn payload; no automatic replacement invoice discount","replacementGross":12000000,"replacementDiscount":0,"replacementNet":12000000,"sourceReturnValue":9000000,"diff":3000000,"cashReceived":3000000,"cashRefunded":0,"settlement":"CASH","previewDiff":3000000}

## تطبیق
- {"cashIn":30000000,"cashOut":0,"blue":30000000,"stock":[{"name":"returned source","actual":20,"ledger":0},{"name":"kept line","actual":19,"ledger":-1},{"name":"replacement","actual":19,"ledger":-1}]}

SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.
