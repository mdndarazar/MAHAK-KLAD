# زنجیرهٔ تخفیف و بارکد اعتبار — تک‌قلمی

**نتیجهٔ اجرا و تطبیق:** PASS
**SQLite موقت:** /tmp/mahak-discount-credit-chain-single-2qwhSS/isolated.db

## زنجیره‌ای که اجرا شد
۱. فروش فاکتور با تخفیف کلی فروشنده.
۲. برگشت یک کالا با روش STORE_CREDIT و صدور بارکد.
۳. مصرف کامل همان بارکد برای خرید تازه.
۴. برگشت کامل کالای خرید دوم با STORE_CREDIT و سنجش اعتبار باقی‌مانده/جایگزین.

## نتیجهٔ مبلغ‌ها
- فاکتور اولیه: 10000000 ناخالص، تخفیف 1000000، خالص 9000000.
- برگشت اول: ارزش خالص 9000000؛ مجموع بارکد اول 9000000.
- خرید دوم با بارکد: قیمت 9000000 و اعتبار مصرف‌شده 9000000.
- برگشت دوم: 9000000؛ بارکدهای صادرشده در مرحلهٔ دوم 9000000؛ ماندهٔ فعال کل 9000000.
- تطبیق وجه/موجودی: {"originalCashReceived":9000000,"cashRefunded":0,"blue":9000000,"reportTotals":{"count":2,"goodsTotal":19000000,"taxTotal":0,"serviceTotal":0,"discountTotal":1000000,"deliveryTotal":0,"grandTotal":18000000,"cashTotal":9000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":9000000,"returnedTotal":18000000,"exchangeCreditTotal":0,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":18000000,"exchangeCount":0,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":-9000000,"exchangeReturnedTotal":0,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":9000000,"storeCreditRefundTotal":9000000,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"original-1","actual":10,"ledger":0},{"name":"second-sale-good","actual":10,"ledger":0}],"cheques":0}

Only a temporary isolated SQLite database was used; no production/staging or live database, real payment, or production code change.
