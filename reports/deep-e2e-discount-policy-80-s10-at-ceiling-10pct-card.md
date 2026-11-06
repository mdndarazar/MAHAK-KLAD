# Discount Policy 80 — S10 / at-ceiling-10pct / CARD

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=100000; direct line discount=0; invoice discount=10000; net=90000.
**Sale:** {"id":1,"gross":100000,"lineDiscount":0,"invoiceDiscount":10000,"totalDiscount":10000,"net":90000,"paid":90000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":10000,"netShare":90000}]
**Returns:** [{"id":1,"step":1,"expectedNet":90000,"actualNet":90000,"refundMethod":"CARD","refundAmount":90000,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":90000,"restockedQty":1}]}]
**Credits:** []
**Policy assessment:** {"expectedNetReturnRight":90000,"actualCustomerValue":90000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":90000,"card":0,"refundCash":0,"refundCard":90000,"blue":0},"actual":{"cash":90000,"card":0,"refundCash":0,"refundCard":90000},"blue":0,"stock":{"actual":20,"ledger":0},"invoices":1,"returns":1,"payments":1,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
