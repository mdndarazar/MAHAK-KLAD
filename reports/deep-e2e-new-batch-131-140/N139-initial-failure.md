# سناریوی جدید N139

**وضعیت:** FAIL
**پایگاه داده:** SQLite موقت ایزوله (/tmp/mahak-next10-139-eH0oMT/isolated.db)

## مراحل و تطبیق‌ها
- issue-credit: {"operation":"issue-credit","id":1,"code":"CRPXH4QF","amount":50000,"multiUse":true,"label":"credit-1","status":"ACTIVE","scope":"ALL","expiresAt":1795811399999}
- sale: {"operation":"sale","invoiceId":1,"gross":200000,"lineDiscount":0,"invoiceDiscount":0,"net":200000,"tender":"CASH","creditCode":"CRPXH4QF","items":[{"id":1,"variantId":1,"qty":2,"unitPrice":100000,"discount":0,"lineTotal":200000}]}
- undefined: {"label":"sale invoice 1: gross=200000; discounts=0; net=200000","expected":{"cash":150000,"card":0,"refundCash":0,"refundCard":0,"blue":150000},"actual":{"cash":150000,"card":0,"refundCash":0,"refundCard":0},"raw":{"cash":150000,"card":0,"refundCash":0,"refundCard":0},"blue":150000,"stock":[{"id":1,"name":"two-qty-credit-funded-item","expected":8,"actual":8,"ledger":-2}],"invoices":[{"id":1,"total":200000,"paid":200000,"discount":0,"status":"SETTLED","settled":true,"parent":null}],"returnCount":0,"creditStates":[{"id":1,"code":"CRPXH4QF","amount":50000,"usedAmount":50000,"usedCount":1,"status":"USED","expiresAt":1795811399999,"scope":"ALL"}],"checkPayments":0}

## ارزیابی نهایی
- نتیجهٔ مورد انتظار: {"cash":150000,"card":0,"refundCash":0,"refundCard":0,"blue":150000}
- نتیجهٔ واقعی: {"cash":150000,"card":0,"refundCash":0,"refundCard":0}؛ blue=150000
- موجودی/دفتر: [{"name":"two-qty-credit-funded-item","expected":8,"actual":8,"ledger":-2}]
- فاکتور=1؛ برگشت/تعویض=0؛ اعتبار=1؛ چک=0
- یافته‌ها: []
- شکست/رد: {"message":"بازپرداخت یا اعتبارِ درخواستی ۷۵٬۰۰۰ ریال برای فاکتور ۱ ممکن نیست: ارزش رسمی اقلام انتخاب‌شده برای برگشت فقط ۵۰٬۰۰۰ ریال است.\nمبلغی تا همین ارزش وارد کنید؛ سقف پول دریافتی و تسویه‌ی بدهی جداگانه و طبق وضعیت فاکتور اعمال می‌شود.","stack":"BusinessError: بازپرداخت یا اعتبارِ درخواستی ۷۵٬۰۰۰ ریال برای فاکتور ۱ ممکن نیست: ارزش رسمی اقلام انتخاب‌شده برای برگشت فقط ۵۰٬۰۰۰ ریال است.\nمبلغی تا همین ارزش وارد کنید؛ سقف پول دریافتی و تسویه‌ی بدهی جداگانه و طبق وضعیت فاکتور اعمال می‌شود.\n    at resolveRefund (file:///home/user/MAHAK-KLAD/src/main/services/SalesService.ts:3828:11)\n    at runReturn (file:///home/user/MAHAK-KLAD/src/main/services/SalesService.ts:4297:16)\n    at async file:///home/user/MAHAK-KLAD/src/main/services/SalesService.ts:7031:20\n    at async client.$transaction (file:///home/user/MAHAK-KLAD/test/harness/prismaLite.mjs:921:22)\n    at async file:///home/user/MAHAK-KLAD/tests/audit-fixes/deep-e2e-next10-discount-exchange-credit.mjs:263:17"}

فقط مسیر service-layer و دیتابیس موقت تستی استفاده شد. منطق production، دیتابیس واقعی، staging و چاپ فیزیکی دست‌نخورده‌اند.
