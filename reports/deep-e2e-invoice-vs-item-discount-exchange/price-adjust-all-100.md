# تخفیف کل فاکتور در برابر تخفیف هر قلم — PRICE-ADJUST-ALL-100

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-price-adjust-all-100-9YNLqY/isolated.db

## نتیجهٔ قابل‌خواندن
- {"mechanism":"PriceAdjust scope ALL mutates each SKU salePrice; it is not an invoice discount field","skuCount":100,"baseEach":100000,"adjustedEach":90000,"totalBase":10000000,"totalAfter":9000000,"storedInvoiceDiscount":0,"lineRows":100}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
