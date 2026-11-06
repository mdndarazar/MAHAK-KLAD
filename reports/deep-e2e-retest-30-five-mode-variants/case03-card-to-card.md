# بازآزمون ۳۰ جریان — حالت برگشت CARD_TO_CARD

- جریان مرجع: 03 — فروش POS و برگشت POS
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-03-card_to_card-Xo8sKe/isolated.db)
- فاکتور نمونه: 100000 ناخالص، 0 تخفیف، 100000 خالص.
- قلم/اقلام برگشتی خالص: 100000.
- نتیجهٔ مالی نهایی: {"cash":100000,"card":0,"refundCash":0,"refundCard":0,"blue":100000} (expected); {"cash":100000,"card":0,"refundCash":0,"refundCard":0} (actual); blue=100000.
- نتیجهٔ برگشت: {"id":1,"total":100000,"refundMethod":"CARD_TO_CARD","refundAmount":100000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
