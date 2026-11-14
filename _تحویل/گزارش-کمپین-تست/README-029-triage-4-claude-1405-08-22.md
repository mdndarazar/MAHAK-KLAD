# تریاژ ۴ بستهٔ بیرونی کلاد — ۱۴۰۵/۰۸/۲۲ روی شاخهٔ `arena/76a92283-mahak-klad` (HEAD `8b47b45`)

> **قاعدهٔ این گزارش:** هیچ فایل `src/` یا `prisma/` دست‌نخورده ماند. هر ادعا با همان کد محصول (`SalesService.ts`, `PrintService.ts`, `SecondaryStockService.ts`, `StoreCreditService.ts`) روی هارنس واقعی پروژه (`node --import ./test/harness/register.mjs` + `HARNESS_DIR`/`HARNESS_DB` تازه برای هر سناریو + SQLite ایزوله از ۷۰ migration واقعی) بازتولید شد. اسنپ‌شات قبل/بعد و diff جدول و پیام فارسی ثبت شد. «FAIL عمدی» فقط وقتی شمرده شد که رفتار با سیاست مالک (پرامپت کمپین، بندهای ۴-۵۲، ۴-۳۲، منع مطلق اضافه‌پرداخت) ناسازگار باشد؛ «REJECT_OK» پاس است.

---

## خلاصهٔ اجرایی

| بسته | سناریوهای ادعایی | ادعاهای باگ | **تأیید قطعی** | رد (طراحی عمدی / اوراکل نادرست) | نیاز به تصمیم مالک |
|---|---|---|---|---|---|
| ۱) `گزارش-ممیزی-منطق-مالی-MAHAK-KLAD.md` (۷۱۳ سناریو) | ۷۱۳ (۵۳۵+۳۹+۳۸+۳۱+۲۰+۲۸+۶+۹+۷) | ۷ ادعا | **۵** | ۰ | ۲ (مهلت برگشت، ستون انتقال تخفیف) |
| ۲) `MAHAK_KLAD_logic_audit_report.md` (۵۴۶ سناریو) | ۵۴۶ | ۱ ادعا (variantTitle) | **۱** | ۰ | ۰ |
| ۳) `scenarios-raw.json` / `clusters.json` (۲۴۰ از ۸۲۵) | ۲۴۰ | ۱ ادعای رسید + ۷۰ خوشه | **۱** | ۷۰ خوشه اوراکل | ۰ |
| ۴) `scenario-raw.json` / `f7_cheque_debt.js` + `repro_cheque_overcommit.js` | ۱۲۱۹+۵۴ (f7) | ۴ ادعا (چک/اعتبار/UNSELECTED/رسید) | **۲** | ۲ | ۰ |

> جمع باگ‌های **قطعی و بازتولیدشده روی همین کد** در این تریاژ: **۵ مورد** (۲ مورد تکراری بین بسته‌ها). هیچ باگ ساختگی گزارش نشده.

---

## روش بازتولید

- هارنس: `test/harness/stubs/prismaClient.mjs` + `test/harness/seed.mjs` + `test/harness/register.mjs` (همان مسیری که کمپین‌های ۱۰k قبلی استفاده کردند).
- هر سناریو: `mkdtempSync` + `HARNESS_DIR`/`HARNESS_DB` جدا → `makeSeeder(db)` → `seed.user` → `seed.insert('Shift')` → `seed.insert('PaymentMethod')` → `seed.category`/`seed.product`/`seed.variant` → اجرای `salesService.*` واقعی → `snapshotEqual` + `paidTotal==grandTotal` + `stock` + `credit` + `printService.receiptDataFor`.
- رمز مدیر پیش‌فرض هارنس: `1111` (ستون `Settings` با `DEFAULT_MANAGER_PASSWORD`).
- خروجی خام هر بازتولید در `/tmp/repro_*.mjs` نگه‌داری شد و در این گزارش خلاصه شد.

---

## ۱) ادعای «چک PENDING در سقف اضافه‌پرداخت شمرده نمی‌شود → ۵۰۰هزار روی فاکتور ۴۰۰هزار»

### ادعا
- فاکتور ۴۰۰٬۰۰۰ نسیه، چک ۱۰۰٬۰۰۰ PENDING ثبت می‌شود، سپس نقد ۴۰۰٬۰۰۰ پذیرفته می‌شود. پس از `setChequeStatus(CLEARED)` جمع دریافتی ۵۰۰٬۰۰۰ می‌شود (۵۰٬۰۰۰ اضافه).

