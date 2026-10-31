# تکمیل شواهد بررسی MAHAK-KLAD (۲۰۲۶-۱۰-۱۸، نوبت پیگیری)

همهٔ اجراها روی کپی موقت ZIP و دیتابیس موقت SQLite هارنس (`node:sqlite`، Node v22.23.1). هیچ سورس، schema، migration یا ZIP تغییر نکرد.

## دسترسی به لینک‌ها
- صفحه‌های `github.com/.../tree` و `.../blob` از طریق اتصال GitHub ورک‌اسپیس باز **نشدند** (اتصال وصل نیست).
- همان فایل‌ها از `raw.githubusercontent.com` با موفقیت خوانده شدند: README.md، previous-claude-scenario8-design-plan.md، source-sha256-from-previous-report.txt، S5-partial-mixed-original.mjs، S5-partial-mixed-original.stdout.txt، S5-scenario-common.mjs، S5-partial-mixed-repo-probe.mjs، round3-no-session-race.mjs، race-run-timeout.stdout-stderr.txt، no-session-control.stdout-stderr.txt.
- صفحهٔ فهرست پوشه (tree) باز نشد؛ فقط فایل‌های نام‌برده بررسی شدند.

## ۱. تطبیق نسخه: PASS (مستقل)
| فایل | هش ZIP پیوست‌شده | هش قبلی | نتیجه |
|---|---|---|---|
| ZIP | 18ebe06b…3f73028 | 18ebe06b…3f73028 (گزارش قبلی A1) | یکسان |
| SalesService.ts | 9e9dbc16…cfb56277 | 9e9dbc16…cfb56277 | یکسان |
| ShiftService.ts | 1a8ba7d9…bfd43da5 | 1a8ba7d9…bfd43da5 | یکسان |
| CustodyService.ts | 092a03f4…b9c12bb20c9b | 092a03f4…b9c12bb20c9b | یکسان |
تعداد فایل درخت: ۱۵۶۷ (برابر گزارش قبلی).

## ۲. S5 با مبلغ اصلاح‌شده: PASS (مستقل، اجرای جدید با برچسب `5-corrected`)
- ورودی: فروش ۱۵M (قلم ۵M + قلم ۱۰M)، ۲M هدیه + ۱۳M وجه؛ برگشت جزئی قلم ۵M با `refundAmount=4,333,334`.
- خروجی: برگشت ثبت شد؛ `RETURN_REFUND=4,333,334` روی شیفت جاری؛ `creditRestored=666,666`؛ شاخهٔ جدید StoreCredit با `status=DRAFT`، `amount=666,666`، allocation از نوع `BRANCH` با `parentCreditId=rootCreditId=والد`؛ موعد انقضای شاخه = موعد ریشه؛ والد `USED` ماند؛ جمع ۶۶۶٬۶۶۶ + ۴٬۳۳۳٬۳۳۴ = ۵٬۰۰۰٬۰۰۰.
- شاخه قابل‌خرج نیست: `findRedeemable` رد کرد («پیش‌نویس است و صادر نشده»). کد کامل اعتبار در خروجی خطا دیده نشد.
- اجرای تاریخی ۴٬۳۳۳٬۳۳۳ (فایل قبلی) رد شده بود و PASS حساب نمی‌شود؛ دوباره اجرا نشد.
- نکته: `goodsReceiptRequired=1` و موجودی برنگشت (۹ ماند)؛ یعنی دریافت فیزیکی کالا مستقل و معلق است، مطابق اصل «تحویل کالا ابزار مستقل است».

## ۳الف. race بین finalClose و عملیات مالی: FAIL (مستقل، ۴ اجرای قطعی، تکرارپذیر)
- علت NOT RUN قبلی: کد خروج 13 در Node یعنی top-level await حل‌نشده (نه kill شدن با timeout که 124 می‌داد). **ناسازگاری شواهد:** stderr قبلی خط ۷ را با `try{await run(mode)}` نشان می‌دهد ولی `round3-no-session-race.mjs` موجود در پوشهٔ شواهد تابع `run` ندارد؛ پس فایل اجراشده با فایل آرشیوشده یکی نیست و علت دقیق hang قبلی قابل بازسازی نیست. این فایل در ZIP هم نیست.
- پروب جدید `race2.mjs` (همان setup، با watchdog و `Promise.race` تا gate نتواند بی‌صدا hang کند). gate با جایگزینی موقت `shiftService.shiftForNow` در حافظهٔ فرایند تست، بدون تغییر سورس.
- مسیر: `IPC.saleReturnCorrection` → `returnReconcileVoid` (SalesService.ts ~9250) که `shiftService.shiftForNow()` را **بیرون از تراکنش و بدون fence** صدا می‌زند؛ fenceی که `withSessionActor` می‌دهد در این مسیر داخل tx بازسنجی نمی‌شود و `recordCashMovement` هم بسته‌بودن شیفت را چک نمی‌کند.
- نتیجه در هر ۴ اجرا: عملیات به gate رسید (shift=2، ACTIVE)، `finalClose` موفق شد (shift 2 بسته، state=NO_SESSION، epoch 3→4)، سپس عملیات قدیمی **commit شد** و `CASH_IN 600,000` روی shift 2 ساخت، ۵ms **بعد از** closedAt آن شیفت. expectedCash شیفت بسته‌شده ۰ ماند، یعنی این گردش در بستن لحاظ نشده: CashMovement نامعتبر.
- کنترل ترتیبی (عملیات اول، finalClose بعد): هر دو موفق، و expectedCash شیفت 2 = 600,000. یعنی رفتار مجاز «اول commit، بعد close که آن را لحاظ کند» درست کار می‌کند؛ مشکل فقط ترتیب معکوس است.
- محدودیت: فقط مسیر اصلاح جبرانی برگشت آزموده شد. فروش/برگشت/تعویض با `custodyFence` از `assertFenceInTx` داخل tx عبور می‌کنند و انتظار می‌رود رد شوند، ولی در این نوبت اجرا نشدند.

