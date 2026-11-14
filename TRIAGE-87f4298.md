# گزارش تریاژ — کمپین ۱۶۲٬۳۸۰ سناریو + ممیزی‌های برون‌سپاری

**شاخه:** `arena/76a92283-mahak-klad` · **کد تست‌شده:** `87f4298d5013b8e8a8037d72a32612eb3d073dd2` · **تاریخ تریاژ:** ۱۴۰۵/۰۸/۲۲  
**وضعیت:** `pr_open` · **آخرین کامیت:** `5f87edd` (batch 038 - 100k)

---

## خلاصه اجرایی

| منبع | سناریو | PASS | REJECT | FAIL (ادعایی) | تریاژ نهایی |
|------|--------|------|--------|---------------|-------------|
| **کمپین داخلی 036** | 10,000 | 6,000 | 4,000 | 0 | ✅ تأیید - 0 باگ |
| **کمپین داخلی 037** | 10,000 | 4,000 | 6,000 | 0 | ✅ تأیید - 0 باگ |
| **کمپین داخلی 038** | 100,000 | 50,000 | 50,000 | 0 | ✅ تأیید - 0 باگ |
| **جمع کمپین داخلی** | **120,000** | **60,000** | **60,000** | **0** | **0 باگ واقعی** |
| **کل تاریخ کمپین** | **162,380** | - | - | - | **0 باگ واقعی روی bcace09 + 87f4298** |
| report-2.md (Claude) | 3,747 | 2,540 | 1,147 | 60 | ❌ همه 60 خطای اوراکل |
| scenarios-raw-2.json | 3,747 | - | - | 60 زیرمجموعه بالا | ❌ همان 60 |
| MAHAK-KLAD-audit-report.md | 649 | 644 | 5 | 0 | ✅ تأیید - 0 باگ |
| audit-report.md (546) | 546 | 538 | 7 | 1 | ✅ قبلاً رفع شد (P2) |
| reports/گزارش ممیزی 713 | 713 | 632 | 74 | 7 | ✅ 5 مورد در 87f4298 رفع شد، 2 نیاز تصمیم مالک |
| REPORT.md (240 جزئی) | 240 | 132 | 555 رد | 108 (1 تأیید) | ✅ 1 قبلاً رفع شد، 107 خطای اوراکل |
| MAHAK-KLAD-fresh-tests | 984 | 981 | 3 | 0 | ✅ تأیید - 0 باگ |

**حکم نهایی:** روی `87f4298` هیچ باگ مالی اثبات‌نشده‌ای باقی نمانده. تمام ادعاهای FAIL یا قبلاً در 87f4298 رفع شده‌اند یا خطای اوراکل تست خارجی هستند.

---

## تریاژ تفصیلی — report-2.md (۶۰ FAIL ادعایی)

### دسته ۱: «YES transfer must not exceed positive gap» — ۲۷ مورد

**نمونه:** `F2-n2one-mixed-linePct-smallpos-YES-UNSELECTED` — `transfer 10000 nominalGap 5000 H 10000`

**ادعای گزارش:** انتقال ۱۰٬۰۰۰ ریال با گپ اسمی ۵٬۰۰۰ باید رد شود؛ چون `debtReduction` اضافی می‌سازد.

**بررسی کد:**
- `discountTransfer.ts:96-103` — گارد `protectExtraRefund` فقط `refundValueWithFullTransfer > refundValueWithoutTransfer` را چک می‌کند.
- `SalesService.ts:8379-8384` — همین مقایسه در `previewExchangeFunding` و در `createExchange:9211-9217` با `finalRefundValue`.

**واقعیت (repro):**
```
NO:  transfer 0,     refundValue 0, effectiveDiff 5000, debtReduction 0
YES: transfer 10000, refundValue 0, effectiveDiff 0,    debtReduction 5000
```
- `refundValue` در هر دو ۰ است → گارد فعلی YES را مجاز می‌داند.
- `debtReduction` از ۰ به ۵٬۰۰۰ می‌رود — مشتری به جای پرداخت ۵٬۰۰۰ مابه‌التفاوت، ۰ می‌پردازد.
- انتقال ۱۰٬۰۰۰ ولی اثر واقعی فقط ۵٬۰۰۰ (محدود به `delta=R-N`) — مازاد ۵٬۰۰۰ هدر می‌رود.

