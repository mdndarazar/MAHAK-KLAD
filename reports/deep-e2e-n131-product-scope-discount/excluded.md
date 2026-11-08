# N131 product-scope probe — replacement excluded

**اجرای reconciliation:** PASS
**SQLite:** /tmp/mahak-n131-product-scope-excluded-Y2sQra/isolated.db

## تخفیف محصول‌محور
- PriceAdjust واقعی با kind=DISCOUNT، mode=PERCENT، value=10 و scope=VARIANTS اعمال شد.
- در هر دو اجرا A و B داخل scope بودند؛ A از ۱۰۰٬۰۰۰ به ۹۰٬۰۰۰ و B از ۲۰۰٬۰۰۰ به ۱۸۰٬۰۰۰ رسید.
- جایگزین A1 فقط در اجرای included داخل scope بود؛ جایگزین C در اجرای excluded بیرون scope ماند.

## مشاهدهٔ برگشت/تعویض
- {"replacementScope":"EXCLUDED","replacementVariantId":4,"replacementPrice":100000,"sourceReturnValue":90000,"actualDiff":10000,"cashReceived":10000,"cashRefunded":0,"childDiscount":0,"returnMethod":"NONE"}
- PriceAdjust: {"batchId":1,"title":"10٪ تخفیف روی قیمت فروش · ۲ کالای انتخاب‌شده","kind":"DISCOUNT","mode":"PERCENT","percent":10,"scope":"VARIANTS","scopedIds":[1,2],"changedIds":[1,2],"activeDiscountVariantIds":[1,2],"prices":{"A":90000,"B":180000,"A1":100000,"C":100000}}

## تطبیق
- {"rawCash":280000,"rawCard":0,"refund":0,"blue":280000,"reportTotals":{"count":2,"goodsTotal":370000,"taxTotal":0,"serviceTotal":0,"discountTotal":0,"deliveryTotal":0,"grandTotal":370000,"cashTotal":280000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":280000,"returnedTotal":0,"exchangeCreditTotal":90000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":10000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":280000,"exchangeReturnedTotal":90000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"name":"A source returned","actual":10,"ledger":0},{"name":"B kept","actual":9,"ledger":-1},{"name":"A1 eligible option","actual":10,"ledger":0},{"name":"C excluded option","actual":9,"ledger":-1}],"cheques":0}

این آزمون دربارهٔ تخفیف گروهیِ مختص SKUهاست؛ N131 قبلی تخفیف invoice-level داشت. دو نوع تخفیف عمداً از هم تفکیک شده‌اند. فقط SQLite موقت؛ بدون پول یا DB واقعی/staging و بدون تغییر production.
