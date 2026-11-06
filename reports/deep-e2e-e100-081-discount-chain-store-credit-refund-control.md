# E100-081 کنترل discount-chain — refund STORE_CREDIT

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

دو کد multi-use manager-restricted، هرکدام ۱۰۰٬۰۰۰، فقط به B/C/D، اقلام جایگزین و دو SKU کمکی محدود شدند؛ هر کدام ۵۰٬۰۰۰ روی root و ۵۰٬۰۰۰ روی auxiliary invoice مصرف شدند. A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۱۰۰٬۰۰۰؛ net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار محدودشده=۱۰۰٬۰۰۰؛ نقد=۴۰۰٬۰۰۰؛ POS=۴۰۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
ریشه net=۹۰۰٬۰۰۰؛ برگشت A=۱۸۰٬۰۰۰ با CASH؛ B=۱۸۰٬۰۰۰→۱۶۲٬۰۰۰ (‎−۱۸٬۰۰۰) BLOCKED؛ C+D=۰→۰ (۰) اجرا نشد؛ B1→B2=اجرا نشد.

Final cash=۴۰۰٬۰۰۰؛ POS=۴۰۰٬۰۰۰؛ برگشت نقد=۱۸۰٬۰۰۰؛ برگشت POS=۰؛ blue=۶۲۰٬۰۰۰.
فاکتور=2؛ برگشت=1؛ payment=6؛ cash movement=1؛ allocation=0؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"CASH","refundAmount":180000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null}]
Allocationها: []

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
