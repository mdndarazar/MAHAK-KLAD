# طرح ۱۳ موردی — سناریوی تخفیف D80-S02 / POS tender / CARD_TO_CARD

**وضعیت اجرا:** PASS; DB SQLite موقت و ایزوله.

فاکتور تک‌قلمی: قیمت ناخالص ۱۰۰٬۰۰۰؛ تخفیف ردیف ۱۰٬۰۰۰؛ خالص ۹۰٬۰۰۰؛ tender=POS. انتظار policy: مبلغ برگشت/تسویه/اعتبار نباید سهم تخفیف ۱۰٬۰۰۰ را به مشتری برگرداند.

**برگشت ثبت‌شده:** {"id":1,"total":90000,"refundMethod":"CARD_TO_CARD","refundAmount":90000,"refundStoreCreditAmount":0,"exchangeSettlement":null,"returnedItems":[{"id":1,"returnId":1,"saleItemId":1,"variantId":1,"variantName":null,"variantCode":null,"qty":1,"unitPrice":100000,"lineTotal":90000,"removedFromStock":0,"restockedQty":0}],"createdCredits":[],"sourceCredits":[]}
**ارزیابی policy:** {"expectedNetReturnRight":90000,"recordedReturnValue":90000,"actualCustomerValue":90000,"deviations":[]}
**انحراف‌ها:** []

**دفتر نهایی:** expected={"cash":0,"card":90000,"refundCash":0,"refundCard":0,"blue":90000}; actual={"cash":0,"card":90000,"refundCash":0,"refundCard":0}; blue=90000; stock={"actual":10,"ledger":0}; invoices=1; returns=1; payments=1; cashMovements=0; credits=0; checks=0.

برای CARD_TO_CARD، پاسخ manager-paid در هارنس تست ثبت می‌شود؛ انتقال بانکی واقعی انجام نمی‌شود. برای NONE/STORE_CREDIT، شناسه، مبلغ، وضعیت و انقضاهای credit در JSON نگهداری می‌شوند.
فقط تست؛ هیچ production source، DB واقعی، stage یا reset تغییر نکرده.
