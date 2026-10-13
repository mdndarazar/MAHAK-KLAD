-- Aggregate custody reconciliation is additive.  Existing cash-only count,
-- cash-close, legacy recovery and shift rows retain their original meaning.
CREATE TABLE "CustodyAggregateBoundary" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "boundaryKind" TEXT NOT NULL,
  "fromShiftId" INTEGER,
  "toShiftId" INTEGER,
  "handoverId" INTEGER,
  "previousBoundaryId" INTEGER,
  "priorAcceptedObservedTotal" BIGINT NOT NULL,
  "priorTheoreticalTotal" BIGINT NOT NULL,
  "physicalMovement" BIGINT NOT NULL,
  "operationalExpectedTotal" BIGINT NOT NULL,
  "theoreticalExpectedTotal" BIGINT NOT NULL,
  "observedOperationalTotal" BIGINT NOT NULL,
  "newDifference" BIGINT NOT NULL,
  "totalTheoreticalDifference" BIGINT NOT NULL,
  "countedByUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL,
  "calculationVersion" TEXT NOT NULL DEFAULT 'aggregate-v1',
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "operationalDay" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("handoverId") REFERENCES "CustodyHandover"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustodyAggregateBoundary_handoverId_key" ON "CustodyAggregateBoundary"("handoverId");
CREATE INDEX "CustodyAggregateBoundary_fromShiftId_at_idx" ON "CustodyAggregateBoundary"("fromShiftId", "at");
CREATE INDEX "CustodyAggregateBoundary_toShiftId_at_idx" ON "CustodyAggregateBoundary"("toShiftId", "at");
CREATE INDEX "CustodyAggregateBoundary_operationalDay_at_idx" ON "CustodyAggregateBoundary"("operationalDay", "at");
CREATE INDEX "CustodyAggregateBoundary_previousBoundaryId_idx" ON "CustodyAggregateBoundary"("previousBoundaryId");

CREATE TABLE "CustodyDiscrepancyCase" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "boundaryId" INTEGER NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "boundaryKind" TEXT NOT NULL,
  "fromShiftId" INTEGER,
  "toShiftId" INTEGER,
  "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "operationalExpectedTotal" BIGINT NOT NULL,
  "theoreticalExpectedTotal" BIGINT NOT NULL,
  "observedOperationalTotal" BIGINT NOT NULL,
  "differenceAmount" BIGINT NOT NULL,
  "totalTheoreticalDifference" BIGINT NOT NULL,
  "operationalDay" TEXT NOT NULL,
  "closedAt" DATETIME,
  "closedByUserId" INTEGER,
  "currentReviewResult" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY ("boundaryId") REFERENCES "CustodyAggregateBoundary"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CustodyDiscrepancyCase_status_detectedAt_idx" ON "CustodyDiscrepancyCase"("status", "detectedAt");
CREATE INDEX "CustodyDiscrepancyCase_operationalDay_idx" ON "CustodyDiscrepancyCase"("operationalDay");

CREATE TABLE "CustodyDiscrepancyReview" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "caseId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "managerUserId" INTEGER,
  "actorKind" TEXT NOT NULL DEFAULT 'MANAGER_SESSION',
  "result" TEXT,
  "note" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  FOREIGN KEY ("caseId") REFERENCES "CustodyDiscrepancyCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CustodyDiscrepancyReview_caseId_at_idx" ON "CustodyDiscrepancyReview"("caseId", "at");
CREATE INDEX "CustodyDiscrepancyReview_managerUserId_at_idx" ON "CustodyDiscrepancyReview"("managerUserId", "at");
