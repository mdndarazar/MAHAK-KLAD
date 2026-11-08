# E100-090 کنترل discount-first-only — refund STORE_CREDIT

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

شش کد multi-use با scope عادی ALL، هرکدام ۲۰۰٬۰۰۰؛ هرکدام ۱۰۰٬۰۰۰ روی فاکتور ریشه مصرف شده‌اند. اعتبارها روی کل فاکتور pool می‌شوند و برای A/B/C/D سهم per-item ساختگی تعریف نشده است. برگشت A از مسیر NONE بازپرداخت واقعی ندارد و سهم اعتبار به همان کدهای نیمه‌مصرف‌شده برمی‌گردد؛ جانشین صادر نمی‌شود.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۱۰۰٬۰۰۰؛ net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار محدودشده=۶۰۰٬۰۰۰؛ نقد=۱۵۰٬۰۰۰؛ POS=۱۵۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
ریشه net=۹۰۰٬۰۰۰؛ برگشت A=۱۸۰٬۰۰۰ با NONE؛ B=۱۸۰٬۰۰۰→۲۲۰٬۰۰۰ (۴۰٬۰۰۰) PASS؛ C+D=۵۴۰٬۰۰۰→۵۸۰٬۰۰۰ (۴۰٬۰۰۰) PASS؛ B1→B2=‎−۲۰٬۰۰۰ PASS.

Final cash=۱۵۰٬۰۰۰؛ POS=۲۳۰٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۳۸۰٬۰۰۰.
فاکتور=4؛ برگشت=4؛ payment=13؛ cash movement=0؛ allocation=3؛ redemption=6.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":220000,"exchangeDiff":40000,"exchangeSettlement":"CASH"},{"id":3,"invoiceId":1,"kind":"EXCHANGE","total":540000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":580000,"exchangeDiff":40000,"exchangeSettlement":"CASH"},{"id":4,"invoiceId":2,"kind":"EXCHANGE","total":220000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":4,"exchangeTotal":200000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":6,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":80000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":4,"redemptionId":4,"sourceCreditId":4,"amount":20000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
