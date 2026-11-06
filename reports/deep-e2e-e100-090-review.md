# ریشه‌یابی و کنترل‌های مورد سیزدهم: E100-090

## دامنه و روش

E100-090 آخرین مورد از ۱۳ توقف در trace صدجریانی است. بررسی و همهٔ کنترل‌ها فقط روی SQLite موقت تازه برای هر اجرا انجام شدند؛ هیچ production source، DB واقعی، staging یا سیاست اعتبار تغییر نکرد. شش کد multi-use عادی با scope=`ALL`، هرکدام به مبلغ ۲۰۰٬۰۰۰، روی فاکتور ریشه هرکدام ۱۰۰٬۰۰۰ مصرف شدند. اعتبار عادی روی **کل فاکتور pool** می‌شود؛ این تست برای A/B/C/D سهم per-item نساخت.

برای تطبیق دقیق trace اصلی، ریشه بدون تخفیف ۱٬۰۰۰٬۰۰۰ بود: ۶۰۰٬۰۰۰ اعتبار + ۲۰۰٬۰۰۰ نقد + ۲۰۰٬۰۰۰ POS. در کنترل تخفیف، تخفیف ۱۰٪ خالص ریشه را به ۹۰۰٬۰۰۰ رساند و tender برابر ۶۰۰٬۰۰۰ اعتبار + ۱۵۰٬۰۰۰ نقد + ۱۵۰٬۰۰۰ POS شد. همهٔ invoiceها تسویه بودند؛ چک، فروش نسیه و بدهی/وصول بدهی وارد نشد.

## آنچه در trace اصلی اتفاق افتاد

1. **فروش ریشه:** شش کد `ALL` از هرکدام ۱۰۰٬۰۰۰ استفاده کردند؛ هر کد ۱۰۰٬۰۰۰ مانده و `PARTIALLY_USED/usedCount=1` داشت.
2. **برگشت A=۲۰۰٬۰۰۰ با NONE:** پول واقعی برنگشت؛ دو allocation جمعاً ۲۰۰٬۰۰۰ سهم برگشت را به دو منبع multi-use موجود برگرداندند. جانشین جدید صادر نشد.
3. **تعویض مثبت B=۲۰۰٬۰۰۰→B1=۲۲۰٬۰۰۰، اختلاف +۲۰٬۰۰۰:** تعویض پذیرفته شد. برگشت #328 ثبت شد، ولی برای آن `CreditReturnAllocation` منشأیی وجود نداشت. دفتر وجه واقعی به cash=۲۰۰٬۰۰۰ و card=۲۲۰٬۰۰۰ رسید؛ blue=۴۲۰٬۰۰۰. در فیلد `exchangeSettlement` مقدار `CASH` دیده می‌شود، ولی این با دفتر واقعی یکی نیست؛ کنترل‌ها هم tender واقعی card +۲۰٬۰۰۰ را از Payment/raw ledger ثبت کردند.
4. **تعویض منفی C+D:** trace اصلی به‌صورت برچسب runner «۷۰۰٬۰۰۰→۶۸۰٬۰۰۰» معرفی شده، اما جزئیات خود همان trace اقلام C=۳۰۰٬۰۰۰ و D=۳۰۰٬۰۰۰ و جایگزین‌های C1=D1=۲۹۰٬۰۰۰ را نشان می‌دهد؛ بنابراین عددهای مبتنی بر قلم **۶۰۰٬۰۰۰→۵۸۰٬۰۰۰، اختلاف −۲۰٬۰۰۰** هستند. برچسب ۷۰۰٬۰۰۰ یک ناسازگاری متنی trace است و در این RCA به‌عنوان مبلغ واقعی استفاده نشده است. تلاش منفی و retry با STORE_CREDIT هر دو پیش از mutation همان guard را دریافت کردند: `برگشت قبلی #328 تخصیص منشأ اعتبار ندارد؛ هیچ تعویضی ثبت نشد تا منبع مالی با حدس جابه‌جا نشود.`

