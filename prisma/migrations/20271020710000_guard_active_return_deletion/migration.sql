-- Active return evidence may not be physically erased to free sold quantity.
-- ReturnDelete is a void operation; only SaleReturn.voidedAt changes activity.
-- An atomic returnUpdate briefly voids its parent inside its transaction before
-- replacing rows, then reactivates it under the existing sold-cap trigger.
CREATE TRIGGER "sale_return_item_active_delete_guard"
BEFORE DELETE ON "SaleReturnItem"
WHEN EXISTS (
  SELECT 1 FROM "SaleReturn" r
  WHERE r."id" = OLD."returnId" AND r."voidedAt" IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'active sale return item deletion requires a voided return');
END;

-- A hard delete of an active parent would cascade-delete its line evidence.
-- Purge explicitly marks rows voided in the same transaction before deletion.
CREATE TRIGGER "sale_return_active_delete_guard"
BEFORE DELETE ON "SaleReturn"
WHEN OLD."voidedAt" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'active sale return deletion requires voiding');
END;
