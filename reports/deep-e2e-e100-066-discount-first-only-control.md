# E100-066 زنجیره با تخفیف فقط روی فاکتور اول

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

تخفیف ۱۰٪ متناسب فقط روی خطوط فاکتور اولیه اعمال شد؛ B1/C1/D1/B2 با قیمت کامل باقی ماندند تا قیمت خالص پرداخت‌شدهٔ خرید اولیه با قیمت جاری جایگزین سنجیده شود.

## محاسبهٔ مبالغ
فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=۱۰۰٬۰۰۰، net=۹۰۰٬۰۰۰؛ خطوط خالص={"A":180000,"B":180000,"C":270000,"D":270000}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=۶۰۰٬۰۰۰ نقد.

## نتیجهٔ عملیات
ریشه net=۹۰۰٬۰۰۰ (تخفیف ۱۰۰٬۰۰۰؛ خطوط {"A":180000,"B":180000,"C":270000,"D":270000}). برگشت A=۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۲۲۰٬۰۰۰ (۴۰٬۰۰۰); C+D: ۵۴۰٬۰۰۰→۵۸۰٬۰۰۰ (۴۰٬۰۰۰) PASS; B1→B2: ‎−۲۰٬۰۰۰ / STORE_CREDIT.

وضعیت نهایی واقعی: cash=۶۰۰٬۰۰۰، POS=۴۰٬۰۰۰، refund نقد=۰، refund POS=۰، blue=۶۴۰٬۰۰۰.
تعداد فاکتور=4؛ برگشت=4؛ Payment=12؛ CashMovement=0؛ allocations=5.
برگشت‌های ثبت‌شده: [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":2,"exchangeTotal":220000,"exchangeDiff":40000,"exchangeSettlement":"CASH"},{"id":3,"invoiceId":1,"kind":"EXCHANGE","total":540000,"refundMethod":"NONE","refundAmount":0,"exchangeInvoiceId":3,"exchangeTotal":580000,"exchangeDiff":40000,"exchangeSettlement":"CREDIT"},{"id":4,"invoiceId":2,"kind":"EXCHANGE","total":220000,"refundMethod":"STORE_CREDIT","refundAmount":0,"exchangeInvoiceId":4,"exchangeTotal":200000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"}]
Allocationهای منبع: [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":4,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":6,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":1,"redemptionId":3,"sourceCreditId":3,"amount":50000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":4,"returnId":1,"redemptionId":4,"sourceCreditId":5,"amount":30000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":5,"returnId":4,"redemptionId":6,"sourceCreditId":1,"amount":20000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":false}]

JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.
فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.
