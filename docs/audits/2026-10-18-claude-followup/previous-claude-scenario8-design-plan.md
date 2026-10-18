# سناریو ۸ و regression: بررسی مستقل و طرح (بدون تغییر در پروژه)

**وضعیت این گزارش:** فقط بررسی و طرح. هیچ فایل سورس، schema، migration، تست یا تنظیمات پروژه تغییر نکرده است. هیچ patch یا ZIP اصلاح‌شده ساخته نشده. هیچ دیتابیس واقعی لمس نشده. همه اجراها روی هارنس موقت (`node:sqlite`) انجام شد.

---

## A) شواهد

### A1. شواهد بررسی‌شده و هش‌ها
- ZIP ارسالی از نو استخراج شد. فهرست کامل: **۱۵۶۷ فایل** با SHA-256. قبل و بعد از همه اجراها یکسان ماند (PROJECT TREE UNCHANGED).
- هش ZIP ارسالی: `18ebe06b3145d51787113ae919a8267698859c867d73cbfd22420ba503f73028`
- هش سورس‌ها:
  - `src/main/services/SalesService.ts` = `9e9dbc16f5b28b1dba96e83cf392b4b35c5f3b9387d257121443f495cfb56277`
  - `src/main/services/ShiftService.ts` = `1a8ba7d96cba5944df68410f4857ce6093e98964e4e970dc00d82c6bdfd43da5`
  - `src/main/services/CustodyService.ts` = `092a03f4abf9082f2563ef1334d81e99cbfe042752dba3e8db211bb12bb20c9b`
- هش گزارش قبلی (`REPORT.md`) `b1a33ed5ca315c160af40dca20e06100a08863cd323aea3103eefda58341d42d` با فایل ثبت‌شده تطبیق داده شد. هش سورس‌ها با `source-sha256.txt` قبلی یکسان است.

### A2. اجرای مستقل (هارنس موقت، خارج از درخت پروژه)

| مورد | نتیجه | یادداشت |
|---|---|---|
| S1 برگشت کامل مختلط (۱۵M = ۲M هدیه + ۱۳M وجه) | **PASS (۶/۶)** | والد ACTIVE، usedAmount=0، ORIGINAL_REVERSED=2M، RETURN_REFUND=13M روی شیفت جاری، اعتبار اضافه ساخته نشد |
| S2 تعویض مختلط | **FAIL** | رد کلی در `SalesService.ts:3548-3551`. کنترل تمام‌نقد با همان پارامترها پذیرفته شد (reg2) |
| S3 دو بار تعویض | **FAIL** (پیش‌شرط) | تعویض اول رد شد؛ زنجیره grandchild ساخته نشد |
| S4 سه قلم (۵M هدیه + ۲۰M وجه) | **PASS (۸/۸)** | تقسیم ۸/۲، ۸/۲، ۴/۱؛ Σوجه=20M، Σهدیه=5M، سقف رعایت شد |
| S5 | **NOT RUN** | در متن ارسالی تعریفی برای «سناریو ۵» نیست؛ در پروژه هم پیدا نشد |
| S6 انقضا (GIFT_CARRY بعد از ۸ روز) | **FAIL** (پیش‌شرط) | GIFT_CARRY ساخته نشد. probe کمکی روی والد: موعد ریشه بعد از برگشت کامل حفظ شد و در روز ۸ رد شد. این probe جای S6 حساب نمی‌شود |
| S8 مراحل ۱-۳ | **FAIL** | مرحلهٔ ۱ رد کلی. مراحل ۲ و ۳ اجرا نشدند |
| S8 مرحله ۴ (برگشت جزئی ۱M از فرزند) | **FAIL** (پیش‌شرط) | فرزندی نیست. کنترل روی والد (نه S8): ۱۳۳٬۳۳۳ DRAFT + ۸۶۶٬۶۶۷ نقد، مطابق انتظار |
| race (finalClose در برابر فروش) | **NOT RUN** | فایل `round3-no-session-race.mjs` در ZIP نیست. تحلیل ایستا در بخش B |
| مرز ۰۵:۰۰ | **NOT RUN** | تستی اجرا نشد. تحلیل ایستا در بخش B |
| debt_first (دو قلم ۵۰۰، پرداخت ۵۰۰، بدهی ۵۰۰) | **PASS (۴/۴)** | کنترل جدید روی هارنس موقت: برگشت ۵۰۰ ⇒ debtReduced=500، نقد صفر، RETURN_REFUND=0 |
| proportional (۵۰۰ = ۳۰۰ هدیه + ۲۰۰ وجه، برگشت ۱۰۰) | **PASS (allocator)** | allocateCreditReturn ⇒ ۶۰ هدیه + ۴۰ وجه. خود proportionalReturn فقط از طریق تست موجود fix-financial-f5-entitlement (PASS) پوشش دارد؛ assertionهای آن را نخواندم |
| ۱۵M برگشت کامل (ریاضی allocator) | **PASS** | ۲M هدیه + ۱۳M وجه |
| ۱۵M برگشت جزئی ۱M (ریاضی allocator) | **PASS** | ۱۳۳٬۳۳۳ + ۸۶۶٬۶۶۷ |
| ۱۵M: ۱M سپس ۱۴M (ریاضی allocator) | **PASS** | سهم تجمعی ۱٬۸۶۶٬۶۶۷ هدیه از ۲M کل. بدون بیش‌برداشت |

