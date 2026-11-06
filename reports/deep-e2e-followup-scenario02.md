# Follow-up scenario 2 — barcode return plus cash residual

**Status: PASS (isolated service-layer test).**

## مثال مبلغی ریزبه‌ریز
- دو کالا: ۵۰۰٬۰۰۰ + ۵۰۰٬۰۰۰ = **۱٬۰۰۰٬۰۰۰ ریال**.
- پرداخت فروش: **۶۰۰٬۰۰۰ نقد** + چهار بارکدِ **۱۰۰٬۰۰۰** = ۴۰۰٬۰۰۰ اعتبار.
- پس از فروش، مرجع آبی: **۶۰۰٬۰۰۰**؛ اعتبار خرید در آن شمرده نشد.
- کالای ۵۰۰٬۰۰۰ ریالی برگشت داده شد: **۴۰۰٬۰۰۰ اعتبار منبع** به چهار بارکد جانشین برگشت و **۱۰۰٬۰۰۰ ریال نقد** پرداخت شد.
- پس از برگشت: مرجع آبی = ۶۰۰٬۰۰۰ − ۱۰۰٬۰۰۰ = **۵۰۰٬۰۰۰ ریال**؛ کالای برگشتی به موجودی برگشت.

## نتیجه نسبت به سیاست اعلام‌شده
**مطابق در این سناریو:** ۴۰۰٬۰۰۰ ریال اعتبار به پول نقد تبدیل نشد؛ ۱۰۰٬۰۰۰ ریالِ باقیمانده واقعاً از صندوق برگشت؛ مرجع آبی با محاسبهٔ مستقل اسناد خام برابر شد. چهار بارکد جانشین هرکدام ۱۰۰٬۰۰۰ ریال و ACTIVE بودند.

## شواهد
- فاکتور: {"grandTotal":1000000,"paidTotal":1000000,"status":"PARTIALLY_RETURNED","payments":[{"key":"F02-CASH","kind":"CASH","amount":600000,"overpayAmount":0},{"key":"STORE_CREDIT","kind":"STORE_CREDIT","amount":100000,"overpayAmount":0},{"key":"STORE_CREDIT","kind":"STORE_CREDIT","amount":100000,"overpayAmount":0},{"key":"STORE_CREDIT","kind":"STORE_CREDIT","amount":100000,"overpayAmount":0},{"key":"STORE_CREDIT","kind":"STORE_CREDIT","amount":100000,"overpayAmount":0}]}
- برگشت: {"id":1,"total":500000,"refundMethod":"CASH","refundAmount":100000,"refundStoreCreditAmount":0,"voided":false}
- بارکدهای جانشین: [{"id":5,"amount":100000,"status":"ACTIVE","expiresAt":1795984199999},{"id":6,"amount":100000,"status":"ACTIVE","expiresAt":1795984199999},{"id":7,"amount":100000,"status":"ACTIVE","expiresAt":1795984199999},{"id":8,"amount":100000,"status":"ACTIVE","expiresAt":1795984199999}]
- اسناد حرکت نقد و checkpointها: {"cashMovements":[{"type":"RETURN_REFUND","amount":100000}],"events":[{"label":"baseline","expected":{"cash":0,"card":0,"refundCash":0,"refundCard":0},"actual":{"cash":0,"card":0,"refundCash":0,"refundCard":0},"raw":{"cash":0,"card":0,"refundCash":0,"refundCard":0},"blue":0,"expectedBlue":0,"stock":[{"variantId":1,"actual":10,"ledger":0},{"variantId":2,"actual":10,"ledger":0}],"credits":[{"id":1,"amount":100000,"usedAmount":0,"usedCount":0,"status":"ACTIVE"},{"id":2,"amount":100000,"usedAmount":0,"usedCount":0,"status":"ACTIVE"},{"id":3,"amount":100000,"usedAmount":0,"usedCount":0,"status":"ACTIVE"},{"id":4,"amount":100000,"usedAmount":0,"usedCount":0,"status":"ACTIVE"}]},{"label":"sale: 600k cash + 4×100k credit","expected":{"cash":600000,"card":0,"refundCash":0,"refundCard":0},"actual":{"cash":600000,"card":0,"refundCash":0,"refundCard":0},"raw":{"cash":600000,"card":0,"refundCash":0,"refundCard":0},"blue":600000,"expectedBlue":600000,"stock":[{"variantId":1,"actual":9,"ledger":-1},{"variantId":2,"actual":9,"ledger":-1}],"credits":[{"id":1,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":2,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":3,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":4,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"}]},{"label":"return: restore 400k source credit + refund 100k cash","expected":{"cash":600000,"card":0,"refundCash":100000,"refundCard":0},"actual":{"cash":600000,"card":0,"refundCash":100000,"refundCard":0},"raw":{"cash":600000,"card":0,"refundCash":100000,"refundCard":0},"blue":500000,"expectedBlue":500000,"stock":[{"variantId":1,"actual":10,"ledger":0},{"variantId":2,"actual":9,"ledger":-1}],"credits":[{"id":1,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":2,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":3,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"},{"id":4,"amount":100000,"usedAmount":100000,"usedCount":1,"status":"USED"}]}]}

**محدودیت:** این مورد فقط مسیر برگشت نقدیِ ۱۰۰٬۰۰۰ را تأیید می‌کند؛ کارت، کارت‌به‌کارت مدیر و صدور اعتبارِ بدون انقضا هنوز در سناریوهای جداگانه باید آزموده شوند. دیتابیس آزمایشی موقت بود و دادهٔ واقعی تغییر نکرد.
