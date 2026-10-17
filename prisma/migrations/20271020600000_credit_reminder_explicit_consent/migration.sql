-- A phone number, an existing non-opt-out flag, and historic queued messages
-- are NOT evidence of permission to send a credit reminder. No backfill:
-- every existing credit remains unconsented until a manager records affirmative
-- consent for the current destination, with a separate contemporaneous record.
ALTER TABLE "StoreCredit" ADD COLUMN "reminderConsentAt" DATETIME;
ALTER TABLE "StoreCredit" ADD COLUMN "reminderConsentPhone" TEXT;
ALTER TABLE "StoreCredit" ADD COLUMN "reminderConsentEvidence" TEXT;
