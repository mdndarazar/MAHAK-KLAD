# N131: تعویض با جایگزین ۹۰٬۰۰۰ ریالی

**نتیجه:** PASS
**SQLite ایزوله:** /tmp/mahak-n131-exchange-90000-ysnNt9/isolated.db

## ورودی
- کالای مبدأ: قیمت ۱۰۰٬۰۰۰؛ تخفیف فاکتور ۱۰٬۰۰۰؛ مبلغ خالص پرداخت‌شده ۹۰٬۰۰۰.
- کالای جایگزین: بدون تخفیف صریح در درخواست تعویض.

## مشاهدهٔ سیستم
- ارزش برگشت مبدأ (پس از سهم تخفیف): 90000.
- قیمت جایگزین: 90000؛ تخفیف ثبت‌شده روی فاکتور جایگزین: 0.
- اختلاف واقعی تعویض: 0؛ نقد دریافتی: 0؛ نقد برگشتی: 0.

## تطبیق
- {"rawCash":90000,"rawCard":0,"cashRefund":0,"blue":90000,"reportTotals":{"count":2,"goodsTotal":190000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000,"deliveryTotal":0,"grandTotal":180000,"cashTotal":90000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":90000,"returnedTotal":0,"exchangeCreditTotal":90000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":90000,"exchangeReturnedTotal":90000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"source","actual":10,"ledger":0},{"name":"replacement","actual":9,"ledger":-1}],"cheques":0}

بدون تغییر در production؛ یک دیتابیس آزمایشی مستقل برای این قیمت جایگزین.
