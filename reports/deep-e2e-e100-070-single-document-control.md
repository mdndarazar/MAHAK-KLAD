# E100-070 کنترل بدون زنجیره: تعویض B+C+D در یک سند

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

پس از همان برگشت A، B+C+D یک‌جا از فاکتور ریشه در یک درخواست exchange انجام شدند؛ تعویض مثبت B به‌صورت سند واسط حذف شد. فاکتور فروش اصلی، بی‌تخفیف و با سه کد single-use عادی ALL، هرکدام ۱۰۰٬۰۰۰ ریال بود.

## محاسبهٔ مبالغ
فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=۰، net=۱٬۰۰۰٬۰۰۰؛ خطوط خالص={"A":200000,"B":200000,"C":300000,"D":300000}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=۳۵۰٬۰۰۰ نقد + ۳۵۰٬۰۰۰ POS.

## نتیجهٔ عملیات
برگشت A=۲۰۰٬۰۰۰؛ یک تعویض B+C+D: ۸۰۰٬۰۰۰→۸۰۰٬۰۰۰، اختلاف=۰؛ PASS.

وضعیت نهایی واقعی: cash=۳۵۰٬۰۰۰، POS=۳۵۰٬۰۰۰، refund نقد=۰، refund POS=۰، blue=۷۰۰٬۰۰۰.
تعداد فاکتور=2؛ برگشت=2؛ Payment=6؛ CashMovement=0؛ allocations=4.
برگشت‌های ثبت‌شده: [{"id":1,"invoiceId":1,"kind":"RETURN","total":200000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":800000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":2,"exchangeTotal":800000,"exchangeDiff":0,"exchangeSettlement":"NONE"}]
Allocationهای منبع: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":3,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":1,"redemptionId":3,"sourceCreditId":2,"amount":0,"saleItemId":null,"creditRestored":false,"settlementAdjusted":true},{"id":4,"returnId":2,"redemptionId":3,"sourceCreditId":2,"amount":100000,"saleItemId":null,"creditRestored":false,"settlementAdjusted":false}]

JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.
فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.
