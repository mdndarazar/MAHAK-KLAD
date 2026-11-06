# Seller invoice-discount exchange — MULTI-EQUAL-CROSS-CATEGORY

**Technical and ledger reconciliation:** PASS
**Isolated SQLite:** /tmp/mahak-seller-discount-multi-equal-cross-category-74plAe/isolated.db

## Fixture
- Original receipt: 4 item(s), gross 40000000, invoice-level discount 10000000, net paid 30000000.
- Source item: 10000000; replacement: 10000000; replacement is a different product and category.

## Observed exchange
- {"sourceGross":10000000,"allocatedInvoiceDiscountShare":2500000,"sourceReturnValue":7500000,"replacementGross":10000000,"replacementCategoryDifferent":true,"actualDifference":2500000,"previewDifference":2500000,"cashReceived":2500000,"cashRefunded":0,"replacementInvoiceDiscount":0,"refundMethod":"NONE"}

## Ledger reconciliation
- {"cashLedger":40000000,"refundLedger":0,"blue":32500000,"reportTotals":{"count":2,"goodsTotal":50000000,"taxTotal":0,"serviceTotal":0,"discountTotal":10000000,"deliveryTotal":0,"grandTotal":40000000,"cashTotal":32500000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":32500000,"returnedTotal":0,"exchangeCreditTotal":7500000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":2500000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":32500000,"exchangeReturnedTotal":7500000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"label":"source-A","actual":10,"ledger":0},{"label":"source-B","actual":9,"ledger":-1},{"label":"source-C","actual":9,"ledger":-1},{"label":"source-D","actual":9,"ledger":-1},{"label":"replacement","actual":9,"ledger":-1}],"payments":[{"id":1,"invoiceId":1,"amount":30000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-MULTI-EQUAL-CROSS-CATEGORY-CASH"},{"id":2,"invoiceId":2,"amount":7500000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"},{"id":3,"invoiceId":2,"amount":2500000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-MULTI-EQUAL-CROSS-CATEGORY-CASH"}],"cashMovements":[],"cheques":0}

Only isolated temporary SQLite was used. No production/staging/live database or real money; no production logic changed.
