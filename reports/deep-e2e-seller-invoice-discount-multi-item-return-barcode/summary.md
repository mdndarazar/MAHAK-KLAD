# برگشت یک قلم از فاکتور چندقلمی با صدور بارکد اعتبار

**وضعیت اجرا و reconciliation:** PASS
**SQLite موقت:** /tmp/mahak-seller-discount-multi-return-barcode-6iVtRx/isolated.db

## ورودی
- چهار قلم ۱۰٬۰۰۰٬۰۰۰ ریالی؛ جمع ناخالص ۴۰٬۰۰۰٬۰۰۰ ریال.
- تخفیف کلی فاکتور ۱۰٬۰۰۰٬۰۰۰ ریال؛ مبلغ خالص و پرداخت نقدی ۳۰٬۰۰۰٬۰۰۰ ریال.
- یک قلم برگشت خورد؛ روش بازپرداخت STORE_CREDIT با مهلت ۳۰ روز انتخاب شد.

## نتیجهٔ بارکد اعتبار
- سهم تخفیف قلم: 2500000 ریال.
- مبلغ خود برگشت: 7500000 ریال.
- مجموع اعتبار بارکدی صادرشده: 7500000 ریال؛ تعداد بارکد: 1.
- روش انتخاب‌شده: STORE_CREDIT؛ مبلغ ثبت‌شده در سند برگشت: 7500000 ریال؛ وجه نقد واقعیِ خارج‌شده: 0 ریال.
- تأیید شد: بارکد اعتبار نیز ۷٬۵۰۰٬۰۰۰ ریال است؛ سهم ۲٬۵۰۰٬۰۰۰ ریالی تخفیف از مبلغ ناخالص قلم کسر شده و به بارکد برگشت اعتباری داده نشد.

## تطبیق
- {"cashRefundMovement":0,"cashInitiallyReceived":30000000,"blue":30000000,"reportTotals":{"count":1,"goodsTotal":40000000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000000,"deliveryTotal":0,"grandTotal":30000000,"cashTotal":30000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":30000000,"returnedTotal":7500000,"exchangeCreditTotal":0,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":7500000,"exchangeCount":0,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":22500000,"exchangeReturnedTotal":0,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":7500000,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"A returned","actual":10,"ledger":0},{"name":"B kept","actual":9,"ledger":-1},{"name":"C kept","actual":9,"ledger":-1},{"name":"D kept","actual":9,"ledger":-1}],"cheques":0}

بارکد واقعی فقط در SQLite موقت ساخته شد و مقدار/وضعیتش گزارش شد؛ مقدار redeemable code افشا نشده است. هیچ production/staging، دیتابیس واقعی یا وجه واقعی درگیر نبود و هیچ منطق production تغییر نکرد.
