-- Durable request idempotency and immutable discount-transfer provenance for
-- exchange transactions. Legacy rows remain NULL/zero and therefore preserve
-- their existing return/tender behavior.
ALTER TABLE "SaleReturn" ADD COLUMN "exchangeRequestKey" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "exchangeRequestFingerprint" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "exchangeRequestResultJson" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "discountTransferOption" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "discountTransferAmount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "SaleReturn" ADD COLUMN "discountTransferRefundValue" BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "SaleReturn_exchangeRequestKey_key" ON "SaleReturn"("exchangeRequestKey");

CREATE TABLE "DiscountTransferEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceInvoiceId" INTEGER NOT NULL,
    "sourceSaleItemId" INTEGER NOT NULL,
    "sourceReturnId" INTEGER NOT NULL,
    "sourceReturnItemId" INTEGER NOT NULL,
    "sourceQtyStart" INTEGER NOT NULL,
    "sourceQtyEnd" INTEGER NOT NULL,
    "childInvoiceId" INTEGER,
    "childSaleItemId" INTEGER,
    "option" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "windowDiscount" BIGINT NOT NULL DEFAULT 0,
    "provenanceJson" TEXT NOT NULL DEFAULT '{}',
    "userId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DiscountTransferEvent_eventKey_key" ON "DiscountTransferEvent"("eventKey");
CREATE INDEX "DiscountTransferEvent_sourceSaleItemId_sourceQtyStart_sourceQtyEnd_idx"
  ON "DiscountTransferEvent"("sourceSaleItemId", "sourceQtyStart", "sourceQtyEnd");
CREATE INDEX "DiscountTransferEvent_sourceReturnId_idx" ON "DiscountTransferEvent"("sourceReturnId");
CREATE INDEX "DiscountTransferEvent_childInvoiceId_childSaleItemId_idx"
  ON "DiscountTransferEvent"("childInvoiceId", "childSaleItemId");
