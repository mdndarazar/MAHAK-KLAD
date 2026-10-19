-- Append-only provenance events for value carried through exchange invoices.
-- Scalar references are deliberate: hard-deleting a business document must not
-- cascade away financial evidence. Historical rows are NOT guessed/backfilled.
CREATE TABLE "ExchangeFundingEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "shareId" TEXT NOT NULL,
    "rootShareId" TEXT NOT NULL,
    "sourceInvoiceId" INTEGER,
    "childInvoiceId" INTEGER,
    "returnId" INTEGER,
    "sourcePaymentId" INTEGER,
    "sourceRedemptionId" INTEGER,
    "sourceCreditId" INTEGER,
    "parentEventId" INTEGER,
    "debtId" INTEGER,
    "sourceMethodKind" TEXT,
    "sourceDestination" TEXT,
    "evidenceKind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "evidenceRef" TEXT,
    "actorUserId" INTEGER,
    "reversesEventId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeFundingEvent_amount_kind" CHECK (
      ("kind" IN ('SNAPSHOT_STALE', 'SNAPSHOT_RECONCILED') AND "amount" = 0)
      OR ("kind" NOT IN ('SNAPSHOT_STALE', 'SNAPSHOT_RECONCILED') AND "amount" <> 0)
    )
);

CREATE UNIQUE INDEX "ExchangeFundingEvent_eventKey_key" ON "ExchangeFundingEvent"("eventKey");
CREATE UNIQUE INDEX "ExchangeFundingEvent_reversesEventId_key" ON "ExchangeFundingEvent"("reversesEventId");
CREATE INDEX "ExchangeFundingEvent_shareId_id_idx" ON "ExchangeFundingEvent"("shareId", "id");
CREATE INDEX "ExchangeFundingEvent_sourceInvoiceId_id_idx" ON "ExchangeFundingEvent"("sourceInvoiceId", "id");
CREATE INDEX "ExchangeFundingEvent_childInvoiceId_id_idx" ON "ExchangeFundingEvent"("childInvoiceId", "id");
CREATE INDEX "ExchangeFundingEvent_returnId_id_idx" ON "ExchangeFundingEvent"("returnId", "id");
CREATE INDEX "ExchangeFundingEvent_parentEventId_idx" ON "ExchangeFundingEvent"("parentEventId");
