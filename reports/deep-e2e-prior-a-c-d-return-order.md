# برگشت کامل C/D پس از برگشت یا تعویض A

**نتیجه:** 4/4 برگشت پذیرفته شد؛ 0 رد؛ 0 خطای harness.
**DB:** SQLite موقت ایزوله (/tmp/mahak-prior-a-cd-return-thBlpA/isolated.db).
**منابع دقیق:** B-only=۵۰٬۰۰۰، C-only=۱۰۰٬۰۰۰، D-only=۵۰٬۰۰۰؛ پرداخت نقدی=۸۰۰٬۰۰۰. هر مبلغ اعتباری فقط به دستهٔ خودش محدود است.

| مسیر | برگشت/تعویض A | برگشت کامل C/D | نتیجه |
|---|---|---|---|
| A-RETURN-then-C-RETURN | PASS | PASS | ACCEPTED |
| A-EXCHANGE-then-C-RETURN | PASS | PASS | ACCEPTED |
| A-RETURN-then-D-RETURN | PASS | PASS | ACCEPTED |
| A-EXCHANGE-then-D-RETURN | PASS | PASS | ACCEPTED |

## جزئیات
### A-RETURN-then-C-RETURN — ACCEPTED
- **A cash return 200,000**: پذیرفته شد; اعتبارها: []; سهم اعتبار منبع: ۰
- **full C return as store credit**: پذیرفته شد; اعتبارها: [{"id":4,"code":"ETTQ6A","amount":200000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":5,"code":"CRU2HVCY","amount":100000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[3]"}]; سهم اعتبار منبع: ۱۰۰٬۰۰۰

### A-EXCHANGE-then-C-RETURN — ACCEPTED
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبارها: [{"id":9,"code":"EMPF9L","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع: ۰
- **full C return as store credit**: پذیرفته شد; اعتبارها: [{"id":10,"code":"EG8MPE","amount":200000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":11,"code":"CRAWEREM","amount":100000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[7]"}]; سهم اعتبار منبع: ۱۰۰٬۰۰۰

### A-RETURN-then-D-RETURN — ACCEPTED
- **A cash return 200,000**: پذیرفته شد; اعتبارها: []; سهم اعتبار منبع: ۰
- **full D return as store credit**: پذیرفته شد; اعتبارها: [{"id":15,"code":"EW8XGP","amount":250000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":16,"code":"CRCLZUKX","amount":50000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[12]"}]; سهم اعتبار منبع: ۵۰٬۰۰۰

### A-EXCHANGE-then-D-RETURN — ACCEPTED
- **A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبارها: [{"id":20,"code":"EBDQ4T","amount":20000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع: ۰
- **full D return as store credit**: پذیرفته شد; اعتبارها: [{"id":21,"code":"EYC2V9","amount":250000,"expiresAt":null,"expiresAtJalali":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":22,"code":"CRD64Q4W","amount":50000,"expiresAt":1795984199999,"expiresAtJalali":"1405/09/08","status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[16]"}]; سهم اعتبار منبع: ۵۰٬۰۰۰


## ایمنی
- فقط DB آزمایشی موقت؛ هیچ چک یا مسیر نسیه اجرا نشد.
- production source و DB واقعی تغییر نکردند.
