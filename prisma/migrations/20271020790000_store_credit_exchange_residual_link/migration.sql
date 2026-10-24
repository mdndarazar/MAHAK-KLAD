-- Link a customer-facing StoreCredit access code to one B/N residual-right
-- ledger key. The residual-right journal remains the balance/provenance source.
ALTER TABLE "StoreCredit" ADD COLUMN "exchangeResidualRightKey" TEXT;
CREATE UNIQUE INDEX "StoreCredit_exchangeResidualRightKey_key" ON "StoreCredit"("exchangeResidualRightKey");
