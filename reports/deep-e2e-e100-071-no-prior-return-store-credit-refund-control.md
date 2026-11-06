# E100-071 کنترل no-prior-return — refund STORE_CREDIT

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

چهار کد single-use manager-restricted به B/C/D و اقلام جایگزین صادر شدند؛ A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۴۰۰٬۰۰۰؛ نقد=۳۰۰٬۰۰۰؛ POS=۳۰۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
ریشه net=۱٬۰۰۰٬۰۰۰؛ برگشت A=۰ (حذف‌شده برای کنترل تشخیصی)؛ B=۲۰۰٬۰۰۰→۱۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) PASS؛ C+D=۶۰۰٬۰۰۰→۶۲۰٬۰۰۰ (۲۰٬۰۰۰) PASS؛ B1→B2=۲۰٬۰۰۰ PASS.

Final cash=۳۰۰٬۰۰۰؛ POS=۳۴۰٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۶۴۰٬۰۰۰.
فاکتور=4؛ برگشت=3؛ payment=11؛ cash movement=0؛ allocation=1؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"EXCHANGE","total":200000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":180000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":600000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":620000,"exchangeDiff":20000,"exchangeSettlement":"CASH"},{"id":3,"invoiceId":2,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":4,"exchangeTotal":200000,"exchangeDiff":20000,"exchangeSettlement":"CASH"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":2,"sourceCreditId":4,"amount":20000,"saleItemId":2,"creditRestored":true,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
