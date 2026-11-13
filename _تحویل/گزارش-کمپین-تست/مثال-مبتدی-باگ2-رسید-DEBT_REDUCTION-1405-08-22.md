# مثال مبتدیانه — باگ ۲: رسید DEBT_REDUCTION اشتباه (۲۰۰ هزار به‌جای ۱۳۰ هزار)

> همان باگ `PrintService.ts:242` که تریاژ ۲۵۰k→۵۰k نقد→تعویض ۱۰۰k→۳۰k را ۲۰۰k نشان می‌داد.

---

## ۱) قصهٔ فاکتور

**مشتری:** مریم حسینی — تلفن ۰۹۱۲...
**فاکتور اول (نسیه چون پول کم آورده):**
- کالا A: ۱۰۰٬۰۰۰ ریال
- کالا B: ۱۵۰٬۰۰۰ ریال
- **جمع کل = ۲۵۰٬۰۰۰**
- پرداختی همان روز: **۵۰٬۰۰۰ نقد** (به صندوق رفت، عدد آبی +۵۰k)
- **مانده بدهی = ۲۰۰٬۰۰۰** (چون ۲۵۰k - ۵۰k = ۲۰۰k)

```
فاکتور #10
  grandTotal: 250,000
  paidTotal: 50,000
  remaining: 200,000  ← اینو هم payments() میگه هم باید رسید بگه
  وضعیت: نسیه (۲۰۰k بدهی)
```

## ۲) فردا مشتری برمی‌گردد — تعویض

مریم می‌گوید: «اون کالای ۱۰۰هزاری رو پس می‌دم، یه کالای ۳۰هزاری برمی‌دارم. فرق‌ش رو نمی‌خوام نقد — بذار از بدهی‌ام کم شه.»

قانون «تعویضِ منفی با کاهش بدهی» همین است:
- کالای برگشتی: ۱۰۰٬۰۰۰
- کالای جایگزین: ۳۰٬۰۰۰
- اختلاف منفی: ۷۰٬۰۰۰ (۱۰۰k - ۳۰k)
- تسویه: **DEBT_REDUCTION** یعنی «۷۰k از بدهی مشتری کم کن، پولی از صندوق نده»

پس:
```
برگشتی 100k → جایگزین 30k → 70k میره تو بدهی
بدهی قبل: 200,000
بدهی بعد: 200,000 - 70,000 = 130,000  ← درست
```

## ۳) سیستم درست حساب می‌کند — ولی رسید غلط

**بخش درست (SaleService):**
```js
payments({invoiceId:10}) → remaining: 130,000 ✅
SaleReturn row: {kind:'EXCHANGE', total:100000, debtReduction:70000, exchangeTotal:30000}
```

**بخش غلط (PrintService.receiptDataFor):**
```js
receiptDataFor(10) → remaining: 200,000 ❌
```

یعنی اگه رسید رو چاپ کنی و به مشتری بدی، روش نوشته:
> «مانده بدهی: ۲۰۰٬۰۰۰ ریال»

در حالی که حسابداری و `payments()` می‌گه ۱۳۰٬۰۰۰. اختلاف **۷۰٬۰۰۰** دقیقاً همون `debtReduction`.

## ۴) چرا رسید غلط شد؟ یک SELECT ناقص

در `PrintService.ts:242` وقتی رسید می‌خواهد بدهی را حساب کند:

```ts
returns: { select: { kind, total, refundMethod, refundAmount, refundStoreCreditAmount } }
// کمبود: exchangeTotal, exchangeDiff, debtReduction, exchangeCreditReversed خوانده نمی‌شود!

remaining = remainingOf({ grandTotal:250k, received:50k, ...debtAdjustmentsOf(returns) })
```

`debtAdjustmentsOf` برای تعویض نیاز دارد `debtReduction` را ببیند تا `returnedValue += 70k` کند. چون `debtReduction` اصلاً خوانده نشده (`undefined → 0`)، فکر می‌کند:


```
payable = grandTotal - returnedValue = 250k - 0 = 250k (به‌جای 180k)
remaining = payable - received = 250k - 50k = 200k (به‌جای 130k)
```

## ۵) مثال عددیِ ساده‌تر

- فاکتور ۱٬۰۰۰٬۰۰۰، نقد ۲۰۰٬۰۰۰ → بدهی ۸۰۰٬۰۰۰
- تعویض: برگشتی ۵۰۰٬۰۰۰ → جایگزین ۳۰۰٬۰۰۰ → DEBT_REDUCTION ۲۰۰٬۰۰۰
- درست: بدهی ۶۰۰٬۰۰۰
- رسید غلط: بدهی ۸۰۰٬۰۰۰ (۲۰۰k اختلاف)

یا برای صفر شدن:
- فاکتور ۲۰۰٬۰۰۰، نقد ۵۰٬۰۰۰ → بدهی ۱۵۰٬۰۰۰
- تعویض ۱۵۰٬۰۰۰ → ۰ → DEBT_REDUCTION ۱۵۰٬۰۰۰
- درست: بدهی ۰ (تسویه)
- رسید غلط: بدهی ۱۵۰٬۰۰۰ (تصور می‌کنی هنوز بدهکار است!)

## ۶) اثرش چیست؟

- پول گم نمی‌شود — فقط **کاغذ غلط** می‌دهی.
- مشتری فکر می‌کند ۲۰۰k بدهکار است، در حالی که ۱۳۰k است → دعوا سر صندوق.
- گزارش شیفت و دفتر حسابداری درست (۱۳۰k) ولی رسیدِ دست مشتری غلط (۲۰۰k) → مغایرت.

## ۷) مدرک هارنس (همین کد)

```
invoice 1 grandTotal 250000 paid 50000 remaining 200000
preview debtReduction 70000
after exchange remaining 130000 paid 50000
receipt remaining 200000
MATCH? FAIL diff -70000
SaleReturn {kind:'EXCHANGE', total:100000, debtReduction:70000, exchangeTotal:30000}
```

## ۸) درستش چیست؟ (بدون اعمال)

```ts
// PrintService.ts:242
select: {
  kind, total, refundMethod, refundAmount, refundStoreCreditAmount,
  exchangeTotal, exchangeDiff, debtReduction, exchangeCreditReversed // ← اضافه شود
}
```

بعدش تست: `payments().remaining == receiptDataFor().remaining` برای هر تعویض DEBT_REDUCTION.

---
**جمع:** باگِ «کاغذ» است نه «پول» — ولی کاغذِ غلط در بازار همان پولِ غلط است.
**وضعیت طرح:** ⏳ هنوز در انتظار تایید تو — اگر تایید کنی وارد طرح می‌شود (اهمیت: متوسط، چون مغایرت رسید/دفتر است).