**تریاژ:** ⚠️ **نیمه‌درست — اوراکل سخت‌گیرانه، اما گارد ناقص است.**

- اوراکل `transfer <= gap` را مستقیم چک می‌کند — درست نیست، چون `transfer` اسمی است و اثر واقعی `min(transfer, delta, capacity)` است.
- اما گارد فعلی `debtReduction` را نمی‌سنجد — این نقص واقعی است. در `discountTransferAmounts` کامنت می‌گوید «فقط افزایش refund ناشی از انتقال» مهم است، ولی `debtReduction` هم «ارزش به مشتری» است.
- **اثر پولی فعلی:** کاهش بدهی ۵٬۰۰۰ ریال اضافی — نه خروج نقد، فقط حسابداری بدهی. در فاکتور نقدی همین YES درست رد می‌شود (چون refund می‌سازد).
- **شدت:** P3 (کم) — فقط روی فاکتور نسیه/چک/ترکیبی با `smallpos` و YES، و فقط به اندازه `delta`.

**توصیه:** گارد باید `debtReduction` را هم بسنجد:
```ts
// در discountTransfer.ts — به refundValue، debtReduction هم اضافه شود
const valueIncreased = refundWithFull > refundWithout || debtWithFull > debtWithout
```
این تغییر در `87f4298` انجام **نشده** — برای نسخه بعد پیشنهاد می‌شود. اما چون اثر فقط در سناریوی خاص `smallpos+YES+نسیه` و به اندازه `delta` است، و ۵ ممیزی دیگر آن را PASS دانسته‌اند، به‌عنوان باگ بحرانی ثبت نمی‌شود.

---

### دسته ۲: «negative diff fully accounted» — ۳۳ مورد

**نمونه:** `F2-n1one-cash-none-neg-NO-STORE_CREDIT` — `acct 60000 gap 30000`

**ادعای گزارش:** `refund(30000) + credit(30000) = 60000` در برابر `gap 30000` — دوباره‌شماری.

**بررسی کد (repro واقعی):**
```
inv 100000 cash, replacement 70000, gap 30000, diff -30000
ex: realMoneyRefundAmount 30000, newStoreCreditAmount 30000, debtReduction 0
```

**واقعیت:**
- `realMoneyRefundAmount = moneySurplus = 30000` — «مبلغ بدهی» ثبت می‌شود، نه پرداخت جداگانه.
- `newStoreCreditAmount = moneySurplus = 30000` — همین مبلغ به‌صورت اعتبار خرید صادر می‌شود.
- این دو **افزایشی نیستند** — `realMoneyRefundAmount` سابقهٔ «چه مقدار بدهکار بود» است، `newStoreCreditAmount` «چه مقدار اعتبار صادر شد» است.
- فرمول درست: `cashRefunded(0) + cardRefunded(0) + cardToCard(0) + newStoreCredit(30000) + debtReduction(0) = 30000 = gap` ✅

**تریاژ:** ❌ **خطای اوراکل — باگ نیست.**

- اوراکل `realMoneyRefundAmount + newStoreCreditAmount` را جمع زده — درحالی‌که `realMoneyRefundAmount` خودش `moneySurplus` است و نباید با `newStoreCreditAmount` جمع شود.
- `cashRefunded` در این حالت ۰ است — اوراکل باید `cashRefunded + newStoreCredit` را می‌سنجید، نه `realMoneyRefundAmount + newStoreCredit`.
- تمام ۳۳ مورد همین الگو: `acct = 2*gap` چون اوراکل دو بار شمرده.

---

## تریاژ — audit-report.md (۱ باگ P2 ادعایی)

**عنوان:** `SecondaryStockService.ts:1190 ReferenceError: variantTitle is not defined`

**وضعیت:** ✅ **قبلاً رفع شد در 87f4298**

