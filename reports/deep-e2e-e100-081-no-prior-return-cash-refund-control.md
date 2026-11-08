# E100-081 کنترل no-prior-return — refund CASH

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

دو کد multi-use manager-restricted، هرکدام ۱۰۰٬۰۰۰، فقط به B/C/D، اقلام جایگزین و دو SKU کمکی محدود شدند؛ هر کدام ۵۰٬۰۰۰ روی root و ۵۰٬۰۰۰ روی auxiliary invoice مصرف شدند. A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۱۰۰٬۰۰۰؛ نقد=۴۵۰٬۰۰۰؛ POS=۴۵۰٬۰۰۰. روش ورودی settlement منفی=CASH.

## نتیجه
ریشه net=۱٬۰۰۰٬۰۰۰؛ برگشت A=۰ (حذف‌شده برای کنترل تشخیصی)؛ B=۲۰۰٬۰۰۰→۱۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) PASS؛ C+D=۶۰۰٬۰۰۰→۵۸۰٬۰۰۰ (‎−۲۰٬۰۰۰) PASS؛ B1→B2=۲۰٬۰۰۰ PASS.

Final cash=۴۵۰٬۰۰۰؛ POS=۴۷۰٬۰۰۰؛ برگشت نقد=۰؛ برگشت POS=۰؛ blue=۹۲۰٬۰۰۰.
فاکتور=5؛ برگشت=3؛ payment=10؛ cash movement=0؛ allocation=2؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"EXCHANGE","total":200000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":180000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":600000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":4,"exchangeTotal":580000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"},{"id":3,"invoiceId":3,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":5,"exchangeTotal":200000,"exchangeDiff":20000,"exchangeSettlement":"CASH"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":20000,"saleItemId":2,"creditRestored":true,"settlementAdjusted":false},{"id":2,"returnId":2,"redemptionId":2,"sourceCreditId":1,"amount":20000,"saleItemId":3,"creditRestored":true,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
