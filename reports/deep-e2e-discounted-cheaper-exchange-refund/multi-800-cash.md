# تعویض با کالای ارزان‌تر/هم‌قیمت — MULTI-800-CASH

**نتیجهٔ تست و تطبیق:** PASS
**SQLite موقت:** /tmp/mahak-cheaper-exchange-multi-800-cash-5WDNzs/isolated.db

## فاکتور و تعویض
- نوع فاکتور: چندقلمی؛ خطوط 4؛ ناخالص ۴٬۰۰۰٬۰۰۰ تومان؛ تخفیف کل ۸۰۰٬۰۰۰ تومان؛ خالص پرداخت ۳٬۲۰۰٬۰۰۰ تومان.
- قیمت روی برچسب قلم برگشتی: ۱٬۰۰۰٬۰۰۰ تومان؛ سهم تخفیف همان قلم ۲۰۰٬۰۰۰ تومان؛ ارزش خالص برگشت ۸۰۰٬۰۰۰ تومان.
- قیمت جایگزین ۸۰۰٬۰۰۰ تومان؛ اختلاف ۰ تومان بدون مابه‌التفاوت.
- روش/ثبت بازپرداخت: CASH.

## تطبیق عدد آبی و انبار
- {"payments":[{"amount":32000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"CHEAPER-MULTI-800-CASH-CASH"},{"amount":8000000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"}],"cashIn":32000000,"cashOut":0,"blue":32000000,"reportTotals":{"count":2,"goodsTotal":48000000,"taxTotal":0,"serviceTotal":0,"discountTotal":8000000,"deliveryTotal":0,"grandTotal":40000000,"cashTotal":32000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":32000000,"returnedTotal":0,"exchangeCreditTotal":8000000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":32000000,"exchangeReturnedTotal":8000000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"source-1","actual":10,"ledger":0},{"name":"source-2","actual":9,"ledger":-1},{"name":"source-3","actual":9,"ledger":-1},{"name":"source-4","actual":9,"ledger":-1},{"name":"replacement","actual":9,"ledger":-1}],"cheques":0}

Only temporary isolated SQLite; no production/staging/live database or real money. Manager card-to-card is only a test-harness record; no actual bank transfer.
