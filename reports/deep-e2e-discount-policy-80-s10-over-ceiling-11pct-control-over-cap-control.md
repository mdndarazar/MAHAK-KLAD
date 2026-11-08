# Discount Policy 80 — S10 / over-ceiling-11pct-control / OVER_CAP_CONTROL

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=100000; direct line discount=0; invoice discount=11000; net=89000.
**Sale:** {"rejected":true,"message":"جمع تخفیف این فاکتور ۱۱٬۰۰۰ ریال است (تخفیف ردیف ۰ ریال، تخفیف کل فاکتور ۱۱٬۰۰۰ ریال و کاهش قیمت زیر قیمت مرجع ۰ ریال) و از سقف مجاز ۱۰٬۰۰۰ ریال بیشتر است (سقف: ۱۰٪ از ۱۰۰٬۰۰۰ ریال). این محدودیت را مدیر در «سیاست تخفیف» تعیین کرده و با رمز مدیر هم باز نمی‌شود.","mutationFree":true}
**Per-item discount/net allocation:** []
**Returns:** []
**Credits:** []
**Policy assessment:** null
**Final reconciliation:** {"expected":{"cash":0,"card":0,"refundCash":0,"refundCard":0,"blue":0},"actual":{"cash":0,"card":0,"refundCash":0,"refundCard":0},"blue":0,"stock":{"actual":20,"ledger":0},"invoices":0,"returns":0,"payments":0,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
