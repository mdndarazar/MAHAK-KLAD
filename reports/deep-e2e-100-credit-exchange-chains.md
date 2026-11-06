# گزارش ۱۰۰ سناریوی مستقل زنجیرهٔ فروش/اعتبار/برگشت/تعویض

**اجرا:** 100/100 جریان · PASS 100 · FAIL 0 · خطای غیرمنتظره 0 · توقف امن 0 · finding 0 · رد مورد انتظار 79.
**دیتابیس:** SQLite موقت ایزوله (/tmp/mahak-e2e-100-6MtKlU/isolated.db).
**تعریف blue:** physical cash received + POS received - cash refund - POS refund; store credit and pending/paid C2C transfers are excluded.
**تسویه/چک/نسیه:** 446 فاکتور؛ پرداخت‌نشده 0؛ تسویه‌نشده 0؛ پرداخت چکی 0؛ جدول بدهی 0.
**ماتریس:** تعداد بارکد فروش 0/1/2/3/4/6; tender فروش CASH/CARD/SPLIT; روش‌های برگشت CASH/CARD_TO_CARD/STORE_CREDIT/NONE/CARD.

هر شماره یک جریان مستقل با shift، SKUها، فاکتورها و اعتبارهای خودش است؛ شاخه‌های پرداخت به‌عنوان سناریوی مستقل جدا شمرده نشده‌اند. هر عملیات و رد/تلاش تکراری checkpoint دارد؛ وضعیت BLOCKED یعنی ادامهٔ زنجیره به‌علت توقف امن انجام نشد و جداگانه گزارش شده است.

| # | وضعیت | تعداد کد/مبلغ کد | مدل مصرف | tender | روش برگشت | مراحل تعویض | نتیجه/رد/خطا |
|---:|---|---:|---|---|---|---|---|
| 1 | PASS | 0 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 2 | PASS | 1 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | CASH | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 3 | PASS | 2 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 4 | PASS | 3 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 5 | PASS | 4 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 6 | PASS | 6 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 7 | PASS | 0 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 8 | PASS | 1 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 9 | PASS | 2 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | NONE | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 10 | PASS | 3 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | CASH | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 11 | PASS | 4 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 12 | PASS | 6 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 13 | PASS | 0 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 14 | PASS | 1 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 15 | PASS | 2 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 16 | PASS | 3 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 17 | PASS | 4 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 18 | PASS | 6 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 19 | PASS | 0 × ۲۵٬۰۰۰ | MULTI_LIVE  | CASH | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 20 | PASS | 1 × ۲۵٬۰۰۰ | MULTI_LIVE  | CASH | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 21 | PASS | 2 × ۲۵٬۰۰۰ | MULTI_LIVE و redemption دوم | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 22 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 23 | PASS | 4 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 24 | PASS | 6 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 25 | PASS | 0 × ۵۰٬۰۰۰ | MULTI_LIVE  | SPLIT | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 26 | PASS | 1 × ۵۰٬۰۰۰ | MULTI_LIVE و redemption دوم | SPLIT | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 27 | PASS | 2 × ۵۰٬۰۰۰ | MULTI_LIVE  | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 28 | PASS | 3 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 29 | PASS | 4 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 30 | PASS | 6 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 31 | PASS | 0 × ۱۰۰٬۰۰۰ | MULTI_LIVE و redemption دوم | CARD | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 32 | PASS | 1 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | CARD | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 33 | PASS | 2 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 34 | PASS | 3 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 35 | PASS | 4 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 36 | PASS | 6 × ۱۰۰٬۰۰۰ | MULTI_LIVE و redemption دوم | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 37 | PASS | 0 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 38 | PASS | 1 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 39 | PASS | 2 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 40 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 41 | PASS | 4 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | CARD | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 42 | PASS | 6 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | CARD | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 43 | PASS | 0 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 44 | PASS | 1 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 45 | PASS | 2 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 46 | PASS | 3 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 47 | PASS | 4 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 48 | PASS | 6 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 49 | PASS | 0 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | CARD | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 50 | PASS | 1 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | CARD | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 51 | PASS | 2 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 52 | PASS | 3 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 53 | PASS | 4 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 54 | PASS | 6 × ۱۰۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 55 | PASS | 0 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 56 | PASS | 1 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 57 | PASS | 2 × ۲۵٬۰۰۰ | SINGLE_USED  | CASH | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 58 | PASS | 3 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | CARD | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 59 | PASS | 4 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 60 | PASS | 6 × ۲۵٬۰۰۰ | SINGLE_USED  | CARD | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 61 | PASS | 0 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 62 | PASS | 1 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | CASH | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 63 | PASS | 2 × ۵۰٬۰۰۰ | SINGLE_USED  | SPLIT | CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 64 | PASS | 3 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 65 | PASS | 4 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 66 | PASS | 6 × ۵۰٬۰۰۰ | SINGLE_USED  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 67 | PASS | 0 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 68 | PASS | 1 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 69 | PASS | 2 × ۱۰۰٬۰۰۰ | SINGLE_USED  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 70 | PASS | 3 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 71 | PASS | 4 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | CASH | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 72 | PASS | 6 × ۱۰۰٬۰۰۰ | SINGLE_USED  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 73 | PASS | 0 × ۲۵٬۰۰۰ | MULTI_LIVE  | CASH | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 74 | PASS | 1 × ۲۵٬۰۰۰ | MULTI_LIVE  | CASH | CASH | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 75 | PASS | 2 × ۲۵٬۰۰۰ | MULTI_LIVE  | CASH | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 76 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_LIVE و redemption دوم | CARD | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 77 | PASS | 4 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 78 | PASS | 6 × ۲۵٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 79 | PASS | 0 × ۵۰٬۰۰۰ | MULTI_LIVE  | SPLIT | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 80 | PASS | 1 × ۵۰٬۰۰۰ | MULTI_LIVE  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 81 | PASS | 2 × ۵۰٬۰۰۰ | MULTI_LIVE و redemption دوم | SPLIT | CASH | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 82 | PASS | 3 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | CASH | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 83 | PASS | 4 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 84 | PASS | 6 × ۵۰٬۰۰۰ | MULTI_LIVE  | CASH | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 85 | PASS | 0 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 86 | PASS | 1 × ۱۰۰٬۰۰۰ | MULTI_LIVE و redemption دوم | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 87 | PASS | 2 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | CARD | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 88 | PASS | 3 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 89 | PASS | 4 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 90 | PASS | 6 × ۱۰۰٬۰۰۰ | MULTI_LIVE  | SPLIT | NONE | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 91 | PASS | 0 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | CARD_TO_CARD | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 92 | PASS | 1 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 93 | PASS | 2 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 94 | PASS | 3 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 95 | PASS | 4 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 96 | PASS | 6 × ۲۵٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CARD | NONE | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 97 | PASS | 0 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | STORE_CREDIT | B→۱۸۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 98 | PASS | 1 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | STORE_CREDIT | B→۲۲۰٬۰۰۰; C+D -20k; B1→B2 |  |
| 99 | PASS | 2 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | SPLIT | NONE | B→۱۸۰٬۰۰۰; C+D +20k; B1→B2 |  |
| 100 | PASS | 3 × ۵۰٬۰۰۰ | MULTI_USED_TWICE و redemption دوم | CASH | CARD_TO_CARD | B→۲۲۰٬۰۰۰; C+D +20k; B1→B2 |  |

