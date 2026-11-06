# بازآزمون ۳۰ جریان — حالت برگشت CARD_TO_CARD

- جریان مرجع: 09 — چهار اعتبار و برگشت چندمنبعی
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-09-card_to_card-xFtjWQ/isolated.db)
- فاکتور نمونه: 400000 ناخالص، 40000 تخفیف، 360000 خالص.
- قلم/اقلام برگشتی خالص: 180000.
- نتیجهٔ مالی نهایی: {"cash":360000,"card":0,"refundCash":0,"refundCard":0,"blue":360000} (expected); {"cash":360000,"card":0,"refundCash":0,"refundCard":0} (actual); blue=360000.
- نتیجهٔ برگشت: {"id":1,"total":180000,"refundMethod":"CARD_TO_CARD","refundAmount":180000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
