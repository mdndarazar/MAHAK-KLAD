# E100-054 کنترل تخفیف‌دار: تکرار زنجیره با تخفیف ۱۰٪

**وضعیت:** PASS. **DB:** SQLite موقت ایزوله.

همان ترتیب E100-054 اجرا شد، اما روی اقلام فاکتور ریشه ۱۰٪ تخفیف متناسب اعمال شد؛ قیمت‌های جایگزین B1/C1/D1 بدون تخفیف ماندند تا اختلاف با قیمت خالصی که مشتری واقعاً پرداخته سنجیده شود. فاکتور کمکیِ مصرف دوم کدها مانند اجرای اصلی بدون تخفیف باقی ماند.

## محاسبهٔ net
ریشه: gross=۱٬۰۰۰٬۰۰۰، تخفیف=۱۰۰٬۰۰۰، net=۹۰۰٬۰۰۰؛ خطوط net={"A":180000,"B":180000,"C":270000,"D":270000}.
تسویهٔ ریشه: اعتبار ۶۰۰٬۰۰۰ + نقد ۱۵۰٬۰۰۰ + POS ۱۵۰٬۰۰۰.

## نتایج عملیات
برگشت A: ۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۲۲۰٬۰۰۰، اختلاف +۴۰٬۰۰۰؛ C+D: ۵۴۰٬۰۰۰→۵۸۰٬۰۰۰، اختلاف ۴۰٬۰۰۰؛ خطای C+D=ندارد؛ B1→B2: اختلاف ‎−۲۰٬۰۰۰، روش درخواستی CASH، روش ثبت‌شده STORE_CREDIT، سهم اعتبار برگشتی ۲۰٬۰۰۰، بازپرداخت نقدی ۰.
در گام B1→B2، ورودی CASH خواسته بود؛ چون مازاد قابل‌بازگشت از pool اعتبار بود نه پول واقعی، سیستم نقد نداد و ۲۰٬۰۰۰ را به منبع اعتبار برگرداند.

**ماندهٔ واقعی:** cash=۱۵۰٬۰۰۰، POS=۱۹۰٬۰۰۰، refund cash=۰، refund POS=۰، blue=۳۴۰٬۰۰۰.
**فاکتورها:** [{"id":1,"sourceInvoiceId":null,"grandTotal":900000,"paidTotal":900000,"settled":true,"items":[{"variantId":1,"qty":1,"unitPrice":200000,"discount":20000,"lineTotal":180000},{"variantId":2,"qty":1,"unitPrice":200000,"discount":20000,"lineTotal":180000},{"variantId":3,"qty":1,"unitPrice":300000,"discount":30000,"lineTotal":270000},{"variantId":4,"qty":1,"unitPrice":300000,"discount":30000,"lineTotal":270000}]},{"id":2,"sourceInvoiceId":null,"grandTotal":600000,"paidTotal":600000,"settled":true,"items":[{"variantId":9,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000},{"variantId":10,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000},{"variantId":11,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000},{"variantId":12,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000},{"variantId":13,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000},{"variantId":14,"qty":1,"unitPrice":100000,"discount":0,"lineTotal":100000}]},{"id":3,"sourceInvoiceId":1,"grandTotal":220000,"paidTotal":220000,"settled":true,"items":[{"variantId":5,"qty":1,"unitPrice":220000,"discount":0,"lineTotal":220000}]},{"id":4,"sourceInvoiceId":1,"grandTotal":580000,"paidTotal":580000,"settled":true,"items":[{"variantId":6,"qty":1,"unitPrice":290000,"discount":0,"lineTotal":290000},{"variantId":7,"qty":1,"unitPrice":290000,"discount":0,"lineTotal":290000}]},{"id":5,"sourceInvoiceId":3,"grandTotal":200000,"paidTotal":200000,"settled":true,"items":[{"variantId":8,"qty":1,"unitPrice":200000,"discount":0,"lineTotal":200000}]}]
**برگشت‌ها:** [{"id":1,"invoiceId":1,"kind":"RETURN","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":null,"exchangeTotal":0,"exchangeDiff":0,"exchangeSettlement":null},{"id":2,"invoiceId":1,"kind":"EXCHANGE","total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":3,"exchangeTotal":220000,"exchangeDiff":40000,"exchangeSettlement":"CASH"},{"id":3,"invoiceId":1,"kind":"EXCHANGE","total":540000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":4,"exchangeTotal":580000,"exchangeDiff":40000,"exchangeSettlement":"CREDIT"},{"id":4,"invoiceId":3,"kind":"EXCHANGE","total":220000,"refundMethod":"STORE_CREDIT","refundAmount":0,"refundStoreCreditAmount":0,"exchangeInvoiceId":5,"exchangeTotal":200000,"exchangeDiff":-20000,"exchangeSettlement":"CREDIT"}]
**Allocationها:** [{"id":1,"returnId":1,"redemptionId":1,"sourceCreditId":5,"amount":100000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":2,"returnId":1,"redemptionId":2,"sourceCreditId":4,"amount":80000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":true},{"id":3,"returnId":4,"redemptionId":4,"sourceCreditId":2,"amount":20000,"saleItemId":null,"creditRestored":true,"settlementAdjusted":false}]

هر checkpoint در JSON، انتظار/واقعی cash و POS، refund، blue، stock/ledger، فاکتورها، اعتبارها و allocationها را نگه می‌دارد.
فقط DB تست ایزوله و گزارش تغییر کرد؛ production code، DB واقعی و policy تغییر نکردند.
