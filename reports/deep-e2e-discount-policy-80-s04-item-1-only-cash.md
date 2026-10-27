# Discount Policy 80 — S04 / item-1-only / CASH

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=600011; direct line discount=0; invoice discount=42001; net=558010.
**Sale:** {"id":1,"gross":600011,"lineDiscount":0,"invoiceDiscount":42001,"totalDiscount":42001,"net":558010,"paid":558010,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100001,"lineDiscount":0,"lineBase":100001,"invoiceDiscountShare":7000,"netShare":93001},{"saleItemId":2,"gross":200003,"lineDiscount":0,"lineBase":200003,"invoiceDiscountShare":14000,"netShare":186003},{"saleItemId":3,"gross":300007,"lineDiscount":0,"lineBase":300007,"invoiceDiscountShare":21001,"netShare":279006}]
**Returns:** [{"id":1,"step":1,"expectedNet":93001,"actualNet":93001,"refundMethod":"CASH","refundAmount":93001,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100001,"lineTotal":93001,"restockedQty":1}]}]
**Credits:** []
**Policy assessment:** {"expectedNetReturnRight":93001,"actualCustomerValue":93001,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":558010,"card":0,"refundCash":93001,"refundCard":0,"blue":465009},"actual":{"cash":558010,"card":0,"refundCash":93001,"refundCard":0},"blue":465009,"stock":{"actual":58,"ledger":-2},"invoices":1,"returns":1,"payments":1,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
