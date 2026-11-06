# تخفیف کل فاکتور در برابر تخفیف هر قلم — EXCHANGE-EXPLICIT-HIGH

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-exchange-explicit-high-xTdIxt/isolated.db

## نتیجهٔ قابل‌خواندن
- {"exchangeApiMode":"explicitly supplied replacement invoiceDiscount (not sent by SalesReturn UI)","sourceSaleGross":10000000,"sourceInvoiceDiscount":1000000,"sourcePaidAndReturnValue":9000000,"replacementGross":11000000,"replacementInvoiceDiscount":1100000,"replacementNet":9900000,"diff":900000,"direction":"collect","cashReceived":900000,"cashRefunded":0,"currentExchangeUiHasManagerAutoDiscount":false,"transferYesNoImplemented":false}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
