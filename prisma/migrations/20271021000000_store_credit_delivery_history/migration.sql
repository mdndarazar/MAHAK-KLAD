-- Delivery/printing is an audit fact, not a usability gate. A linked return or
-- exchange credit may already be partially used or spent when the cashier records
-- that its paper/barcode reached the customer, so allow the pending history row to
-- be completed for every non-void, non-deleted linked credit without changing its
-- financial status.
DROP TRIGGER IF EXISTS "StoreCreditDelivery_valid_handoff";
CREATE TRIGGER "StoreCreditDelivery_valid_handoff"
BEFORE UPDATE OF "status" ON "StoreCreditDelivery"
WHEN NEW."status" = 'DELIVERED'
  AND (OLD."status" <> 'PENDING' OR NOT EXISTS (
    SELECT 1 FROM "StoreCredit" c
    WHERE c."id" = NEW."creditId"
      AND (c."returnId" IS NOT NULL OR c."exchangeInvoiceId" IS NOT NULL)
      AND c."voidedAt" IS NULL AND c."deletedAt" IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'only a pending live linked credit can record customer delivery');
END;
