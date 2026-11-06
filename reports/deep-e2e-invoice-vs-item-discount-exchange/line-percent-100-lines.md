# تخفیف کل فاکتور در برابر تخفیف هر قلم — LINE-PERCENT-100-LINES

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-line-percent-100-lines-vLGmEp/isolated.db

## نتیجهٔ قابل‌خواندن
- {"mechanism":"100 independently discounted rows; each 10% discount is 10,000, aggregate discount remains 10% of gross, not 100 repeated/compounded discounts","rowCount":100,"gross":10000000,"discount":1000000,"net":9000000,"perRowDiscount":10000,"perRowNet":90000}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
