# ریشه‌یابی E100-081 — دوازدهمین توقف از ۱۳ مورد

## شناسایی و جمع‌بندی

با مرتب‌کردن trace اصلی بر اساس ترتیب BLOCKEDها، E100-081 **دوازدهمین مورد** است (E100-090 مورد سیزدهم است). بازاجرای هدفمند `selectedCase=81` در SQLite موقت: **۱/۱ جریان، PASS=0، FAIL=0، BLOCKED=1**؛ توقف در exchange منفی B به B1.

این مورد به E100-071 شبیه است، اما source creditها چندمصرفی‌اند و باقی‌مانده‌شان در یک فاکتور مستقل مصرف می‌شود. دو اعتبار manager-restricted، هرکدام ۱۰۰٬۰۰۰ و فقط برای B/C/D، جایگزین‌ها و دو SKU کمکی، ۵۰٬۰۰۰ روی root و ۵۰٬۰۰۰ روی فاکتور کمکی مصرف شدند؛ هر کد در پایان `USED/usedCount=2` ماند. A از allowlist خارج بود. برگشت A=۲۰۰٬۰۰۰ با CASH انجام شد و هیچ اعتبار یا successorی به آن تعلق نگرفت. گیت سپس exchange کاهشی B را با پیام تخصیص منشأ برای برگشت قبلی #1 رد کرد.

**نتیجهٔ controls:** baseline و تخفیف روی کل chain هر دو در B منفی متوقف شدند؛ درخواست CASH و STORE_CREDIT جداگانه آزمایش شد. کنترل بدون زنجیره هم متوقف شد، چون اختلاف aggregate آن −۴۰٬۰۰۰ بود. تخفیف فقط روی فاکتور اول، اختلاف B را صفر و دو اختلاف بعدی را مثبت کرد و chain را PASS کرد. حذف برگشت A، دو exchange منفی −۲۰٬۰۰۰ را با هر دو روش پذیرفت؛ درخواست CASH نیز در واقع هیچ پولی از صندوق خارج نکرد و روش واقعی به STORE_CREDIT تبدیل شد.

## Fixture اصلی و وضعیت قبل از توقف

- Root: A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ gross/net=**۱٬۰۰۰٬۰۰۰**.
- دو اعتبار manager-restricted `VARIANTS`, هرکدام ۱۰۰٬۰۰۰ و با `maxUses=10`; هرکدام ۵۰٬۰۰۰ در خرید root مصرف شد.
- Tender واقعی root: **۴۵۰٬۰۰۰ نقد + ۴۵۰٬۰۰۰ POS**.
- فاکتور کمکی جدا: دو SKU هرکدام ۵۰٬۰۰۰؛ با ۵۰٬۰۰۰ ماندهٔ هر کد پرداخت شد؛ مبلغ=۱۰۰٬۰۰۰ و پول واقعی اضافه=۰. هر دو کد پس از دو redemption `USED`, `usedAmount=100,000`, `usedCount=2` شدند.
- Scope کدها شامل B/C/D، B1/C1/D1/B2 و دو SKU کمکی بود؛ A در allowlist نبود.
- برگشت A: **۲۰۰٬۰۰۰ CASH**، `sourceCreditRestoredAmount=0`, successor=۰ و allocation=۰. پول واقعی برگشتی در ledger ثبت شد.
- Exchange B=۲۰۰٬۰۰۰→B1=۱۸۰٬۰۰۰؛ اختلاف **−۲۰٬۰۰۰**. پس از رد و retry، وضعیت واقعی: ۲ فاکتور (root+aux)، ۱ برگشت، ۶ Payment، cash=۴۵۰٬۰۰۰، POS=۴۵۰٬۰۰۰، refund نقد=۲۰۰٬۰۰۰، refund POS=۰، blue=**۷۰۰٬۰۰۰**. B/C/D در موجودی فروش‌رفته باقی ماندند؛ B1 و کالاهای جایگزین stock movement جدید نداشتند.

## علت مستقیم توقف

`SalesService.ts:1825–1840` در بازسازی funding، اگر برای یک برگشت قبلی مبلغ funded مثبت باشد، allocation اعتباری صفر باشد و هر CREDIT bucket در زنجیره باقی مانده باشد، پیش از mutation رد می‌کند. در E100-081 رکورد هدف **برگشت A #1** بود.

این برگشت با CASH تسویه شده بود و `A` از scope دو کد `VARIANTS` خارج بود. بنابراین صفر بودن `CreditReturnAllocation` برای A با خود scope سازگار است؛ سهم اعتبار واجد شرایطی برای بازگرداندن به A وجود نداشت. بااین‌حال guard برای این شرط، روش واقعی برگشت و scope اعتبار باقی‌مانده را بررسی نمی‌کند؛ «برگشت پولیِ خارج از scope که allocation اعتباری ندارد» را از «سهم اعتباری مجاز که منشأش جا افتاده/مبهم است» جدا نمی‌کند.

### نتیجهٔ قطعی و محدودیت داوری

