-- S8 partial exchange of a child invoice is still a physical child return.
-- First allow SOURCE_N in the persisted replacement-line matrix; its proof is
-- the same committed residual-right tender contract used by the ledger reader.
DROP TRIGGER IF EXISTS "exchange_funding_line_allocation_no_update";
DROP TRIGGER IF EXISTS "exchange_funding_line_allocation_no_delete";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_scope_insert";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_cumulative_insert";
CREATE TABLE "ExchangeFundingLineAllocation_s8" (
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
  CONSTRAINT "ExchangeFundingLineAllocation_s8_scope" CHECK (
    length(trim("eventKey")) BETWEEN 8 AND 240
    AND typeof("sourceInvoiceId") = 'integer' AND "sourceInvoiceId" > 0
    AND typeof("childInvoiceId") = 'integer' AND "childInvoiceId" > 0
    AND "sourceInvoiceId" <> "childInvoiceId"
    AND typeof("returnId") = 'integer' AND "returnId" > 0
    AND typeof("sourceEventId") = 'integer' AND "sourceEventId" > 0
    AND typeof("saleItemId") = 'integer' AND "saleItemId" > 0
    AND typeof("saleItemQty") = 'integer' AND "saleItemQty" > 0
    AND typeof("saleItemValue") = 'integer' AND "saleItemValue" > 0
    AND "sourceKind" IN ('SOURCE_GIFT', 'SOURCE_N', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE')
    AND typeof("amount") = 'integer' AND "amount" > 0
  )
);
INSERT INTO "ExchangeFundingLineAllocation_s8" (
  "id", "eventKey", "sourceInvoiceId", "childInvoiceId", "returnId", "sourceEventId",
  "saleItemId", "saleItemQty", "saleItemValue", "sourceKind", "amount", "createdAt"
)
SELECT "id", "eventKey", "sourceInvoiceId", "childInvoiceId", "returnId", "sourceEventId",
  "saleItemId", "saleItemQty", "saleItemValue", "sourceKind", "amount", "createdAt"
FROM "ExchangeFundingLineAllocation";
DROP TABLE "ExchangeFundingLineAllocation";
ALTER TABLE "ExchangeFundingLineAllocation_s8" RENAME TO "ExchangeFundingLineAllocation";
CREATE UNIQUE INDEX "ExchangeFundingLineAllocation_eventKey_key" ON "ExchangeFundingLineAllocation"("eventKey");
CREATE UNIQUE INDEX "ExchangeFundingLineAllocation_sourceEventId_saleItemId_key"
  ON "ExchangeFundingLineAllocation"("sourceEventId", "saleItemId");
CREATE INDEX "ExchangeFundingLineAllocation_childInvoiceId_saleItemId_idx"
  ON "ExchangeFundingLineAllocation"("childInvoiceId", "saleItemId");
CREATE INDEX "ExchangeFundingLineAllocation_returnId_id_idx" ON "ExchangeFundingLineAllocation"("returnId", "id");
CREATE INDEX "ExchangeFundingLineAllocation_sourceInvoiceId_id_idx" ON "ExchangeFundingLineAllocation"("sourceInvoiceId", "id");
CREATE TRIGGER "exchange_funding_line_allocation_no_update"
BEFORE UPDATE ON "ExchangeFundingLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding line allocations are append-only'); END;
CREATE TRIGGER "exchange_funding_line_allocation_no_delete"
BEFORE DELETE ON "ExchangeFundingLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding line allocations are append-only'); END;

-- Permit S8 line attribution only after the replacement invoice and reciprocal
-- SaleReturn links exist. This remains descriptive, not a payout permit.
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_scope_insert";
CREATE TRIGGER "exchange_funding_return_line_allocation_scope_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION'
  AND (
    NEW."amountDelta" > NEW."sourceItemAmount"
    OR NEW."cumulativeAmount" > NEW."sourceItemAmount"
    OR NEW."priorAmount" > NEW."sourceItemAmount"
    OR NOT EXISTS (
      SELECT 1
      FROM "SaleReturn" returned
      JOIN "SaleReturnItem" returnedItem
        ON returnedItem."id" = NEW."returnItemId"
       AND returnedItem."returnId" = returned."id"
      JOIN "SaleInvoice" child
        ON child."id" = NEW."childInvoiceId"
      JOIN "SaleReturn" exchangeReturn
        ON exchangeReturn."id" = child."exchangeReturnId"
      JOIN "SaleInvoiceItem" saleItem
        ON saleItem."id" = NEW."saleItemId"
      JOIN "ExchangeFundingLineAllocation" sourceLine
        ON sourceLine."childInvoiceId" = NEW."childInvoiceId"
       AND sourceLine."saleItemId" = NEW."saleItemId"
       AND sourceLine."sourceEventId" = NEW."sourceEventId"
      WHERE returned."id" = NEW."returnId"
        AND returned."invoiceId" = NEW."childInvoiceId"
        AND returned."voidedAt" IS NULL
        AND returnedItem."saleItemId" = NEW."saleItemId"
        AND returnedItem."variantId" = saleItem."variantId"
        AND returnedItem."qty" = NEW."returningQty"
        AND returnedItem."lineTotal" = NEW."returnValue"
        AND child."orderType" = 'EXCHANGE'
        AND child."sourceInvoiceId" = NEW."sourceInvoiceId"
        AND child."exchangeReturnId" = exchangeReturn."id"
        AND exchangeReturn."kind" = 'EXCHANGE'
        AND exchangeReturn."invoiceId" = NEW."sourceInvoiceId"
        AND exchangeReturn."exchangeInvoiceId" = child."id"
        AND saleItem."invoiceId" = NEW."childInvoiceId"
        AND saleItem."qty" = NEW."saleItemQty"
        AND sourceLine."sourceInvoiceId" = NEW."sourceInvoiceId"
        AND sourceLine."returnId" = child."exchangeReturnId"
        AND sourceLine."saleItemQty" = NEW."saleItemQty"
        AND sourceLine."saleItemValue" = NEW."saleItemValue"
        AND sourceLine."sourceKind" = NEW."sourceKind"
        AND sourceLine."amount" = NEW."sourceItemAmount"
        AND (
          (returned."kind" = 'RETURN'
            AND returned."exchangeInvoiceId" IS NULL
            AND COALESCE(returned."exchangeTotal", 0) = 0)
          OR
          (returned."kind" = 'EXCHANGE'
            AND returned."exchangeInvoiceId" IS NOT NULL
            AND returned."exchangeTotal" > 0
            AND EXISTS (
              SELECT 1 FROM "SaleInvoice" replacement
              WHERE replacement."id" = returned."exchangeInvoiceId"
                AND replacement."orderType" = 'EXCHANGE'
                AND replacement."sourceInvoiceId" = child."id"
                AND replacement."exchangeReturnId" = returned."id"
                AND replacement."voidedAt" IS NULL
                AND replacement."grandTotal" = returned."exchangeTotal"
            ))
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'exchange return line allocation scope mismatch');
END;


-- Reinstall the immutable cumulative-rounding guard after rebuilding the source matrix table.
CREATE TRIGGER "exchange_funding_return_line_allocation_cumulative_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION'
  AND (
    NEW."cumulativeReturnValue" <> NEW."priorReturnValue" + NEW."returnValue"
    OR NEW."returnedQtyBefore" <> COALESCE((
      SELECT SUM(previousItem."qty")
      FROM "SaleReturn" previousReturn
      JOIN "SaleReturnItem" previousItem ON previousItem."returnId" = previousReturn."id"
      WHERE previousReturn."invoiceId" = NEW."childInvoiceId"
        AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId"
        AND previousItem."saleItemId" = NEW."saleItemId"
    ), 0)
    OR NEW."priorReturnValue" <> COALESCE((
      SELECT SUM(previousItem."lineTotal")
      FROM "SaleReturn" previousReturn
      JOIN "SaleReturnItem" previousItem ON previousItem."returnId" = previousReturn."id"
      WHERE previousReturn."invoiceId" = NEW."childInvoiceId"
        AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId"
        AND previousItem."saleItemId" = NEW."saleItemId"
    ), 0)
    OR NEW."priorAmount" <> COALESCE((
      SELECT SUM(previousAllocation."amountDelta")
      FROM "ExchangeFundingReturnLineAllocation" previousAllocation
      JOIN "SaleReturn" previousReturn ON previousReturn."id" = previousAllocation."returnId"
      WHERE previousAllocation."eventKind" = 'ALLOCATION'
        AND previousAllocation."childInvoiceId" = NEW."childInvoiceId"
        AND previousAllocation."saleItemId" = NEW."saleItemId"
        AND previousAllocation."sourceEventId" = NEW."sourceEventId"
        AND previousReturn."invoiceId" = NEW."childInvoiceId"
        AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId"
        AND NOT EXISTS (
          SELECT 1 FROM "ExchangeFundingReturnLineAllocation" reversal
          WHERE reversal."eventKind" = 'REVERSAL'
            AND reversal."reversesAllocationId" = previousAllocation."id"
        )
    ), 0)
    OR EXISTS (
      SELECT 1
      FROM "SaleReturn" previousReturn
      JOIN "SaleReturnItem" previousItem ON previousItem."returnId" = previousReturn."id"
      WHERE previousReturn."invoiceId" = NEW."childInvoiceId"
        AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId"
        AND previousItem."saleItemId" = NEW."saleItemId"
        AND (
          SELECT COUNT(*)
          FROM "ExchangeFundingReturnLineAllocation" previousAllocation
          JOIN "ExchangeFundingLineAllocation" previousSource
            ON previousSource."childInvoiceId" = NEW."childInvoiceId"
           AND previousSource."saleItemId" = NEW."saleItemId"
           AND previousSource."sourceEventId" = previousAllocation."sourceEventId"
          WHERE previousAllocation."eventKind" = 'ALLOCATION'
            AND previousAllocation."returnId" = previousReturn."id"
            AND previousAllocation."returnItemId" = previousItem."id"
            AND previousAllocation."sourceInvoiceId" = NEW."sourceInvoiceId"
            AND previousAllocation."childInvoiceId" = NEW."childInvoiceId"
            AND previousAllocation."saleItemId" = NEW."saleItemId"
            AND previousAllocation."sourceKind" = previousSource."sourceKind"
            AND previousAllocation."saleItemQty" = NEW."saleItemQty"
            AND previousAllocation."saleItemValue" = NEW."saleItemValue"
            AND previousAllocation."sourceItemAmount" = previousSource."amount"
            AND previousAllocation."returningQty" = previousItem."qty"
            AND previousAllocation."returnValue" = previousItem."lineTotal"
            AND NOT EXISTS (
              SELECT 1 FROM "ExchangeFundingReturnLineAllocation" reversal
              WHERE reversal."eventKind" = 'REVERSAL'
                AND reversal."reversesAllocationId" = previousAllocation."id"
            )
        ) <> (
          SELECT COUNT(*) FROM "ExchangeFundingLineAllocation" currentSource
          WHERE currentSource."childInvoiceId" = NEW."childInvoiceId"
            AND currentSource."saleItemId" = NEW."saleItemId"
        )
      )
    OR (
      (SELECT COUNT(*)
       FROM "ExchangeFundingReturnLineAllocation" currentAllocation
       WHERE currentAllocation."eventKind" = 'ALLOCATION'
         AND currentAllocation."returnItemId" = NEW."returnItemId") + 1
      =
      (SELECT COUNT(*) FROM "ExchangeFundingLineAllocation" currentSource
       WHERE currentSource."childInvoiceId" = NEW."childInvoiceId"
         AND currentSource."saleItemId" = NEW."saleItemId")
      AND (
        COALESCE((SELECT SUM(currentAllocation."amountDelta")
          FROM "ExchangeFundingReturnLineAllocation" currentAllocation
          WHERE currentAllocation."eventKind" = 'ALLOCATION'
            AND currentAllocation."returnItemId" = NEW."returnItemId"), 0)
          + NEW."amountDelta" <> NEW."returnValue"
        OR COALESCE((SELECT SUM(currentAllocation."priorAmount")
          FROM "ExchangeFundingReturnLineAllocation" currentAllocation
          WHERE currentAllocation."eventKind" = 'ALLOCATION'
            AND currentAllocation."returnItemId" = NEW."returnItemId"), 0)
          + NEW."priorAmount" <> NEW."priorReturnValue"
        OR COALESCE((SELECT SUM(currentAllocation."cumulativeAmount")
          FROM "ExchangeFundingReturnLineAllocation" currentAllocation
          WHERE currentAllocation."eventKind" = 'ALLOCATION'
            AND currentAllocation."returnItemId" = NEW."returnItemId"), 0)
          + NEW."cumulativeAmount" <> NEW."cumulativeReturnValue"
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'exchange return line cumulative allocation mismatch');
END;
