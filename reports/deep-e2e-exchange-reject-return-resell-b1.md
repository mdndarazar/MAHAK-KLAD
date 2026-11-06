# مسیر جایگزین پس از رد تعویض B: برگشت B و فروش B1 از POS

**نتیجه:** 1/4 مسیر PASS؛ 0 مغایرت؛ 3 خطای harness.
**DB:** SQLite موقت ایزوله (/tmp/mahak-b-exchange-return-resell-TNHouo/isolated.db).
**قاعدهٔ مورد انتظار:** برگشت کامل B باید دو کد تازه بسازد: ۵۰٬۰۰۰ successor منبع B با همان انقضا و کد قبلی `USED`؛ ۱۵۰٬۰۰۰ پشتوانهٔ پول واقعی به اعتبار جداگانهٔ بدون انقضا.

| سناریوی POS | رد تعویض مستقیم | برگشت B: 50k+150k | فروش B1 | 50k بارکد باقی‌ماند؟ | باقی‌مانده کد 150k | نتیجه |
|---|---|---|---|---|---:|---|
| A-cash-return_B1-180_money150-plus-cash30_keep50 | پذیرفته | ناموفق | ناموفق | — | — | HARNESS_ERROR |
| A-cash-return_B1-180_use-both_keep20 | پذیرفته | ناموفق | ناموفق | — | — | HARNESS_ERROR |
| A-cash-return_B1-140_money140_keep50-plus10 | پذیرفته | ناموفق | ناموفق | — | — | HARNESS_ERROR |
| A-exchange_B1-180_money150-plus-cash30_keep50 | رد؛ بدون تغییر=true | 150000+50000 | 180000؛ credit=150000؛ نقد=30000 | ACTIVE | 0 | PASS |

## جزئیات
### A-cash-return_B1-180_money150-plus-cash30_keep50 — HARNESS_ERROR
- **prior A cash return 200,000**: انجام شد
- **direct B→B1 exchange 180000**: انجام شد
- خطای harness: Expected the direct B exchange to hit the reproduced prior-A gate; it unexpectedly succeeded, so stop this workaround branch for review.
### A-cash-return_B1-180_use-both_keep20 — HARNESS_ERROR
- **prior A cash return 200,000**: انجام شد
- **direct B→B1 exchange 180000**: انجام شد
- خطای harness: Expected the direct B exchange to hit the reproduced prior-A gate; it unexpectedly succeeded, so stop this workaround branch for review.
### A-cash-return_B1-140_money140_keep50-plus10 — HARNESS_ERROR
- **prior A cash return 200,000**: انجام شد
- **direct B→B1 exchange 140000**: انجام شد
- خطای harness: Expected the direct B exchange to hit the reproduced prior-A gate; it unexpectedly succeeded, so stop this workaround branch for review.
### A-exchange_B1-180_money150-plus-cash30_keep50 — PASS
- **prior A→A1 exchange 200,000→180,000**: انجام شد; کدها: [{"id":21,"code":"EMGWLR","amount":20000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"expiresAtJalali":null,"source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null,"returnId":7}]
- **direct B→B1 exchange 180000**: رد شد; خطا: برگشت قبلی #7 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد.; رد بدون تغییر: true
- **fallback: full B return to store credit**: انجام شد; کدها: [{"id":22,"code":"EP64KQ","amount":150000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"expiresAtJalali":null,"source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null,"returnId":8},{"id":23,"code":"CRPGXFJ8","amount":50000,"usedAmount":0,"status":"ACTIVE","expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[11]","returnId":8}]
- **POS sale B1=180000; use money-backed code only + cash 30000**: انجام شد; تطبیق: {"invoiceTotal":true,"creditApplied":true,"paidTotal":true,"source50KeptAsExpected":true,"moneyCodeRemainderCorrect":true,"oldOriginalSourceRemainsUsed":true,"stockAndInvoiceCommitted":true}; مصرف بارکدها: [{"creditId":22,"amount":150000,"remainderAfter":0}]


## محدوده
- فقط service-layer و SQLite موقت؛ فروش فقط به‌عنوان POS service-layer شبیه‌سازی شد، چاپ/تحویل فیزیکی اجرا نشد.
- هیچ چک، فروش نسیه، دریافت نسیه، تسویهٔ نسیه، production code یا DB واقعی استفاده/تغییر نشد.