- علت مستقیم و پیام توقف قطعی‌اند: guard به برگشت A #1 رسید و exchange منفی B را رد کرد؛ retry نیز mutation-free رد شد.
- برای A، allocation صفر با سیاست manager-restricted سازگار بود؛ refund نقدی ۲۰۰٬۰۰۰ در ledger و blue اعمال شد.
- بدون برگشت A، همان B منفی با CASH و STORE_CREDIT پذیرفته شد؛ کدهای قدیمی USED ماندند و اختلاف ۲۰٬۰۰۰ به اعتبار successor مستقل و همچنان محدودشده تبدیل شد. درخواست CASH **actual cash refund ایجاد نکرد**. این مقایسه نشان می‌دهد وجود برگشت قبلی A trigger توقف فعلی است.
- چون credit manager-restricted است، این نتیجه را به bypass عمومیِ scope تعمیم نمی‌دهیم. تشخیص فعلی: **توقف کاذب برای برگشت A خارج از scope محتمل و با کنترل قوی پشتیبانی می‌شود؛ سهم B/C/D باید همچنان مطابق policy مالک قابل ردیابی بماند.** هیچ نتیجه‌ای دربارهٔ بازطراحی policy یا مجاز بودن cash-out گرفته نشده است.

## کنترل‌ها — ۹ اجرای مستقل با DB موقت تازه

### ۱–۲. بدون زنجیره: exchange تجمیعی B+C+D، هر دو روش

قیمت‌های واقعی این fixture: برگشت B+C+D=**۸۰۰٬۰۰۰**، جایگزین B1+C1+D1=۱۸۰٬۰۰۰+۲۹۰٬۰۰۰+۲۹۰٬۰۰۰=**۷۶۰٬۰۰۰**؛ اختلاف **−۴۰٬۰۰۰**. پس این کنترل برخلاف E100-070 اختلاف صفر ندارد.

پس از برگشت A، هر دو درخواست `CASH` و `STORE_CREDIT` با همان خطای برگشت #1 رد شدند و mutation ندادند. نتیجه نشان می‌دهد حذف exchange واسط B به‌تنهایی کافی نیست؛ اگر exchange تجمیعی هنوز اختلاف منفی داشته باشد، guard همچنان اجرا می‌شود.

### ۳–۴. baseline chain: exchange B با −۲۰٬۰۰۰، هر دو روش

بعد از A=۲۰۰٬۰۰۰ نقدی، B=۲۰۰٬۰۰۰→B1=۱۸۰٬۰۰۰. در DB جدا، درخواست CASH و در DB مستقل دیگر درخواست STORE_CREDIT انجام شد. هر دو به guard برگشت #1 رسیدند. Final هرکدام cash=۴۵۰٬۰۰۰، POS=۴۵۰٬۰۰۰، refund نقد=۲۰۰٬۰۰۰، blue=۷۰۰٬۰۰۰؛ دو کد multi-use با `usedCount=2` و بدون تغییر ماندند.

### ۵–۶. تخفیف ۱۰٪ روی تمام فاکتورهای chain، هر دو روش

Root خالص=**۹۰۰٬۰۰۰**؛ A/B/C/D خالص=۱۸۰/۱۸۰/۲۷۰/۲۷۰؛ اعتبار=۱۰۰٬۰۰۰، نقد=۴۰۰٬۰۰۰ و POS=۴۰۰٬۰۰۰. برگشت A=۱۸۰٬۰۰۰ CASH بود.

تخفیف ۱۰٪ روی B1، آن را به ۱۶۲٬۰۰۰ رساند؛ B خالص ۱۸۰٬۰۰۰→۱۶۲٬۰۰۰، اختلاف **−۱۸٬۰۰۰**. درخواست CASH و STORE_CREDIT در دو DB مجزا، هر دو همان برگشت #1 را دیدند و قبل از mutation متوقف شدند. C+D و B1→B2 در این دو اجرا نرسیدند. Final cash=۴۰۰٬۰۰۰، POS=۴۰۰٬۰۰۰، refund نقد=۱۸۰٬۰۰۰، blue=۶۲۰٬۰۰۰ ماند.

### ۷. تخفیف فقط روی فاکتور اول — chain کامل PASS

Root net=۹۰۰٬۰۰۰ و A=۱۸۰٬۰۰۰ با CASH برگشت شد. جایگزین‌ها بدون تخفیف ماندند:

- B: ۱۸۰٬۰۰۰→B1=۱۸۰٬۰۰۰؛ اختلاف صفر.
- C+D: ۵۴۰٬۰۰۰→C1+D1=۵۸۰٬۰۰۰؛ **+۴۰٬۰۰۰ POS**.
- B1→B2: ۱۸۰٬۰۰۰→۲۰۰٬۰۰۰؛ **+۲۰٬۰۰۰ POS**.

