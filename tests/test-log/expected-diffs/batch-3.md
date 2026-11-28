# دستهٔ ۳ — قفل‌ها، مجوزها و کدها (دفتر تفاوت‌های خواسته‌شده)

- **کامیت پایهٔ دسته:** آخرین کامیت دستهٔ ۲ (`787352ef061352a8ac29672a235b10ca6d82c485`)؛ نگهبان همچنان از `f6c5db0` می‌سنجد (`--batch 3`).
- **قاعده:** بندی که این‌جا سطر «تفاوت» ندارد، ۰ تفاوت دارد؛ جز متن یا دیده‌ای که خود بند نام برده است.
- **آزمون طلایی:** برابر (قفل‌ها چیزی حساب نمی‌کنند و به حساب پول دست نمی‌زنند).
- **معیار پایان (معماری، دستهٔ ۳):** آزمون‌های شمار کلید (`plan1405-gate-catalog.mjs`، `plan1405-gate-decision.mjs` و `plan1405-password-fields.mjs`) یک بار و با عدد نهایی عوض شده‌اند؛ آزمون‌های کد، مجوز زمان‌بندی‌شده و راه دور سبزند، جز سطرهای اجازه‌دار.

| بند | تفاوت خواسته‌شده | سطر آزمون موجود که عوض می‌شود | آزمون تازه |
| --- | --- | --- | --- |
| گام ۱: ۴-۲۵، ۴-۴۸، ۴-۷۳، ۴-۷۹ و ۴-۸۰ (ورودی‌های کاتالوگ) | پنج شناسهٔ کار تازه در `gateCatalog.ts`، کنار کارهای هم‌خانواده: `custody.open-outside-shift` «باز کردن صندوق بیرون از شیفت» (۴-۲۵؛ «بستن صندوق»)، `return.after-deadline` «برگشت و تعویض پس از مهلت» (۴-۴۸؛ «برگشت و تعویض»؛ رمز دوم و سوم جدای خودش)، `credit.third-print-seller` «چاپ بار سوم گواهی اعتبار به دست فروشنده» (۴-۷۳؛ «مدیریت اعتبار»)، `cheque.void-pending` «ابطال چک در جریان یا برگشتی» (۴-۷۹؛ STRICT، مادر «نسیه») و `cheque.settle` «تسویهٔ چک» (۴-۸۰؛ همان کلید `act-cheque-replace` و همان رمز «جایگزینی چک»، STRICT، مادر «نسیه»). چهار کلید تازهٔ `act-*` در `panels.ts`: هر کدام یک ردیف «قفل کار» حساس، پیش‌فرض روشن، کد «حساس». شمارها: ۸۰ ⇐ ۸۴ کلید، ۴۸ ⇐ ۵۳ شناسهٔ کار، ۳۶ ⇐ ۴۰ کلید `act-*`، ۴۳ ⇐ ۴۷ «حساس»، `REMOTE_PANELS` ۹۲ ⇐ ۹۷ (زیر سقف ۱۲۸ هاب). هیچ‌کدام تا دستهٔ خودش (۵، ۶ و ۸) صدا زده نمی‌شود؛ پس هیچ رفتاری عوض نمی‌شود. در ابزارها و آزمون‌ها فقط همین شمارها و نام‌های تازه در فهرست قفل‌ها | `plan1405-gate-catalog.mjs:27`، `:30`، `:31`، `:43`، `:45` (§۸-۴) و با اجازهٔ مالک (TL-D9): `:48` (strictهای دارای مادر ۱۶ ⇐ ۱۸)، `:73` (۹۲ ⇐ ۹۷) و متن‌های هم‌عدد `:6`، `:41`، `:71`؛ `plan1405-gate-decision.mjs:66` (§۸-۴) و متن‌های `:4`، `:65`، `:69` (TL-D9)؛ `plan1405-remote-grants.mjs:144`، `:170`، `:188` (۳۶ ⇐ ۳۱ سیاست ساختگی) و متن‌های `:8`، `:139`، `:165`؛ `remote-panels-desktop.mjs:17` (TL-D9) | `tl-4-25-48-73-79-80-catalog.mjs` |
| ۴-۸ | «ثبت یادداشت» بازبینی بازیابی Shift قدیمی از راه صفحه ذخیره می‌شود: در `reviewLegacyRecovery` (`CustodyService.ts`) `actor?.userId ?? manager!.userId` ⇐ `actor ? actor.userId : manager!.userId` (نشست مدیر شناسهٔ تهی دارد و `??` به `manager` تهی می‌رسید؛ خطای کلی «… چیزی ذخیره نشد»). یادداشت با `GLOBAL_MANAGER` و `MANAGER_SESSION`، رویداد `LEGACY_RECOVERY_REVIEWED` و ردیف ممیزی ثبت می‌شود؛ راه رمز مدیر همان. در ابزارها: ۰ تفاوت (هیچ ابزاری این کانال را صدا نمی‌زند) | — | `tl-4-8-legacy-review-note.mjs` |
| ۴-۷ | گزارش مدیر حضانت (`CustodyService.ts` `report`) فیلد فقط‌خواندنی `legacyRecoveriesUnreviewed`: بازیابی‌هایی که هیچ ردیفی در `LegacyShiftRecoveryReview` ندارند، بی بازهٔ تاریخ (تا ۵۰۰ ردیف آخر، صفحهٔ همان گزارش)، به همان شکل ردیف‌های `legacyRecoveries`؛ `legacyRecoveries`، `legacyRecoveryReviews`، خلاصه و خروجی حسابرسی همان. صفحه (`CustodyAdminChip.tsx`): کادر زرد، جدول و فرم «ثبت یادداشت بازبینی» فقط از همین فیلد (پس از ثبت یادداشت، آن بازیابی از دید می‌رود و فرم بازیابی بی‌یادداشت بعدی را برمی‌دارد)؛ دکمهٔ بستهٔ «سوابق بازیابی‌ها (n)» با جدول بازیابی‌های بازهٔ گزارش و «یادداشت‌های بازبینی» (زمان، بازیابی، بازبین یا «نشست مدیر»، یادداشت)، فقط خواندنی؛ جدول «آخرین بازبینی‌های ثبت‌شده» به همین سوابق رفت. هشدار نوار بالا (`CustodyChip.tsx`) و «آخرین شمارش‌ها» دست نخوردند. در ابزارها: ۰ تفاوت | — | `tl-4-7-legacy-recovery-history.mjs` |
| ۴-۲۸ | دو مدت مجوز راه دور و دو مدت کد، هر کدام ۱ تا ۱۰۰۰ دقیقه (`durations.ts`): کلید قدیمی `remoteGrantMinutes` «مدت مجوز راه دور — ماژول‌های معمولی» شد و کلید تازهٔ `remoteSensitiveGrantMinutes` برای «ماژول‌های پولی و حساس» آمد؛ پروندهٔ سه‌کلیدی قدیمی سالم خوانده می‌شود و مدت راه دور قبلی برای هر دو می‌ماند؛ نوشتن همیشه چهار کلید. مجوز گوشی یا ربات: قسمت معمولی مدت اول و قسمت پولی یا تازه مدت دوم (`grantDurationMs` در `RemoteGrantRegistry.ts`، مرز `codeSectionOfPanel`، سیم‌کشی `CloudSyncService.ts`)؛ «قفل کار» همان یک بار و پنجرهٔ بلیتش حداکثر ۶۰ دقیقه (`lockDurationMs`؛ در کد کار و پنجرهٔ رمز هم). سقف مجوز در شش جا ۶۰ ⇐ ۱۰۰۰ دقیقه: `RemoteGrantRegistry.ts`، `grantApprovalCoordinator.ts`، `experimentalHubChild.ts`، `experimentalHubSupervisor.ts`، `experimentalRemoteCommandIssuer.ts` و سیاست `botRemoteBridge.ts` (TL-D10). سقف سخت ۶۰ دقیقهٔ نشست (`panelSession.ts`) دست نخورد: `openRenewingPanel` در `unlocks.ts` نشستِ مجوز یا کدِ بلندتر را ۵ دقیقه پیش از سقف همان لحظه بسته و دوباره باز می‌کند، فقط اگر همان نشست است، مجوز بی تمدید بی‌کاری معتبر است و ساعت بیش از ۲ دقیقه جهش نکرده؛ نشست مدیر همان پنجره باز ⇐ ۳۰ ثانیه بعد؛ نشستِ بسته‌شده هرگز دوباره ساخته نمی‌شود. صفحه‌ها: دو خانهٔ مدت راه دور با یک کادر رمز مدیر (`RemoteGrantControls.tsx`؛ شمار کادرهای رمز همان)، «۱ تا ۱۰۰۰» در آن و در `OneTimeCodesSettings.tsx`؛ «وضعیت سیستم» گوشی چهار ردیف (`phoneReportCatalog.ts` اندازهٔ ۳ ⇐ ۴ و زیرنویس «چهار مدت …»)؛ عنوان رویداد `DURATIONS_CHANGED` همان عنوان تازهٔ هر مدت. بی تغییر: `tickets.ts`، `SCHEDULED_MAX_SPAN_MS` (۴-۴۷)، سقف ۱۲۸ سیاست هاب. در ابزارها: ابزار ربات ۰ تفاوت تازه (همان ۳۳ دیدهٔ بستن دستهٔ ۲، متن برابر؛ زمان رسیدن پیام‌ها همان)؛ ابزارهای دیگر به مدت‌ها و مجوز راه دور دست نمی‌زنند | TL-D10: `plan1405-remote-grants.mjs:4`، `:63`، `:67`، `:68`؛ `plan1405-gate-catalog.mjs:88`؛ `remote-approval-coordinator.mjs:74`؛ `remote-grant-registry-security.mjs:23`، `:49`؛ `plan1405-one-time-codes.mjs:272`، `:277`، `:285`، `:287`؛ `plan1405-phone-reports.mjs:350`، `:353`، `:354` (فقط مرزها و شمار کلیدها؛ هیچ سنجشی برداشته نشد) | `tl-4-28-durations-1000.mjs` (۸ آزمون؛ ۱۶ جهش ساختگی همه گرفته شدند) |
| ۴-۳۰ | پیام درخواست مجوز ربات زیر خط «قفل» یک خط «نوع» با نشانهٔ رنگی همان نوع دارد: «🔴 نوع: کار یک‌باره (فقط یک بار؛ زمان ندارد)»، «🟢 نوع: ماژول معمولی» یا «🟠 نوع: ماژول پولی و حساس». منبع، `lockKindOf` تازه در `panels.ts` است: شناسهٔ کار کاتالوگ یا کلید «قفل کار» ⇐ کار یک‌باره؛ بقیه با همان مرز `codeSectionOfPanel` کدها و مدت‌های ۴-۲۸؛ هفت قسمت تازهٔ طرح ۱۴۰۵ که امروز کنار نامشان برچسبی نداشتند «پولی و حساس»اند. برای ماژول خط «⏱ زمان رایانه برای این نوع: … دقیقه» هم می‌آید (`minutesFor` در `botRemoteBridge.ts`، همان کلید مدتی که فعال‌سازی مجوز می‌خواند). نتیجهٔ تأیید برای بقیهٔ گیرنده‌ها «· … دقیقه» دارد (قفل کار «· یک بار»)؛ خبر همه خط نوع و «⏱ زمان: … (همان تنظیمات رایانه)» را دارد و خبر رد خط نوع را. خبر «📱 مجوز راه دور باز شد» خط نوع و «⏱ زمان» دارد: میزبان (`CloudSyncService.ts`) برچسب ثابت نوع را در `decision` و دقیقه را در `minutes` ردیف `REMOTE_GRANT_OPENED` می‌نویسد و `messengerEvents.ts` آن را نشان می‌دهد؛ ردیف قدیمی بی نوع همان دو خط قبلی را دارد. ردیف `BOT_DECISION` همان چهار فیلد است. این بند پیش از ۴-۲۹ اجرا شد، چون دکمهٔ تأیید ۴-۲۹ همین عدد را نشان می‌دهد. اندازه: src +۶۳/−۱۳. در ابزارها: ابزار ربات همان ۳۳ دیده را دارد؛ نسبت به ۴-۲۸ فقط متن B9 دیده‌های ۱، ۲، ۵ و ۶ (پیام درخواست و نتیجهٔ تأیید) عوض شد و خط نوع و زمان را دارد؛ زمان رسیدن پیام‌ها همان است | — | `tl-4-30-lock-kind.mjs` (۷ آزمون؛ ۱۳ جهش ساختگی همه گرفته شدند) |

