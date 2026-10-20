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
