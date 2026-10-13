-- Additive only (session s397r). Segment-scoped aggregate baseline + bootstrap.
--
-- * No existing row is UPDATEd, DELETEd or re-classified. Historical rows keep
--   baselineSource = NULL, which explicitly means "recorded by aggregate-v1;
--   classification unknown" — v1's first row (previousBoundaryId IS NULL) is
--   *not* silently relabelled, because a NULL previous id in v1 does not prove
--   that the row was the first observation of its own segment.
-- * baselineSource for new rows: CHAINED (reconciled against the accepted
--   baseline of the same source segment) | ADOPTION (first aggregate
--   observation of a segment without a baseline; evidence-neutral: expected =
--   observed, newDifference = 0, no case).
-- * sourceMovementOffset: net physical movement of toShiftId already reflected
--   in this observation. Non-zero only for a mid-segment ADOPTION_BASELINE that
--   is written inside a *successful* handover acceptance transaction.
ALTER TABLE "CustodyAggregateBoundary" ADD COLUMN "baselineSource" TEXT;
ALTER TABLE "CustodyAggregateBoundary" ADD COLUMN "sourceMovementOffset" BIGINT NOT NULL DEFAULT 0;
CREATE INDEX "CustodyAggregateBoundary_baselineSource_at_idx" ON "CustodyAggregateBoundary"("baselineSource", "at");
