-- Global store-credit return rule: preserve immutable, cumulative source shares.
-- ALL-scope credits stay invoice-pooled (saleItemId is NULL); only a manager-
-- restricted source may record the eligible returned sale item.
CREATE TABLE "CreditReturnAllocation" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventKey" TEXT NOT NULL,
  "invoiceId" INTEGER NOT NULL,
  "returnId" INTEGER NOT NULL,
  "redemptionId" INTEGER NOT NULL,
  "sourceCreditId" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "creditRestored" BOOLEAN NOT NULL DEFAULT 1,
  "settlementAdjusted" BOOLEAN NOT NULL DEFAULT 1,
  "restrictScope" TEXT NOT NULL DEFAULT 'ALL',
  "saleItemId" INTEGER,
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CreditReturnAllocation_eventKey_key" ON "CreditReturnAllocation"("eventKey");
CREATE INDEX "CreditReturnAllocation_invoiceId_redemptionId_idx" ON "CreditReturnAllocation"("invoiceId", "redemptionId");
CREATE INDEX "CreditReturnAllocation_returnId_idx" ON "CreditReturnAllocation"("returnId");
CREATE INDEX "CreditReturnAllocation_sourceCreditId_idx" ON "CreditReturnAllocation"("sourceCreditId");
CREATE TRIGGER "CreditReturnAllocation_no_update"
BEFORE UPDATE ON "CreditReturnAllocation"
BEGIN
  SELECT RAISE(ABORT, 'CreditReturnAllocation is append-only');
END;
CREATE TRIGGER "CreditReturnAllocation_no_delete"
BEFORE DELETE ON "CreditReturnAllocation"
BEGIN
  SELECT RAISE(ABORT, 'CreditReturnAllocation is append-only');
END;