### A3. تست‌های موجود پروژه که خودم اجرا کردم (هارنس موقت)

| تست | نتیجه |
|---|---|
| fix-financial-credit-return-provenance | PASS (۱۲/۱۲) |
| fix-financial-credit-funded-exchange-scenario | PASS (۲/۲). این تست **رد تعویض مختلط** را به‌عنوان رفتار فعلی ثبت می‌کند |
| fix-financial-f5-entitlement | PASS |
| fix-s346-custody-foundation | PASS (۲۹) |
| fix-s415-custody-blue-final-close | PASS (۳۰). رد CUSTODY_STALE وقتی شمارش نهایی وسط کار تغییر کند؛ نه race کامل فروش |
| fix-s450-sale-edit-custody-fence | PASS (۳۶) |
| fix-s461-persistent-handover-deadline | PASS (۲۳) |
| fix-financial-goods-ipc-cutover | PASS (۲) |
| fix-s376-unattended-scheduled-recovery | PASS (۴۴). rollover زمان‌بندی‌شده، نه ۰۵:۰۰ ثابت |
| fix-s199-exchange-return-parent-debt | PASS (۶) |
| fix-s197-exchange-nasiyeh-cash-refund | PASS (۱۰) |

### A4. آنچه مستقل بازاجرا نشد
- race واقعی finalClose و فروش هم‌زمان، و بررسی shiftForNow داخل تراکنش.
- مرز ۰۵:۰۰ و منطقه زمانی.
- سناریوی ۵ (تعریف‌نشده).
- سناریوهای ۲، ۳، ۶ و ۸ در شکل کامل خود (پیش‌شرط آن‌ها گارد است).

---

## B) ریشهٔ FAILها و پیش‌شرط‌ها

### B1. گارد عمومی تعویض (ریشهٔ S2، S3، S6، S8)
- **محل:** `src/main/services/SalesService.ts` سطر **۳۵۴۸ تا ۳۵۵۱** داخل runReturn (مسیر createExchange با applyRefund=false).
- **کد:**
  ```ts
  if (!opts.applyRefund && await tx.payment.count({
    where: { invoiceId: invoice.id, voidedAt: null, storeCreditId: { not: null } }
  }))
    throw new BusinessError('تعویضِ خریدی که با اعتبار پرداخت شده فعلاً به تطبیق منشأ توسط مدیر نیاز دارد؛ ...')
  ```
