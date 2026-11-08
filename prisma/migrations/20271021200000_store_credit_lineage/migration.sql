-- Shared redemption budget for a store-credit root and every successor barcode.
-- Historical credits start as independent roots with their current counters copied.
CREATE TABLE "StoreCreditLineage" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "issuedAmount" BIGINT NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 1,
  "multiUse" BOOLEAN NOT NULL DEFAULT false,
  "carryRemainder" BOOLEAN NOT NULL DEFAULT true,
  "usedAmount" BIGINT NOT NULL DEFAULT 0,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "StoreCredit" ADD COLUMN "lineageId" INTEGER;
ALTER TABLE "StoreCreditRedemption" ADD COLUMN "lineageId" INTEGER;
ALTER TABLE "CreditReturnAllocation" ADD COLUMN "restoredCreditId" INTEGER;

INSERT INTO "StoreCreditLineage" (
  "id", "issuedAmount", "maxUses", "multiUse", "carryRemainder", "usedAmount", "usedCount", "createdAt"
)
SELECT
  "id", "amount", "maxUses", "multiUse", "carryRemainder", "usedAmount", "usedCount", "issuedAt"
FROM "StoreCredit";

-- Before this migration every barcode was an independent allowance.
UPDATE "StoreCredit" SET "lineageId" = "id";
UPDATE "StoreCreditRedemption"
SET "lineageId" = (SELECT "lineageId" FROM "StoreCredit" WHERE "StoreCredit"."id" = "StoreCreditRedemption"."creditId");

CREATE INDEX "StoreCredit_lineageId_idx" ON "StoreCredit"("lineageId");
CREATE INDEX "StoreCreditRedemption_lineageId_idx" ON "StoreCreditRedemption"("lineageId");
CREATE INDEX "CreditReturnAllocation_restoredCreditId_idx" ON "CreditReturnAllocation"("restoredCreditId");
