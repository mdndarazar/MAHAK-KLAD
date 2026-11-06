# بازآزمون ۳۰ جریان — حالت برگشت CASH

- جریان مرجع: 27 — بازگشت به اعتبار زنده بدون successor
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-27-cash-2F6eF5/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 20000 تخفیف، 180000 خالص.
- قلم/اقلام برگشتی خالص: 180000.
- نتیجهٔ مالی نهایی: {"cash":180000,"card":0,"refundCash":180000,"refundCard":0,"blue":0} (expected); {"cash":180000,"card":0,"refundCash":180000,"refundCard":0} (actual); blue=0.
- نتیجهٔ برگشت: {"id":1,"total":180000,"refundMethod":"CASH","refundAmount":180000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
