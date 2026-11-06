# طرح ۱۳ موردی — نتیجهٔ کامل سناریوی D80-S02

**وضعیت:** PASS؛ هر ۱۸ زیرشاخهٔ ماتریس اجرا شد، هر شاخه روی DB SQLite مستقل. ترکیب‌ها: ۳ tender خرید × ۶ روش برگشت/کنترل؛ S03 تا بسته‌شدن کامل این خانواده آغاز نشد.

## Fixture و oracle
یک قلم با قیمت ناخالص ۱۰۰٬۰۰۰، تخفیف مستقیم ردیف ۱۰٬۰۰۰، بدون تخفیف فاکتور، خالص ۹۰٬۰۰۰. Tender خرید به نوبت CASH=۹۰٬۰۰۰، POS=۹۰٬۰۰۰، SPLIT=CASH ۴۵٬۰۰۰ + POS ۴۵٬۰۰۰ بود. انتظار: برگشت/تسویه/اعتبار net=۹۰٬۰۰۰ و تخفیف برگشتی صفر.

## نتیجهٔ همهٔ زیرشاخه‌ها
| Tender خرید | روش برگشت/کنترل | ثبت و ارزش مشتری | وجه / blue پس از عملیات | اعتبار / موجودی | وضعیت |
|---|---|---|---|---|---|
| CASH | `CARD_TO_CARD` | درخواست/پرداخت مدیر=90,000; ارزش مشتری=90,000 | cash/card ledger unchanged by transfer; blue=90,000 | —; stock=10 (ledger 0) | PASS |
| CASH | `CARD` | برگشت net=90,000؛ برگشت POS=90,000 با gate مدیر; ارزش مشتری=90,000 | card ledger=0؛ POS refund=90,000؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| CASH | `CASH` | برگشت net=90,000؛ وجه نقد=90,000; ارزش مشتری=90,000 | cash ledger=90,000؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| CASH | `MANAGER_FULL_PRICE` | manager-full-price درخواست ۱۰۰٬۰۰۰ در برابر دریافتی ۹۰٬۰۰۰ mutation-free رد شد (کنترل مرزی); ارزش مشتری=۰ | بدون refund؛ blue=90,000 | —; stock=9 (ledger -1) | PASS |
| CASH | `NONE` | NONE؛ اعتبار خودکار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |
| POS | `CARD_TO_CARD` | درخواست/پرداخت مدیر=90,000; ارزش مشتری=90,000 | cash/card ledger unchanged by transfer; blue=90,000 | —; stock=10 (ledger 0) | PASS |
| POS | `CARD` | برگشت net=90,000؛ برگشت POS=90,000 با gate مدیر; ارزش مشتری=90,000 | card ledger=90,000؛ POS refund=90,000؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| POS | `CASH` | برگشت net=90,000؛ وجه نقد=90,000; ارزش مشتری=90,000 | cash ledger=0؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| POS | `MANAGER_FULL_PRICE` | manager-full-price درخواست ۱۰۰٬۰۰۰ در برابر دریافتی ۹۰٬۰۰۰ mutation-free رد شد (کنترل مرزی); ارزش مشتری=۰ | بدون refund؛ blue=90,000 | —; stock=9 (ledger -1) | PASS |
| POS | `NONE` | NONE؛ اعتبار خودکار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |
| POS | `STORE_CREDIT` | برگشت net=90,000؛ اعتبار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |
| SPLIT | `CARD_TO_CARD` | درخواست/پرداخت مدیر=90,000; ارزش مشتری=90,000 | cash/card ledger unchanged by transfer; blue=90,000 | —; stock=10 (ledger 0) | PASS |
| SPLIT | `CARD` | برگشت net=90,000؛ برگشت POS=90,000 با gate مدیر; ارزش مشتری=90,000 | card ledger=45,000؛ POS refund=90,000؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| SPLIT | `CASH` | برگشت net=90,000؛ وجه نقد=90,000; ارزش مشتری=90,000 | cash ledger=45,000؛ blue=0 | —; stock=10 (ledger 0) | PASS |
| SPLIT | `MANAGER_FULL_PRICE` | manager-full-price درخواست ۱۰۰٬۰۰۰ در برابر دریافتی ۹۰٬۰۰۰ mutation-free رد شد (کنترل مرزی); ارزش مشتری=۰ | بدون refund؛ blue=90,000 | —; stock=9 (ledger -1) | PASS |
| SPLIT | `NONE` | NONE؛ اعتبار خودکار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |
| SPLIT | `STORE_CREDIT` | برگشت net=90,000؛ اعتبار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |
| CASH | `STORE_CREDIT` | برگشت net=90,000؛ اعتبار=90,000; ارزش مشتری=90,000 | cash/card unchanged; blue=90,000 | 90,000 / ACTIVE / expiry=None / delivery=PENDING; stock=10 (ledger 0) | PASS |

## جمع‌بندی S02
در تمام ۱۸ حالت، SaleReturnItem و مسیر تسویه به مبلغ خالص ۹۰٬۰۰۰ محدود ماندند. هیچ شاخه‌ای تخفیف ۱۰٬۰۰۰ را به نقد، POS، C2C یا اعتبار اضافه تبدیل نکرد. هر checkpoint وجه خام و گزارش سرویس، blue و موجودی واقعی/ledger را تطبیق داد؛ checks=0. سه tender خرید، ازجمله SPLIT، به‌طور مستقل پوشش یافتند.

کنترل manager-full-price در برابر gross=۱۰۰٬۰۰۰ در هر سه tender، چون جمع وجه واقعی فقط ۹۰٬۰۰۰ بود mutation-free رد شد و PASS طبقه‌بندی شد. در CARD و CARD_TO_CARD فقط gate مربوط به مسیر خودش استفاده شد؛ C2C به‌صورت پرداخت manager در harness مدل شد و انتقال بانکی واقعی انجام نشد.

مشاهدهٔ جانبی خارج از داوری تخفیف: هرجا STORE_CREDIT با ورودی creditDays=30 اجرا شد، کد ۹۰٬۰۰۰ با expiry=null و handoff=PENDING ساخته شد. این یافته تخفیفی اعلام نمی‌شود و نیازمند پیگیری مستقل است.

**گام بعد:** S03، دو قلم هم‌قیمت با invoice discount؛ برگشت هر قلم جدا، هر دو ترتیب و برگشت کامل، با R.

Runner: `../tests/audit-fixes/deep-e2e-discount-policy-80-scenario-02-single-line-discount-return.mjs`; trace هر ۱۸ branch در `deep-e2e-discount-policy-80-s02-*.json`. فقط DB تست ایزوله.
