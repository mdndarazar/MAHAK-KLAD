-- New return provenance only. Keep every historic Payment, redemption and
-- StoreCredit untouched. A redemption compensated via a distinct B/E branch
-- must NEVER be reversed a second time by a later purge/void.
-- Snapshot the non-cash share on NEW returns for report aggregation: historic
-- returns remain 0 and reports never need to guess from the refund method.
ALTER TABLE "SaleReturn" ADD COLUMN "creditRestored" BIGINT NOT NULL DEFAULT 0;
-- Historic exchange receipts keep their original layout. New documents use a
-- separate credit paper so reprinting the accounting receipt cannot reissue a
-- spendable barcode without the manager's reprint check.
ALTER TABLE "SaleReturn" ADD COLUMN "creditPaperSeparate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreCreditRedemption" ADD COLUMN "compensatedAt" DATETIME;
ALTER TABLE "StoreCreditRedemption" ADD COLUMN "compensatedReturnId" INTEGER;
-- Past expiry is UNKNOWN, not a fabricated 'no expiry' fact.
ALTER TABLE "StoreCreditRedemption" ADD COLUMN "expiryCaptured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreCreditRedemption" ADD COLUMN "expiryAtRedeem" DATETIME;
CREATE INDEX "StoreCreditRedemption_compensatedReturnId_idx" ON "StoreCreditRedemption"("compensatedReturnId");

CREATE TABLE "CreditReturnAllocation" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "returnId" INTEGER NOT NULL,
  "invoiceId" INTEGER NOT NULL,
  "redemptionId" INTEGER NOT NULL,
  "parentCreditId" INTEGER NOT NULL,
  "rootCreditId" INTEGER NOT NULL,
  "originNominal" BIGINT NOT NULL,
  "amount" BIGINT NOT NULL,
  -- Part of an unusable one-shot parent remainder transferred exactly once.
  -- NOT a refund of this sale and NEVER included in debt/OVERPAY.
  "supplementUnspent" BIGINT NOT NULL DEFAULT 0,
  "successorCreditId" INTEGER,
  "kind" TEXT NOT NULL,
  "originalExpiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditReturnAllocation_nonnegative" CHECK ("amount" > 0 AND "originNominal" > 0 AND "supplementUnspent" >= 0)
);
CREATE UNIQUE INDEX "CreditReturnAllocation_returnId_redemptionId_key"
  ON "CreditReturnAllocation"("returnId", "redemptionId");
CREATE UNIQUE INDEX "CreditReturnAllocation_successorCreditId_key"
  ON "CreditReturnAllocation"("successorCreditId");
CREATE INDEX "CreditReturnAllocation_parentCreditId_id_idx"
  ON "CreditReturnAllocation"("parentCreditId", "id");
CREATE INDEX "CreditReturnAllocation_rootCreditId_id_idx"
  ON "CreditReturnAllocation"("rootCreditId", "id");
CREATE INDEX "CreditReturnAllocation_invoiceId_idx"
  ON "CreditReturnAllocation"("invoiceId");
