-- Database boundary for the append-only exchange-child return attribution journal.
-- A REVERSAL must be an exact inverse of its existing ALLOCATION; scalar IDs
-- alone are not proof that the reversed row belongs to this returned line.
CREATE TRIGGER "exchange_funding_return_line_allocation_integrity_insert"
BEFORE INSERT ON "ExchangeFundingReturnLineAllocation"
WHEN
  (NEW."eventKind" = 'ALLOCATION' AND NEW."eventKey" <> (
    'exchange-return-item:' || NEW."returnItemId" || ':source:' || NEW."sourceEventId" || ':allocation:v1'
  ))
  OR
  (NEW."eventKind" = 'REVERSAL' AND NOT EXISTS (
    SELECT 1
    FROM "ExchangeFundingReturnLineAllocation" allocation
    WHERE allocation."id" = NEW."reversesAllocationId"
      AND allocation."eventKind" = 'ALLOCATION'
      AND allocation."returnId" = NEW."returnId"
      AND allocation."returnItemId" = NEW."returnItemId"
      AND allocation."sourceInvoiceId" = NEW."sourceInvoiceId"
      AND allocation."childInvoiceId" = NEW."childInvoiceId"
      AND allocation."saleItemId" = NEW."saleItemId"
      AND allocation."sourceEventId" = NEW."sourceEventId"
      AND allocation."sourceKind" = NEW."sourceKind"
      AND allocation."saleItemQty" = NEW."saleItemQty"
      AND allocation."saleItemValue" = NEW."saleItemValue"
      AND allocation."sourceItemAmount" = NEW."sourceItemAmount"
      AND allocation."returnedQtyBefore" = NEW."returnedQtyBefore"
      AND allocation."returningQty" = NEW."returningQty"
      AND allocation."returnedQtyAfter" = NEW."returnedQtyAfter"
      AND allocation."priorReturnValue" = NEW."priorReturnValue"
      AND allocation."returnValue" = NEW."returnValue"
      AND allocation."cumulativeReturnValue" = NEW."cumulativeReturnValue"
      AND NEW."priorAmount" = allocation."cumulativeAmount"
      AND NEW."amountDelta" = -allocation."amountDelta"
      AND NEW."cumulativeAmount" = allocation."priorAmount"
      AND NEW."allocationVersion" = allocation."allocationVersion"
      AND NEW."eventKey" = (
        'exchange-return-item:' || NEW."returnItemId" || ':source:' || NEW."sourceEventId" || ':reversal:v1'
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'exchange return line allocation integrity check failed');
END;
