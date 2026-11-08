# بازآزمون ۳۰ جریان — حالت برگشت CARD_TO_CARD

- جریان مرجع: 18 — بازگشت سهم به کد زندهٔ نیمه‌مصرف
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-18-card_to_card-wMc4Xb/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 10000 تخفیف، 190000 خالص.
- قلم/اقلام برگشتی خالص: 190000.
- نتیجهٔ مالی نهایی: {"cash":190000,"card":0,"refundCash":0,"refundCard":0,"blue":190000} (expected); {"cash":190000,"card":0,"refundCash":0,"refundCard":0} (actual); blue=190000.
- نتیجهٔ برگشت: {"id":1,"total":190000,"refundMethod":"CARD_TO_CARD","refundAmount":190000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
