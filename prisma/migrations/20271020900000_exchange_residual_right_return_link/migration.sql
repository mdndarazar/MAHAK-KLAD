-- Link an S1 residual-right restoration event to the exact ordinary sale return.
-- The scalar is deliberately not an FK: append-only provenance survives business-row cleanup.
ALTER TABLE "ExchangeResidualRightEvent" ADD COLUMN "relatedReturnId" INTEGER;
CREATE INDEX "ExchangeResidualRightEvent_relatedReturnId_idx"
  ON "ExchangeResidualRightEvent"("relatedReturnId");
