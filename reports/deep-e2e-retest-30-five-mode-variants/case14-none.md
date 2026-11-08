# بازآزمون ۳۰ جریان — حالت برگشت NONE

- جریان مرجع: 14 — چندبارکدی با روش‌های تسویه
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-14-none-JZvSrl/isolated.db)
- فاکتور نمونه: 300000 ناخالص، 30000 تخفیف، 270000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":135000,"card":135000,"refundCash":0,"refundCard":0,"blue":270000} (expected); {"cash":135000,"card":135000,"refundCash":0,"refundCard":0} (actual); blue=270000.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[{"id":1,"amount":90000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"delivery":{"status":"PENDING","handoffType":"CUSTOMER","deliveredAt":null}}]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
