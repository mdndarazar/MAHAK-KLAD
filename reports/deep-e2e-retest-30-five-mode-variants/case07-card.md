# بازآزمون ۳۰ جریان — حالت برگشت CARD

- جریان مرجع: 07 — فروش فقط با اعتبار و ماندهٔ کد
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-07-card-9QYhU5/isolated.db)
- فاکتور نمونه: 100000 ناخالص، 0 تخفیف، 100000 خالص.
- قلم/اقلام برگشتی خالص: 100000.
- نتیجهٔ مالی نهایی: {"cash":0,"card":100000,"refundCash":0,"refundCard":100000,"blue":0} (expected); {"cash":0,"card":100000,"refundCash":0,"refundCard":100000} (actual); blue=0.
- نتیجهٔ برگشت: {"id":1,"total":100000,"refundMethod":"CARD","refundAmount":100000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
