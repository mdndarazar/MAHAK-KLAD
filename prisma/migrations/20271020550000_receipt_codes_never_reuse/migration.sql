-- Receipt credentials are never recycled, including after expiry or deletion of an invoice.
-- Historical duplicates remain on SaleInvoice; the registry has ONE reservation per
-- normalized code, not a false assertion that all historical claims were unique.
-- No foreign key to SaleInvoice: deleting an invoice must not release its code.
CREATE TABLE "ReceiptCodeReservation" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'ISSUED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReceiptCodeReservation_invoiceId_key" ON "ReceiptCodeReservation"("invoiceId");

-- Codes issued by the old generator were uppercase ASCII letters/digits. Strip
-- common scanner/presentation separators when importing any other legacy values.
-- Grouping tolerates duplicate historical invoices without altering any document.
INSERT OR IGNORE INTO "ReceiptCodeReservation" ("code", "source", "createdAt")
SELECT UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM("returnCode"), ' ', ''), '-', ''), '_', ''), char(9), ''), char(10), ''), char(13), '')),
       'HISTORICAL', MIN("issuedAt")
FROM "SaleInvoice"
WHERE "returnCode" IS NOT NULL AND TRIM("returnCode") <> ''
GROUP BY UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM("returnCode"), ' ', ''), '-', ''), '_', ''), char(9), ''), char(10), ''), char(13), ''));
