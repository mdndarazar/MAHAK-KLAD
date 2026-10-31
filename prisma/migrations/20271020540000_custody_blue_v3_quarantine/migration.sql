-- New witnesses use V3. Preserve every V1/V2 historical row and its amount.
ALTER TABLE "CustodyBlueSnapshot" ADD COLUMN "evidenceDigest" TEXT;
-- Do not mutate the original financial snapshot to explain a broken chain.
-- Case and later manager resolution are distinct, immutable rows.
CREATE TABLE "CustodyEvidenceQuarantine" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "sourceKey" TEXT NOT NULL UNIQUE,
  "shiftId" INTEGER NOT NULL,
  "handoverId" INTEGER,
  "snapshotId" INTEGER,
  "reasonCode" TEXT NOT NULL,
  "detectedEpoch" INTEGER NOT NULL,
  "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CustodyEvidenceQuarantine_shiftId_detectedAt_idx" ON "CustodyEvidenceQuarantine"("shiftId", "detectedAt");
CREATE INDEX "CustodyEvidenceQuarantine_handoverId_idx" ON "CustodyEvidenceQuarantine"("handoverId");
CREATE TABLE "CustodyEvidenceRecovery" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "quarantineId" INTEGER NOT NULL UNIQUE,
  "shiftId" INTEGER NOT NULL,
  "managerUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL DEFAULT 'MANAGER_CUSTODY_PIN',
  "countedAmount" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "recoverySnapshotId" INTEGER,
  "seenEpoch" INTEGER NOT NULL,
  "epochAfter" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("quarantineId") REFERENCES "CustodyEvidenceQuarantine"("id") ON DELETE RESTRICT
);
CREATE INDEX "CustodyEvidenceRecovery_shiftId_at_idx" ON "CustodyEvidenceRecovery"("shiftId", "at");
CREATE TRIGGER "custody_evidence_quarantine_no_update" BEFORE UPDATE ON "CustodyEvidenceQuarantine"
BEGIN SELECT RAISE(ABORT, 'custody evidence quarantine is append-only'); END;
CREATE TRIGGER "custody_evidence_quarantine_no_delete" BEFORE DELETE ON "CustodyEvidenceQuarantine"
BEGIN SELECT RAISE(ABORT, 'custody evidence quarantine is append-only'); END;
CREATE TRIGGER "custody_evidence_recovery_no_update" BEFORE UPDATE ON "CustodyEvidenceRecovery"
BEGIN SELECT RAISE(ABORT, 'custody evidence recovery is append-only'); END;
CREATE TRIGGER "custody_evidence_recovery_no_delete" BEFORE DELETE ON "CustodyEvidenceRecovery"
BEGIN SELECT RAISE(ABORT, 'custody evidence recovery is append-only'); END;
