# E100-081 کنترل single-document — refund CASH

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

دو کد multi-use manager-restricted، هرکدام ۱۰۰٬۰۰۰، فقط به B/C/D، اقلام جایگزین و دو SKU کمکی محدود شدند؛ هر کدام ۵۰٬۰۰۰ روی root و ۵۰٬۰۰۰ روی auxiliary invoice مصرف شدند. A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۱۰۰٬۰۰۰؛ نقد=۴۵۰٬۰۰۰؛ POS=۴۵۰٬۰۰۰. روش ورودی settlement منفی=CASH.

## نتیجه
پس از برگشت A، B+C+D یک‌جا: ۸۰۰٬۰۰۰→۷۶۰٬۰۰۰، اختلاف=‎−۴۰٬۰۰۰؛ BLOCKED.

Final cash=۴۵۰٬۰۰۰؛ POS=۴۵۰٬۰۰۰؛ برگشت نقد=۲۰۰٬۰۰۰؛ برگشت POS=۰؛ blue=۷۰۰٬۰۰۰.
فاکتور=2؛ برگشت=1؛ payment=6؛ cash movement=1؛ allocation=0؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"CASH","refundAmount":200000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null}]
Allocationها: []

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