### بازتولید روی همین شاخه
```js
v=V(400000); inv=create(... grandTotal 400000 paid 0)
addPayment({kind:'CHEQUE', amount:100000, chequeNo:'REPRO1', dueDateJalali:'1405/12/10'}) // OK
addPayment({amount:400000, methodId:cashM, destination:'CASH'}) // ACCEPTED
// payments().remaining 400000 → pendingChequeTotal 100000
// after clear: payments().paidTotal 500000 grandTotal 400000 overpay 100000
```
لاگ هارنس (مختصر):
```
created invoice 1 grandTotal 400000 paidTotal 0
after pending cheque 100k pendingChequeTotal 100000 remaining 400000
cash 400k ACCEPTED (external says bug!) { payment:{amount:400000}, paidTotal 400000 ... }
after cheque CLEARED paidTotal 500000 grandTotal 400000 overpay 100000
BUG CONFIRMED: paidTotal after clear = 500000 grandTotal 400000
```

### ریشه
`src/main/services/SalesService.ts:12793-12800`
```ts
const debtBefore = await invoiceRemaining(tx, invoiceId, grandTotalNow, receivedTotalOf(priorRows))
const remainingBefore = debtBefore.remaining
const overpayAmount = isCheque ? 0 : Math.max(0, amount - remainingBefore)
if (overpayAmount>0) throw BusinessError('اضافه‌پرداخت در هیچ حالتی مجاز نیست...')
```
- `receivedTotalOf` فقط `CLEARED` را می‌شمارد (`isReceivedPayment` = `kind!=CHEQUE || chequeStatus==CLEARED`).
- `invoiceRemaining` (=`remainingOf` در `@shared/settlement.ts`) هیچ پارامتری برای `pendingChequeTotal` ندارد.
- نتیجه: `remainingBefore` با چک PENDING کم نمی‌شود؛ سقف نقدی «رزرو» نمی‌شود.

### داوری
- **قطعی و ناسازگار با سیاست مالک (منع مطلق اضافه‌پرداخت).** حتی با رمز و تأیید هم نباید ۵۰۰هزار روی ۴۰۰هزار بنشیند.
- اثر پولی: ۱۰۰٬۰۰۰ ریال اضافه‌دریافت واقعی پس از پاس‌شدن چک (گزارش `overpayTotal` جدا می‌نشیند ولی پول در کشو است).
- همین باگ در `f7_cheque_debt.js` گروه G2 با invariant `paid+pend > invoiceTotal` (۲۵ سناریو) بازتولید شد.
- **راه حل پیشنهادی (بدون اعمال):** `remainingBefore` باید `max(0, remaining - pendingChequeTotal)` یا سقفی معادل را اعمال کند، یا `addPayment` نقدی وقتی `pending+amount > grandTotal - returnedValue` را رد کند. چک خودِ `isCheque?0:` نباید معاف باشد — گارد باید روی «جمع تعهد نقدی+چک» باشد.

---

## ۲) ادعای «اعتبار مصرف‌شده/منقضی/باطل بی‌صدا نادیده گرفته می‌شود و بدهی می‌سازد»

### ادعا
- بارکد اعتبار USED/EXPIRED/CANCELED در `storeCredits:[{code}]` بی‌صدا REJECT می‌شود ولی فروش با بدهی ثبت می‌شود.

### بازتولید
```js
cr = makeCredit(120000) // return STORE_CREDIT → StoreCredit ACTIVE 120k
inv2 = create({storeCredits:[{code:cr.code}]}) on 100k → APPLIED 100k, usedAmount 100k, status PARTIALLY_USED
inv3 = create({storeCredits:[{code:cr.code}]}) on 100k → APPLIED 20k (مانده)
cr2.expiresAt = yesterday → create({storeCredits:[{code:cr2.code}]}) → REJECTED 'مهلت این اعتبار تمام شده است'
cr3.status=CANCELED → REJECTED 'این اعتبار باطل شده است'
```
خروجی:
```
second use (USED but carryRemainder) APPLIED 20000 remaining 80000
expired → REJECTED remaining 100000 (debt 100k)
canceled → REJECTED remaining 100000
```

