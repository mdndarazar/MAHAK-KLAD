# Discount Policy 80 — S04 / order-6-CBA / STORE_CREDIT

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=600011; direct line discount=0; invoice discount=42001; net=558010.
**Sale:** {"id":1,"gross":600011,"lineDiscount":0,"invoiceDiscount":42001,"totalDiscount":42001,"net":558010,"paid":558010,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100001,"lineDiscount":0,"lineBase":100001,"invoiceDiscountShare":7000,"netShare":93001},{"saleItemId":2,"gross":200003,"lineDiscount":0,"lineBase":200003,"invoiceDiscountShare":14000,"netShare":186003},{"saleItemId":3,"gross":300007,"lineDiscount":0,"lineBase":300007,"invoiceDiscountShare":21001,"netShare":279006}]
**Returns:** [{"id":1,"step":1,"expectedNet":279006,"actualNet":279006,"refundMethod":"STORE_CREDIT","refundAmount":279006,"refundStoreCreditAmount":0,"items":[{"saleItemId":3,"qty":1,"unitPrice":300007,"lineTotal":279006,"restockedQty":1}]},{"id":2,"step":2,"expectedNet":186003,"actualNet":186003,"refundMethod":"STORE_CREDIT","refundAmount":186003,"refundStoreCreditAmount":0,"items":[{"saleItemId":2,"qty":1,"unitPrice":200003,"lineTotal":186003,"restockedQty":1}]},{"id":3,"step":3,"expectedNet":93001,"actualNet":93001,"refundMethod":"STORE_CREDIT","refundAmount":93001,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100001,"lineTotal":93001,"restockedQty":1}]}]
**Credits:** [{"id":1,"amount":279006,"status":"ACTIVE","expiresAt":null,"returnId":1},{"id":2,"amount":186003,"status":"ACTIVE","expiresAt":null,"returnId":2},{"id":3,"amount":93001,"status":"ACTIVE","expiresAt":null,"returnId":3}]
**Policy assessment:** {"expectedNetReturnRight":558010,"actualCustomerValue":558010,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":558010,"card":0,"refundCash":0,"refundCard":0,"blue":558010},"actual":{"cash":558010,"card":0,"refundCash":0,"refundCard":0},"blue":558010,"stock":{"actual":60,"ledger":0},"invoices":1,"returns":3,"payments":1,"credits":3,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
