-- Safe recovery for open Shifts created before custody metadata existed.
-- All tables are additive; legacy financial rows are never backfilled or rewritten.
CREATE TABLE "LegacyShiftRecovery" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL,
  "witnessUserId" INTEGER NOT NULL,
  "actorKind" TEXT NOT NULL,
  "authMethod" TEXT NOT NULL,
  "countedCash" BIGINT NOT NULL,
  "expectedTotalSnapshot" BIGINT,
  "provisionalDifference" BIGINT,
  "differenceScope" TEXT NOT NULL,
  "ackTextVersion" TEXT NOT NULL,
  "note" TEXT,
  "epochBefore" INTEGER NOT NULL,
  "epochAfter" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "operationalDay" TEXT NOT NULL
);
CREATE INDEX "LegacyShiftRecovery_createdAt_idx" ON "LegacyShiftRecovery"("createdAt");
CREATE INDEX "LegacyShiftRecovery_differenceScope_idx" ON "LegacyShiftRecovery"("differenceScope");

CREATE TABLE "LegacyShiftRecoveryItem" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "recoveryId" INTEGER NOT NULL,
  "shiftId" INTEGER NOT NULL UNIQUE,
  "legacyUserId" INTEGER,
  "openedAtSnapshot" DATETIME NOT NULL,
  "lastActivityAt" DATETIME,
  "invoiceCountSnapshot" INTEGER NOT NULL DEFAULT 0,
  "expectedCashSnapshot" BIGINT,
  "expectedCalcStatus" TEXT NOT NULL,
  "openingFloatSnapshot" BIGINT,
  "cashInSnapshot" BIGINT,
  "cashOutSnapshot" BIGINT,
  "closedAtWritten" DATETIME NOT NULL,
  FOREIGN KEY ("recoveryId") REFERENCES "LegacyShiftRecovery"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LegacyShiftRecoveryItem_recoveryId_idx" ON "LegacyShiftRecoveryItem"("recoveryId");

CREATE TABLE "LegacyShiftRecoveryReview" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "recoveryId" INTEGER NOT NULL,
  "itemId" INTEGER,
  "decision" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "authMethod" TEXT NOT NULL,
  "actorUserId" INTEGER,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("recoveryId") REFERENCES "LegacyShiftRecovery"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("itemId") REFERENCES "LegacyShiftRecoveryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LegacyShiftRecoveryReview_recoveryId_createdAt_idx" ON "LegacyShiftRecoveryReview"("recoveryId", "createdAt");
CREATE INDEX "LegacyShiftRecoveryReview_itemId_createdAt_idx" ON "LegacyShiftRecoveryReview"("itemId", "createdAt");

CREATE TABLE "LegacyRecoveryOpeningLink" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "recoveryId" INTEGER NOT NULL UNIQUE,
  "openingShiftId" INTEGER NOT NULL UNIQUE,
  "openingCountId" INTEGER NOT NULL,
  "recoveryCountedCash" BIGINT NOT NULL,
  "openingCountedCash" BIGINT NOT NULL,
  "gapCash" BIGINT NOT NULL,
  "reason" TEXT,
  "openerUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("recoveryId") REFERENCES "LegacyShiftRecovery"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("openingShiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("openingCountId") REFERENCES "CustodyCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LegacyRecoveryOpeningLink_openingCountId_idx" ON "LegacyRecoveryOpeningLink"("openingCountId");

ALTER TABLE "CustodyEvent" ADD COLUMN "legacyRecoveryId" INTEGER;
CREATE INDEX "CustodyEvent_legacyRecoveryId_at_idx" ON "CustodyEvent"("legacyRecoveryId", "at");
