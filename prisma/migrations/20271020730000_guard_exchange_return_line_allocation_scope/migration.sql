-- Bind every accounting-attribution row to the active physical return item and
-- the immutable source-to-item matrix. The journal is not a refund permit, but
-- malformed or cross-linked provenance must not enter it even via direct SQL.
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
        AND returned."kind" = 'RETURN'
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
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'exchange return line allocation scope mismatch');
END;