- **اثر:** هر فاکتوری با حتی ۱ ریال پرداخت اعتباری، هیچ تعویضی ندارد. این دقیقاً «رد کلی تعویض» است که دستور آن را ممنوع کرده.
- **تست موجود که این رفتار را قفل کرده:** fix-financial-credit-funded-exchange-scenario (PASS). یعنی با حذف گارد، آن تست **باید** تغییر کند. این تغییر رفتار عمدی است و باید در طرح صریح ثبت شود، نه این‌که تست برای PASS شدن تغییر داده شود.

### B2. مدل داده ناقص است (پیش‌شرط همه)
- در `src/` هیچ‌کدام از GIFT_CARRY، REAL_CASH_CARRY، TRANSFERRED، CREDIT_NOT_REDEEMABLE وجود ندارد.
- `CreditReturnAllocation.kind` در `prisma/schema.prisma` سطر **۲۷۳۹** فقط ORIGINAL_REVERSED | BRANCH | SUPPLEMENT | EXPIRED است.
- وضعیت `StoreCredit.status` (حوالی سطر ۶۵۰ schema) مقدار پیش‌فرض ACTIVE دارد و وضعیت «قفل» ندارد. `DRAFT` در enum هست.
- `createExchange` (`SalesService.ts` حوالی سطر **۶۷۴۱**) یک Payment واحد EXCHANGE_CREDIT به مبلغ min(returnTotal, exchangeTotal) می‌سازد. هیچ تقسیم هدیه/وجه و هیچ allocation یا StoreCredit روی فرزند ساخته نمی‌شود.

### B3. تضاد داخلی در مشخصات S8 (مهم‌ترین نکته برای طرح)
- معیار قبولی ۳ می‌گوید: برگشت کامل فرزند ⇒ **۱۳M وجه** + **۲M شاخهٔ هدیه DRAFT**.
- مرحلهٔ ۳ می‌گوید: والد StoreCredit.id=1 ⇒ **ACTIVE، usedAmount=0**.
- اگر هر دو همزمان درست باشند، بعد از برگشت کامل **۲M هدیهٔ ACTIVE روی والد + ۲M DRAFT روی شاخه** = **۴M قابل‌خرج از یک ۲M اصلی**. این دقیقاً دوبارخرجی است که S8 باید جلوی آن را بگیرد.
- کد فعلی یکی را انتخاب می‌کند: برگشت کامل ⇒ ORIGINAL_REVERSED (والد ACTIVE، بدون شاخه). reg1 همین را PASS کرد. پس برای برگشت کامل «یکی از دو» درست است، نه هر دو.
- **پیشنهاد:** فقط یک ابزار حامل هدیه داشته باشیم. برگشت کامل ⇒ همان والد احیا شود (بدون DRAFT جدید)؛ برگشت جزئی ⇒ شاخهٔ DRAFT با موعد ریشه. این تصمیم مالک است (بخش F).

### B4. race و مرز شیفت/حضانت (ایستا، NOT RUN)
- `SalesService.ts` حوالی سطر **۳۷۸۱**: `shiftService.currentId(tx, …)` درون تراکنش صدا زده می‌شود.
- `ShiftService.ts` سطرهای **۶۷۱ تا ۶۸۵** (shiftForNow) و **۶۸۸ تا ۶۹۷** (currentId): وقتی custody فعال است و fence نیست، `custodyService.isGoverned()` و `status()` را صدا می‌زنند.
- `CustodyService.ts` سطرهای **۱۲۳۱ تا ۱۲۳۹** (isGoverned) و **۱۲۴۸** (status): از کلاینت سراسری `prisma` استفاده می‌کنند، نه `tx`. پس وضعیت شیفت داخل تراکنش بازسنجی نمی‌شود.
- در مقابل، `assertFenceInTx` (`CustodyService.ts` سطرهای **۴۴۸۷ تا ۴۴۹۶**) یک `updateMany` شرطی روی epoch و activeShiftId داخل `tx` می‌زند. این الگوی درست است و باید برای همه نویسنده‌های مالی اجباری شود.
- `ipc/index.ts` سطرهای **۲۱۵ تا ۲۳۰** (withSessionActor): وقتی custody فعال نیست، از `shiftService.currentStaffId()` بدون fence استفاده می‌شود. یعنی مسیر legacy همچنان race پذیر است.
- `finalClose` (`CustodyService.ts` سطر **۳۰۰۲**) داخل `tx` و با `assertFenceInTx` (سطر **۳۰۴۱**) است. تست fix-s415 فقط رد شدن شمارش قدیمی را ثابت می‌کند، نه race کامل فروش.

