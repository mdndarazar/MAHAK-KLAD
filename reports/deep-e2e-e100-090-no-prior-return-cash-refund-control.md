# E100-090 کنترل no-prior-return — refund CASH

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

شش کد multi-use با scope عادی ALL، هرکدام ۲۰۰٬۰۰۰؛ هرکدام ۱۰۰٬۰۰۰ روی فاکتور ریشه مصرف شده‌اند. اعتبارها روی کل فاکتور pool می‌شوند و برای A/B/C/D سهم per-item ساختگی تعریف نشده است. برگشت A از مسیر NONE بازپرداخت واقعی ندارد و سهم اعتبار به همان کدهای نیمه‌مصرف‌شده برمی‌گردد؛ جانشین صادر نمی‌شود.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۶۰۰٬۰۰۰؛ نقد=۲۰۰٬۰۰۰؛ POS=۲۰۰٬۰۰۰. روش ورودی settlement منفی=CASH.

## نتیجه
ریشه net=۱٬۰۰۰٬۰۰۰؛ برگشت A=۰ (حذف‌شده برای کنترل تشخیصی)؛ B=۲۰۰٬۰۰۰→۲۲۰٬۰۰۰ (۲۰٬۰۰۰) PASS؛ C+D=۶۰۰٬۰۰۰→۵۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) BLOCKED؛ B1→B2=اجرا نشد.

Final cash=۲۰۰٬۰۰۰؛ POS=۲۲۰٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۴۲۰٬۰۰۰.
فاکتور=2؛ برگشت=1؛ payment=10؛ cash movement=0؛ allocation=0؛ redemption=6.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"EXCHANGE","total":200000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":220000,"exchangeDiff":20000,"exchangeSettlement":"CASH"}]
Allocationها: []

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
