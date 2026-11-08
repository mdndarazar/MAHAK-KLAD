# تخفیف کل فاکتور در برابر تخفیف هر قلم — EXCHANGE-UI-EQUAL

**نتیجهٔ آزمون:** FAIL
**SQLite موقت:** /tmp/mahak-invoice-item-discount-exchange-ui-equal-EZ696L/isolated.db

## نتیجهٔ قابل‌خواندن
- {"message":"Expected values to be strictly equal:\n\n0 !== 1000000\n","stack":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 1000000\n\n    at file:///home/user/MAHAK-KLAD/tests/audit-fixes/deep-e2e-invoice-vs-item-discount-exchange.mjs:96:11"}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
