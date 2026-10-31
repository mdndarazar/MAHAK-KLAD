-- S7: witnessed, append-only corrections for N rights. B is deliberately
-- excluded because its validity is rooted in gift expiry, not cash evidence.
CREATE TABLE "ExchangeResidualRightPaymentEvidence" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "paymentId" INTEGER NOT NULL,
  "confirmedAmount" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "documentBase64" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "reviewedByUserId" INTEGER,
  "reviewNote" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExchangeResidualRightPaymentEvidence_check" CHECK (
    "paymentId" > 0 AND "confirmedAmount" > 0 AND "confirmedAmount" <= 9007199254740991 AND
    length("sha256") = 64 AND length(trim("fileName")) > 0 AND
    length("documentBase64") > 0 AND "mimeType" IN ('application/pdf', 'text/csv') AND
    length(trim("reviewNote")) >= 10
  )
);
CREATE UNIQUE INDEX "ExchangeResidualRightPaymentEvidence_paymentId_key"
  ON "ExchangeResidualRightPaymentEvidence"("paymentId");
CREATE INDEX "ExchangeResidualRightPaymentEvidence_sha256_idx"
  ON "ExchangeResidualRightPaymentEvidence"("sha256");
CREATE TRIGGER "exchange_residual_right_payment_evidence_no_update"
BEFORE UPDATE ON "ExchangeResidualRightPaymentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'S7 payment evidence is immutable');
END;
CREATE TRIGGER "exchange_residual_right_payment_evidence_no_delete"
BEFORE DELETE ON "ExchangeResidualRightPaymentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'S7 payment evidence is immutable');
END;

CREATE TABLE "ExchangeResidualRightCorrectionEvent" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventKey" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "rightKey" TEXT NOT NULL,
  "rightKind" TEXT NOT NULL,
  "eventKind" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "availableDelta" BIGINT NOT NULL DEFAULT 0,
  "disputedDelta" BIGINT NOT NULL DEFAULT 0,
  "basisAmount" BIGINT NOT NULL DEFAULT 0,
  "sourceInvoiceId" INTEGER NOT NULL,
  "childInvoiceId" INTEGER NOT NULL,
  "rootReturnId" INTEGER NOT NULL,
  "sourceEventId" INTEGER NOT NULL,
  "rootShareId" TEXT NOT NULL,
  "relatedInvoiceId" INTEGER,
  "relatedPaymentId" INTEGER,
  "relatedReturnId" INTEGER,
  "parentCorrectionEventId" INTEGER,
  "actorUserId" INTEGER,
  "evidenceKind" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExchangeResidualRightCorrectionEvent_scope_check" CHECK (
    "rightKind" = 'N' AND length(trim("rightKey")) >= 8 AND
    length(trim("operationKey")) >= 8 AND length(trim("rootShareId")) > 0 AND
    "sourceInvoiceId" > 0 AND "childInvoiceId" > 0 AND "rootReturnId" > 0 AND
    "sourceEventId" > 0 AND "amount" >= 0 AND "amount" <= 9007199254740991 AND
    "basisAmount" >= 0 AND "basisAmount" <= 9007199254740991 AND
    length(trim("evidenceKind")) > 0 AND length(trim("evidenceRef")) >= 8 AND
    length(trim("reason")) >= 8
  ),
  CONSTRAINT "ExchangeResidualRightCorrectionEvent_kind_check" CHECK (
    ("eventKind" = 'RIGHT_ADJUST' AND "amount" > 0 AND "availableDelta" = -"amount" AND "disputedDelta" = 0 AND "basisAmount" = 0 AND "relatedInvoiceId" IS NULL AND "relatedPaymentId" IS NULL AND "relatedReturnId" IS NULL AND "parentCorrectionEventId" IS NULL)
    OR ("eventKind" = 'DISPUTED_RECOVERY_OPEN' AND "amount" > 0 AND "availableDelta" = 0 AND "disputedDelta" = "amount" AND "basisAmount" > 0 AND "relatedInvoiceId" > 0 AND "relatedPaymentId" > 0 AND "relatedReturnId" IS NULL AND "parentCorrectionEventId" IS NULL)
    OR ("eventKind" = 'DISPUTE_OFFSET_BY_RETURN' AND "amount" > 0 AND "availableDelta" = 0 AND "disputedDelta" = -"amount" AND "basisAmount" > 0 AND "relatedInvoiceId" > 0 AND "relatedPaymentId" > 0 AND "relatedReturnId" > 0 AND "parentCorrectionEventId" > 0)
    OR ("eventKind" IN ('SOURCE_QUARANTINED', 'SOURCE_REATTRIBUTED') AND "amount" = 0 AND "availableDelta" = 0 AND "disputedDelta" = 0 AND "basisAmount" = 0)
  )
);
CREATE UNIQUE INDEX "ExchangeResidualRightCorrectionEvent_eventKey_key"
  ON "ExchangeResidualRightCorrectionEvent"("eventKey");
CREATE INDEX "ExchangeResidualRightCorrectionEvent_rightKey_id_idx"
  ON "ExchangeResidualRightCorrectionEvent"("rightKey", "id");
CREATE INDEX "ExchangeResidualRightCorrectionEvent_operationKey_id_idx"
  ON "ExchangeResidualRightCorrectionEvent"("operationKey", "id");
CREATE INDEX "ExchangeResidualRightCorrectionEvent_relatedReturnId_id_idx"
  ON "ExchangeResidualRightCorrectionEvent"("relatedReturnId", "id");
CREATE INDEX "ExchangeResidualRightCorrectionEvent_parentCorrectionEventId_idx"
  ON "ExchangeResidualRightCorrectionEvent"("parentCorrectionEventId");
CREATE TRIGGER "exchange_residual_right_correction_no_update"
BEFORE UPDATE ON "ExchangeResidualRightCorrectionEvent"
BEGIN
  SELECT RAISE(ABORT, 'S7 residual right corrections are append-only');
END;
CREATE TRIGGER "exchange_residual_right_correction_no_delete"
BEFORE DELETE ON "ExchangeResidualRightCorrectionEvent"
BEGIN
  SELECT RAISE(ABORT, 'S7 residual right corrections are append-only');
END;
