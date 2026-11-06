# E100-071 کنترل single-document

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

چهار کد single-use manager-restricted به B/C/D و اقلام جایگزین صادر شدند؛ A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.

## پیکربندی مالی
Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=۰؛ net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار محدودشده=۴۰۰٬۰۰۰؛ نقد=۳۰۰٬۰۰۰؛ POS=۳۰۰٬۰۰۰. روش ورودی settlement منفی=در این اجرا اختلاف منفی رخ نداد.

## نتیجه
پس از برگشت A، B+C+D یک‌جا: ۸۰۰٬۰۰۰→۸۰۰٬۰۰۰، اختلاف=۰؛ PASS.

Final cash=۳۰۰٬۰۰۰؛ POS=۳۰۰٬۰۰۰؛ برگشت نقد=۲۰۰٬۰۰۰؛ برگشت POS=۰؛ blue=۴۰۰٬۰۰۰.
فاکتور=2؛ برگشت=2؛ payment=7؛ cash movement=1؛ allocation=8؛ redemption=4.
برگشت‌ها: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"CASH","refundAmount":200000,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":800000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":2,"exchangeTotal":800000,"exchangeDiff":0,"exchangeSettlement":"NONE"}]
Allocationها: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":2,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":3,"returnId":1,"redemptionId":3,"sourceCreditId":4,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":4,"returnId":1,"redemptionId":4,"sourceCreditId":3,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":5,"returnId":2,"redemptionId":1,"sourceCreditId":2,"amount":100000,"saleItemId":2,"creditRestored":false,"settlementAdjusted":false},{"id":6,"returnId":2,"redemptionId":2,"sourceCreditId":1,"amount":100000,"saleItemId":2,"creditRestored":false,"settlementAdjusted":false},{"id":7,"returnId":2,"redemptionId":3,"sourceCreditId":4,"amount":100000,"saleItemId":3,"creditRestored":false,"settlementAdjusted":false},{"id":8,"returnId":2,"redemptionId":4,"sourceCreditId":3,"amount":100000,"saleItemId":3,"creditRestored":false,"settlementAdjusted":false}]

JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.
فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.
