# ریشه‌یابی E100-071 — یازدهمین توقف از ۱۳ مورد

## شناسایی درست مورد یازدهم

ترتیب توقف‌ها از trace اصلی ۱۰۰ جریان استخراج شد؛ مورد یازدهم **E100-071** است. `E100-090` در این ترتیب مورد سیزدهم است. اجرای هدفمند `selectedCase=71` در SQLite موقت: **۱/۱، PASS=0، FAIL=0، BLOCKED=1، finding=0**؛ مرحلهٔ توقف `exchange B to B1` بود.

## خلاصهٔ نتیجه

این مورد با یافته‌های ۹ و ۱۰ متفاوت است: این‌جا اعتبار `ALL` نیست، بلکه چهار کد single-use با scope محدود `VARIANTS_BCD` داریم و **A عمداً خارج از scope کدهاست**. A به‌درستی با پول واقعی برگشت خورد و سهم اعتبار برگشتی/جانشینش صفر ماند. بعد تعویض کاهشی B، با اختلاف −۲۰٬۰۰۰، با دو روش `CASH` و `STORE_CREDIT` در گیت برگشت قبلی #1 متوقف شد.

کنترل یک‌سندی B+C+D با اختلاف صفر **PASS** شد. تخفیف روی همهٔ فاکتورها B را کاهشی‌تر کرد و همان گیت را با هر دو روش زد. تخفیف فقط روی فاکتور اول اختلاف B را صفر و C+D را مثبت کرد؛ کل زنجیره **PASS** شد. کنترل تشخیصیِ بدون برگشت قبلی A نیز exchange کاهشی B را با هر دو روش پذیرفت، اما حتی با ورودی `CASH` پول واقعی بیرون نداد و مازاد را به اعتبار محدودشده برگرداند.

## Fixture واقعی و رخداد baseline

- Root: A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع=**۱٬۰۰۰٬۰۰۰**.
- چهار اعتبار single-use، هرکدام ۱۰۰٬۰۰۰؛ جمع=**۴۰۰٬۰۰۰**. scope هر چهار کد `VARIANTS`; allowlist شامل B,C,D و B1,C1,D1,B2 است و A در آن نیست.
- Tender واقعی root: **۳۰۰٬۰۰۰ نقد + ۳۰۰٬۰۰۰ POS**.
- برگشت A: **۲۰۰٬۰۰۰ CASH**. سهم credit برگشتی=۰، successor=۰ و allocation=۰؛ نقد واقعی برگشت ۲۰۰٬۰۰۰ ثبت شد. این صفر allocation در این fixture با scope سازگار است: A برای کدهای manager-restricted واجد شرایط نبود.
- B=۲۰۰٬۰۰۰→B1=۱۸۰٬۰۰۰: اختلاف **−۲۰٬۰۰۰**. اجرای اصلی با روش انتخابی CASH و fallback به STORE_CREDIT هر دو پیش از ثبت exchange با پیام «برگشت قبلی #1 تخصیص منشأ اعتبار ندارد» رد شدند.
- پیش و پس از رد/retry: فاکتور=۱، برگشت=۱، Payment=۶، cash=۳۰۰٬۰۰۰، POS=۳۰۰٬۰۰۰، refund نقد=۲۰۰٬۰۰۰، refund POS=۰، blue=**۴۰۰٬۰۰۰**؛ stock و کدهای USED تغییری نکردند.

## علت فنی مستقیم

