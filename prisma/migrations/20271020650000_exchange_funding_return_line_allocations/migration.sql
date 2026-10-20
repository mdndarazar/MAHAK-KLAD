-- Append-only source attribution for ordinary returns from a validated exchange child.
-- These rows identify accounting origin only; they are never a refund/credit permit.
CREATE TABLE "ExchangeFundingReturnLineAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "returnId" INTEGER NOT NULL,
    "returnItemId" INTEGER NOT NULL,
    "sourceInvoiceId" INTEGER NOT NULL,
    "childInvoiceId" INTEGER NOT NULL,
    "saleItemId" INTEGER NOT NULL,
    "sourceEventId" INTEGER NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "saleItemQty" INTEGER NOT NULL,
    "saleItemValue" BIGINT NOT NULL,
    "sourceItemAmount" BIGINT NOT NULL,
    "returnedQtyBefore" INTEGER NOT NULL,
    "returningQty" INTEGER NOT NULL,
    "returnedQtyAfter" INTEGER NOT NULL,
    "priorReturnValue" BIGINT NOT NULL,
    "returnValue" BIGINT NOT NULL,
    "cumulativeReturnValue" BIGINT NOT NULL,
    "priorAmount" BIGINT NOT NULL,
    "amountDelta" BIGINT NOT NULL,
    "cumulativeAmount" BIGINT NOT NULL,
    "allocationVersion" INTEGER NOT NULL DEFAULT 1,
    "reversesAllocationId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeFundingReturnLineAllocation_scope" CHECK (
      length(trim("eventKey")) BETWEEN 8 AND 240
      AND "eventKind" IN ('ALLOCATION', 'REVERSAL')
      AND typeof("returnId") = 'integer' AND "returnId" > 0
      AND typeof("returnItemId") = 'integer' AND "returnItemId" > 0
      AND typeof("sourceInvoiceId") = 'integer' AND "sourceInvoiceId" > 0
      AND typeof("childInvoiceId") = 'integer' AND "childInvoiceId" > 0
      AND "sourceInvoiceId" <> "childInvoiceId"
      AND typeof("saleItemId") = 'integer' AND "saleItemId" > 0
      AND typeof("sourceEventId") = 'integer' AND "sourceEventId" > 0
      AND "sourceKind" IN ('SOURCE_GIFT', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE')
      AND typeof("saleItemQty") = 'integer' AND "saleItemQty" > 0
      AND typeof("saleItemValue") = 'integer' AND "saleItemValue" > 0
      AND typeof("sourceItemAmount") = 'integer' AND "sourceItemAmount" > 0
      AND "sourceItemAmount" <= "saleItemValue"
      AND typeof("returnedQtyBefore") = 'integer' AND "returnedQtyBefore" >= 0
      AND typeof("returningQty") = 'integer' AND "returningQty" > 0
      AND typeof("returnedQtyAfter") = 'integer'
      AND "returnedQtyAfter" = "returnedQtyBefore" + "returningQty"
      AND "returnedQtyAfter" <= "saleItemQty"
      AND typeof("priorReturnValue") = 'integer' AND "priorReturnValue" >= 0
      AND typeof("returnValue") = 'integer' AND "returnValue" >= 0
      AND typeof("cumulativeReturnValue") = 'integer' AND "cumulativeReturnValue" >= 0
      AND typeof("priorAmount") = 'integer' AND "priorAmount" >= 0
      AND typeof("amountDelta") = 'integer'
      AND typeof("cumulativeAmount") = 'integer' AND "cumulativeAmount" >= 0
      AND typeof("allocationVersion") = 'integer' AND "allocationVersion" > 0
      AND (
        ("eventKind" = 'ALLOCATION' AND "reversesAllocationId" IS NULL
          AND "amountDelta" >= 0 AND "cumulativeAmount" = "priorAmount" + "amountDelta")
        OR
        ("eventKind" = 'REVERSAL' AND typeof("reversesAllocationId") = 'integer'
          AND "reversesAllocationId" > 0 AND "amountDelta" <= 0)
      )
    )
);

CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_eventKey_key"
  ON "ExchangeFundingReturnLineAllocation"("eventKey");
CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_returnItemId_sourceEventId_eventKind_key"
  ON "ExchangeFundingReturnLineAllocation"("returnItemId", "sourceEventId", "eventKind");
CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_reversesAllocationId_key"
  ON "ExchangeFundingReturnLineAllocation"("reversesAllocationId");
CREATE INDEX "ExchangeFundingReturnLineAllocation_childInvoiceId_saleItemId_idx"
  ON "ExchangeFundingReturnLineAllocation"("childInvoiceId", "saleItemId");
CREATE INDEX "ExchangeFundingReturnLineAllocation_returnId_id_idx"
  ON "ExchangeFundingReturnLineAllocation"("returnId", "id");
CREATE INDEX "ExchangeFundingReturnLineAllocation_returnItemId_id_idx"
  ON "ExchangeFundingReturnLineAllocation"("returnItemId", "id");
CREATE INDEX "ExchangeFundingReturnLineAllocation_sourceEventId_id_idx"
  ON "ExchangeFundingReturnLineAllocation"("sourceEventId", "id");

CREATE TRIGGER "exchange_funding_return_line_allocation_no_update"
BEFORE UPDATE ON "ExchangeFundingReturnLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding return line allocations are append-only'); END;
CREATE TRIGGER "exchange_funding_return_line_allocation_no_delete"
BEFORE DELETE ON "ExchangeFundingReturnLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding return line allocations are append-only'); END;