### B5. مرز ۰۵:۰۰ (ایستا، NOT RUN)
- `CustodyService.ts` سطرهای **۱۶۶ تا ۱۷۱** (cutoverRolloverAt): `setHours(0, dayCutoverMinute)`. پیش‌فرض ۳۰۰ دقیقه = ۰۵:۰۰ (`src/shared/receipt.ts` سطر ۱۵۶). با `out <= now` به روز بعد می‌رود.
- برای **جلسات زمان‌بندی‌شده** قاعده فرق می‌کند: `scheduledEnd + overtimeMaxMinutes` (سطرهای **۲۸۶ تا ۲۹۱**). پس «۰۵:۰۰» فقط برای جلسات legacy و بدون برنامه است.
- ریسک: تابع از منطقهٔ زمانی فرایند استفاده می‌کند (setHours)، نه از منطقهٔ تنظیمی. باید روی ماشین مشتری تست شود.

### B6. سیاست‌ها
- `proportional`: allocateCreditReturn (`src/shared/creditReturnProvenance.ts` سطرهای **۶ تا ۳۵**) با تقسیم تجمعی و floor: مثال ۵۰۰/۳۰۰/۲۰۰ و برگشت ۱۰۰ ⇒ ۶۰/۴۰. درست است.
- `debt_first`: debtFirstReturn در `src/shared/returnEntitlement.ts` سطر **۳۹** و planCreditReturn (`CreditReturnService.ts` سطرهای **۶۴ تا ۶۶**): اول بدهی کم می‌شود، بقیه سهم. کنترل من PASS شد.

---

## C) طرح فنی پیشنهادی (اعمال نشده)

### C1. مدل داده و رابطهٔ ریشه/فرزند
- **StoreCredit:** وضعیت جدید `LOCKED` (فقط برای شاخه‌های منتقل‌شده به فرزند). findRedeemable و create آن را با NOT_REDEEMABLE رد می‌کنند (`StoreCreditService.ts` حوالی سطرهای ۱۰۰۸ تا ۱۰۳۸).
- **CreditReturnAllocation.kind:** افزودن `TRANSFERRED` (انتقال از والد به فرزند در تعویض). ستون‌های parentCreditId، rootCreditId، successorCreditId از قبل هستند.
- **Payment روی فرزند:** دو ردیف جدا با destination متمایز:
  - `GIFT_CARRY` (سهم هدیه) با storeCreditId ⇒ همان `LOCKED`.
  - `REAL_CASH_CARRY` (سهم وجه) بدون StoreCredit؛ فقط دفتر.
  - این پاسخ اصل ۱ است: سهم‌ها قابل‌ردیابی و جدا می‌مانند.
- **ریشه:** rootCreditId همیشه به اولین هدیهٔ اصلی اشاره کند. originOf (`CreditReturnService.ts` سطرهای ۸۸ تا ۱۲۵) همین زنجیره را دنبال می‌کند و تغییری لازم ندارد.

### C2. قفل و آزادسازی
1. **تعویض:** والد USED می‌ماند. سهم هدیه روی فرزند LOCKED می‌شود (بدون قابلیت خرج). سهم وجه فقط دفتر است.
2. **برگشت کامل فرزند:**
   - سهم وجه ⇒ RETURN_REFUND روی شیفت جاری و refundAmount (حداکثر = سهم وجه).
   - سهم هدیه ⇒ یا **احیای والد** (ORIGINAL_REVERSED، بدون DRAFT جدید) یا **DRAFT جدید** (والد USED می‌ماند). **فقط یکی** (بخش B3 و F1).
