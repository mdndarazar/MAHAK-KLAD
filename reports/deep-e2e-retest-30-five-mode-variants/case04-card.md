# بازآزمون ۳۰ جریان — حالت برگشت CARD

- جریان مرجع: 04 — تعویض کاهشی با اعتبار
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-04-card-fIhRzg/isolated.db)
- فاکتور نمونه: 100000 ناخالص، 10000 تخفیف، 90000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":0,"card":90000,"refundCash":0,"refundCard":90000,"blue":0} (expected); {"cash":0,"card":90000,"refundCash":0,"refundCard":90000} (actual); blue=0.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"CARD","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
