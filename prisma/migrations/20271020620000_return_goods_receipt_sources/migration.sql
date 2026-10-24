-- Each new physical receipt records the exact stock source that was restored.
-- Scalar IDs deliberately survive later deletion of sales/warehouse rows; no
-- historical receipt is backfilled with a guessed allocation or stock row.
CREATE TABLE "ReturnGoodsReceiptSource" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "receiptId" INTEGER NOT NULL,
  "returnItemId" INTEGER NOT NULL,
  "variantId" INTEGER NOT NULL,
  "allocationId" INTEGER,
  "sourceKind" TEXT NOT NULL,
  "warehouseId" INTEGER,
  "warehouseName" TEXT NOT NULL DEFAULT '',
  "secondaryStockItemId" INTEGER,
  "stockItemName" TEXT,
  "stockItemCode" TEXT,
  "qty" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnGoodsReceiptSource_valid" CHECK (
    "receiptId" > 0 AND "returnItemId" > 0 AND "variantId" > 0 AND "qty" > 0 AND
    (("sourceKind" = 'STORE' AND "warehouseId" IS NULL AND "secondaryStockItemId" IS NULL AND "stockItemName" IS NULL AND "stockItemCode" IS NULL)
     OR ("sourceKind" = 'WAREHOUSE' AND "allocationId" IS NOT NULL AND "secondaryStockItemId" > 0 AND "stockItemName" IS NOT NULL))
  )
);

CREATE INDEX "ReturnGoodsReceiptSource_receiptId_id_idx" ON "ReturnGoodsReceiptSource"("receiptId", "id");
CREATE INDEX "ReturnGoodsReceiptSource_allocationId_idx" ON "ReturnGoodsReceiptSource"("allocationId");
CREATE INDEX "ReturnGoodsReceiptSource_secondaryStockItemId_idx" ON "ReturnGoodsReceiptSource"("secondaryStockItemId");
