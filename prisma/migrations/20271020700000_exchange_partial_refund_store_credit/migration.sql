-- Persist the non-cash component when a negative exchange is split between
-- actual cash/card payout and a newly issued store-credit barcode.
ALTER TABLE "SaleReturn"
ADD COLUMN "refundStoreCreditAmount" BIGINT NOT NULL DEFAULT 0;