کل chain PASS شد؛ final cash=۴۰۰٬۰۰۰، POS=۴۶۰٬۰۰۰، refund نقد=۱۸۰٬۰۰۰، blue=**۶۸۰٬۰۰۰**. در این مسیر اختلاف منفی اجرا نشد؛ PASS علت provenance را برطرف نمی‌کند.

### ۸–۹. کنترل تشخیصی بدون برگشت A، هر دو روش

با همان root و فاکتور کمکی—و همان دو source code که `USED/usedCount=2` بودند—برگشت A حذف شد. سپس B=۲۰۰٬۰۰۰→۱۸۰٬۰۰۰ با درخواست CASH یا STORE_CREDIT، در دو DB جدا، پذیرفته شد. هر دو نیز C+D=۶۰۰٬۰۰۰→۵۸۰٬۰۰۰ با اختلاف −۲۰٬۰۰۰ و B1→B2=۱۸۰٬۰۰۰→۲۰۰٬۰۰۰ با +۲۰٬۰۰۰ POS را کامل کردند.

در حالت درخواست CASH برای B، `SaleReturn.refundMethod` واقعی `STORE_CREDIT` بود، cash/POS refund=۰ و ۲۰٬۰۰۰ successor مستقل و manager-restricted ثبت شد؛ برای C+D نیز اختلاف منفی به credit successor جداگانه برگشت. کدهای اصلی همچنان `USED/usedCount=2` ماندند؛ سهم‌های ۲۰٬۰۰۰ مستقل/جدا بودند و ادغام نشدند. Final cash=۴۵۰٬۰۰۰، POS=۴۷۰٬۰۰۰، refund واقعی=۰ و blue=**۹۲۰٬۰۰۰** در هر دو اجرا. این کار اثبات نمی‌کند هر cash request باید پرداخت نقدی شود؛ ledger نشان می‌دهد چنین پرداختی انجام نشد.

## ثبت برای طرح پوشش توقف‌ها

E100-081 یافتهٔ دوازدهم است: پس از مصرف دوبارهٔ ماندهٔ کدهای multi-use restricted در فاکتور دوم، برگشت نقدی A که خارج از allowlist بود allocation اعتباری نداشت؛ گیت این وضعیت را قبل از exchange کاهشی B با نبود provenance یکسان گرفت. تفاوت lifecycle (`MULTI_LIVE` که در ادامه به `USED/usedCount=2` رسید) ماهیت گیت را تغییر نداد. نتیجهٔ محتاطانه، false-stop محتمل برای برگشت A است؛ اما هر ادامه باید مانع تخصیص اعتبار محدودشده به کالای خارج از scope و مانع بازپرداخت پول واقعیِ بدون پشتوانه شود.

## فایل‌های شاهد

- اجرای اصلی: [focused summary](deep-e2e-e100-081-focused.md)، [JSON](deep-e2e-e100-081-focused.json).
- بدون زنجیره/CASH: [گزارش](deep-e2e-e100-081-single-document-cash-refund-control.md)، [trace](deep-e2e-e100-081-single-document-cash-refund-control.json).
- بدون زنجیره/STORE_CREDIT: [گزارش](deep-e2e-e100-081-single-document-store-credit-refund-control.md)، [trace](deep-e2e-e100-081-single-document-store-credit-refund-control.json).
- baseline، CASH: [گزارش](deep-e2e-e100-081-baseline-chain-cash-refund-control.md)، [trace](deep-e2e-e100-081-baseline-chain-cash-refund-control.json).
- baseline، STORE_CREDIT: [گزارش](deep-e2e-e100-081-baseline-chain-store-credit-refund-control.md)، [trace](deep-e2e-e100-081-baseline-chain-store-credit-refund-control.json).
- تخفیف کل chain/CASH: [گزارش](deep-e2e-e100-081-discount-chain-cash-refund-control.md)، [trace](deep-e2e-e100-081-discount-chain-cash-refund-control.json).
- تخفیف کل chain/STORE_CREDIT: [گزارش](deep-e2e-e100-081-discount-chain-store-credit-refund-control.md)، [trace](deep-e2e-e100-081-discount-chain-store-credit-refund-control.json).
- تخفیف فقط root: [گزارش](deep-e2e-e100-081-discount-first-only-control.md)، [trace](deep-e2e-e100-081-discount-first-only-control.json).
- بدون برگشت A/CASH: [گزارش](deep-e2e-e100-081-no-prior-return-cash-refund-control.md)، [trace](deep-e2e-e100-081-no-prior-return-cash-refund-control.json).
- بدون برگشت A/STORE_CREDIT: [گزارش](deep-e2e-e100-081-no-prior-return-store-credit-refund-control.md)، [trace](deep-e2e-e100-081-no-prior-return-store-credit-refund-control.json).
- Runner controls: [single/discount controls](../tests/audit-fixes/deep-e2e-e100-081-single-and-discount-controls.mjs).

فقط test روی SQLite موقت ایزوله اجرا شد. چک، نسیه، دریافت/تسویهٔ بدهی، DB واقعی، staging و reset استفاده نشدند. در این کار production source و سیاست اعتبار تغییر نکردند.