3. **برگشت جزئی فرزند:** allocateCreditReturn سهم هدیه و وجه را تقسیم می‌کند. سهم هدیه ⇒ شاخهٔ BRANCH با status=DRAFT و expiresAtExact ریشه. سهم وجه ⇒ بازپرداخت نقدی یا کاهش بدهی.
4. **تحویل:** confirmCreditDelivery (`ReturnEntitlementService.ts`) با شاهد (تحویل کالا یا شاهد بانکی) DRAFT را فعال می‌کند. هدیه هرگز پول نقد یا OVERPAY نیست.

### C3. migration افزایشی و سازگار با داده‌های قدیمی
- فقط ADD VALUE و ستون/ایندکس جدید؛ هیچ UPDATE روی داده‌های قدیمی.
- ردیف‌های قدیمی kind و status دارند و تغییر نمی‌کنند.
- Payment قدیمی بدون destination جدید همان مسیر فعلی را دارد.
- تست migration فقط روی **کپی** دیتابیس و با BackupService پیش از هر تغییر واقعی (اصل ۹).

### C4. برگشت کامل/جزئی و گرد کردن
- سهم هدیه به‌صورت **تجمعی و floor** (همان allocateCreditReturn): جمع سهم‌ها همیشه برابر سهم کل است و هیچ ریالی گم یا اضافه نمی‌شود.
- مثال‌های تطبیق‌شده: ۱M ⇒ ۱۳۳٬۳۳۳ + ۸۶۶٬۶۶۷؛ ۱M سپس ۱۴M ⇒ ۱٬۸۶۶٬۶۶۷ تجمعی.

### C5. سقف وجه و سقف هدیه
- Σ REAL_CASH_CARRY برگشت‌داده‌شده ≤ Σ سهم وجه (هرگز بیشتر).
- Σ(هدیهٔ احیاشده یا DRAFT) ≤ مبلغ هدیهٔ ریشه منهای مصرف‌شده.
- این دو invariant باید داخل همان تراکنش برگشت چک شوند، نه فقط در گزارش.

### C6. انقضای ریشه
- همه نسل‌ها (فرزند، شاخه، شاخهٔ شاخه) expiresAt ریشه را کپی می‌کنند (originalExpiresAt در allocation). کد فعلی این کار را می‌کند.
- اگر ریشه منقضی باشد، برگشت کامل ثبت می‌شود ولی DRAFT فعال نمی‌شود (EXPIRED).

### C7. مرز تراکنش، شیفت و حضانت
- همه نویسنده‌های مالی (فروش، تعویض، برگشت، finalClose) باید assertFenceInTx را داخل tx صدا بزنند، نه فقط وقتی custody فعال است.
- isGoverned و status باید نسخهٔ client-پذیر داشته باشند تا داخل tx خوانده شوند.
- مرز روز مالی: rolloverAt برای جلسات زمان‌بندی‌شده از scheduledEnd + overtime می‌آید؛ برای legacy از dayCutoverMinute (۰۵:۰۰). هر دو باید در یک تابع جمع شوند و منطقهٔ زمانی تنظیمی استفاده شود.
- هیچ تعویض یا برگشتی بعد از بستن شیفت بدون مجوز مدیر ثبت نشود (periodLockService.assertOpen موجود است).

---

## D) فایل‌ها و سرویس‌های درگیر

