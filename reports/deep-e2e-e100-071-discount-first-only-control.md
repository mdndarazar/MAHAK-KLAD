# E100-071 کنترل discount-first-only

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

چهار کد single-use manager-restricted به B/C/D و اقلام جایگزین صادر شدند؛ A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۱۰۰٬۰۰۰؛ net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار محدودشده=۴۰۰٬۰۰۰؛ نقد=۲۵۰٬۰۰۰؛ POS=۲۵۰٬۰۰۰. روش ورودی settlement منفی=در این اجرا اختلاف منفی رخ نداد.

## نتیجه
ریشه net=۹۰۰٬۰۰۰؛ برگشت A=۱۸۰٬۰۰۰ با CASH؛ B=۱۸۰٬۰۰۰→۱۸۰٬۰۰۰ (۰) PASS؛ C+D=۵۴۰٬۰۰۰→۶۲۰٬۰۰۰ (۸۰٬۰۰۰) PASS؛ B1→B2=۲۰٬۰۰۰ PASS.

Final cash=۲۵۰٬۰۰۰؛ POS=۳۵۰٬۰۰۰؛ برگشت نقد=۱۸۰٬۰۰۰؛ برگشت POS=۰؛ blue=۴۲۰٬۰۰۰.
فاکتور=4؛ برگشت=4؛ payment=11؛ cash movement=1؛ allocation=0؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"CASH","refundAmount":180000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":180000,"exchangeDiff":0,"exchangeSettlement":"NONE"},{"id":3,"invoiceId":1,"kind":"EXCHANGE","total":540000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":620000,"exchangeDiff":80000,"exchangeSettlement":"CASH"},{"id":4,"invoiceId":2,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":4,"exchangeTotal":200000,"exchangeDiff":20000,"exchangeSettlement":"CASH"}]
Allocationها: []

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
