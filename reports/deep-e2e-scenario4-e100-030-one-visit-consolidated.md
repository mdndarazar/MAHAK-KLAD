# E100-030 بدون تخفیف: همه‌چیز در یک مراجعه و یک تعویض یک‌جا

**نتیجه:** عملیات یک‌جای برگشت/تعویض پذیرفته شد؛ 9/9 checkpoint پاس شد.
**DB:** SQLite موقت و ایزوله (/tmp/mahak-e100-030-one-visit-5IIqgl/isolated.db).

## ورودی سناریو
- فاکتور بدون تخفیف: A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع ۱٬۰۰۰٬۰۰۰ ریال.
- پرداخت اولیه: ۳۰۰٬۰۰۰ اعتبار ALL + ۷۰۰٬۰۰۰ نقد.
- مشتری در یک درخواست تمام A+B+C+D را برمی‌گرداند و B1+C1+D1 را می‌گیرد؛ هیچ سندِ تعویض جداگانه‌ای برای B قبل از این درخواست ساخته نمی‌شود.

## نتیجهٔ ثبت‌شده
- جمع برگشت: ۱٬۰۰۰٬۰۰۰؛ جمع کالاهای جایگزین: ۸۰۰٬۰۰۰؛ اختلاف **‎−۲۰۰٬۰۰۰ ریال** به نفع مشتری بود.
- نتیجهٔ actual: {"returnRecord":{"id":1,"total":1000000,"kind":"EXCHANGE","exchangeInvoiceId":2,"exchangeTotal":800000,"exchangeDiff":-200000,"exchangeSettlement":"CREDIT","refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0},"allocations":[{"redemptionId":3,"sourceCreditId":4,"amount":50000,"creditRestored":true,"settlementAdjusted":false},{"redemptionId":4,"sourceCreditId":2,"amount":50000,"creditRestored":true,"settlementAdjusted":false},{"redemptionId":5,"sourceCreditId":3,"amount":50000,"creditRestored":true,"settlementAdjusted":false},{"redemptionId":6,"sourceCreditId":5,"amount":50000,"creditRestored":true,"settlementAdjusted":false}],"returnLines":[{"saleItemId":1,"variantId":1,"lineTotal":200000,"restockedQty":1},{"saleItemId":2,"variantId":2,"lineTotal":200000,"restockedQty":1},{"saleItemId":3,"variantId":3,"lineTotal":300000,"restockedQty":1},{"saleItemId":4,"variantId":4,"lineTotal":300000,"restockedQty":1}],"payments":[{"methodId":3,"amount":800000,"kind":"CASH","destination":null,"storeCreditId":null,"note":"ارزش کالای برگشتی فاکتور ۱ (پول نقد نیست)"}],"stocks":{"A-200k":10,"B-200k":10,"C-300k":10,"D-300k":10,"B1-220k":9,"C1-290k":9,"D1-290k":9}}

## آیا مشکل قبلی هنوز هست؟
- در حالت یک سند تجمیعی، مشکلِ «برگشت قبلی B تخصیص منشأ ندارد» رخ نداد؛ چون برگشت قبلی B وجود نداشت. کل کالاها در همان برگشت یک‌جا بودند و allocationهای اعتبارِ همین برگشت ثبت شدند.
- جریان مرحله‌ای هم جداگانه در یک اجرای پیوسته و همان shift تست شده: برگشت A، سپس تعویض B، سپس C+D. با وجود اینکه همه در همان مراجعه/جلسهٔ تست بودند، C+D همچنان در گیت منشأ رد شد (جزئیات در گزارش no-discount). پس یک مراجعه بودن به‌تنهایی کافی نیست؛ اگر B در سند جداگانه ثبت شود، برای سند بعدی C+D «برگشت قبلی» است.
- این سناریوی تجمیعی با اختلاف منفی ۲۰۰٬۰۰۰ است. مبلغ اضافه، خودبه‌خود پول نقد محسوب نمی‌شود؛ دفتر برگشت و تخصیص اعتبار را بررسی کنید و اعتبار را به پول تبدیل نکنید.

## ایمنی
- فقط DB تست موقت استفاده شد؛ وجه واقعی، چک، بدهی یا DB واقعی در کار نبود و production code تغییر نکرد.
