-- Pooled exchange-return allocation v4: determine credit entitlement from the whole
-- exchange invoice's proven source pool; keep the physical return item only as audit scope.
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_no_update";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_no_delete";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_integrity_insert";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_scope_insert";
DROP TRIGGER IF EXISTS "exchange_funding_return_line_allocation_cumulative_insert";
DROP TRIGGER IF EXISTS "exchange_return_line_physical_snapshot_update";
DROP TRIGGER IF EXISTS "exchange_return_line_parent_kind_update";

CREATE TABLE "ExchangeFundingReturnLineAllocation_pooled" (
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
  CONSTRAINT "ExchangeFundingReturnLineAllocation_pooled_scope" CHECK (
    length(trim("eventKey")) BETWEEN 8 AND 240
    AND "eventKind" IN ('ALLOCATION', 'REVERSAL')
    AND typeof("returnId") = 'integer' AND "returnId" > 0
    AND typeof("returnItemId") = 'integer' AND "returnItemId" > 0
    AND typeof("sourceInvoiceId") = 'integer' AND "sourceInvoiceId" > 0
    AND typeof("childInvoiceId") = 'integer' AND "childInvoiceId" > 0
    AND "sourceInvoiceId" <> "childInvoiceId"
    AND typeof("saleItemId") = 'integer' AND "saleItemId" > 0
    AND typeof("sourceEventId") = 'integer' AND "sourceEventId" > 0
    AND "sourceKind" IN ('SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE')
    AND typeof("saleItemQty") = 'integer' AND "saleItemQty" > 0
    AND typeof("saleItemValue") = 'integer' AND "saleItemValue" > 0
    AND typeof("sourceItemAmount") = 'integer' AND "sourceItemAmount" > 0
    AND ("allocationVersion" >= 4 OR "sourceItemAmount" <= "saleItemValue")
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
    AND (("eventKind" = 'ALLOCATION' AND "reversesAllocationId" IS NULL
          AND "amountDelta" >= 0 AND "cumulativeAmount" = "priorAmount" + "amountDelta")
      OR ("eventKind" = 'REVERSAL' AND typeof("reversesAllocationId") = 'integer'
          AND "reversesAllocationId" > 0 AND "amountDelta" <= 0))
  )
);
INSERT INTO "ExchangeFundingReturnLineAllocation_pooled" SELECT * FROM "ExchangeFundingReturnLineAllocation";
DROP TABLE "ExchangeFundingReturnLineAllocation";
ALTER TABLE "ExchangeFundingReturnLineAllocation_pooled" RENAME TO "ExchangeFundingReturnLineAllocation";
CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_eventKey_key" ON "ExchangeFundingReturnLineAllocation"("eventKey");
CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_returnItemId_sourceEventId_eventKind_key" ON "ExchangeFundingReturnLineAllocation"("returnItemId", "sourceEventId", "eventKind");
CREATE UNIQUE INDEX "ExchangeFundingReturnLineAllocation_reversesAllocationId_key" ON "ExchangeFundingReturnLineAllocation"("reversesAllocationId");
CREATE INDEX "ExchangeFundingReturnLineAllocation_childInvoiceId_saleItemId_idx" ON "ExchangeFundingReturnLineAllocation"("childInvoiceId", "saleItemId");
CREATE INDEX "ExchangeFundingReturnLineAllocation_returnId_id_idx" ON "ExchangeFundingReturnLineAllocation"("returnId", "id");
CREATE INDEX "ExchangeFundingReturnLineAllocation_returnItemId_id_idx" ON "ExchangeFundingReturnLineAllocation"("returnItemId", "id");
CREATE INDEX "ExchangeFundingReturnLineAllocation_sourceEventId_id_idx" ON "ExchangeFundingReturnLineAllocation"("sourceEventId", "id");
CREATE TRIGGER "exchange_funding_return_line_allocation_no_update" BEFORE UPDATE ON "ExchangeFundingReturnLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding return line allocations are append-only'); END;
CREATE TRIGGER "exchange_funding_return_line_allocation_no_delete" BEFORE DELETE ON "ExchangeFundingReturnLineAllocation"
BEGIN SELECT RAISE(ABORT, 'exchange funding return line allocations are append-only'); END;

