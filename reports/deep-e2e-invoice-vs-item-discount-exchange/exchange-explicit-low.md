# تخفیف کل فاکتور در برابر تخفیف هر قلم — EXCHANGE-EXPLICIT-LOW

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-exchange-explicit-low-WgAMNt/isolated.db

## نتیجهٔ قابل‌خواندن
- {"exchangeApiMode":"explicitly supplied replacement invoiceDiscount (not sent by SalesReturn UI)","sourceSaleGross":10000000,"sourceInvoiceDiscount":1000000,"sourcePaidAndReturnValue":9000000,"replacementGross":9000000,"replacementInvoiceDiscount":900000,"replacementNet":8100000,"diff":-900000,"direction":"refund","cashReceived":0,"cashRefunded":900000,"currentExchangeUiHasManagerAutoDiscount":false,"transferYesNoImplemented":false}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