| مسیر | محدوده تقریبی | تصمیم | اثر بر داده‌های قبلی | راه برگشت |
|---|---|---|---|---|
| src/main/services/SalesService.ts | ۳۵۴۸-۳۵۵۱ | حذف گارد کلی؛ جایگزینی با مسیر TRANSFERRED | رفتار تعویض مختلط تغییر می‌کند؛ تست funded-exchange باید صریح به‌روز شود | feature flag یا revert |
| src/main/services/SalesService.ts | حوالی ۶۷۴۱ | تقسیم Payment فرزند به GIFT_CARRY و REAL_CASH_CARRY | فقط فرزندهای جدید | revert |
| src/main/services/CreditReturnService.ts | ۲۸-۸۲، ۱۳۲-۲۴۰ | حالت TRANSFERRED و سقف تجمعی | فقط برگشت‌های جدید | revert |
| src/main/services/StoreCreditService.ts | حوالی ۱۰۰۸-۱۰۳۸ | وضعیت LOCKED در lookup | فقط اعتبارهای جدید | revert |
| prisma/schema.prisma | حوالی ۲۷۳۹ | مقدار TRANSFERRED در kind و LOCKED در status (داده‌ای نمی‌شکند) | ستون/مقدار جدید | migration برگشت (حذف مقدار فقط اگر ردیفی نداشته باشد) |
| src/main/services/ShiftService.ts | ۶۷۱-۶۹۷ | currentId و shiftForNow با tx | تغییر رفتار legacy custody-off | feature flag |
| src/main/services/CustodyService.ts | ۱۲۳۱-۱۲۵۶، ۱۶۶-۱۷۱، ۲۸۶-۲۹۱، ۴۴۸۷-۴۴۹۶ | isGoverned و status با client؛ یکپارچه‌سازی مرز روز | تأثیر روی rollover | feature flag |
| src/main/ipc/index.ts | ۲۱۵-۲۳۰، ۶۸۷-۶۹۷، ۷۵۸-۷۶۶ | مسیر fence برای legacy | رفتار legacy | feature flag |
| src/shared/creditReturnProvenance.ts | ۶-۳۵ | بدون تغییر (درست است) | - | - |
| src/shared/returnEntitlement.ts | ۳۹-۵۰ | بدون تغییر (درست است) | - | - |
| src/main/services/ReturnEntitlementService.ts | تحویل و شاهد | بدون تغییر (فقط مسیر جدید) | - | - |

---

## E) ماتریس پذیرش

| سناریو | ورودی | invariant | خروجی مورد انتظار | وضعیت فعلی |
|---|---|---|---|---|
| S1 برگشت کامل مختلط | فرزند ۱۵M (۲M هدیه + ۱۳M وجه)، برگشت کامل نقد ۱۳M | Σوجه ≤ 13M؛ Σهدیه ≤ 2M؛ یک ابزار هدیه | ۱۳M نقد؛ هدیه یا احیای والد یا DRAFT، نه هر دو | **PASS** (برای والد؛ مسیر فرزند هنوز نیست) |
| S2 تعویض مختلط | والد ۱۵M مختلط، جایگزین ۱۵M | فرزند با GIFT_CARRY و REAL_CASH_CARRY؛ والد USED؛ allocation TRANSFERRED | فرزند ساخته شود؛ هیچ اعتبار قابل‌خرج | **FAIL** (گارد سطر ۳۵۵۱) |
| S3 دو بار تعویض | فرزند تعویض‌شده دوباره | rootCreditId=1 در همه نسل‌ها | نوه با root=1 | **FAIL** (پیش‌شرط S2) |
| S4 سه قلم | ۵M هدیه + ۲۰M وجه، برگشت سه قلم | Σوجه=20M؛ Σهدیه=5M؛ تجمعی | ۸/۲، ۸/۲، ۴/۱ | **PASS** |
| S5 | تعریف‌نشده | - | - | **NOT RUN** |
| S6 انقضا | GIFT_CARRY بعد از ۸ روز | موعد ریشه | رد بعد از ۷ روز | **FAIL** (پیش‌شرط S2؛ probe والد PASS) |
| S8 مراحل ۱-۳ | همان S1 + S2 + تلاش خرج id=2 | بازخرج ممنوع؛ هیچ اعتبار بی‌شاهد | همان S2 + S1 | **FAIL** |
| S8 مرحله ۴ | ۱M از فرزند | ۱۳۳٬۳۳۳ DRAFT + ۸۶۶٬۶۶۷ وجه | دقیقاً همین | **FAIL** (پیش‌شرط)؛ کنترل روی والد PASS |
| debt_first | دو قلم ۵۰۰، پرداخت ۵۰۰، بدهی ۵۰۰، برگشت ۵۰۰ | نقد صفر؛ بدهی کم شود | debtReduced=500، RETURN_REFUND=0 | **PASS** |
| proportional | ۵۰۰ = ۳۰۰ هدیه + ۲۰۰ وجه، برگشت ۱۰۰ | ۶۰ + ۴۰ | ۶۰ هدیه، ۴۰ وجه | **PASS** (allocator) |
| race | finalClose و فروش هم‌زمان | هیچ تراکنش مالی بدون fence معتبر | فروش رد یا close رد؛ نه هر دو | **NOT RUN** |
| ۰۵:۰۰ | برگشت در ۰۴:۵۹:۵۹ و ۰۵:۰۰:۰۰ | شیفت و روز مالی درست | شیفت قبلی یا بعدی طبق rolloverAt | **NOT RUN** |

