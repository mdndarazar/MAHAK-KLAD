-- Record the invoice-level reversal of synthetic exchange tender when a
-- replacement invoice is returned without an actual-money payout. NULL keeps
-- historical child-return rows on their legacy interpretation; new rows write
-- an explicit amount (including zero).
ALTER TABLE "SaleReturn"
  ADD COLUMN "exchangeCreditReversed" BIGINT
  CHECK (
    "exchangeCreditReversed" IS NULL
    OR (typeof("exchangeCreditReversed") = 'integer' AND "exchangeCreditReversed" >= 0)
  );
