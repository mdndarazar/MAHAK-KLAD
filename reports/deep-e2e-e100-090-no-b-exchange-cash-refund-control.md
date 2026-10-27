# E100-090 کنترل no-b-exchange — refund CASH

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

شش کد multi-use با scope عادی ALL، هرکدام ۲۰۰٬۰۰۰؛ هرکدام ۱۰۰٬۰۰۰ روی فاکتور ریشه مصرف شده‌اند. اعتبارها روی کل فاکتور pool می‌شوند و برای A/B/C/D سهم per-item ساختگی تعریف نشده است. برگشت A از مسیر NONE بازپرداخت واقعی ندارد و سهم اعتبار به همان کدهای نیمه‌مصرف‌شده برمی‌گردد؛ جانشین صادر نمی‌شود.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۶۰۰٬۰۰۰؛ نقد=۲۰۰٬۰۰۰؛ POS=۲۰۰٬۰۰۰. روش ورودی settlement منفی=CASH.

## نتیجه
ریشه net=۱٬۰۰۰٬۰۰۰؛ برگشت A=۲۰۰٬۰۰۰؛ بدون exchange واسط B، تبادل مستقیم C+D=۶۰۰٬۰۰۰→۵۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) PASS.

Final cash=۲۰۰٬۰۰۰؛ POS=۲۰۰٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۴۰۰٬۰۰۰.
فاکتور=2؛ برگشت=2؛ payment=9؛ cash movement=0؛ allocation=3؛ redemption=6.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":600000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":580000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":3,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":2,"redemptionId":6,"sourceCreditId":2,"amount":20000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
