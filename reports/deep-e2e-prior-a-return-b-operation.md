# برگشت/تعویض A پیش از تعویض/برگشت B

**نتیجه:** 3 پذیرفته؛ 1 رد؛ 0 رد همراه mutation؛ 0 خطای harness.
**DB:** SQLite موقت ایزوله (/tmp/mahak-prior-a-b-operation-CII4l5/isolated.db); هیچ DB واقعی یا stage استفاده نشد.
**فاکتور پایه:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ اعتبار ۵۰٬۰۰۰ فقط برای B و سه اعتبار ۵۰٬۰۰۰ فقط برای C/D؛ نقد=۸۰۰٬۰۰۰. A پشتوانهٔ پول واقعی دارد و بیرون از scope اعتبارهاست.
**چهار مسیر مستقل:** A برگشت نقدی→B تعویض؛ A برگشت نقدی→B برگشت؛ A→A1 تعویض→B تعویض؛ A→A1 تعویض→B برگشت. هر مسیر DB/shift مستقل دارد.

| مسیر | مرحلهٔ A | مرحلهٔ B | نتیجهٔ B |
|---|---|---|---|
| A-cash-return_then_B-exchange | انجام شد | پذیرفته شد | ACCEPTED |
| A-cash-return_then_B-return | انجام شد | پذیرفته شد | ACCEPTED |
| A-exchange_then_B-exchange | انجام شد | رد شد: برگشت قبلی #5 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد. | BLOCKED |
| A-exchange_then_B-return | انجام شد | پذیرفته شد | ACCEPTED |

## جزئیات
### A-cash-return_then_B-exchange — ACCEPTED
- **A first: cash refund 200,000**: پذیرفته شد; اعتبارهای صادرشده: []; سهم اعتبار منبع برگشتی: ۰
- **B second: B→B1 exchange**: پذیرفته شد; اعتبارهای صادرشده: [{"id":5,"code":"CRWMWGJ9","amount":20000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[2]"}]; سهم اعتبار منبع برگشتی: ۲۰٬۰۰۰

### A-cash-return_then_B-return — ACCEPTED
- **A first: cash refund 200,000**: پذیرفته شد; اعتبارهای صادرشده: []; سهم اعتبار منبع برگشتی: ۰
- **B second: full B return**: پذیرفته شد; اعتبارهای صادرشده: [{"id":10,"code":"EMQ2FY","amount":150000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":11,"code":"CRP9JCHY","amount":50000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[5]"}]; سهم اعتبار منبع برگشتی: ۵۰٬۰۰۰

### A-exchange_then_B-exchange — BLOCKED
- **A first: A→A1 (200,000→180,000)**: پذیرفته شد; اعتبارهای صادرشده: [{"id":16,"code":"ERWC3F","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع برگشتی: ۰
- **B second: B→B1 exchange**: رد شد; پیام: برگشت قبلی #5 سهم اعتبارِ قابل‌ردیابی ندارد؛ اعتبارهای باقی‌مانده محدود به scope «CATEGORY» هستند. مشخص نیست کدام سهم به کالای برگشتی تعلق دارد؛ اعتبار به کالای خارج از محدوده منتقل نمی‌شود و تعویض مستقیم متوقف شد. سابقهٔ اقلام و اعتبار را بررسی کنید؛ هیچ تغییری ثبت نشد.; بدون تغییرِ ردشده: true

### A-exchange_then_B-return — ACCEPTED
- **A first: A→A1 (200,000→180,000)**: پذیرفته شد; اعتبارهای صادرشده: [{"id":21,"code":"EGZ9QP","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع برگشتی: ۰
- **B second: full B return**: پذیرفته شد; اعتبارهای صادرشده: [{"id":22,"code":"EEXVE3","amount":150000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":23,"code":"CRELQHFH","amount":50000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[11]"}]; سهم اعتبار منبع برگشتی: ۵۰٬۰۰۰


## ایمنی
- فقط service-layer روی SQLite موقت؛ در هیچ سناریویی چک یا مسیر نسیه/تسویهٔ نسیه اجرا نشد.
- production source، DB واقعی و stage تغییر نکردند.
