# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — AUTO-HIGH

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-invoice-discount-return-exchange-auto-high-vDAr9W/isolated.db

## فاکتور مبدأ
- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.
- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.

## رفتار
- {"kind":"exchange","uiCurrentMode":"service control with 10% invoice discount explicitly supplied; current UI does not do this","replacementGross":12000000,"replacementDiscount":1200000,"replacementNet":10800000,"sourceReturnValue":9000000,"diff":1800000,"cashReceived":1800000,"cashRefunded":0,"settlement":"CASH","previewDiff":1800000}

## تطبیق
- {"cashIn":28800000,"cashOut":0,"blue":28800000,"stock":[{"name":"returned source","actual":20,"ledger":0},{"name":"kept line","actual":19,"ledger":-1},{"name":"replacement","actual":19,"ledger":-1}]}

SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.
