-- Additive, history-preserving boundary for independent physical goods receipt.
-- All old returns (including pending card transfers with no entitlement) remain
-- false: neither money nor physical presence is inferred/backfilled. New
-- inventory-deducted returns enter the protocol explicitly in the same sale
-- transaction; no existing document, stock row or receipt is rewritten.
ALTER TABLE "SaleReturn" ADD COLUMN "goodsReceiptRequired" BOOLEAN NOT NULL DEFAULT false;
