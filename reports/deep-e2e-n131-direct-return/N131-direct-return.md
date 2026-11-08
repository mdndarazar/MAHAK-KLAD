# پیگیری محدود N131 — برگشت مستقیم پس از تخفیف فاکتور

**وضعیت:** PASS
**SQLite موقت ایزوله:** /tmp/mahak-n131-direct-return-LXfe6m/isolated.db

## پرسش و مثال
- قیمت برچسب کالا: ۱۰۰٬۰۰۰ ریال.
- تخفیف روی فاکتور: ۱۰٬۰۰۰ ریال.
- مبلغ خالص فاکتور و وجه نقد پرداخت‌شده: ۹۰٬۰۰۰ ریال.
- سپس همان کالا با روش برگشت CASH مستقیماً برگشت خورد؛ بدون تعویض.

## عدد ثبت‌شدهٔ برگشت
- مبلغ کل برگشت در سند: 90000 ریال.
- مبلغ نقد واقعاً برگشتی: 90000 ریال.
- پاسخ دقیق به سؤال: سیستم مبلغ کالا را 90000 ریال حساب کرد و 90000 ریال نقد برگرداند.

## تطبیق
- {"expectedCashIn":90000,"rawCashIn":90000,"rawCashRefund":90000,"reportTotals":{"count":1,"goodsTotal":100000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000,"deliveryTotal":0,"grandTotal":90000,"cashTotal":90000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":90000,"returnedTotal":90000,"exchangeCreditTotal":0,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":0,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":90000,"exchangeReturnedTotal":0,"refundCashTotal":90000,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"blue":0,"stock":{"initial":10,"actual":10,"ledger":0},"checks":0}

این فقط یک آزمایش مستقیم برگشت برای روشن‌کردن مبلغ ثبت‌شده بود؛ N131 اصلی دربارهٔ تعویض بود. در این پیگیری هیچ سیاستی تغییر یا اصلاح نشد.
