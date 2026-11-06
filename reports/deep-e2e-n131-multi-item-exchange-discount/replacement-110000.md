# N131 چندقلمی — جایگزین ۱۱۰٬۰۰۰ ریالی

**وضعیت اجرا و تطبیق:** PASS
**SQLite مستقل:** /tmp/mahak-n131-multi-110000-aRUaQd/isolated.db

## فاکتور چندقلمی
- قلم A: ۱۰۰٬۰۰۰ ریال؛ قلم B: ۲۰۰٬۰۰۰ ریال؛ جمع ناخالص ۳۰۰٬۰۰۰ ریال.
- تخفیف فاکتور ۳۰٬۰۰۰ ریال (۱۰٪)؛ فاکتور خالص و پرداخت نقدی کامل ۲۷۰٬۰۰۰ ریال.
- سهم متناسب تخفیف: A برابر ۱۰٬۰۰۰ و B برابر ۲۰٬۰۰۰؛ پس ارزش خالص A برای برگشت/تعویض ۹۰٬۰۰۰ است.

## تعویض قلم A
- قلم B در فاکتور اصلی باقی ماند؛ فقط A با کالای جایگزین عوض شد. روی جایگزین تخفیف صریحی وارد نشد تا انتقال خودکار سنجیده شود.
- قیمت جایگزین: 110000؛ برگشت خالص A: 90000.
- اختلاف واقعی: 20000؛ اختلاف موردانتظار با انتقال همان ۱۰٬۰۰۰ تخفیف: 10000؛ فاصله: 10000.
- دریافت/بازپرداخت نقد واقعی: 20000 / 0.

## تطبیق
- {"rawCash":290000,"rawCard":0,"cashRefund":0,"blue":290000,"reportTotals":{"count":2,"goodsTotal":410000,"taxTotal":0,"serviceTotal":0,"discountTotal":30000,"deliveryTotal":0,"grandTotal":380000,"cashTotal":290000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":290000,"returnedTotal":0,"exchangeCreditTotal":90000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":20000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":290000,"exchangeReturnedTotal":90000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"source A returned","actual":10,"ledger":0},{"name":"source B retained","actual":9,"ledger":-1},{"name":"replacement C","actual":9,"ledger":-1}],"cheques":0}

تست فقط روی service layer و SQLite موقت انجام شد؛ قیمت جایگزین با رمز مدیر در fixture مجاز شد تا آزمایش سیاست تخفیف از گیت قیمت جدا بماند؛ production تغییر نکرد.
