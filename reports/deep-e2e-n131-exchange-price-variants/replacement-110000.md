# N131: تعویض با جایگزین ۱۱۰٬۰۰۰ ریالی

**نتیجه:** PASS
**SQLite ایزوله:** /tmp/mahak-n131-exchange-110000-MpIzuA/isolated.db

## ورودی
- کالای مبدأ: قیمت ۱۰۰٬۰۰۰؛ تخفیف فاکتور ۱۰٬۰۰۰؛ مبلغ خالص پرداخت‌شده ۹۰٬۰۰۰.
- کالای جایگزین: بدون تخفیف صریح در درخواست تعویض.

## مشاهدهٔ سیستم
- ارزش برگشت مبدأ (پس از سهم تخفیف): 90000.
- قیمت جایگزین: 110000؛ تخفیف ثبت‌شده روی فاکتور جایگزین: 0.
- اختلاف واقعی تعویض: 20000؛ نقد دریافتی: 20000؛ نقد برگشتی: 0.

## تطبیق
- {"rawCash":110000,"rawCard":0,"cashRefund":0,"blue":110000,"reportTotals":{"count":2,"goodsTotal":210000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000,"deliveryTotal":0,"grandTotal":200000,"cashTotal":110000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":110000,"returnedTotal":0,"exchangeCreditTotal":90000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":20000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":110000,"exchangeReturnedTotal":90000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"source","actual":10,"ledger":0},{"name":"replacement","actual":9,"ledger":-1}],"cheques":0}

بدون تغییر در production؛ یک دیتابیس آزمایشی مستقل برای این قیمت جایگزین.
