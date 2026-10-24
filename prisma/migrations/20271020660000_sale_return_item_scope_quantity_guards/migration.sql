-- Enforce return-item invoice/variant scope and the active physical return cap.
-- Corrections do not release returned quantity. Only SaleReturn.voidedAt does.

CREATE TRIGGER "sale_return_item_scope_insert"
BEFORE INSERT ON "SaleReturnItem"
BEGIN
  SELECT RAISE(ABORT, 'sale return item quantity must be a positive integer')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0;
  SELECT RAISE(ABORT, 'sale return item invoice/variant scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
      FROM "SaleReturn" r
      JOIN "SaleInvoiceItem" si ON si."id" = NEW."saleItemId"
      WHERE r."id" = NEW."returnId"
        AND r."invoiceId" = si."invoiceId"
        AND NEW."variantId" = si."variantId"
    );
  SELECT RAISE(ABORT, 'active sale return quantity exceeds sold quantity')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturn" r
      JOIN "SaleInvoiceItem" si ON si."id" = NEW."saleItemId"
      WHERE r."id" = NEW."returnId"
        AND r."voidedAt" IS NULL
        AND COALESCE((
          SELECT SUM(ri."qty")
          FROM "SaleReturnItem" ri
          JOIN "SaleReturn" ar ON ar."id" = ri."returnId"
          WHERE ri."saleItemId" = NEW."saleItemId"
            AND ar."voidedAt" IS NULL
        ), 0) + NEW."qty" > si."qty"
    );
END;

CREATE TRIGGER "sale_return_item_scope_update"
BEFORE UPDATE OF "returnId", "saleItemId", "variantId", "qty" ON "SaleReturnItem"
BEGIN
  SELECT RAISE(ABORT, 'sale return item quantity must be a positive integer')
    WHERE typeof(NEW."qty") <> 'integer' OR NEW."qty" <= 0;
  SELECT RAISE(ABORT, 'sale return item invoice/variant scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
      FROM "SaleReturn" r
      JOIN "SaleInvoiceItem" si ON si."id" = NEW."saleItemId"
      WHERE r."id" = NEW."returnId"
        AND r."invoiceId" = si."invoiceId"
        AND NEW."variantId" = si."variantId"
    );
  SELECT RAISE(ABORT, 'active sale return quantity exceeds sold quantity')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturn" r
      JOIN "SaleInvoiceItem" si ON si."id" = NEW."saleItemId"
      WHERE r."id" = NEW."returnId"
        AND r."voidedAt" IS NULL
        AND COALESCE((
          SELECT SUM(ri."qty")
          FROM "SaleReturnItem" ri
          JOIN "SaleReturn" ar ON ar."id" = ri."returnId"
          WHERE ri."saleItemId" = NEW."saleItemId"
            AND ri."id" <> OLD."id"
            AND ar."voidedAt" IS NULL
        ), 0) + NEW."qty" > si."qty"
    );
END;

-- A linked SaleReturn may not be retargeted to another invoice, including
-- legacy rows that already have return items. For active rows, also evaluate
-- the resulting per-sale-item total before allowing the parent scope change.
CREATE TRIGGER "sale_return_invoice_scope_update"
BEFORE UPDATE OF "invoiceId" ON "SaleReturn"
BEGIN
  SELECT RAISE(ABORT, 'sale return invoice scope mismatch for linked items')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturnItem" ri
      JOIN "SaleInvoiceItem" si ON si."id" = ri."saleItemId"
      WHERE ri."returnId" = OLD."id"
        AND (si."invoiceId" <> NEW."invoiceId" OR ri."variantId" <> si."variantId")
    );
  SELECT RAISE(ABORT, 'active sale return quantity exceeds sold quantity')
    WHERE NEW."voidedAt" IS NULL AND EXISTS (
      SELECT ri."saleItemId"
      FROM "SaleReturnItem" ri
      JOIN "SaleInvoiceItem" si ON si."id" = ri."saleItemId"
      WHERE ri."returnId" = OLD."id"
      GROUP BY ri."saleItemId", si."qty"
      HAVING COALESCE((
        SELECT SUM(other."qty")
        FROM "SaleReturnItem" other
        JOIN "SaleReturn" ar ON ar."id" = other."returnId"
        WHERE other."saleItemId" = ri."saleItemId"
          AND ar."voidedAt" IS NULL
          AND ar."id" <> OLD."id"
      ), 0) + SUM(ri."qty") > si."qty"
    );
END;

-- Reactivation is the only update that releases/re-reserves physical return
-- quantity. Corrections and settlement rows intentionally do not participate.
CREATE TRIGGER "sale_return_reactivation_quantity_guard"
BEFORE UPDATE OF "voidedAt" ON "SaleReturn"
WHEN OLD."voidedAt" IS NOT NULL AND NEW."voidedAt" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'sale return invoice scope mismatch for linked items')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturnItem" ri
      JOIN "SaleInvoiceItem" si ON si."id" = ri."saleItemId"
      WHERE ri."returnId" = NEW."id"
        AND (si."invoiceId" <> NEW."invoiceId" OR ri."variantId" <> si."variantId")
    );
  SELECT RAISE(ABORT, 'active sale return quantity exceeds sold quantity')
    WHERE EXISTS (
      SELECT ri."saleItemId"
      FROM "SaleReturnItem" ri
      JOIN "SaleInvoiceItem" si ON si."id" = ri."saleItemId"
      WHERE ri."returnId" = NEW."id"
      GROUP BY ri."saleItemId", si."qty"
      HAVING COALESCE((
        SELECT SUM(other."qty")
        FROM "SaleReturnItem" other
        JOIN "SaleReturn" ar ON ar."id" = other."returnId"
        WHERE other."saleItemId" = ri."saleItemId"
          AND ar."voidedAt" IS NULL
          AND ar."id" <> NEW."id"
      ), 0) + SUM(ri."qty") > si."qty"
    );
END;

-- Changing a sold line after returns exist must not orphan their scope or lower
-- the quantity below already-active physical returns.
CREATE TRIGGER "sale_invoice_item_return_scope_update"
BEFORE UPDATE OF "invoiceId", "variantId", "qty" ON "SaleInvoiceItem"
BEGIN
  SELECT RAISE(ABORT, 'sale invoice item scope mismatch for linked returns')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturnItem" ri
      JOIN "SaleReturn" r ON r."id" = ri."returnId"
      WHERE ri."saleItemId" = OLD."id"
        AND (r."invoiceId" <> NEW."invoiceId" OR ri."variantId" <> NEW."variantId")
    );
  SELECT RAISE(ABORT, 'active sale return quantity exceeds sold quantity')
    WHERE EXISTS (
      SELECT 1
      FROM "SaleReturnItem" ri
      JOIN "SaleReturn" r ON r."id" = ri."returnId"
      WHERE ri."saleItemId" = OLD."id"
        AND r."voidedAt" IS NULL
      GROUP BY ri."saleItemId"
      HAVING typeof(NEW."qty") <> 'integer'
        OR NEW."qty" <= 0
        OR SUM(ri."qty") > NEW."qty"
    );
END;
