# آیا تعویض C یا D پس از عملیات A هم رد می‌شود؟

**نتیجه:** 6/8 زنجیره کامل؛ 2 رد؛ 0 خطای harness.
**DB:** SQLite موقت و ایزوله (/tmp/mahak-prior-a-cd-exchange-9pOnSm/isolated.db).
**فاکتور:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ کل اعتبار ۲۰۰٬۰۰۰: B-only=۵۰٬۰۰۰، C-only=۱۰۰٬۰۰۰، D-only=۵۰٬۰۰۰؛ پرداخت نقدی=۸۰۰٬۰۰۰. هر اعتبار فقط به دستهٔ قلم خودش محدود است. A بیرون از scope همهٔ اعتبارهاست.
**عملیات هدف:** C→C1 و D→D1 هرکدام با اختلاف ۲۰٬۰۰۰؛ در هر مسیر A یا برگشت نقدی ۲۰۰٬۰۰۰ است یا تعویض A→A1 با اختلاف ۲۰٬۰۰۰. هر مسیر پایگاه و شیفت جدا دارد.

| ترتیب و مسیر | گام اول | گام دوم | نتیجه |
|---|---|---|---|
| A_FIRST-RETURN-C-EXCHANGE | PASS | PASS | ACCEPTED |
| TARGET_FIRST-RETURN-C-EXCHANGE | PASS | PASS | ACCEPTED |
| A_FIRST-EXCHANGE-C-EXCHANGE | PASS | BLOCKED: برگشت قبلی #5 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد. | BLOCKED |
| TARGET_FIRST-EXCHANGE-C-EXCHANGE | PASS | PASS | ACCEPTED |
| A_FIRST-RETURN-D-EXCHANGE | PASS | PASS | ACCEPTED |
| TARGET_FIRST-RETURN-D-EXCHANGE | PASS | PASS | ACCEPTED |
| A_FIRST-EXCHANGE-D-EXCHANGE | PASS | BLOCKED: برگشت قبلی #12 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد. | BLOCKED |
| TARGET_FIRST-EXCHANGE-D-EXCHANGE | PASS | PASS | ACCEPTED |

## جزئیات تطبیق
### A_FIRST-RETURN-C-EXCHANGE — ACCEPTED
- **A cash return 200,000**: پذیرفته شد; اعتبار صادرشده: []
- **C→C1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":4,"code":"CRDKL2G6","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[3]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}

### TARGET_FIRST-RETURN-C-EXCHANGE — ACCEPTED
- **C→C1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":8,"code":"CR2N4TQL","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[7]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}
- **A cash return 200,000**: پذیرفته شد; اعتبار صادرشده: []

### A_FIRST-EXCHANGE-C-EXCHANGE — BLOCKED
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبار صادرشده: [{"id":12,"code":"EJNFE4","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]
- **C→C1 exchange**: رد شد; پیام: برگشت قبلی #5 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد.; بدون تغییر پس از رد: true

### TARGET_FIRST-EXCHANGE-C-EXCHANGE — ACCEPTED
- **C→C1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":16,"code":"CR9766ZH","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[15]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبار صادرشده: [{"id":17,"code":"ELM4XX","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]

### A_FIRST-RETURN-D-EXCHANGE — ACCEPTED
- **A cash return 200,000**: پذیرفته شد; اعتبار صادرشده: []
- **D→D1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":21,"code":"CRRCU7VY","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[20]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}

### TARGET_FIRST-RETURN-D-EXCHANGE — ACCEPTED
- **D→D1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":25,"code":"CRFEUUAW","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[24]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}
- **A cash return 200,000**: پذیرفته شد; اعتبار صادرشده: []

### A_FIRST-EXCHANGE-D-EXCHANGE — BLOCKED
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبار صادرشده: [{"id":29,"code":"EXD4PH","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]
- **D→D1 exchange**: رد شد; پیام: برگشت قبلی #12 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد.; بدون تغییر پس از رد: true

### TARGET_FIRST-EXCHANGE-D-EXCHANGE — ACCEPTED
- **D→D1 exchange**: پذیرفته شد; اعتبار صادرشده: [{"id":33,"code":"CRTGUK68","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[32]"}]; بررسی منبع: {"expectedDifference":-20000,"actualDifference":-20000,"expectedSuccessor":20000,"actualIssued":20000,"expectedSourceExpiry":1795984199999,"exactSourceExpiryAmount":20000,"oldSourceStillUsed":true}
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبار صادرشده: [{"id":34,"code":"EET4NY","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]


## ایمنی
- فقط SQLite آزمایشی موقت؛ هیچ production code یا DB واقعی تغییر نکرد.
- هیچ چک یا عملیات نسیه/تسویهٔ نسیه اجرا نشد.
