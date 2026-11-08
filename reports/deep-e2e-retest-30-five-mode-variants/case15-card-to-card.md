# بازآزمون ۳۰ جریان — حالت برگشت CARD_TO_CARD

- جریان مرجع: 15 — صفر/یک/چهار کد و زنجیرهٔ نسل دوم
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-15-card_to_card-X98Nnz/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 0 تخفیف، 200000 خالص.
- قلم/اقلام برگشتی خالص: 200000.
- نتیجهٔ مالی نهایی: {"cash":200000,"card":0,"refundCash":0,"refundCard":0,"blue":200000} (expected); {"cash":200000,"card":0,"refundCash":0,"refundCard":0} (actual); blue=200000.
- نتیجهٔ برگشت: {"id":1,"total":200000,"refundMethod":"CARD_TO_CARD","refundAmount":200000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
