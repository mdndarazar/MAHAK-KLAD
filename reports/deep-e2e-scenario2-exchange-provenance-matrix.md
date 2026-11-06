# E100-018: تفکیک گیت تعویض‌های بعدی

**نتیجه:** 6/7 هدف پذیرفته؛ 1 رد؛ 0 خطای harness.
**DB:** SQLite موقت ایزوله (/tmp/mahak-e100-018-provenance-K1x3pX/isolated.db).
**همهٔ بارکدها عادی ALL:** شش کد ۱۰۰٬۰۰۰؛ فروش ۱٬۰۰۰٬۰۰۰ با ۶۰۰٬۰۰۰ اعتبار، ۲۰۰٬۰۰۰ نقد و ۲۰۰٬۰۰۰ POS. A با اعتبار invoice-wide برگردانده شد؛ سپس در شش شاخه B→B1=220 (+20) با کارت انجام شد. شاخهٔ هفتم، کنترل بدون تعویض B است.

| هدف پس از A (و B، جز کنترل) | نتیجه | بدون تغییر پس از رد | پیام |
|---|---|---|---|
| A-return_Bplus_CplusDminus | پذیرفته شد | — | — |
| A-return_Bplus_CplusDplus | پذیرفته شد | — | — |
| A-return_Bplus_Cminus | پذیرفته شد | — | — |
| A-return_Bplus_Dminus | پذیرفته شد | — | — |
| A-return_Bplus_child-B1minus | پذیرفته شد | — | — |
| A-return_Bplus_CD-full-return | رد شد | true | با این برگشت، ۲۰۰٬۰۰۰ ریال اضافه‌دریافت روی فاکتور ۱۶ ساخته می‌شود (پول دریافت‌شده ۴۰۰٬۰۰۰ ریال از مانده‌ی کالا ۲۰۰٬۰۰۰ ریال بیشتر می‌ماند).\nاگر آگاهانه می‌خواهید همین مبلغ کامل ثبت شود، «بله ثبت کن» را بزنید؛ مبلغ اضافه به‌صورت جدا (ردیف «دریافت پول اضافه») در گزارش فاکتور نمایش داده می‌شود، یا می‌توانید از آن کد اعتبار خرید صادر کنید. |
| A-return_direct_CplusDminus-control | پذیرفته شد | — | — |

## رویدادهای کلیدی
### A-return_Bplus_CplusDminus — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: C+D negative difference −20k**: پذیرفته شد
### A-return_Bplus_CplusDplus — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: C+D positive difference +20k**: پذیرفته شد
### A-return_Bplus_Cminus — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: C negative difference −10k**: پذیرفته شد
### A-return_Bplus_Dminus — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: D negative difference −10k**: پذیرفته شد
### A-return_Bplus_child-B1minus — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: B1 re-exchange from child invoice −20k**: پذیرفته شد
### A-return_Bplus_CD-full-return — BLOCKED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **B→B1 positive exchange 200k→220k (+20k card)**: پذیرفته شد; allocationهای همین برگشت=2
- **target: full C+D return**: رد شد; با این برگشت، ۲۰۰٬۰۰۰ ریال اضافه‌دریافت روی فاکتور ۱۶ ساخته می‌شود (پول دریافت‌شده ۴۰۰٬۰۰۰ ریال از مانده‌ی کالا ۲۰۰٬۰۰۰ ریال بیشتر می‌ماند).\nاگر آگاهانه می‌خواهید همین مبلغ کامل ثبت شود، «بله ثبت کن» را بزنید؛ مبلغ اضافه به‌صورت جدا (ردیف «دریافت پول اضافه») در گزارش فاکتور نمایش داده می‌شود، یا می‌توانید از آن کد اعتبار خرید صادر کنید.; mutation-free=true
### A-return_direct_CplusDminus-control — ACCEPTED
- **return A through invoice-wide credit pool**: پذیرفته شد; allocationهای همین برگشت=6
- **target: C+D negative difference −20k**: پذیرفته شد

## ایمنی
- فقط SQLite موقت؛ هیچ چک، نسیه، stage یا DB واقعی استفاده نشد.
- هیچ production code تغییر نکرد.