## یافته‌های double-spend / تبدیل اعتبار به پول نقد

## توقف‌های ایمن نیازمند بازبینی سیاست/تخصیص
- سناریوی 1، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRRPWTC7) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 2، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRAEJCLR) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۶ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 3، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRKRKDTP) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 4، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRFW6MLB) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۴ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 5، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRCAKAAY) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 6، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR3VZJ8E) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 7، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRZEGX4Y) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 8، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR4PBDL6) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۱ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 9، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRWYBXX8) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 10، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR6K7QCP) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۹ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 11، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRDNYBH6) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 12، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRVN86CU) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 13، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR7KA7AX) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۵۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 14، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRGTUZZL) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۵۶ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 15، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRCHGPB4) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۶۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 16، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRBNAGU7) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۶۴ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 16، رد مورد انتظار و mutation-free: credit-only cashout probe: با این برگشت مبلغ اضافه‌ای برای صدور اعتبار خرید ساخته نمی‌شود؛ یا بازپرداخت همان اضافه را پوشش داده یا فاکتور هنوز بدهکار است.
- سناریوی 17، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRCG8AEM) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۶۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 18، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR8EQXUB) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۷۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 19، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRFCT6N7) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۷۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 21، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRZMD739) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۸۶ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 25، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRD9ML46) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۰۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 26، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRKXGVWN) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۰۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 31، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRX8T8DP) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۲۹ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 36، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR3C4B6X) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۵۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 36، رد مورد انتظار و mutation-free: credit-only cashout probe: با این برگشت مبلغ اضافه‌ای برای صدور اعتبار خرید ساخته نمی‌شود؛ یا بازپرداخت همان اضافه را پوشش داده یا فاکتور هنوز بدهکار است.
- سناریوی 37، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR3EVH9W) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۵۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 38، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRXGW83F) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۶۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 39، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRQA79PT) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۶۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 40، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRTF4TR8) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۷۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 41، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRYQVVY2) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۷۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 42، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRPNWAVE) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۸۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 43، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRKNH7BK) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۸۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 44، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR6CHJU6) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۹۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 45، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRMRWH8Y) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۱۹۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 46، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRNDWZRW) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۰۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 47، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR7KEJ3P) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۰۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 48، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRBZFUUB) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۱۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 49، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRM2AMML) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۱۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 50، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRGKKHAH) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۲۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 51، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRHFEHDU) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۲۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 52، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR38JUH7) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۳۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 53، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR3F69C7) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۳۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 54، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRVWERBQ) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۴۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 55، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRN9JCXW) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۴۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 56، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRXWF4WG) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۴۹ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 57، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRMCYC2G) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۵۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 58، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR4336BC) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۵۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 59، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRPWX6PW) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۶۱ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 60، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRY74TAU) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۶۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 61، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRJBX7RT) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۷۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 62، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRUJN78D) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۷۴ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 63، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRP2DBYB) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۷۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 64، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRHEGWQM) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۸۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 65، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRDFXNLG) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۸۶ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 66، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRRHNY2X) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۹۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 66، رد مورد انتظار و mutation-free: credit-only cashout probe: با این برگشت مبلغ اضافه‌ای برای صدور اعتبار خرید ساخته نمی‌شود؛ یا بازپرداخت همان اضافه را پوشش داده یا فاکتور هنوز بدهکار است.
- سناریوی 67، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR29JQLL) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۹۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 68، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRV7ABRQ) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۲۹۹ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 69، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRP7BMX8) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۰۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 70، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRLPJ6LX) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۰۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 71، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRRN8D8Z) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۱۱ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 72، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRAXA2CB) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۱۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 73، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRDNKC4H) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۲۰ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 76، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRAUXHJC) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۳۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 79، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR8N822L) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۴۶ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 81، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR8N3EKU) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۵۵ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 85، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRBMAMY6) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۷۲ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 86، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRXBCLPE) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۷۷ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 91، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRMQRYB8) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۳۹۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 92، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRMAAB6X) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۰۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 93، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRT93NLF) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۰۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 94، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRZ4ZALZ) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۱۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 95، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRKJXHAU) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۱۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 96، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRAFCRYY) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۲۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 97، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRDXFNE4) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۲۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 98، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CR8ZCTQG) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۳۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 99، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRAZTBZG) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۳۸ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- سناریوی 100، رد مورد انتظار و mutation-free: panel lookup/preview check of fully used barcode: این اعتبار (CRNAREVM) کامل مصرف شده است — آخرین مصرف روی فاکتور شماره ۴۴۳ در تاریخ ۱۴۰۵/۰۸/۰۸.
۲ تلاش دیگر باقی مانده است؛ بعد از آن ورود رمز برای ۱۰ دقیقه قفل می‌شود.
- هیچ double-spend تأییدشده یا پرداخت نقد/POSِ بدون پشتوانه در نتایج نهایی ثبت نشد. هر تلاش بازاستفادهٔ کد کاملاًمصرف‌شده که رد شد، بدون invoice/payment/stock/redemption اضافی بود.