CREATE TRIGGER "exchange_funding_return_line_allocation_integrity_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN (NEW."eventKind" = 'ALLOCATION' AND NEW."eventKey" <> (
    'exchange-return-item:' || NEW."returnItemId" || ':source:' || NEW."sourceEventId" || ':allocation:v' ||
    CASE WHEN NEW."allocationVersion" >= 4 THEN NEW."allocationVersion" ELSE 1 END))
 OR (NEW."eventKind" = 'REVERSAL' AND NOT EXISTS (
    SELECT 1 FROM "ExchangeFundingReturnLineAllocation" allocation
    WHERE allocation."id" = NEW."reversesAllocationId" AND allocation."eventKind" = 'ALLOCATION'
      AND allocation."returnId" = NEW."returnId" AND allocation."returnItemId" = NEW."returnItemId"
      AND allocation."sourceInvoiceId" = NEW."sourceInvoiceId" AND allocation."childInvoiceId" = NEW."childInvoiceId"
      AND allocation."saleItemId" = NEW."saleItemId" AND allocation."sourceEventId" = NEW."sourceEventId"
      AND allocation."sourceKind" = NEW."sourceKind" AND allocation."saleItemQty" = NEW."saleItemQty"
      AND allocation."saleItemValue" = NEW."saleItemValue" AND allocation."sourceItemAmount" = NEW."sourceItemAmount"
      AND allocation."returnedQtyBefore" = NEW."returnedQtyBefore" AND allocation."returningQty" = NEW."returningQty"
      AND allocation."returnedQtyAfter" = NEW."returnedQtyAfter" AND allocation."priorReturnValue" = NEW."priorReturnValue"
      AND allocation."returnValue" = NEW."returnValue" AND allocation."cumulativeReturnValue" = NEW."cumulativeReturnValue"
      AND NEW."priorAmount" = allocation."cumulativeAmount" AND NEW."amountDelta" = -allocation."amountDelta"
      AND NEW."cumulativeAmount" = allocation."priorAmount" AND NEW."allocationVersion" = allocation."allocationVersion"
      AND NEW."eventKey" = ('exchange-return-item:' || NEW."returnItemId" || ':source:' || NEW."sourceEventId" ||
        ':reversal:v' || CASE WHEN NEW."allocationVersion" >= 4 THEN NEW."allocationVersion" ELSE 1 END)
  ))
BEGIN SELECT RAISE(ABORT, 'exchange return line allocation integrity check failed'); END;

CREATE TRIGGER "exchange_funding_return_line_allocation_scope_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION' AND NEW."allocationVersion" < 4
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

CREATE TRIGGER "exchange_funding_return_line_allocation_cumulative_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION' AND NEW."allocationVersion" < 4
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

CREATE TRIGGER "exchange_funding_return_line_allocation_scope_pooled_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION' AND NEW."allocationVersion" >= 4
  AND (NEW."amountDelta" > NEW."sourceItemAmount" OR NEW."cumulativeAmount" > NEW."sourceItemAmount"
    OR NEW."priorAmount" > NEW."sourceItemAmount"
    OR NOT EXISTS (
      SELECT 1 FROM "SaleReturn" returned
      JOIN "SaleReturnItem" returnedItem ON returnedItem."id" = NEW."returnItemId" AND returnedItem."returnId" = returned."id"
      JOIN "SaleInvoice" child ON child."id" = NEW."childInvoiceId"
      JOIN "SaleReturn" exchangeReturn ON exchangeReturn."id" = child."exchangeReturnId"
      JOIN "SaleInvoiceItem" saleItem ON saleItem."id" = NEW."saleItemId"
      JOIN "ExchangeFundingLineAllocation" sourceLine ON sourceLine."childInvoiceId" = NEW."childInvoiceId"
        AND sourceLine."sourceEventId" = NEW."sourceEventId"
      WHERE returned."id" = NEW."returnId" AND returned."invoiceId" = NEW."childInvoiceId"
        AND returned."voidedAt" IS NULL AND returned."kind" = 'RETURN'
        AND returned."exchangeInvoiceId" IS NULL AND COALESCE(returned."exchangeTotal", 0) = 0
        AND returnedItem."saleItemId" = NEW."saleItemId" AND returnedItem."variantId" = saleItem."variantId"
        AND returnedItem."qty" = NEW."returningQty" AND returnedItem."lineTotal" = NEW."returnValue"
        AND child."orderType" = 'EXCHANGE' AND child."sourceInvoiceId" = NEW."sourceInvoiceId"
        AND child."exchangeReturnId" = exchangeReturn."id" AND exchangeReturn."kind" = 'EXCHANGE'
        AND exchangeReturn."invoiceId" = NEW."sourceInvoiceId" AND exchangeReturn."exchangeInvoiceId" = child."id"
        AND saleItem."invoiceId" = NEW."childInvoiceId" AND saleItem."qty" = NEW."saleItemQty"
        AND sourceLine."sourceInvoiceId" = NEW."sourceInvoiceId" AND sourceLine."returnId" = child."exchangeReturnId"
        AND sourceLine."sourceKind" = NEW."sourceKind"
        AND (SELECT SUM(sourceAmount."amount") FROM "ExchangeFundingLineAllocation" sourceAmount
          WHERE sourceAmount."childInvoiceId" = NEW."childInvoiceId"
            AND sourceAmount."sourceEventId" = NEW."sourceEventId"
            AND sourceAmount."sourceInvoiceId" = NEW."sourceInvoiceId"
            AND sourceAmount."returnId" = child."exchangeReturnId"
            AND sourceAmount."sourceKind" = NEW."sourceKind") = NEW."sourceItemAmount"
    ))
