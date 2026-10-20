-- Bind per-item return snapshots to active physical history and to the
-- immutable per-source line journal. This remains accounting attribution only;
-- it does not grant a refund, gift restoration, or store-credit entitlement.
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
