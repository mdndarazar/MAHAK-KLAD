-- Independent, witnessed, quantity-by-quantity receipt of physical goods.
-- This is not a payment or a bank confirmation. Append-only even after a
-- correction/void; its immutable row explains each inventory movement.
CREATE TABLE "ReturnGoodsReceipt" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventKey" TEXT NOT NULL,
  "returnId" INTEGER NOT NULL,
  "returnItemId" INTEGER NOT NULL,
  "variantId" INTEGER NOT NULL,
  "qty" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "witnessKind" TEXT NOT NULL,
  "witnessRef" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnGoodsReceipt_positive" CHECK ("qty" > 0)
);
CREATE UNIQUE INDEX "ReturnGoodsReceipt_eventKey_key" ON "ReturnGoodsReceipt"("eventKey");
CREATE INDEX "ReturnGoodsReceipt_returnId_id_idx" ON "ReturnGoodsReceipt"("returnId", "id");
CREATE INDEX "ReturnGoodsReceipt_returnItemId_id_idx" ON "ReturnGoodsReceipt"("returnItemId", "id");
