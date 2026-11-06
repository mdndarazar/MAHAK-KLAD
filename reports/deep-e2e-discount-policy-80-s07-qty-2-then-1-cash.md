# Discount Policy 80 — S07 / qty-2-then-1 / CASH

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=300000; direct line discount=0; invoice discount=30000; net=270000.
**Sale:** {"id":1,"gross":300000,"lineDiscount":0,"invoiceDiscount":30000,"totalDiscount":30000,"net":270000,"paid":270000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":300000,"lineDiscount":0,"lineBase":300000,"invoiceDiscountShare":30000,"netShare":270000}]
**Returns:** [{"id":1,"step":1,"expectedNet":180000,"actualNet":180000,"refundMethod":"CASH","refundAmount":180000,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":2,"unitPrice":100000,"lineTotal":180000,"restockedQty":2}]},{"id":2,"step":2,"expectedNet":90000,"actualNet":90000,"refundMethod":"CASH","refundAmount":90000,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":90000,"restockedQty":1}]}]
**Credits:** []
**Policy assessment:** {"expectedNetReturnRight":270000,"actualCustomerValue":270000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":270000,"card":0,"refundCash":270000,"refundCard":0,"blue":0},"actual":{"cash":270000,"card":0,"refundCash":270000,"refundCard":0},"blue":0,"stock":{"actual":20,"ledger":0},"invoices":1,"returns":2,"payments":1,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
