-- Additive blue-reference evidence. No existing sale, payment, cash-close,
-- custody count or historical aggregate is rewritten or reclassified.
ALTER TABLE "CustodyState" ADD COLUMN "financialRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CustodyBlueSnapshot" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "handoverId" INTEGER,
  "shiftId" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL,
  "countOrigin" TEXT NOT NULL,
  "humanAmount" BIGINT,
  "arithmeticAmount" BIGINT,
  "referenceFromDay" TEXT NOT NULL,
  "referenceToDay" TEXT NOT NULL,
  "scopeKind" TEXT NOT NULL,
  "referenceStatus" TEXT NOT NULL,
  "referenceAmount" BIGINT,
  "knownSubtotal" BIGINT,
  "ambiguousLegacyCredit" BIGINT,
  "calculationVersion" TEXT NOT NULL,
  "sourceScope" TEXT,
  "sourceHash" TEXT,
  "financialRevision" INTEGER NOT NULL,
  "epochAtCount" INTEGER NOT NULL,
  "priorSnapshotId" INTEGER,
  "rawDifference" BIGINT,
  "inheritedDifference" BIGINT,
  "freshDifference" BIGINT,
  "freshStatus" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "operationalDay" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("handoverId") REFERENCES "CustodyHandover"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustodyBlueSnapshot_handoverId_role_key" ON "CustodyBlueSnapshot"("handoverId", "role");
CREATE INDEX "CustodyBlueSnapshot_shiftId_at_idx" ON "CustodyBlueSnapshot"("shiftId", "at");
CREATE INDEX "CustodyBlueSnapshot_operationalDay_role_at_idx" ON "CustodyBlueSnapshot"("operationalDay", "role", "at");
CREATE INDEX "CustodyBlueSnapshot_priorSnapshotId_idx" ON "CustodyBlueSnapshot"("priorSnapshotId");

CREATE TABLE "CustodyBlueResolution" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "snapshotId" INTEGER NOT NULL,
  "managerUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL,
  "decisionKind" TEXT NOT NULL,
  "evidenceDay" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "ambiguousAmount" BIGINT NOT NULL,
  "effectiveReferenceAmount" BIGINT NOT NULL,
  "resolvedRawDifference" BIGINT,
  "resolvedFreshDifference" BIGINT,
  "freshStatus" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("snapshotId") REFERENCES "CustodyBlueSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CustodyBlueResolution_snapshotId_at_idx" ON "CustodyBlueResolution"("snapshotId", "at");
CREATE INDEX "CustodyBlueResolution_managerUserId_at_idx" ON "CustodyBlueResolution"("managerUserId", "at");

-- Defend the financial evidence even from accidental UPDATE / DELETE in a
-- future service. A correction is a separate CustodyBlueResolution row.
CREATE TRIGGER "custody_blue_snapshot_no_update" BEFORE UPDATE ON "CustodyBlueSnapshot"
BEGIN SELECT RAISE(ABORT, 'custody blue snapshots are append-only'); END;
CREATE TRIGGER "custody_blue_snapshot_no_delete" BEFORE DELETE ON "CustodyBlueSnapshot"
BEGIN SELECT RAISE(ABORT, 'custody blue snapshots are append-only'); END;
CREATE TRIGGER "custody_blue_resolution_no_update" BEFORE UPDATE ON "CustodyBlueResolution"
BEGIN SELECT RAISE(ABORT, 'custody blue resolutions are append-only'); END;
CREATE TRIGGER "custody_blue_resolution_no_delete" BEFORE DELETE ON "CustodyBlueResolution"
BEGIN SELECT RAISE(ABORT, 'custody blue resolutions are append-only'); END;

-- Every write to report-affecting financial rows increments the same revision
-- inside the SQLite writer transaction. A payment can have zero net effect and
-- still invalidate an unfinished blind count. Changes outside today's scope
-- may invalidate unnecessarily; false acceptance is never allowed.
CREATE TRIGGER "custody_blue_payment_insert_rev" AFTER INSERT ON "Payment"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_payment_update_rev" AFTER UPDATE ON "Payment"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_payment_delete_rev" AFTER DELETE ON "Payment"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_invoice_insert_rev" AFTER INSERT ON "SaleInvoice"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_invoice_update_rev" AFTER UPDATE ON "SaleInvoice"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_invoice_delete_rev" AFTER DELETE ON "SaleInvoice"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_return_insert_rev" AFTER INSERT ON "SaleReturn"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_return_update_rev" AFTER UPDATE ON "SaleReturn"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_return_delete_rev" AFTER DELETE ON "SaleReturn"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
-- A historical CREDIT/null bucket can also change if its method is edited.
CREATE TRIGGER "custody_blue_method_insert_rev" AFTER INSERT ON "PaymentMethod"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_method_update_rev" AFTER UPDATE ON "PaymentMethod"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
CREATE TRIGGER "custody_blue_method_delete_rev" AFTER DELETE ON "PaymentMethod"
BEGIN UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN'; END;
