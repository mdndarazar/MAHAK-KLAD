-- Once a physical child-return item has immutable source attribution, its
-- quantity/value/scope snapshots may not be retargeted underneath the ledger.
-- Restock bookkeeping remains mutable; voided archival deletion remains governed
-- by the existing active-return delete guard.
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
