-- POS invoice-level idempotency. The request fingerprint is a one-way hash of
-- the economic request; barcodes are canonicalized as an unordered set before
-- hashing so scan order cannot bind an idempotency key to a different credit.
ALTER TABLE "SaleInvoice" ADD COLUMN "saleRequestKey" TEXT;
ALTER TABLE "SaleInvoice" ADD COLUMN "saleRequestFingerprint" TEXT;
CREATE UNIQUE INDEX "SaleInvoice_saleRequestKey_key" ON "SaleInvoice"("saleRequestKey");

-- New return/exchange credits are ACTIVE when issued. Delivery remains an
-- append-only audit fact and is not a prerequisite to redeeming the barcode.
DROP TRIGGER IF EXISTS "StoreCredit_return_credit_must_start_draft";
DROP TRIGGER IF EXISTS "StoreCredit_return_credit_requires_delivery";
DROP TRIGGER IF EXISTS "StoreCreditDelivery_valid_handoff";
CREATE TRIGGER "StoreCreditDelivery_valid_handoff"
BEFORE UPDATE OF "status" ON "StoreCreditDelivery"
WHEN NEW."status" = 'DELIVERED'
  AND (OLD."status" <> 'PENDING' OR NOT EXISTS (
    SELECT 1 FROM "StoreCredit" c
    WHERE c."id" = NEW."creditId"
      AND (c."returnId" IS NOT NULL OR c."exchangeInvoiceId" IS NOT NULL)
      AND c."status" IN ('ACTIVE', 'DRAFT')
      AND c."voidedAt" IS NULL AND c."deletedAt" IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'only a pending linked live credit can record customer delivery');
END;
