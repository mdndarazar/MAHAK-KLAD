# برگشت مستقیم یک قلم از فاکتور چندقلمی با تخفیف کلی فروشنده

**وضعیت اجرا و reconciliation:** PASS
**SQLite موقت:** /tmp/mahak-seller-discount-multi-direct-return-xsnUqO/isolated.db

## فاکتور آزمایشی
- چهار قلم جداگانه، هرکدام ۱۰٬۰۰۰٬۰۰۰ ریال؛ جمع ناخالص ۴۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کلی فاکتور ۱۰٬۰۰۰٬۰۰۰ ریال؛ مبلغ خالص/پرداخت‌شده ۳۰٬۰۰۰٬۰۰۰ ریال.
- فقط قلم A برگشت خورد؛ B، C و D نزد مشتری ماندند.

## مقدار برگشت
- سهم نسبتی تخفیف هر قلم: 2500000 ریال.
- مبلغ ثبت‌شدهٔ برگشت: 7500000 ریال.
- وجه نقدی که واقعاً برگشت: 7500000 ریال.
- پاسخ: سیستم سهم تخفیف را حساب کرد؛ برای قلم برگشتی ۷٬۵۰۰٬۰۰۰ ریال برگرداند.

## تطبیق دفترها و موجودی
- {"cashRefundMovement":7500000,"rawPayments":[{"amount":30000000,"kind":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-MULTI-RETURN-CASH"}],"blue":22500000,"reportTotals":{"count":1,"goodsTotal":40000000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000000,"deliveryTotal":0,"grandTotal":30000000,"cashTotal":30000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":30000000,"returnedTotal":7500000,"exchangeCreditTotal":0,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":0,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":30000000,"exchangeReturnedTotal":0,"refundCashTotal":7500000,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"A returned","actual":10,"ledger":0},{"name":"B kept","actual":9,"ledger":-1},{"name":"C kept","actual":9,"ledger":-1},{"name":"D kept","actual":9,"ledger":-1}],"cheques":0}

فقط SQLite موقت و ایزوله؛ هیچ دیتابیس واقعی/staging یا وجه واقعی استفاده نشد و production تغییر نکرد.
