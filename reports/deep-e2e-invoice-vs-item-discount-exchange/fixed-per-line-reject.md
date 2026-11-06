# تخفیف کل فاکتور در برابر تخفیف هر قلم — FIXED-PER-LINE-REJECT

**نتیجهٔ آزمون:** PASS
**SQLite موقت:** /tmp/mahak-invoice-item-discount-fixed-per-line-reject-Q7lDjR/isolated.db

## نتیجهٔ قابل‌خواندن
- {"managerFixedInvoicePolicyAcceptsLineDiscount":false,"rejection":"سیاست تخفیف «فقط تخفیف ثابت مدیر» است؛ تخفیف ردیف یا کاهش قیمت کالا مجاز نیست (تخفیف ردیف ۱٬۰۰۰٬۰۰۰ ریال، تخفیف کل فاکتور ۰ ریال و کاهش قیمت زیر قیمت مرجع ۰ ریال). این محدودیت را مدیر در «سیاست تخفیف» تعیین کرده و با رمز مدیر هم باز نمی‌شود.","mutationFree":true}

فقط SQLite موقت/ایزوله؛ بدون DB واقعی/staging و وجه واقعی. هیچ منطق production تغییر نکرد.