نام آزمون‌های تازه و تفاوت‌های ابزارها پس از اجرای هر بند همین‌جا درست می‌شود.

## فهرست جاهای قفل برای یک‌شکل شدن (۴-۴۶ و ۴-۸۱؛ معماری §۳-۲ و جدول §۶)

از روی کاتالوگ (۸۴ کلید: ۴۴ قسمت و ۴۰ قفل کار؛ ۵۳ شناسهٔ کار) و جست‌وجوی همهٔ کادرهای رمز رابط (`<PasswordField` و `type="password"` خام در `src/renderer/src`؛ همان رده‌بندی `plan1405-password-fields.mjs`، ۹۶ کادر). نگاشت هر جا به کلید یا شناسهٔ قفلش، و شکل نهایی پنجره، با ۴-۸۱ (گام آخر همین دسته) کامل می‌شود.

**جاهایی که یک‌شکل می‌شوند** (هر قفل روشن، جز «کلیدسازی»: کد یک‌بارمصرف، «درخواست مجوز از مدیر» و نوشتهٔ «با رمز کدام بخش»):

- کادرهای «دروازه» (۲۷ پرونده، ۵۲ کادر):

| پرونده (زیر `src/renderer/src`) | کادرها (`value`) |
| --- | --- |
| `components/AutoCentralPasswordBox.tsx` | `box.password` |
| `components/BridgeDiagnosticsModal.tsx` | `password` |
| `components/CardTransferPanel.tsx` | `payPassword`, `cancelPassword`, `adjPassword` |
| `components/CreditForms.tsx` | `value.managerPassword`, `password` |
| `components/InvoicePaymentsModal.tsx` | `chequePw`, `lockPw`, `chequePw` |
| `components/NewStoreProductModal.tsx` | `toStorePw`, `newProductPw` |
| `components/OverpayFlowDialogs.tsx` | `pw`, `reprintPw` |
| `components/ProductFormModal.tsx` | `password` |
| `components/ReturnEditModal.tsx` | `editPw` |
| `components/ShiftSessionModal.tsx` | `managerPassword` |
| `components/StockAdjustModal.tsx` | `password` |
| `components/StockSourceModal.tsx` | `password` |
| `components/StocktakeReminderBadge.tsx` | `pw` |
| `components/returns/CardPosOverrideDialog.tsx` | `password` |
| `pages/CategoryCharges.tsx` | `chargePw` |
| `pages/ManagementReports.tsx` | `mgrPass` |
| `pages/Pos.tsx` | `printPw` |
| `pages/PriceAdjust.tsx` | `adjustPw` |
| `pages/Products.tsx` | `purgePw` |
| `pages/PurchaseInvoice.tsx` | `purchasePw` |
| `pages/SalesInvoice.tsx` | `chargePw` |
| `pages/SalesReports.tsx` | `exCorrectionUnlockPassword`, `exVoidAuthPassword`, `exCorrectionAuthPassword` |
| `pages/SalesReturn.tsx` | `lockPw`, `creditLimitPw`, `managerPw`, `fullRefundPw`, `correctionUnlockPassword`, `correctionAuthPassword`, `voidAuthPassword` |
| `pages/SecondaryStock.tsx` | `toStorePw` |
| `pages/Settings.tsx` | `bundlePw`, `discountPw`, `discountTransferPw`, `byTimePw`, `custDelPw`, `policyPw`, `timePw`, `backupGatePw`, `panelManagerPw`, `slimManagerPw`, `applyPassword` |
| `pages/SmsPanel.tsx` | `pw` |
| `pages/Stocktake.tsx` | `schedulePw` |

