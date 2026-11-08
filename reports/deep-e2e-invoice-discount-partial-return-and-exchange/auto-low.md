# تخفیف ۱۰٪ کل فاکتور؛ برگشت/تعویض یک قلم — AUTO-LOW

**نتیجه:** PASS
**SQLite موقت:** /tmp/mahak-invoice-discount-return-exchange-auto-low-7ssYyb/isolated.db

## فاکتور مبدأ
- دو قلم: ۱۰٬۰۰۰٬۰۰۰ و ۲۰٬۰۰۰٬۰۰۰ ریال؛ ناخالص ۳۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کل ۱۰٪: ۳٬۰۰۰٬۰۰۰ ریال؛ پرداخت خالص ۲۷٬۰۰۰٬۰۰۰ ریال.
- قلم ۱۰٬۰۰۰٬۰۰۰ ریالی، سهم نسبتی تخفیف ۱٬۰۰۰٬۰۰۰ و ارزش خالص برگشت ۹٬۰۰۰٬۰۰۰ ریال.

## رفتار
- {"kind":"exchange","uiCurrentMode":"service control with 10% invoice discount explicitly supplied; current UI does not do this","replacementGross":8000000,"replacementDiscount":800000,"replacementNet":7200000,"sourceReturnValue":9000000,"diff":-1800000,"cashReceived":0,"cashRefunded":1800000,"settlement":"CASH_REFUND","previewDiff":-1800000}

## تطبیق
- {"cashIn":27000000,"cashOut":1800000,"blue":25200000,"stock":[{"name":"returned source","actual":20,"ledger":0},{"name":"kept line","actual":19,"ledger":-1},{"name":"replacement","actual":19,"ledger":-1}]}

SQLite موقت ایزوله؛ بدون پول واقعی و بدون تغییر production. در حالت UI، سند تعویض تخفیف کلِ تازه را خودکار نمی‌فرستد؛ حالت AUTO کنترل سرویس با ارسال صریح تخفیف ۱۰٪ است.
