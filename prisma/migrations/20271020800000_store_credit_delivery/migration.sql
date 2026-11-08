-- Return/exchange barcodes remain unusable until an operator confirms actual
-- handoff to the customer. Printing is deliberately not treated as delivery.
-- No legacy backfill is made: earlier rows do not prove whether the customer
-- actually received their barcode, so existing ACTIVE credits retain their
-- historical state rather than receiving a fabricated delivery attestation.
CREATE TABLE "StoreCreditDelivery" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "creditId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'DELIVERED', 'CANCELED')),
  "handoffType" TEXT NOT NULL DEFAULT 'CUSTOMER',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" DATETIME,
  "userId" INTEGER,
  "note" TEXT,
  "policyVersion" INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "StoreCreditDelivery_creditId_key" ON "StoreCreditDelivery"("creditId");
CREATE INDEX "StoreCreditDelivery_status_createdAt_idx" ON "StoreCreditDelivery"("status", "createdAt");
CREATE TRIGGER "StoreCreditDelivery_valid_handoff"
BEFORE UPDATE OF "status" ON "StoreCreditDelivery"
WHEN NEW."status" = 'DELIVERED'
  AND (OLD."status" <> 'PENDING' OR NOT EXISTS (
    SELECT 1 FROM "StoreCredit" c
    WHERE c."id" = NEW."creditId" AND c."status" = 'DRAFT'
      AND (c."returnId" IS NOT NULL OR c."exchangeInvoiceId" IS NOT NULL)
      AND c."voidedAt" IS NULL AND c."deletedAt" IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'only a pending linked DRAFT credit can be handed to a customer');
END;

-- A linked return/exchange credit cannot be inserted directly as ACTIVE.
CREATE TRIGGER "StoreCredit_return_credit_must_start_draft"
BEFORE INSERT ON "StoreCredit"
WHEN NEW."status" = 'ACTIVE' AND (NEW."returnId" IS NOT NULL OR NEW."exchangeInvoiceId" IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'return/exchange store credit must start as DRAFT');
END;

-- A linked return/exchange credit can only be ACTIVE after its delivery ledger is DELIVERED, including manager reactivation attempts.
CREATE TRIGGER "StoreCredit_return_credit_requires_delivery"
BEFORE UPDATE OF "status" ON "StoreCredit"
WHEN OLD."status" <> 'ACTIVE' AND NEW."status" = 'ACTIVE'
  AND (NEW."returnId" IS NOT NULL OR NEW."exchangeInvoiceId" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "StoreCreditDelivery" d
    WHERE d."creditId" = NEW."id" AND d."status" = 'DELIVERED'
  )
BEGIN
  SELECT RAISE(ABORT, 'return/exchange store credit cannot activate before customer delivery');
END;
