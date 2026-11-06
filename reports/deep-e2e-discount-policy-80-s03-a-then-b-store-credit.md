# Discount Policy 80 — S03 / A-then-B / STORE_CREDIT

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=200000; direct line discount=0; invoice discount=20000; net=180000.
**Sale:** {"id":1,"gross":200000,"lineDiscount":0,"invoiceDiscount":20000,"totalDiscount":20000,"net":180000,"paid":180000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":10000,"netShare":90000},{"saleItemId":2,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":10000,"netShare":90000}]
**Returns:** [{"id":1,"step":1,"expectedNet":90000,"actualNet":90000,"refundMethod":"STORE_CREDIT","refundAmount":90000,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":90000,"restockedQty":1}]},{"id":2,"step":2,"expectedNet":90000,"actualNet":90000,"refundMethod":"STORE_CREDIT","refundAmount":90000,"refundStoreCreditAmount":0,"items":[{"saleItemId":2,"qty":1,"unitPrice":100000,"lineTotal":90000,"restockedQty":1}]}]
**Credits:** [{"id":1,"amount":90000,"status":"ACTIVE","expiresAt":null,"returnId":1},{"id":2,"amount":90000,"status":"ACTIVE","expiresAt":null,"returnId":2}]
**Policy assessment:** {"expectedNetReturnRight":180000,"actualCustomerValue":180000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":180000,"card":0,"refundCash":0,"refundCard":0,"blue":180000},"actual":{"cash":180000,"card":0,"refundCash":0,"refundCard":0},"blue":180000,"stock":{"actual":40,"ledger":0},"invoices":1,"returns":2,"payments":1,"credits":2,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
