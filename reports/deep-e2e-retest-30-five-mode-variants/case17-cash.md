# بازآزمون ۳۰ جریان — حالت برگشت CASH

- جریان مرجع: 17 — برگشت جزئی و سپس تعویض
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-17-cash-r1a0OI/isolated.db)
- فاکتور نمونه: 300000 ناخالص، 30000 تخفیف، 270000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":135000,"card":135000,"refundCash":90000,"refundCard":0,"blue":180000} (expected); {"cash":135000,"card":135000,"refundCash":90000,"refundCard":0} (actual); blue=180000.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"CASH","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
