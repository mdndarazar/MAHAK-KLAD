# مثال مبتدیانه — باگ ۴: `updatePayment` سقف اضافه‌پرداخت ندارد

> نشانی: `src/main/services/SalesService.ts:13122` مسیر `updatePayment`
> تریاژ: نسیه ۱٬۰۰۰٬۰۰۰ → وصول ۴۰۰٬۰۰۰ → ویرایش به ۱٬۵۰۰٬۰۰۰ ACCEPT شد (۵۰۰٬۰۰۰ اضافه)

---

## ۱) قصهٔ فاکتور

**مشتری:** علی رضایی — ۰۹۱۵...
**فاکتور نسیه:**
- ۲ کالا: ۶۰۰٬۰۰۰ + ۴۰۰٬۰۰۰ = **۱٬۰۰۰٬۰۰۰ ریال**
- پرداختی اول: **۰** — همه نسیه
- `grandTotal: 1,000,000`
- `paidTotal: 0`
- `remaining: 1,000,000` — بدهی کامل

```
فاکتور #20
  جمع: 1,000,000
  پرداخت: 0
  مانده: 1,000,000
```

## ۲) یک پرداخت درست

علی فردا ۴۰۰٬۰۰۰ نقد می‌آورد:

```js
addPayment({invoiceId:20, amount:400000, methodId:cashM, destination:'CASH'})
→ ACCEPTED ✅
  paidTotal: 400,000
  remaining: 600,000
  overpay: 0
```

تا اینجا همه درست — `addPayment` سقف دارد:
```ts
// SalesService.ts:12799
if (overpayAmount > 0) throw BusinessError('اضافه‌پرداخت در هیچ حالتی مجاز نیست...')
```

یعنی اگر همان لحظه ۱٬۲۰۰٬۰۰۰ می‌زد، رد می‌شد.

## ۳) حالا ویرایش — باگ همین‌جاست

فروشنده اشتباهی یا عمدی می‌رود روی همان ردیف ۴۰۰٬۰۰۰ و می‌زند «ویرایش»:

```js
updatePayment({id: paymentId, amount:1_500_000, reason:'اصلاح', managerPassword:'1111'})
```

**انتظار درست چیست؟**
باید **رد** شود، چون:
```
grandTotal: 1,000,000
درخواستی جدید: 1,500,000
→ 500,000 بیشتر از جمع فاکتور → اضافه‌پرداخت مطلق ممنوع
```

حتی با رمز مدیر، دلیل، یا «بله ثبت کن» هم نباید قبول شود — سیاست مالک همین است.

**رفتار فعلی (باگ):**
```
✅ ACCEPTED — paidTotal: 1,500,000
   grandTotal: 1,000,000
   overpayTotal: 500,000
   overpayAmount روی ردیف: 500,000
   remaining: 0
```

یعنی **۵۰۰ هزار ریال اضافه** بی‌صدا توی کشو/حساب مدیر نشسته و فاکتور «تسویه» نشان می‌دهد.

## ۴) چرا شد؟ یک گارد جا افتاده

**مسیر درست (`addPayment`):**
```ts
// 12793
debtBefore = await invoiceRemaining(grandTotal, receivedTotalOf(priorRows))
remainingBefore = debtBefore.remaining // 600,000
overpayAmount = amount - remainingBefore // 1,500,000 - 600,000 = 900,000 → throw
```

**مسیر باگی (`updatePayment`):**
```ts
// 13122 به بعد
if (input.amount != null) data.amount = input.amount // فقط می‌نویسد!
// هیچ محاسبهٔ overpay، هیچ throw
await tx.payment.update({where:{id}, data})
settle = await recalcSettlement(...) // فقط بعدش overpay را ذخیره می‌کند، نه اینکه رد کند
```

`recalcSettlement` → `allocateOverpay` → `overpayAmount = 500,000` را **ثبت** می‌کند، نه اینکه **جلوگیری** کند.

## ۵) مثال عددی ساده‌تر

- فاکتور ۲۰۰٬۰۰۰، پرداخت ۵۰٬۰۰۰ → بدهی ۱۵۰٬۰۰۰
- ویرایش ۵۰٬۰۰۰ → ۳۰۰٬۰۰۰ → باید رد (۱۰۰k اضافه) → ولی قبول می‌شود → `paidTotal 300k > grand 200k`

یا ۱ ریال اضافه هم باید رد شود:
- فاکتور ۱٬۰۰۰٬۰۰۰، پرداخت ۹۹۹٬۹۹۹ → ویرایش به ۱٬۰۰۰٬۰۰۱ → ۱ ریال اضافه → باید رد → الان قبول.

## ۶) اثرش چیست؟

- **دزدیِ قانونی‌نما:** فروشنده می‌تواند هر فاکتور تسویه‌نشده را با ویرایشِ یک ردیف، «پرپول» کند و اضافه را برداشت کند. چون ویرایش با رمز مدیر هم مجاز است، لاگ دارد ولی پول اضافه **مجاز شمرده می‌شود**.
- مغایرت با `addPayment` و `create` که هر دو مطلق رد می‌کنند — یک سوراخ.
- در گزارش «اضافه‌دریافت» می‌افتد ولی جلویش گرفته نمی‌شود.

## ۷) مدرک هارنس (همین کد)

```
after 400k cash: paidTotal 400,000 remaining 600,000
updatePayment to 1.5M ACCEPTED (bug B-P-037): {
  payment: {amount:1500000, overpayAmount:500000},
  paidTotal:1500000, grandTotal:1000000, overpaid:500000
}
BUG CONFIRMED: paidTotal 1500000 > grand 1000000
```

## ۸) درستش چیست؟ (بدون اعمال — فقط برای فهم)

قبل از `tx.payment.update` در `updatePayment` باید همان گارد `addPayment` بیاید:

```ts
// محاسبهٔ سقف بدونِ همین ردیفِ در حال ویرایش
priorRows = payments where invoiceId && id != current.id
remainingWithoutCurrent = invoiceRemaining(grandTotal, receivedTotalOf(priorRows)).remaining
// مثلاً 1,000,000 - 0 = 1,000,000 (چون فقط همین یک ردیف داریم)
if (newAmount > remainingWithoutCurrent) throw BusinessError('اضافه‌پرداخت مجاز نیست...')
// برای مثال 1,500,000 > 1,000,000 → throw
```

یا ساده‌تر: بعد از `data.amount = input.amount`، `settle = await recalcSettlement` را **قبل** از commit حساب کن و اگر `settle.overpaid > 0` → `throw` و rollback.

---
**جمع:** باگِ «درِ پشتی» است — جلوی درِ اصلی (`addPayment`) قفل است، ولی درِ پشتی (`updatePayment`) باز است.
**وضعیت طرح:** ⏳ هنوز در انتظار تایید تو — اگر تایید کنی وارد طرح می‌شود (اهمیت: بالا، چون پول واقعی اضافه می‌گیرد).
