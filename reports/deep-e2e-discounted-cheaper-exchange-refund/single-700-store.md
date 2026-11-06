# تعویض با کالای ارزان‌تر/هم‌قیمت — SINGLE-700-STORE

**نتیجهٔ تست و تطبیق:** PASS
**SQLite موقت:** /tmp/mahak-cheaper-exchange-single-700-store-oKKxxE/isolated.db

## فاکتور و تعویض
- نوع فاکتور: تک‌قلمی؛ خطوط 1؛ ناخالص ۱٬۰۰۰٬۰۰۰ تومان؛ تخفیف کل ۲۰۰٬۰۰۰ تومان؛ خالص پرداخت ۸۰۰٬۰۰۰ تومان.
- قیمت روی برچسب قلم برگشتی: ۱٬۰۰۰٬۰۰۰ تومان؛ سهم تخفیف همان قلم ۲۰۰٬۰۰۰ تومان؛ ارزش خالص برگشت ۸۰۰٬۰۰۰ تومان.
- قیمت جایگزین ۷۰۰٬۰۰۰ تومان؛ اختلاف ۱۰۰٬۰۰۰ تومان بازپرداخت به مشتری.
- روش/ثبت بازپرداخت: STORE_CREDIT؛ اعتبار بارکدی صادرشده ۱۰۰٬۰۰۰ تومان.

## تطبیق عدد آبی و انبار
- {"payments":[{"amount":8000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"CHEAPER-SINGLE-700-STORE-CASH"},{"amount":7000000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"}],"cashIn":8000000,"cashOut":0,"blue":8000000,"reportTotals":{"count":2,"goodsTotal":17000000,"taxTotal":0,"serviceTotal":0,"discountTotal":2000000,"deliveryTotal":0,"grandTotal":15000000,"cashTotal":8000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":8000000,"returnedTotal":0,"exchangeCreditTotal":7000000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":1000000,"exchangeCount":1,"exchangeDiffTotal":-1000000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":7000000,"exchangeReturnedTotal":8000000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":1000000,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"source-1","actual":10,"ledger":0},{"name":"replacement","actual":9,"ledger":-1}],"cheques":0}

Only temporary isolated SQLite; no production/staging/live database or real money. Manager card-to-card is only a test-harness record; no actual bank transfer.