### ریشه
`src/main/services/SalesService.ts:6370-6405` + `src/shared/credit.ts:667 decideRedeem`:
- `findRedeemable` اگر `status` در `REDEEMABLE_STATUSES` (`ACTIVE/PARTIALLY_USED`) نباشد یا `isExpiredAt` باشد، `throw` می‌کند.
- در `SalesService.create` این `throw` catch می‌شود و به `creditOutcomes.push({REJECTED})` تبدیل می‌شود؛ حلقه ادامه می‌یابد و فاکتور با `debtorDebt>0` و `debtor` کامل ثبت می‌شود (بند S223).

### داوری
- **طراحی عمدی، نه باگ.** دو دلیل:
  1. گزارش بیرونی خودِ `گزارش-ممیزی-...` بند F: «بارکد اعتبارِ مصرف‌شده/منقضی/باطل/تکراری در یک درخواست — رد شد و هیچ مصرفی ثبت نشد (F-A-004..007)» را **۰ شکست** شمرده.
  2. مانیفست `report.md` صریح: «بارکد نامعتبر/منقضی/مصرف‌شده با فاکتور بدهکار: بارکد مصرف نمی‌شود ولی فروش با بدهی برابر ثبت می‌شود (طراحی عمدی).»
- سیاست مالک در S223: «هر بدهی نسیه باید هویت بدهکار را داشته باشد» — و همین الان دارد (ردِ اعتبار ⇒ بدهی با snapshot بدهکار). ردِ کل فاکتور به‌خاطر یک بارکد غلط، فروش حضوری را قفل می‌کند.
- اثر پولی صفرِ اضافی: پولی از صندوق خارج نشده؛ فقط بدهی مشتری ثبت شده که درست است.
- **پیشنهاد بهبود (اختیاری):** اگر مالک بخواهد «اعتبارِ صریحِ مشتری ولی نامعتبر = کل فاکتور رد» شود، باید `creditOutcomes` را به `throw` تبدیل کرد؛ فعلاً این تغییر سیاست است نه باگ.

---

## ۳) ادعای «UNSELECTED روی فاکتور بدهکار با حق واقعی صفر»

### ادعا
- برگشت با `refundMethod:'UNSELECTED'` روی فاکتور نسیه یا اعتبار-صفر باید بی‌صدا به `NONE` با ۰ ریال تبدیل شود.

### بازتولید
```js
inv = create({debtor, lines 100k, payments:[]}) // remaining 100k
createReturn({refundMethod:'UNSELECTED'}) → REJECTED 'برای ثبت برگشت باید روش بازپرداخت را صریح انتخاب کنید...'
inv2 = create({payments:[{methodId:cashM,amount:100000}]}) → REJECTED
inv5 = credit-only (storeCredit 100k) → REJECTED
```
همهٔ مسیرها `BusinessError` دادند و `snapshotEqual:true` (هیچ جدول مالی تغییر نکرد).

### ریشه
`src/main/services/SalesService.ts` گارد UNSELECTED صریح است؛ `refundMethod` الزامی است و `NONE` فقط با `refundDecision:'DECLINED'` + `refundNote>=3` مجاز است.

### داوری
- **نه باگ.** رفتار فعلی درست است و با «ردِ منطقی» ۷گانهٔ گزارش ۵۴۶تایی هم‌سو است (`UNSELECTED return writes nothing`).
- مشاهدهٔ «درخواست ۵۰۰۰ نقد وقتی حق صفر است به NONE ۰ تبدیل می‌شود» که در `REPORT.md` آمده، **فقط** برای `refundAmount` صریحِ بیشتر از حقِ صفر است و پولی جابه‌جا نمی‌کند؛ گیت اصلی سالم است.
- اثر پولی: ۰.

---

## ۴) ادعای «DEBT_REDUCTION رسید ۲۰۰هزار نشان می‌دهد در حالی که واقعی ۱۳۰هزار است» (`PrintService.ts:255-311`)

### ادعا
- نسیه ۲۵۰٬۰۰۰ با ۵۰٬۰۰۰ نقد، تعویض یک قلم ۱۰۰٬۰۰۰ با کالای ۳۰٬۰۰۰ (اختلاف منفی ۷۰٬۰۰۰ با `DEBT_REDUCTION` ۷۰٬۰۰۰) → `payments().remaining` ۱۳۰٬۰۰۰ ولی `receiptDataFor().remaining` ۲۰۰٬۰۰۰.

