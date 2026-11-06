# تخفیف کل فاکتور در برابر تخفیف هر قلم — EXCHANGE-EXPLICIT-EQUAL

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-exchange-explicit-equal-lVG429/isolated.db

## نتیجهٔ قابل‌خواندن
- {"exchangeApiMode":"explicitly supplied replacement invoiceDiscount (not sent by SalesReturn UI)","sourceSaleGross":10000000,"sourceInvoiceDiscount":1000000,"sourcePaidAndReturnValue":9000000,"replacementGross":10000000,"replacementInvoiceDiscount":1000000,"replacementNet":9000000,"diff":0,"direction":"zero","cashReceived":0,"cashRefunded":0,"currentExchangeUiHasManagerAutoDiscount":false,"transferYesNoImplemented":false}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
