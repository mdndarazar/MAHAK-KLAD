# بازآزمون ۳۰ جریان — حالت برگشت NONE

- جریان مرجع: 07 — فروش فقط با اعتبار و ماندهٔ کد
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-07-none-NKc6lL/isolated.db)
- فاکتور نمونه: 100000 ناخالص، 0 تخفیف، 100000 خالص.
- قلم/اقلام برگشتی خالص: 100000.
- نتیجهٔ مالی نهایی: {"cash":0,"card":100000,"refundCash":0,"refundCard":0,"blue":100000} (expected); {"cash":0,"card":100000,"refundCash":0,"refundCard":0} (actual); blue=100000.
- نتیجهٔ برگشت: {"id":1,"total":100000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[{"id":1,"amount":100000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"delivery":{"status":"PENDING","handoffType":"CUSTOMER","deliveredAt":null}}]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