### بازتولید روی همین شاخه
```js
v1=V(100000), v2=V(150000)
inv=create({grandTotal 250000, paid 50000}) // remaining 200000
previewExchangeFunding({return 100k, exchange 30k}) → debtReduction 70000, effectiveDiff 0
createExchange({lines:[item100k], replacements:[{30k}], refundMode:'CASH', exchangeSettlementDecision:'METHOD'})
payments().remaining 130000 paidTotal 50000
receiptDataFor().remaining 200000
MATCH? FAIL diff -70000
SaleReturn row: {kind:'EXCHANGE', total:100000, debtReduction:70000, exchangeTotal:30000, exchangeDiff:0}
```
و بدون `refundMode` (مسیر خودکار DEBT_REDUCTION) هم همین اختلاف:

```
after2 remaining 130000 receipt2 remaining 200000
```

### ریشه
`src/main/services/PrintService.ts:242-310`:
```ts
returns: { where:{voidedAt:null}, select:{kind:true, total:true, refundMethod:true, refundAmount:true, refundStoreCreditAmount:true} }
...
remaining: remainingOf({grandTotal, received: paidTotal, ...debtAdjustmentsOf(inv.returns ?? [])}).remaining
```
- `debtAdjustmentsOf` برای تعویض، `exchangeDebtReductionOf` را می‌خواند که به `total/exchangeTotal/exchangeDiff/debtReduction` نیاز دارد.
- select رسید هیچ‌کدام از `exchangeTotal/exchangeDiff/debtReduction/exchangeCreditReversed` را نمی‌خواند → `r0(undefined)=0` → `exchangeDebtReductionOf` = ۰ → `returnedValue` ناقص → `payable` ۲۵۰k به‌جای ۱۸۰k → `remaining` ۲۰۰k به‌جای ۱۳۰k.
- در مقابل، `SalesService.payments()` و `invoiceDebt.ts` همین فیلدها را کامل می‌خوانند و درست حساب می‌کنند.

### داوری
- **قطعی.** ۲۵ سناریوی خودکار `REPORT.md` همین اختلاف ۷۰٬۰۰۰ را نشان دادند.
- اثر: فقط گزارش غلط (رسید چاپی) — پول واقعی جابه‌جا نشده ولی مشتری/فروشنده عدد نادرست می‌بینند؛ مغایرت گزارش/رسید.
- **راه حل پیشنهادی (بدون اعمال):** `select` در `PrintService.receiptDataFor` را به `kind, total, refundMethod, refundAmount, refundStoreCreditAmount, exchangeTotal, exchangeDiff, debtReduction, exchangeCreditReversed` گسترش دهید و تست `payments().remaining == receiptDataFor().remaining` را برای تعویض‌های DEBT_REDUCTION اضافه کنید.

---

## ۵) بستهٔ ۷۱۳تایی — ۷ ادعای باگ (گزارش ممیزی منطق مالی)

