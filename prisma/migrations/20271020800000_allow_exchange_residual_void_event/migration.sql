-- Extend the append-only residual-right journal with the inverse of OPENED.
-- Rebuild is required because SQLite cannot alter the original CHECK constraint.
PRAGMA foreign_keys=OFF;
DROP TRIGGER IF EXISTS "exchange_residual_right_event_no_update";
DROP TRIGGER IF EXISTS "exchange_residual_right_event_no_delete";
ALTER TABLE "ExchangeResidualRightEvent" RENAME TO "ExchangeResidualRightEvent_before_void";

CREATE TABLE "ExchangeResidualRightEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "rightKey" TEXT NOT NULL,
    "rightKind" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "availableDelta" BIGINT NOT NULL,
    "reservedDelta" BIGINT NOT NULL,
    "spentDelta" BIGINT NOT NULL,
    "sourceInvoiceId" INTEGER NOT NULL,
    "childInvoiceId" INTEGER NOT NULL,
    "returnId" INTEGER NOT NULL,
    "sourceEventId" INTEGER NOT NULL,
    "rootShareId" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "operationKey" TEXT,
    "relatedInvoiceId" INTEGER,
    "relatedPaymentId" INTEGER,
    "actorUserId" INTEGER,
    "evidenceKind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "evidenceRef" TEXT,
    "reversesEventId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeResidualRightEvent_scope_check" CHECK (
      "sourceInvoiceId" > 0 AND "childInvoiceId" > 0 AND "returnId" > 0 AND
      "sourceEventId" > 0 AND length(trim("rootShareId")) > 0 AND
      "amount" <= 9007199254740991
    ),
    CONSTRAINT "ExchangeResidualRightEvent_kind_check" CHECK ("rightKind" IN ('B', 'N')),
    CONSTRAINT "ExchangeResidualRightEvent_event_check" CHECK (
      ("eventKind" = 'OPENED' AND "amount" > 0 AND "availableDelta" = "amount" AND "reservedDelta" = 0 AND "spentDelta" = 0)
      OR ("eventKind" = 'RESERVED' AND "amount" > 0 AND "availableDelta" = -"amount" AND "reservedDelta" = "amount" AND "spentDelta" = 0)
      OR ("eventKind" = 'COMMITTED' AND "amount" > 0 AND "availableDelta" = 0 AND "reservedDelta" = -"amount" AND "spentDelta" = "amount")
      OR ("eventKind" = 'CANCELLED' AND "amount" > 0 AND "availableDelta" = "amount" AND "reservedDelta" = -"amount" AND "spentDelta" = 0)
      OR ("eventKind" = 'RESTORED' AND "amount" > 0 AND "availableDelta" = "amount" AND "reservedDelta" = 0 AND "spentDelta" = -"amount")
      OR ("eventKind" = 'VOIDED' AND "amount" > 0 AND "availableDelta" = -"amount" AND "reservedDelta" = 0 AND "spentDelta" = 0)
    ),
    CONSTRAINT "ExchangeResidualRightEvent_n_no_expiry" CHECK ("rightKind" <> 'N' OR "expiresAt" IS NULL)
);

INSERT INTO "ExchangeResidualRightEvent" (
  "id", "eventKey", "rightKey", "rightKind", "eventKind", "amount", "availableDelta",
  "reservedDelta", "spentDelta", "sourceInvoiceId", "childInvoiceId", "returnId", "sourceEventId",
  "rootShareId", "expiresAt", "operationKey", "relatedInvoiceId", "relatedPaymentId", "actorUserId",
  "evidenceKind", "evidenceRef", "reversesEventId", "createdAt"
)
SELECT "id", "eventKey", "rightKey", "rightKind", "eventKind", "amount", "availableDelta",
  "reservedDelta", "spentDelta", "sourceInvoiceId", "childInvoiceId", "returnId", "sourceEventId",
  "rootShareId", "expiresAt", "operationKey", "relatedInvoiceId", "relatedPaymentId", "actorUserId",
  "evidenceKind", "evidenceRef", "reversesEventId", "createdAt"
FROM "ExchangeResidualRightEvent_before_void";
DROP TABLE "ExchangeResidualRightEvent_before_void";

CREATE UNIQUE INDEX "ExchangeResidualRightEvent_eventKey_key" ON "ExchangeResidualRightEvent"("eventKey");
CREATE UNIQUE INDEX "ExchangeResidualRightEvent_reversesEventId_key" ON "ExchangeResidualRightEvent"("reversesEventId");
CREATE UNIQUE INDEX "ExchangeResidualRightEvent_one_open_key" ON "ExchangeResidualRightEvent"("rightKey") WHERE "eventKind" = 'OPENED';
CREATE INDEX "ExchangeResidualRightEvent_rightKey_id_idx" ON "ExchangeResidualRightEvent"("rightKey", "id");
CREATE INDEX "ExchangeResidualRightEvent_returnId_id_idx" ON "ExchangeResidualRightEvent"("returnId", "id");
CREATE INDEX "ExchangeResidualRightEvent_sourceEventId_id_idx" ON "ExchangeResidualRightEvent"("sourceEventId", "id");
CREATE INDEX "ExchangeResidualRightEvent_scope_id_idx" ON "ExchangeResidualRightEvent"("sourceInvoiceId", "childInvoiceId", "id");

CREATE TRIGGER "exchange_residual_right_event_no_update"
BEFORE UPDATE ON "ExchangeResidualRightEvent"
BEGIN
  SELECT RAISE(ABORT, 'exchange residual right events are append-only');
END;
CREATE TRIGGER "exchange_residual_right_event_no_delete"
BEFORE DELETE ON "ExchangeResidualRightEvent"
BEGIN
  SELECT RAISE(ABORT, 'exchange residual right events are append-only');
END;
PRAGMA foreign_keys=ON;
