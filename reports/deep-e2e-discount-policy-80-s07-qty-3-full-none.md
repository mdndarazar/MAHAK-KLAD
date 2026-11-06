# Discount Policy 80 — S07 / qty-3-full / NONE

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=300000; direct line discount=0; invoice discount=30000; net=270000.
**Sale:** {"id":1,"gross":300000,"lineDiscount":0,"invoiceDiscount":30000,"totalDiscount":30000,"net":270000,"paid":270000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":300000,"lineDiscount":0,"lineBase":300000,"invoiceDiscountShare":30000,"netShare":270000}]
**Returns:** [{"id":1,"step":1,"expectedNet":270000,"actualNet":270000,"refundMethod":"NONE","refundAmount":0,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":3,"unitPrice":100000,"lineTotal":270000,"restockedQty":3}]}]
**Credits:** [{"id":1,"amount":270000,"status":"ACTIVE","expiresAt":null,"returnId":1}]
**Policy assessment:** {"expectedNetReturnRight":270000,"actualCustomerValue":270000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":270000,"card":0,"refundCash":0,"refundCard":0,"blue":270000},"actual":{"cash":270000,"card":0,"refundCash":0,"refundCard":0},"blue":270000,"stock":{"actual":20,"ledger":0},"invoices":1,"returns":1,"payments":1,"credits":1,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
