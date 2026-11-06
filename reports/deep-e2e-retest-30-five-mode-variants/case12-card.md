# بازآزمون ۳۰ جریان — حالت برگشت CARD

- جریان مرجع: 12 — برگشت خرید چهاراعتباری
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-12-card-GTiiHO/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 10000 تخفیف، 190000 خالص.
- قلم/اقلام برگشتی خالص: 190000.
- نتیجهٔ مالی نهایی: {"cash":190000,"card":0,"refundCash":0,"refundCard":190000,"blue":0} (expected); {"cash":190000,"card":0,"refundCash":0,"refundCard":190000} (actual); blue=0.
- نتیجهٔ برگشت: {"id":1,"total":190000,"refundMethod":"CARD","refundAmount":190000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
