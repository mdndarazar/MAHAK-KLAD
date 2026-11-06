# Seller invoice-discount exchange — SINGLE-LOW

**Technical and ledger reconciliation:** PASS
**Isolated SQLite:** /tmp/mahak-seller-discount-single-low-xuKiz7/isolated.db

## Fixture
- Original receipt: 1 item(s), gross 20000000, invoice-level discount 2000000, net paid 18000000.
- Source item: 20000000; replacement: 10000000; replacement is a different product and category.

## Observed exchange
- {"sourceGross":20000000,"allocatedInvoiceDiscountShare":2000000,"sourceReturnValue":18000000,"replacementGross":10000000,"replacementCategoryDifferent":true,"actualDifference":-8000000,"previewDifference":-8000000,"cashReceived":0,"cashRefunded":8000000,"replacementInvoiceDiscount":0,"refundMethod":"CASH"}

## Ledger reconciliation
- {"cashLedger":28000000,"refundLedger":8000000,"blue":10000000,"reportTotals":{"count":2,"goodsTotal":30000000,"taxTotal":0,"serviceTotal":0,"discountTotal":2000000,"deliveryTotal":0,"grandTotal":28000000,"cashTotal":18000000,"cardTotal":0,"creditTotal":0,"otherTotal":0,"receivedTotal":18000000,"returnedTotal":0,"exchangeCreditTotal":10000000,"storeCreditUsedTotal":0,"storeCreditIssuedTotal":0,"exchangeCount":1,"exchangeDiffTotal":-8000000,"overpayTotal":0,"creditRemainingTotal":0,"priorSettlementTotal":0,"netReceivedTotal":18000000,"exchangeReturnedTotal":18000000,"refundCashTotal":8000000,"refundCardTotal":0,"refundDebtOnlyTotal":0,"storeCreditRefundTotal":0,"legacyRefundCount":0,"managerAccountTotal":0,"destinationUnknownTotal":0},"stock":[{"label":"source-source","actual":10,"ledger":0},{"label":"replacement","actual":9,"ledger":-1}],"payments":[{"id":1,"invoiceId":1,"amount":18000000,"kind":"CASH","destination":"CASH","methodKind":"CASH","key":"SELLER-DISCOUNT-SINGLE-LOW-CASH"},{"id":2,"invoiceId":2,"amount":10000000,"kind":"CASH","destination":null,"methodKind":"EXCHANGE_CREDIT","key":"EXCHANGE_CREDIT"}],"cashMovements":[{"type":"EXCHANGE_REFUND","amount":8000000}],"cheques":0}

Only isolated temporary SQLite was used. No production/staging/live database or real money; no production logic changed.