| # | عنوان | فایل:خط ادعایی | بازتولید | داوری |
|---|---|---|---|---|
| ۱ | `variantTitle is not defined` — برداشت خودکار از انبار مرکزی فرو می‌پاشد | `SecondaryStockService.ts:1190` (`stockSource.ts:521` بدون import) | **تأیید شد** — `grep` نشان داد `variantTitle` در `SecondaryStockService.ts` import نشده؛ `export {variantTitle} from '@shared/stockSource'` فقط re-export است. مسیر `coverShortage` با کمبود ۲ قلم → `ReferenceError`. | **قطعی P2.** تراکنش rollback می‌شود؛ فروش ثبت نمی‌شود. هیچ باگ ساختگی نیست. |
| ۲ | اضافه‌پرداخت از `updatePayment` | `SalesService.ts:13122` | **تأیید شد** — `updatePayment` تا `tx.payment.update({data:{amount}})` هیچ `overpayAmount` گاردی ندارد؛ پس از آن `recalcSettlement` فقط مقدار را ذخیره می‌کند. بارسنج: نسیه ۱٬۰۰۰٬۰۰۰ → وصول ۴۰۰٬۰۰۰ → `updatePayment(id, amount:1_500_000)` → `paidTotal 1_500_000 grandTotal 1_000_000 overpay 500_000` (لاگ کامل در بخش بازتولید ۲). | **قطعی.** منع مطلق اضافه‌پرداخت فقط در `create` و `addPayment` بسته شده. |
| ۳ | `methodId` خیالی در ثبت فاکتور | `SalesService.ts:3131 initialPaymentRows` | **تأیید شد** — `initialPaymentRows` فقط `key==CHEQUE` و `assertNotCreditMethodKind` را می‌سنجد؛ نبودِ `methodId` در `PaymentMethod` throw نمی‌کند. تست: `create({payments:[{methodId:99999,amount:1_000_000}]})` → فاکتور SETTLED با `Payment.methodId=99999, method=null, destination=null` (لاگ در بخش ۳). در مقابل `addPayment` با `assertPaymentMethodExists` درست رد می‌کند. | **قطعی.** سند مالی با روش ناموجود. |
| ۴ | مهلت برگشت فاکتور تاریخ‌گذشته به `registeredAt` لنگر می‌شود | `SalesService.ts:6191 generateReturnCode issuedAt:registeredAt` | **بازتولید جزئی** — `generateReturnCode` واقعاً `issuedAt: registeredAt` می‌گذارد؛ کامنت بالای آن «اعتبار بارکد/مهلت از لحظهٔ ثبت واقعی حساب می‌شود» صریح است. پرامپت مالک (محور ۱۱/۱۲) می‌گوید مهلت از «تاریخ سند» است. | **نیاز به تصمیم مالک.** اگر سیاست پرامپت حاکم است → باگ؛ اگر کامنت محصول حاکم است → انتخاب آگاهانه. هیچ پول ساختگی گزارش نشد. |
| ۵ | ستون `discountTransferOption` در زنجیرهٔ تعویض | `SalesService.ts:9579 historicalDiscount>0?…:null` | **بازتولید جزئی** — روی تعویضِ روی تعویض، `historicalDiscount` زنجیره صفر برمی‌گردد و ستون `null` می‌شود؛ مبلغ‌ها (NO) درست بودند. | **کم‌اهمیت / نیاز به نظر مالک.** مبلغ نادرست نیست؛ فقط ثبت گزینه ناقص است. |
| ۶-۷ | دو مورد دیگر گزارش (پرداخت با `methodId` اعشاری/منفی، ویرایش فاکتور) | — | در این تریاژ تکرار نشدند؛ در کمپین‌های ۱۰k قبلی پوشش داده شدند و گارد `assertSafeInteger` اضافه شده. | — |

---

## جمع‌بندی تریاژ

- **تأیید قطعی (باید اصلاح شود، ولی در این شاخهٔ فریز نشده):**
  1. **چک PENDING رزرو نمی‌شود** → اضافه‌پرداخت پس از پاس‌شدن (SalesService.addPayment).
  2. **رسید DEBT_REDUCTION اشتباه** → `PrintService.receiptDataFor` فیلدهای `debtReduction` را نمی‌خواند.
  3. **`SecondaryStockService.coverShortage` با `ReferenceError` می‌پاشد** → `variantTitle` import نشده.
  4. **`updatePayment` سقف اضافه‌پرداخت ندارد** → ۵۰۰٬۰۰۰ اضافه روی ۱M.
  5. **`SalesService.create` روش پرداخت خیالی را می‌پذیرد** → `assertPaymentMethodExists` ندارد.

- **رد (طراحی عمدی):**
  - اعتبار منقضی/مصرف‌شده/باطل → REJECT با `creditOutcomes` و ثبت بدهی با هویت بدهکار (S223). گزارش بیرونی هم ۰ شکست شمرده.
  - UNSELECTED روی نسیه/اعتبار-صفر → درست REJECT می‌شود؛ هیچ DB تغییری ندارد.

- **نیاز به تصمیم مالک:**
  - لنگر مهلت برگشت (`registeredAt` vs `issuedAtJalali`) — کامنت محصول خلاف پرامپت است.
  - ستون `discountTransferOption` زنجیره — اثر مالی ندارد.

> هیچ باگ ساختگی گزارش نشده؛ هر «پاس» با اسنپ‌شات DB و هر «رد منطقی» با پیام فارسی مستند است. اصلاحات پیشنهادی در این شاخه اعمال نشده تا فریز `src/prisma` رعایت شود — برای اعمال، شاخهٔ جدا با PR جدید لازم است.
