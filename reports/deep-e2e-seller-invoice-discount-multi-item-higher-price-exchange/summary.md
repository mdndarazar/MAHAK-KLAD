# تعویض قلم گران‌تر از فاکتور چندقلمی با تخفیف کلی

**وضعیت تست و reconciliation:** FAIL
**SQLite موقت:** /tmp/mahak-seller-discount-multi-high-exchange-b9v8LY/isolated.db

## مثال
- چهار قلم، هرکدام ۲٬۰۰۰٬۰۰۰ تومان؛ جمع ناخالص ۸٬۰۰۰٬۰۰۰ تومان.
- تخفیف کلی فاکتور ۸۰۰٬۰۰۰ تومان؛ خالص/پرداخت اولیه ۷٬۲۰۰٬۰۰۰ تومان.
- قلم A به ارزش ناخالص ۲٬۰۰۰٬۰۰۰ تومان برگشت خورد و با قلم ۳٬۰۰۰٬۰۰۰ تومانی جایگزین شد.
- چون چهار قلم هم‌قیمت‌اند، سهم تخفیف A برابر ۲۰۰٬۰۰۰ تومان و ارزش خالص برگشت A برابر ۱٬۸۰۰٬۰۰۰ تومان است.

## رفتار فعلی سیستم
- مبلغ برگشت قلم A: 18000000 ریال معادل ۱٬۸۰۰٬۰۰۰ تومان.
- جایگزین با قیمت کامل ثبت شد: 30000000 ریال معادل ۳٬۰۰۰٬۰۰۰ تومان.
- مابه‌التفاوت واقعی و دریافتی: 10000000 ریال معادل ۱٬۲۰۰٬۰۰۰ تومان.
- اگر فروشنده «بله» بزند و همان سهم ۲۰۰٬۰۰۰ تومان منتقل شود، مابه‌التفاوت به ۱٬۰۰۰٬۰۰۰ تومان می‌رسد؛ با «خیر»، سیستم فعلی ۱٬۲۰۰٬۰۰۰ تومان می‌گیرد.

## تطبیق
- {"rawPayments":[{"amount":72000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"MULTI-SELLER-DISC-HIGH-CASH"},{"amount":18000000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"},{"amount":10000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"MULTI-SELLER-DISC-HIGH-CASH"}],"rawCash":82000000,"refund":0,"blue":82000000,"reportTotals":{"count":2,"goodsTotal":110000000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000000,"deliveryTotal":0,"grandTotal":100000000,"cashTotal":82000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":82000000,"returnedTotal":0,"exchangeCreditTotal":18000000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":10000000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":82000000,"exchangeReturnedTotal":18000000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"A returned","actual":10,"ledger":0},{"name":"B kept","actual":9,"ledger":-1},{"name":"C kept","actual":9,"ledger":-1},{"name":"D kept","actual":9,"ledger":-1},{"name":"replacement","actual":9,"ledger":-1}],"cheques":0}

فقط یک SQLite موقت و ایزوله استفاده شد؛ هیچ production/staging، دیتابیس واقعی یا وجه واقعی درگیر نشد و منطق production تغییر نکرد.