- کادر خامِ دروازهٔ نگه‌داشته: `pages/CreditManagement.tsx` (issueManagerPw, issueManagerPw).
- پنجره‌ها و تکه‌های مشترک: `ManagerGate.tsx`، `GateUnlockDialog.tsx`، `PasswordField.tsx`، `RemoteRequestBox.tsx` و `OneTimeCodeBox.tsx`.

**بیرون از یک‌شکل‌سازی (همان می‌مانند):**

- typedOnly (۱۵ کادر؛ کلیدسازی، رمز تازه، هویت و رازِ غیرِرمز): `components/GateUnlockDialog.tsx`، `components/ManagerGate.tsx`، `components/MessengerSettings.tsx`، `pages/Pos.tsx`، `pages/SmsPanel.tsx`، `pages/Settings.tsx`.
- خام هویتی (۱۷ کادر؛ PIN و رمز شخصی): `components/CustodyAdminChip.tsx`، `components/CustodyChip.tsx`، `components/RemoteRequestBox.tsx`، `pages/SalesReports.tsx`، `pages/SalesReturn.tsx`.
- خام کلیدسازی (۹ کادر): `components/RemoteGrantControls.tsx`، `pages/RemoteLink.tsx`، `components/OneTimeCodesSettings.tsx`، `components/ScheduledGrantsBox.tsx`، `components/RecoveryCodesBox.tsx`.
- بیرون از دروازه: `pages/WooSync.tsx` (token).
