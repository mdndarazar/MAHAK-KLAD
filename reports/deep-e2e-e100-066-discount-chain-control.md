# E100-066 زنجیره با ۱۰٪ تخفیف روی همهٔ فاکتورهای زنجیره

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

تخفیف ۱۰٪ متناسب روی خطوط فاکتور اولیه و همچنین روی خطوط جایگزین در هر exchange اعمال شد؛ فاکتور کمکی وجود ندارد چون در E100-066 شش کد single-use هستند و همه روی همان خرید مصرف می‌شوند.

## محاسبهٔ مبالغ
فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=۱۰۰٬۰۰۰، net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=۶۰۰٬۰۰۰ نقد.

## نتیجهٔ عملیات
ریشه net=۹۰۰٬۰۰۰ (تخفیف ۱۰۰٬۰۰۰؛ خطوط {"A":180000,"B":180000,"C":270000,"D":270000}). برگشت A=۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۱۹۸٬۰۰۰ (۱۸٬۰۰۰); C+D: ۵۴۰٬۰۰۰→۵۲۲٬۰۰۰ (‎−۱۸٬۰۰۰) BLOCKED; B1→B2: اجرا نشد؛ C+D متوقف شد.

وضعیت نهایی واقعی: cash=۶۰۰٬۰۰۰، POS=۱۸٬۰۰۰، refund نقد=۰، refund POS=۰، blue=۶۱۸٬۰۰۰.
تعداد فاکتور=2؛ برگشت=2؛ Payment=9؛ CashMovement=0؛ allocations=4.
برگشت‌های ثبت‌شده: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":2,"exchangeTotal":198000,"exchangeDiff":18000,"exchangeSettlement":"CASH"}]
Allocationهای منبع: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":1,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":4,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":1,"redemptionId":3,"sourceCreditId":3,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":4,"returnId":1,"redemptionId":4,"sourceCreditId":6,"amount":30000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true}]

JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.
فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.
