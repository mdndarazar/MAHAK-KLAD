-- Distinguish the original exchange-opening return from a later return of the
-- replacement invoice. This is a scalar provenance link, not a cascading FK.
ALTER TABLE "ExchangeFundingEvent" ADD COLUMN "relatedReturnId" INTEGER;
CREATE INDEX "ExchangeFundingEvent_relatedReturnId_id_idx"
  ON "ExchangeFundingEvent"("relatedReturnId", "id");
