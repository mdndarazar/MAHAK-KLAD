# بازآزمون ۳۰ جریان — حالت برگشت CASH

- جریان مرجع: 29 — دو منبع USED و دو successor
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-29-cash-AtB3Wt/isolated.db)
- فاکتور نمونه: 200000 ناخالص، 20000 تخفیف، 180000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":90000,"card":90000,"refundCash":90000,"refundCard":0,"blue":90000} (expected); {"cash":90000,"card":90000,"refundCash":90000,"refundCard":0} (actual); blue=90000.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"CASH","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