## تطبیق ریزبه‌ریز
- جزئیات هر رویداد در JSON کنار همین فایل است: انتظار و نتیجهٔ cash/POS/refunds/blue؛ stock SKU و ledger؛ invoice/return/exchange IDs؛ وضعیت/مانده/usedCount و redemption history هر کد؛ successor و delivery state؛ allocationهای منبع و وضعیت انتقال C2C.
- در خرید اصلی تعداد کدها ۰،۱،۲،۳،۴ یا ۶ است؛ در موارد multi-use کدها یا نیمه‌مصرف‌شده می‌مانند یا با redemption دوم در فاکتور مستقل به‌طور مشروع مصرف می‌شوند. هر کد fully-used برای جلوگیری از double-spend دوباره امتحان می‌شود.
- زنجیرهٔ هدف فروش چهارقلمی، برگشت A، تعویض B، تعویض هم‌زمان C+D و تعویض دوبارهٔ B1 از فاکتور child خودش بود؛ 100 جریان کامل شدند و 0 مورد پیش از تکمیل، در گیت تخصیص منشأ اعتبار به‌صورت mutation-free متوقف شدند. تفاوت مثبت/منفی، tender نقد/POS/اعتبار و روش‌های برگشت در ماتریس چرخانده شدند.

## محدوده و محدودیت
- فقط service-layer و SQLite موقت؛ پنل Electron واقعی، چاپگر واقعی و پایانهٔ POS واقعی اجرا نشدند.
- هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB زنده، stage یا reset استفاده نشد.
- کارت‌به‌کارت فقط در جدول درخواست آزمایشی و با مدیر test-paid می‌شود؛ انتقال واقعی بانکی نیست.
- این تست هیچ production source را تغییر نمی‌دهد.
