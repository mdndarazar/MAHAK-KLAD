# E100-071 کنترل baseline-chain — refund STORE_CREDIT

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

چهار کد single-use manager-restricted به B/C/D و اقلام جایگزین صادر شدند؛ A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۴۰۰٬۰۰۰؛ نقد=۳۰۰٬۰۰۰؛ POS=۳۰۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
ریشه net=۱٬۰۰۰٬۰۰۰؛ برگشت A=۲۰۰٬۰۰۰ با CASH؛ B=۲۰۰٬۰۰۰→۱۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) BLOCKED؛ C+D=۰→۰ (۰) اجرا نشد؛ B1→B2=اجرا نشد.

Final cash=۳۰۰٬۰۰۰؛ POS=۳۰۰٬۰۰۰؛ برگشت نقد=۲۰۰٬۰۰۰؛ برگشت POS=۰؛ blue=۴۰۰٬۰۰۰.
فاکتور=1؛ برگشت=1؛ payment=6؛ cash movement=1؛ allocation=0؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"CASH","refundAmount":200000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null}]
Allocationها: []

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
