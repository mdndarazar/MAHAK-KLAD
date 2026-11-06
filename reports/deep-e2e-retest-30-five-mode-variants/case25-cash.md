# بازآزمون ۳۰ جریان — حالت برگشت CASH

- جریان مرجع: 25 — زنجیرهٔ چندقلمی A، B، C+D و B2
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-25-cash-xG8lni/isolated.db)
- فاکتور نمونه: 400000 ناخالص، 40000 تخفیف، 360000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":0,"card":360000,"refundCash":90000,"refundCard":0,"blue":270000} (expected); {"cash":0,"card":360000,"refundCash":90000,"refundCard":0} (actual); blue=270000.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"CASH","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
