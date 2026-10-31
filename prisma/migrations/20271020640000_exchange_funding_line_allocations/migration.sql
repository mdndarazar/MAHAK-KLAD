-- Freeze the proven funding matrix for each replacement sale item. This is
-- descriptive provenance only: no refund or exchange authorization is inferred.
CREATE TABLE "ExchangeFundingLineAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "sourceInvoiceId" INTEGER NOT NULL,
    "childInvoiceId" INTEGER NOT NULL,
    "returnId" INTEGER NOT NULL,
    "sourceEventId" INTEGER NOT NULL,
    "saleItemId" INTEGER NOT NULL,
    "saleItemQty" INTEGER NOT NULL,
    "saleItemValue" BIGINT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeFundingLineAllocation_scope" CHECK (
      length(trim("eventKey")) BETWEEN 8 AND 240
      AND typeof("sourceInvoiceId") = 'integer' AND "sourceInvoiceId" > 0
      AND typeof("childInvoiceId") = 'integer' AND "childInvoiceId" > 0
      AND "sourceInvoiceId" <> "childInvoiceId"
      AND typeof("returnId") = 'integer' AND "returnId" > 0
      AND typeof("sourceEventId") = 'integer' AND "sourceEventId" > 0
      AND typeof("saleItemId") = 'integer' AND "saleItemId" > 0
      AND typeof("saleItemQty") = 'integer' AND "saleItemQty" > 0
      AND typeof("saleItemValue") = 'integer' AND "saleItemValue" > 0
      AND "sourceKind" IN ('SOURCE_GIFT', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE')
      AND typeof("amount") = 'integer' AND "amount" > 0
    )
);

CREATE UNIQUE INDEX "ExchangeFundingLineAllocation_eventKey_key"
  ON "ExchangeFundingLineAllocation"("eventKey");
CREATE UNIQUE INDEX "ExchangeFundingLineAllocation_sourceEventId_saleItemId_key"
  ON "ExchangeFundingLineAllocation"("sourceEventId", "saleItemId");
CREATE INDEX "ExchangeFundingLineAllocation_childInvoiceId_saleItemId_idx"
  ON "ExchangeFundingLineAllocation"("childInvoiceId", "saleItemId");
CREATE INDEX "ExchangeFundingLineAllocation_returnId_id_idx"
  ON "ExchangeFundingLineAllocation"("returnId", "id");
CREATE INDEX "ExchangeFundingLineAllocation_sourceInvoiceId_id_idx"
  ON "ExchangeFundingLineAllocation"("sourceInvoiceId", "id");

CREATE TRIGGER "exchange_funding_line_allocation_no_update"
BEFORE UPDATE ON "ExchangeFundingLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding line allocations are append-only'); END;
CREATE TRIGGER "exchange_funding_line_allocation_no_delete"
BEFORE DELETE ON "ExchangeFundingLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding line allocations are append-only'); END;
