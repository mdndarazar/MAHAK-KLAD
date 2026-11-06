# اجرای مورد اول — اعتبار بارکدی در اختلاف مثبت تعویض

**نتیجه:** PASS
**SQLite ایزوله:** /tmp/mahak-exchange-credit-first-only-U0d2nl/isolated.db

## مثال عددی
- فروش اولیه: دو کالا × ۱٬۰۰۰ = ۲٬۰۰۰ ریال؛ کاملاً نقدی و تسویه‌شده.
- اعتبار خرید موجود: ۷۰۰ ریال.
- تعویض کالای A به ارزش ۱٬۰۰۰ با کالای C به ارزش ۱٬۵۰۰؛ اختلاف مثبت ۵۰۰ ریال.
- از اختلاف ۵۰۰ ریالی، ۵۰۰ با اعتبار خرید پرداخت شد؛ وجه نقد اضافه = صفر. ماندهٔ اعتبار = ۲۰۰ ریال.

## تطبیق و دامنه
- نتیجهٔ نهایی: {"expectedCash":2000,"actualCash":2000,"card":0,"blue":2000,"reportTotals":{"count":2,"goodsTotal":3500,"taxTotal":0,"serviceTotal":0,"discountTotal":0,"deliveryTotal":0,"grandTotal":3500,"cashTotal":2000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":2000,"returnedTotal":0,"exchangeCreditTotal":1000,"storeCreditUsedTotal":500,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":500,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":2000,"exchangeReturnedTotal":1000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"invoices":[{"id":1,"total":2000,"paid":2000,"settled":true},{"id":2,"total":1500,"paid":1500,"settled":true}],"stocks":[{"name":"A source","expected":100,"actual":100,"ledger":0},{"name":"B kept item","expected":99,"actual":99,"ledger":-1},{"name":"C replacement","expected":99,"actual":99,"ledger":-1}],"chequePayments":0}
- فقط مورد شمارهٔ ۱ اجرا شد؛ مورد ۲ و بقیهٔ فایل مادر اجرا نشدند.
- پایگاه تست SQLite موقت و ایزوله بود؛ هیچ منطق production، دیتابیس واقعی/staging یا پول واقعی استفاده نشد.
