-- Validate existing return-item scope and active physical quantities. New
-- triggers cannot retroactively protect rows written by older application
-- versions, and historical evidence must never be rewritten to appear valid.
-- A temporary CHECK table makes any inconsistency abort this migration while
-- leaving the shop database's return documents untouched for reconciliation.
CREATE TEMP TABLE "_sale_return_history_validation" (
  "violation" INTEGER NOT NULL CHECK ("violation" = 0)
);

-- Every historical SaleReturnItem must remain attached to the same invoice and
-- variant as its source SaleInvoiceItem. LEFT JOINs catch broken/missing links
-- as well as a valid but incorrect parent scope.
INSERT INTO "_sale_return_history_validation" ("violation")
SELECT 1
FROM "SaleReturnItem" ri
LEFT JOIN "SaleReturn" r ON r."id" = ri."returnId"
LEFT JOIN "SaleInvoiceItem" si ON si."id" = ri."saleItemId"
WHERE r."id" IS NULL
   OR si."id" IS NULL
   OR r."invoiceId" IS NOT si."invoiceId"
   OR ri."variantId" IS NOT si."variantId";

-- Only a physical void releases active quantity. Corrections and all other
-- historical rows remain in this aggregate, matching the live write guards.
INSERT INTO "_sale_return_history_validation" ("violation")
SELECT 1
FROM "SaleInvoiceItem" si
WHERE COALESCE((
  SELECT SUM(ri."qty")
  FROM "SaleReturnItem" ri
  JOIN "SaleReturn" r ON r."id" = ri."returnId"
  WHERE ri."saleItemId" = si."id"
    AND r."voidedAt" IS NULL
), 0) > si."qty";

DROP TABLE "_sale_return_history_validation";
