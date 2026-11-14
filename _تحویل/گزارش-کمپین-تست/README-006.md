# دستهٔ ۶ — بارکد اعتباری (اجرای ناقص، صادقانه ثبت‌شده)

**کد:** `97d5cc0`

## آنچه قطعی شد
- صدور اعتبار از برگشت: کد ۶ نویسه‌ای (`EQN8AQ`)، مبلغ درست ۱۰۰٬۰۰۰، وضعیت `ACTIVE` ✅
- ستون‌های اعتبار (از schema): `restrictScope`, `restrictCategoryIdsJson`, `restrictVariantIdsJson`,
  `minPurchase`, `maxPerTransaction`, `multiUse`, `maxUses`, `usedAmount`, `usedCount`, `expiresAt`,
  `status`, `carryRemainder`, `lineageId` ⇒ ساختار پشتیبان «ALL / کالا / دسته / چندبارمصرف» موجود است.

## آنچه **اجرا نشد** (نقص تست، نه محصول)
من تلاش کردم اعتبار را با `payments: [{ creditCode }]` مصرف کنم. نتیجه:
فاکتور ثبت شد ولی `usedAmount` و `usedCount` اعتبار **صفر ماند** ⇒ یعنی این شکل درخواست،
اعتبار را مصرف نمی‌کند و فقط پرداخت نقدیِ دقیق انجام شده. پس این‌ها **مصرف اعتبار نیستند** و
نباید به‌عنوان «اعتبار دوبار مصرف شد» یا «اعتبار منقضی پذیرفته شد» تفسیر شوند.

**شکل درست مصرف اعتبار** در کد `creditTenders` است (پرداخت ترکیبی با `requestedAmount` و
تنظیم `splitStoreCreditPayment`)، که باید در دستهٔ ۷ با آن تست شود.

**باگ تأییدشده: ۰**