---

## F) ریسک‌ها و سؤال‌هایی که مالک باید تصمیم بگیرد

1. **حامل هدیه در برگشت کامل (بخش B3):** احیای والد (ORIGINAL_REVERSED) یا DRAFT جدید؟ هر دو با هم دوبارخرج است. پیشنهاد: احیای والد، چون کد فعلی همین است و تست‌های موجود آن را قفل کرده‌اند. پیامد: روی برگشت کامل، بارکد قبلی دوباره فعال می‌شود. اگر مالک بارکد جدید بخواهد، والد باید USED بماند و شاخه ساخته شود.
2. **آیا id=2 باید واقعاً رکورد StoreCredit باشد؟** گزینه A: رکورد LOCKED در لحظهٔ تعویض ساخته شود. گزینه B: فقط دفتر تا برگشت فرزند، بعد رکورد. A ردیابی بهتر دارد ولی یک بارکد قفل‌شده در سیستم هست. B ساده‌تر است ولی مرحلهٔ ۲ S8 (lookup id=2) را بی‌معنی می‌کند.
3. **آیا انقضای سهم هدیهٔ فرزند از لحظهٔ اصلی ریشه است؟** مشخصات می‌گوید بله (از ریشه). کد فعلی هم همین است. فقط تأیید لازم است.
4. **تعویض با مابه‌التفاوت منفی و سهم وجه:** آیا ۱۳M وجه باید نقد بماند یا به کارت برگردد؟ سیاستی است؛ کد فعلی از refundMode پیروی می‌کند.
5. **برگشت فرزند پس از بستن شیفت والد:** آیا مجاز است؟ اگر نه، مدیر باید تأیید کند یا رد کند.
6. **مرز ۰۵:۰۰:** آیا برای جلسات زمان‌بندی‌شده هم ۰۵:۰۰ مرز مالی است، یا scheduledEnd + overtime؟ کد فعلی دومی را دارد.
7. **سناریوی ۵:** تعریفش را بفرستید.
8. **تغییر تست موجود:** fix-financial-credit-funded-exchange-scenario رد تعویض را قفل کرده. با اجرای طرح، این تست باید عمداً به‌روز شود، با تصمیم شما.
9. **ریسک legacy custody-off:** مسیر currentStaffId بدون fence است. اگر custody فعال نیست، race همچنان باز است. باید تصمیم گرفته شود که آیا fence برای فروش و تعویض مالی اجباری شود.

---

## G) تأیید
- هیچ فایل پروژه‌ای تغییر نکرد. درخت استخراج‌شده قبل و بعد از همه اجراها با ۱۵۶۷ هش یکسان است.
- هیچ migration یا patch اعمال نشد.
- هیچ ZIP سورس اصلاح‌شده‌ای ساخته نشد.
- هیچ dependency نصب نشد.
- تست‌ها فقط روی هارنس موقت اجرا شدند و هیچ دیتابیس واقعی لمس نشد.
- یادآوری: در اجرای قبلی فایل‌های `tests/scenario8/` در یک کپی کاری ساخته شده بودند (نه در ZIP اصلی). کپی تازه از ZIP اصلی استخراج شد و آن فایل‌ها در آن نیستند.