پس مشاهدهٔ مستقیم trace این است: **برگشت A دارای allocation بود؛ برگشت تعویض مثبت B (#328) نداشت؛ گام منفی بعدی به علت همان برگشت #328 رد شد.**

## کنترل‌های مستقل، هرکدام با DB تازه

| حالت | عملیات و اختلاف خالص | نتیجه | دفتر واقعی نهایی cash / POS / refund | Blue | نکتهٔ provenance |
|---|---|---|---:|---:|---|
| یک‌سندی، بدون تخفیف (دو اجرای تنظیم مستقل) | پس از A، B+C+D: ۸۰۰٬۰۰۰→۸۰۰٬۰۰۰، صفر | PASS؛ refund mode در این حالت وارد عمل نمی‌شود | ۲۰۰٬۰۰۰ / ۲۰۰٬۰۰۰ / صفر | ۴۰۰٬۰۰۰ | فقط دو allocation برگشت A؛ ۶ redemption |
| زنجیرهٔ baseline، CASH و STORE_CREDIT | A با NONE؛ B: ۲۰۰٬۰۰۰→۲۲۰٬۰۰۰، +۲۰٬۰۰۰؛ سپس C+D: ۶۰۰٬۰۰۰→۵۸۰٬۰۰۰، −۲۰٬۰۰۰ | هر دو BLOCKED در C+D؛ رد mutation-free | ۲۰۰٬۰۰۰ / ۲۲۰٬۰۰۰ / صفر | ۴۲۰٬۰۰۰ | allocationهای ثبت‌شده فقط برای A؛ برگشت Bِ مثبت allocation=۰؛ خطا #2 |
| تخفیف ۱۰٪ روی همهٔ زنجیره، CASH و STORE_CREDIT | ریشه net=۹۰۰٬۰۰۰؛ A=۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۱۹۸٬۰۰۰، +۱۸٬۰۰۰؛ C+D: ۵۴۰٬۰۰۰→۵۲۲٬۰۰۰، −۱۸٬۰۰۰ | هر دو BLOCKED در C+D؛ رد mutation-free | ۱۵۰٬۰۰۰ / ۱۶۸٬۰۰۰ / صفر | ۳۱۸٬۰۰۰ | همان guard روی برگشت مثبت B بدون allocation؛ تخفیفِ متناسب مانع را برطرف نکرد |
| تخفیف فقط روی ریشه، CASH و STORE_CREDIT | ریشه net=۹۰۰٬۰۰۰؛ A=۱۸۰٬۰۰۰؛ B: ۱۸۰٬۰۰۰→۲۲۰٬۰۰۰، +۴۰٬۰۰۰؛ C+D: ۵۴۰٬۰۰۰→۵۸۰٬۰۰۰، +۴۰٬۰۰۰؛ سپس B1→B2: ۲۲۰٬۰۰۰→۲۰۰٬۰۰۰، −۲۰٬۰۰۰ | کل زنجیره PASS در هر دو اجرا | ۱۵۰٬۰۰۰ / ۲۳۰٬۰۰۰ / صفر | ۳۸۰٬۰۰۰ | دو اختلاف اول مثبت‌اند؛ در B1→B2 actual ledger=`STORE_CREDIT`، وجه refund=۰ و allocation برگشتی ۲۰٬۰۰۰ به منبع موجود ثبت شد. تغییر علامت C+D یعنی این PASS به‌تنهایی رفع guard را ثابت نمی‌کند. |
| بدون برگشت A، CASH و STORE_CREDIT | B مثبت +۲۰٬۰۰۰؛ سپس C+D −۲۰٬۰۰۰ | هر دو BLOCKED؛ رد mutation-free | ۲۰۰٬۰۰۰ / ۲۲۰٬۰۰۰ / صفر | ۴۲۰٬۰۰۰ | allocation صفر در کل اجرا؛ خطا به برگشت قبلی #1 (B)، بنابراین برگشت A برای بازتولید لازم نیست |
| بدون exchange مثبت B، CASH و STORE_CREDIT | پس از A، مستقیم C+D: ۶۰۰٬۰۰۰→۵۸۰٬۰۰۰، −۲۰٬۰۰۰ | هر دو PASS | ۲۰۰٬۰۰۰ / ۲۰۰٬۰۰۰ / صفر | ۴۰۰٬۰۰۰ | actual ledger در هر دو ورودی `STORE_CREDIT`؛ refund واقعی=۰؛ allocation=۲۰٬۰۰۰ به منبع موجود، نه کد جانشین |

در کنترل‌های دارای برگشت A، شش کد منبع حفظ شدند؛ مبلغ مصرف‌شدهٔ منبع پس از برگشت A دقیقاً به اندازهٔ خالص A کم شد و successor جدید صادر نشد. در تمام checkpointها دفتر گزارش‌شده و raw، blue، stock/stock movement، allocationها، redemptionها و settlement فاکتورها assert شدند؛ `checks=0`. در تلاش‌های BLOCKED، snapshot سند/پول/موجودی/اعتبار بدون تغییر ماند.

### بازتولید مالی در روش‌های منفی

در دو کنترلی که exchange منفی واقعاً ثبت شد (C+D مستقیمِ بدون B و B1→B2 در تخفیف فقط ریشه)، ورودی‌های CASH و STORE_CREDIT جداگانه اجرا شدند. بااین‌حال روش واقعی رکورد برگشت در هر چهار اجرا `STORE_CREDIT` بود: refund نقد/POS صفر ماند و allocation مثبت به credit source موجود ثبت شد؛ مبلغ جدیدی در `refundAmount` یا `refundStoreCreditAmount` صادر نشد. بنابراین «درخواست CASH» را نباید به‌معنی خروج وجه واقعی گزارش کرد. در baseline و تخفیف کل زنجیره، هر دو ورودی قبل از settlement به همان guard رسیدند و هیچ refund اجرا نشد.

## علت مستقیم و ارزیابی محتاطانه

**علت مستقیمِ بازتولیدشده:** در خط پایه، برگشت مثبت B (#328) روی فاکتور ریشه ثبت می‌شود بی‌آنکه allocation منشأ credit داشته باشد؛ تبادل منفی بعدی C+D همان برگشت قبلی را در زنجیره می‌بیند و guard پیش از نوشتن exchange متوقف می‌کند. متن خطا و سندی که آن را trigger می‌کند در baseline و تخفیف کل زنجیره یکسان‌اند.

دو مقایسه محرک را از سایر عوامل جدا می‌کنند:

- حذف برگشت A، درحالی‌که B مثبت و سپس C+D منفی حفظ شده‌اند، guard را حذف نکرد؛ پیام اکنون به برگشت B #1 اشاره دارد. پس برگشت A نه شرط لازم برای توقف است و نه علت مستقیم این مورد.
- حذف exchange مثبت B، درحالی‌که برگشت رسمی A و همان اختلاف منفی C+D حفظ شده‌اند، هر دو درخواست CASH و STORE_CREDIT را پذیرفت. رکورد منفی با allocation منبع اعتبار ثبت شد و وجه واقعی پرداخت نشد. این مقایسه نقش گام Bِ بدون allocation را به‌عنوان محرک نزدیک تقویت می‌کند.

**برداشت RCA:** شواهد کنترل‌شده با اطمینان بالا نشان می‌دهند گام مثبت B بدون provenanceِ تخصیص مورد انتظارِ گام منفی بعدی، علت مستقیم توقف E100-090 است؛ حذف A به‌تنهایی نتیجه را عوض نمی‌کند، حذف B می‌کند. تفاوت تخفیف نیز علامت را عوض می‌کند: تخفیف تمام اسناد C+D را منفی و مسدود نگه داشت؛ تخفیف فقط روی ریشه C+D را مثبت کرد، و exchange منفیِ بعدی B1→B2 از مسیر بازگرداندن سهم به credit source موجود پذیرفته شد.

این RCA **مجوز تغییر سیاست یا تعمیم فراتر از کنترل‌ها نیست**. چون scope اعتبار عادی `ALL` است، نباید برای تحلیل، سهم per-item ساختگی به کدها نسبت داد. ثبت فعلی، علت/رفتار مشاهده‌شده را از تصمیم مالک دربارهٔ رفتار مطلوب جدا می‌کند؛ هیچ سیاست اعتباری تغییر نکرده است.

## خروجی‌ها

۱۲ اجرای مستقل، هرکدام یک JSON و یک Markdown checkpoint:

- [runner کنترل E100-090](../tests/audit-fixes/deep-e2e-e100-090-single-and-discount-controls.mjs)
- [یک‌سندی CASH](deep-e2e-e100-090-single-document-cash-refund-control.md) و [JSON](deep-e2e-e100-090-single-document-cash-refund-control.json)؛ [یک‌سندی STORE_CREDIT](deep-e2e-e100-090-single-document-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-single-document-store-credit-refund-control.json)
- [baseline CASH](deep-e2e-e100-090-baseline-chain-cash-refund-control.md) و [JSON](deep-e2e-e100-090-baseline-chain-cash-refund-control.json)؛ [baseline STORE_CREDIT](deep-e2e-e100-090-baseline-chain-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-baseline-chain-store-credit-refund-control.json)
- [تخفیف کل زنجیره CASH](deep-e2e-e100-090-discount-chain-cash-refund-control.md) و [JSON](deep-e2e-e100-090-discount-chain-cash-refund-control.json)؛ [تخفیف کل زنجیره STORE_CREDIT](deep-e2e-e100-090-discount-chain-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-discount-chain-store-credit-refund-control.json)
- [تخفیف فقط ریشه CASH](deep-e2e-e100-090-discount-first-only-cash-refund-control.md) و [JSON](deep-e2e-e100-090-discount-first-only-cash-refund-control.json)؛ [تخفیف فقط ریشه STORE_CREDIT](deep-e2e-e100-090-discount-first-only-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-discount-first-only-store-credit-refund-control.json)
- [بدون برگشت A CASH](deep-e2e-e100-090-no-prior-return-cash-refund-control.md) و [JSON](deep-e2e-e100-090-no-prior-return-cash-refund-control.json)؛ [بدون برگشت A STORE_CREDIT](deep-e2e-e100-090-no-prior-return-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-no-prior-return-store-credit-refund-control.json)
- [بدون exchange مثبت B، CASH](deep-e2e-e100-090-no-b-exchange-cash-refund-control.md) و [JSON](deep-e2e-e100-090-no-b-exchange-cash-refund-control.json)؛ [بدون exchange مثبت B، STORE_CREDIT](deep-e2e-e100-090-no-b-exchange-store-credit-refund-control.md) و [JSON](deep-e2e-e100-090-no-b-exchange-store-credit-refund-control.json)

فقط تست ایزوله و گزارش مستند شد؛ production code، DB واقعی و policy کد اعتباری دست‌نخورده‌اند.
