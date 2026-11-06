# Seller invoice-discount exchange — SINGLE-EQUAL

**Technical and ledger reconciliation:** PASS
**Isolated SQLite:** /tmp/mahak-seller-discount-single-equal-PHyWgA/isolated.db

## Fixture
- Original receipt: 1 item(s), gross 20000000, invoice-level discount 2000000, net paid 18000000.
- Source item: 20000000; replacement: 20000000; replacement is a different product and category.

## Observed exchange
- {"sourceGross":20000000,"allocatedInvoiceDiscountShare":2000000,"sourceReturnValue":18000000,"replacementGross":20000000,"replacementCategoryDifferent":true,"actualDifference":2000000,"previewDifference":2000000,"cashReceived":2000000,"cashRefunded":0,"replacementInvoiceDiscount":0,"refundMethod":"NONE"}

## Ledger reconciliation
- {"cashLedger":38000000,"refundLedger":0,"blue":20000000,"reportTotals":{"count":2,"goodsTotal":40000000,"taxTotal":0,"serviceTotal":0,"discountTotal":2000000,"deliveryTotal":0,"grandTotal":38000000,"cashTotal":20000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":20000000,"returnedTotal":0,"exchangeCreditTotal":18000000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":2000000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":20000000,"exchangeReturnedTotal":18000000,"refundCashTotal":0,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"label":"source-source","actual":10,"ledger":0},{"label":"replacement","actual":9,"ledger":-1}],"payments":[{"id":1,"invoiceId":1,"amount":18000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-SINGLE-EQUAL-CASH"},{"id":2,"invoiceId":2,"amount":18000000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"},{"id":3,"invoiceId":2,"amount":2000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-SINGLE-EQUAL-CASH"}],"cashMovements":[],"cheques":0}

Only isolated temporary SQLite was used. No production/staging/live database or real money; no production logic changed.
