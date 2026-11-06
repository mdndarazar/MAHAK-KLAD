# زنجیرهٔ تخفیف فاکتور با اعتبار ALL و پرداخت نقدی

**نتیجهٔ بازآزمایی:** PASS_WITH_LEGACY_ORACLE_MISMATCH. تطبیق‌های مالی مستقل: 9/9.
**تطبیق با فرض‌های قدیمی این تست:** 15/21; فرض‌های ناسازگار: firstSurplusIsSourceCreditNotCash، secondReplacementReturnBlockedWithTraceabilityError، rejectedB1ReturnCreatedNoDocument، only500kOfCreditReturnRecordedAtRoot، reconstructionOverstatesCashRemovalBy1_5m، reconstructionLeaves7_5mInsteadOf9mCash.
**DB:** SQLite موقت ایزوله (/tmp/mahak-discounted-invoice-mixed-credit-chain-K6XME3/isolated.db); دیتابیس واقعی و staging استفاده نشد.

## جریان اجراشده
- فروش اصلی: دو قلم ناخالص ۱۰٬۰۰۰٬۰۰۰ + ۱۰٬۰۰۰٬۰۰۰؛ تخفیف فاکتور ۲٬۰۰۰٬۰۰۰؛ فاکتور خالص ۱۸٬۰۰۰٬۰۰۰ با ۲٬۰۰۰٬۰۰۰ اعتبار ALL و ۱۶٬۰۰۰٬۰۰۰ نقد.
- A با ارزش خالص ۹٬۰۰۰٬۰۰۰ با A1 به مبلغ ۸٬۵۰۰٬۰۰۰ تعویض شد؛ اختلاف ‎−۵۰۰٬۰۰۰. برگشت نقدی ثبت‌شده ۰ و سهم اعتبار بازگشته به منبع/جانشین ۵۰۰٬۰۰۰.
- B با ارزش خالص ۹٬۰۰۰٬۰۰۰ با B1 به مبلغ ۹٬۵۰۰٬۰۰۰ تعویض شد؛ مشتری ۵۰۰٬۰۰۰ نقد پرداخت کرد.
- A1 برگشت خورد: ۸٬۵۰۰٬۰۰۰؛ نقد ۷٬۰۰۰٬۰۰۰ و سهم منبع اعتباری ۱٬۵۰۰٬۰۰۰.
- B1 نیز پذیرفته شد و برگشت خورد: ۹٬۵۰۰٬۰۰۰؛ نقد برگشتی ۹٬۵۰۰٬۰۰۰. پاسخ رد/توقف برای این برگشت ثبت نشد.
- پس از برگشت کامل B1، تلاش برای تعویض دوباره رد شد: پذیرفته شد=false؛ بدون تغییر=true.
- تلاش برای برگشت دوبارهٔ همان B1 هم رد شد: پذیرفته شد=false؛ بدون تغییر=true؛ پاسخ سیستم: همه‌ی اقلام این فاکتور قبلاً برگشت خورده‌اند؛ چیزی برای برگشت نمانده است..

## تطبیق سیاست و پول واقعی
- برگشت دو قلم اصلی: ۱۸٬۰۰۰٬۰۰۰؛ برابر ارزش خالص فاکتور ۱۸٬۰۰۰٬۰۰۰، نه ارزش ناخالص ۲۰٬۰۰۰٬۰۰۰. تخفیف ۲٬۰۰۰٬۰۰۰ به مشتری نقداً یا به‌صورت اعتبار تازه اضافه نشده است.
- وجه برگشتی کل: ۱۶٬۵۰۰٬۰۰۰؛ وجه نقد اضافه‌ای که روی تعویض B دریافت شد: ۵۰۰٬۰۰۰؛ خالص خروج نقد ۱۶٬۰۰۰٬۰۰۰ که با نقد اولیهٔ ۱۶٬۰۰۰٬۰۰۰ برابر است.
- اعتبار جانشینِ زنده: ۲٬۰۰۰٬۰۰۰ در برابر اعتبار اولیهٔ ۲٬۰۰۰٬۰۰۰؛ بارکد اصلی پس از مصرف USED مانده است.
- گزارش وجه سرویس: {"cash":16500000,"card":0,"refundCash":16500000,"refundCard":0}؛ blue واقعی پس از برگشت هر چهار کالا: ۰.
- وضعیت انبار: original-A-10m: 10 عدد (دفتر مطابق)؛ original-B-10m: 10 عدد (دفتر مطابق)؛ replacement-A1-8.5m: 10 عدد (دفتر مطابق)؛ replacement-B1-9.5m: 10 عدد (دفتر مطابق).
- تطبیق‌های مالی مستقل: {"returnedOriginalNetEqualsSaleNet":true,"bothReplacementInvoicesFullyReturned":true,"netPhysicalCashOutEqualsOriginalCashIn":true,"activeSuccessorCreditEqualsOriginalCreditFunding":true,"everyVariantStockMatchesLedger":true,"everyVariantStockRestoredToOpening":true,"blueReturnsToZeroAfterAllGoodsReturned":true,"fullyReturnedB1CannotBeExchanged":true,"fullyReturnedB1CannotBeReturnedAgain":true}.

## تفاوت با انتظار قبلی تست
- نسخهٔ قبلی این تست انتظار داشت برگشت B1 متوقف شود و بر اساس این انتظار یک تخصیص اعتباری ۵۰۰٬۰۰۰ و برداشت نقدی فرضی را محاسبه می‌کرد. اجرای واقعی B1 را پذیرفت؛ بنابراین این انتظارات قدیمی با trace فعلی سازگار نیستند.
- منطق برنامه یا سیاست مالک تغییر داده نشد. در عوض، همهٔ مبلغ‌های واقعیِ برگشت/دریافت، ماندهٔ دو successor، دفتر موجودی و مقدار blue ثبت شدند تا اختلاف پنهان نماند. اگر یکی از این تطبیق‌های مستقل شکست بخورد، نتیجه FAIL باقی می‌ماند.

## محدودیت
- فقط SQLite موقت و جریان رسمی فروش/تعویض/برگشت؛ بدون چک، نسیه، وصول/تسویهٔ بدهی، DB واقعی، staging، انتقال بانکی واقعی یا تغییر production code.
