# پرامپتِ مشاورهٔ مستقل برای Claude — MAHAK-KLAD — رفعِ ناقصیِ 7 باگ + C+D بدون ریسک

> این پرامپت را **همراه با ZIPِ کاملِ آخرین working tree روی شاخهٔ `arena/8a852de1-mahak-klad` (commit آخر + همهٔ تغییراتِ dirty)** به Claude بده. ZIP شاملِ آخرین snapshotِ واقعیِ پروژه است؛ `.git`، `node_modules`، `out/dist` داخلِ بسته نیست.

## نقشِ تو و مرزِ اختیارت

- تو فقط **مشاورِ فنیِ مستقل** هستی. **هیچ فایلی را تغییر نده، کد ننویس، patch نساز و تست اجرا نکن.** فقط نظرِ فنی، ریشه‌یابی و یک **برنامهٔ کم‌ریسکِ قدم‌به‌قدم** برایِ رفعِ مشکل بده.
- تصمیمِ نهاییِ محصول با **مالک** و عاملِ پیاده‌سازی (من) است. من در نهایت مشکل را حل می‌کنم؛ تو فقط مشورت می‌دهی تا از زاویهٔ دیگر مطمئن شویم چیزی را خراب نمی‌کنیم.
- اگر پیشنهادت با سیاستِ مالک تعارض دارد، تعارض را **صریح و جداگانه** اعلام کن و آن را به‌عنوانِ پیشنهادِ جایگزین مطرح کن؛ سیاستِ مالک را جایگزین نکن.

## سیاستِ قطعنامهٔ مالک — تغییرناپذیر

1. منطقِ اصلیِ نرم‌افزار به **هیچ عنوان** نباید تغییر کند. رفتارِ قبلیِ بارکد/برگشت/تعویضِ مستقیم و زنجیره‌ای، انبار، گزارش، صندوق، کارت‌خوان که درست کار می‌کند، دست‌نخورده بماند.
2. بارکدِ اعتباریِ عمومی (`scope=ALL`) **در سطحِ فاکتور** مصرف می‌شود و **نباید به سهم‌هایِ جداگانه برایِ هر قلم تقسیم شود**. فقط بارکدی که مدیر به کالا/دسته محدود کرده، می‌تواند رویِ اقلامِ واجدشرایطِ خودش اعمال شود.
3. فرمولِ تخفیفِ تاریخیِ مصوب در `reports/discount-policy-final-design.md` بدونِ تغییرِ رفتارِ پایه، فقط به محاسبهٔ `R` و `D` وصل می‌شود:
   - `NO: t=0`
   - `YES: t=min(d,c)` که `c` ظرفیتِ تخفیف‌پذیرِ جایگزین است و هرگز خالصِ جایگزین را منفی نمی‌کند
   - `YES_ZERO: اگر Δ≤0 ⇒ t=0؛ وگرنه t=min(d,c,Δ)` که `Δ = R − N` پیش از انتقالِ تاریخی است
   - چک‌باکسِ «جلوگیری از بازپرداختِ اضافه» به‌طورِ پیش‌فرض روشن و فقط `YES` را که بازپرداخت را از `NO` بیشتر کند غیرفعال می‌کند.
4. دو توصیهٔ قبلیِ Claude و GLM **فقط مشورتی** هستند؛ سیاستِ مالک و منطقِ جاریِ نرم‌افزار با آزمونِ ایزولهٔ نسخهٔ موردنظر معیارِ نهایی‌اند.

## وضعِ فعلیِ تست‌ها — شواهدِ عینی (نه حدس)

- رویِ همین commitِ آخرین، با `node --import ./test/harness/register.mjs` و SQLiteِ موقتِ ایزوله (بدونِ لمسِ production):
  - `fix-s60-exchange-debt.mjs`: **10/10 PASS** (کاهشِ بدهیِ `min(N−R,B)`، `CashMovement`ِ درست، پلِ تطبیق بسته)
  - `fix-cash-movement-financial-revision` و `fix-financial-exchange-s11-debt-offset-paid-carry` : **PASS**
  - `deep-e2e-10-financial-flows`: **7/11 PASS، ۴ FAIL** (06 card refund, 09/11 pooled, 10 mixed-tender) — هر ۴ FAIL **بدونِ جهشِ مالی** rollback شدند.
  - `deep-e2e-100-credit-exchange-chains`: در **گزارشِ Markdownِ commit‌شده 100/100 PASS** است، ولی در **اجرایِ زندهٔ همین محیط** با همین harness **`FAIL: invoiceCount 0`** می‌دهد — یعنی گزارشِ Markdown با harnessِ فعلیِ `test/harness/register.mjs` هماهنگ نیست.
  - **۱۳تایِ دستهٔ C+D** (`b-first-a-second`, `prior-a-c-d-*`, `restricted-b-expiry`) همه **HARNESS_ERROR/BLOCKED 0** — guardِ `previewExchangeReturnFunding` می‌گوید `scope=ALL`ِ برگشتِ A allocation ندارد و آن را با provenanceِ گمشده یکی می‌گیرد (همان یافتهٔ `deep-e2e-100-blocked-policy-review.md`).
