# Discount Policy 80 — S09 / all-including-undiscounted-C / NONE

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=300000; direct line discount=10000; invoice discount=0; net=290000.
**Sale:** {"id":1,"gross":300000,"lineDiscount":10000,"invoiceDiscount":0,"totalDiscount":10000,"net":290000,"paid":290000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100000,"lineDiscount":10000,"lineBase":90000,"invoiceDiscountShare":0,"netShare":90000},{"saleItemId":2,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":0,"netShare":100000},{"saleItemId":3,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":0,"netShare":100000}]
**Returns:** [{"id":1,"step":1,"expectedNet":290000,"actualNet":290000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":90000,"restockedQty":1},{"saleItemId":2,"qty":1,"unitPrice":100000,"lineTotal":100000,"restockedQty":1},{"saleItemId":3,"qty":1,"unitPrice":100000,"lineTotal":100000,"restockedQty":1}]}]
**Credits:** [{"id":1,"amount":290000,"status":"ACTIVE","expiresAt":null,"returnId":1}]
**Policy assessment:** {"expectedNetReturnRight":290000,"actualCustomerValue":290000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":290000,"card":0,"refundCash":0,"refundCard":0,"blue":290000},"actual":{"cash":290000,"card":0,"refundCash":0,"refundCard":0},"blue":290000,"stock":{"actual":60,"ledger":0},"invoices":1,"returns":1,"payments":1,"credits":1,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
