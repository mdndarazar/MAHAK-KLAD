# E100-090 کنترل discount-chain — refund STORE_CREDIT

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

شش کد multi-use با scope عادی ALL، هرکدام ۲۰۰٬۰۰۰؛ هرکدام ۱۰۰٬۰۰۰ روی فاکتور ریشه مصرف شده‌اند. اعتبارها روی کل فاکتور pool می‌شوند و برای A/B/C/D سهم per-item ساختگی تعریف نشده است. برگشت A از مسیر NONE بازپرداخت واقعی ندارد و سهم اعتبار به همان کدهای نیمه‌مصرف‌شده برمی‌گردد؛ جانشین صادر نمی‌شود.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۱۰۰٬۰۰۰؛ net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار محدودشده=۶۰۰٬۰۰۰؛ نقد=۱۵۰٬۰۰۰؛ POS=۱۵۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
ریشه net=۹۰۰٬۰۰۰؛ برگشت A=۱۸۰٬۰۰۰ با NONE؛ B=۱۸۰٬۰۰۰→۱۹۸٬۰۰۰ (۱۸٬۰۰۰) PASS؛ C+D=۵۴۰٬۰۰۰→۵۲۲٬۰۰۰ (‎−۱۸٬۰۰۰) BLOCKED؛ B1→B2=اجرا نشد.

Final cash=۱۵۰٬۰۰۰؛ POS=۱۶۸٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۳۱۸٬۰۰۰.
فاکتور=2؛ برگشت=2؛ payment=10؛ cash movement=0؛ allocation=2؛ redemption=6.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":198000,"exchangeDiff":18000,"exchangeSettlement":"CASH"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":6,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":2,"amount":80000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
