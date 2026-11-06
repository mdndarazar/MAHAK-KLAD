# تخفیف کل فاکتور در برابر تخفیف هر قلم — INVOICE-PERCENT-100-LINES

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-invoice-percent-100-lines-JPUCJk/isolated.db

## نتیجهٔ قابل‌خواندن
- {"mechanism":"DiscountPolicy FIXED/PERCENT is an invoice-level discount; separate from line discounts","skuCount":100,"eachGross":100000,"gross":10000000,"invoiceDiscount":1000000,"netPaid":9000000,"itemDiscountsSum":0,"storedInvoiceDiscount":1000000,"storedLineTotalSum":10000000}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
