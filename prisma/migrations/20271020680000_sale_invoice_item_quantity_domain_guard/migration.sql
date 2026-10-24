-- Return quantity caps assume a sold quantity is a positive SQLite integer.
-- Enforce that basis even when a line has no active return yet; otherwise a
-- fractional quantity could let a physical integer return compare against a
-- non-integer sold cap.
CREATE TRIGGER "sale_invoice_item_quantity_domain_insert"
BEFORE INSERT ON "SaleInvoiceItem"
BEGIN
  SELECT RAISE(ABORT, 'sale invoice item quantity must be a positive integer')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0;
END;

CREATE TRIGGER "sale_invoice_item_quantity_domain_update"
BEFORE UPDATE OF "qty" ON "SaleInvoiceItem"
BEGIN
  SELECT RAISE(ABORT, 'sale invoice item quantity must be a positive integer')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0;
END;