BEGIN SELECT RAISE(ABORT, 'exchange pooled return allocation scope mismatch'); END;

CREATE TRIGGER "exchange_funding_return_line_allocation_cumulative_pooled_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN NEW."eventKind" = 'ALLOCATION' AND NEW."allocationVersion" >= 4
  AND (NEW."cumulativeReturnValue" <> NEW."priorReturnValue" + NEW."returnValue"
    OR NEW."returnedQtyBefore" <> COALESCE((SELECT SUM(previousItem."qty")
      FROM "SaleReturn" previousReturn JOIN "SaleReturnItem" previousItem ON previousItem."returnId" = previousReturn."id"
      WHERE previousReturn."invoiceId" = NEW."childInvoiceId" AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId" AND previousItem."saleItemId" = NEW."saleItemId"), 0)
    OR NEW."priorReturnValue" <> COALESCE((SELECT SUM(previousItem."lineTotal")
      FROM "SaleReturn" previousReturn JOIN "SaleReturnItem" previousItem ON previousItem."returnId" = previousReturn."id"
      WHERE previousReturn."invoiceId" = NEW."childInvoiceId" AND previousReturn."voidedAt" IS NULL
        AND previousReturn."id" < NEW."returnId"), 0)
      + COALESCE((SELECT SUM(currentItem."lineTotal") FROM "SaleReturnItem" currentItem
        WHERE currentItem."returnId" = NEW."returnId" AND currentItem."id" < NEW."returnItemId"), 0)
    OR NEW."priorAmount" <> COALESCE((SELECT SUM(previousAllocation."amountDelta")
      FROM "ExchangeFundingReturnLineAllocation" previousAllocation
      JOIN "SaleReturn" previousReturn ON previousReturn."id" = previousAllocation."returnId"
      WHERE previousAllocation."eventKind" = 'ALLOCATION' AND previousAllocation."childInvoiceId" = NEW."childInvoiceId"
        AND previousAllocation."sourceEventId" = NEW."sourceEventId" AND previousReturn."invoiceId" = NEW."childInvoiceId"
        AND previousReturn."voidedAt" IS NULL AND previousReturn."id" <= NEW."returnId"
        AND (previousReturn."id" < NEW."returnId" OR previousAllocation."id" < NEW."id")
        AND NOT EXISTS (SELECT 1 FROM "ExchangeFundingReturnLineAllocation" reversal
          WHERE reversal."eventKind" = 'REVERSAL' AND reversal."reversesAllocationId" = previousAllocation."id")), 0))
BEGIN SELECT RAISE(ABORT, 'exchange pooled return cumulative allocation mismatch'); END;

CREATE TRIGGER "exchange_return_line_physical_snapshot_update"
BEFORE UPDATE OF "returnId", "saleItemId", "variantId", "qty", "unitPrice", "lineTotal"
ON "SaleReturnItem"
WHEN EXISTS (
  SELECT 1
  FROM "ExchangeFundingReturnLineAllocation" allocation
  WHERE allocation."returnItemId" = OLD."id"
)
BEGIN
  SELECT RAISE(ABORT, 'allocated exchange return item snapshot is immutable');
END;

CREATE TRIGGER "exchange_return_line_parent_kind_update"
BEFORE UPDATE OF "kind" ON "SaleReturn"
WHEN EXISTS (
  SELECT 1
  FROM "ExchangeFundingReturnLineAllocation" allocation
  WHERE allocation."returnId" = OLD."id"
)
BEGIN
  SELECT RAISE(ABORT, 'allocated exchange return kind is immutable');
END;
