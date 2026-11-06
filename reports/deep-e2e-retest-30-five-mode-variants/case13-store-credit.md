# بازآزمون ۳۰ جریان — حالت برگشت STORE_CREDIT

- جریان مرجع: 13 — تعویض با فاکتور دوم مشتری
- وضعیت: **PASS**
- پایگاه داده: SQLite موقت ایزوله (/tmp/mahak-retest30-13-store_credit-RipboA/isolated.db)
- فاکتور نمونه: 100000 ناخالص، 10000 تخفیف، 90000 خالص.
- قلم/اقلام برگشتی خالص: 90000.
- نتیجهٔ مالی نهایی: {"cash":0,"card":90000,"refundCash":0,"refundCard":0,"blue":90000} (expected); {"cash":0,"card":90000,"refundCash":0,"refundCard":0} (actual); blue=90000.
- نتیجهٔ برگشت: {"id":1,"total":90000,"refundMethod":"STORE_CREDIT","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"exchangeInvoiceId":null,"credits":[{"id":1,"amount":90000,"usedAmount":0,"status":"ACTIVE","expiresAt":null,"delivery":{"status":"PENDING","handoffType":"CUSTOMER","deliveredAt":null}}]}

این اجرا یک شاخهٔ تکمیلیِ تسویه/برگشت با شکل فاکتور متناسب با جریان مرجع است؛ زنجیرهٔ کامل اصلی همان‌طور که در گزارش ۳۰تایی ثبت شده، جداگانه نگهداری می‌شود.
این تست service-layer است؛ کارت‌به‌کارت فقط در هارنس manager-paid می‌شود. چاپگر، POS واقعی، DB زنده و staging استفاده نشده‌اند.
فقط تست/گزارش تغییر کرده است؛ منطق production تغییر نکرده.
