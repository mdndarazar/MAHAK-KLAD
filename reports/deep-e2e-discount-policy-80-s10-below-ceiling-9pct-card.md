# Discount Policy 80 — S10 / below-ceiling-9pct / CARD

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=100000; direct line discount=0; invoice discount=9000; net=91000.
**Sale:** {"id":1,"gross":100000,"lineDiscount":0,"invoiceDiscount":9000,"totalDiscount":9000,"net":91000,"paid":91000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100000,"lineDiscount":0,"lineBase":100000,"invoiceDiscountShare":9000,"netShare":91000}]
**Returns:** [{"id":1,"step":1,"expectedNet":91000,"actualNet":91000,"refundMethod":"CARD","refundAmount":91000,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":91000,"restockedQty":1}]}]
**Credits:** []
**Policy assessment:** {"expectedNetReturnRight":91000,"actualCustomerValue":91000,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":91000,"card":0,"refundCash":0,"refundCard":91000,"blue":0},"actual":{"cash":91000,"card":0,"refundCash":0,"refundCard":91000},"blue":0,"stock":{"actual":20,"ledger":0},"invoices":1,"returns":1,"payments":1,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
