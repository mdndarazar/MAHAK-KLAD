# Discount Policy 80 — S08 / both-discounts-item-A / CARD_TO_CARD

**Status:** PASS; isolated SQLite database per branch.
**Fixture:** gross=300000; direct line discount=10000; invoice discount=20000; net=270000.
**Sale:** {"id":1,"gross":300000,"lineDiscount":10000,"invoiceDiscount":20000,"totalDiscount":30000,"net":270000,"paid":270000,"settled":true}
**Per-item discount/net allocation:** [{"saleItemId":1,"gross":100000,"lineDiscount":10000,"lineBase":90000,"invoiceDiscountShare":6207,"netShare":83793},{"saleItemId":2,"gross":200000,"lineDiscount":0,"lineBase":200000,"invoiceDiscountShare":13793,"netShare":186207}]
**Returns:** [{"id":1,"step":1,"expectedNet":83793,"actualNet":83793,"refundMethod":"CARD_TO_CARD","refundAmount":83793,"refundStoreCreditAmount":0,"items":[{"saleItemId":1,"qty":1,"unitPrice":100000,"lineTotal":83793,"restockedQty":0}]}]
**Credits:** []
**Policy assessment:** {"expectedNetReturnRight":83793,"actualCustomerValue":83793,"discountReturned":0,"deviations":[]}
**Final reconciliation:** {"expected":{"cash":270000,"card":0,"refundCash":0,"refundCard":0,"blue":270000},"actual":{"cash":270000,"card":0,"refundCash":0,"refundCard":0},"blue":270000,"stock":{"actual":39,"ledger":-1},"invoices":1,"returns":1,"payments":1,"credits":0,"checks":0}
Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.