در `SalesService.ts:1825–1840` guard هر برگشت قبلی را می‌سنجد. شرط توقف، در عمل این است: مبلغ برگشت تأمین‌شده از صفر بیشتر باشد، allocation اعتباری آن برگشت صفر باشد، و در funding buckets هنوز هر نوع CREDIT وجود داشته باشد. این شرط برای E100-071، برگشت A (#1) را هدف گرفت.

اما اطلاعات همان برگشت می‌گفت `refundMethod=CASH`, `refundAmount=200,000`, `sourceCreditRestoredAmount=0`; A هم از allowlist هر چهار کد خارج بود. guard برای این شرطِ کلی، نه روش واقعی برگشت و نه scope اعتبار را بررسی می‌کند؛ allocation خالیِ «هیچ منبع محدودشده‌ای برای A واجد شرایط نبود» را از allocation خالیِ «سهم اعتباریِ واجد شرایط گم شده/مبهم است» جدا نمی‌کند.

### تفکیک علت قطعی از داوری policy

- **قطعی:** علت مستقیم توقف، guard عمومی روی برگشت قبلی A (#1) است؛ پیام، exchange را پیش از mutation می‌بندد.
- **قطعی:** allocation صفر برای A متناسب با scope واقعی است؛ این برگشت از مسیر CASH انجام شد و اعتبارهای B/C/D برای A مصرف نشدند.
- **محتمل، نه حکم قطعی:** گیت برای این برگشت پولیِ خارج از scope بیش‌ازحد محافظه‌کار است؛ کنترل بدون برگشت A نشان داد B با settlement یکسان قابل انجام است. اما چون کدها manager-restricted هستند، تخصیص سهم B/C/D باید همچنان طبق policy محدودشده و قابل ردیابی بماند. بنابراین گزارش، false stop برای رکورد A را محتمل می‌داند؛ دربارهٔ تمام حالات تخصیص restricted credit حکم عمومی نمی‌دهد.

## کنترل‌های تکمیلی — DB مستقل برای هر اجرا

### ۱) بدون زنجیره — PASS

پس از برگشت A، B+C+D یکجا exchange شد:

- برگشتی=**۸۰۰٬۰۰۰**؛ جایگزین B1+C1+D1=۱۸۰٬۰۰۰+۳۱۰٬۰۰۰+۳۱۰٬۰۰۰=**۸۰۰٬۰۰۰**؛ اختلاف صفر.
- PASS؛ final cash=۳۰۰٬۰۰۰، POS=۳۰۰٬۰۰۰، refund نقد=۲۰۰٬۰۰۰، blue=۴۰۰٬۰۰۰.

این کنترل نشان می‌دهد در سند تجمیعیِ صفر-اختلاف، برگشت A بدون allocation مانع نشده است؛ گیر در exchange کاهشی B چندسندی/گیت مسیر منفی است.

### ۲) زنجیرهٔ baseline؛ اختلاف B منفی با دو روش جدا

در دو DB جدا، پس از همان برگشت A=۲۰۰٬۰۰۰ نقدی:

- B=۲۰۰٬۰۰۰→۱۸۰٬۰۰۰؛ اختلاف −۲۰٬۰۰۰، درخواست `CASH`: **BLOCKED** روی برگشت #1، بدون mutation.
- همان آزمون در DB تازه با درخواست `STORE_CREDIT`: **BLOCKED** روی همان guard، بدون mutation.

هر دو trace پس از رد actual cash=۳۰۰٬۰۰۰، POS=۳۰۰٬۰۰۰، refund نقد=۲۰۰٬۰۰۰، blue=۴۰۰٬۰۰۰ و چهار source code در `USED` را نشان می‌دهند. بنابراین انتخاب settlement علت این توقف نیست؛ guard قبل از رسیدن به شاخهٔ CASH/STORE_CREDIT اجرا می‌شود.

### ۳) تخفیف ۱۰٪ روی کل chain؛ اختلاف B با دو روش جدا

Root net=**۹۰۰٬۰۰۰**؛ سهم خالص A/B/C/D=۱۸۰٬۰۰۰/۱۸۰٬۰۰۰/۲۷۰٬۰۰۰/۲۷۰٬۰۰۰. Tender واقعی=۲۵۰٬۰۰۰ نقد+۲۵۰٬۰۰۰ POS+۴۰۰٬۰۰۰ اعتبار. برگشت A=۱۸۰٬۰۰۰ نقدی، چون A خارج از scope کدهاست.

تخفیف ۱۰٪ روی B1=۱۸۰٬۰۰۰، قیمت B1 را به ۱۶۲٬۰۰۰ می‌رساند: B net ۱۸۰٬۰۰۰→۱۶۲٬۰۰۰، اختلاف **−۱۸٬۰۰۰**. در دو اجرای مستقل، `CASH` و `STORE_CREDIT` هر دو همان guard را زدند. چون B متوقف شد، exchange بعدی C+D و re-exchange اجرا نشدند؛ این عدم اجرا صریحاً در JSON ثبت است. Final cash=۲۵۰٬۰۰۰، POS=۲۵۰٬۰۰۰، refund نقد=۱۸۰٬۰۰۰، blue=۳۲۰٬۰۰۰ ماند.

### ۴) تخفیف فقط روی root — کل زنجیره PASS، اما بدون شاخهٔ منفی

Root net=۹۰۰٬۰۰۰؛ برگشت A=۱۸۰٬۰۰۰ نقد. قیمت جایگزین‌ها کامل ماند:

- B: net ۱۸۰٬۰۰۰→B1=۱۸۰٬۰۰۰، اختلاف صفر؛ PASS.
- C+D: net ۵۴۰٬۰۰۰→C1+D1=۶۲۰٬۰۰۰، **+۸۰٬۰۰۰ POS**؛ PASS.
- B1→B2: ۱۸۰٬۰۰۰→۲۰۰٬۰۰۰، **+۲۰٬۰۰۰ POS**؛ PASS.

Final cash=۲۵۰٬۰۰۰، POS=۳۵۰٬۰۰۰، refund نقد=۱۸۰٬۰۰۰، blue=۴۲۰٬۰۰۰. چون هیچ اختلاف منفی رخ نداد، این PASS رفع guard یا provenance را ثابت نمی‌کند.

### ۵) کنترل تشخیصی: حذف برگشت A — هر دو ورودی منفی پذیرفته شدند

با همان root، credit scope و اختلاف B=−۲۰٬۰۰۰، اما **بدون برگشت A قبلی**، دو اجرای مستقل با درخواست `CASH` و `STORE_CREDIT` انجام شد. هر دو exchange B را پذیرفتند؛ دو re-exchange مثبت بعدی نیز ثبت شدند.

نکتهٔ مهم سیاست مالی: در اجرای درخواست `CASH`، ledger ثبت کرد که بازپرداخت واقعی صفر بود؛ `SaleReturn.refundMethod=STORE_CREDIT`, exchange settlement=`CREDIT`, و ۲۰٬۰۰۰ اعتبار successor با همان محدودیت صادر شد. cash و POS از B تغییر نکردند. در اجرای `STORE_CREDIT` نیز وجه واقعی بیرون نرفت. در هر دو، B برگشت داده شد و برای ۲۰٬۰۰۰ اعتبار یک successor جدید با همان محدودیت صادر شد؛ source codeهای کاملاًمصرف‌شده `USED` ماندند و دوباره فعال نشدند.

پس با حذف فقط برگشت A، همان B منفی و هر دو ورودی settlement از گیت عبور کردند؛ این شاهد قوی است که وجود ردیف برگشت A بدون allocation، trigger لازم توقف مورد اصلی بوده است. این کنترل به‌تنهایی مجوز cash-out از اعتبار نیست؛ ledger واقعی نشان داد cash-out رخ نداد.

## تفسیر نهایی برای طرح پوشش توقف‌ها

**یافتهٔ یازدهم:** guard بین «برگشت A با اعتبار صفرِ موردانتظار، چون کالا خارج از scope است و پول واقعی برگشته» و «برگشت دارای سهم restricted credit ولی allocation مفقود/مبهم» تمایز کافی ندارد. یک‌سندی و حالت تخفیف‌دارِ بدون اختلاف منفی PASS شدند؛ baseline و full-discount، exchange منفی B را با هر دو settlement متوقف کردند؛ حذف برگشت A هر دو روش را پذیرفت و از پرداخت نقدیِ بدون پشتوانه جلوگیری شد.

این رفتار را به‌عنوان **توقف کاذب محتمل/نیازمند داوری در scope محدودشده** ثبت می‌کنیم، نه مغایرت قطعی با policy `ALL`. قاعدهٔ owner برای اعتبارهای manager-restricted همچنان پابرجاست: سهم B/C/D باید مطابق scope و traceable باشد. هیچ راه‌حل اجرایی یا policy جدیدی اعمال نشده است.

## شواهد

- اجرای اصلی: [focused summary](deep-e2e-e100-071-focused.md) و [JSON](deep-e2e-e100-071-focused.json).
- کنترل تجمیعی: [گزارش](deep-e2e-e100-071-single-document-control.md) و [trace](deep-e2e-e100-071-single-document-control.json).
- baseline، درخواست CASH: [گزارش](deep-e2e-e100-071-baseline-chain-cash-refund-control.md) و [trace](deep-e2e-e100-071-baseline-chain-cash-refund-control.json).
- baseline، درخواست STORE_CREDIT: [گزارش](deep-e2e-e100-071-baseline-chain-store-credit-refund-control.md) و [trace](deep-e2e-e100-071-baseline-chain-store-credit-refund-control.json).
- تخفیف روی chain، درخواست CASH: [گزارش](deep-e2e-e100-071-discount-chain-cash-refund-control.md) و [trace](deep-e2e-e100-071-discount-chain-cash-refund-control.json).
- تخفیف روی chain، درخواست STORE_CREDIT: [گزارش](deep-e2e-e100-071-discount-chain-store-credit-refund-control.md) و [trace](deep-e2e-e100-071-discount-chain-store-credit-refund-control.json).
- تخفیف فقط روی root: [گزارش](deep-e2e-e100-071-discount-first-only-control.md) و [trace](deep-e2e-e100-071-discount-first-only-control.json).
- کنترل بدون برگشت A، CASH: [گزارش](deep-e2e-e100-071-no-prior-return-cash-refund-control.md) و [trace](deep-e2e-e100-071-no-prior-return-cash-refund-control.json).
- کنترل بدون برگشت A، STORE_CREDIT: [گزارش](deep-e2e-e100-071-no-prior-return-store-credit-refund-control.md) و [trace](deep-e2e-e100-071-no-prior-return-store-credit-refund-control.json).
- Runner کنترل‌ها: [single/discount controls](../tests/audit-fixes/deep-e2e-e100-071-single-and-discount-controls.mjs).

فقط تست روی SQLite موقت ایزوله انجام شد؛ چک، نسیه، وصول/تسویهٔ بدهی، DB واقعی، staging و reset استفاده نشدند. در این کار production source و سیاست اعتبار تغییر نکردند.
