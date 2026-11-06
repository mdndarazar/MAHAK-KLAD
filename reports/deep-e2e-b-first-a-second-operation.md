# ابتدا عملیات B، سپس برگشت/تعویض A

**نتیجه:** 4/4 زنجیره کامل؛ 0 متوقف؛ 0 خطای harness.
**DB:** SQLite موقت (/tmp/mahak-b-first-a-second-f4HKuO/isolated.db)؛ فقط محیط آزمایشی.
**فاکتور:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ منبع B محدود به B و سه منبع دیگر محدود به C/D؛ پرداخت نقدی ۸۰۰٬۰۰۰. ترتیب آزمایش: عملیات B اول، سپس عملیات A.

| مسیر | عملیات B اول | عملیات A دوم | نتیجه |
|---|---|---|---|
| B-exchange_then_A-cash-return | PASS | PASS | ACCEPTED |
| B-exchange_then_A-exchange | PASS | PASS | ACCEPTED |
| B-return_then_A-cash-return | PASS | PASS | ACCEPTED |
| B-return_then_A-exchange | PASS | PASS | ACCEPTED |

## جزئیات
### B-exchange_then_A-cash-return — ACCEPTED
- **B first: B→B1 exchange**: پذیرفته شد; اعتبارهای صادرشده: [{"id":5,"code":"CRABP6YW","amount":20000,"expiresAt":1795984199999,"status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[2]"}]; سهم اعتبار منبع برگشتی: ۲۰٬۰۰۰
- **A second: cash return 200,000**: پذیرفته شد; اعتبارهای صادرشده: []; سهم اعتبار منبع برگشتی: ۰

### B-exchange_then_A-exchange — ACCEPTED
- **B first: B→B1 exchange**: پذیرفته شد; اعتبارهای صادرشده: [{"id":10,"code":"CRGBJ9FD","amount":20000,"expiresAt":1795984199999,"status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[5]"}]; سهم اعتبار منبع برگشتی: ۲۰٬۰۰۰
- **A second: A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبارهای صادرشده: [{"id":11,"code":"EWT7KL","amount":20000,"expiresAt":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع برگشتی: ۰

### B-return_then_A-cash-return — ACCEPTED
- **B first: full B return**: پذیرفته شد; اعتبارهای صادرشده: [{"id":16,"code":"ENM63X","amount":150000,"expiresAt":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":17,"code":"CRF9NG9R","amount":50000,"expiresAt":1795984199999,"status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[8]"}]; سهم اعتبار منبع برگشتی: ۵۰٬۰۰۰
- **A second: cash return 200,000**: پذیرفته شد; اعتبارهای صادرشده: []; سهم اعتبار منبع برگشتی: ۰

### B-return_then_A-exchange — ACCEPTED
- **B first: full B return**: پذیرفته شد; اعتبارهای صادرشده: [{"id":22,"code":"EVMDTR","amount":150000,"expiresAt":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null},{"id":23,"code":"CRLYY46H","amount":50000,"expiresAt":1795984199999,"status":"ACTIVE","source":"MANUAL","restrictScope":"CATEGORY","restrictCategoryIdsJson":"[11]"}]; سهم اعتبار منبع برگشتی: ۵۰٬۰۰۰
- **A second: A→A1 exchange 200,000→180,000**: پذیرفته شد; اعتبارهای صادرشده: [{"id":24,"code":"E9WJAR","amount":20000,"expiresAt":null,"status":"ACTIVE","source":"EXCHANGE","restrictScope":"ALL","restrictCategoryIdsJson":null}]; سهم اعتبار منبع برگشتی: ۰


## ایمنی
- SQLite موقت ایزوله؛ هیچ production source، DB واقعی یا stage تغییر نکرد.
- هیچ چک یا عملیات نسیه/تسویهٔ نسیه اجرا نشد.
