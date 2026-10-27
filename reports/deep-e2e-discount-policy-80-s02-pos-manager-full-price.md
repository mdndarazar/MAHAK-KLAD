# طرح ۱۳ موردی — سناریوی تخفیف D80-S02 / POS tender / MANAGER_FULL_PRICE

**وضعیت اجرا:** PASS; DB SQLite موقت و ایزوله.

فاکتور تک‌قلمی: قیمت ناخالص ۱۰۰٬۰۰۰؛ تخفیف ردیف ۱۰٬۰۰۰؛ خالص ۹۰٬۰۰۰؛ tender=POS. انتظار policy: مبلغ برگشت/تسویه/اعتبار نباید سهم تخفیف ۱۰٬۰۰۰ را به مشتری برگرداند.

**برگشت ثبت‌شده:** {"error":"بازپرداخت مبلغ کاملِ بدون کسر تخفیف (۱۰۰٬۰۰۰ ریال) از فاکتور ۱ ممکن نیست: از پول واقعاً دریافت‌شده فقط ۹۰٬۰۰۰ ریال مانده است.\\nتایید مدیر فقط کسر تخفیف را برمی‌دارد؛ بیشتر از پولی که واقعاً دریافت شده از صندوق/کارت پرداخت نمی‌شود.","mutationFree":true}
**ارزیابی policy:** {"expectedNetReturnRight":90000,"actualCustomerValue":0,"extraDiscountRefunded":0,"deviations":[],"note":"Manager full-price override was refused because only the discounted 90,000 was actually received."}
**انحراف‌ها:** []

**دفتر نهایی:** expected={"cash":0,"card":90000,"refundCash":0,"refundCard":0,"blue":90000}; actual={"cash":0,"card":90000,"refundCash":0,"refundCard":0}; blue=90000; stock={"actual":9,"ledger":-1}; invoices=1; returns=0; payments=1; cashMovements=0; credits=0; checks=0.

برای CARD_TO_CARD، پاسخ manager-paid در هارنس تست ثبت می‌شود؛ انتقال بانکی واقعی انجام نمی‌شود. برای NONE/STORE_CREDIT، شناسه، مبلغ، وضعیت و انقضاهای credit در JSON نگهداری می‌شوند.
فقط تست؛ هیچ production source، DB واقعی، stage یا reset تغییر نکرده.
