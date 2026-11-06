# زنجیرهٔ تعویض B→B1، سپس D→D1، سپس A→A1

**نتیجه:** 3/3 زنجیره کامل؛ 0 متوقف؛ 0 مغایرت؛ 0 خطای harness.
**DB:** SQLite موقت ایزوله (/tmp/mahak-restricted-b-d-a-chain-FzpIrI/isolated.db)؛ هیچ DB زنده یا stage استفاده نشد.
**فروش پایه:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع ۱٬۰۰۰٬۰۰۰. اعتبارها: B-only=۵۰٬۰۰۰، D-only=۵۰٬۰۰۰، دو اعتبار C-only=۵۰٬۰۰۰ هرکدام؛ نقد=۸۰۰٬۰۰۰. هر محدودیت با دستهٔ دقیق همان قلم تعریف شد.
**ترتیب هر زنجیره:** B→B1 نخست؛ سپس D→D1؛ سپس A→A1. اختلاف D و A هرکدام ۲۰٬۰۰۰. برای B سه شاخه اجرا شد: معتبر/۲۰هزار، منقضی/۲۰هزار، منقضی/۶۰هزار.

| حالت | B→B1 | D→D1 (دوم) | A→A1 (سوم) | زنجیره |
|---|---|---|---|---|
| B-valid-diff20 | PASS | PASS | PASS | PASS |
| B-expired-diff20 | PASS | PASS | PASS | PASS |
| B-expired-diff60 | PASS | PASS | PASS | PASS |

## جزئیات مرحله‌ها
### B-valid-diff20 — PASS
- منبع B منقضی: false; اختلاف B: ۲۰٬۰۰۰; انتظار اعتبار B: ۲۰٬۰۰۰.
- **B**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":1795984199999,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **D**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":1795984199999,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **A**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":null,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}

### B-expired-diff20 — PASS
- منبع B منقضی: true; اختلاف B: ۲۰٬۰۰۰; انتظار اعتبار B: ۰.
- **B**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":30000,"actualDifference":30000,"expectedCredit":0,"actualCredit":0,"expectedExpiry":null,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":830000,"actualBlue":830000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **D**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":1795984199999,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":830000,"actualBlue":830000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **A**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":null,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":830000,"actualBlue":830000,"expiredShareClosed":true,"expiredSharePrinted":true}

### B-expired-diff60 — PASS
- منبع B منقضی: true; اختلاف B: ۶۰٬۰۰۰; انتظار اعتبار B: ۱۰٬۰۰۰.
- **B**: PASS؛ اختلاف ۶۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-10000,"actualDifference":-10000,"expectedCredit":10000,"actualCredit":10000,"expectedExpiry":null,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **D**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":1795984199999,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}
- **A**: PASS؛ اختلاف ۲۰٬۰۰۰ ؛ تطبیق: {"expectedEffectiveDifference":-20000,"actualDifference":-20000,"expectedCredit":20000,"actualCredit":20000,"expectedExpiry":null,"expiryMatches":true,"oldSourceStillUsed":true,"noUnbackedRefund":true,"positiveCashCorrect":true,"expectedBlue":800000,"actualBlue":800000,"expiredShareClosed":true,"expiredSharePrinted":true}


## محدودهٔ ایمنی
- فقط SQLite موقت و service-layer؛ موارد انقضا صرفاً در DB آزمایشی با تغییر تاریخ خام شبیه‌سازی شدند.
- هیچ چک، فروش نسیه، دریافت نسیه، تسویهٔ نسیه، production source یا DB واقعی استفاده/تغییر نشد.
