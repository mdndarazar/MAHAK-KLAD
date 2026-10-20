-- Quantities cross the SQLite/Prisma boundary as JavaScript numbers. A SQLite
-- INTEGER above MAX_SAFE_INTEGER is exact in storage but not in the service or
-- renderer, so it must not enter the sold/returned quantity domains.
CREATE TRIGGER "sale_invoice_item_quantity_safe_integer_insert"
BEFORE INSERT ON "SaleInvoiceItem"
BEGIN
  SELECT RAISE(ABORT, 'sale invoice item quantity must be a positive integer within JavaScript safe range')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0 OR NEW."qty" > 9007199254740991;
END;

CREATE TRIGGER "sale_invoice_item_quantity_safe_integer_update"
BEFORE UPDATE OF "qty" ON "SaleInvoiceItem"
BEGIN
  SELECT RAISE(ABORT, 'sale invoice item quantity must be a positive integer within JavaScript safe range')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0 OR NEW."qty" > 9007199254740991;
END;

CREATE TRIGGER "sale_return_item_quantity_safe_integer_insert"
BEFORE INSERT ON "SaleReturnItem"
BEGIN
  SELECT RAISE(ABORT, 'sale return item quantity must be a positive integer within JavaScript safe range')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0 OR NEW."qty" > 9007199254740991;
END;

CREATE TRIGGER "sale_return_item_quantity_safe_integer_update"
BEFORE UPDATE OF "qty" ON "SaleReturnItem"
BEGIN
  SELECT RAISE(ABORT, 'sale return item quantity must be a positive integer within JavaScript safe range')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0 OR NEW."qty" > 9007199254740991;
END;

-- Triggers protect future writes but do not repair or legitimize old rows. A
-- temporary CHECK table validates installed data without mutating or rounding
-- any historical sale/return quantity. Invalid data aborts this migration so
-- startup can require operator reconciliation from a backup instead of
-- continuing with a corrupted quantity basis.
CREATE TEMP TABLE "_sale_return_quantity_domain_validation" (
  "qty" INTEGER NOT NULL CHECK (
    typeof("qty") = 'integer' AND "qty" > 0 AND "qty" <= 9007199254740991
  )
);
INSERT INTO "_sale_return_quantity_domain_validation" ("qty")
  SELECT "qty" FROM "SaleInvoiceItem";
DELETE FROM "_sale_return_quantity_domain_validation";
INSERT INTO "_sale_return_quantity_domain_validation" ("qty")
  SELECT "qty" FROM "SaleReturnItem";
DROP TABLE "_sale_return_quantity_domain_validation";
