# E100-070 زنجیره با ۱۰٪ تخفیف روی همهٔ فاکتورهای زنجیره

**وضعیت:** BLOCKED. **DB:** SQLite موقت ایزوله.

تخفیف ۱۰٪ متناسب روی خطوط فاکتور اولیه و همچنین روی خطوط جایگزین در هر exchange اعمال شد؛ فاکتور کمکی وجود ندارد چون در E100-070 سه کد single-use هستند و هرکدام روی یک آیتم فاکتور ریشه مصرف می‌شوند.

## محاسبهٔ مبالغ
فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=۱۰۰٬۰۰۰، net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=۳۰۰٬۰۰۰ نقد + ۳۰۰٬۰۰۰ POS؛ روش آزمودهٔ refund منفی=STORE_CREDIT.

## نتیجهٔ عملیات
ریشه net=۹۰۰٬۰۰۰ (تخفیف ۱۰۰٬۰۰۰؛ خطوط {"A":180000,"B":180000,"C":270000,"D":270000}). برگشت A=۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۱۹۸٬۰۰۰ (۱۸٬۰۰۰); C+D: ۵۴۰٬۰۰۰→۵۲۲٬۰۰۰ (‎−۱۸٬۰۰۰) BLOCKED; B1→B2: اجرا نشد؛ C+D متوقف شد.

وضعیت نهایی واقعی: cash=۳۰۰٬۰۰۰، POS=۳۰۰٬۰۰۰، refund نقد=۰، refund POS=۰، blue=۶۰۰٬۰۰۰.
تعداد فاکتور=2؛ برگشت=2؛ Payment=7؛ CashMovement=0؛ allocations=2.
برگشت‌های ثبت‌شده: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":2,"exchangeTotal":198000,"exchangeDiff":18000,"exchangeSettlement":"CREDIT"}]
Allocationهای منبع: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":3,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":1,"amount":80000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true}]

JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.
فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.
