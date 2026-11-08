# بازآزمون ۳۰ جریان — حالت برگشت NONE

- جریان مرجع: 27 — بازگشت به اعتبار زنده بدون successor
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-27-none-unUpop/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 20000 تخفیف، 180000 خالص.
- قلم/اقلام برگشتی خالص: 180000.
- نتیجهٔ مالی نهایی: {"cash":180000,"card":0,"refundCash":0,"refundCard":0,"blue":180000} (expected); {"cash":180000,"card":0,"refundCash":0,"refundCard":0} (actual); blue=180000.
- نتیجهٔ برگشت: {"id":1,"total":180000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[{"id":1,"amount":180000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"delivery":{"status":"PENDING","handoffType":"CUSTOMER","deliveredAt":null}}]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