- **موردِ بحرانیِ تکی:** سناریویِ مالک `1,000,000 (600k پولِ واقعی + 100k اعتبار + 300k بدهی) → N=1,000,000,R=500,000` باید به `500k جایگزین + 300k کاهشِ بدهی + 100k بازگشتِ اعتبارِ منشأدار + 100k تسویهٔ انتخابی` ختم شود. تستِ ایزولهٔ `/tmp/check_s11.mjs` رویِ همین SalesService **برایِ `diff=-500k` به `debtReduction 300k + StoreCredit 200k null`** رسید (اختلافِ `diff`ِ اسمی vs اثرگذار).

## چیزی که گم‌شده و می‌خواهم کم‌ریسک درستش کنم

1. `src/shared/discountTransfer.ts` در این ZIP فقط `discountTransferAmounts` و `allocateRialShares` را دارد؛ ولی `src/main/services/SalesService.ts` در خطِ 71-72 `discountTransferPolicyDelta` و `recommendDiscountTransferChoices` را از همین فایل import می‌کند → **کرشِ `not a function`**.
2. `src/shared/returnCreditPolicy.ts` اصلاً وجود ندارد، ولی `SalesService.ts` و `fix-financial-global-credit-return-policy` آن را می‌خواهند → **کرشِ `MODULE_NOT_FOUND`**.
3. به‌همین دلیل `deep-e2e-discount-transfer-ledger` و `fix-financial-global-*` **FAIL** می‌شوند، درحالی‌که منطقِ خالصِ `discountTransferAmounts` (NO/YES/YES_ZERO) به‌تنهایی ۷/۷ حالتِ اضافیِ pure-policyِ من را **PASS** کرده.

## کاری که *من* می‌خواهم انجام بدهم — از تو مشاوره می‌خواهم

می‌خواهم **فقط با کم‌ریسک‌ترین حالتِ ممکن**، بدونِ تغییرِ منطقِ اصلیِ نرم‌افزار، این ناقصی را ۱۰۰٪ سالم کنم:

- تکمیلِ `src/shared/discountTransfer.ts` با دو تابعِ گم‌شده **صرفاً بر اساسِ فرمولِ مصوبِ بالا** (`Δ=R−N`, `min(d,c,Δ)`، سقفِ `c`، چک‌باکسِ `preventExtraRefund`) — بدونِ لمسِ `tender`/`barCode`/`ALL pooled`؛ فقط محاسبهٔ پیش‌نمایشِ تخفیف.
- افزودنِ `src/shared/returnCreditPolicy.ts` با `RETURN_CREDIT_POLICY_VERSION` و `planCreditReturn`ِ **invoice-wide و pooled** (برایِ `ALL`، `saleItemId=null`؛ فقط برایِ بارکدِ محدودِ مدیر، `saleItemId` پر می‌شود) — بدونِ سهم‌بندیِ قلمی برایِ `ALL`، تا `C+D`ِ بعدی pool را بازسازی کند.
- همسان‌سازیِ `SalesService.ts` برایِ استفاده از همین `plan`ِ جدید در `preview` و `commit` (اتمیک، بدونِ mutation در guardِ پیش‌نمایش).
- تستِ هر قدم رویِ **SQLiteِ موقتِ ایزوله** و توقفِ فوری با اولین موردِ مشکوک برایِ گرفتنِ نظرِ مالک.

## از تو دقیقاً چه می‌خواهم

1. **آیا این طرح، کم‌ریسک‌ترین حالتِ ممکن است یا احتمالِ خرابی دارد؟** صادقانه بگو خطرش کجاست و آیا با این طرح منطقِ اصلی خراب می‌شود یا نه.
2. **آیا `discountTransferPolicyDelta` باید دقیقاً `Δ = R_merch − N_merch` (پیش از انتقال) باشد یا تعریفِ snapshotِ `N`ِ دیگری دارد؟** و `recommendDiscountTransferChoices` باید فقط `YES`ِ غیرمجاز را فیلتر کند یا ستارهٔ پیشنهادی هم بدهد؟
3. **برایِ `returnCreditPolicy.ts` چه guardِ idempotency/fingerprintِ دقیقی بگذارم که 13 توقفِ `C+D`ِ گزارشِ README بدونِ mutation و بدونِ شکستنِ `ALL pooled` حل شوند؟**
4. **ترتیبِ قدم‌ها و چک‌لیستِ رگرسیونِ نهایی چیست که 100٪ سالم شود و هیچ رگرسیونِ نقدی/کارتی/بارکدی خارجِ دامنه نشکند؟**

لطفاً **طرحِ دقیقِ قدم‌به‌قدمِ کم‌ریسک** را بده، نه کد. اگر جایی ناامن است، صریح بگو. مالک تاکید می‌کند منطقِ اصلی نباید به هیچ عنوان تغییر کند.

---
*پیوست: ZIPِ آخرین working tree روی `arena/8a852de1-mahak-klad` (آخرین بسته با همهٔ تغییراتِ dirty، بدونِ `node_modules/.git/out/dist`)*
