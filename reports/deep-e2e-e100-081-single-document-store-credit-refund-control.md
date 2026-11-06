# E100-081 کنترل single-document — refund STORE_CREDIT

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

دو کد multi-use manager-restricted، هرکدام ۱۰۰٬۰۰۰، فقط به B/C/D، اقلام جایگزین و دو SKU کمکی محدود شدند؛ هر کدام ۵۰٬۰۰۰ روی root و ۵۰٬۰۰۰ روی auxiliary invoice مصرف شدند. A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۱۰۰٬۰۰۰؛ نقد=۴۵۰٬۰۰۰؛ POS=۴۵۰٬۰۰۰. روش ورودی settlement منفی=STORE_CREDIT.

## نتیجه
پس از برگشت A، B+C+D یک‌جا: ۸۰۰٬۰۰۰→۷۶۰٬۰۰۰، اختلاف=‎−۴۰٬۰۰۰؛ PASS.

Final cash=۴۵۰٬۰۰۰؛ POS=۴۵۰٬۰۰۰؛ برگشت نقد=۲۰۰٬۰۰۰؛ برگشت POS=۰؛ blue=۷۰۰٬۰۰۰.
فاکتور=3؛ برگشت=2؛ payment=7؛ cash movement=1؛ allocation=5؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"CASH","refundAmount":200000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":800000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":760000,"exchangeDiff":-40000,"exchangeSettlement":"CREDIT"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":1,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":2,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":3,"returnId":2,"redemptionId":1,"sourceCreditId":1,"amount":50000,"saleItemId":2,"creditRestored":false,"settlementAdjusted":false},{"id":4,"returnId":2,"redemptionId":2,"sourceCreditId":2,"amount":10000,"saleItemId":2,"creditRestored":false,"settlementAdjusted":false},{"id":5,"returnId":2,"redemptionId":2,"sourceCreditId":2,"amount":40000,"saleItemId":2,"creditRestored":true,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