## ۳ب. مرز rollover: PASS برای گیت rollover حضانت (مستقل)؛ مسیر بدون custody: NOT RUN
- رفتار واقعی (سورس + اجرا): `rolloverAt` هنگام باز شدن segment محاسبه و ذخیره می‌شود.
  - جلسهٔ legacy/بی‌برنامه: `setHours(0, dayCutoverMinute)` با پیش‌فرض ۳۰۰ = ۰۵:۰۰ **به ساعت محلی فرایند**.
  - جلسهٔ زمان‌بندی‌شده (templateId + scheduledEndAt): `scheduledEnd + overtimeMaxMinutes`، و ۰۵:۰۰ در آن نقشی ندارد.
- اجرا با ساعت جعلی در دو TZ (Asia/Tehran و UTC)، سه حالت:
  | حالت | rolloverAt | ‎-1ms | دقیقاً rolloverAt |
  |---|---|---|---|
  | legacy باز در ۱۴:۰۰ | فردا ۰۵:۰۰ محلی (Tehran=01:30Z، UTC=05:00Z) | ACTIVE | NO_SESSION، closedAt=rolloverAt |
  | legacy باز در ۰۴:۵۹:۳۰ | همان روز ۰۵:۰۰ (۳۰ ثانیه بعد) | ACTIVE | NO_SESSION، closedAt=rolloverAt |
  | scheduled ۱۳:۵۵–۱۴:۰۵ + overtime 30 | ۱۴:۳۵ | ACTIVE | NO_SESSION، closedAt=rolloverAt |
  بعد از مرز، `actorForFinancialOperation` با `CUSTODY_AUTH_REQUIRED` رد کرد.
- یافته: مرز legacy به TZ سیستم‌عامل وابسته است (همان ساعت دیواری، لحظهٔ مطلق متفاوت). اگر TZ ماشین مشتری درست نباشد، مرز جابه‌جا می‌شود.
- NOT RUN: عملیات مالی در حال اجرا که از مرز rollover عبور کند (هم‌خانوادهٔ race بالا)، و حالت custody خاموش (ShiftService از STALE مبتنی بر روز استفاده می‌کند، نه cutover).

## ۴. وضعیت فیچر S2/S3/S6/S8: هنوز حل‌نشده (مستقل، ایستا)
- گارد عمومی هنوز در `SalesService.ts` سطر ۳۵۴۸–۳۵۵۱ هست (هش سورس هم تغییر نکرده).
- `GIFT_CARRY`، `REAL_CASH_CARRY`، `TRANSFERRED`، `CREDIT_NOT_REDEEMABLE`: صفر رخداد در `src/` و `prisma/schema.prisma`.
- پس S2/S3/S6/S8 پیاده‌سازی نشده‌اند. نتیجه‌های FAIL قبلی معتبرند؛ رد تعویض به‌خاطر گارد PASS نیست. این‌ها دوباره اجرا نشدند چون سورس یکسان است.

## ۵. مستقل در برابر نقل‌شده
- **مستقلاً تأیید شد (این نوبت):** هش ZIP و سه سورس؛ S5 اصلاح‌شده؛ race (FAIL) و کنترل ترتیبی؛ مرز rollover legacy/scheduled در دو TZ؛ وجود گارد و نبود مدل داده.
- **فقط نقل از گزارش قبلی (بازاجرا نشد چون هش یکسان است):** S1، S4، debt_first، proportional = PASS؛ S2، S3، S6، S8 = FAIL؛ PASS تست‌های موجود پروژه (fix-financial-*، fix-s346، fix-s415، …).
- **اصلاح بر گزارش قبلی:** آن گزارش S5 را «تعریف‌نشده/NOT RUN» نوشته بود؛ اکنون با تعریف کاربر اجرا و PASS شد. همچنین «timeout» در خروجی race در واقع exit 13 است.

## ۶. محدودیت‌های باقی‌مانده
- race فقط برای `saleReturnCorrection`؛ سایر نویسنده‌های مالی بدون fence (مثلاً مسیرهای ۸۷۲۰ و legacy `currentStaffId`) آزموده نشدند.
- عبور عملیات در حال اجرا از مرز rollover و حالت custody خاموش اجرا نشد.
- ساعت جعلی فقط `Date` را عوض می‌کند؛ رفتار روی ویندوز/Electron و دیتابیس واقعی Prisma اجرا نشد (فقط هارنس `prismaLite`).
- فایل اجراشدهٔ race قبلی با نسخهٔ آرشیوی یکی نیست.
- فهرست کامل پوشهٔ GitHub دیده نشد.

## ۷. تأیید
- درخت ZIP استخراج‌شده قبل و بعد از همه اجراها: ۱۵۶۷ هش یکسان (TREE_UNCHANGED). هش ZIP بدون تغییر.
- کپی اجرا فقط پوشهٔ `tools/followup-tmp/` (پروب‌های جدید) را اضافه داشت؛ بقیه byte-به-byte یکسان.
- هیچ دیتابیس واقعی لمس نشد؛ هر اجرا در `mkdtemp` جدا.
- هیچ patch، migration یا ZIP اصلاح‌شده ساخته نشد؛ پروب‌های این بسته فقط ابزار آزمون‌اند.
