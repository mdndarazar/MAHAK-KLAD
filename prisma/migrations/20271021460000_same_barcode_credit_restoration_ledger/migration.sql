-- Append-only record for returning a proven multi-use gift-credit remainder
-- to its original barcode during exchange; reversals are explicit events.
CREATE TABLE "StoreCreditBalanceAdjustment" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventKey" TEXT NOT NULL UNIQUE,
  "creditId" INTEGER NOT NULL,
  "returnId" INTEGER NOT NULL,
  "invoiceId" INTEGER NOT NULL,
  "redemptionId" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "kind" TEXT NOT NULL,
  "beforeUsedAmount" BIGINT NOT NULL,
  "afterUsedAmount" BIGINT NOT NULL,
  "beforeUsedCount" INTEGER NOT NULL,
  "afterUsedCount" INTEGER NOT NULL,
  "reversesEventId" INTEGER UNIQUE,
  "actorUserId" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCreditBalanceAdjustment_positive_amount" CHECK ("amount" > 0),
  CONSTRAINT "StoreCreditBalanceAdjustment_nonnegative_balance" CHECK (
    "beforeUsedAmount" >= 0 AND "afterUsedAmount" >= 0 AND
    "beforeUsedCount" >= 0 AND "afterUsedCount" >= 0
  )
);
CREATE INDEX "StoreCreditBalanceAdjustment_creditId_id_idx"
  ON "StoreCreditBalanceAdjustment"("creditId", "id");
CREATE INDEX "StoreCreditBalanceAdjustment_returnId_id_idx"
  ON "StoreCreditBalanceAdjustment"("returnId", "id");
CREATE INDEX "StoreCreditBalanceAdjustment_redemptionId_idx"
  ON "StoreCreditBalanceAdjustment"("redemptionId");
CREATE TRIGGER "StoreCreditBalanceAdjustment_no_update"
BEFORE UPDATE ON "StoreCreditBalanceAdjustment"
BEGIN
  SELECT RAISE(ABORT, 'StoreCreditBalanceAdjustment is append-only');
END;
CREATE TRIGGER "StoreCreditBalanceAdjustment_no_delete"
BEFORE DELETE ON "StoreCreditBalanceAdjustment"
BEGIN
  SELECT RAISE(ABORT, 'StoreCreditBalanceAdjustment is append-only');
END;