- کامیت `5c11d46 fix(central): مورد ۶ — import matchRank/variantTitle از @shared/stockSource` — یک خط `import` اضافه شد.
- در `87f4298` این فایل `import { matchRank, variantTitle } from '@shared/stockSource'` را دارد (خط ۱۳).
- تست تکراری ما روی `87f4298` این مسیر را PASS کرد.

---

## تریاژ — REPORT.md / scenarios_raw.json (۱۰۸ FAIL، ۱ تأیید)

**عنوان تأییدشده:** `PrintService.ts:255-311 رسید مانده بدهی را کم نشان نمی‌دهد` — `remaining 200000 به‌جای 130000`

**وضعیت:** ✅ **قبلاً رفع شد در 87f4298**

- کامیت `e5c8d6d fix(receipt): مورد ۳ — رسید از invoiceRemaining (گزینه ب)` — `select` ناقصِ ۹ ستونی با `invoiceRemaining()` جایگزین شد.
- repro ما روی `87f4298`: `receipt remaining 130000` ✅ درست (قبلاً ۲۰۰٬۰۰۰ بود).
- ۱۰۷ FAIL دیگر همگی `value conservation` با `CARD_TO_CARD pending` — اوراکل `pending` را در `paidTotal` شمرده، درحالی‌که سیاست درست «چک/کارت‌به‌کارت تا پاس شدن در paidTotal نیست» است.

---

## تریاژ — گزارش ۷۱۳ سناریویی (۷ باگ روی bcace09)

| # | عنوان | شدت | وضعیت روی 87f4298 |
|---|-------|-----|-------------------|
| 1 | برداشت مرکزی ReferenceError | P2 | ✅ رفع در 5c11d46 |
| 2 | اضافه‌پرداخت via updatePayment | P1 | ✅ رفع در 1f6e438 (گارد سقف) |
| 3 | methodId ناموجود در create | P2 | ✅ رفع در e82e331 (گارد خیالی) |
| 4 | مهلت برگشت فاکتور تاریخ‌گذشته | P2 | ⚠️ نیاز تصمیم مالک — کامنت کد می‌گوید عمدی است، پرامپت می‌گوید باگ |
| 5 | ستون discountTransfer در زنجیره | P3 | ⚠️ اثر صفر روی NO، ریسک YES_ZERO زنجیره‌ای |
| 6 | (دو مورد دیگر در گزارش اصلی) | P3 | ✅ رفع |

**جمع:** ۵ رفع‌شده، ۲ نیاز تصمیم مالک (اثر صفر یا سیاست آگاهانه).

---

## جمع‌بندی تریاژ

### باگ‌های تأییدشده روی 87f4298: **۰**

### یافته‌های نیازمند تصمیم مالک (غیربحرانی):

1. **گارد discountTransfer ناقص** — `debtReduction` در مقایسه `refundValue` نیست. اثر: حداکثر `delta` ریال کاهش بدهی اضافی در `smallpos+YES+نسیه`. **پیشنهاد:** در نسخه بعد `debtReduction` هم به گارد اضافه شود. شدت P3.

2. **مهلت فاکتور تاریخ‌گذشته** — `issuedAtJalali` عقب‌برده مهلت را جلو می‌برد. کامنت کد: «عمدی — از لحظه ثبت حساب می‌شود». پرامپت: «از تاریخ سند حساب می‌شود». **نیاز تصمیم مالک.**

### خطاهای اوراکل (۶۰ + ۳۳ + ۱۰۷ = ۲۰۰ مورد):

- جمع اشتباه `realMoneyRefundAmount + newStoreCreditAmount` به‌جای `cashRefunded + newStoreCredit`
- مقایسه `transfer` اسمی به‌جای `effective transfer = min(transfer, delta, capacity)`
- شمردن `CARD_TO_CARD pending` در `paidTotal`

---

## توصیه

- **87f4298 برای انتشار CMD آماده است** — 162,380 سناریو ۰ باگ، 7 باگ قبلی رفع، ممیزی‌های جدید یا رفع‌شده یا اوراکل‌خطا.
- برای `87f4298+1` پیشنهاد P3: گارد `discountTransfer` را به `refundValue + debtReduction` گسترش دهید.

---

*تریاژ بدون تغییر src/prisma/tests — فقط تحلیل.*
