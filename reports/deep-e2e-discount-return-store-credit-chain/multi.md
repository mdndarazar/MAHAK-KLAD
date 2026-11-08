# زنجیرهٔ تخفیف و بارکد اعتبار — چندقلمی

**نتیجهٔ اجرا و تطبیق:** PASS
**SQLite موقت:** /tmp/mahak-discount-credit-chain-multi-ZwyitR/isolated.db

## زنجیره‌ای که اجرا شد
۱. فروش فاکتور با تخفیف کلی فروشنده.
۲. برگشت یک کالا با روش STORE_CREDIT و صدور بارکد.
۳. مصرف کامل همان بارکد برای خرید تازه.
۴. برگشت کامل کالای خرید دوم با STORE_CREDIT و سنجش اعتبار باقی‌مانده/جایگزین.

## نتیجهٔ مبلغ‌ها
- فاکتور اولیه: 40000000 ناخالص، تخفیف 10000000، خالص 30000000.
- برگشت اول: ارزش خالص 7500000؛ مجموع بارکد اول 7500000.
- خرید دوم با بارکد: قیمت 7500000 و اعتبار مصرف‌شده 7500000.
- برگشت دوم: 7500000؛ بارکدهای صادرشده در مرحلهٔ دوم 7500000؛ ماندهٔ فعال کل 7500000.
- تطبیق وجه/موجودی: {"originalCashReceived":30000000,"cashRefunded":0,"blue":30000000,"reportTotals":{"count":2,"goodsTotal":47500000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000000,"deliveryTotal":0,"grandTotal":37500000,"cashTotal":30000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":30000000,"returnedTotal":15000000,"exchangeCreditTotal":0,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":15000000,"exchangeCount":0,"exchangeDiffTotal":0,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":15000000,"exchangeReturnedTotal":0,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":7500000,"storeCreditRefundTotal":7500000,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"original-1","actual":10,"ledger":0},{"name":"original-2","actual":9,"ledger":-1},{"name":"original-3","actual":9,"ledger":-1},{"name":"original-4","actual":9,"ledger":-1},{"name":"second-sale-good","actual":10,"ledger":0}],"cheques":0}

Only a temporary isolated SQLite database was used; no production/staging or live database, real payment, or production code change.
