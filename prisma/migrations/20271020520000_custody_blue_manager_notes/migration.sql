-- An optional annotation is a NEW manager-authenticated row. Do not change
-- the frozen financial document, its count, its reference, or its resolution.
CREATE TABLE "CustodyBlueNote" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "snapshotId" INTEGER NOT NULL,
  "managerUserId" INTEGER NOT NULL,
  "authMethod" TEXT NOT NULL DEFAULT 'MANAGER_CUSTODY_PIN',
  "text" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("snapshotId") REFERENCES "CustodyBlueSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CustodyBlueNote_snapshotId_at_idx" ON "CustodyBlueNote"("snapshotId", "at");
CREATE INDEX "CustodyBlueNote_managerUserId_at_idx" ON "CustodyBlueNote"("managerUserId", "at");
CREATE TRIGGER "custody_blue_note_no_update" BEFORE UPDATE ON "CustodyBlueNote"
BEGIN SELECT RAISE(ABORT, 'custody blue notes are append-only'); END;
CREATE TRIGGER "custody_blue_note_no_delete" BEFORE DELETE ON "CustodyBlueNote"
BEGIN SELECT RAISE(ABORT, 'custody blue notes are append-only'); END;
