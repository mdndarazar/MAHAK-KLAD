# E100-066 کنترل بدون زنجیره: تعویض B+C+D در یک سند

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

پس از همان برگشت A، B+C+D یک‌جا از فاکتور ریشه در یک درخواست exchange انجام شدند؛ تعویض مثبت B به‌صورت سند واسط حذف شد. فاکتور فروش اصلی، بی‌تخفیف و با همان شش کد ۵۰٬۰۰۰تایی ALL بود.

## محاسبهٔ مبالغ
فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=۰، net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=۷۰۰٬۰۰۰ نقد.

## نتیجهٔ عملیات
برگشت A=۲۰۰٬۰۰۰؛ یک تعویض B+C+D: ۸۰۰٬۰۰۰→۸۰۰٬۰۰۰، اختلاف=۰؛ PASS.

وضعیت نهایی واقعی: cash=۷۰۰٬۰۰۰، POS=۰، refund نقد=۰، refund POS=۰، blue=۷۰۰٬۰۰۰.
تعداد فاکتور=2؛ برگشت=2؛ Payment=8؛ CashMovement=0؛ allocations=8.
برگشت‌های ثبت‌شده: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":800000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":2,"exchangeTotal":800000,"exchangeDiff":0,"exchangeSettlement":"NONE"}]
Allocationهای منبع: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":2,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":5,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":1,"redemptionId":3,"sourceCreditId":1,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":4,"returnId":1,"redemptionId":4,"sourceCreditId":4,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":5,"returnId":1,"redemptionId":5,"sourceCreditId":6,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":6,"returnId":1,"redemptionId":6,"sourceCreditId":3,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":7,"returnId":2,"redemptionId":5,"sourceCreditId":6,"amount":50000,"saleItemId":null,"creditRestored":false,"settlementAdjusted":false},{"id":8,"returnId":2,"redemptionId":6,"sourceCreditId":3,"amount":50000,"saleItemId":null,"creditRestored":false,"settlementAdjusted":false}]

JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.
فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.
